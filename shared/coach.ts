/**
 * AI Study Coach: a student's private learning loop (material → learn → practice → feedback →
 * review). Shared constants; see docs/STUDY-COACH.md. Nothing here is a teacher table: coach data
 * lives in coach_* side tables and never feeds teacher analytics.
 */

export const COACH_FLAG = "study_coach";

/** Coach topic keys; Growth's topic resolution never produces this prefix. */
export const COACH_KEY_PREFIX = "cx:";
export const coachTopicKey = (topicId: string) => `${COACH_KEY_PREFIX}${topicId}`;

/** Languages of generated content: the language the user picked in the app. */
export const COACH_LOCALES = ["az", "en", "ru"] as const;
export type CoachLocale = (typeof COACH_LOCALES)[number];
export const coachLocaleOf = (v: string | null | undefined): CoachLocale => (v === "en" || v === "ru" ? v : "az");

export const MATERIAL_SOURCES = ["UPLOAD", "TEXT"] as const;
export type MaterialSource = (typeof MATERIAL_SOURCES)[number];

export const MATERIAL_GOALS = ["LEARN_ALL", "TOPIC", "EXAM_PREP", "SUMMARY", "QUESTIONS"] as const;
export type MaterialGoal = (typeof MATERIAL_GOALS)[number];

export const COACH_MATERIAL_STATUSES = ["QUEUED", "EXTRACTING", "SEGMENTING", "READY", "FAILED"] as const;
export type CoachMaterialStatus = (typeof COACH_MATERIAL_STATUSES)[number];

/** The three steps the student sees ("Fayl yoxlanılır" → "Material emal olunur" → "Material hazırdır"), plus a failure. */
export const MATERIAL_STAGES = ["CHECKING", "PROCESSING", "READY", "FAILED"] as const;
export type MaterialStage = (typeof MATERIAL_STAGES)[number];
export function materialStage(status: CoachMaterialStatus): MaterialStage {
  if (status === "QUEUED") return "CHECKING";
  if (status === "EXTRACTING" || status === "SEGMENTING") return "PROCESSING";
  return status;
}

export const MATERIAL_ERRORS = ["NO_TEXT", "TOO_MANY_PAGES", "UNREADABLE", "FILE_MISSING", "AI_UNAVAILABLE", "AI_QUOTA", "INTERRUPTED", "INTERNAL"] as const;
export type MaterialError = (typeof MATERIAL_ERRORS)[number];

/** Upload limits: the existing API upload path (8 MB), 150 pages, 300k characters of text. */
export const COACH_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const COACH_MAX_PAGES = 150;
export const COACH_MAX_CHARS = 300_000;
export const COACH_MAX_PASTE_CHARS = 100_000;
export const COACH_UPLOAD_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".docx", ".pptx", ".txt"] as const;

export const CHUNK_METHODS = ["TEXT", "OCR"] as const;
export type ChunkMethod = (typeof CHUNK_METHODS)[number];

export const ARTIFACT_KINDS = ["SUMMARY_SHORT", "SUMMARY_DETAILED", "SUMMARY_EXAM", "CONCEPTS"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
/** What the student picks in the "Öyrən" tab; SHORT also brings the key concepts. */
export const SUMMARY_FORMATS = ["SHORT", "DETAILED", "EXAM"] as const;
export type SummaryFormat = (typeof SUMMARY_FORMATS)[number];

/** Where a generated sentence comes from: the material (with a verified citation) or the model's own knowledge. */
export const GROUNDING = ["MATERIAL", "MIXED", "GENERAL", "NOT_FOUND"] as const;
export type Grounding = (typeof GROUNDING)[number];

export const QUIZ_FORMATS = ["MCQ", "TRUE_FALSE", "OPEN", "WRITTEN", "CALCULATION", "MATCHING", "MIXED"] as const;
export type QuizFormat = (typeof QUIZ_FORMATS)[number];
export const QUIZ_COUNTS = [5, 10, 15] as const;
export const QUIZ_STATUSES = ["READY", "IN_PROGRESS", "GRADED"] as const;
export type QuizStatus = (typeof QUIZ_STATUSES)[number];
/** Item outcome: the engine's statuses plus PROVISIONAL (an AI grade that is not final). */
export const COACH_ITEM_STATUSES = ["CORRECT", "WRONG", "UNANSWERED", "PENDING_REVIEW", "PROVISIONAL", "PARTIAL"] as const;
export type CoachItemStatus = (typeof COACH_ITEM_STATUSES)[number];
export const GRADED_BY = ["RULE", "AI", "AI_PRO"] as const;
export type GradedBy = (typeof GRADED_BY)[number];

export const MISTAKE_CAUSES = ["CONCEPT_CONFUSION", "CALC_SLIP", "MISREAD", "MISSING_STEP", "NOT_LEARNED", "UNKNOWN"] as const;
export type MistakeCause = (typeof MISTAKE_CAUSES)[number];

export const RECALL_MODES = ["OFF", "LOW", "NORMAL"] as const;
export type RecallMode = (typeof RECALL_MODES)[number];

export const TUTOR_MODES = ["CLARIFY", "HINT", "EXPLAIN", "EXAMPLE", "CHECK", "RECALL"] as const;
export type TutorMode = (typeof TUTOR_MODES)[number];
/** The buttons next to a topic: "Sadə izah et", "Nümunə göstər", "Məni yoxla", or a free question. */
export const TUTOR_ACTIONS = ["ASK", "SIMPLE", "EXAMPLE", "QUIZ_ME"] as const;
export type TutorAction = (typeof TUTOR_ACTIONS)[number];

export const COACH_EVENT_TYPES = [
  "CONSENT",
  "UPLOAD",
  "MATERIAL_READY",
  "PACK_OPENED",
  "PACK_EDITED",
  "QUIZ_STARTED",
  "QUIZ_SUBMITTED",
  "HINT_USED",
  "TUTOR_ASKED",
  "RECALL_SHOWN",
  "MISTAKE_FIXED",
  "PRO_GRADE",
  "SHARED",
] as const;
export type CoachEventType = (typeof COACH_EVENT_TYPES)[number];

/** Free beta limits; every value can be changed in platform_settings (`coach.limits`, `coach.student*`). */
export const COACH_DEFAULT_LIMITS = {
  uploadsPerDay: 5,
  maxMaterials: 20,
  ocrPagesPerMaterial: 30,
  ocrPagesPerMonth: 200,
  quizzesPerDay: 10,
  tutorPerDay: 40,
  proGradesPerDay: 5,
};
export type CoachLimits = typeof COACH_DEFAULT_LIMITS;
export const COACH_DEFAULT_MONTHLY_TOKENS = 500_000;
export const COACH_DEFAULT_DAILY_ACTIONS = 30;

/** Retention: tutor messages after 90 days, failed uploads after 7, materials unopened for a year. */
export const RETENTION_DAYS = { tutorMessages: 90, failedMaterials: 7, idleMaterials: 365 };
