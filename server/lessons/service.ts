import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  groupMembers,
  lessonAttendance,
  lessonConsentAcks,
  lessonMeetings,
  lessonNotes,
  lessonRecords,
  lessons,
  lessonSeries,
  type LessonMeetingRow,
  type LessonRow,
} from "../../drizzle/schema";
import { occurrenceStarts, type LessonNoteInput, type LessonSeriesInput } from "../../shared/lessonIntegration";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { lessonReachesStudent, lessonRosterStudentIds } from "./access";
import { createMeetingForLesson } from "./meetings";
import { notifyLessonScheduled } from "./notifications";
import { connectionOf } from "./tokenStore";

export type LessonWithMeeting = LessonRow & { meeting: LessonMeetingRow | null };

/** Active student members of these groups, de-duplicated with the individually picked student ids. */
async function rosterFor(groupIds: string[], studentIds: number[]): Promise<number[]> {
  if (!groupIds.length) return lessonRosterStudentIds([], studentIds);
  const members = await requireDb()
    .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(inArray(groupMembers.groupId, groupIds), eq(groupMembers.status, "ACTIVE")));
  return lessonRosterStudentIds(members.map((m) => m.userId), studentIds);
}

/**
 * Creates a lesson series and generates one `lessons` row per occurrence (capped, see
 * `occurrenceStarts`), then best-effort creates the external meeting for each occurrence and
 * notifies the roster. A missing/inactive provider connection never blocks the save -- the
 * lesson is created SCHEDULED without a meeting, and the teacher sees "needs connection" until
 * they connect the provider and the sweeper (or a manual retry) picks it up.
 */
export async function createSeries(scope: TeacherScope, input: LessonSeriesInput): Promise<LessonWithMeeting[]> {
  const db = requireDb();
  const seriesId = nanoid();
  const endsAt = new Date(input.startsAt.getTime() + input.durationMinutes * 60_000);
  const duration = endsAt.getTime() - input.startsAt.getTime();
  await db.insert(lessonSeries).values({
    id: seriesId,
    workspaceId: scope.workspaceId,
    createdBy: scope.userId,
    title: input.title,
    groupIds: input.groupIds,
    studentIds: input.studentIds,
    platform: input.platform,
    recurrence: input.recurrence,
    recurrenceUntil: input.recurrenceUntil ?? null,
    durationMinutes: input.durationMinutes,
    timezone: input.timezone,
    joinWindowBeforeMin: input.joinWindowBeforeMin,
    joinWindowAfterMin: input.joinWindowAfterMin,
  });

  const starts = occurrenceStarts(input.startsAt, input.recurrence, input.recurrenceUntil ?? null);
  const rows = starts.map((startsAt) => ({
    id: nanoid(),
    seriesId,
    workspaceId: scope.workspaceId,
    createdBy: scope.userId,
    title: input.title,
    groupIds: input.groupIds,
    studentIds: input.studentIds,
    platform: input.platform,
    startsAt,
    endsAt: new Date(startsAt.getTime() + duration),
    joinWindowBeforeMin: input.joinWindowBeforeMin,
    joinWindowAfterMin: input.joinWindowAfterMin,
  }));
  if (rows.length) await db.insert(lessons).values(rows);

  const connection = await connectionOf(scope.userId, input.platform);
  if (connection && connection.status === "ACTIVE") {
    for (const row of rows) await createMeetingForLesson(row, connection);
  }

  const roster = await rosterFor(input.groupIds, input.studentIds);
  if (rows[0]) await notifyLessonScheduled(roster.filter((id) => id !== scope.userId), rows[0].id, rows[0].title, rows[0].startsAt);

  return lessonsWithMeetings(rows.map((r) => r.id));
}

async function lessonsWithMeetings(ids: string[]): Promise<LessonWithMeeting[]> {
  if (!ids.length) return [];
  const db = requireDb();
  const rows = await db.select().from(lessons).where(inArray(lessons.id, ids));
  const meetings = await db.select().from(lessonMeetings).where(inArray(lessonMeetings.lessonId, ids));
  const byLesson = new Map(meetings.map((m) => [m.lessonId, m]));
  return rows.map((r) => ({ ...r, meeting: byLesson.get(r.id) ?? null }));
}

export async function listForWorkspace(scope: TeacherScope): Promise<LessonWithMeeting[]> {
  const db = requireDb();
  const rows = await db.select().from(lessons).where(eq(lessons.workspaceId, scope.workspaceId)).orderBy(lessons.startsAt);
  return lessonsWithMeetings(rows.map((r) => r.id)).then((withMeeting) => {
    // lessonsWithMeetings re-queries `lessons`; reuse its row order (startsAt) rather than the inArray result's.
    const byId = new Map(withMeeting.map((r) => [r.id, r]));
    return rows.map((r) => byId.get(r.id)!);
  });
}

async function lessonOrThrow(scope: TeacherScope, lessonId: string): Promise<LessonRow> {
  const [row] = await requireDb()
    .select()
    .from(lessons)
    .where(and(eq(lessons.id, lessonId), eq(lessons.workspaceId, scope.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

export async function lessonDetail(scope: TeacherScope, lessonId: string) {
  const lesson = await lessonOrThrow(scope, lessonId);
  const db = requireDb();
  const [meeting] = await db.select().from(lessonMeetings).where(eq(lessonMeetings.lessonId, lessonId)).limit(1);
  const notes = await db.select().from(lessonNotes).where(eq(lessonNotes.lessonId, lessonId)).orderBy(lessonNotes.createdAt);
  const records = await db.select().from(lessonRecords).where(eq(lessonRecords.lessonId, lessonId));
  const attendance = await db.select().from(lessonAttendance).where(eq(lessonAttendance.lessonId, lessonId));
  return { lesson, meeting: meeting ?? null, notes, records, attendance };
}

export async function cancelLesson(scope: TeacherScope, lessonId: string): Promise<void> {
  await lessonOrThrow(scope, lessonId);
  await requireDb().update(lessons).set({ status: "CANCELLED" }).where(eq(lessons.id, lessonId));
}

/** Manual retry for a lesson whose meeting failed (or is still pending because the provider wasn't connected yet when it was created). */
export async function retryMeeting(scope: TeacherScope, lessonId: string): Promise<void> {
  const lesson = await lessonOrThrow(scope, lessonId);
  const connection = await connectionOf(scope.userId, lesson.platform);
  if (!connection || connection.status !== "ACTIVE") throw new AppError("NOT_FOUND");
  await createMeetingForLesson(lesson, connection);
}

// ---------------------------------------------------------------------------
// Student side
// ---------------------------------------------------------------------------

/** Lessons reaching this student (by group membership or direct targeting), across every workspace. Mirrors tasks.studentAssignments. */
export async function studentLessons(studentId: number, studentGroupIds: string[]): Promise<LessonWithMeeting[]> {
  const rows = await requireDb().select().from(lessons).orderBy(lessons.startsAt);
  const relevant = rows.filter((l) => lessonReachesStudent(l, studentId, studentGroupIds));
  return lessonsWithMeetings(relevant.map((r) => r.id)).then((withMeeting) => {
    const byId = new Map(withMeeting.map((r) => [r.id, r]));
    return relevant.map((r) => byId.get(r.id)!);
  });
}

export async function studentLessonDetail(studentId: number, studentGroupIds: string[], lessonId: string) {
  const [lesson] = await requireDb().select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lesson || !lessonReachesStudent(lesson, studentId, studentGroupIds)) throw new AppError("NOT_FOUND");
  const db = requireDb();
  const [meeting] = await db.select().from(lessonMeetings).where(eq(lessonMeetings.lessonId, lessonId)).limit(1);
  // The teacher's SHARED notes (visible to the whole class), plus this student's own -- never another student's note.
  const all = await db.select().from(lessonNotes).where(eq(lessonNotes.lessonId, lessonId)).orderBy(lessonNotes.createdAt);
  const notes = all.filter((n) => n.authorId === studentId || (n.visibility === "SHARED" && n.authorId === lesson.createdBy));
  const records = await db.select().from(lessonRecords).where(eq(lessonRecords.lessonId, lessonId));
  const consentAcked = await hasAckedConsent(studentId, lessonId);
  return { lesson, meeting: meeting ?? null, notes, records, consentAcked };
}

// ---------------------------------------------------------------------------
// Notes (Dərs Qeydləri) -- either side, scoped to a lesson they can actually see
// ---------------------------------------------------------------------------

export async function addTeacherNote(scope: TeacherScope, input: LessonNoteInput): Promise<void> {
  await lessonOrThrow(scope, input.lessonId);
  await requireDb()
    .insert(lessonNotes)
    .values({ id: nanoid(), lessonId: input.lessonId, authorId: scope.userId, body: input.body, visibility: input.visibility });
}

export async function addStudentNote(studentId: number, studentGroupIds: string[], input: Omit<LessonNoteInput, "visibility">): Promise<void> {
  const [lesson] = await requireDb().select().from(lessons).where(eq(lessons.id, input.lessonId)).limit(1);
  if (!lesson || !lessonReachesStudent(lesson, studentId, studentGroupIds)) throw new AppError("NOT_FOUND");
  // Stored as SHARED so the teacher (who always sees every note) sees it; studentLessonDetail's own
  // filter is what actually keeps one student's note from showing up to classmates, not this flag.
  await requireDb()
    .insert(lessonNotes)
    .values({ id: nanoid(), lessonId: input.lessonId, authorId: studentId, body: input.body, visibility: "SHARED" });
}

/** GDPR: records that this participant acknowledged the recording notice before joining. Idempotent (re-acking just no-ops). */
export async function ackRecordingConsent(userId: number, lessonId: string): Promise<void> {
  await requireDb()
    .insert(lessonConsentAcks)
    .values({ id: nanoid(), lessonId, userId, kind: "RECORDING_NOTICE" })
    .onDuplicateKeyUpdate({ set: { ackedAt: new Date() } });
}

export async function hasAckedConsent(userId: number, lessonId: string): Promise<boolean> {
  const [row] = await requireDb()
    .select({ id: lessonConsentAcks.id })
    .from(lessonConsentAcks)
    .where(and(eq(lessonConsentAcks.lessonId, lessonId), eq(lessonConsentAcks.userId, userId)))
    .limit(1);
  return !!row;
}
