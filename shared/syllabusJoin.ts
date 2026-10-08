/**
 * Public syllabus share link (`/syllabus/<code>`) and the join requests students send from it.
 * Separate from group invite codes: the link only shows a published syllabus and lets a signed-in
 * student ask the teacher to be added to an upcoming group or for individual participation.
 */

export const JOIN_REQUEST_TYPES = ["GROUP", "INDIVIDUAL"] as const;
export type JoinRequestType = (typeof JOIN_REQUEST_TYPES)[number];

export const JOIN_REQUEST_STATUSES = ["PENDING", "ACCEPTED", "REJECTED", "CANCELLED"] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const JOIN_DECISIONS = ["ACCEPTED", "REJECTED"] as const;
export type JoinDecision = (typeof JOIN_DECISIONS)[number];

export const JOIN_MESSAGE_MAX = 1000;
export const JOIN_DECISION_NOTE_MAX = 500;

/** Groups starting from today (Asia/Baku) up to this many days ahead are offered on the page. */
export const UPCOMING_GROUP_WINDOW_DAYS = 90;

/** 32 unambiguous characters × 12 ≈ 60 bits: unguessable, still short enough to type from a poster. */
export const SHARE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const SHARE_CODE_LENGTH = 12;
const SHARE_CODE_PATTERN = new RegExp(`^[${SHARE_CODE_ALPHABET}]{${SHARE_CODE_LENGTH}}$`);

/** Case-insensitive; null for anything that cannot be a share code (never looked up). */
export function normalizeShareCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return SHARE_CODE_PATTERN.test(code) ? code : null;
}

export const syllabusSharePath = (code: string) => `/syllabus/${encodeURIComponent(code)}`;

/** Document and link-preview title of the public page. */
export const syllabusPageTitle = (title: string) => (title.trim() ? `${title.trim()} — Syllabus | Resulio` : "Syllabus | Resulio");
