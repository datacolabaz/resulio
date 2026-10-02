import { and, eq, isNull, like, ne, or, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { nanoid } from "nanoid";
import * as schema from "../drizzle/schema";
import { authAccounts, users, type InsertUser, type UiContext, type User } from "../drizzle/schema";
import type { ReferralSource } from "../shared/referralSources";

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

/** Google login writes `auth_accounts` (migration 0002). Missing tables surface as login reason=db. */
export async function warnIfGoogleAuthSchemaMissing() {
  const db = getDb();
  if (!db) {
    console.warn("[GoogleAuth] DATABASE_URL is not set; sign-in cannot create users.");
    return;
  }
  try {
    await db.select({ id: authAccounts.id }).from(authAccounts).limit(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error("[GoogleAuth] Table auth_accounts is missing or unreadable:", message, "Apply drizzle migrations 0002–0004 (pnpm db:migrate). Google login will fail with reason=db.");
  }
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
 * The provider's subject never becomes the internal user id. `isNew` tells the caller whether
 * this call actually created the account -- referral attribution (see server/modules/referrals.ts)
 * must only ever apply to that moment, never to a later login by the same person.
 */
export async function upsertProviderUser(input: {
  provider: string;
  providerAccountId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}): Promise<{ user: User; isNew: boolean }> {
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
      return { user, isNew: false };
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
    return { user: user!, isNew: true };
  });
}

export async function setLastActiveContext(userId: number, context: UiContext) {
  await requireDb().update(users).set({ lastActiveContext: context }).where(eq(users.id, userId));
}

export async function setPreferredLocale(userId: number, locale: string) {
  await requireDb().update(users).set({ preferredLocale: locale }).where(eq(users.id, userId));
}

/**
 * Saves the optional student onboarding fields and marks onboarding as done, whether the
 * student filled anything in or skipped outright — either way it must not be asked again.
 * Every field is optional: an omitted field is left untouched, never cleared.
 */
export async function completeStudentOnboarding(
  userId: number,
  input: {
    timezone?: string;
    targetExam?: string;
    targetScore?: string;
    targetExamDate?: Date | null;
    referralSource?: ReferralSource;
    referrerUserId?: number | null;
    referrerName?: string | null;
  },
) {
  await requireDb()
    .update(users)
    .set({
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.targetExam !== undefined ? { targetExam: input.targetExam } : {}),
      ...(input.targetScore !== undefined ? { targetScore: input.targetScore } : {}),
      ...(input.targetExamDate !== undefined ? { targetExamDate: input.targetExamDate } : {}),
      ...(input.referralSource !== undefined ? { referralSource: input.referralSource } : {}),
      // Tagging a user and typing a name are mutually exclusive on the client, so whichever one
      // was sent wins outright and clears the other rather than leaving a stale value behind.
      ...(input.referrerUserId !== undefined ? { referrerUserId: input.referrerUserId, referrerName: null } : {}),
      ...(input.referrerName !== undefined ? { referrerName: input.referrerName, referrerUserId: null } : {}),
      studentOnboardedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/**
 * Up to 8 users (excluding the caller) whose name contains `query`, for the onboarding step's
 * "who recommended you" tag search. Name only — no email/avatar — since this is exposed to any
 * signed-in student searching for an arbitrary other person by name.
 */
export async function searchUsersByName(query: string, excludeUserId: number) {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const rows = await requireDb()
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(like(users.name, `%${trimmed}%`), ne(users.id, excludeUserId)))
    .limit(8);
  return rows.filter((r): r is { id: number; name: string } => !!r.name);
}
