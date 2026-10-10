import { and, eq, inArray } from "drizzle-orm";
import { groupMembers, syllabusAccessGrants, syllabusEnrollments } from "../../drizzle/schema";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { ownedSyllabus } from "./access";
import { grantState } from "./accessRules";
import { buildPopulation, population, type GrantRow } from "./analytics";
import type { PopulationStudent } from "./analyticsCompute";
import * as store from "./store";

/**
 * "Who is this syllabus for": the numbers on a syllabus card and the student list behind them.
 * Both come from `buildPopulation` (the Analytics tab's population), so the card, the popover and
 * the tracking tab always count the same students.
 */

export const ROSTER_SORTS = ["progress", "activity"] as const;
export type RosterSort = (typeof ROSTER_SORTS)[number];
export const ROSTER_LIMIT_DEFAULT = 25;
export const ROSTER_LIMIT_MAX = 100;

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface RosterSummary {
  /** Distinct students who may open the syllabus right now (group members and individual grants). */
  students: number;
  /** Reached only by grants that start later. */
  pending: number;
  /** Access expired, revoked, or no grant left (they still have an enrollment). */
  ended: number;
  /** Everyone in the list: students + pending + ended. */
  total: number;
  /** Own groups with a grant that is active or starts later. */
  groups: number;
  /** Students with an individual grant that is active or starts later. */
  individual: number;
  /** Students who opened the syllabus, and their average progress. */
  enrolled: number;
  averageProgressPct: number;
}

/** Pure: the card numbers from one syllabus's population, grants and enrollments. */
export function rosterSummary(input: {
  students: readonly Pick<PopulationStudent, "access">[];
  grants: readonly GrantRow[];
  ownGroupIds: Iterable<string>;
  enrollments: ReadonlyArray<{ progressPct: number }>;
  now: Date;
}): RosterSummary {
  const own = new Set(input.ownGroupIds);
  const live = input.grants.filter((g) => {
    const s = grantState(g, input.now);
    return s === "ACTIVE" || s === "PENDING";
  });
  const count = (pred: (s: Pick<PopulationStudent, "access">) => boolean) => input.students.filter(pred).length;
  const students = count((s) => s.access === "ACTIVE");
  const pending = count((s) => s.access === "PENDING");
  const n = input.enrollments.length;
  return {
    students,
    pending,
    ended: input.students.length - students - pending,
    total: input.students.length,
    groups: new Set(live.flatMap((g) => (g.groupId && own.has(g.groupId) ? [g.groupId] : []))).size,
    individual: new Set(live.flatMap((g) => (g.studentId ? [g.studentId] : []))).size,
    enrolled: n,
    averageProgressPct: n ? round1(input.enrollments.reduce((sum, e) => sum + e.progressPct, 0) / n) : 0,
  };
}

/** Card numbers for every syllabus of the list page in a fixed number of queries. */
export async function rosterSummaries(workspaceId: string, syllabusIds: readonly string[], now = new Date()) {
  const result = new Map<string, RosterSummary>();
  if (!syllabusIds.length) return result;
  const db = requireDb();
  const ids = [...syllabusIds];
  const [grants, enrollments] = await Promise.all([
    db.select().from(syllabusAccessGrants).where(inArray(syllabusAccessGrants.syllabusId, ids)),
    db
      .select({ syllabusId: syllabusEnrollments.syllabusId, studentId: syllabusEnrollments.studentId, viaGroupId: syllabusEnrollments.viaGroupId, progressPct: syllabusEnrollments.progressPct })
      .from(syllabusEnrollments)
      .where(inArray(syllabusEnrollments.syllabusId, ids)),
  ]);
  const groups = (await store.groupsByIds([...new Set(grants.flatMap((g) => (g.groupId ? [g.groupId] : [])))], db)).filter((g) => g.workspaceId === workspaceId);
  const members = groups.length
    ? await db
        .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
        .from(groupMembers)
        .where(and(inArray(groupMembers.groupId, groups.map((g) => g.id)), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")))
    : [];
  for (const id of ids) {
    const g = grants.filter((r) => r.syllabusId === id);
    const e = enrollments.filter((r) => r.syllabusId === id);
    const built = buildPopulation({ workspaceId, grants: g, enrollments: e, groups, members, names: new Map(), now });
    result.set(id, rosterSummary({ students: built.students, grants: g, ownGroupIds: built.groups.map((x) => x.id), enrollments: e, now }));
  }
  return result;
}

export interface RosterRow {
  studentId: number;
  name: string;
  access: PopulationStudent["access"];
  /** Names of the teacher's groups that give the current access. */
  groups: string[];
  individual: boolean;
  /** null = has not opened the syllabus yet. */
  progressPct: number | null;
  completed: boolean;
  lastActivityAt: Date | null;
}

const CURRENT = new Set(["ACTIVE", "PENDING"]);

/** Pure: current students (active or starting later) first, then by the chosen key, then by name. */
export function sortRoster(rows: RosterRow[], sort: RosterSort) {
  const key = (r: RosterRow) => (sort === "progress" ? (r.progressPct ?? -1) : (r.lastActivityAt?.getTime() ?? -1));
  return rows.sort((a, b) => Number(CURRENT.has(b.access)) - Number(CURRENT.has(a.access)) || key(b) - key(a) || a.name.localeCompare(b.name));
}

/** The card popover: owner only, one syllabus, at most `limit` rows plus the full summary. */
export async function syllabusRoster(scope: TeacherScope, syllabusId: string, opts: { sort: RosterSort; limit: number }) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  const now = new Date();
  const { students, groups, enrollments, grants } = await population(syllabus, requireDb());
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const enrollmentOf = new Map(enrollments.map((e) => [e.studentId, e]));
  const rows = students.map((s): RosterRow => {
    const e = enrollmentOf.get(s.studentId);
    return {
      studentId: s.studentId,
      name: s.name,
      access: s.access,
      groups: s.via.groupIds.flatMap((id) => groupName.get(id) ?? []),
      individual: s.via.individual,
      progressPct: e ? round1(e.progressPct) : null,
      completed: e?.status === "COMPLETED",
      lastActivityAt: e ? (e.lastActivityAt ?? e.enrolledAt) : null,
    };
  });
  const limit = Math.min(Math.max(1, Math.floor(opts.limit)), ROSTER_LIMIT_MAX);
  return {
    summary: rosterSummary({ students, grants, ownGroupIds: groupName.keys(), enrollments, now }),
    students: sortRoster(rows, opts.sort).slice(0, limit),
  };
}
