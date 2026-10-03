import { PASSWORD_PROVIDER } from "@shared/auth";

/** An existing users row whose email matches the email a provider (e.g. Google) just verified. */
export type LinkCandidate = {
  userId: number;
  /** Every auth_accounts.provider already linked to this user. */
  providers: string[];
  hasPassword: boolean;
  loginMethod: string | null;
};

export type LinkPlan = { action: "CREATE" } | { action: "LINK"; userId: number; dropPassword: boolean };

/**
 * Decides what a first-time provider sign-in (no auth_accounts row for this provider subject yet)
 * does with existing users that share its verified email:
 *
 * - Only users with no provider link besides email + password are eligible: legacy rows from before
 *   auth_accounts existed, and password-only accounts. A user already linked to another Google
 *   account is never merged, so two Google accounts sharing an email stay two users.
 * - Exactly one eligible user: link to it, so Google and email + password reach the same account.
 * - That user's password was set by someone who never proved they own the email (there is no
 *   email verification for sign-up), so it is dropped. Otherwise an attacker could pre-register a
 *   victim's email with a password and keep access after the real owner signs in with Google.
 *   The owner can set a new password from Settings once signed in.
 * - Zero or several eligible users: create a fresh user rather than guess.
 */
export function providerLinkPlan(provider: string, candidates: LinkCandidate[]): LinkPlan {
  const eligible = candidates.filter(
    (c) => c.loginMethod !== "demo" && !c.providers.includes(provider) && c.providers.every((p) => p === PASSWORD_PROVIDER),
  );
  if (eligible.length !== 1) return { action: "CREATE" };
  return { action: "LINK", userId: eligible[0].userId, dropPassword: eligible[0].hasPassword };
}

export type SetPasswordDenial = "PASSWORD_NO_EMAIL" | "INVALID_CURRENT_PASSWORD" | "REAUTH_REQUIRED" | "PASSWORD_EMAIL_IN_USE";

/**
 * Self-service password rules for a signed-in user (the only way an existing Google account gets
 * a password -- sign-up refuses emails that already have an account):
 * - changing an existing password needs the current one;
 * - adding the first password needs a recent sign-in, so a long-lived session left open on a shared
 *   computer can't be turned into a permanent password login;
 * - the email can't already be the password login of a different user.
 */
export function setPasswordDecision(input: {
  hasEmail: boolean;
  hasPassword: boolean;
  currentPasswordOk: boolean;
  recentSignIn: boolean;
  emailUsedByOtherUser: boolean;
}): SetPasswordDenial | null {
  if (!input.hasEmail) return "PASSWORD_NO_EMAIL";
  if (input.hasPassword && !input.currentPasswordOk) return "INVALID_CURRENT_PASSWORD";
  if (!input.hasPassword && !input.recentSignIn) return "REAUTH_REQUIRED";
  if (input.emailUsedByOtherUser) return "PASSWORD_EMAIL_IN_USE";
  return null;
}
