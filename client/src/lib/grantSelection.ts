import type { SyllabusGrantState } from "@shared/syllabus";

/**
 * "Grant access" dialog: students follow the selected groups. A group whose students are all
 * checked becomes a group grant (late joiners get access too); a partially checked group becomes
 * individual grants for the checked students only.
 */

export interface PickStudent {
  id: number;
  name: string | null;
  email: string | null;
  groupIds: string[];
}

export interface ExistingGrant {
  groupId: string | null;
  studentId: number | null;
  state: SyllabusGrantState;
}

export interface Selection {
  groupIds: string[];
  /** Members of selected groups the teacher unchecked. */
  excluded: number[];
  /** Students picked individually (search / preset), outside the group lists. */
  extra: number[];
}

export const emptySelection = (): Selection => ({ groupIds: [], excluded: [], extra: [] });

const isLive = (state: SyllabusGrantState) => state === "ACTIVE" || state === "PENDING";

/** Groups with a live group grant, and students reached by a live grant (their own or one of their groups'). */
export function existingAccess(grants: readonly ExistingGrant[], students: readonly PickStudent[]) {
  const live = grants.filter((g) => isLive(g.state));
  const groups = new Set(live.flatMap((g) => (g.groupId ? [g.groupId] : [])));
  const reached = new Set(live.flatMap((g) => (g.studentId ? [g.studentId] : [])));
  for (const s of students) if (s.groupIds.some((g) => groups.has(g))) reached.add(s.id);
  return { groups, students: reached };
}

export type Access = ReturnType<typeof existingAccess>;

export const membersOf = (groupId: string, students: readonly PickStudent[]) => students.filter((s) => s.groupIds.includes(groupId));

export function isChecked(sel: Selection, student: PickStudent, access: Access) {
  if (access.students.has(student.id) || sel.extra.includes(student.id)) return true;
  return student.groupIds.some((g) => sel.groupIds.includes(g)) && !sel.excluded.includes(student.id);
}

/** Selecting a group checks all its students; leaving it forgets unchecks that no longer apply. */
export function toggleGroup(sel: Selection, groupId: string, students: readonly PickStudent[]): Selection {
  const inGroup = (id: number, groupIds: readonly string[]) => students.some((s) => s.id === id && s.groupIds.some((g) => groupIds.includes(g)));
  if (sel.groupIds.includes(groupId)) {
    const groupIds = sel.groupIds.filter((g) => g !== groupId);
    return { groupIds, excluded: sel.excluded.filter((id) => inGroup(id, groupIds)), extra: sel.extra };
  }
  const groupIds = [...sel.groupIds, groupId];
  return { groupIds, excluded: sel.excluded, extra: sel.extra.filter((id) => !inGroup(id, [groupId])) };
}

export function setStudentChecked(sel: Selection, student: PickStudent, checked: boolean): Selection {
  const inSelectedGroup = student.groupIds.some((g) => sel.groupIds.includes(g));
  const excluded = sel.excluded.filter((id) => id !== student.id);
  const extra = sel.extra.filter((id) => id !== student.id);
  if (checked) return { ...sel, excluded, extra: inSelectedGroup ? extra : [...extra, student.id] };
  return { ...sel, excluded: inSelectedGroup ? [...excluded, student.id] : excluded, extra };
}

export interface GrantPlan {
  groupIds: string[];
  studentIds: number[];
  /** Selected groups that become individual grants because someone was unchecked. */
  partialGroupIds: string[];
  /** Students who get access now and did not have it before. */
  studentCount: number;
}

export function planGrant(sel: Selection, students: readonly PickStudent[], access: Access): GrantPlan {
  const excluded = new Set(sel.excluded);
  const groupIds: string[] = [];
  const partialGroupIds: string[] = [];
  const viaGroup = new Set<number>();
  const individual = new Set<number>();
  for (const groupId of sel.groupIds) {
    if (access.groups.has(groupId)) continue;
    const eligible = membersOf(groupId, students).filter((s) => !access.students.has(s.id));
    if (eligible.every((s) => !excluded.has(s.id))) {
      groupIds.push(groupId);
      for (const s of eligible) viaGroup.add(s.id);
    } else {
      partialGroupIds.push(groupId);
      for (const s of eligible) if (!excluded.has(s.id)) individual.add(s.id);
    }
  }
  for (const id of sel.extra) if (!access.students.has(id)) individual.add(id);
  const studentIds = [...individual].filter((id) => !viaGroup.has(id));
  return { groupIds, studentIds, partialGroupIds, studentCount: viaGroup.size + studentIds.length };
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u0259/g, "a");

export function searchStudents<S extends PickStudent>(students: readonly S[], query: string, limit = 8): S[] {
  const q = fold(query.trim());
  if (!q) return [];
  return students.filter((s) => fold(`${s.name ?? ""} ${s.email ?? ""}`).includes(q)).slice(0, limit);
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
