import { and, eq, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { lessonMeetings, lessonRecords, lessons, type LessonMeetingRow, type LessonRow } from "../../drizzle/schema";
import { GOOGLE_MEET_RETENTION_DAYS, recordingRetentionExpired } from "../../shared/lessonIntegration";
import { getDb, requireDb } from "../db";
import { findGoogleMeetConferenceRecord, fetchGoogleMeetTranscriptText, listGoogleMeetTranscripts } from "./providers/googleMeet";
import { validAccessToken } from "./meetings";
import { connectionOf } from "./tokenStore";

/**
 * Rescues the Google Meet transcript before Google's own 30-day deletion (docs/LESSON-INTEGRATION.md).
 * Zoom needs no equivalent sweeper -- its recordings arrive via the `recording.completed` webhook
 * (webhooks.ts) as soon as Zoom finishes processing them.
 *
 * Two passes, run on the same interval: (1) every ended Google Meet lesson gets a PENDING
 * `lesson_records` placeholder the first time this runs after it ends, and (2) every PENDING
 * placeholder is retried against the Meet API until it is CAPTURED or, once the 30-day window has
 * closed, marked UNAVAILABLE so nobody mistakes silence for success.
 */
const SWEEP_INTERVAL_MS = 30 * 60_000;
/** Google Meet's `conferenceRecords`/`transcripts` resources only exist once Meet has finished processing the call -- usually within minutes, but this cushions a slow day. */
const PROCESSING_GRACE_MS = 15 * 60_000;

async function endedGoogleMeetLessonsMissingRecord(): Promise<(LessonRow & { meeting: LessonMeetingRow })[]> {
  const db = requireDb();
  const now = new Date();
  const rows = await db
    .select({ lesson: lessons, meeting: lessonMeetings })
    .from(lessons)
    .innerJoin(lessonMeetings, eq(lessonMeetings.lessonId, lessons.id))
    .where(and(eq(lessons.platform, "GOOGLE_MEET"), eq(lessonMeetings.status, "CREATED"), lt(lessons.endsAt, new Date(now.getTime() - PROCESSING_GRACE_MS))));
  if (rows.length === 0) return [];
  const existing = new Set((await db.select({ lessonId: lessonRecords.lessonId }).from(lessonRecords).where(eq(lessonRecords.kind, "TRANSCRIPT"))).map((r) => r.lessonId));
  return rows.filter((r) => !existing.has(r.lesson.id)).map((r) => ({ ...r.lesson, meeting: r.meeting }));
}

/** Creates the PENDING transcript placeholder for every ended Google Meet lesson that doesn't have one yet. */
export async function ensurePendingTranscriptRecords(): Promise<void> {
  const missing = await endedGoogleMeetLessonsMissingRecord();
  if (missing.length === 0) return;
  const db = requireDb();
  await db.insert(lessonRecords).values(
    missing.map((lesson) => ({
      id: nanoid(),
      lessonId: lesson.id,
      kind: "TRANSCRIPT" as const,
      sourceProvider: "GOOGLE_MEET" as const,
      captureStatus: "PENDING" as const,
      providerExpiresAt: new Date(lesson.endsAt.getTime() + GOOGLE_MEET_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      attempts: 0,
    })),
  );
}

async function pendingGoogleMeetTranscripts() {
  const db = requireDb();
  return db
    .select({ record: lessonRecords, lesson: lessons, meeting: lessonMeetings })
    .from(lessonRecords)
    .innerJoin(lessons, eq(lessons.id, lessonRecords.lessonId))
    .innerJoin(lessonMeetings, eq(lessonMeetings.lessonId, lessons.id))
    .where(and(eq(lessonRecords.kind, "TRANSCRIPT"), eq(lessonRecords.sourceProvider, "GOOGLE_MEET"), eq(lessonRecords.captureStatus, "PENDING"), isNull(lessonRecords.capturedAt)));
}

/** One retry attempt for every PENDING Google Meet transcript. Never throws -- every outcome lands on the row itself. */
export async function captureGoogleMeetTranscripts(): Promise<void> {
  const pending = await pendingGoogleMeetTranscripts();
  const db = requireDb();
  for (const { record, lesson, meeting } of pending) {
    const expired = record.providerExpiresAt ? recordingRetentionExpired("GOOGLE_MEET", new Date(lesson.endsAt), new Date()) : false;
    try {
      const connection = await connectionOf(lesson.createdBy, "GOOGLE_MEET");
      if (!connection || connection.status !== "ACTIVE") throw new Error("Müəllimin Google Meet qoşulması aktiv deyil");
      const accessToken = await validAccessToken(connection);
      const conferenceRecord = meeting.externalMeetingId ? await findGoogleMeetConferenceRecord(accessToken, meeting.externalMeetingId) : null;
      if (!conferenceRecord) throw new Error("Google Meet görüş qeydi hələ tapılmadı");
      const transcripts = await listGoogleMeetTranscripts(accessToken, conferenceRecord.name);
      const ready = transcripts.find((t) => t.state === "FILE_GENERATED");
      if (!ready) throw new Error("Transkript hələ hazır deyil");
      const text = await fetchGoogleMeetTranscriptText(accessToken, ready.name);
      await db.update(lessonRecords).set({ captureStatus: "CAPTURED", textContent: text, capturedAt: new Date(), lastError: null, attempts: record.attempts + 1 }).where(eq(lessonRecords.id, record.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(lessonRecords)
        .set({ captureStatus: expired ? "UNAVAILABLE" : "PENDING", lastError: message.slice(0, 255), attempts: record.attempts + 1 })
        .where(eq(lessonRecords.id, record.id));
    }
  }
}

export function startLessonCaptureSweeper(): void {
  if (!getDb()) return;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await ensurePendingTranscriptRecords();
      await captureGoogleMeetTranscripts();
    } catch (error) {
      console.error("[Lessons] Capture sweep failed", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  }, SWEEP_INTERVAL_MS).unref();
}
