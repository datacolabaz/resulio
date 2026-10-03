/** `auth_accounts.provider` for email + password sign-in; providerAccountId is the normalized email. */
export const PASSWORD_PROVIDER = "password";

export const PASSWORD_MIN_LENGTH = 8;
/** Generous for passphrases, but bounded so a request can't make the server hash megabytes. */
export const PASSWORD_MAX_LENGTH = 128;

/** Emails are compared case-insensitively everywhere; this is the one canonical form. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
