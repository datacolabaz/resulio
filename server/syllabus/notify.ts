import { createHash } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  syllabusCompletions,
  syllabusLessonProgress,
  syllabusModuleProgress,
  syllabusNoticeBatches,
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
// Batching: one open batch per recipient in `syllabus_notice_batches`, merged on every recompute and
// sent by `flushDueNotices` once its window has passed, so a restart never drops one. Before that
// table exists the same batches live in memory for the window.
// ---------------------------------------------------------------------------

export interface UnlockPayload {
  syllabusTitle: string;
  studentId: number;
  enrollmentId: string;
  /** [id, title] in unlock order. */
  lessons: Array<[string, string]>;
  modules: Array<[string, string]>;
}
export interface ApprovalPayload {
  syllabusTitle: string;
  teacherId: number;
  keys: string[];
  students: number[];
}
export type PendingNotice =
  | { key: string; kind: "UNLOCK"; syllabusId: string; payload: UnlockPayload }
  | { key: string; kind: "APPROVAL"; syllabusId: string; payload: ApprovalPayload };

const unionPairs = (a: Array<[string, string]>, b: Array<[string, string]>) => {
  const seen = new Map(a);
  for (const [id, title] of b) seen.set(id, title);
  return [...seen];
};
const union = <T>(a: readonly T[], b: readonly T[]) => [...new Set([...a, ...b])];

/** Pure: an addition folded into an open batch (latest titles win, first-seen order kept). */
export function mergeNotice(open: PendingNotice, add: PendingNotice): PendingNotice {
  if (open.kind === "UNLOCK" && add.kind === "UNLOCK") {
    return { ...open, payload: { ...open.payload, syllabusTitle: add.payload.syllabusTitle, lessons: unionPairs(open.payload.lessons, add.payload.lessons), modules: unionPairs(open.payload.modules, add.payload.modules) } };
  }
  if (open.kind === "APPROVAL" && add.kind === "APPROVAL") {
    return { ...open, payload: { ...open.payload, syllabusTitle: add.payload.syllabusTitle, keys: union(open.payload.keys, add.payload.keys), students: union(open.payload.students, add.payload.students) } };
  }
  return add;
}

const announcedApprovals = new Set<string>();
const MAX_REMEMBERED = 20_000;
const memoryBatches = new Map<string, PendingNotice>();

const logFailure = (error: unknown) => {
  if (!isMissingTable(error)) console.error("[syllabus] notice flush failed", error instanceof Error ? error.message : error);
};

function enqueueInMemory(notice: PendingNotice) {
  const open = memoryBatches.get(notice.key);
  memoryBatches.set(notice.key, open ? mergeNotice(open, notice) : notice);
  if (open) return;
  const timer = setTimeout(() => {
    const due = memoryBatches.get(notice.key);
    memoryBatches.delete(notice.key);
    if (due) void send(due).catch(logFailure);
  }, NOTICE_WINDOW_MS);
  timer.unref?.();
}

const isRetryable = (e: unknown) => {
  for (let cur = e, i = 0; cur && typeof cur === "object" && i < 5; cur = (cur as { cause?: unknown }).cause, i++) {
    const code = (cur as { code?: unknown }).code;
    if (code === "ER_DUP_ENTRY" || code === "ER_LOCK_DEADLOCK") return true;
  }
  return false;
};

const fromRow = (row: typeof syllabusNoticeBatches.$inferSelect) =>
  ({ key: row.batchKey, kind: row.kind, syllabusId: row.syllabusId, payload: row.payload }) as unknown as PendingNotice;

async function upsertBatch(notice: PendingNotice, now: Date) {
  await requireDb().transaction(async (tx) => {
    const [row] = await tx.select().from(syllabusNoticeBatches).where(eq(syllabusNoticeBatches.batchKey, notice.key)).limit(1).for("update");
    if (!row) {
      await tx.insert(syllabusNoticeBatches).values({
        batchKey: notice.key,
        kind: notice.kind,
        syllabusId: notice.syllabusId,
        payload: notice.payload as unknown as Record<string, unknown>,
        dueAt: new Date(now.getTime() + NOTICE_WINDOW_MS),
      });
      return;
    }
    const merged = mergeNotice(fromRow(row), notice);
    await tx
      .update(syllabusNoticeBatches)
      .set({ payload: merged.payload as unknown as Record<string, unknown>, revision: sql`${syllabusNoticeBatches.revision} + 1` })
      .where(eq(syllabusNoticeBatches.batchKey, notice.key));
  });
}

/** Where open batches live; one object so tests can run the batching without MySQL. */
export const batchStore = {
  upsert: upsertBatch,
  due: async (now: Date, limit: number) => (await requireDb().select().from(syllabusNoticeBatches).where(lte(syllabusNoticeBatches.dueAt, now)).limit(limit)).map((row) => ({ notice: fromRow(row), revision: row.revision })),
  /** Deletes the batch only if nobody merged into it since it was read. */
  claim: async (key: string, revision: number) => {
    const [res] = await requireDb()
      .delete(syllabusNoticeBatches)
      .where(and(eq(syllabusNoticeBatches.batchKey, key), eq(syllabusNoticeBatches.revision, revision)));
    return res.affectedRows === 1;
  },
};

/** Adds to the recipient's open batch (persisted; in memory until the table exists). */
export async function enqueueNotice(notice: PendingNotice, now = new Date()) {
  try {
    await batchStore.upsert(notice, now).catch((e) => (isRetryable(e) ? batchStore.upsert(notice, now) : Promise.reject(e)));
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    enqueueInMemory(notice);
  }
}

/** Sends every batch whose window has passed. Safe on several instances: a batch is sent by whoever deletes it. */
export async function flushDueNotices(now = new Date(), limit = 50) {
  let due: Awaited<ReturnType<typeof batchStore.due>>;
  try {
    due = await batchStore.due(now, limit);
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  let sent = 0;
  for (const { notice, revision } of due) {
    // Merged in the meantime: the next sweep sends the larger batch.
    if (!(await batchStore.claim(notice.key, revision))) continue;
    await send(notice).then(() => sent++, logFailure);
  }
  return sent;
}

function send(notice: PendingNotice) {
  return notice.kind === "UNLOCK" ? sendUnlock(notice.syllabusId, notice.payload) : sendApproval(notice.syllabusId, notice.payload);
}

async function sendUnlock(syllabusId: string, b: UnlockPayload) {
  const db = requireDb();
  const lessonIds = b.lessons.map(([id]) => id);
  const moduleIds = b.modules.map(([id]) => id);
  const [lessonRows, moduleRows] = await Promise.all([
    lessonIds.length
      ? db.select({ id: syllabusLessonProgress.lessonId, openedAt: syllabusLessonProgress.openedAt }).from(syllabusLessonProgress).where(and(eq(syllabusLessonProgress.enrollmentId, b.enrollmentId), inArray(syllabusLessonProgress.lessonId, lessonIds)))
      : [],
    moduleIds.length
      ? db.select({ id: syllabusModuleProgress.moduleId, status: syllabusModuleProgress.status }).from(syllabusModuleProgress).where(and(eq(syllabusModuleProgress.enrollmentId, b.enrollmentId), inArray(syllabusModuleProgress.moduleId, moduleIds)))
      : [],
  ]);
  const toRefs = (pairs: Array<[string, string]>) => pairs.map(([id, title]) => ({ id, title }));
  const left = unseenNodes(
    { lessons: toRefs(b.lessons), modules: toRefs(b.modules) },
    new Set(lessonRows.filter((r) => r.openedAt).map((r) => r.id)),
    new Set(moduleRows.filter((r) => r.status !== "AVAILABLE" && r.status !== "LOCKED").map((r) => r.id)),
  );
  if (!left.lessons.length && !left.modules.length) return;
  dispatch({
    event: "SYLLABUS_UNLOCKED",
    userId: b.studentId,
    dedupeKey: `syl-unlock:${b.enrollmentId}:${batchKey([...left.lessons, ...left.modules].map((n) => n.id))}`,
    data: {
      syllabusId,
      syllabusTitle: b.syllabusTitle,
      lessons: left.lessons.map((l) => l.title),
      modules: left.modules.map((m) => m.title),
      lessonId: left.lessons[0]?.id ?? null,
    },
  });
}

async function sendApproval(syllabusId: string, b: ApprovalPayload) {
  if (!b.keys.length) return;
  let studentName: string | null = null;
  if (b.students.length === 1) {
    const [row] = await requireDb().select({ name: users.name }).from(users).where(eq(users.id, b.students[0])).limit(1);
    studentName = row?.name?.trim() || null;
  }
  dispatch({
    event: "SYLLABUS_APPROVAL_NEEDED",
    userId: b.teacherId,
    dedupeKey: `syl-approval:${syllabusId}:${batchKey(b.keys)}`,
    data: { syllabusId, syllabusTitle: b.syllabusTitle, count: b.students.length, studentName },
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
      const payload: UnlockPayload = {
        syllabusTitle: syllabus.title,
        studentId: e.studentId,
        enrollmentId: e.id,
        lessons: plan.lessons.map((l) => [l.id, l.title]),
        modules: plan.modules.map((m) => [m.id, m.title]),
      };
      safe("unlock", () => enqueueNotice({ key: `unlock:${e.id}`, kind: "UNLOCK", syllabusId: syllabus.id, payload }));
    }
    const fresh = plan.approvals.map((a) => `${e.id}:${a.type}:${a.id}:${decisions}`).filter((k) => !announcedApprovals.has(k));
    if (fresh.length) {
      if (announcedApprovals.size > MAX_REMEMBERED) announcedApprovals.clear();
      for (const k of fresh) announcedApprovals.add(k);
      const payload: ApprovalPayload = { syllabusTitle: syllabus.title, teacherId: syllabus.createdBy, keys: fresh, students: [e.studentId] };
      safe("approval", () => enqueueNotice({ key: `approval:${syllabus.createdBy}:${syllabus.id}`, kind: "APPROVAL", syllabusId: syllabus.id, payload }));
    }
    if (completedNow) safe("completed", () => sendCompleted(e, syllabus));
  } catch (error) {
    console.error("[syllabus] notice planning failed", error instanceof Error ? error.message : error);
  }
}
