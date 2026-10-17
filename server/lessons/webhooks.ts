import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { fileObjects, files, lessonMeetings, lessonRecords, lessonWebhookEvents, lessons, type LessonWebhookEventRow } from "../../drizzle/schema";
import { zoomRecordFileKind, type MeetingProvider, type RecordKind } from "../../shared/lessonIntegration";
import { requireDb } from "../db";
import { objectKeyFor, objectStore } from "../fileStorage/r2";

/**
 * Zoom's inbound webhooks (recording.completed and friends). Google Meet has no webhook -- it is
 * polled by the capture sweeper (captureSweeper.ts) instead. This file only turns a verified,
 * already-parsed webhook body into `lesson_records` rows; signature verification lives next to
 * the rest of the Zoom client, in providers/zoom.ts, and the Express route is webhookRoutes.ts.
 */

type ZoomRecordingFile = { id?: string; file_type?: string; download_url?: string };
export type ZoomWebhookPayload = {
  event?: string;
  event_ts?: number;
  download_token?: string;
  payload?: { object?: { id?: number | string; uuid?: string; recording_files?: ZoomRecordingFile[] }; plainToken?: string };
};

/** Idempotency: Zoom retries undelivered webhooks, so a (provider, externalId) pair is only ever recorded once. */
async function recordWebhookEvent(provider: MeetingProvider, eventType: string, externalId: string | null, lessonId: string | null, payload: unknown): Promise<LessonWebhookEventRow | null> {
  const db = requireDb();
  if (externalId) {
    const [existing] = await db
      .select()
      .from(lessonWebhookEvents)
      .where(and(eq(lessonWebhookEvents.provider, provider), eq(lessonWebhookEvents.externalId, externalId)))
      .limit(1);
    if (existing) return null; // Already received (and, per `markWebhookEvent`, already processed or in progress) -- skip reprocessing.
  }
  const [row] = await db
    .insert(lessonWebhookEvents)
    .values({ provider, eventType, externalId, lessonId, payload: payload as Record<string, unknown>, status: "RECEIVED" })
    .$returningId();
  return { id: row.id, provider, eventType, externalId, lessonId, payload: payload as Record<string, unknown>, status: "RECEIVED", error: null, receivedAt: new Date(), processedAt: null };
}

async function markWebhookEvent(id: number, status: "PROCESSED" | "FAILED" | "IGNORED", error?: string): Promise<void> {
  await requireDb()
    .update(lessonWebhookEvents)
    .set({ status, error: error ? error.slice(0, 255) : null, processedAt: new Date() })
    .where(eq(lessonWebhookEvents.id, id));
}

async function lessonForZoomMeeting(externalMeetingId: string) {
  const db = requireDb();
  const [row] = await db
    .select({ lesson: lessons, meeting: lessonMeetings })
    .from(lessonMeetings)
    .innerJoin(lessons, eq(lessons.id, lessonMeetings.lessonId))
    .where(eq(lessonMeetings.externalMeetingId, externalMeetingId))
    .limit(1);
  return row ?? null;
}

/** Upserts one `lesson_records` row per (lessonId, kind) -- a webhook retry updates the same row rather than duplicating it. */
async function upsertRecord(lessonId: string, kind: RecordKind, values: Partial<typeof lessonRecords.$inferInsert>): Promise<void> {
  const db = requireDb();
  const [existing] = await db.select().from(lessonRecords).where(and(eq(lessonRecords.lessonId, lessonId), eq(lessonRecords.kind, kind))).limit(1);
  if (existing) {
    await db.update(lessonRecords).set(values).where(eq(lessonRecords.id, existing.id));
  } else {
    await db.insert(lessonRecords).values({ id: nanoid(), lessonId, kind, sourceProvider: "ZOOM", captureStatus: "PENDING", attempts: 0, ...values });
  }
}

async function downloadZoomFileText(downloadUrl: string, downloadToken: string | undefined): Promise<string> {
  const url = downloadToken ? `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(downloadToken)}` : downloadUrl;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Zoom recording file download returned ${res.status}`);
  return res.text();
}

async function downloadZoomFileBuffer(downloadUrl: string, downloadToken: string | undefined): Promise<Buffer> {
  const url = downloadToken ? `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(downloadToken)}` : downloadUrl;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Zoom recording file download returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Streams a Zoom recording video directly into R2 (bypassing the web-upload 8 MB cap, which exists for browser uploads, not this server-to-server rescue path), or records UNAVAILABLE when no object store is configured -- MySQL is not a reasonable place for lesson-recording-sized video. */
async function captureZoomRecordingFile(lessonId: string, workspaceId: string, uploadedBy: number, file: ZoomRecordingFile, downloadToken: string | undefined): Promise<void> {
  const store = objectStore();
  if (!store || !file.download_url) {
    await upsertRecord(lessonId, "RECORDING", { captureStatus: "UNAVAILABLE", lastError: "R2 (obyekt saxlaması) tənzimlənməyib, video qeydi götürülə bilmədi" });
    return;
  }
  try {
    const buffer = await downloadZoomFileBuffer(file.download_url, downloadToken);
    const fileId = nanoid();
    const fileName = `zoom-recording-${file.id ?? fileId}.mp4`;
    const objectKey = objectKeyFor({ id: fileId, workspaceId, fileName });
    await store.put(objectKey, buffer, "video/mp4");
    const db = requireDb();
    await db.transaction(async (tx) => {
      await tx.insert(files).values({ id: fileId, workspaceId, uploadedBy, fileName, mimeType: "video/mp4", sizeBytes: buffer.byteLength, isPublic: false, dataBase64: "" });
      await tx.insert(fileObjects).values({ fileId, backend: store.backend, bucket: store.bucket, objectKey, sizeBytes: buffer.byteLength });
    });
    await upsertRecord(lessonId, "RECORDING", { captureStatus: "CAPTURED", fileId, capturedAt: new Date(), lastError: null });
  } catch (error) {
    await upsertRecord(lessonId, "RECORDING", { captureStatus: "FAILED", lastError: (error instanceof Error ? error.message : String(error)).slice(0, 255) });
  }
}

async function captureZoomTextFile(lessonId: string, kind: RecordKind, file: ZoomRecordingFile, downloadToken: string | undefined): Promise<void> {
  if (!file.download_url) {
    await upsertRecord(lessonId, kind, { captureStatus: "UNAVAILABLE", lastError: "Zoom bu fayl üçün yükləmə linki vermədi" });
    return;
  }
  try {
    const text = await downloadZoomFileText(file.download_url, downloadToken);
    await upsertRecord(lessonId, kind, { captureStatus: "CAPTURED", textContent: text, capturedAt: new Date(), lastError: null });
  } catch (error) {
    await upsertRecord(lessonId, kind, { captureStatus: "FAILED", lastError: (error instanceof Error ? error.message : String(error)).slice(0, 255) });
  }
}

/**
 * Processes one already-signature-verified Zoom webhook body. Never throws: every failure is
 * recorded on the webhook-event row (and, where a lesson was identified, on the relevant
 * `lesson_records` row) so a bad delivery can be seen and retried rather than crashing the route.
 */
export async function processZoomWebhook(payload: ZoomWebhookPayload): Promise<void> {
  const eventType = payload.event ?? "unknown";
  const object = payload.payload?.object;
  const externalId = object?.uuid ?? (object?.id !== undefined ? String(object.id) : null) ?? (payload.event_ts ? `${eventType}:${payload.event_ts}` : null);
  const recorded = await recordWebhookEvent("ZOOM", eventType, externalId, null, payload);
  if (!recorded) return; // Duplicate delivery of something already recorded.

  if (eventType !== "recording.completed" || !object?.id) {
    await markWebhookEvent(recorded.id, "IGNORED");
    return;
  }

  try {
    const found = await lessonForZoomMeeting(String(object.id));
    if (!found) {
      await markWebhookEvent(recorded.id, "FAILED", `No lesson found for Zoom meeting ${object.id}`);
      return;
    }
    const { lesson } = found;
    for (const file of object.recording_files ?? []) {
      const kind = zoomRecordFileKind(file.file_type ?? "");
      if (!kind) continue;
      if (kind === "RECORDING") await captureZoomRecordingFile(lesson.id, lesson.workspaceId, lesson.createdBy, file, payload.download_token);
      else await captureZoomTextFile(lesson.id, kind, file, payload.download_token);
    }
    await markWebhookEvent(recorded.id, "PROCESSED");
  } catch (error) {
    await markWebhookEvent(recorded.id, "FAILED", error instanceof Error ? error.message : String(error));
  }
}
