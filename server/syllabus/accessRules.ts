import type { SyllabusGrantState } from "../../shared/syllabus";

/**
 * Access ≠ progress (§43): these rules decide only whether a student may open a syllabus now.
 * Revocation or expiry never touches the enrollment, so re-granting restores everything (§27).
 */

export interface GrantLike {
  id: string;
  groupId: string | null;
  studentId: number | null;
  status: "ACTIVE" | "REVOKED";
  startsAt: Date | null;
  endsAt: Date | null;
}

/** PENDING and EXPIRED are derived from the dates and never stored. */
export function grantState(g: Pick<GrantLike, "status" | "startsAt" | "endsAt">, now: Date): SyllabusGrantState {
  if (g.status === "REVOKED") return "REVOKED";
  if (g.startsAt && g.startsAt.getTime() > now.getTime()) return "PENDING";
  if (g.endsAt && g.endsAt.getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

export const grantReaches = (g: Pick<GrantLike, "groupId" | "studentId">, studentId: number, activeGroupIds: readonly string[]) =>
  g.studentId === studentId || (g.groupId !== null && activeGroupIds.includes(g.groupId));

/** The grant that currently lets this student in (an individual grant wins over a group grant), or null. */
export function effectiveGrant<G extends GrantLike>(grants: readonly G[], studentId: number, activeGroupIds: readonly string[], now: Date): G | null {
  const live = grants.filter((g) => grantState(g, now) === "ACTIVE" && grantReaches(g, studentId, activeGroupIds));
  return live.find((g) => g.studentId === studentId) ?? live[0] ?? null;
}

/** The most meaningful state to show a student whose grants reach them: ACTIVE > PENDING > EXPIRED > REVOKED. */
export function bestGrantState(grants: readonly GrantLike[], studentId: number, activeGroupIds: readonly string[], now: Date): SyllabusGrantState | null {
  const order: SyllabusGrantState[] = ["ACTIVE", "PENDING", "EXPIRED", "REVOKED"];
  const states = grants.filter((g) => grantReaches(g, studentId, activeGroupIds)).map((g) => grantState(g, now));
  return order.find((s) => states.includes(s)) ?? null;
}
