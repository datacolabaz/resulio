import { bigint, boolean, index, int, json, longtext, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import {
  ATTENDANCE_SOURCES,
  CONNECTION_STATUSES,
  CONSENT_KINDS,
  LESSON_RECURRENCES,
  LESSON_STATUSES,
  MEETING_CREATION_STATUSES,
  MEETING_PROVIDERS,
  RECORD_CAPTURE_STATUSES,
  RECORD_KINDS,
  WEBHOOK_EVENT_STATUSES,
} from "../shared/lessonIntegration";

/**
 * Online Dərs və Qeyd İnteqrasiyası (docs/LESSON-INTEGRATION.md). Side tables only, like
 * mcpSchema.ts: nothing here is read by the Teacher → Group → Exam model. `lessons` carries its
 * recipients as `groupIds`/`studentIds` JSON columns directly on the row, the same convention
 * `tasks` uses, rather than a separate join table.
 */

const ID = 32;
const id = (name: string) => varchar(name, { length: ID });

/** One OAuth connection per teacher per provider. Tokens are stored encrypted (server/lessons/tokenStore.ts), never in the clear. */
export const teacherMeetingConnections = mysqlTable(
  "teacher_meeting_connections",
  {
    id: id("id").primaryKey(),
    workspaceId: id("workspaceId").notNull(),
    userId: int("userId").notNull(),
    provider: mysqlEnum("provider", MEETING_PROVIDERS).notNull(),
    status: mysqlEnum("status", CONNECTION_STATUSES).notNull().default("ACTIVE"),
    externalAccountId: varchar("externalAccountId", { length: 191 }),
    accountEmail: varchar("accountEmail", { length: 255 }),
    scope: varchar("scope", { length: 255 }),
    accessTokenCipher: text("accessTokenCipher").notNull(),
    refreshTokenCipher: text("refreshTokenCipher"),
    tokenExpiresAt: timestamp("tokenExpiresAt"),
    lastError: varchar("lastError", { length: 255 }),
    connectedAt: timestamp("connectedAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [uniqueIndex("teacher_meeting_connections_user_provider_unique").on(t.userId, t.provider), index("teacher_meeting_connections_workspace_idx").on(t.workspaceId)],
);

/** The recurring parent a lesson belongs to; a one-off lesson still gets a series of its own (recurrence "ONCE"). */
export const lessonSeries = mysqlTable(
  "lesson_series",
  {
    id: id("id").primaryKey(),
    workspaceId: id("workspaceId").notNull(),
    createdBy: int("createdBy").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    groupIds: json("groupIds").$type<string[]>().notNull(),
    studentIds: json("studentIds").$type<number[]>().notNull(),
    platform: mysqlEnum("platform", MEETING_PROVIDERS).notNull(),
    recurrence: mysqlEnum("recurrence", LESSON_RECURRENCES).notNull(),
    recurrenceUntil: timestamp("recurrenceUntil"),
    durationMinutes: int("durationMinutes").notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    joinWindowBeforeMin: int("joinWindowBeforeMin").notNull(),
    joinWindowAfterMin: int("joinWindowAfterMin").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("lesson_series_workspace_idx").on(t.workspaceId)],
);

/** One scheduled occurrence. `groupIds`/`studentIds` are copied from the series at generation time, as `tasks` does. */
export const lessons = mysqlTable(
  "lessons",
  {
    id: id("id").primaryKey(),
    seriesId: id("seriesId").notNull(),
    workspaceId: id("workspaceId").notNull(),
    createdBy: int("createdBy").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    groupIds: json("groupIds").$type<string[]>().notNull(),
    studentIds: json("studentIds").$type<number[]>().notNull(),
    platform: mysqlEnum("platform", MEETING_PROVIDERS).notNull(),
    startsAt: timestamp("startsAt").notNull(),
    endsAt: timestamp("endsAt").notNull(),
    status: mysqlEnum("status", LESSON_STATUSES).notNull().default("SCHEDULED"),
    joinWindowBeforeMin: int("joinWindowBeforeMin").notNull(),
    joinWindowAfterMin: int("joinWindowAfterMin").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("lessons_workspace_startsAt_idx").on(t.workspaceId, t.startsAt), index("lessons_series_idx").on(t.seriesId)],
);

/** The external meeting created on the provider for one lesson occurrence. 1:1 with `lessons`, like `fileObjects` is to `files`. */
export const lessonMeetings = mysqlTable(
  "lesson_meetings",
  {
    lessonId: id("lessonId").primaryKey(),
    connectionId: id("connectionId").notNull(),
    provider: mysqlEnum("provider", MEETING_PROVIDERS).notNull(),
    status: mysqlEnum("status", MEETING_CREATION_STATUSES).notNull().default("PENDING"),
    externalMeetingId: varchar("externalMeetingId", { length: 191 }),
    /** The provider's raw join URL. Never sent to students directly -- they always go through Resulio's gated join route. */
    joinUrl: varchar("joinUrl", { length: 1024 }),
    hostUrl: varchar("hostUrl", { length: 1024 }),
    passcode: varchar("passcode", { length: 32 }),
    providerCalendarEventId: varchar("providerCalendarEventId", { length: 191 }),
    lastError: varchar("lastError", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("lesson_meetings_connection_idx").on(t.connectionId)],
);

/** Who actually joined, from the gated join route and (when the provider reports it) its own attendance report. */
export const lessonAttendance = mysqlTable(
  "lesson_attendance",
  {
    id: id("id").primaryKey(),
    lessonId: id("lessonId").notNull(),
    userId: int("userId").notNull(),
    joinedAt: timestamp("joinedAt"),
    leftAt: timestamp("leftAt"),
    durationSec: int("durationSec"),
    source: mysqlEnum("source", ATTENDANCE_SOURCES).notNull().default("JOIN_LINK"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("lesson_attendance_lesson_user_unique").on(t.lessonId, t.userId)],
);

/**
 * The rescued artifact itself -- the whole point of the module: a copy that outlives the
 * provider's own retention window. `textContent` holds transcript/summary/chat text inline;
 * `fileId` points into the existing `files`/`fileObjects` storage for a recording's binary.
 */
export const lessonRecords = mysqlTable(
  "lesson_records",
  {
    id: id("id").primaryKey(),
    lessonId: id("lessonId").notNull(),
    kind: mysqlEnum("kind", RECORD_KINDS).notNull(),
    sourceProvider: mysqlEnum("sourceProvider", MEETING_PROVIDERS).notNull(),
    captureStatus: mysqlEnum("captureStatus", RECORD_CAPTURE_STATUSES).notNull().default("PENDING"),
    fileId: id("fileId"),
    textContent: longtext("textContent"),
    durationSec: int("durationSec"),
    /** When the provider's own copy would have expired (Google Meet: 30 days after the lesson). Null when not time-boxed. */
    providerExpiresAt: timestamp("providerExpiresAt"),
    capturedAt: timestamp("capturedAt"),
    lastError: varchar("lastError", { length: 255 }),
    attempts: int("attempts").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("lesson_records_lesson_kind_idx").on(t.lessonId, t.kind)],
);

/** Freeform teacher/student notes against a lesson (the "Dərs Qeydləri" pages). */
export const lessonNotes = mysqlTable(
  "lesson_notes",
  {
    id: id("id").primaryKey(),
    lessonId: id("lessonId").notNull(),
    authorId: int("authorId").notNull(),
    body: text("body").notNull(),
    visibility: varchar("visibility", { length: 16 }).notNull().default("SHARED"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("lesson_notes_lesson_idx").on(t.lessonId)],
);

/** Raw inbound provider webhooks (Zoom; Google Meet has none and is polled instead), kept for replay and audit. */
export const lessonWebhookEvents = mysqlTable(
  "lesson_webhook_events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    provider: mysqlEnum("provider", MEETING_PROVIDERS).notNull(),
    eventType: varchar("eventType", { length: 64 }).notNull(),
    externalId: varchar("externalId", { length: 191 }),
    lessonId: id("lessonId"),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    status: mysqlEnum("status", WEBHOOK_EVENT_STATUSES).notNull().default("RECEIVED"),
    error: varchar("error", { length: 255 }),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    processedAt: timestamp("processedAt"),
  },
  (t) => [uniqueIndex("lesson_webhook_events_provider_external_unique").on(t.provider, t.externalId), index("lesson_webhook_events_lesson_idx").on(t.lessonId)],
);

/** GDPR: one row per participant who acknowledged the recording notice for a lesson. */
export const lessonConsentAcks = mysqlTable(
  "lesson_consent_acks",
  {
    id: id("id").primaryKey(),
    lessonId: id("lessonId").notNull(),
    userId: int("userId").notNull(),
    kind: mysqlEnum("kind", CONSENT_KINDS).notNull().default("RECORDING_NOTICE"),
    ackedAt: timestamp("ackedAt").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("lesson_consent_acks_lesson_user_kind_unique").on(t.lessonId, t.userId, t.kind)],
);

export type TeacherMeetingConnectionRow = typeof teacherMeetingConnections.$inferSelect;
export type LessonSeriesRow = typeof lessonSeries.$inferSelect;
export type LessonRow = typeof lessons.$inferSelect;
export type LessonMeetingRow = typeof lessonMeetings.$inferSelect;
export type LessonAttendanceRow = typeof lessonAttendance.$inferSelect;
export type LessonRecordRow = typeof lessonRecords.$inferSelect;
export type LessonNoteRow = typeof lessonNotes.$inferSelect;
export type LessonWebhookEventRow = typeof lessonWebhookEvents.$inferSelect;
export type LessonConsentAckRow = typeof lessonConsentAcks.$inferSelect;
