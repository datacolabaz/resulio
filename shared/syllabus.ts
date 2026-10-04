import { z } from "zod";

/**
 * Syllabus / structured learning: shared enums, content schemas and completion rules.
 * See docs/SYLLABUS-ARCHITECTURE.md. New values go last in every list that backs a MySQL enum.
 */

export const SYLLABUS_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type SyllabusStatus = (typeof SYLLABUS_STATUSES)[number];

/** A DRAFT module/lesson is left out of the next published version. */
export const SYLLABUS_NODE_STATUSES = ["DRAFT", "READY"] as const;
export type SyllabusNodeStatus = (typeof SYLLABUS_NODE_STATUSES)[number];

export const SYLLABUS_ITEM_KINDS = ["THEORY", "TEACHER_PRACTICE", "STUDENT_PRACTICE", "ASSESSMENT", "RESOURCE"] as const;
export type SyllabusItemKind = (typeof SYLLABUS_ITEM_KINDS)[number];

/** LESSON = inside a lesson; MODULE = module assessment; SYLLABUS = final assessment. */
export const SYLLABUS_ITEM_SCOPES = ["LESSON", "MODULE", "SYLLABUS"] as const;
export type SyllabusItemScope = (typeof SYLLABUS_ITEM_SCOPES)[number];

export const SYLLABUS_VERSION_STATUSES = ["PUBLISHED", "ARCHIVED"] as const;

/** Stored grant status. PENDING (not started yet) and EXPIRED (ended) are derived from the dates. */
export const SYLLABUS_GRANT_STATUSES = ["ACTIVE", "REVOKED"] as const;
export const SYLLABUS_GRANT_STATES = ["ACTIVE", "PENDING", "EXPIRED", "REVOKED"] as const;
export type SyllabusGrantState = (typeof SYLLABUS_GRANT_STATES)[number];

export const SYLLABUS_ENROLLMENT_STATUSES = ["ACTIVE", "COMPLETED"] as const;

export const MODULE_PROGRESS_STATES = ["LOCKED", "AVAILABLE", "IN_PROGRESS", "AWAITING_APPROVAL", "COMPLETED"] as const;
export type ModuleProgressState = (typeof MODULE_PROGRESS_STATES)[number];

export const LESSON_PROGRESS_STATES = ["LOCKED", "AVAILABLE", "IN_PROGRESS", "AWAITING_REVIEW", "AWAITING_APPROVAL", "COMPLETED"] as const;
export type LessonProgressState = (typeof LESSON_PROGRESS_STATES)[number];

export const UNLOCK_SOURCES = ["FIRST", "SEQUENTIAL", "MANUAL", "GRANDFATHERED"] as const;
export type UnlockSource = (typeof UNLOCK_SOURCES)[number];

export const UNLOCK_TARGET_TYPES = ["MODULE", "LESSON"] as const;
export type UnlockTargetType = (typeof UNLOCK_TARGET_TYPES)[number];

export const APPROVAL_TARGET_TYPES = ["LESSON", "MODULE", "SYLLABUS"] as const;
export type ApprovalTargetType = (typeof APPROVAL_TARGET_TYPES)[number];
export const APPROVAL_DECISIONS = ["APPROVED", "RETURNED"] as const;

export const DIFFICULTY_LEVELS = ["EASY", "MEDIUM", "HARD"] as const;
export const VIDEO_PROVIDERS = ["youtube", "vimeo", "loom", "drive", "url"] as const;
export const SUBMISSION_TYPES = ["TEXT", "FILE", "TEXT_OR_FILE", "CODE"] as const;
export const PRACTICE_EVALUATIONS = ["TEACHER", "AI_AUTO"] as const;

/** Learning activity types (§29, §42). Plain varchar in the DB: append freely, no migration. */
export const LEARNING_ACTIVITY_TYPES = [
  "SYLLABUS_OPENED",
  "SYLLABUS_STARTED",
  "SYLLABUS_COMPLETED",
  "MODULE_OPENED",
  "MODULE_UNLOCKED",
  "MODULE_COMPLETED",
  "LESSON_OPENED",
  "LESSON_STARTED",
  "LESSON_UNLOCKED",
  "LESSON_COMPLETED",
  "THEORY_OPENED",
  "THEORY_COMPLETED",
  "VIDEO_OPENED",
  "VIDEO_STARTED",
  "VIDEO_PROGRESS",
  "VIDEO_COMPLETED",
  "TEACHER_PRACTICE_OPENED",
  "PRACTICE_OPENED",
  "PRACTICE_STARTED",
  "PRACTICE_SUBMITTED",
  "PRACTICE_RESUBMITTED",
  "PRACTICE_COMPLETED",
  "ASSESSMENT_OPENED",
  "ASSESSMENT_STARTED",
  "ASSESSMENT_SUBMITTED",
  "ASSESSMENT_PASSED",
  "ASSESSMENT_FAILED",
  "MANUAL_UNLOCK",
  "ACCESS_GRANTED",
  "ACCESS_REVOKED",
  "VERSION_UPGRADED",
  "HEARTBEAT",
] as const;
export type LearningActivityType = (typeof LEARNING_ACTIVITY_TYPES)[number];

/** The only types a client may report; outcomes (completed, submitted, passed, unlocked) are recorded by the server. */
export const CLIENT_ACTIVITY_TYPES = [
  "SYLLABUS_OPENED",
  "MODULE_OPENED",
  "LESSON_OPENED",
  "THEORY_OPENED",
  "VIDEO_OPENED",
  "VIDEO_STARTED",
  "VIDEO_PROGRESS",
  "VIDEO_COMPLETED",
  "TEACHER_PRACTICE_OPENED",
  "PRACTICE_OPENED",
  "PRACTICE_STARTED",
  "ASSESSMENT_OPENED",
  "HEARTBEAT",
] as const satisfies readonly LearningActivityType[];
export type ClientActivityType = (typeof CLIENT_ACTIVITY_TYPES)[number];

export const MAX_ACTIVITY_BATCH = 20;
export const MAX_ACTIVITY_DURATION_SECONDS = 3600;
/** Upper bound credited to a lesson's active time per heartbeat. */
export const MAX_HEARTBEAT_SECONDS = 60;
export const VIDEO_PROGRESS_MARKS = [25, 50, 75] as const;

export const MAX_ITEM_CONTENT_CHARS = 200_000;
export const MAX_ATTEMPTS_LIMIT = 20;

// ---------------------------------------------------------------------------
// Completion rules (§8, §9, §16, §17) — partial at syllabus/module/lesson level, resolved by inheritance
// ---------------------------------------------------------------------------

export const THEORY_RULES = ["REQUIRED", "OPTIONAL"] as const;
export const TEACHER_PRACTICE_RULES = ["NONE", "VIEWED", "TEACHER_MARKED"] as const;
export const STUDENT_PRACTICE_RULES = ["NONE", "SUBMITTED", "GRADED", "PASSED"] as const;
export const ASSESSMENT_RULES = ["NONE", "ATTEMPTED", "PASSED"] as const;
export const SCORE_POLICIES = ["BEST", "LATEST"] as const;

const pct = z.number().min(0).max(100);

export const retryPolicySchema = z.object({
  /** null = as many as the engine allows (MAX_ATTEMPTS_LIMIT). */
  maxAttempts: z.number().int().min(1).max(MAX_ATTEMPTS_LIMIT).nullable(),
  cooldownMinutes: z.number().int().min(0).max(60 * 24 * 7),
  scorePolicy: z.enum(SCORE_POLICIES),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const completionRulesSchema = z.object({
  sequentialModules: z.boolean(),
  sequentialLessons: z.boolean(),
  theory: z.enum(THEORY_RULES),
  teacherPractice: z.enum(TEACHER_PRACTICE_RULES),
  studentPractice: z.enum(STUDENT_PRACTICE_RULES),
  practicePassPct: pct,
  assessment: z.enum(ASSESSMENT_RULES),
  assessmentPassPct: pct,
  retry: retryPolicySchema,
  teacherApproval: z.boolean(),
  moduleRequiresAllLessons: z.boolean(),
});
export type CompletionRules = z.infer<typeof completionRulesSchema>;

export const completionRulesPatchSchema = completionRulesSchema.partial().extend({ retry: retryPolicySchema.partial().optional() });
export type CompletionRulesPatch = z.infer<typeof completionRulesPatchSchema>;

/** Owner-approved defaults (docs/SYLLABUS-ARCHITECTURE.md, Q3). */
export const DEFAULT_COMPLETION_RULES: CompletionRules = {
  sequentialModules: true,
  sequentialLessons: true,
  theory: "REQUIRED",
  teacherPractice: "VIEWED",
  studentPractice: "SUBMITTED",
  practicePassPct: 60,
  assessment: "PASSED",
  assessmentPassPct: 70,
  retry: { maxAttempts: 3, cooldownMinutes: 0, scorePolicy: "BEST" },
  teacherApproval: false,
  moduleRequiresAllLessons: true,
};

/** Field-wise inheritance: later layers override earlier ones; `retry` merges per field. */
export function resolveRules(...layers: Array<CompletionRulesPatch | null | undefined>): CompletionRules {
  let out: CompletionRules = { ...DEFAULT_COMPLETION_RULES, retry: { ...DEFAULT_COMPLETION_RULES.retry } };
  for (const layer of layers) {
    if (!layer) continue;
    const { retry, ...rest } = layer;
    const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<CompletionRules>;
    out = { ...out, ...defined, retry: { ...out.retry, ...(retry ? Object.fromEntries(Object.entries(retry).filter(([, v]) => v !== undefined)) : {}) } };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Item content (validated per kind)
// ---------------------------------------------------------------------------

const entityRef = z.string().trim().min(1).max(32);
const webUrl = z
  .string()
  .trim()
  .max(2000)
  .regex(/^https?:\/\/[^\s]+$/i, "INVALID_URL");
const shortText = z.string().trim().max(255);
const longText = z.string().max(20_000);
const attachment = z.object({ fileId: entityRef, name: z.string().max(255), size: z.number().int().nonnegative() });

export const theoryBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("markdown"), md: z.string().max(50_000) }),
  z.object({ type: z.literal("code"), language: z.string().trim().max(32).default(""), code: z.string().max(50_000) }),
  z.object({ type: z.literal("image"), fileId: entityRef.optional(), url: webUrl.optional(), caption: shortText.default("") }),
  z.object({ type: z.literal("video"), provider: z.enum(VIDEO_PROVIDERS), url: webUrl, durationSec: z.number().int().min(0).max(36_000).optional() }),
  z.object({ type: z.literal("file"), fileId: entityRef, name: shortText }),
  z.object({ type: z.literal("material"), materialId: entityRef }),
  z.object({ type: z.literal("link"), url: webUrl, title: shortText.default("") }),
]);
export type TheoryBlock = z.infer<typeof theoryBlockSchema>;

export const theoryContentSchema = z.object({ blocks: z.array(theoryBlockSchema).max(200).default([]) });

export const teacherPracticeContentSchema = z.object({
  problem: longText.default(""),
  difficulty: z.enum(DIFFICULTY_LEVELS).default("MEDIUM"),
  expectedOutcome: longText.default(""),
  hints: z.array(z.string().max(2000)).max(20).default([]),
  exampleInput: longText.default(""),
  exampleOutput: longText.default(""),
  attachments: z.array(attachment).max(20).default([]),
  /** Never sent to students unless `revealSolutionToStudents`; `notes` never. */
  teacherOnly: z.object({ solution: longText.default(""), notes: longText.default("") }).default({ solution: "", notes: "" }),
  revealSolutionToStudents: z.boolean().default(false),
});

export const studentPracticeContentSchema = z.object({
  instructions: longText.default(""),
  difficulty: z.enum(DIFFICULTY_LEVELS).default("MEDIUM"),
  expectedResult: longText.default(""),
  hints: z.array(z.string().max(2000)).max(20).default([]),
  submissionType: z.enum(SUBMISSION_TYPES).default("TEXT_OR_FILE"),
  deadline: z
    .object({
      type: z.enum(["NONE", "RELATIVE_DAYS", "ABSOLUTE"]),
      days: z.number().int().min(1).max(365).optional(),
      at: z.coerce.date().optional(),
    })
    .default({ type: "NONE" }),
  evaluation: z.enum(PRACTICE_EVALUATIONS).default("AI_AUTO"),
  /** Overrides the rules' practicePassPct for this task. */
  passPct: pct.optional(),
  attachments: z.array(attachment).max(20).default([]),
});

export const assessmentItemContentSchema = z.object({
  passPct: pct.optional(),
  maxAttempts: z.number().int().min(1).max(MAX_ATTEMPTS_LIMIT).nullable().optional(),
  cooldownMinutes: z.number().int().min(0).max(60 * 24 * 7).optional(),
  scorePolicy: z.enum(SCORE_POLICIES).optional(),
});

export const resourceContentSchema = z.object({
  note: z.string().max(2000).default(""),
  url: webUrl.optional(),
  title: shortText.optional(),
});

export const ITEM_CONTENT_SCHEMAS = {
  THEORY: theoryContentSchema,
  TEACHER_PRACTICE: teacherPracticeContentSchema,
  STUDENT_PRACTICE: studentPracticeContentSchema,
  ASSESSMENT: assessmentItemContentSchema,
  RESOURCE: resourceContentSchema,
} as const satisfies Record<SyllabusItemKind, z.ZodTypeAny>;

export type TheoryContent = z.infer<typeof theoryContentSchema>;
export type TeacherPracticeContent = z.infer<typeof teacherPracticeContentSchema>;
export type StudentPracticeContent = z.infer<typeof studentPracticeContentSchema>;
export type AssessmentItemContent = z.infer<typeof assessmentItemContentSchema>;
export type ResourceContent = z.infer<typeof resourceContentSchema>;
export type ItemContent = TheoryContent | TeacherPracticeContent | StudentPracticeContent | AssessmentItemContent | ResourceContent;

/** Validates and normalizes `content` for `kind`; throws with message INVALID_ITEM_CONTENT / ITEM_CONTENT_TOO_LARGE. */
export function parseItemContent(kind: SyllabusItemKind, raw: unknown): ItemContent {
  const parsed = ITEM_CONTENT_SCHEMAS[kind].safeParse(raw ?? {});
  if (!parsed.success) throw new Error("INVALID_ITEM_CONTENT");
  if (JSON.stringify(parsed.data).length > MAX_ITEM_CONTENT_CHARS) throw new Error("ITEM_CONTENT_TOO_LARGE");
  return parsed.data as ItemContent;
}
