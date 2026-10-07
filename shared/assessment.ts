import { z } from "zod";
import { timestampDate } from "./timestamp";

export const ASSESSMENT_TYPES = ["EXAM", "KSQ", "BSQ"] as const;
export type AssessmentType = (typeof ASSESSMENT_TYPES)[number];

export const QUESTION_TYPES = [
  "MULTIPLE_CHOICE",
  "MULTIPLE_SELECT",
  "TRUE_FALSE",
  "SHORT_ANSWER",
  "LONG_ANSWER",
  "MATCHING",
  "ORDERING",
  "FILL_BLANK",
  "NUMERIC",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** When a student may see the result at all. */
export const RELEASE_MODES = ["IMMEDIATE", "AFTER_CLOSE", "AFTER_GRADING"] as const;
export type ReleaseMode = (typeof RELEASE_MODES)[number];

/** How much of the attempt a student may review once the result is released. */
export const REVIEW_MODES = ["SCORE_ONLY", "WRONG_ONLY", "FULL"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Lifecycle status stored on the assessment row. */
export const ASSESSMENT_STATUSES = ["DRAFT", "PUBLISHED", "CLOSED"] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

/** Status derived from the stored status plus the availability window. */
export const LIVE_STATUSES = ["DRAFT", "SCHEDULED", "ACTIVE", "COMPLETED"] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];

/**
 * Session lifecycle only. Grading ("pending manual grading") and release are properties of the
 * result; inactivity is derived from `lastActivityAt`. VOIDED attempts do not count toward the limit.
 */
export const ATTEMPT_STATUSES = ["IN_PROGRESS", "SUBMITTED", "AUTO_SUBMITTED", "EXPIRED_NO_ANSWERS", "VOIDED"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** Allowed values for `assessments.inactivityThresholdMinutes`; null disables the inactive label. */
export const INACTIVITY_THRESHOLDS = [5, 10, 15, 30] as const;
export const DEFAULT_INACTIVITY_MINUTES = 10;

/**
 * Participant state shown to the teacher. INACTIVE is derived (never stored) and PENDING_REVIEW
 * comes from the result, so neither changes the session.
 */
export const PARTICIPANT_STATES = [
  "NOT_STARTED",
  "VIEWED",
  "IN_PROGRESS",
  "INACTIVE",
  "COMPLETED",
  "AUTO_SUBMITTED",
  "EXPIRED_NO_ANSWERS",
  "PENDING_REVIEW",
] as const;
export type ParticipantState = (typeof PARTICIPANT_STATES)[number];

export const ACTIVITY_ENTITY_TYPES = ["ASSESSMENT", "ASSIGNMENT", "MATERIAL", "FILE"] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

export const ACTIVITY_EVENT_TYPES = [
  "ASSESSMENT_VIEWED",
  "ASSESSMENT_STARTED",
  "ASSESSMENT_RESUMED",
  "ASSESSMENT_AUTOSAVED",
  "ASSESSMENT_SUBMITTED",
  "ASSESSMENT_EXPIRED",
  "ASSESSMENT_ATTEMPT_VOIDED",
  "RESULT_RELEASED",
  "ASSIGNMENT_VIEWED",
  "ASSIGNMENT_STARTED",
  "ASSIGNMENT_SUBMITTED",
  "ASSIGNMENT_LATE_SUBMITTED",
  "ASSIGNMENT_GRADED",
  "ASSIGNMENT_RETURNED_FOR_REVISION",
  "MATERIAL_VIEWED",
  "MATERIAL_DOWNLOADED",
  "VIDEO_STARTED",
  "VIDEO_PROGRESS",
  "VIDEO_COMPLETED",
  "FILE_UPLOADED",
  "FILE_DOWNLOADED",
  "REMINDER_SENT",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

export const ITEM_STATUSES = ["CORRECT", "WRONG", "UNANSWERED", "PENDING_REVIEW"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

const key = z.string().trim().min(1).max(32);
const text = z.string().trim().min(1).max(2000);
const choice = z.object({ key, text });

const base = {
  text: z.string().trim().min(1).max(5000),
  points: z.number().positive().max(1000),
  difficulty: z.enum(DIFFICULTIES).default("MEDIUM"),
  topic: z.string().trim().max(120).default(""),
  skill: z.string().trim().max(120).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  explanation: z.string().trim().max(5000).optional(),
  imageUrl: z.string().url().max(2000).optional(),
};

const uniqueKeys = (items: { key: string }[]) => new Set(items.map((i) => i.key)).size === items.length;

export const questionInputSchema = z
  .discriminatedUnion("type", [
    z.object({
      ...base,
      type: z.literal("MULTIPLE_CHOICE"),
      content: z.object({ options: z.array(choice).min(2).max(10) }),
      answerKey: z.object({ correct: key }),
    }),
    z.object({
      ...base,
      type: z.literal("MULTIPLE_SELECT"),
      content: z.object({ options: z.array(choice).min(2).max(10) }),
      answerKey: z.object({ correct: z.array(key).min(1) }),
    }),
    z.object({
      ...base,
      type: z.literal("TRUE_FALSE"),
      content: z.object({}).default({}),
      answerKey: z.object({ correct: z.boolean() }),
    }),
    z.object({
      ...base,
      type: z.literal("SHORT_ANSWER"),
      content: z.object({}).default({}),
      answerKey: z.object({
        accepted: z.array(text).min(1).max(20),
        caseSensitive: z.boolean().default(false),
      }),
    }),
    z.object({
      ...base,
      type: z.literal("LONG_ANSWER"),
      content: z.object({}).default({}),
      answerKey: z.object({ rubric: z.string().trim().max(5000).optional() }).default({}),
    }),
    z.object({
      ...base,
      type: z.literal("MATCHING"),
      content: z.object({
        left: z.array(choice).min(2).max(12),
        right: z.array(choice).min(2).max(12),
      }),
      answerKey: z.object({ pairs: z.record(z.string(), key) }),
    }),
    z.object({
      ...base,
      type: z.literal("ORDERING"),
      content: z.object({ items: z.array(choice).min(2).max(12) }),
      answerKey: z.object({ order: z.array(key).min(2) }),
    }),
    z.object({
      ...base,
      type: z.literal("FILL_BLANK"),
      content: z.object({ blankCount: z.number().int().min(1).max(10) }),
      answerKey: z.object({
        blanks: z.array(z.array(text).min(1).max(20)).min(1).max(10),
        caseSensitive: z.boolean().default(false),
      }),
    }),
    z.object({
      ...base,
      type: z.literal("NUMERIC"),
      content: z.object({ unit: z.string().trim().max(32).optional() }).default({}),
      answerKey: z.object({ value: z.number().finite(), tolerance: z.number().min(0).default(0) }),
    }),
  ])
  .superRefine((q, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message, path: ["answerKey"] });
    switch (q.type) {
      case "MULTIPLE_CHOICE": {
        if (!uniqueKeys(q.content.options)) issue("DUPLICATE_OPTION_KEYS");
        if (!q.content.options.some((o) => o.key === q.answerKey.correct)) issue("CORRECT_OPTION_MISSING");
        break;
      }
      case "MULTIPLE_SELECT": {
        if (!uniqueKeys(q.content.options)) issue("DUPLICATE_OPTION_KEYS");
        const keys = new Set(q.content.options.map((o) => o.key));
        if (!q.answerKey.correct.every((k) => keys.has(k))) issue("CORRECT_OPTION_MISSING");
        break;
      }
      case "MATCHING": {
        if (!uniqueKeys(q.content.left) || !uniqueKeys(q.content.right)) issue("DUPLICATE_OPTION_KEYS");
        const right = new Set(q.content.right.map((o) => o.key));
        const complete = q.content.left.every((l) => right.has(q.answerKey.pairs[l.key] ?? ""));
        if (!complete) issue("MATCHING_PAIRS_INCOMPLETE");
        break;
      }
      case "ORDERING": {
        if (!uniqueKeys(q.content.items)) issue("DUPLICATE_OPTION_KEYS");
        const items = q.content.items.map((i) => i.key).sort();
        if (JSON.stringify(items) !== JSON.stringify([...q.answerKey.order].sort())) issue("ORDER_KEY_MISMATCH");
        break;
      }
      case "FILL_BLANK": {
        if (q.answerKey.blanks.length !== q.content.blankCount) issue("BLANK_COUNT_MISMATCH");
        break;
      }
      default:
        break;
    }
  });

export type QuestionInput = z.infer<typeof questionInputSchema>;
export type QuestionContent = QuestionInput["content"];
export type AnswerKey = QuestionInput["answerKey"];

/** Shape of a student's answer per question type. Validated loosely; grading is defensive. */
export const studentAnswerSchema = z.union([
  z.string().max(20000),
  z.boolean(),
  z.array(z.string().max(2000)).max(50),
  z.record(z.string(), z.string().max(64)),
  z.null(),
]);
export type StudentAnswer = z.infer<typeof studentAnswerSchema>;

/** Question types the wrong-answer rule applies to: closed questions with one correct option (A–E). */
export const CLOSED_QUESTION_TYPES: readonly QuestionType[] = ["MULTIPLE_CHOICE"];

/**
 * "N wrong answers cancel one correct one" for closed questions: each wrong closed answer takes off
 * its points / N. Unanswered questions are not wrong; the closed part never goes below 0.
 */
export const wrongPenaltySchema = z.object({
  enabled: z.boolean(),
  ratio: z.number().int().min(2).max(10),
});
export type WrongPenalty = z.infer<typeof wrongPenaltySchema>;
export const DEFAULT_WRONG_PENALTY: WrongPenalty = { enabled: false, ratio: 4 };

export const assessmentSettingsSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(5000).default(""),
  instructions: z.string().trim().max(5000).default(""),
  subject: z.string().trim().max(120).default(""),
  durationSeconds: z.number().int().min(60).max(60 * 60 * 12),
  attemptsAllowed: z.number().int().min(1).max(20).default(1),
  randomize: z.boolean().default(false),
  releaseMode: z.enum(RELEASE_MODES).default("IMMEDIATE"),
  reviewMode: z.enum(REVIEW_MODES).default("FULL"),
  showCorrectAnswers: z.boolean().default(false),
  showExplanations: z.boolean().default(false),
  wrongPenalty: wrongPenaltySchema.default(DEFAULT_WRONG_PENALTY),
  /** E-mail each student their result once it is final and released. */
  emailResults: z.boolean().default(false),
});
export type AssessmentSettings = z.infer<typeof assessmentSettingsSchema>;

/** Partial update of settings. No defaults here, so omitted fields keep their stored value. */
export const assessmentSettingsPatchSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(5000).optional(),
  instructions: z.string().trim().max(5000).optional(),
  subject: z.string().trim().max(120).optional(),
  durationSeconds: z.number().int().min(60).max(60 * 60 * 12).optional(),
  attemptsAllowed: z.number().int().min(1).max(20).optional(),
  randomize: z.boolean().optional(),
  releaseMode: z.enum(RELEASE_MODES).optional(),
  reviewMode: z.enum(REVIEW_MODES).optional(),
  showCorrectAnswers: z.boolean().optional(),
  showExplanations: z.boolean().optional(),
  wrongPenalty: wrongPenaltySchema.optional(),
  emailResults: z.boolean().optional(),
});
export type AssessmentSettingsPatch = z.infer<typeof assessmentSettingsPatchSchema>;

export const scheduleSchema = z
  .object({
    startAt: timestampDate().nullable(),
    endAt: timestampDate().nullable(),
    timezone: z.string().trim().min(1).max(64).default("Asia/Baku"),
  })
  .refine((s) => !s.startAt || !s.endAt || s.endAt > s.startAt, { message: "END_BEFORE_START", path: ["endAt"] });
export type Schedule = z.infer<typeof scheduleSchema>;

export const targetsSchema = z.object({
  groupIds: z.array(z.string().min(1).max(32)).max(100).default([]),
  studentIds: z.array(z.number().int().positive()).max(1000).default([]),
});
export type Targets = z.infer<typeof targetsSchema>;

/** Optional per-assignment overrides of the assessment defaults. */
export const assignmentOverridesSchema = z.object({
  availableFrom: timestampDate().nullable().default(null),
  availableUntil: timestampDate().nullable().default(null),
  durationSeconds: z.number().int().min(60).max(60 * 60 * 12).nullable().default(null),
  attemptsAllowed: z.number().int().min(1).max(20).nullable().default(null),
});
export type AssignmentOverrides = z.infer<typeof assignmentOverridesSchema>;
