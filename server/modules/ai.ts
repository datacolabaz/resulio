import { z } from "zod";
import { DIFFICULTIES, questionInputSchema, type QuestionInput } from "../../shared/assessment";
import { ENV } from "../_core/env";
import { invokeLLM, type MessageContent } from "../_core/llm";
import { withAiUsage } from "../aiUsage/context";
import { assertAiAllowed } from "../aiUsage/limits";
import { ALLOWED_FILE_TYPES, extensionOf, fileBytes, fileRow } from "./files";
import { filePart, pdfInputMode } from "./llmFileParts";
import { pdfPageTexts } from "../questionBank/pdf";
import { createBankQuestion } from "../questionBank/bank";
import { guardBankTables, ownedSection } from "../questionBank/topics";
import { store } from "../resulioStore";
import { extractDocument, renderDoc } from "./textExtract";
import { addQuestionToAssessment, ownedAssessment } from "./assessments";
import type { TeacherScope } from "./access";
import { providerAlertFor, sendAiAlert } from "./aiAlerts";
import { AppError } from "./errors";

export const AI_QUESTION_TYPES = ["MULTIPLE_CHOICE", "MULTIPLE_SELECT", "TRUE_FALSE", "SHORT_ANSWER", "FILL_BLANK", "NUMERIC"] as const;

/** An uploaded file (PDF/Word/PowerPoint/CSV/Excel/image) or pasted text to ground generation in --
 *  see `sourceMaterialOf`. At most one of the two is used; `fileId` wins if both are sent. */
export const aiSourceSchema = z.object({
  fileId: z.string().trim().min(1).max(32).optional(),
  text: z.string().trim().max(20_000).optional(),
});
export type AiSourceInput = z.infer<typeof aiSourceSchema>;

export const aiGenerateSchema = z.object({
  topic: z.string().trim().min(2).max(200),
  grade: z.string().trim().max(40).default(""),
  language: z.enum(["az", "ru", "en", "de"]).default("az"),
  difficulty: z.enum(DIFFICULTIES).default("MEDIUM"),
  questionType: z.enum(AI_QUESTION_TYPES),
  count: z.number().int().min(1).max(10),
  points: z.number().positive().max(100).default(1),
  /** When set, questions must be grounded in this material instead of the model's own knowledge. */
  source: aiSourceSchema.optional(),
});
export type AiGenerateInput = z.infer<typeof aiGenerateSchema>;

/** Extensions `sourceMaterialOf` can turn into plain text via the existing text-extraction module. */
const TEXT_EXTRACT_EXTENSIONS = new Set([".docx", ".pptx", ".csv", ".xlsx", ".txt"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
/** Keeps the prompt (and the token bill) bounded; a few thousand words is plenty of source material
 *  for a handful of questions, and anything longer is almost always more material than the teacher
 *  meant to hand over in one go. */
const MAX_SOURCE_CHARS = 20_000;

/** Source material as the model will see it: inline text, or message parts (a native PDF/image) for
 *  providers that can read files directly. */
export type SourceMaterial = { kind: "text"; text: string } | { kind: "parts"; parts: MessageContent[] };

/**
 * The extension-dispatch core of `sourceMaterialOf`, pulled out so it's testable without a
 * database or real file storage: given the bytes of an already-fetched upload, decide how to hand
 * them to the model. Reuses the same extraction building blocks as question import
 * (textExtract.ts, questionBank/pdf.ts) and the provider-aware file-part logic shared with it
 * (llmFileParts.ts) -- no new parsing code, only a new "generate from this" use of the existing one.
 */
export async function sourceMaterialFromFile(fileName: string, bytes: Buffer): Promise<SourceMaterial> {
  const ext = extensionOf(fileName);

  if (IMAGE_EXTENSIONS.has(ext)) {
    return { kind: "parts", parts: [filePart(ALLOWED_FILE_TYPES[ext], new Uint8Array(bytes), fileName, ENV.llm)] };
  }
  if (ext === ".pdf") {
    if (pdfInputMode(ENV.llm, "") === "native") {
      return { kind: "parts", parts: [filePart("application/pdf", new Uint8Array(bytes), fileName, ENV.llm)] };
    }
    const pages = await pdfPageTexts(new Uint8Array(bytes));
    if (!pages.some((p) => p.trim())) throw new AppError("AI_SOURCE_UNREADABLE");
    return { kind: "text", text: pages.join("\n\n").slice(0, MAX_SOURCE_CHARS) };
  }
  if (TEXT_EXTRACT_EXTENSIONS.has(ext)) {
    const result = extractDocument(fileName, bytes);
    if (!result.ok) throw new AppError("AI_SOURCE_UNREADABLE");
    const text = renderDoc(result.doc);
    if (!text.trim()) throw new AppError("AI_SOURCE_UNREADABLE");
    return { kind: "text", text: text.slice(0, MAX_SOURCE_CHARS) };
  }
  // Legacy .doc/.xls/.ppt and anything else ALLOWED_FILE_TYPES doesn't already extract text from.
  throw new AppError("AI_SOURCE_FILE_TYPE");
}

/**
 * Resolves `AiGenerateInput["source"]` into something to hand the model. Returns null when no
 * source was given, so `generateQuestions` can fall back to its original topic-only prompt
 * unchanged. Pasted text needs no file lookup; a `fileId` must belong to the teacher's own
 * workspace (the same ownership check question import uses) before anything is read from it.
 */
export async function sourceMaterialOf(scope: TeacherScope, source: AiSourceInput | undefined): Promise<SourceMaterial | null> {
  if (!source) return null;
  if (source.text) return { kind: "text", text: source.text.slice(0, MAX_SOURCE_CHARS) };
  if (!source.fileId) return null;

  const file = await fileRow(source.fileId);
  if (!file || file.workspaceId !== scope.workspaceId) throw new AppError("FILE_NOT_FOUND");
  return sourceMaterialFromFile(file.fileName, await fileBytes(file));
}

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

/** Added to the system prompt only when `source` material was given -- the default (no source)
 *  prompt below is untouched, so existing topic-only generation behaves exactly as before. */
const GROUNDING_RULE =
  " The teacher has attached MATERIAL for you to write these questions from. " +
  "Use ONLY facts, statements, numbers and names that literally appear in that MATERIAL -- never your own outside knowledge for the content, the correct answer, or the explanation. " +
  "If the MATERIAL doesn't contain enough distinct content for the requested count, return fewer correct questions instead of inventing content to reach it.";

function userInstruction(input: AiGenerateInput, grounded: boolean) {
  return (
    `Write ${input.count} ${input.questionType} questions about "${input.topic}"` +
    (input.grade ? ` for grade/level ${input.grade}` : "") +
    `, difficulty ${input.difficulty}, in ${LANGUAGE_NAMES[input.language]}.` +
    (grounded ? " Base every question strictly on the MATERIAL below/attached." : "")
  );
}

export async function generateQuestions(scope: TeacherScope, input: AiGenerateInput) {
  if (!ENV.llmConfigured) throw new AppError("AI_UNAVAILABLE");
  const usage = store.usageOf(scope.workspaceId);
  if (usage.used + input.count > usage.limit) throw new AppError("AI_USAGE_LIMIT_REACHED");
  await assertAiAllowed(scope.userId);

  const material = await sourceMaterialOf(scope, input.source);
  const instruction = userInstruction(input, !!material);
  const userContent: MessageContent[] | string = !material
    ? instruction
    : material.kind === "text"
      ? [{ type: "text", text: `${instruction}\n\nMATERIAL:\n${material.text}` }]
      : [{ type: "text", text: instruction }, ...material.parts];

  const result = await withAiUsage({ feature: "QUESTION_GENERATE", userId: scope.userId, workspaceId: scope.workspaceId }, () => invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You write assessment questions for teachers. Reply with JSON only: {\"questions\":[...]}. " +
          `Every item must match exactly this shape: ${SHAPES[input.questionType]}. ` +
          "Keys of options are A, B, C, D. Answers must be unambiguous and factually correct." +
          (material ? GROUNDING_RULE : ""),
      },
      {
        role: "user",
        content: userContent,
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