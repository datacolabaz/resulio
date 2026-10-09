import { z } from "zod";
import { DIFFICULTIES, questionInputSchema, type QuestionInput } from "../../shared/assessment";
import { ENV } from "../_core/env";
import { invokeLLM } from "../_core/llm";
import { withAiUsage } from "../aiUsage/context";
import { assertAiAllowed } from "../aiUsage/limits";
import { createBankQuestion } from "../questionBank/bank";
import { guardBankTables, ownedSection } from "../questionBank/topics";
import { store } from "../resulioStore";
import { addQuestionToAssessment, ownedAssessment } from "./assessments";
import type { TeacherScope } from "./access";
import { providerAlertFor, sendAiAlert } from "./aiAlerts";
import { AppError } from "./errors";

export const AI_QUESTION_TYPES = ["MULTIPLE_CHOICE", "MULTIPLE_SELECT", "TRUE_FALSE", "SHORT_ANSWER", "FILL_BLANK", "NUMERIC"] as const;

export const aiGenerateSchema = z.object({
  topic: z.string().trim().min(2).max(200),
  grade: z.string().trim().max(40).default(""),
  language: z.enum(["az", "ru", "en", "de"]).default("az"),
  difficulty: z.enum(DIFFICULTIES).default("MEDIUM"),
  questionType: z.enum(AI_QUESTION_TYPES),
  count: z.number().int().min(1).max(10),
  points: z.number().positive().max(100).default(1),
});
export type AiGenerateInput = z.infer<typeof aiGenerateSchema>;

const SHAPES: Record<(typeof AI_QUESTION_TYPES)[number], string> = {
  MULTIPLE_CHOICE: `{"type":"MULTIPLE_CHOICE","text":"...","content":{"options":[{"key":"A","text":"..."},{"key":"B","text":"..."},{"key":"C","text":"..."},{"key":"D","text":"..."}]},"answerKey":{"correct":"B"},"explanation":"..."}`,
  MULTIPLE_SELECT: `{"type":"MULTIPLE_SELECT","text":"...","content":{"options":[{"key":"A","text":"..."},{"key":"B","text":"..."},{"key":"C","text":"..."},{"key":"D","text":"..."}]},"answerKey":{"correct":["A","C"]},"explanation":"..."}`,
  TRUE_FALSE: `{"type":"TRUE_FALSE","text":"...","content":{},"answerKey":{"correct":true},"explanation":"..."}`,
  SHORT_ANSWER: `{"type":"SHORT_ANSWER","text":"...","content":{},"answerKey":{"accepted":["...","..."],"caseSensitive":false},"explanation":"..."}`,
  FILL_BLANK: `{"type":"FILL_BLANK","text":"Sentence with ___ blanks","content":{"blankCount":1},"answerKey":{"blanks":[["answer","variant"]],"caseSensitive":false},"explanation":"..."}`,
  NUMERIC: `{"type":"NUMERIC","text":"...","content":{"unit":"m"},"answerKey":{"value":12.5,"tolerance":0},"explanation":"..."}`,
};

const LANGUAGE_NAMES = { az: "Azerbaijani", ru: "Russian", en: "English", de: "German" } as const;

export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Keep only questions that pass the same validation as manually authored ones. */
export function validateAiQuestions(raw: unknown, input: AiGenerateInput): QuestionInput[] {
  const list = Array.isArray((raw as { questions?: unknown })?.questions) ? (raw as { questions: unknown[] }).questions : [];
  const out: QuestionInput[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const parsed = questionInputSchema.safeParse({
      ...item,
      type: input.questionType,
      points: input.points,
      difficulty: input.difficulty,
      topic: input.topic.slice(0, 120),
      tags: ["ai"],
    });
    if (parsed.success) out.push(parsed.data);
    if (out.length >= input.count) break;
  }
  return out;
}

export async function generateQuestions(scope: TeacherScope, input: AiGenerateInput) {
  if (!ENV.llmConfigured) throw new AppError("AI_UNAVAILABLE");
  const usage = store.usageOf(scope.workspaceId);
  if (usage.used + input.count > usage.limit) throw new AppError("AI_USAGE_LIMIT_REACHED");
  await assertAiAllowed(scope.userId);

  const result = await withAiUsage({ feature: "QUESTION_GENERATE", userId: scope.userId, workspaceId: scope.workspaceId }, () => invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You write assessment questions for teachers. Reply with JSON only: {\"questions\":[...]}. " +
          `Every item must match exactly this shape: ${SHAPES[input.questionType]}. ` +
          "Keys of options are A, B, C, D. Answers must be unambiguous and factually correct.",
      },
      {
        role: "user",
        content:
          `Write ${input.count} ${input.questionType} questions about "${input.topic}"` +
          (input.grade ? ` for grade/level ${input.grade}` : "") +
          `, difficulty ${input.difficulty}, in ${LANGUAGE_NAMES[input.language]}.`,
      },
    ],
    responseFormat: { type: "json_object" },
  })).catch(async (error: unknown) => {
    const alert = providerAlertFor(error);
    if (alert) await sendAiAlert(scope.workspaceId, alert);
    throw error;
  });
  const content = result.choices[0]?.message?.content;
  const text = typeof content === "string" ? content : "";
  const questions = validateAiQuestions(extractJson(text), input);
  if (!questions.length) throw new AppError("AI_INVALID_OUTPUT");
  try {
    const { draft, usage: next } = store.addAiDraft(scope.workspaceId, questions);
    return { draftId: draft.id, questions: draft.questions, usage: next };
  } catch (error) {
    if (error instanceof Error && error.message === "AI_USAGE_LIMIT_REACHED") throw new AppError("AI_USAGE_LIMIT_REACHED");
    throw error;
  }
}

/** Accepted AI questions are filed in a bank section (source AI) and optionally added to a draft assessment. */
export async function acceptAiQuestions(scope: TeacherScope, draftId: string, tempIds: string[], sectionId: string, assessmentId?: string) {
  await guardBankTables(() => ownedSection(scope, sectionId));
  if (assessmentId) {
    const a = await ownedAssessment(scope, assessmentId);
    if (a.status === "CLOSED") throw new AppError("CLOSED");
  }
  let selected: QuestionInput[];
  try {
    selected = store.takeAiQuestions(scope.workspaceId, draftId, tempIds);
  } catch {
    throw new AppError("NOT_FOUND");
  }
  const created = [];
  for (const q of selected) {
    const row = await createBankQuestion(scope, q, { sectionId, source: "AI" });
    if (assessmentId) await addQuestionToAssessment(scope, assessmentId, row.id);
    created.push(row);
  }
  return created;
}