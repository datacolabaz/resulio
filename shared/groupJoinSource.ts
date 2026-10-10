/**
 * How a student became a member of a group. Stored per membership in `group_member_sources` as free
 * text (not a DB enum), so a new join path never needs a migration. Exam share links are not here:
 * they never add anyone to a group or to an exam's roster.
 */
export const GROUP_JOIN_SOURCES = [
  /** The group's multi-use invite code or its `/join/<code>` link. */
  "GROUP_CODE_LINK",
  /** A single-use `/g/<token>` link. */
  "SINGLE_USE_LINK",
  /** An e-mail-restricted `/invite/<token>` link. */
  "EMAIL_INVITE",
  /** The teacher added an existing user by e-mail. */
  "TEACHER_ADDED",
  /** The teacher approved a request left PENDING by the retired approval policy. */
  "TEACHER_APPROVED",
  /** The teacher accepted a syllabus join request for this group. */
  "SYLLABUS_REQUEST",
  /** Joined before sources were recorded and nothing on record says how. */
  "UNKNOWN",
] as const;

export type GroupJoinSource = (typeof GROUP_JOIN_SOURCES)[number];

export const isGroupJoinSource = (v: string): v is GroupJoinSource => (GROUP_JOIN_SOURCES as readonly string[]).includes(v);

/** What the teacher sees about one membership's origin. `detail` is a link label, invited e-mail or syllabus title. */
export interface JoinSourceView {
  joinedVia: GroupJoinSource;
  joinedAt: Date;
  detail: string | null;
}
