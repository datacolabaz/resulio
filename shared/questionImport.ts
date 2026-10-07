import { z } from "zod";
import { DIFFICULTIES } from "./assessment";

export const IMPORT_JOB_STATUSES = ["QUEUED", "PROCESSING", "READY", "FAILED", "COMPLETED"] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

export const IMPORT_ITEM_STATUSES = ["PENDING", "ACCEPTED", "REJECTED"] as const;
export type ImportItemStatus = (typeof IMPORT_ITEM_STATUSES)[number];

/** Where the stored correct answer came from: marked in the file, solved by the AI, or set by the teacher. */
export const ANSWER_SOURCES = ["SOURCE", "AI", "TEACHER"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];

export const CONFIDENCE_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Question types the extractor may produce; matching/ordering are left to manual authoring. */
export const IMPORT_QUESTION_TYPES = ["MULTIPLE_CHOICE", "MULTIPLE_SELECT", "TRUE_FALSE", "SHORT_ANSWER", "LONG_ANSWER", "FILL_BLANK", "NUMERIC"] as const;
export type ImportQuestionType = (typeof IMPORT_QUESTION_TYPES)[number];

export const IMPORT_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export const IMPORT_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg"] as const;

/** Pages read per import; longer PDFs are refused rather than silently truncated. */
export const IMPORT_MAX_PAGES = 40;
/** Pages sent to the model per request; small enough for a full answer within the output token budget. */
export const IMPORT_CHUNK_PAGES = 4;
export const IMPORT_MAX_QUESTIONS = 300;

/**
 * Review flags shown next to an extracted question. Blocking ones (see `BLOCKING_ISSUES`) must be
 * fixed before the question can be accepted; the others are warnings.
 */
export const IMPORT_ISSUES = [
  "INVALID_QUESTION",
  "ANSWER_MISSING",
  "ANSWER_MISMATCH",
  "AI_ANSWER",
  "LOW_CONFIDENCE",
  "NEEDS_FIGURE",
  "DUPLICATE_IN_BANK",
  "DUPLICATE_IN_FILE",
  "TYPE_CHANGED",
] as const;
export type ImportIssue = (typeof IMPORT_ISSUES)[number];
export const BLOCKING_ISSUES: readonly ImportIssue[] = ["INVALID_QUESTION", "ANSWER_MISSING"];

/** Why a job FAILED; shown to the teacher as `questionImport.failed.<code>`. */
export const IMPORT_JOB_ERRORS = [
  "PDF_UNREADABLE",
  "TOO_MANY_PAGES",
  "NO_TEXT",
  "NO_QUESTIONS",
  "AI_OUTPUT",
  "AI_KEY_INVALID",
  "AI_NOT_FOUND",
  "AI_QUOTA",
  "AI_REQUEST_FAILED",
  "AI_UNAVAILABLE",
  "DAILY_LIMIT",
  "FILE_MISSING",
  "INTERRUPTED",
  "INTERNAL",
] as const;
export type ImportJobError = (typeof IMPORT_JOB_ERRORS)[number];

export const DIFFICULTY_RANK: Record<(typeof DIFFICULTIES)[number], number> = { EASY: 0, MEDIUM: 1, HARD: 2 };

export const topicNameSchema = z.string().trim().min(1).max(120);

export const topicInputSchema = z.object({
  name: topicNameSchema,
  parentId: z.string().min(1).max(32).nullable().optional(),
  syllabusId: z.string().min(1).max(32).nullable().optional(),
  syllabusModuleId: z.string().min(1).max(32).nullable().optional(),
  syllabusLessonId: z.string().min(1).max(32).nullable().optional(),
});
export type TopicInput = z.infer<typeof topicInputSchema>;

/** Lower-case, accent- and punctuation-insensitive form used for topic names and duplicate checks. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ə/g, "e")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
