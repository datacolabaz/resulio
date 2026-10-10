/**
 * How the group's invite code / `/join/<code>` link treats a student who uses it:
 * - AUTO: joins at once (ACTIVE membership).
 * - APPROVAL: becomes a PENDING request the teacher approves or declines.
 * - MANUAL: refused; only the teacher adds students.
 * Single-use links and e-mail invites are targeted and always join at once, whatever the policy.
 */
export const JOIN_POLICIES = ["AUTO", "APPROVAL", "MANUAL"] as const;
export type JoinPolicy = (typeof JOIN_POLICIES)[number];

/** Stored as `study_groups.joinPolicy` (AUTO | MANUAL) plus the `group_join_settings` approval flag. */
export function effectiveJoinPolicy(stored: "AUTO" | "MANUAL", approvalRequired: boolean): JoinPolicy {
  if (stored === "MANUAL") return "MANUAL";
  return approvalRequired ? "APPROVAL" : "AUTO";
}

/** After a teacher declines a code/link request, the same student can't ask that group again for this long. */
export const JOIN_REQUEST_COOLDOWN_MS = 24 * 60 * 60_000;
