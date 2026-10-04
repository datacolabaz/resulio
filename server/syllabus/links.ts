import { and, eq, inArray, isNull } from "drizzle-orm";
import { syllabi, syllabusAccessGrants, syllabusEnrollments, syllabusItems, type SyllabusAccessGrant } from "../../drizzle/schema";
import type { SyllabusGrantState, SyllabusItemKind } from "../../shared/syllabus";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { assertGroupOwner } from "../modules/groups";
import { grantState } from "./accessRules";
import { contentRefs } from "./authoring";
import * as store from "./store";

/**
 * Read-only cross-links from existing screens into syllabi: which syllabi a group has, and how many
 * syllabi point at each library material. Nothing here changes groups or materials.
 */

const STATE_ORDER: SyllabusGrantState[] = ["ACTIVE", "PENDING", "EXPIRED", "REVOKED"];

export interface GroupSyllabusRow {
  id: string;
  title: string;
  state: SyllabusGrantState;
  endsAt: Date | null;
  archived: boolean;
  members: number;
  enrolled: number;
  completed: number;
  averageProgressPct: number;
}

/** One row per syllabus granted to the group; syllabi whose only grants were revoked are left out. */
export function groupSyllabusRows(input: {
  workspaceId: string;
  grants: ReadonlyArray<Pick<SyllabusAccessGrant, "syllabusId" | "status" | "startsAt" | "endsAt">>;
  syllabi: ReadonlyArray<{ id: string; title: string; providerWorkspaceId: string; archivedAt: Date | null }>;
  memberIds: readonly number[];
  enrollments: ReadonlyArray<{ syllabusId: string; studentId: number; progressPct: number; status: string }>;
  now: Date;
}): GroupSyllabusRow[] {
  const members = new Set(input.memberIds);
  const rows: GroupSyllabusRow[] = [];
  for (const s of input.syllabi) {
    if (s.providerWorkspaceId !== input.workspaceId) continue;
    const mine = input.grants.filter((g) => g.syllabusId === s.id);
    const states = mine.map((g) => ({ g, state: grantState(g, input.now) }));
    const state = STATE_ORDER.find((st) => states.some((x) => x.state === st));
    if (!state || state === "REVOKED") continue;
    const ends = states.filter((x) => x.state === state).map((x) => x.g.endsAt);
    const endsAt = ends.includes(null) ? null : (ends.filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null);
    const enrolled = input.enrollments.filter((e) => e.syllabusId === s.id && members.has(e.studentId));
    const avg = enrolled.length ? enrolled.reduce((sum, e) => sum + Number(e.progressPct), 0) / enrolled.length : 0;
    rows.push({
      id: s.id,
      title: s.title,
      state,
      endsAt,
      archived: !!s.archivedAt,
      members: members.size,
      enrolled: enrolled.length,
      completed: enrolled.filter((e) => e.status === "COMPLETED").length,
      averageProgressPct: Math.round(avg * 10) / 10,
    });
  }
  return rows.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.title.localeCompare(b.title));
}

export async function syllabiForGroup(scope: TeacherScope, groupId: string) {
  const db = requireDb();
  await assertGroupOwner(scope, groupId, db);
  const grants = await db.select().from(syllabusAccessGrants).where(eq(syllabusAccessGrants.groupId, groupId));
  if (!grants.length) return [];
  const ids = [...new Set(grants.map((g) => g.syllabusId))];
  const [rows, members] = await Promise.all([store.syllabiByIds(ids), store.activeMembersWithNames(groupId)]);
  const memberIds = members.map((m) => m.studentId);
  const enrollments = memberIds.length
    ? await db
        .select({ syllabusId: syllabusEnrollments.syllabusId, studentId: syllabusEnrollments.studentId, progressPct: syllabusEnrollments.progressPct, status: syllabusEnrollments.status })
        .from(syllabusEnrollments)
        .where(and(inArray(syllabusEnrollments.syllabusId, ids), inArray(syllabusEnrollments.studentId, memberIds)))
    : [];
  return groupSyllabusRows({ workspaceId: scope.workspaceId, grants, syllabi: rows, memberIds, enrollments, now: new Date() });
}

/** materialId → number of distinct syllabi whose draft references it (theory blocks or resource items). */
export function materialUsageCounts(items: ReadonlyArray<{ syllabusId: string; kind: SyllabusItemKind; content: Record<string, unknown> }>) {
  const bySyllabus = new Map<string, Set<string>>();
  for (const it of items) {
    for (const materialId of contentRefs(it.kind, it.content ?? {}).materialIds) {
      const set = bySyllabus.get(materialId) ?? new Set<string>();
      set.add(it.syllabusId);
      bySyllabus.set(materialId, set);
    }
  }
  return [...bySyllabus].map(([materialId, set]) => ({ materialId, syllabi: set.size }));
}

export async function materialUsage(scope: TeacherScope) {
  const items = await requireDb()
    .select({ syllabusId: syllabusItems.syllabusId, kind: syllabusItems.kind, content: syllabusItems.content })
    .from(syllabusItems)
    .innerJoin(syllabi, eq(syllabi.id, syllabusItems.syllabusId))
    .where(and(eq(syllabi.providerWorkspaceId, scope.workspaceId), isNull(syllabusItems.deletedAt), inArray(syllabusItems.kind, ["THEORY", "RESOURCE"])));
  return materialUsageCounts(items);
}
