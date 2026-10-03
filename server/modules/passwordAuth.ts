import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { authAccounts, users, type User } from "../../drizzle/schema";
import { REAUTH_WINDOW_MS } from "../../shared/adminPermissions";
import { normalizeEmail, PASSWORD_PROVIDER } from "../../shared/auth";
import { setPasswordDecision } from "../_core/accountLinking";
import { hashPassword, needsRehash, verifyPassword } from "../_core/password";
import type { SessionTimes } from "../_core/sdk";
import { requireDb } from "../db";
import { AppError } from "./errors";

function isDuplicateKey(error: unknown): boolean {
  let cur: unknown = error;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    const o = cur as { code?: unknown; errno?: unknown; cause?: unknown };
    if (o.code === "ER_DUP_ENTRY" || o.errno === 1062) return true;
    cur = o.cause;
  }
  return false;
}

/**
 * Email + password sign-up. Refuses any email that already belongs to a user -- Google, legacy or
 * password -- so knowing someone's email is never enough to attach a password to their account.
 * Existing Google users add a password from Settings instead (setOwnPassword), and are told so
 * (GOOGLE_ACCOUNT_NO_PASSWORD) -- a deliberate, product-approved enumeration tradeoff. The unique
 * (provider, providerAccountId) index on auth_accounts settles concurrent sign-ups for one email.
 */
export async function registerWithPassword(input: { email: string; password: string; name: string }): Promise<{ user: User; isNew: true }> {
  const email = normalizeEmail(input.email);
  // Hashed before the lookup so a taken email answers no faster than a successful sign-up.
  const passwordHash = await hashPassword(input.password);
  try {
    return await requireDb().transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);
      if (existing) throw new AppError(existing.passwordHash ? "REGISTRATION_UNAVAILABLE" : "GOOGLE_ACCOUNT_NO_PASSWORD");
      const [inserted] = await tx
        .insert(users)
        .values({ openId: `usr_${nanoid(21)}`, name: input.name, email, loginMethod: PASSWORD_PROVIDER, lastSignedIn: new Date(), passwordHash })
        .$returningId();
      await tx.insert(authAccounts).values({ userId: inserted.id, provider: PASSWORD_PROVIDER, providerAccountId: email, providerEmail: email });
      const [user] = await tx.select().from(users).where(eq(users.id, inserted.id)).limit(1);
      return { user: user!, isNew: true as const };
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError("REGISTRATION_UNAVAILABLE");
    throw error;
  }
}

/**
 * One error for unknown email and wrong password, with the same scrypt work on both paths. An email
 * that belongs to a passwordless (Google-only) account gets GOOGLE_ACCOUNT_NO_PASSWORD instead, so
 * students who type their Gmail password learn to use the Google button.
 */
export async function loginWithPassword(input: { email: string; password: string }): Promise<{ user: User; isNew: false }> {
  const email = normalizeEmail(input.email);
  const db = requireDb();
  const [row] = await db
    .select({ user: users })
    .from(authAccounts)
    .innerJoin(users, eq(users.id, authAccounts.userId))
    .where(and(eq(authAccounts.provider, PASSWORD_PROVIDER), eq(authAccounts.providerAccountId, email)))
    .limit(1);
  const user = row?.user;
  const ok = await verifyPassword(input.password, user?.passwordHash);
  if (!user?.passwordHash) {
    const [passwordless] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.passwordHash)))
      .limit(1);
    throw new AppError(passwordless ? "GOOGLE_ACCOUNT_NO_PASSWORD" : "INVALID_CREDENTIALS");
  }
  if (!ok) throw new AppError("INVALID_CREDENTIALS");
  const rehashed = needsRehash(user.passwordHash) ? await hashPassword(input.password) : undefined;
  await db
    .update(users)
    .set({ lastSignedIn: new Date(), ...(rehashed ? { passwordHash: rehashed } : {}) })
    .where(eq(users.id, user.id));
  return { user, isNew: false };
}

/**
 * Adds or changes the signed-in user's own password (rules in setPasswordDecision). The password
 * login is (re)pointed at the account's current email. Changing an existing password ends every
 * other session; the caller must re-issue the current session cookie.
 */
export async function setOwnPassword(
  user: User,
  session: SessionTimes | null | undefined,
  input: { currentPassword?: string; newPassword: string },
  now = Date.now(),
): Promise<{ revokedOtherSessions: boolean }> {
  const email = user.email ? normalizeEmail(user.email) : null;
  const hasPassword = !!user.passwordHash;
  const db = requireDb();
  const currentPasswordOk = hasPassword && (await verifyPassword(input.currentPassword ?? "", user.passwordHash));
  const other = email
    ? await db
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(and(eq(authAccounts.provider, PASSWORD_PROVIDER), eq(authAccounts.providerAccountId, email), ne(authAccounts.userId, user.id)))
        .limit(1)
    : [];
  const denial = setPasswordDecision({
    hasEmail: !!email,
    hasPassword,
    currentPasswordOk,
    recentSignIn: !!session && now - session.authTimeMs <= REAUTH_WINDOW_MS,
    emailUsedByOtherUser: other.length > 0,
  });
  if (denial) throw new AppError(denial);

  const passwordHash = await hashPassword(input.newPassword);
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, ...(hasPassword ? { sessionsValidAfter: new Date(now) } : {}) })
        .where(eq(users.id, user.id));
      await tx.delete(authAccounts).where(and(eq(authAccounts.userId, user.id), eq(authAccounts.provider, PASSWORD_PROVIDER)));
      await tx.insert(authAccounts).values({ userId: user.id, provider: PASSWORD_PROVIDER, providerAccountId: email!, providerEmail: email });
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError("PASSWORD_EMAIL_IN_USE");
    throw error;
  }
  return { revokedOtherSessions: hasPassword };
}
