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

/**
 * Why a material failed (status FAILED), or a warning on a READY material (OCR_LIMIT, OCR_PARTIAL).
 * AI failures are told apart: AI_QUOTA = the provider's rate limit (429, "busy, retry soon"),
 * AI_EXHAUSTED = its daily quota, AI_CONFIG = wrong key/model or a model with no quota,
 * AI_TIMEOUT = no answer in time, OCR_UNSUPPORTED = the provider cannot read PDFs/images.
 */
export const MATERIAL_ERRORS = [
  "NO_TEXT",
  "TOO_MANY_PAGES",
  "FILE_TOO_LARGE",
  "UNREADABLE",
  "FILE_MISSING",
  "FILE_TYPE",
  "OCR_LIMIT",
  "OCR_PARTIAL",
  "OCR_UNSUPPORTED",
  "AI_LIMIT",
  "AI_UNAVAILABLE",
  "AI_QUOTA",
  "AI_EXHAUSTED",
  "AI_CONFIG",
  "AI_TIMEOUT",
  "INTERRUPTED",
  "INTERNAL",
] as const;
export type MaterialError = (typeof MATERIAL_ERRORS)[number];
/** READY with one of these: the material works, a notice explains what was left out. */
export const MATERIAL_WARNINGS: readonly MaterialError[] = ["OCR_LIMIT", "OCR_PARTIAL"];

/**
 * Upload limits. Size and pages come from `coach.limits` (maxUploadMb, maxPages); files above the
 * API upload path (8 MB) go straight to R2, so without R2 the size limit stays at 8 MB. Hard caps
 * keep an admin typo from letting a 2 GB file into server memory.
 */
export const COACH_DB_MAX_UPLOAD_MB = 8;
export const COACH_HARD_MAX_UPLOAD_MB = 200;
export const COACH_HARD_MAX_PAGES = 1000;
/** Text kept per material (~330 dense pages); later pages are dropped. */
export const COACH_MAX_CHARS = 1_000_000;
export const COACH_MAX_PASTE_CHARS = 100_000;
export const COACH_UPLOAD_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".docx", ".pptx", ".txt"] as const;

export const CHUNK_METHODS = ["TEXT", "OCR"] as const;
export type ChunkMethod = (typeof CHUNK_METHODS)[number];

/** MATERIAL_SUMMARY: the short overview of a whole material, stored with `topicId` = the material id. */
export const ARTIFACT_KINDS = ["SUMMARY_SHORT", "SUMMARY_DETAILED", "SUMMARY_EXAM", "CONCEPTS", "MATERIAL_SUMMARY"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
/** What the student picks in the "Öyrən" tab; SHORT also brings the key concepts. */
export const SUMMARY_FORMATS = ["SHORT", "DETAILED", "EXAM"] as const;
export type SummaryFormat = (typeof SUMMARY_FORMATS)[number];

/** Where a generated sentence comes from: the material (with a verified citation) or the model's own knowledge. */
export const GROUNDING = ["MATERIAL", "MIXED", "GENERAL", "NOT_FOUND"] as const;
export type Grounding = (typeof GROUNDING)[number];

/** A verified citation: the quote is copied verbatim from the chunk (original language). */
export interface Cite {
  chunkId: string;
  page: number;
  quote: string;
}
export interface PackPoint {
  text: string;
  cites: Cite[];
  /** MATERIAL when at least one citation was verified; GENERAL = the model's own knowledge. */
  grounding: "MATERIAL" | "GENERAL";
}
export interface PackSection {
  heading: string;
  points: PackPoint[];
}
export interface PackConcept {
  term: string;
  definition: string;
  cites: Cite[];
  grounding: "MATERIAL" | "GENERAL";
}
/** One generated artifact. Summaries use `sections` (+ `questions`/`pitfalls` for EXAM); CONCEPTS uses `concepts`. */
export interface ArtifactContent {
  title: string;
  sections: PackSection[];
  concepts?: PackConcept[];
  /** EXAM: likely exam questions. */
  questions?: string[];
  /** EXAM: common mistakes. */
  pitfalls?: string[];
}
export const SUMMARY_KIND: Record<SummaryFormat, ArtifactKind> = { SHORT: "SUMMARY_SHORT", DETAILED: "SUMMARY_DETAILED", EXAM: "SUMMARY_EXAM" };

export const QUIZ_FORMATS = ["MCQ", "TRUE_FALSE", "OPEN", "WRITTEN", "CALCULATION", "MATCHING", "MIXED"] as const;
export type QuizFormat = (typeof QUIZ_FORMATS)[number];
/** Formats the student can pick. */
export const PRACTICE_FORMATS = ["MCQ", "TRUE_FALSE", "OPEN", "WRITTEN", "MATCHING", "CALCULATION", "MIXED"] as const satisfies readonly QuizFormat[];
export const QUIZ_COUNTS = [5, 10, 15] as const;
/** "Özünü yoxla": mixed questions over a whole material. */
export const COACH_MATERIAL_QUIZ_COUNT = 10;
export const QUIZ_STATUSES = ["READY", "IN_PROGRESS", "GRADED"] as const;
export type QuizStatus = (typeof QUIZ_STATUSES)[number];
/** Item outcome: the engine's statuses plus PROVISIONAL (an AI grade that is not final). */
export const COACH_ITEM_STATUSES = ["CORRECT", "WRONG", "UNANSWERED", "PENDING_REVIEW", "PROVISIONAL", "PARTIAL"] as const;
export type CoachItemStatus = (typeof COACH_ITEM_STATUSES)[number];
export const GRADED_BY = ["RULE", "AI", "AI_PRO"] as const;
export type GradedBy = (typeof GRADED_BY)[number];

/** Formats offered in "Məşq et" and the question types each one generates. */
export const FORMAT_TYPES: Record<QuizFormat, readonly string[]> = {
  MCQ: ["MULTIPLE_CHOICE"],
  TRUE_FALSE: ["TRUE_FALSE"],
  OPEN: ["SHORT_ANSWER"],
  WRITTEN: ["LONG_ANSWER"],
  CALCULATION: ["NUMERIC"],
  MATCHING: ["MATCHING"],
  MIXED: ["MULTIPLE_CHOICE", "TRUE_FALSE", "SHORT_ANSWER", "MATCHING"],
};

/** One quiz's evidence for a topic, in the Growth engine's shape (origin PRACTICE). */
export interface CoachEvidence {
  resultId: string;
  completedAt: string;
  questionCount: number;
  pendingCount: number;
  earned: number;
  possible: number;
  wrongPoints: number;
}

/** CALCULATION: formula over named inputs, evaluated on the server to check the model's answer. */
export interface CalcSpec {
  formula: string;
  variables: Record<string, number>;
  unit?: string;
  /** False when the server's result differed from the model's key (the item is not graded strictly). */
  verified?: boolean;
}

/** AI feedback on an answer: what was right, what was missing, and the rubric points. */
export interface ItemFeedback {
  summary: string;
  good?: string[];
  missing?: string[];
  rubric?: { point: string; met: boolean }[];
}

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
  /** Pages read by OCR; `meta.pages` counts against the monthly OCR cap (deleting a material does not refund it). */
  "OCR",
] as const;

/** OCR page quality (0-100) below this marks the page as poorly recognised. */
export const OCR_LOW_QUALITY = 60;
/** The material asks the student to check its text only when at least this share of its pages is poorly recognised. */
export const OCR_REVIEW_SHARE = 0.1;
/** A recognised page with fewer letters is a picture or diagram page ("şəkil səhifəsi"), not a poor recognition. */
export const OCR_IMAGE_PAGE_LETTERS = 150;
export type CoachEventType = (typeof COACH_EVENT_TYPES)[number];

/** Page numbers per outcome of reading a material, shown on the material and in the text editor. */
export interface MaterialPageReport {
  /** Recognised, but poorly: the student may want to check them. */
  low: number[];
  /** Picture/diagram pages with little text. */
  image: number[];
  /** OCR failed on them (after retries). */
  failed: number[];
  /** Left out by the OCR caps. */
  skipped: number[];
}

/** Whether poorly recognised pages are a meaningful share of the material (and not a few diagrams). */
export function reviewNeeded(lowPages: number, pageCount: number): boolean {
  return lowPages > 0 && lowPages >= Math.max(1, pageCount) * OCR_REVIEW_SHARE;
}

/** "3, 5–7, 12" (at most `max` groups, then "…"). */
export function pageList(pages: number[], max = 12): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const groups: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    groups.push(j === i ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return groups.length > max ? `${groups.slice(0, max).join(", ")}, …` : groups.join(", ");
}

/** Free beta limits; every value can be changed in platform_settings (`coach.limits`, `coach.student*`). */
export const COACH_DEFAULT_LIMITS = {
  uploadsPerDay: 5,
  maxMaterials: 20,
  /** MB per file (with R2; without it at most COACH_DB_MAX_UPLOAD_MB). */
  maxUploadMb: 50,
  /** Pages (PDF pages, slides, or ~3000-character parts of a text). */
  maxPages: 300,
  ocrPagesPerMaterial: 30,
  ocrPagesPerMonth: 200,
  quizzesPerDay: 10,
  tutorPerDay: 40,
  proGradesPerDay: 5,
  /** Topics shorter than this many pages are joined with a neighbour (0 = never). */
  topicMinPages: 2,
  /** Topics longer than this many pages are split at headings (0 = never). */
  topicMaxPages: 6,
};
export type CoachLimits = typeof COACH_DEFAULT_LIMITS;

const MB = 1024 * 1024;

/** What the upload form shows and the server enforces, for the configured limits and file storage. */
export function coachUploadLimits(limits: Pick<CoachLimits, "maxUploadMb" | "maxPages" | "ocrPagesPerMaterial" | "ocrPagesPerMonth">, direct: boolean) {
  const wantedMb = limits.maxUploadMb > 0 ? limits.maxUploadMb : COACH_DEFAULT_LIMITS.maxUploadMb;
  const maxMb = Math.min(wantedMb, direct ? COACH_HARD_MAX_UPLOAD_MB : COACH_DB_MAX_UPLOAD_MB);
  return {
    /** Browser → R2 for files above the API upload path. */
    direct,
    maxBytes: maxMb * MB,
    maxPages: Math.min(limits.maxPages > 0 ? limits.maxPages : COACH_DEFAULT_LIMITS.maxPages, COACH_HARD_MAX_PAGES),
    /** 0 = no per-material OCR cap. */
    ocrPages: limits.ocrPagesPerMaterial,
    ocrPagesPerMonth: limits.ocrPagesPerMonth,
    /** The configured size is above what this storage allows (no R2): the form says so. */
    reducedByStorage: !direct && wantedMb > COACH_DB_MAX_UPLOAD_MB,
  };
}
export type CoachUploadLimits = ReturnType<typeof coachUploadLimits>;

/** Checked in the browser before anything is sent; the server checks again. */
export function coachFileProblem(file: { name: string; size: number }, maxBytes: number): "TYPE" | "SIZE" | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
  if (!(COACH_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) return "TYPE";
  if (file.size <= 0 || file.size > maxBytes) return "SIZE";
  return null;
}

/** Progress of a run, for "Material emal olunur… (səhifə X/Y)". */
export interface MaterialProgress {
  step: "READING" | "OCR" | "TOPICS";
  done: number;
  total: number;
}
export const COACH_DEFAULT_MONTHLY_TOKENS = 500_000;
export const COACH_DEFAULT_DAILY_ACTIONS = 30;

/** Retention: tutor messages after 90 days, failed uploads after 7, materials unopened for a year. */
export const RETENTION_DAYS = { tutorMessages: 90, failedMaterials: 7, idleMaterials: 365 };
