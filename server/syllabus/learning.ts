import { and, eq, isNull, sql } from "drizzle-orm";
import { syllabusEnrollments, syllabusItemProgress, syllabusLessonProgress, syllabusPracticeTasks, taskSubmissions, tasks } from "../../drizzle/schema";
import { requireDb } from "../db";
import { startAttempt } from "../modules/attempts";
import { AppError } from "../modules/errors";
import { activeGroupIdsOfStudent } from "../modules/groups";
import { submitToTask } from "../modules/tasks";
import { assertStudentAccess, type StudentAccess } from "./access";
import { bestGrantState, effectiveGrant } from "./accessRules";
import { logActivity, type ActivityRow } from "./activityLog";
import { OPENS_ITEM, STARTS_ITEM, validateActivity, type ClientActivityEvent } from "./activityRules";
import { syllabusEnabledFor } from "./availability";
import { lessonChangesFor } from "./changes";
import { locateItem, locateLesson } from "./engine";
import * as progression from "./progression";
import { studentLessonView, studentPathView } from "./serialize";
import * as store from "./store";
import {
  assessmentState,
  attemptsOf,
  completionView,
  endedView,
  lessonUnlockedAt,
  practiceDueAt,
  practiceSubmissions,
  progressSummary,
  referencedMaterials,
} from "./studentDetails";
import type { EngineOutput, ItemFact, ItemStub, VersionStructure } from "./types";
import { groupmateRows } from "./visibility";

/**
 * Everything a student can call. Each entry point goes through `open()` — feature flag, grant,
 * enrollment — and every content read is decided by the engine first, so locked content is never
 * loaded, let alone returned.
 */

interface Opened extends StudentAccess {
  enrollment: progression.EnrollmentState["enrollment"];
  structure: VersionStructure;
  output: EngineOutput;
  facts?: ReadonlyMap<string, ItemFact>;
}

async function open(userId: number, syllabusId: string): Promise<Opened> {
  const access = await assertStudentAccess(userId, syllabusId);
  let enrollment = await store.enrollmentOf(syllabusId, userId);
  if (!enrollment) {
    if (access.syllabus.archivedAt) throw new AppError("SYLLABUS_ARCHIVED");
    enrollment = await progression.enroll(access.syllabus, userId, access.grant.groupId);
  }
  const state = await progression.current(enrollment);
  if (!state) throw new AppError("NOT_FOUND");
  return { ...access, ...state };
}

function unlockedItem(o: Opened, itemId: string) {
  const found = locateItem(o.structure, itemId);
  if (!found) throw new AppError("NOT_FOUND");
  const evals = found.lesson
    ? o.output.lessons.find((l) => l.id === found.lesson!.id)?.items
    : found.module
      ? o.output.modules.find((m) => m.id === found.module!.id)?.items
      : o.output.finalItems;
  const ev = evals?.find((e) => e.itemId === itemId);
  if (!ev?.available) throw new AppError("SYLLABUS_LOCKED");
  return found;
}

/** Cards for "My syllabi": active ones plus ended ones (progress kept, no content). */
export async function mySyllabi(userId: number) {
  const groupIds = await activeGroupIdsOfStudent(userId);
  const [grants, enrollments] = await Promise.all([store.grantsReachingStudent(userId, groupIds), store.enrollmentsOfStudent(userId)]);
  const ids = [...new Set([...grants.map((g) => g.syllabusId), ...enrollments.map((e) => e.syllabusId)])];
  const rows = await store.syllabiByIds(ids);
  const now = new Date();
  const out = [];
  for (const s of rows) {
    if (!s.currentVersionId || !(await syllabusEnabledFor(s.providerWorkspaceId))) continue;
    const mine = grants.filter((g) => g.syllabusId === s.id);
    const enrollment = enrollments.find((e) => e.syllabusId === s.id) ?? null;
    const state = effectiveGrant(mine, userId, groupIds, now) ? "ACTIVE" : bestGrantState(mine, userId, groupIds, now);
    if (!state) continue;
    if (state === "PENDING" && !enrollment) {
      const startsAt = mine.map((g) => g.startsAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      out.push({ id: s.id, title: s.title, subject: s.subject, level: s.level, coverFileId: s.coverFileId, access: state, startsAt, progress: null });
      continue;
    }
    if (state !== "ACTIVE" && !enrollment) continue;
    out.push({
      id: s.id,
      title: s.title,
      subject: s.subject,
      level: s.level,
      coverFileId: s.coverFileId,
      access: state,
      startsAt: null,
      progress: enrollment
        ? {
            progressPct: enrollment.progressPct,
            completedLessons: enrollment.completedLessons,
            totalLessons: enrollment.totalLessons,
            currentLessonId: state === "ACTIVE" ? enrollment.currentLessonId : null,
            completed: enrollment.status === "COMPLETED",
            lastActivityAt: enrollment.lastActivityAt,
          }
        : null,
    });
  }
  return out;
}

export async function learningPath(userId: number, syllabusId: string) {
  const o = await open(userId, syllabusId);
  const version = await store.versionById(o.enrollment.versionId);
  const summary = progressSummary(o.structure, o.output, o.facts);
  const scores = await attemptsOf(userId, summary.assessments.flatMap((a) => (a.assessmentId ? [a.assessmentId] : [])));
  const grants = await store.grantsForSyllabus(syllabusId);
  const grantedGroups = o.groupIds.filter((g) => grants.some((x) => x.groupId === g && x.status === "ACTIVE"));
  const groupRows = ((await store.groupsByIds(grantedGroups)) ?? []).filter((g) => g.workspaceId === o.syllabus.providerWorkspaceId);
  const completion = o.enrollment.status === "COMPLETED" ? await store.completionOf(o.enrollment.id) : null;
  const lessonChanges = await lessonChangesFor(o.enrollment);
  const details = await store.moduleDetailsOfVersion(o.enrollment.versionId);
  return {
    syllabus: { id: o.syllabus.id, title: o.syllabus.title, description: o.syllabus.description ?? "", subject: o.syllabus.subject, level: o.syllabus.level },
    version: { id: o.enrollment.versionId, label: version?.version.label ?? "" },
    access: { endsAt: o.grant.endsAt },
    ...studentPathView(o.structure, o.output, details),
    awaitingApproval: o.output.syllabusAwaitingApproval,
    summary: {
      practice: summary.practice,
      theory: summary.theory,
      assessments: summary.assessments.map(({ assessmentId, ...a }) => {
        const finished = (assessmentId ? (scores.get(assessmentId) ?? []) : []).filter((r) => r.status !== "IN_PROGRESS");
        const shown = finished.flatMap((r) => (r.pct === null ? [] : [r.pct]));
        return { ...a, attempts: finished.length, bestPct: shown.length ? Math.max(...shown) : null, held: finished.some((r) => r.held) };
      }),
    },
    groups: groupRows.map((g) => ({ id: g.id, name: g.name })),
    completion: completion ? completionView(completion, version?.version.label ?? "") : null,
    lessonChanges,
  };
}

/** Active access → the full path; ended or not-yet-started access → progress only, no content. */
export async function overview(userId: number, syllabusId: string) {
  try {
    return { mode: "ACTIVE" as const, path: await learningPath(userId, syllabusId), ended: null };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "SYLLABUS_NO_ACCESS") throw error;
    return { mode: "ENDED" as const, path: null, ended: await endedView(userId, syllabusId) };
  }
}

/** Whether to show the student's Syllabus entry: some syllabus of an enabled workspace reaches them. Never throws. */
export async function hasAny(userId: number) {
  try {
    const groupIds = await activeGroupIdsOfStudent(userId);
    const [grants, enrollments] = await Promise.all([store.grantsReachingStudent(userId, groupIds), store.enrollmentsOfStudent(userId)]);
    const ids = [...new Set([...grants.filter((g) => g.status === "ACTIVE").map((g) => g.syllabusId), ...enrollments.map((e) => e.syllabusId)])];
    const rows = await store.syllabiByIds(ids);
    for (const s of rows) if (s.currentVersionId && (await syllabusEnabledFor(s.providerWorkspaceId))) return true;
    return false;
  } catch {
    return false;
  }
}

export async function lesson(userId: number, syllabusId: string, lessonId: string) {
  const o = await open(userId, syllabusId);
  const lr = o.output.lessons.find((l) => l.id === lessonId);
  if (!lr) throw new AppError("NOT_FOUND");
  // Content is loaded only for an unlocked lesson.
  const stubs = lr.status === "LOCKED" ? [] : (o.structure.modules.flatMap((m) => m.lessons).find((l) => l.id === lessonId)?.items ?? []);
  const contents = await store.versionItems(o.enrollment.versionId, stubs.map((i) => i.id));
  const view = studentLessonView(
    o.structure,
    o.output,
    lessonId,
    contents.map((c) => ({ itemId: c.itemId, kind: c.kind, content: c.content })),
  );
  if (!view || view.locked) return view;
  return { ...view, ...(await lessonExtras(o, lessonId, view.items, contents)) };
}

type LessonItems = Extract<NonNullable<ReturnType<typeof studentLessonView>>, { locked: false }>["items"];

/** Practice submissions, assessment attempts, due dates and referenced materials of an unlocked lesson. */
async function lessonExtras(o: Opened, lessonId: string, items: LessonItems, contents: ReadonlyArray<{ itemId: string; kind: ItemStub["kind"]; content: Record<string, unknown> }>) {
  const stubs = new Map(o.structure.modules.flatMap((m) => m.lessons).find((l) => l.id === lessonId)!.items.map((i) => [i.id, i]));
  const practice = items.filter((i) => i.kind === "STUDENT_PRACTICE");
  const assessed = items.filter((i) => i.kind === "ASSESSMENT");
  const rules = locateLesson(o.structure, lessonId)!.lesson.rules;
  const needsUnlockDate = practice.some((i) => (i.content.deadline as { type?: string } | undefined)?.type === "RELATIVE_DAYS");
  const [subs, attemptRows, unlockedAt, mats] = await Promise.all([
    practiceSubmissions(o.enrollment.studentId, practice.flatMap((i) => (stubs.get(i.id)?.taskId ? [stubs.get(i.id)!.taskId!] : []))),
    attemptsOf(o.enrollment.studentId, assessed.flatMap((i) => (stubs.get(i.id)?.assessmentId ? [stubs.get(i.id)!.assessmentId!] : []))),
    needsUnlockDate ? lessonUnlockedAt(o.enrollment.id, lessonId) : Promise.resolve(null),
    referencedMaterials(o.syllabus.providerWorkspaceId, contents),
  ]);
  const now = new Date();
  return {
    items: items.map((i) => {
      const stub = stubs.get(i.id);
      if (i.kind === "STUDENT_PRACTICE") {
        const submission = stub?.taskId ? (subs.get(stub.taskId) ?? null) : null;
        const dueAt = practiceDueAt(i.content.deadline, unlockedAt);
        return { ...i, practice: { taskId: stub?.taskId ?? null, submission, dueAt, overdue: !!dueAt && dueAt < now && !submission, canSubmit: i.available && !submission?.grade } };
      }
      if (i.kind === "ASSESSMENT" && stub) {
        return { ...i, assessment: assessmentState(stub, rules, stub.assessmentId ? (attemptRows.get(stub.assessmentId) ?? []) : [], i.available && i.state !== "MET", now) };
      }
      return i;
    }),
    materials: mats.map((m) => ({ id: m.id, title: m.title, fileId: m.fileId ?? null })),
  };
}

const ITEM_FACT_COLUMNS = {
  openedAt: syllabusItemProgress.openedAt,
  startedAt: syllabusItemProgress.startedAt,
  completedAt: syllabusItemProgress.completedAt,
} as const;

/** First time wins: an existing timestamp is never overwritten. */
async function upsertItemFact(o: Opened, itemId: string, patch: Partial<Record<keyof typeof ITEM_FACT_COLUMNS, Date>>) {
  const found = locateItem(o.structure, itemId)!;
  const set = Object.fromEntries(
    (Object.keys(patch) as Array<keyof typeof ITEM_FACT_COLUMNS>).map((k) => [k, sql`coalesce(${ITEM_FACT_COLUMNS[k]}, values(${ITEM_FACT_COLUMNS[k]}))`]),
  );
  await requireDb()
    .insert(syllabusItemProgress)
    .values({ enrollmentId: o.enrollment.id, itemId, syllabusId: o.syllabus.id, lessonId: found.lesson?.id ?? null, kind: found.item.kind, ...patch })
    .onDuplicateKeyUpdate({ set });
}

const activityBase = (o: Opened) => ({ userId: o.enrollment.studentId, workspaceId: o.syllabus.providerWorkspaceId, syllabusId: o.syllabus.id, versionId: o.enrollment.versionId, groupId: o.grant.groupId });

/** "Mark as read": satisfies the theory rule for one THEORY item. */
export async function completeTheory(userId: number, syllabusId: string, itemId: string) {
  const o = await open(userId, syllabusId);
  const found = unlockedItem(o, itemId);
  if (found.item.kind !== "THEORY") throw new AppError("SYLLABUS_INVALID_TARGET");
  const now = new Date();
  await upsertItemFact(o, itemId, { openedAt: now, completedAt: now });
  await logActivity([{ ...activityBase(o), moduleId: found.module?.id, lessonId: found.lesson?.id, itemId, activityType: "THEORY_COMPLETED", source: "SERVER" }]);
  const state = await progression.recompute(o.enrollment.id);
  return { lessonStatus: state?.output.lessons.find((l) => l.id === found.lesson?.id)?.status ?? null, progressPct: state?.output.progressPct ?? 0 };
}

const OPEN_THROTTLE_MS = 30 * 60_000;
const recentOpens = new Map<string, number>();
function throttledOpen(key: string, now: number) {
  const last = recentOpens.get(key);
  if (last && now - last < OPEN_THROTTLE_MS) return true;
  if (recentOpens.size > 50_000) recentOpens.clear();
  recentOpens.set(key, now);
  return false;
}

/** Client activity ingestion: validated against the pinned version and current locks; outcomes stay server-only. */
export async function track(userId: number, syllabusId: string, events: readonly ClientActivityEvent[]) {
  const o = await open(userId, syllabusId);
  const openLessons = new Set(o.output.lessons.filter((l) => l.status !== "LOCKED").map((l) => l.id));
  const openScopedItems = new Set([...o.output.modules.flatMap((m) => m.items), ...o.output.finalItems].filter((e) => e.available).map((e) => e.itemId));
  const { accepted, rejected } = validateActivity(events, { structure: o.structure, openLessons, openScopedItems });
  const db = requireDb();
  const now = new Date();
  const rows: ActivityRow[] = [];
  let factsChanged = false;
  for (const a of accepted) {
    if (a.type === "HEARTBEAT") {
      if (a.lessonId && a.durationSeconds) {
        await db
          .update(syllabusLessonProgress)
          .set({ activeSeconds: sql`${syllabusLessonProgress.activeSeconds} + ${a.durationSeconds}` })
          .where(and(eq(syllabusLessonProgress.enrollmentId, o.enrollment.id), eq(syllabusLessonProgress.lessonId, a.lessonId)));
      }
      continue;
    }
    if (a.type === "LESSON_OPENED" && a.lessonId) {
      await db
        .update(syllabusLessonProgress)
        .set({ openedAt: now })
        .where(and(eq(syllabusLessonProgress.enrollmentId, o.enrollment.id), eq(syllabusLessonProgress.lessonId, a.lessonId), isNull(syllabusLessonProgress.openedAt)));
      if (o.output.lessons.find((l) => l.id === a.lessonId)?.status === "AVAILABLE") factsChanged = true;
    }
    if (a.itemId && OPENS_ITEM.has(a.type)) {
      await upsertItemFact(o, a.itemId, { openedAt: now });
      factsChanged = true;
    }
    if (a.itemId && STARTS_ITEM.has(a.type)) await upsertItemFact(o, a.itemId, { openedAt: now, startedAt: now });
    if (a.itemId && a.type === "VIDEO_COMPLETED") {
      await upsertItemFact(o, a.itemId, { openedAt: now, completedAt: now });
      factsChanged = true;
    }
    const repeatable = a.type === "VIDEO_PROGRESS" || a.type === "VIDEO_COMPLETED";
    const key = `${userId}:${a.type}:${a.moduleId ?? ""}:${a.lessonId ?? ""}:${a.itemId ?? ""}:${a.metadata?.pct ?? ""}`;
    if (!repeatable && throttledOpen(key, now.getTime())) continue;
    rows.push({ ...activityBase(o), moduleId: a.moduleId, lessonId: a.lessonId, itemId: a.itemId, activityType: a.type, durationSeconds: a.durationSeconds, metadata: a.metadata, source: "CLIENT" });
  }
  await db.update(syllabusEnrollments).set({ lastActivityAt: now }).where(eq(syllabusEnrollments.id, o.enrollment.id));
  await logActivity(rows);
  if (factsChanged) await progression.recompute(o.enrollment.id);
  return { accepted: accepted.length, rejected };
}

/** Starts (or resumes) an unlocked assessment item through the existing engine. */
export async function startAssessment(userId: number, syllabusId: string, itemId: string) {
  const o = await open(userId, syllabusId);
  const found = unlockedItem(o, itemId);
  if (found.item.kind !== "ASSESSMENT" || !found.item.assessmentId) throw new AppError("SYLLABUS_INVALID_TARGET");
  // The assignment is created by the recompute that unlocked the item; one more recompute covers a lost race.
  let assignmentId = await progression.assignmentForItem(o.enrollment.id, itemId);
  if (assignmentId === null) {
    await progression.recompute(o.enrollment.id);
    assignmentId = await progression.assignmentForItem(o.enrollment.id, itemId);
  }
  if (assignmentId === null) throw new AppError("SYLLABUS_LOCKED");
  const started = await startAttempt(found.item.assessmentId, userId, assignmentId);
  if (!started.resumed) {
    await logActivity([{ ...activityBase(o), moduleId: found.module?.id, lessonId: found.lesson?.id, itemId, assessmentId: found.item.assessmentId, activityType: "ASSESSMENT_STARTED", source: "SERVER" }]);
  }
  return started;
}

/** Submits an unlocked practice into its frozen container task (AI review / auto-grade run as for any task). */
export async function submitPractice(userId: number, syllabusId: string, itemId: string, files: Array<{ fileId: string }>, answerText: string) {
  const o = await open(userId, syllabusId);
  const found = unlockedItem(o, itemId);
  if (found.item.kind !== "STUDENT_PRACTICE" || !found.item.taskId) throw new AppError("SYLLABUS_INVALID_TARGET");
  const [task] = await requireDb().select().from(tasks).where(eq(tasks.id, found.item.taskId)).limit(1);
  if (!task) throw new AppError("NOT_FOUND");
  const [before] = await requireDb()
    .select({ submittedAt: taskSubmissions.submittedAt })
    .from(taskSubmissions)
    .where(and(eq(taskSubmissions.taskId, task.id), eq(taskSubmissions.studentId, userId)))
    .limit(1);
  const view = await submitToTask(userId, task, files, answerText);
  await upsertItemFact(o, itemId, { openedAt: new Date(), startedAt: new Date() });
  const activityType = before?.submittedAt ? "PRACTICE_RESUBMITTED" : "PRACTICE_SUBMITTED";
  await logActivity([{ ...activityBase(o), moduleId: found.module?.id, lessonId: found.lesson?.id, itemId, taskId: task.id, activityType, source: "SERVER" }]);
  await progression.recompute(o.enrollment.id);
  return view;
}

/** Download rule for files inside syllabus content: live access and the item using the file is open now. */
export async function canOpenItem(userId: number, syllabusId: string, itemId: string) {
  try {
    unlockedItem(await open(userId, syllabusId), itemId);
    return true;
  } catch {
    return false;
  }
}

/** File upload rule for practice containers: the item must be unlocked for this student in their pinned version. */
export async function practiceUploadAllowed(userId: number, taskId: string) {
  try {
    const [link] = await requireDb().select().from(syllabusPracticeTasks).where(eq(syllabusPracticeTasks.taskId, taskId)).limit(1);
    if (!link) return false;
    const o = await open(userId, link.syllabusId);
    const found = locateItem(o.structure, link.itemId);
    if (!found || found.item.taskId !== taskId) return false;
    unlockedItem(o, link.itemId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Groupmates' progress (owner decision Q7). Allowed only for an ACTIVE member of a group of the
 * syllabus's workspace that has a grant on it, and only while the teacher's setting is ON.
 * Progress fields only — no scores, answers, feedback or activity.
 */
export async function groupProgress(userId: number, syllabusId: string, groupId: string) {
  const o = await open(userId, syllabusId);
  if (!o.groupIds.includes(groupId)) throw new AppError("NOT_FOUND");
  const group = await store.groupById(groupId);
  if (!group || group.workspaceId !== o.syllabus.providerWorkspaceId) throw new AppError("NOT_FOUND");
  const grants = await store.grantsForSyllabus(syllabusId);
  if (!grants.some((g) => g.groupId === groupId && g.status === "ACTIVE")) throw new AppError("NOT_FOUND");
  if (!(await store.progressVisibleToGroup(groupId))) throw new AppError("SYLLABUS_PROGRESS_HIDDEN");

  const members = await store.activeMembersWithNames(groupId);
  const enrollments = await store.enrollmentsOfStudents(syllabusId, members.map((m) => m.studentId));
  const titles = new Map<string, string>();
  for (const versionId of new Set(enrollments.map((e) => e.versionId))) {
    const v = await store.versionById(versionId);
    for (const m of v?.structure.modules ?? []) titles.set(m.id, m.title);
  }
  return {
    group: { id: group.id, name: group.name },
    members: groupmateRows(members, enrollments, titles, userId),
  };
}
