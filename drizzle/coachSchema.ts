import { bigint, boolean, index, int, json, mediumtext, mysqlTable, primaryKey, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import type { AnswerKey, QuestionContent, QuestionType, StudentAnswer } from "../shared/assessment";
import type {
  ArtifactContent,
  ArtifactKind,
  CalcSpec,
  ChunkMethod,
  Cite,
  CoachEventType,
  CoachEvidence,
  CoachItemStatus,
  CoachLocale,
  CoachMaterialStatus,
  GradedBy,
  Grounding,
  ItemFeedback,
  MaterialError,
  MaterialGoal,
  MaterialSource,
  MistakeCause,
  QuizFormat,
  QuizStatus,
  RecallMode,
  TutorAction,
  TutorMode,
} from "../shared/coach";
import type { MasteryStatus } from "../shared/growth";

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

/** A practice quiz the student generated for one topic (or a review set across topics: topicId null). */
export const coachQuizzes = mysqlTable(
  "coach_quizzes",
  {
    id: id("id").primaryKey(),
    studentId: int("studentId").notNull(),
    materialId: id("materialId"),
    topicId: id("topicId"),
    format: varchar("format", { length: 12 }).$type<QuizFormat>().notNull(),
    locale: varchar("locale", { length: 2 }).$type<CoachLocale>().notNull(),
    status: varchar("status", { length: 12 }).$type<QuizStatus>().default("READY").notNull(),
    total: int("total").default(0).notNull(),
    correct: int("correct").default(0).notNull(),
    /** 0-100 once graded. */
    percentage: int("percentage"),
    pending: int("pending").default(0).notNull(),
    hintsUsed: int("hintsUsed").default(0).notNull(),
    model: varchar("model", { length: 120 }),
    submittedAt: timestamp("submittedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("coach_quizzes_student_idx").on(t.studentId, t.createdAt), index("coach_quizzes_topic_idx").on(t.topicId)],
);
export type CoachQuizRow = typeof coachQuizzes.$inferSelect;

/** One question of a quiz. The answer key and explanation never leave the server before submission. */
export const coachQuizItems = mysqlTable(
  "coach_quiz_items",
  {
    id: id("id").primaryKey(),
    quizId: id("quizId").notNull(),
    studentId: int("studentId").notNull(),
    topicId: id("topicId"),
    ord: int("ord").notNull(),
    type: varchar("type", { length: 20 }).$type<QuestionType>().notNull(),
    text: text("text").notNull(),
    content: json("content").$type<QuestionContent>().notNull(),
    answerKey: json("answerKey").$type<AnswerKey>().notNull(),
    explanation: text("explanation"),
    hint: text("hint"),
    cites: json("cites").$type<Cite[]>(),
    /** CALCULATION: the formula and inputs the model used, re-computed on the server (P6). */
    calc: json("calc").$type<CalcSpec>(),
    answer: json("answer").$type<StudentAnswer>(),
    status: varchar("status", { length: 16 }).$type<CoachItemStatus>(),
    /** 0-100 credit (partial credit for AI-graded answers). */
    score: int("score"),
    gradedBy: varchar("gradedBy", { length: 8 }).$type<GradedBy>(),
    /** AI grading confidence 0-100. */
    confidence: int("confidence"),
    feedback: json("feedback").$type<ItemFeedback>(),
    hintUsed: boolean("hintUsed").default(false).notNull(),
    disputed: boolean("disputed").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("coach_quiz_items_quiz_idx").on(t.quizId, t.ord)],
);
export type CoachQuizItemRow = typeof coachQuizItems.$inferSelect;

/** The student's own mastery of a coach topic (coach evidence only; never mixed into Growth). */
export const coachTopicMastery = mysqlTable(
  "coach_topic_mastery",
  {
    studentId: int("studentId").notNull(),
    topicId: id("topicId").notNull(),
    materialId: id("materialId").notNull(),
    mastery: int("mastery").default(0).notNull(),
    status: varchar("status", { length: 12 }).$type<MasteryStatus>().default("INSUFFICIENT").notNull(),
    attempts: int("attempts").default(0).notNull(),
    /** Newest-first evidence, at most 10 quizzes. */
    evidence: json("evidence").$type<CoachEvidence[]>().notNull(),
    lastPracticedAt: timestamp("lastPracticedAt"),
    /** Spaced review: when this topic should come back, and the current interval. */
    nextReviewAt: timestamp("nextReviewAt"),
    intervalDays: int("intervalDays").default(0).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.topicId], name: "coach_topic_mastery_pk" }), index("coach_topic_mastery_review_idx").on(t.studentId, t.nextReviewAt)],
);
export type CoachTopicMasteryRow = typeof coachTopicMastery.$inferSelect;

/** A wrong answer kept for review ("AI yaddaşı"): visible to and deletable by the student. */
export const coachMistakes = mysqlTable(
  "coach_mistakes",
  {
    id: id("id").primaryKey(),
    studentId: int("studentId").notNull(),
    materialId: id("materialId"),
    topicId: id("topicId"),
    quizId: id("quizId"),
    itemId: id("itemId"),
    cause: varchar("cause", { length: 20 }).$type<MistakeCause>().default("UNKNOWN").notNull(),
    question: varchar("question", { length: 600 }).notNull(),
    fixedAt: timestamp("fixedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("coach_mistakes_student_idx").on(t.studentId, t.fixedAt), index("coach_mistakes_topic_idx").on(t.topicId)],
);
export type CoachMistakeRow = typeof coachMistakes.$inferSelect;

/** One tutor conversation, about one topic (or a whole material). */
export const coachThreads = mysqlTable(
  "coach_threads",
  {
    id: id("id").primaryKey(),
    studentId: int("studentId").notNull(),
    materialId: id("materialId").notNull(),
    topicId: id("topicId"),
    title: varchar("title", { length: 200 }).notNull(),
    messageCount: int("messageCount").default(0).notNull(),
    lastMessageAt: timestamp("lastMessageAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("coach_threads_student_idx").on(t.studentId, t.lastMessageAt), index("coach_threads_material_idx").on(t.materialId), index("coach_threads_topic_idx").on(t.topicId)],
);
export type CoachThreadRow = typeof coachThreads.$inferSelect;

export const coachMessages = mysqlTable(
  "coach_messages",
  {
    id: id("id").primaryKey(),
    threadId: id("threadId").notNull(),
    studentId: int("studentId").notNull(),
    role: varchar("role", { length: 12 }).$type<"USER" | "ASSISTANT">().notNull(),
    action: varchar("action", { length: 12 }).$type<TutorAction>(),
    mode: varchar("mode", { length: 12 }).$type<TutorMode>(),
    content: text("content").notNull(),
    cites: json("cites").$type<Cite[]>(),
    grounding: varchar("grounding", { length: 12 }).$type<Grounding>(),
    recall: varchar("recall", { length: 600 }),
    model: varchar("model", { length: 100 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("coach_messages_thread_idx").on(t.threadId, t.createdAt), index("coach_messages_student_idx").on(t.studentId, t.createdAt)],
);
export type CoachMessageRow = typeof coachMessages.$inferSelect;

/**
 * "Müəllimlə paylaş": a material the student shared read-only with one teacher (the owner of a
 * workspace whose group they are in). Revoking deletes the row.
 */
export const coachShares = mysqlTable(
  "coach_shares",
  {
    id: id("id").primaryKey(),
    studentId: int("studentId").notNull(),
    materialId: id("materialId").notNull(),
    teacherId: int("teacherId").notNull(),
    workspaceId: id("workspaceId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("coach_shares_material_teacher_uq").on(t.materialId, t.teacherId), index("coach_shares_teacher_idx").on(t.teacherId, t.workspaceId), index("coach_shares_student_idx").on(t.studentId)],
);
export type CoachShareRow = typeof coachShares.$inferSelect;

export type CoachMaterialRow = typeof coachMaterials.$inferSelect;
export type CoachTopicRow = typeof coachTopics.$inferSelect;
export type CoachChunkRow = typeof coachChunks.$inferSelect;
