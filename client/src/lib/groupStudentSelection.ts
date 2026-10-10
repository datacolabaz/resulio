/**
 * Groups-and-students picker (syllabus access, materials, tasks, exams): students follow the
 * selected groups. A selected group whose students are all checked is saved as a group (students
 * who join later are covered too); a partially checked group is saved as its checked students.
 */

export interface PickStudent {
  id: number;
  name: string | null;
  email: string | null;
  groupIds: string[];
}

export interface Selection {
  groupIds: string[];
  /** Members of selected groups the teacher unchecked. */
  excluded: number[];
  /** Students picked individually (search / saved targets), outside the group lists. */
  extra: number[];
}

/** Groups and students that already have access and are shown locked ("girişi var"). */
export interface Access {
  groups: ReadonlySet<string>;
  students: ReadonlySet<number>;
}

export const emptySelection = (): Selection => ({ groupIds: [], excluded: [], extra: [] });

export const noAccess: Access = { groups: new Set(), students: new Set() };

export const membersOf = <S extends PickStudent>(groupId: string, students: readonly S[]) => students.filter((s) => s.groupIds.includes(groupId));

export function isChecked(sel: Selection, student: PickStudent, access: Access = noAccess) {
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

export interface SelectionPlan {
  groupIds: string[];
  studentIds: number[];
  /** Selected groups saved as individual students because someone was unchecked. */
  partialGroupIds: string[];
  /** Students reached (newly, when some already have access). */
  studentCount: number;
}

export function planSelection(sel: Selection, students: readonly PickStudent[], access: Access = noAccess): SelectionPlan {
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

/**
 * Saved targets back into the picker. A group that is not saved but has some (not all) of its
 * uncovered members saved individually reopens as a partial group, the group explaining the most
 * picks first, so a student in two groups doesn't also open the second one; students saved
 * individually that no group explains stay as picks. Ids the picker cannot show (e.g. students
 * who joined through a share link, not a group) come back in `kept` and must be saved unchanged.
 */
export function selectionFromTargets(
  targets: { groupIds: readonly string[]; studentIds: readonly number[] },
  groups: readonly { id: string }[],
  students: readonly PickStudent[],
): { selection: Selection; kept: number[] } {
  const known = new Set(students.map((s) => s.id));
  const groupIds = targets.groupIds.filter((g) => groups.some((x) => x.id === g));
  const picked = new Set(targets.studentIds.filter((id) => known.has(id)));
  const kept = targets.studentIds.filter((id) => !known.has(id));
  const covered = new Set(students.filter((s) => s.groupIds.some((g) => groupIds.includes(g))).map((s) => s.id));
  const partial: string[] = [];
  const excluded = new Set<number>();
  const shown = new Set<number>();
  const candidates = groups
    .filter((g) => !groupIds.includes(g.id))
    .map((g) => ({ id: g.id, uncovered: membersOf(g.id, students).filter((s) => !covered.has(s.id)) }))
    .filter((c) => c.uncovered.some((s) => !picked.has(s.id)));
  for (;;) {
    let best: (typeof candidates)[number] | null = null;
    let bestCount = 0;
    for (const c of candidates) {
      if (partial.includes(c.id)) continue;
      const count = c.uncovered.filter((s) => picked.has(s.id) && !shown.has(s.id)).length;
      if (count > bestCount) [best, bestCount] = [c, count];
    }
    if (!best) break;
    partial.push(best.id);
    for (const s of best.uncovered) (picked.has(s.id) ? shown : excluded).add(s.id);
  }
  const extra = [...picked].filter((id) => !shown.has(id) && !covered.has(id));
  return { selection: { groupIds: [...groupIds, ...partial], excluded: [...excluded], extra }, kept };
}

/**
 * What a form sends. `groupsOnly`: the target only supports whole groups (a group-restricted
 * task), so every selected group is saved and no individual students.
 */
export function recipientsPayload(sel: Selection, students: readonly PickStudent[], opts: { kept?: readonly number[]; groupsOnly?: boolean } = {}) {
  if (opts.groupsOnly) return { groupIds: [...sel.groupIds], studentIds: [] as number[] };
  const plan = planSelection(sel, students);
  return { groupIds: plan.groupIds, studentIds: [...new Set([...plan.studentIds, ...(opts.kept ?? [])])] };
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u0259/g, "a");

/** Case-, accent- and Azerbaijani-letter-insensitive ("ali" finds "Əli"), on name and email. */
export function searchStudents<S extends PickStudent>(students: readonly S[], query: string, limit = 8): S[] {
  const q = fold(query.trim());
  if (!q) return [];
  return students.filter((s) => fold(`${s.name ?? ""} ${s.email ?? ""}`).includes(q)).slice(0, limit);
}
