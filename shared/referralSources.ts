/**
 * Where a new student says they heard about Resulio, asked once as part of the optional
 * student-onboarding step shown right after joining a teacher's group. Plain data (no DB
 * enum beyond this fixed list), labels live in the i18n catalog as `referralSource.<KEY>`.
 *
 * REFERRAL is special: the client follows it up by asking who recommended them, either by
 * tagging an existing Resulio user (`referrerUserId`) or, if that person isn't on Resulio,
 * typing their name (`referrerName`) — see `users.referrerUserId` / `users.referrerName`.
 */
export const REFERRAL_SOURCES = ["INSTAGRAM", "FACEBOOK", "TIKTOK", "GOOGLE_SEARCH", "REFERRAL", "OTHER"] as const;

export type ReferralSource = (typeof REFERRAL_SOURCES)[number];
