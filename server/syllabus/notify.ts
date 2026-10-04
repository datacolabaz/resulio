import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  syllabusCompletions,
  syllabusLessonProgress,
  syllabusModuleProgress,
  users,
  type Syllabus,
  type SyllabusAccessGrant,
  type SyllabusEnrollment,
} from "../../drizzle/schema";
import { requireDb } from "../db";
import { activeStudentIdsOfGroups } from "../modules/groups";
import { dispatch } from "../notifications/dispatcher";
import { isMissingTable } from "../notifications/preferences";
import { grantState } from "./accessRules";
import { syllabusEnabledFor } from "./availability";
import type { EngineOutput, VersionStructure } from "./types";

/**
 * Syllabus notices through the shared dispatcher (preferences, outbox, retries):
 * - SYLLABUS_ACCESS_GRANTED when a grant first reaches a student (or the first version is published);
 * - SYLLABUS_UNLOCKED, batched per enrollment over a short window, leaving out what the student
 *   already opened (they unlocked it themselves while studying, so no notice is needed);
 * - SYLLABUS_APPROVAL_NEEDED to the teacher, batched per syllabus;
 * - SYLLABUS_COMPLETED once per student and syllabus.
 * Everything here is best effort and never fails the caller.
 */

export const NOTICE_WINDOW_MS = 2 * 60_000;

export interface NodeRef {
  id: string;
  title: string;
}

export interface ApprovalRef {
  type: "LESSON" | "MODULE" | "SYLLABUS";
  id: string;
}

export interface PlannedNotices {
  lessons: NodeRef[];
  modules: NodeRef[];
  approvals: ApprovalRef[];
}

/** Pure: what one recompute should announce. The very first lesson/module is covered by the access notice. */
export function planNotices(structure: VersionStructure, out: EngineOutput): PlannedNotices {
  const lessonTitles = new Map(structure.modules.flatMap((m) => m.lessons.map((l) => [l.id, l.title] as const)));
  const moduleTitles = new Map(structure.modules.map((m) => [m.id, m.title] as const));
  const firstModule = structure.modules[0]?.id;
  const firstLesson = structure.modules[0]?.lessons[0]?.id;
  const opened = (t: { from: string; to: string }) => t.from === "LOCKED" && t.to !== "LOCKED";
  const lessons = out.transitions
    .filter((t) => t.nodeType === "LESSON" && opened(t) && t.id !== firstLesson)
    .map((t) => ({ id: t.id, title: lessonTitles.get(t.id) ?? "" }));
  const modules = out.transitions
    .filter((t) => t.nodeType === "MODULE" && opened(t) && t.id !== firstModule)
    .map((t) => ({ id: t.id, title: moduleTitles.get(t.id) ?? "" }));
  const approvals: ApprovalRef[] = out.transitions
    .filter((t) => t.to === "AWAITING_APPROVAL")
    .map((t) => ({ type: t.nodeType, id: t.id }));
  if (out.syllabusAwaitingApproval) approvals.push({ type: "SYLLABUS", id: "syllabus" });
  return { lessons, modules, approvals };
}

/** Pure: drop what the student has already opened or started by the time the batch goes out. */
export function unseenNodes(
  batch: { lessons: NodeRef[]; modules: NodeRef[] },
  openedLessons: ReadonlySet<string>,
  startedModules: ReadonlySet<string>,
) {
  return { lessons: batch.lessons.filter((l) => !openedLessons.has(l.id)), modules: batch.modules.filter((m) => !startedModules.has(m.id)) };
}

export const batchKey = (parts: readonly string[]) => createHash("sha256").update([...parts].sort().join("|")).digest("hex").slice(0, 24);

/** Students a set of grants reaches right now (individual grants and active group members). */
export async function reachedStudents(grants: readonly SyllabusAccessGrant[], now = new Date()) {
  const live = grants.filter((g) => grantState(g, now) === "ACTIVE" || grantState(g, now) === "PENDING");
  const ids = new Set<number>(live.flatMap((g) => (g.studentId ? [g.studentId] : [])));
  const groupIds = [...new Set(live.flatMap((g) => (g.groupId ? [g.groupId] : [])))];
  if (groupIds.length) for (const id of await activeStudentIdsOfGroups(groupIds)) ids.add(id);
  return ids;
}

function safe(label: string, run: () => Promise<void>) {
  setImmediate(() => {
    run().catch((error) => {
      if (!isMissingTable(error)) console.error(`[syllabus] ${label} notice failed`, error instanceof Error ? error.message : error);
    });
  });
}

/** After new grants: everyone they reach who could not open the syllabus before gets one notice. */
export function announceGrants(syllabus: Syllabus, before: readonly SyllabusAccessGrant[], created: readonly SyllabusAccessGrant[]) {
  if (!syllabus.currentVersionId || !created.length) return;
  safe("access", async () => {
    if (!(await syllabusEnabledFor(syllabus.providerWorkspaceId))) return;
    const had = await reachedStudents(before);
    for (const g of created) {
      const reached = await reachedStudents([g]);
      const startsAt = g.startsAt && g.startsAt.getTime() > Date.now() ? g.startsAt.toISOString() : null;
      for (const studentId of reached) {
        if (had.has(studentId)) continue;
        had.add(studentId);
        dispatch({
          event: "SYLLABUS_ACCESS_GRANTED",
          userId: studentId,
          dedupeKey: `syl-access:${g.id}:${studentId}`,
          data: { syllabusId: syllabus.id, syllabusTitle: syllabus.title, startsAt },
        });
      }
    }
  });
}

/** The first published version: students granted while it was a draft hear about it now. */
export function announceFirstPublish(syllabus: Syllabus, grants: readonly SyllabusAccessGrant[]) {
  safe("publish", async () => {
    if (!(await syllabusEnabledFor(syllabus.providerWorkspaceId))) return;
    for (const studentId of await reachedStudents(grants)) {
      dispatch({
        event: "SYLLABUS_ACCESS_GRANTED",
        userId: studentId,
        dedupeKey: `syl-access:${syllabus.id}:${studentId}:first-publish`,
        data: { syllabusId: syllabus.id, syllabusTitle: syllabus.title, startsAt: null },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Batching (in memory, per server instance; a restart drops at most one window of in-app notices)
// ---------------------------------------------------------------------------

interface StudentBatch {
  syllabusId: string;
  syllabusTitle: string;
  studentId: number;
  lessons: Map<string, string>;
  modules: Map<string, string>;
}
interface TeacherBatch {
  syllabusId: string;
  syllabusTitle: string;
  teacherId: number;
  keys: Set<string>;
  students: Set<number>;
}

const studentBatches = new Map<string, StudentBatch>();
const teacherBatches = new Map<string, TeacherBatch>();
const announcedApprovals = new Set<string>();
const MAX_REMEMBERED = 20_000;

function later(fn: () => Promise<void>) {
  const timer = setTimeout(() => void fn().catch((e) => !isMissingTable(e) && console.error("[syllabus] notice flush failed", e instanceof Error ? e.message : e)), NOTICE_WINDOW_MS);
  timer.unref?.();
}

async function flushStudent(enrollmentId: string) {
  const b = studentBatches.get(enrollmentId);
  studentBatches.delete(enrollmentId);
  if (!b) return;
  const db = requireDb();
  const lessonIds = [...b.lessons.keys()];
  const moduleIds = [...b.modules.keys()];
  const [lessonRows, moduleRows] = await Promise.all([
    lessonIds.length
      ? db.select({ id: syllabusLessonProgress.lessonId, openedAt: syllabusLessonProgress.openedAt }).from(syllabusLessonProgress).where(and(eq(syllabusLessonProgress.enrollmentId, enrollmentId), inArray(syllabusLessonProgress.lessonId, lessonIds)))
      : [],
    moduleIds.length
      ? db.select({ id: syllabusModuleProgress.moduleId, status: syllabusModuleProgress.status }).from(syllabusModuleProgress).where(and(eq(syllabusModuleProgress.enrollmentId, enrollmentId), inArray(syllabusModuleProgress.moduleId, moduleIds)))
      : [],
  ]);
  const toRefs = (m: Map<string, string>) => [...m].map(([id, title]) => ({ id, title }));
  const left = unseenNodes(
    { lessons: toRefs(b.lessons), modules: toRefs(b.modules) },
    new Set(lessonRows.filter((r) => r.openedAt).map((r) => r.id)),
    new Set(moduleRows.filter((r) => r.status !== "AVAILABLE" && r.status !== "LOCKED").map((r) => r.id)),
  );
  if (!left.lessons.length && !left.modules.length) return;
  dispatch({
    event: "SYLLABUS_UNLOCKED",
    userId: b.studentId,
    dedupeKey: `syl-unlock:${enrollmentId}:${batchKey([...left.lessons, ...left.modules].map((n) => n.id))}`,
    data: {
      syllabusId: b.syllabusId,
      syllabusTitle: b.syllabusTitle,
      lessons: left.lessons.map((l) => l.title),
      modules: left.modules.map((m) => m.title),
      lessonId: left.lessons[0]?.id ?? null,
    },
  });
}

async function flushTeacher(key: string) {
  const b = teacherBatches.get(key);
  teacherBatches.delete(key);
  if (!b || !b.keys.size) return;
  let studentName: string | null = null;
  if (b.students.size === 1) {
    const [row] = await requireDb().select({ name: users.name }).from(users).where(eq(users.id, [...b.students][0])).limit(1);
    studentName = row?.name?.trim() || null;
  }
  dispatch({
    event: "SYLLABUS_APPROVAL_NEEDED",
    userId: b.teacherId,
    dedupeKey: `syl-approval:${b.syllabusId}:${batchKey([...b.keys])}`,
    data: { syllabusId: b.syllabusId, syllabusTitle: b.syllabusTitle, count: b.students.size, studentName },
  });
}

async function sendCompleted(e: SyllabusEnrollment, syllabus: Syllabus) {
  const [row] = await requireDb().select({ code: syllabusCompletions.verificationCode }).from(syllabusCompletions).where(eq(syllabusCompletions.enrollmentId, e.id)).limit(1);
  dispatch({
    event: "SYLLABUS_COMPLETED",
    userId: e.studentId,
    dedupeKey: `syl-complete:${syllabus.id}:${e.studentId}`,
    data: { syllabusId: syllabus.id, syllabusTitle: syllabus.title, verificationCode: row?.code ?? null },
  });
}

/**
 * Called after every committed recompute. `decisions` (number of approval decisions so far) makes a
 * new request after a "returned" decision a new notice.
 */
export function afterRecompute(e: SyllabusEnrollment, syllabus: Syllabus, structure: VersionStructure, out: EngineOutput, completedNow: boolean, decisions: number) {
  try {
    const plan = planNotices(structure, out);
    if (plan.lessons.length || plan.modules.length) {
      let b = studentBatches.get(e.id);
      if (!b) {
        b = { syllabusId: syllabus.id, syllabusTitle: syllabus.title, studentId: e.studentId, lessons: new Map(), modules: new Map() };
        studentBatches.set(e.id, b);
        later(() => flushStudent(e.id));
      }
      for (const l of plan.lessons) b.lessons.set(l.id, l.title);
      for (const m of plan.modules) b.modules.set(m.id, m.title);
    }
    const fresh = plan.approvals.map((a) => `${e.id}:${a.type}:${a.id}:${decisions}`).filter((k) => !announcedApprovals.has(k));
    if (fresh.length) {
      if (announcedApprovals.size > MAX_REMEMBERED) announcedApprovals.clear();
      for (const k of fresh) announcedApprovals.add(k);
      const key = `${syllabus.createdBy}:${syllabus.id}`;
      let t = teacherBatches.get(key);
      if (!t) {
        t = { syllabusId: syllabus.id, syllabusTitle: syllabus.title, teacherId: syllabus.createdBy, keys: new Set(), students: new Set() };
        teacherBatches.set(key, t);
        later(() => flushTeacher(key));
      }
      for (const k of fresh) t.keys.add(k);
      t.students.add(e.studentId);
    }
    if (completedNow) safe("completed", () => sendCompleted(e, syllabus));
  } catch (error) {
    console.error("[syllabus] notice planning failed", error instanceof Error ? error.message : error);
  }
}
