import type { CompletionRules, SyllabusGrantState } from "../../shared/syllabus";
import { FUNNEL_STAGES, type FunnelStage, type RiskReason, type RiskThresholds } from "../../shared/syllabusAnalytics";
import { buildInsights } from "./insights";
import { daysSince, riskReasons } from "./risk";
import type { ItemStub, VersionStructure } from "./types";

/**
 * Syllabus analytics, pure (§32–§40). Input = rows already scoped to one syllabus of one teacher;
 * output = every number the Analytics tab shows. Access, Progress, Completion and Mastery stay
 * separate metrics (§43): access is grant state, progress is lessons done, completion is the
 * finished syllabus, mastery is assessment scores.
 */

const DAY_MS = 86_400_000;

export interface PopulationStudent {
  studentId: number;
  name: string;
  /** Best grant state reaching the student now; NONE = no grant left but an enrollment exists. */
  access: SyllabusGrantState | "NONE";
  /** Start of the access that is active now (grant start or grant time). */
  accessSince: Date | null;
  /** Granted groups of this teacher the student belongs to. */
  groupIds: string[];
  /** The grants behind `access`: groups of this teacher and/or an individual grant. Empty for NONE. */
  via: { groupIds: string[]; individual: boolean };
}

export interface EnrollmentRow {
  id: string;
  studentId: number;
  versionId: string;
  status: "ACTIVE" | "COMPLETED";
  progressPct: number;
  completedLessons: number;
  totalLessons: number;
  currentModuleId: string | null;
  currentLessonId: string | null;
  lastCompletedLessonId: string | null;
  lastActivityAt: Date | null;
  enrolledAt: Date;
  completedAt: Date | null;
}

export interface ModuleRow {
  enrollmentId: string;
  moduleId: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface LessonRow {
  enrollmentId: string;
  lessonId: string;
  moduleId: string;
  status: string;
  unlockedAt: Date | null;
  openedAt: Date | null;
  completedAt: Date | null;
  activeSeconds: number;
}

export interface PracticeItemRow {
  enrollmentId: string;
  itemId: string;
  openedAt: Date | null;
  startedAt: Date | null;
}

export interface SubmissionRow {
  taskId: string;
  studentId: number;
  submittedAt: Date | null;
  firstSubmittedAt: Date | null;
  score: number | null;
  released: boolean;
}

export interface AttemptRow {
  assessmentId: string;
  studentId: number;
  status: string;
  attemptNo: number;
  finishedAt: Date | null;
  /** null while not graded (no result row yet). */
  pct: number | null;
  pending: boolean;
}

export interface AnalyticsData {
  /** Version used for names and order (the current one); older versions add nodes they still have. */
  currentVersionId: string | null;
  structures: ReadonlyMap<string, VersionStructure>;
  students: PopulationStudent[];
  groups: Array<{ id: string; name: string }>;
  enrollments: EnrollmentRow[];
  modules: ModuleRow[];
  lessons: LessonRow[];
  practiceItems: PracticeItemRow[];
  /** Enrollments with at least one completed theory item. */
  theoryDone: ReadonlySet<string>;
  submissions: SubmissionRow[];
  /** `${itemId}:${studentId}` → practice submissions (first and re-submissions) from the activity log. */
  submitCounts: ReadonlyMap<string, number>;
  attempts: AttemptRow[];
}

// ---------------------------------------------------------------------------
// Outline: stable ids across versions, current version first
// ---------------------------------------------------------------------------

export interface OutlineLesson {
  id: string;
  moduleId: string;
  title: string;
  position: number;
  items: ItemStub[];
}
export interface OutlineModule {
  id: string;
  title: string;
  position: number;
  lessons: OutlineLesson[];
  items: ItemStub[];
}

export function mergedOutline(structures: ReadonlyMap<string, VersionStructure>, currentVersionId: string | null) {
  const ordered = [...structures.entries()].sort(([a], [b]) => (a === currentVersionId ? -1 : b === currentVersionId ? 1 : 0)).map(([, s]) => s);
  const modules: OutlineModule[] = [];
  const finalItems: ItemStub[] = [];
  const seenItems = new Set<string>();
  const addItems = (into: ItemStub[], items: readonly ItemStub[]) => {
    for (const it of items) {
      if (seenItems.has(it.id)) continue;
      seenItems.add(it.id);
      into.push(it);
    }
  };
  for (const s of ordered) {
    for (const m of s.modules) {
      let om = modules.find((x) => x.id === m.id);
      if (!om) {
        om = { id: m.id, title: m.title, position: modules.length + 1, lessons: [], items: [] };
        modules.push(om);
      }
      for (const l of m.lessons) {
        let ol = om.lessons.find((x) => x.id === l.id);
        if (!ol) {
          ol = { id: l.id, moduleId: m.id, title: l.title, position: om.lessons.length + 1, items: [] };
          om.lessons.push(ol);
        }
        addItems(ol.items, l.items);
      }
      addItems(om.items, m.items);
    }
    addItems(finalItems, s.finalItems);
  }
  return { modules, finalItems };
}

// ---------------------------------------------------------------------------
// Per-student facts
// ---------------------------------------------------------------------------

interface ItemPlace {
  item: ItemStub;
  lessonId: string | null;
  moduleId: string | null;
  rules: CompletionRules;
}

/** Every item of one version with its lesson/module and the rules that apply to it. */
function placesOf(s: VersionStructure): ItemPlace[] {
  return [
    ...s.modules.flatMap((m) => [
      ...m.lessons.flatMap((l) => l.items.map((item) => ({ item, lessonId: l.id, moduleId: m.id, rules: l.rules }))),
      ...m.items.map((item) => ({ item, lessonId: null, moduleId: m.id, rules: m.rules })),
    ]),
    ...s.finalItems.map((item) => ({ item, lessonId: null, moduleId: null, rules: s.rules })),
  ];
}

/** Same reading as the progression engine; NONE (not required) counts a submission as done. */
export function practiceDone(sub: SubmissionRow | undefined, rule: CompletionRules["studentPractice"], passPct: number) {
  if (!sub?.submittedAt) return false;
  if (rule === "NONE" || rule === "SUBMITTED") return true;
  if (!sub.released) return false;
  return rule === "GRADED" || (sub.score ?? 0) >= passPct;
}

export interface AssessmentOutcome {
  itemId: string;
  lessonId: string | null;
  moduleId: string | null;
  finished: number;
  /** Score by the item's policy (best or latest graded), null before a graded attempt. */
  score: number | null;
  passed: boolean;
  /** Graded attempts below the pass mark on an item not passed yet. */
  failed: number;
}

export function assessmentOutcome(place: ItemPlace, attempts: readonly AttemptRow[]): AssessmentOutcome {
  const finished = attempts.filter((a) => a.status !== "IN_PROGRESS" && a.status !== "VOIDED").sort((a, b) => a.attemptNo - b.attemptNo);
  const graded = finished.filter((a) => a.pct !== null && !a.pending);
  const pass = place.item.passPct ?? place.rules.assessmentPassPct;
  const policy = place.item.retry?.scorePolicy ?? place.rules.retry.scorePolicy;
  const score = graded.length ? (policy === "LATEST" ? graded[graded.length - 1].pct! : Math.max(...graded.map((a) => a.pct!))) : null;
  const passed = score !== null && score >= pass;
  return {
    itemId: place.item.id,
    lessonId: place.lessonId,
    moduleId: place.moduleId,
    finished: finished.length,
    score,
    passed,
    failed: passed ? 0 : graded.filter((a) => a.pct! < pass).length,
  };
}

interface PracticeOutcome {
  itemId: string;
  lessonId: string;
  moduleId: string;
  reached: boolean;
  opened: boolean;
  started: boolean;
  submitted: boolean;
  done: boolean;
  awaitingReview: boolean;
  belowPass: boolean;
  score: number | null;
  submits: number;
  secondsToSubmit: number | null;
  missing: boolean;
}

// ---------------------------------------------------------------------------
// Small math helpers (rounded for display, null when there is nothing to average)
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;
export const rate = (part: number, whole: number) => (whole > 0 ? round1((part / whole) * 100) : null);
export const mean = (xs: readonly number[]) => (xs.length ? round1(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
const meanSeconds = (xs: readonly number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

const STARTED_MODULE = new Set(["IN_PROGRESS", "AWAITING_APPROVAL", "COMPLETED"]);

function groupBy<T, K>(rows: readonly T[], key: (r: T) => K) {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Students: facts, risk, table rows
// ---------------------------------------------------------------------------

interface Indexes {
  fallback: VersionStructure | undefined;
  enrollmentOf: Map<number, EnrollmentRow>;
  modulesBy: Map<string, ModuleRow[]>;
  lessonsBy: Map<string, LessonRow[]>;
  practiceBy: Map<string, PracticeItemRow[]>;
  subOf: Map<string, SubmissionRow>;
  attemptsOf: Map<string, AttemptRow[]>;
  titleOfLesson: Map<string, string>;
  titleOfModule: Map<string, string>;
  peersOf: (groupIds: readonly string[]) => { avg: number | null; size: number };
}

function studentFacts(data: AnalyticsData, x: Indexes, s: PopulationStudent, th: RiskThresholds, now: Date) {
  const e = x.enrollmentOf.get(s.studentId) ?? null;
  const structure = e ? (data.structures.get(e.versionId) ?? x.fallback) : x.fallback;
  const places = e && structure ? placesOf(structure) : [];
  const lessonRows = new Map((e ? (x.lessonsBy.get(e.id) ?? []) : []).map((r) => [r.lessonId, r]));
  const moduleRows = e ? (x.modulesBy.get(e.id) ?? []) : [];
  const practiceRows = new Map((e ? (x.practiceBy.get(e.id) ?? []) : []).map((r) => [r.itemId, r]));

  const practice: PracticeOutcome[] = places
    .filter((p) => p.item.kind === "STUDENT_PRACTICE" && p.lessonId && p.moduleId)
    .map((p) => {
      const lesson = lessonRows.get(p.lessonId!);
      const reached = !!lesson && lesson.status !== "LOCKED";
      const row = practiceRows.get(p.item.id);
      const sub = p.item.taskId ? x.subOf.get(`${s.studentId}:${p.item.taskId}`) : undefined;
      const passPct = p.item.passPct ?? p.rules.practicePassPct;
      const submitted = !!sub?.submittedAt;
      const firstAt = sub?.firstSubmittedAt ?? sub?.submittedAt ?? null;
      const openedAt = row?.openedAt ?? null;
      const graceFrom = lesson?.unlockedAt ?? lesson?.openedAt ?? null;
      return {
        itemId: p.item.id,
        lessonId: p.lessonId!,
        moduleId: p.moduleId!,
        reached,
        opened: !!openedAt || submitted,
        started: !!row?.startedAt || submitted,
        submitted,
        done: practiceDone(sub, p.rules.studentPractice, passPct),
        awaitingReview: submitted && !sub!.released,
        belowPass: submitted && !!sub!.released && (sub!.score ?? 0) < passPct,
        score: sub?.released && sub.score !== null ? sub.score : null,
        submits: submitted ? Math.max(1, data.submitCounts.get(`${p.item.id}:${s.studentId}`) ?? 1) : 0,
        secondsToSubmit: firstAt && openedAt && firstAt > openedAt ? Math.round((firstAt.getTime() - openedAt.getTime()) / 1000) : null,
        missing:
          reached &&
          !submitted &&
          p.item.required &&
          p.rules.studentPractice !== "NONE" &&
          !!graceFrom &&
          now.getTime() - graceFrom.getTime() >= th.practiceGraceDays * DAY_MS,
      };
    });

  const assessments = places
    .filter((p) => p.item.kind === "ASSESSMENT" && p.item.assessmentId)
    .map((p) => assessmentOutcome(p, x.attemptsOf.get(`${s.studentId}:${p.item.assessmentId}`) ?? []));
  const scored = assessments.filter((a) => a.score !== null);
  const currentLesson = e?.currentLessonId ? lessonRows.get(e.currentLessonId) : undefined;
  const lastActivityAt = e ? (e.lastActivityAt ?? e.enrolledAt) : null;
  const failedAttempts = assessments.reduce((n, a) => n + a.failed, 0);
  const missingPractice = practice.filter((p) => p.missing).length;
  const peers = x.peersOf(s.groupIds);
  const reasons: RiskReason[] = riskReasons(
    {
      accessActive: s.access === "ACTIVE",
      accessSince: s.accessSince,
      enrolled: !!e,
      completed: e?.status === "COMPLETED",
      lastActivityAt,
      progressPct: e?.progressPct ?? 0,
      failedAttempts,
      groupAvgPct: peers.avg,
      groupSize: peers.size,
      currentLessonOpenedAt: currentLesson && currentLesson.status !== "COMPLETED" ? currentLesson.openedAt : null,
      missingPractice,
    },
    th,
    now,
  );
  const active = !!lastActivityAt && now.getTime() - lastActivityAt.getTime() <= th.inactiveDays * DAY_MS;
  const practiceCompleted = practice.filter((p) => p.done).length;
  const row = {
    studentId: s.studentId,
    name: s.name,
    groupIds: s.groupIds,
    access: s.access,
    via: s.via,
    enrolled: !!e,
    completed: e?.status === "COMPLETED",
    completedAt: e?.completedAt ?? null,
    progressPct: e ? round1(e.progressPct) : 0,
    completedLessons: e?.completedLessons ?? 0,
    totalLessons: e?.totalLessons ?? 0,
    currentModuleTitle: e?.currentModuleId ? (x.titleOfModule.get(e.currentModuleId) ?? null) : null,
    currentLessonTitle: e?.currentLessonId ? (x.titleOfLesson.get(e.currentLessonId) ?? null) : null,
    lastCompletedLessonTitle: e?.lastCompletedLessonId ? (x.titleOfLesson.get(e.lastCompletedLessonId) ?? null) : null,
    practice: { done: practiceCompleted, total: practice.length, pct: rate(practiceCompleted, practice.length) },
    assessment: {
      avgPct: mean(scored.map((a) => a.score!)),
      attempted: assessments.filter((a) => a.finished > 0).length,
      passed: assessments.filter((a) => a.passed).length,
      failedAttempts,
    },
    lastActivityAt,
    daysInactive: e ? daysSince(lastActivityAt, now) : null,
    active,
    atRisk: reasons.length > 0,
    reasons,
    /** At or above the group average, active and not at risk (§23 "students who are progressing"). */
    progressing: !!e && e.status !== "COMPLETED" && active && reasons.length === 0 && (peers.avg === null || e.progressPct >= peers.avg),
  };
  return { s, e, lessonRows, moduleRows, practice, assessments, row, anyLessonOpened: [...lessonRows.values()].some((l) => !!l.openedAt) };
}

type Facts = ReturnType<typeof studentFacts>;

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

export function computeAnalytics(data: AnalyticsData, thresholds: RiskThresholds, now: Date, onlyGroupId: string | null = null) {
  const outline = mergedOutline(data.structures, data.currentVersionId);
  const current = data.currentVersionId ? data.structures.get(data.currentVersionId) : undefined;
  const enrollmentOf = new Map(data.enrollments.map((e) => [e.studentId, e]));
  const studentOfEnrollment = new Map(data.enrollments.map((e) => [e.id, e.studentId]));
  const groupsOfStudent = new Map(data.students.map((s) => [s.studentId, s.groupIds]));

  // Group averages over enrolled peers; students without a group compare with everyone enrolled.
  const peerCache = new Map<string, { avg: number | null; size: number }>();
  const peersOf = (groupIds: readonly string[]) => {
    const key = [...groupIds].sort().join(",");
    const hit = peerCache.get(key);
    if (hit) return hit;
    const peers = groupIds.length ? data.enrollments.filter((e) => (groupsOfStudent.get(e.studentId) ?? []).some((g) => groupIds.includes(g))) : data.enrollments;
    const value = { avg: mean(peers.map((p) => p.progressPct)), size: peers.length };
    peerCache.set(key, value);
    return value;
  };

  const x: Indexes = {
    fallback: current ?? data.structures.values().next().value,
    enrollmentOf,
    modulesBy: groupBy(data.modules, (r) => r.enrollmentId),
    lessonsBy: groupBy(data.lessons, (r) => r.enrollmentId),
    practiceBy: groupBy(data.practiceItems, (r) => r.enrollmentId),
    subOf: new Map(data.submissions.map((s) => [`${s.studentId}:${s.taskId}`, s])),
    attemptsOf: groupBy(data.attempts, (a) => `${a.studentId}:${a.assessmentId}`),
    titleOfLesson: new Map(outline.modules.flatMap((m) => m.lessons.map((l) => [l.id, l.title] as const))),
    titleOfModule: new Map(outline.modules.map((m) => [m.id, m.title] as const)),
    peersOf,
  };

  const everyone: Facts[] = data.students.map((s) => studentFacts(data, x, s, thresholds, now));
  const facts = onlyGroupId ? everyone.filter((f) => f.s.groupIds.includes(onlyGroupId)) : everyone;
  const rows = facts.map((f) => f.row);

  // --- overview (§32) ------------------------------------------------------
  const enrolledRows = rows.filter((r) => r.enrolled);
  const attemptedPairs = facts.flatMap((f) => f.assessments.filter((a) => a.finished > 0));
  const lessonTotals = facts.reduce((acc, f) => (f.e ? { done: acc.done + f.e.completedLessons, total: acc.total + f.e.totalLessons } : acc), { done: 0, total: 0 });
  const completedCount = rows.filter((r) => r.completed).length;
  const overview = {
    access: {
      total: rows.length,
      active: rows.filter((r) => r.access === "ACTIVE").length,
      pending: rows.filter((r) => r.access === "PENDING").length,
      ended: rows.filter((r) => r.access === "EXPIRED" || r.access === "REVOKED" || r.access === "NONE").length,
    },
    progress: {
      enrolled: enrolledRows.length,
      started: facts.filter((f) => f.e && (f.e.completedLessons > 0 || f.anyLessonOpened)).length,
      active: enrolledRows.filter((r) => r.active).length,
      inactive: enrolledRows.filter((r) => !r.active && !r.completed).length,
      avgProgressPct: mean(enrolledRows.map((r) => r.progressPct)),
      lessonCompletionPct: rate(lessonTotals.done, lessonTotals.total),
      progressing: rows.filter((r) => r.progressing).length,
      stuck: rows.filter((r) => r.reasons.some((c) => c.code === "STUCK_IN_LESSON")).length,
    },
    completion: {
      completed: completedCount,
      completionRatePct: rate(completedCount, enrolledRows.length),
    },
    mastery: {
      avgAssessmentPct: mean(rows.flatMap((r) => (r.assessment.avgPct !== null ? [r.assessment.avgPct] : []))),
      assessedStudents: rows.filter((r) => r.assessment.attempted > 0).length,
      passRatePct: rate(attemptedPairs.filter((a) => a.passed).length, attemptedPairs.length),
    },
    atRisk: rows.filter((r) => r.atRisk).length,
  };

  // --- lessons (§36) ---------------------------------------------------------
  const lessons = outline.modules.flatMap((m) =>
    m.lessons.map((l) => {
      const views = facts.flatMap((f) => (f.lessonRows.has(l.id) ? [f.lessonRows.get(l.id)!] : []));
      const opened = views.filter((r) => r.openedAt);
      const completed = views.filter((r) => r.status === "COMPLETED");
      const practice = facts.flatMap((f) => f.practice.filter((p) => p.lessonId === l.id && p.reached));
      const assessed = facts.flatMap((f) => f.assessments.filter((a) => a.lessonId === l.id));
      return {
        lessonId: l.id,
        moduleId: m.id,
        modulePosition: m.position,
        position: l.position,
        title: l.title,
        unlocked: views.filter((r) => r.status !== "LOCKED").length,
        opened: opened.length,
        completed: completed.length,
        completionRatePct: rate(completed.length, opened.length),
        practiceCompletionPct: rate(practice.filter((p) => p.done).length, practice.length),
        avgScorePct: mean(assessed.flatMap((a) => (a.score !== null ? [a.score] : []))),
        avgAttempts: mean(assessed.filter((a) => a.finished > 0).map((a) => a.finished)),
        attempters: assessed.filter((a) => a.finished > 0).length,
        avgActiveSeconds: meanSeconds(opened.filter((r) => r.activeSeconds > 0).map((r) => r.activeSeconds)),
      };
    }),
  );

  // --- modules (§35) ----------------------------------------------------------
  const modules = outline.modules.map((m) => {
    const here = facts.flatMap((f) => f.moduleRows.filter((r) => r.moduleId === m.id).map((r) => ({ f, r })));
    const started = here.filter(({ r }) => STARTED_MODULE.has(r.status) || r.startedAt);
    const completed = here.filter(({ r }) => r.status === "COMPLETED");
    const lessonIds = new Set(m.lessons.map((l) => l.id));
    const practice = facts.flatMap((f) => f.practice.filter((p) => p.moduleId === m.id && p.reached));
    const assessed = facts.flatMap((f) => f.assessments.filter((a) => a.moduleId === m.id));
    const attempted = assessed.filter((a) => a.finished > 0);
    return {
      moduleId: m.id,
      position: m.position,
      title: m.title,
      started: started.length,
      completed: completed.length,
      completionRatePct: rate(completed.length, started.length),
      avgScorePct: mean(assessed.flatMap((a) => (a.score !== null ? [a.score] : []))),
      avgTimeToCompleteSeconds: meanSeconds(
        completed.flatMap(({ r }) => (r.startedAt && r.completedAt && r.completedAt > r.startedAt ? [(r.completedAt.getTime() - r.startedAt.getTime()) / 1000] : [])),
      ),
      avgActiveSeconds: meanSeconds(
        started.map(({ f }) => [...f.lessonRows.values()].filter((l) => lessonIds.has(l.lessonId)).reduce((n, l) => n + l.activeSeconds, 0)).filter((n) => n > 0),
      ),
      practiceCompletionPct: rate(practice.filter((p) => p.done).length, practice.length),
      passRatePct: rate(attempted.filter((a) => a.passed).length, attempted.length),
      retryRatePct: rate(attempted.filter((a) => a.finished > 1).length, attempted.length),
      attempters: attempted.length,
    };
  });

  // --- practice tasks (§37) ----------------------------------------------------
  const practice = outline.modules.flatMap((m) =>
    m.lessons.flatMap((l) =>
      l.items
        .filter((i) => i.kind === "STUDENT_PRACTICE")
        .map((i) => {
          const o = facts.flatMap((f) => f.practice.filter((p) => p.itemId === i.id));
          const reached = o.filter((p) => p.reached).length;
          const opened = o.filter((p) => p.opened).length;
          const started = o.filter((p) => p.started).length;
          const submitted = o.filter((p) => p.submitted);
          const completed = o.filter((p) => p.done).length;
          return {
            itemId: i.id,
            lessonId: l.id,
            moduleId: m.id,
            title: i.title,
            lessonTitle: l.title,
            moduleTitle: m.title,
            reached,
            opened,
            started,
            submitted: submitted.length,
            completed,
            openRatePct: rate(opened, reached),
            startRatePct: rate(started, reached),
            submitRatePct: rate(submitted.length, reached),
            completionRatePct: rate(completed, reached),
            avgScorePct: mean(o.flatMap((p) => (p.score !== null ? [p.score] : []))),
            avgAttempts: mean(submitted.map((p) => p.submits)),
            avgTimeToSubmitSeconds: meanSeconds(submitted.flatMap((p) => (p.secondsToSubmit !== null ? [p.secondsToSubmit] : []))),
            awaitingReview: o.filter((p) => p.awaitingReview).length,
            needsHelp: o.filter((p) => p.awaitingReview || p.belowPass).length,
          };
        }),
    ),
  );

  // --- groups (§34): always over everyone, so the comparison does not change with the filter ----
  const completedModulesOf = new Map<string, Set<number>>();
  for (const r of data.modules) {
    if (r.status !== "COMPLETED") continue;
    const sid = studentOfEnrollment.get(r.enrollmentId);
    if (sid === undefined) continue;
    (completedModulesOf.get(r.moduleId) ?? completedModulesOf.set(r.moduleId, new Set()).get(r.moduleId)!).add(sid);
  }
  const groups = data.groups.map((g) => {
    const members = everyone.filter((f) => f.s.groupIds.includes(g.id)).map((f) => f.row);
    const enrolledHere = members.filter((r) => r.enrolled);
    return {
      groupId: g.id,
      name: g.name,
      students: members.length,
      enrolled: enrolledHere.length,
      avgProgressPct: mean(enrolledHere.map((r) => r.progressPct)),
      avgScorePct: mean(members.flatMap((r) => (r.assessment.avgPct !== null ? [r.assessment.avgPct] : []))),
      completed: members.filter((r) => r.completed).length,
      atRisk: members.filter((r) => r.atRisk).length,
      modules: outline.modules.map((m) => ({
        moduleId: m.id,
        title: m.title,
        completed: members.filter((r) => completedModulesOf.get(m.id)?.has(r.studentId)).length,
        of: members.length,
      })),
    };
  });

  // --- funnel (§38) ------------------------------------------------------------
  const count = (pred: (f: Facts) => boolean) => facts.filter(pred).length;
  const funnelCounts: Record<FunnelStage, number> = {
    ACCESS: facts.length,
    SYLLABUS_OPENED: count((f) => !!f.e),
    MODULE_STARTED: count((f) => f.moduleRows.some((r) => STARTED_MODULE.has(r.status) || !!r.startedAt)),
    LESSON_OPENED: count((f) => f.anyLessonOpened),
    THEORY_COMPLETED: count((f) => !!f.e && data.theoryDone.has(f.e.id)),
    PRACTICE_STARTED: count((f) => f.practice.some((p) => p.started)),
    PRACTICE_SUBMITTED: count((f) => f.practice.some((p) => p.submitted)),
    ASSESSMENT_ATTEMPTED: count((f) => f.assessments.some((a) => a.finished > 0)),
    ASSESSMENT_PASSED: count((f) => f.assessments.some((a) => a.passed)),
    MODULE_COMPLETED: count((f) => f.moduleRows.some((r) => r.status === "COMPLETED")),
  };
  const funnel = FUNNEL_STAGES.map((stage) => ({ stage, count: funnelCounts[stage], pct: rate(funnelCounts[stage], funnelCounts.ACCESS) }));

  const core = { overview, students: rows, groups, modules, lessons, practice, funnel };
  return { ...core, insights: buildInsights(core, thresholds) };
}

export type AnalyticsResult = ReturnType<typeof computeAnalytics>;
export type AnalyticsCore = Omit<AnalyticsResult, "insights">;
