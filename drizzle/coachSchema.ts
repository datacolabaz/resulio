import { bigint, boolean, index, int, json, mediumtext, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import type {
  ArtifactContent,
  ArtifactKind,
  ChunkMethod,
  CoachEventType,
  CoachLocale,
  CoachMaterialStatus,
  MaterialError,
  MaterialGoal,
  MaterialSource,
  RecallMode,
} from "../shared/coach";

/**
 * AI Study Coach side tables (docs/STUDY-COACH.md). Student-private: no teacher table is read for
 * writing here and none of these feed teacher analytics. Every constraint and index name is set
 * or checked to stay within MySQL's 64 characters.
 */

const id = (name: string) => varchar(name, { length: 32 });

/** Per-student coach preferences and the privacy notice acceptance. No row = not accepted yet, defaults. */
export const coachSettings = mysqlTable("coach_settings", {
  studentId: int("studentId").primaryKey(),
  /** How often the tutor may bring back a past mistake. */
  recallMode: varchar("recallMode", { length: 8 }).$type<RecallMode>().default("NORMAL").notNull(),
  reminders: boolean("reminders").default(true).notNull(),
  /** When the student accepted the privacy notice; coach AI stays closed until then. */
  consentAt: timestamp("consentAt"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Light funnel for the coach metrics and the per-day feature caps. Append-only; removed with the student's data. */
export const coachEvents = mysqlTable(
  "coach_events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    studentId: int("studentId").notNull(),
    type: varchar("type", { length: 24 }).$type<CoachEventType>().notNull(),
    refId: id("refId"),
    meta: json("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("coach_events_student_idx").on(t.studentId, t.type, t.createdAt)],
);

/**
 * A student's own material: an uploaded file (in `files`, workspace `coach-u<studentId>`, private)
 * or pasted text. Processed in-process by a run (runId), like the question import.
 */
export const coachMaterials = mysqlTable(
  "coach_materials",
  {
    id: id("id").primaryKey(),
    studentId: int("studentId").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    source: varchar("source", { length: 8 }).$type<MaterialSource>().notNull(),
    goal: varchar("goal", { length: 16 }).$type<MaterialGoal>().default("LEARN_ALL").notNull(),
    fileId: id("fileId"),
    fileName: varchar("fileName", { length: 255 }),
    mimeType: varchar("mimeType", { length: 120 }),
    sizeBytes: int("sizeBytes").default(0).notNull(),
    pageCount: int("pageCount").default(0).notNull(),
    charCount: int("charCount").default(0).notNull(),
    status: varchar("status", { length: 12 }).$type<CoachMaterialStatus>().default("QUEUED").notNull(),
    errorCode: varchar("errorCode", { length: 24 }).$type<MaterialError>(),
    runId: id("runId"),
    /** Pages read by OCR (scanned PDF pages, images); counted against the monthly OCR cap. */
    ocrPages: int("ocrPages").default(0).notNull(),
    /** Lowest page quality score (0-100) among OCR pages; null when nothing was recognised. */
    ocrScore: int("ocrScore"),
    /** Low recognition quality: the student is asked to check the recognised text. */
    needsReview: boolean("needsReview").default(false).notNull(),
    /** Bumped when chunk text changes, so generated content made from older text is stale. */
    textRevision: int("textRevision").default(1).notNull(),
    lastOpenedAt: timestamp("lastOpenedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("coach_materials_student_idx").on(t.studentId, t.createdAt)],
);

/** A topic found in a material; titles are in the language the student used at upload time. */
export const coachTopics = mysqlTable(
  "coach_topics",
  {
    id: id("id").primaryKey(),
    materialId: id("materialId").notNull(),
    studentId: int("studentId").notNull(),
    ord: int("ord").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    pageFrom: int("pageFrom").default(1).notNull(),
    pageTo: int("pageTo").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("coach_topics_material_idx").on(t.materialId, t.ord), index("coach_topics_student_idx").on(t.studentId)],
);

/** A passage of the material's text (one or a few pages); the unit of retrieval and citation. */
export const coachChunks = mysqlTable(
  "coach_chunks",
  {
    id: id("id").primaryKey(),
    materialId: id("materialId").notNull(),
    studentId: int("studentId").notNull(),
    topicId: id("topicId"),
    ord: int("ord").notNull(),
    pageFrom: int("pageFrom").notNull(),
    pageTo: int("pageTo").notNull(),
    heading: varchar("heading", { length: 255 }).default("").notNull(),
    text: mediumtext("text").notNull(),
    method: varchar("method", { length: 8 }).$type<ChunkMethod>().default("TEXT").notNull(),
    /** OCR quality score 0-100 of the pages this chunk came from; null for text layers. */
    quality: int("quality"),
    /** The student corrected this text by hand. */
    edited: boolean("edited").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("coach_chunks_material_idx").on(t.materialId, t.ord), index("coach_chunks_topic_idx").on(t.topicId)],
);

/**
 * Generated study content for one topic: a summary pack or the key concepts, one row per
 * (topic, kind, app language). `inputHash` covers the source text, kind, language and prompt, so
 * a corrected text or another language means the row is regenerated, never silently reused.
 */
export const coachArtifacts = mysqlTable(
  "coach_artifacts",
  {
    id: id("id").primaryKey(),
    materialId: id("materialId").notNull(),
    topicId: id("topicId").notNull(),
    studentId: int("studentId").notNull(),
    kind: varchar("kind", { length: 20 }).$type<ArtifactKind>().notNull(),
    locale: varchar("locale", { length: 2 }).$type<CoachLocale>().notNull(),
    inputHash: varchar("inputHash", { length: 64 }).notNull(),
    content: json("content").$type<ArtifactContent>().notNull(),
    /** How many times it was generated or edited; shown as "updated" only. */
    revision: int("revision").default(1).notNull(),
    edited: boolean("edited").default(false).notNull(),
    model: varchar("model", { length: 120 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [uniqueIndex("coach_artifacts_topic_kind_uq").on(t.topicId, t.kind, t.locale), index("coach_artifacts_material_idx").on(t.materialId)],
);
export type CoachArtifactRow = typeof coachArtifacts.$inferSelect;

export type CoachMaterialRow = typeof coachMaterials.$inferSelect;
export type CoachTopicRow = typeof coachTopics.$inferSelect;
export type CoachChunkRow = typeof coachChunks.$inferSelect;
