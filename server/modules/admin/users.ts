import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { users } from "../../../drizzle/schema";
import { requireDb, type Tx } from "../../db";
import { platformRolesOf } from "../access";
import { AppError } from "../errors";
import { appendAudit } from "./audit";
import type { AdminContext } from "./authz";

export const USER_SORTS = ["newest", "lastSeen"] as const;
export type UserSort = (typeof USER_SORTS)[number];

/**
 * Paginated lookup by name/email substring — the admin UI's "find a user" box. No query returns
 * the most recent signups. `sortBy: "lastSeen"` answers "who's active on the site" by ordering on
 * `users.lastSeenAt` (kept live by `markSeen`, see server/_core/sdk.ts's `authenticateRequest` —
 * not a new tracking mechanism, just a new way to read the existing column); the `before` id
 * cursor only means anything for the default id-ordered paging, so it's ignored in that mode.
 */
export async function searchUsers(query: string | undefined, before: number | undefined, limit = 25, sortBy: UserSort = "newest") {
  const db = requireDb();
  const needle = query?.trim();
  const conditions = [
    sortBy === "newest" && before ? sql`${users.id} < ${before}` : undefined,
    needle ? or(like(users.name, `%${needle}%`), like(users.email, `%${needle}%`)) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      accountStatus: users.accountStatus,
      createdAt: users.createdAt,
      lastSignedIn: users.lastSignedIn,
      lastSeenAt: users.lastSeenAt,
    })
    .from(users)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sortBy === "lastSeen" ? desc(users.lastSeenAt) : desc(users.id))
    .limit(limit);
  return rows;
}

export async function getUser(userId: number) {
  const db = requireDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError("NOT_FOUND");
  const roles = await platformRolesOf(userId, db);
  const { passwordHash, ...safe } = user;
  return { ...safe, hasPassword: !!passwordHash, roles };
}

async function lockTarget(tx: Tx, admin: AdminContext, userId: number) {
  if (userId === admin.userId) throw new AppError("CANNOT_TARGET_SELF");
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  if (!user) throw new AppError("NOT_FOUND");
  return user;
}

/** Suspension also revokes every open session. Data is untouched; nothing is deleted. */
export async function suspendUser(admin: AdminContext, userId: number, reason: string) {
  return requireDb().transaction(async (tx) => {
    const user = await lockTarget(tx, admin, userId);
    if ((await platformRolesOf(userId, tx)).includes("SUPER_ADMIN")) throw new AppError("TARGET_IS_SUPER_ADMIN");
    if (user.accountStatus === "SUSPENDED") throw new AppError("ALREADY_SUSPENDED");
    const now = new Date();
    await tx.update(users).set({ accountStatus: "SUSPENDED", suspendedAt: now, sessionsValidAfter: now }).where(eq(users.id, userId));
    await appendAudit(
      tx,
      admin,
      {
        action: "USER_SUSPENDED",
        targetType: "USER",
        targetId: userId,
        userId,
        before: { accountStatus: user.accountStatus },
        after: { accountStatus: "SUSPENDED", sessionsValidAfter: now.toISOString() },
        reason,
      },
      admin.meta,
    );
    return { id: userId, accountStatus: "SUSPENDED" as const };
  });
}

export async function unsuspendUser(admin: AdminContext, userId: number, reason: string) {
  return requireDb().transaction(async (tx) => {
    const user = await lockTarget(tx, admin, userId);
    if (user.accountStatus !== "SUSPENDED") throw new AppError("NOT_SUSPENDED");
    await tx.update(users).set({ accountStatus: "ACTIVE", suspendedAt: null }).where(eq(users.id, userId));
    await appendAudit(
      tx,
      admin,
      {
        action: "USER_UNSUSPENDED",
        targetType: "USER",
        targetId: userId,
        userId,
        before: { accountStatus: "SUSPENDED", suspendedAt: user.suspendedAt?.toISOString() ?? null },
        after: { accountStatus: "ACTIVE" },
        reason,
      },
      admin.meta,
    );
    return { id: userId, accountStatus: "ACTIVE" as const };
  });
}

/** Ends every session issued so far; the user can sign in again with Google. */
export async function revokeSessions(admin: AdminContext, userId: number, reason: string) {
  return requireDb().transaction(async (tx) => {
    const user = await lockTarget(tx, admin, userId);
    const now = new Date();
    await tx.update(users).set({ sessionsValidAfter: now }).where(eq(users.id, userId));
    await appendAudit(
      tx,
      admin,
      {
        action: "USER_SESSIONS_REVOKED",
        targetType: "USER",
        targetId: userId,
        userId,
        before: { sessionsValidAfter: user.sessionsValidAfter?.toISOString() ?? null },
        after: { sessionsValidAfter: now.toISOString() },
        reason,
      },
      admin.meta,
    );
    return { id: userId, sessionsValidAfter: now };
  });
}
