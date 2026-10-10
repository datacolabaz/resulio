import type { SyllabusGrantState } from "@shared/syllabus";
import type { Access, PickStudent, Selection } from "./groupStudentSelection";

/** Syllabus "Grant access" dialog: grants are additive, so live grants show as already granted. */

export interface ExistingGrant {
  groupId: string | null;
  studentId: number | null;
  state: SyllabusGrantState;
}

const isLive = (state: SyllabusGrantState) => state === "ACTIVE" || state === "PENDING";

/** Groups with a live group grant, and students reached by a live grant (their own or one of their groups'). */
export function existingAccess(grants: readonly ExistingGrant[], students: readonly PickStudent[]): Access {
  const live = grants.filter((g) => isLive(g.state));
  const groups = new Set(live.flatMap((g) => (g.groupId ? [g.groupId] : [])));
  const reached = new Set(live.flatMap((g) => (g.studentId ? [g.studentId] : [])));
  for (const s of students) if (s.groupIds.some((g) => groups.has(g))) reached.add(s.id);
  return { groups, students: reached };
}

/** Preset from "Restore": groups come back whole, students as individual picks. */
export const selectionFromPreset = (preset: { groupIds: string[]; studentIds: number[] } | null): Selection => ({
  groupIds: preset?.groupIds ?? [],
  excluded: [],
  extra: preset?.studentIds ?? [],
});

/** Datetime inputs: both optional; the end must be after the start and still ahead. */
export function dateRangeError(startsAt: Date | null, endsAt: Date | null, now = new Date()): "badRange" | "endPast" | null {
  if (startsAt && endsAt && endsAt <= startsAt) return "badRange";
  if (endsAt && endsAt <= now) return "endPast";
  return null;
}
