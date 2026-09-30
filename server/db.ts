import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { nanoid } from "nanoid";
import * as schema from "../drizzle/schema";
import { authAccounts, users, type InsertUser, type UiContext, type User } from "../drizzle/schema";

export type Db = MySql2Database<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

let _db: Db | null = null;

/** Lazily create the pooled drizzle instance so local tooling can run without a DB. */
export function getDb(): Db | null {
  if (!_db && process.env.DATABASE_URL) {
    const pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 10, timezone: "Z" });
    // `timezone: "Z"` only affects how mysql2 serializes dates; DEFAULT (now()) and ON UPDATE use the
    // session time zone, which must also be UTC or those columns drift by the server's offset.
    pool.on("connection", (conn) => {
      (conn as unknown as { query(sql: string, cb: (err: Error | null) => void): void }).query("SET time_zone = '+00:00'", (err) => {
        if (err) console.error("[Database] Failed to set session time zone", err);
      });
    });
    _db = drizzle(pool, { schema, mode: "default" });
  }
  return _db;
}

export function requireDb(): Db {
  const db = getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}

export async function getUserByOpenId(openId: string): Promise<User | undefined> {
  const db = getDb();
  if (!db) return undefined;
  const [row] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return row;
}

export async function getUserById(id: number): Promise<User | undefined> {
  const [row] = await requireDb().select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

const SEEN_REFRESH_MS = 5 * 60 * 1000;

/** Records activity for "active users" metrics without writing on every request. */
export async function markSeen(user: Pick<User, "id" | "lastSeenAt">) {
  const db = getDb();
  if (!db || (user.lastSeenAt && Date.now() - user.lastSeenAt.getTime() < SEEN_REFRESH_MS)) return;
  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
}

/**
 * Resolve (or create) the internal user linked to an external identity provider account.
 * The provider's subject never becomes the internal user id.
 */
export async function upsertProviderUser(input: {
  provider: string;
  providerAccountId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}): Promise<User> {
  const db = requireDb();
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select()
      .from(authAccounts)
      .where(and(eq(authAccounts.provider, input.provider), eq(authAccounts.providerAccountId, input.providerAccountId)))
      .limit(1);

    const refresh = async (userId: number) => {
      await tx
        .update(users)
        .set({
          name: input.name ?? undefined,
          email: input.email ?? undefined,
          avatarUrl: input.avatarUrl ?? undefined,
          lastSignedIn: new Date(),
        })
        .where(eq(users.id, userId));
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) throw new Error("ACCOUNT_USER_MISSING");
      return user;
    };

    if (link) return refresh(link.userId);

    // Users created before auth_accounts existed (legacy login) have no provider link yet.
    // Attach the verified email to that single existing row instead of creating a duplicate.
    if (input.email) {
      const legacy = await tx
        .select({ id: users.id })
        .from(users)
        .leftJoin(authAccounts, eq(authAccounts.userId, users.id))
        .where(
          and(
            sql`lower(${users.email}) = ${input.email.toLowerCase()}`,
            isNull(authAccounts.id),
            or(isNull(users.loginMethod), ne(users.loginMethod, "demo")),
          ),
        )
        .limit(2);
      if (legacy.length === 1) {
        await tx.insert(authAccounts).values({
          userId: legacy[0].id,
          provider: input.provider,
          providerAccountId: input.providerAccountId,
          providerEmail: input.email,
        });
        return refresh(legacy[0].id);
      }
    }

    const values: InsertUser = {
      openId: `usr_${nanoid(21)}`,
      name: input.name,
      email: input.email,
      avatarUrl: input.avatarUrl,
      loginMethod: input.provider,
      lastSignedIn: new Date(),
    };
    const [inserted] = await tx.insert(users).values(values).$returningId();
    await tx.insert(authAccounts).values({
      userId: inserted.id,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      providerEmail: input.email,
    });
    const [user] = await tx.select().from(users).where(eq(users.id, inserted.id)).limit(1);
    return user!;
  });
}

export async function setLastActiveContext(userId: number, context: UiContext) {
  await requireDb().update(users).set({ lastActiveContext: context }).where(eq(users.id, userId));
}

export async function setPreferredLocale(userId: number, locale: string) {
  await requireDb().update(users).set({ preferredLocale: locale }).where(eq(users.id, userId));
}
