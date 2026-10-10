import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  attempts,
  groupMembers,
  learningActivity,
  results,
  syllabi,
  syllabusAnalyticsSettings,
  syllabusEnrollments,
  syllabusItemProgress,
  syllabusLessonProgress,
  syllabusModuleProgress,
  taskSubmissions,
  users,
  type Syllabus,
} from "../../drizzle/schema";
import type { SyllabusGrantState } from "../../shared/syllabus";
import {
  ACTIVITY_RETENTION_MONTHS,
  resolveAnalyticsSettings,
  type AnalyticsSettings,
  type RiskThresholds,
} from "../../shared/syllabusAnalytics";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { dispatch } from "../notifications/dispatcher";
import { isMissingTable } from "../notifications/preferences";
import { ownedSyllabus } from "./access";
import { grantState } from "./accessRules";
import { computeAnalytics, mergedOutline, type AnalyticsData, type PopulationStudent } from "./analyticsCompute";
import { syllabusEnabledFor } from "./availability";
import { allItems, locateItem } from "./engine";
import * as store from "./store";
import type { VersionStructure } from "./types";

/**
 * Teacher analytics for one syllabus (§32–§40), the student timeline (§30), the daily at-risk digest
 * and the activity retention job. Privacy (§41): every teacher read starts from `ownedSyllabus`, so
 * only the teacher's own syllabus, its grants (own groups, own students) and its enrollments are read.
 */

const STATE_RANK: Record<SyllabusGrantState, number> = { ACTIVE: 0, PENDING: 1, EXPIRED: 2, REVOKED: 3 };

// ---------------------------------------------------------------------------
// Settings (thresholds + digest); no row or no table yet = defaults
// ---------------------------------------------------------------------------

export async function settingsOf(syllabusId: string, db: DbOrTx = requireDb()): Promise<AnalyticsSettings> {
  try {
    const [row] = await db.select().from(syllabusAnalyticsSettings).where(eq(syllabusAnalyticsSettings.syllabusId, syllabusId)).limit(1);
    return resolveAnalyticsSettings(row ?? null);
  } catch (error) {
    if (isMissingTable(error)) return resolveAnalyticsSettings(null);
    throw error;
  }
}

export async function getSettings(scope: TeacherScope, syllabusId: string) {
  await ownedSyllabus(scope, syllabusId);
  return settingsOf(syllabusId);
}

export async function saveSettings(scope: TeacherScope, syllabusId: string, settings: AnalyticsSettings) {
  await ownedSyllabus(scope, syllabusId);
  try {
    await requireDb()
      .insert(syllabusAnalyticsSettings)
      .values({ syllabusId, thresholds: settings.thresholds, digestEnabled: settings.digestEnabled, updatedBy: scope.userId })
      .onDuplicateKeyUpdate({ set: { thresholds: settings.thresholds, digestEnabled: settings.digestEnabled, updatedBy: scope.userId } });
  } catch (error) {
    if (isMissingTable(error)) throw new AppError("SYLLABUS_DB_NOT_READY");
    throw error;
  }
  return settingsOf(syllabusId);
}

// ---------------------------------------------------------------------------
// Loading: a fixed number of indexed queries per syllabus, whatever the class size
// ---------------------------------------------------------------------------

export type GrantRow = Parameters<typeof grantState>[0] & { groupId: string | null; studentId: number | null; grantedAt: Date };

/**
 * Pure: who the syllabus reaches. Students of the teacher's own granted groups (active student
 * members only), individually granted students, and anyone who already has an enrollment.
 * Groups of another workspace are ignored even if a grant row ever pointed at one.
 */
export function buildPopulation(input: {
  workspaceId: string;
  grants: readonly GrantRow[];
  enrollments: ReadonlyArray<{ studentId: number; viaGroupId: string | null }>;
  groups: ReadonlyArray<{ id: string; name: string; workspaceId: string }>;
  members: ReadonlyArray<{ groupId: string; userId: number }>;
  names: ReadonlyMap<number, string>;
  now: Date;
}) {
  const groups = input.groups.filter((g) => g.workspaceId === input.workspaceId);
  const own = new Set(groups.map((g) => g.id));
  const membersOf = new Map<string, number[]>();
  for (const m of input.members) if (own.has(m.groupId)) (membersOf.get(m.groupId) ?? membersOf.set(m.groupId, []).get(m.groupId)!).push(m.userId);

  const reached = new Map<number, { state: SyllabusGrantState; since: Date | null; groupIds: Set<string>; viaGroups: Set<string>; individual: boolean }>();
  for (const g of input.grants) {
    if (g.groupId && !own.has(g.groupId)) continue;
    const state = grantState(g, input.now);
    const since = state === "ACTIVE" ? (g.startsAt ?? g.grantedAt) : null;
    for (const id of g.studentId ? [g.studentId] : (membersOf.get(g.groupId!) ?? [])) {
      const prev = reached.get(id) ?? { state, since, groupIds: new Set<string>(), viaGroups: new Set<string>(), individual: false };
      if (STATE_RANK[state] < STATE_RANK[prev.state]) Object.assign(prev, { state, viaGroups: new Set<string>(), individual: false });
      if (state === prev.state) {
        if (g.groupId) prev.viaGroups.add(g.groupId);
        else prev.individual = true;
      }
      if (since && (!prev.since || since < prev.since)) prev.since = since;
      if (g.groupId) prev.groupIds.add(g.groupId);
      reached.set(id, prev);
    }
  }
  const viaOf = new Map(input.enrollments.map((e) => [e.studentId, e.viaGroupId]));
  const ids = [...new Set([...reached.keys(), ...input.enrollments.map((e) => e.studentId)])];
  const students: PopulationStudent[] = ids.map((id) => {
    const r = reached.get(id);
    const via = viaOf.get(id);
    const groupIds = new Set(r?.groupIds ?? []);
    if (via && own.has(via)) groupIds.add(via);
    return {
      studentId: id,
      name: input.names.get(id) ?? "—",
      access: r?.state ?? "NONE",
      accessSince: r?.since ?? null,
      groupIds: [...groupIds],
      via: { groupIds: [...(r?.viaGroups ?? [])], individual: r?.individual ?? false },
    };
  });
  return { students, groups: groups.map((g) => ({ id: g.id, name: g.name })) };
}

/** The population of one syllabus, read from its own rows only (see `buildPopulation`). */
export async function population(syllabus: Syllabus, db: DbOrTx) {
  const [grants, enrollments] = await Promise.all([
    store.grantsForSyllabus(syllabus.id, db),
    db.select().from(syllabusEnrollments).where(eq(syllabusEnrollments.syllabusId, syllabus.id)),
  ]);
  const grantedGroupIds = [...new Set(grants.flatMap((g) => (g.groupId ? [g.groupId] : [])))];
  const groups = (await store.groupsByIds(grantedGroupIds, db)).filter((g) => g.workspaceId === syllabus.providerWorkspaceId);
  const ownGroupIds = groups.map((g) => g.id);
  const members = ownGroupIds.length
    ? await db
        .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
        .from(groupMembers)
        .where(and(inArray(groupMembers.groupId, ownGroupIds), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")))
    : [];
  const ids = [...new Set([...grants.flatMap((g) => (g.studentId ? [g.studentId] : [])), ...members.map((m) => m.userId), ...enrollments.map((e) => e.studentId)])];
  const nameRows = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const names = new Map(nameRows.map((n) => [n.id, n.name?.trim() || "—"]));
  const built = buildPopulation({ workspaceId: syllabus.providerWorkspaceId, grants, enrollments, groups, members, names, now: new Date() });
  return { ...built, enrollments, grants };
}

export async function loadAnalyticsData(syllabus: Syllabus, db: DbOrTx = requireDb()): Promise<AnalyticsData> {
  const { students, groups, enrollments } = await population(syllabus, db);
  const versionIds = [...new Set([...(syllabus.currentVersionId ? [syllabus.currentVersionId] : []), ...enrollments.map((e) => e.versionId)])];
  const structures = new Map<string, VersionStructure>();
  for (const id of versionIds) {
    const v = await store.versionById(id, db);
    if (v) structures.set(id, v.structure);
  }
  const items = [...structures.values()].flatMap(allItems);
  const taskIds = [...new Set(items.flatMap((i) => (i.kind === "STUDENT_PRACTICE" && i.taskId ? [i.taskId] : [])))];
  const assessmentIds = [...new Set(items.flatMap((i) => (i.kind === "ASSESSMENT" && i.assessmentId ? [i.assessmentId] : [])))];
  const studentIds = enrollments.map((e) => e.studentId);
  const sid = syllabus.id;

  const [moduleRows, lessonRows, practiceRows, theoryRows, subs, counts, attemptRows] = await Promise.all([
    db
      .select({
        enrollmentId: syllabusModuleProgress.enrollmentId,
        moduleId: syllabusModuleProgress.moduleId,
        status: syllabusModuleProgress.status,
        startedAt: syllabusModuleProgress.startedAt,
        completedAt: syllabusModuleProgress.completedAt,
      })
      .from(syllabusModuleProgress)
      .where(eq(syllabusModuleProgress.syllabusId, sid)),
    db
      .select({
        enrollmentId: syllabusLessonProgress.enrollmentId,
        lessonId: syllabusLessonProgress.lessonId,
        moduleId: syllabusLessonProgress.moduleId,
        status: syllabusLessonProgress.status,
        unlockedAt: syllabusLessonProgress.unlockedAt,
        openedAt: syllabusLessonProgress.openedAt,
        completedAt: syllabusLessonProgress.completedAt,
        activeSeconds: syllabusLessonProgress.activeSeconds,
      })
      .from(syllabusLessonProgress)
      .where(eq(syllabusLessonProgress.syllabusId, sid)),
    db
      .select({ enrollmentId: syllabusItemProgress.enrollmentId, itemId: syllabusItemProgress.itemId, openedAt: syllabusItemProgress.openedAt, startedAt: syllabusItemProgress.startedAt })
      .from(syllabusItemProgress)
      .where(and(eq(syllabusItemProgress.syllabusId, sid), eq(syllabusItemProgress.kind, "STUDENT_PRACTICE"))),
    db
      .selectDistinct({ enrollmentId: syllabusItemProgress.enrollmentId })
      .from(syllabusItemProgress)
      .where(and(eq(syllabusItemProgress.syllabusId, sid), eq(syllabusItemProgress.kind, "THEORY"), isNotNull(syllabusItemProgress.completedAt))),
    taskIds.length
      ? db
          .select({
            taskId: taskSubmissions.taskId,
            studentId: taskSubmissions.studentId,
            submittedAt: taskSubmissions.submittedAt,
            firstSubmittedAt: taskSubmissions.firstSubmittedAt,
            score: taskSubmissions.score,
            releasedAt: taskSubmissions.feedbackReleasedAt,
          })
          .from(taskSubmissions)
          .where(inArray(taskSubmissions.taskId, taskIds))
      : Promise.resolve([]),
    db
      .select({ itemId: learningActivity.itemId, userId: learningActivity.userId, n: sql<number>`count(*)` })
      .from(learningActivity)
      .where(and(eq(learningActivity.syllabusId, sid), inArray(learningActivity.activityType, ["PRACTICE_SUBMITTED", "PRACTICE_RESUBMITTED"])))
      .groupBy(learningActivity.itemId, learningActivity.userId),
    assessmentIds.length && studentIds.length
      ? db
          .select({
            assessmentId: attempts.assessmentId,
            studentId: attempts.studentId,
            status: attempts.status,
            attemptNo: attempts.attemptNo,
            submittedAt: attempts.submittedAt,
            pct: results.percentage,
            pendingReviewCount: results.pendingReviewCount,
            completedAt: results.completedAt,
          })
          .from(attempts)
          .leftJoin(results, eq(results.attemptId, attempts.id))
          .where(and(inArray(attempts.assessmentId, assessmentIds), inArray(attempts.studentId, studentIds)))
      : Promise.resolve([]),
  ]);

  return {
    currentVersionId: syllabus.currentVersionId,
    structures,
    students,
    groups,
    enrollments: enrollments.map((e) => ({
      id: e.id,
      studentId: e.studentId,
      versionId: e.versionId,
      status: e.status,
      progressPct: e.progressPct,
      completedLessons: e.completedLessons,
      totalLessons: e.totalLessons,
      currentModuleId: e.currentModuleId,
      currentLessonId: e.currentLessonId,
      lastCompletedLessonId: e.lastCompletedLessonId,
      lastActivityAt: e.lastActivityAt,
      enrolledAt: e.enrolledAt,
      completedAt: e.completedAt,
    })),
    modules: moduleRows,
    lessons: lessonRows,
    practiceItems: practiceRows,
    theoryDone: new Set(theoryRows.map((r) => r.enrollmentId)),
    submissions: subs.map((s) => ({ taskId: s.taskId, studentId: s.studentId, submittedAt: s.submittedAt, firstSubmittedAt: s.firstSubmittedAt, score: s.score, released: s.releasedAt !== null })),
    submitCounts: new Map(counts.filter((c) => c.itemId).map((c) => [`${c.itemId}:${c.userId}`, Number(c.n)])),
    attempts: attemptRows.map((a) => ({
      assessmentId: a.assessmentId,
      studentId: a.studentId,
      status: a.status,
      attemptNo: a.attemptNo,
      finishedAt: a.completedAt ?? a.submittedAt,
      pct: a.pct ?? null,
      pending: (a.pendingReviewCount ?? 0) > 0,
    })),
  };
}

/** The Analytics tab: overview, students, groups, modules, lessons, practice, funnel, insights. */
export async function syllabusAnalytics(scope: TeacherScope, syllabusId: string, groupId: string | null = null) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  const db = requireDb();
  const [data, settings] = await Promise.all([loadAnalyticsData(syllabus, db), settingsOf(syllabusId, db)]);
  if (groupId && !data.groups.some((g) => g.id === groupId)) throw new AppError("NOT_FOUND");
  const now = new Date();
  return {
    generatedAt: now,
    published: !!syllabus.currentVersionId,
    groupId,
    groupOptions: data.groups,
    settings,
    ...computeAnalytics(data, settings.thresholds, now, groupId),
  };
}

// ---------------------------------------------------------------------------
// Activity timeline (§30, §31)
// ---------------------------------------------------------------------------

const TIMELINE_LIMIT = 300;

async function timelineFor(syllabus: Syllabus, studentId: number, db: DbOrTx = requireDb()) {
  const enrollment = await store.enrollmentOf(syllabus.id, studentId, db);
  const structures = new Map<string, VersionStructure>();
  for (const id of [enrollment?.versionId, syllabus.currentVersionId]) {
    if (!id || structures.has(id)) continue;
    const v = await store.versionById(id, db);
    if (v) structures.set(id, v.structure);
  }
  const outline = mergedOutline(structures, enrollment?.versionId ?? syllabus.currentVersionId);
  const moduleTitle = new Map(outline.modules.map((m) => [m.id, m.title]));
  const lessonTitle = new Map(outline.modules.flatMap((m) => m.lessons.map((l) => [l.id, l.title] as const)));
  const itemTitle = new Map([...structures.values()].flatMap((s) => allItems(s).map((i) => [i.id, i.title] as const)));
  const assessmentItems = [...structures.values()].flatMap((s) => allItems(s).filter((i) => i.kind === "ASSESSMENT" && i.assessmentId).map((i) => ({ s, i })));

  const [events, outcomes] = await Promise.all([
    db
      .select({
        id: learningActivity.id,
        type: learningActivity.activityType,
        at: learningActivity.occurredAt,
        moduleId: learningActivity.moduleId,
        lessonId: learningActivity.lessonId,
        itemId: learningActivity.itemId,
        durationSeconds: learningActivity.durationSeconds,
        metadata: learningActivity.metadata,
      })
      .from(learningActivity)
      .where(and(eq(learningActivity.userId, studentId), eq(learningActivity.syllabusId, syllabus.id)))
      .orderBy(desc(learningActivity.occurredAt))
      .limit(TIMELINE_LIMIT),
    assessmentItems.length
      ? db
          .select({ assessmentId: attempts.assessmentId, attemptNo: attempts.attemptNo, status: attempts.status, pct: results.percentage, pending: results.pendingReviewCount, at: results.completedAt })
          .from(attempts)
          .innerJoin(results, eq(results.attemptId, attempts.id))
          .where(and(eq(attempts.studentId, studentId), inArray(attempts.assessmentId, [...new Set(assessmentItems.map((x) => x.i.assessmentId!))])))
      : Promise.resolve([]),
  ]);

  // Assessment outcomes come from the exam engine's results (the authoritative record), not from events.
  const outcomeEvents = outcomes
    .filter((o) => o.status !== "VOIDED")
    .flatMap((o) => {
      const hit = assessmentItems.find((x) => x.i.assessmentId === o.assessmentId);
      if (!hit) return [];
      const where = locateItem(hit.s, hit.i.id);
      const pass = hit.i.passPct ?? where?.rules.assessmentPassPct ?? 0;
      const type = o.pending > 0 ? "ASSESSMENT_SUBMITTED" : o.pct >= pass ? "ASSESSMENT_PASSED" : "ASSESSMENT_FAILED";
      return [{ id: `r-${o.assessmentId}-${o.attemptNo}`, type, at: o.at, moduleId: where?.module?.id ?? null, lessonId: where?.lesson?.id ?? null, itemId: hit.i.id, durationSeconds: null, metadata: { attemptNo: o.attemptNo, pct: Math.round(o.pct * 10) / 10 } }];
    });

  return [...events.map((e) => ({ ...e, id: String(e.id) })), ...outcomeEvents]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, TIMELINE_LIMIT)
    .map((e) => ({
      id: e.id,
      type: e.type,
      at: e.at,
      module: e.moduleId ? (moduleTitle.get(e.moduleId) ?? null) : null,
      lesson: e.lessonId ? (lessonTitle.get(e.lessonId) ?? null) : null,
      item: e.itemId ? (itemTitle.get(e.itemId) ?? null) : null,
      durationSeconds: e.durationSeconds,
      pct: typeof (e.metadata as { pct?: unknown } | null)?.pct === "number" ? ((e.metadata as { pct: number }).pct) : null,
    }));
}

/** A student's timeline for their teacher: only a student this syllabus reaches or has enrolled. */
export async function studentTimeline(scope: TeacherScope, syllabusId: string, studentId: number) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  const { students } = await population(syllabus, requireDb());
  if (!students.some((s) => s.studentId === studentId)) throw new AppError("NOT_FOUND");
  return timelineFor(syllabus, studentId);
}

/** The student's own timeline (§41: only self). History stays readable after access ends. */
export async function myTimeline(userId: number, syllabusId: string) {
  const syllabus = await store.syllabusById(syllabusId);
  if (!syllabus || !(await syllabusEnabledFor(syllabus.providerWorkspaceId))) throw new AppError("NOT_FOUND");
  if (!(await store.enrollmentOf(syllabusId, userId))) throw new AppError("NOT_FOUND");
  return timelineFor(syllabus, userId);
}

// ---------------------------------------------------------------------------
// Admin (syllabus.view): aggregate numbers only, no names or content
// ---------------------------------------------------------------------------

export async function adminAggregate(syllabusId: string) {
  const syllabus = await store.syllabusById(syllabusId);
  if (!syllabus) throw new AppError("NOT_FOUND");
  const db = requireDb();
  const [data, settings] = await Promise.all([loadAnalyticsData(syllabus, db), settingsOf(syllabusId, db)]);
  const r = computeAnalytics(data, settings.thresholds, new Date());
  return { syllabusId, overview: r.overview, funnel: r.funnel };
}

// ---------------------------------------------------------------------------
// Daily at-risk digest (teacher, via the dispatcher) and activity retention
// ---------------------------------------------------------------------------

const DIGEST_HOUR_BAKU = 8;
const BAKU_OFFSET_MS = 4 * 3_600_000;
const bakuDay = (now: Date) => new Date(now.getTime() + BAKU_OFFSET_MS).toISOString().slice(0, 10);
const bakuHour = (now: Date) => new Date(now.getTime() + BAKU_OFFSET_MS).getUTCHours();

/** Pure: who the digest names (at most 5) and how many in total. */
export function digestPayload(rows: ReadonlyArray<{ name: string; atRisk: boolean; reasons: ReadonlyArray<{ code: string }> }>) {
  const risky = rows.filter((r) => r.atRisk);
  return { count: risky.length, names: risky.slice(0, 5).map((r) => r.name) };
}

export async function sendDigestFor(syllabus: Syllabus, now = new Date()) {
  const settings = await settingsOf(syllabus.id);
  if (!settings.digestEnabled) return false;
  const data = await loadAnalyticsData(syllabus);
  const r = computeAnalytics(data, settings.thresholds as RiskThresholds, now);
  const { count, names } = digestPayload(r.students);
  if (!count) return false;
  dispatch({
    event: "SYLLABUS_AT_RISK_DIGEST",
    userId: syllabus.createdBy,
    dedupeKey: `syl-risk:${syllabus.id}:${bakuDay(now)}`,
    data: { syllabusId: syllabus.id, syllabusTitle: syllabus.title, count, names },
  });
  return true;
}

let lastDigestDay: string | null = null;

/** Once a day after 08:00 Baku; several instances are safe because the dedupe key is per syllabus and day. */
export async function runDailyDigest(now = new Date()) {
  const day = bakuDay(now);
  if (lastDigestDay === day || bakuHour(now) < DIGEST_HOUR_BAKU) return 0;
  lastDigestDay = day;
  let rows: Syllabus[];
  try {
    rows = await requireDb().select().from(syllabi).where(and(isNotNull(syllabi.currentVersionId), isNull(syllabi.archivedAt)));
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  let sent = 0;
  for (const s of rows) {
    try {
      if (!(await syllabusEnabledFor(s.providerWorkspaceId))) continue;
      if (await sendDigestFor(s, now)) sent++;
    } catch (error) {
      console.error("[syllabus] at-risk digest failed", s.id, error instanceof Error ? error.message : error);
    }
  }
  return sent;
}

const RETENTION_BATCH = 5_000;
const RETENTION_MAX_BATCHES = 40;
let lastRetentionDay: string | null = null;

export function retentionCutoff(now: Date, months = ACTIVITY_RETENTION_MONTHS) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** Deletes raw learning events older than the retention period, in small batches (progress tables are untouched). */
export async function purgeOldActivity(now = new Date(), months = ACTIVITY_RETENTION_MONTHS) {
  const cutoff = retentionCutoff(now, months);
  const db = requireDb();
  let deleted = 0;
  try {
    for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
      const res = await db.delete(learningActivity).where(lt(learningActivity.occurredAt, cutoff)).limit(RETENTION_BATCH);
      const n = Number((res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
      deleted += n;
      if (n < RETENTION_BATCH) break;
    }
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  return deleted;
}

export async function runDailyRetention(now = new Date()) {
  const day = bakuDay(now);
  if (lastRetentionDay === day) return 0;
  lastRetentionDay = day;
  const months = Number(process.env.SYLLABUS_ACTIVITY_RETENTION_MONTHS) || ACTIVITY_RETENTION_MONTHS;
  const n = await purgeOldActivity(now, Math.max(1, Math.floor(months)));
  if (n) console.log(`[syllabus] retention: deleted ${n} learning events older than ${months} months`);
  return n;
}

/** Test helper: forget which day the daily jobs last ran. */
export function resetDailyJobs() {
  lastDigestDay = null;
  lastRetentionDay = null;
}
