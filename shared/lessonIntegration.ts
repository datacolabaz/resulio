import { z } from "zod";

/**
 * Online Dərs və Qeyd İnteqrasiyası (online lesson + recording integration): a teacher connects
 * their Google Meet or Zoom account, schedules lessons for a group and/or individual students,
 * Resulio creates the meeting on that provider and gates the join link to recipients within a
 * time window, and -- the point of the feature -- the transcript/recording/AI summary is copied
 * into Resulio's own storage before the provider's own retention window expires (Google Meet
 * deletes transcript docs after 30 days). Types, zod input schemas and pure helpers live here so
 * client and server agree on them; DB-aware access rules live in server/lessons/access.ts, next
 * to the other *Access.ts modules (mirrors server/modules/taskAccess.ts).
 */

export const MEETING_PROVIDERS = ["GOOGLE_MEET", "ZOOM"] as const;
export type MeetingProvider = (typeof MEETING_PROVIDERS)[number];

export const CONNECTION_STATUSES = ["ACTIVE", "ERROR", "REVOKED"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const LESSON_RECURRENCES = ["ONCE", "WEEKLY", "BIWEEKLY"] as const;
export type LessonRecurrence = (typeof LESSON_RECURRENCES)[number];

export const LESSON_STATUSES = ["SCHEDULED", "LIVE", "ENDED", "CANCELLED"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export const MEETING_CREATION_STATUSES = ["PENDING", "CREATED", "FAILED"] as const;
export type MeetingCreationStatus = (typeof MEETING_CREATION_STATUSES)[number];

export const ATTENDANCE_SOURCES = ["JOIN_LINK", "PROVIDER_REPORT"] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

export const RECORD_KINDS = ["TRANSCRIPT", "RECORDING", "AI_SUMMARY", "CHAT_LOG"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const RECORD_CAPTURE_STATUSES = ["PENDING", "CAPTURED", "FAILED", "UNAVAILABLE"] as const;
export type RecordCaptureStatus = (typeof RECORD_CAPTURE_STATUSES)[number];

export const WEBHOOK_EVENT_STATUSES = ["RECEIVED", "PROCESSED", "FAILED", "IGNORED"] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export const CONSENT_KINDS = ["RECORDING_NOTICE"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** Minutes before `startsAt` / after `endsAt` that a recipient's join link is valid. */
export const DEFAULT_JOIN_WINDOW_BEFORE_MIN = 10;
export const DEFAULT_JOIN_WINDOW_AFTER_MIN = 30;

/** Provider transcript/recording retention Resulio must beat (Google Meet's own 30-day deletion). */
export const GOOGLE_MEET_RETENTION_DAYS = 30;

// ---------------------------------------------------------------------------
// Input schemas (shared between the tRPC router and any client-side form validation)
// ---------------------------------------------------------------------------

export const lessonSeriesInput = z.object({
  title: z.string().trim().min(1).max(255),
  groupIds: z.array(z.string().trim().min(1).max(32)).max(100),
  studentIds: z.array(z.number().int().positive()).max(500),
  platform: z.enum(MEETING_PROVIDERS),
  recurrence: z.enum(LESSON_RECURRENCES),
  /** First occurrence's start. Required even for ONCE. */
  startsAt: z.coerce.date(),
  durationMinutes: z.number().int().min(5).max(480),
  /** Required for WEEKLY/BIWEEKLY; ignored for ONCE. */
  recurrenceUntil: z.coerce.date().nullable().optional(),
  timezone: z.string().trim().min(1).max(64).default("Asia/Baku"),
  joinWindowBeforeMin: z.number().int().min(0).max(120).default(DEFAULT_JOIN_WINDOW_BEFORE_MIN),
  joinWindowAfterMin: z.number().int().min(0).max(240).default(DEFAULT_JOIN_WINDOW_AFTER_MIN),
});
export type LessonSeriesInput = z.infer<typeof lessonSeriesInput>;

/** Edits a single lesson occurrence (not the whole series) -- title, platform and timing only; recipients/recurrence stay as created. */
export const lessonUpdateInput = z.object({
  lessonId: z.string().trim().min(1).max(32),
  title: z.string().trim().min(1).max(255),
  platform: z.enum(MEETING_PROVIDERS),
  startsAt: z.coerce.date(),
  durationMinutes: z.number().int().min(5).max(480),
});
export type LessonUpdateInput = z.infer<typeof lessonUpdateInput>;

export const lessonNoteInput = z.object({
  lessonId: z.string().trim().min(1).max(32),
  body: z.string().trim().min(1).max(10_000),
  visibility: z.enum(["TEACHER_ONLY", "SHARED"]).default("SHARED"),
});
export type LessonNoteInput = z.infer<typeof lessonNoteInput>;

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no I/O -- unit-testable and shared by client + server)
// ---------------------------------------------------------------------------

/**
 * Must a recurring series carry an end date? ONCE never does; WEEKLY/BIWEEKLY always must, so a
 * sweeper never generates occurrences forever.
 */
export function recurrenceNeedsUntil(recurrence: LessonRecurrence): boolean {
  return recurrence !== "ONCE";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Occurrence start times for a series, inclusive of `startsAt`, up to (and not past) `until`. */
export function occurrenceStarts(startsAt: Date, recurrence: LessonRecurrence, until: Date | null, limit = 200): Date[] {
  if (recurrence === "ONCE" || !until) return [startsAt];
  const stepDays = recurrence === "WEEKLY" ? 7 : 14;
  const out: Date[] = [];
  let t = startsAt.getTime();
  const untilMs = until.getTime();
  while (t <= untilMs && out.length < limit) {
    out.push(new Date(t));
    t += stepDays * DAY_MS;
  }
  return out;
}

/**
 * Whether a recipient's join link should work right now: open `joinWindowBeforeMin` minutes
 * before the lesson starts, closed `joinWindowAfterMin` minutes after it ends. Cancelled lessons
 * never open. This is the single gate every join-link code path must apply identically (the
 * student page, the redirect route, and any API that reveals the provider's raw meeting URL).
 */
export function withinJoinWindow(
  lesson: { startsAt: Date; endsAt: Date; status: LessonStatus; joinWindowBeforeMin: number; joinWindowAfterMin: number },
  now: Date,
): boolean {
  if (lesson.status === "CANCELLED") return false;
  const opensAt = lesson.startsAt.getTime() - lesson.joinWindowBeforeMin * 60_000;
  const closesAt = lesson.endsAt.getTime() + lesson.joinWindowAfterMin * 60_000;
  const t = now.getTime();
  return t >= opensAt && t <= closesAt;
}

/** The lesson's live/ended/scheduled status derived from the clock, independent of any stored status column. */
export function derivedLessonStatus(lesson: { startsAt: Date; endsAt: Date }, now: Date): "SCHEDULED" | "LIVE" | "ENDED" {
  if (now < lesson.startsAt) return "SCHEDULED";
  if (now > lesson.endsAt) return "ENDED";
  return "LIVE";
}

/**
 * How urgently a captured record must be rescued, in days until the source provider deletes its
 * own copy. Only meaningful for Google Meet, whose transcripts/recordings purge after
 * GOOGLE_MEET_RETENTION_DAYS; Zoom's cloud recordings are governed by the account's own retention
 * policy and are not time-boxed here.
 */
export function daysUntilProviderDeletion(provider: MeetingProvider, lessonEndedAt: Date, now: Date): number | null {
  if (provider !== "GOOGLE_MEET") return null;
  const deadline = lessonEndedAt.getTime() + GOOGLE_MEET_RETENTION_DAYS * DAY_MS;
  return Math.ceil((deadline - now.getTime()) / DAY_MS);
}

/** Has Google Meet's own 30-day window already closed? Zoom is never time-boxed here (see `daysUntilProviderDeletion`). */
export function recordingRetentionExpired(provider: MeetingProvider, lessonEndedAt: Date, now: Date): boolean {
  const days = daysUntilProviderDeletion(provider, lessonEndedAt, now);
  return days !== null && days < 0;
}

/**
 * Zoom's `recording_files[].file_type` → the `RecordKind` Resulio rescues it as, or null for a
 * file type that isn't worth keeping a copy of (closed captions, the raw per-second timeline
 * JSON, audio-only when the video track is already captured separately).
 */
export function zoomRecordFileKind(fileType: string): RecordKind | null {
  switch (fileType.toUpperCase()) {
    case "MP4":
      return "RECORDING";
    case "TRANSCRIPT":
      return "TRANSCRIPT";
    case "CHAT":
      return "CHAT_LOG";
    case "SUMMARY":
      return "AI_SUMMARY";
    default:
      return null;
  }
}
