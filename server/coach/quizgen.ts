import { z } from "zod";
import { questionInputSchema, type AnswerKey, type QuestionContent, type QuestionType } from "../../shared/assessment";
import { FORMAT_TYPES, type CalcSpec, type Cite, type CoachLocale, type QuizFormat } from "../../shared/coach";
import type { Message } from "../_core/llm";
import { seededShuffle } from "../modules/engine";
import { DATA_RULE, languageRule, materialBlock, type PromptChunk } from "./ai";
import { checkCalc } from "./calc";
import { foldText, verifyCites, type RetrievalChunk } from "./retrieval";

/**
 * Practice questions from a topic's chunks (pure): the prompt, the model's raw shape, and the
 * conversion to the assessment engine's question types, validated with the same schema teachers'
 * questions use. Option order is shuffled on the server so the key is not always "A".
 */

const rawQuestion = z.object({
  type: z.string(),
  text: z.string(),
  options: z.array(z.string()).max(8).optional(),
  correctIndex: z.number().optional(),
  correct: z.boolean().optional(),
  accepted: z.array(z.string()).max(10).optional(),
  pairs: z.array(z.object({ left: z.string(), right: z.string() })).max(8).optional(),
  value: z.number().optional(),
  tolerance: z.number().optional(),
  unit: z.string().optional(),
  formula: z.string().optional(),
  variables: z.record(z.string(), z.number()).optional(),
  rubric: z.string().optional(),
  explanation: z.string().optional(),
  hint: z.string().optional(),
  cites: z.array(z.object({ chunk: z.string(), quote: z.string() })).max(4).optional(),
});
export const quizSchema = z.object({ questions: z.array(rawQuestion).max(30) });
export type RawQuestion = z.infer<typeof rawQuestion>;

export const quizJsonSchema = {
  name: "coach_quiz",
  schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string" },
            text: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            correctIndex: { type: "integer" },
            correct: { type: "boolean" },
            accepted: { type: "array", items: { type: "string" } },
            pairs: { type: "array", items: { type: "object", properties: { left: { type: "string" }, right: { type: "string" } }, required: ["left", "right"] } },
            value: { type: "number" },
            tolerance: { type: "number" },
            unit: { type: "string" },
            formula: { type: "string" },
            variables: { type: "object", additionalProperties: { type: "number" } },
            rubric: { type: "string" },
            explanation: { type: "string" },
            hint: { type: "string" },
            cites: { type: "array", items: { type: "object", properties: { chunk: { type: "string" }, quote: { type: "string" } }, required: ["chunk", "quote"] } },
          },
          required: ["type", "text", "explanation", "hint", "cites"],
        },
      },
    },
    required: ["questions"],
  },
};

const TYPE_RULES: Record<string, string> = {
  MULTIPLE_CHOICE: 'MULTIPLE_CHOICE: `options` (4 plausible choices, one correct), `correctIndex` (0-based).',
  TRUE_FALSE: "TRUE_FALSE: a statement in `text`, `correct` true/false. Mix true and false statements.",
  SHORT_ANSWER: "SHORT_ANSWER: answer is a word, term, name or short phrase; `accepted`: 1-5 accepted spellings/variants.",
  MATCHING: "MATCHING: `pairs`: 3-5 {left, right} pairs (terms ↔ definitions, causes ↔ effects).",
  NUMERIC: "NUMERIC: a calculation; `value` (the answer), `tolerance` (absolute, e.g. rounding), optional `unit`, plus `formula` (plain arithmetic over the names in `variables`: + - * / ^ ( ), sqrt, abs, ln, log, sin, cos, tan, pi; e.g. \"m*a\") and `variables` {name: number} that reproduce `value` exactly.",
  LONG_ANSWER: "LONG_ANSWER: an open question needing 2-6 sentences; `rubric`: 2-5 short points a full answer must cover, one per line.",
};

export function quizMessages(input: { format: QuizFormat; count: number; topicTitle: string; chunks: PromptChunk[]; locale: CoachLocale; nonce: string; avoid?: string[] }): Message[] {
  const types = FORMAT_TYPES[input.format];
  return [
    {
      role: "system",
      content: [
        `You write ${input.count} practice questions for one student, only about what the material below covers.`,
        `Question types to use: ${types.join(", ")}${types.length > 1 ? " (mix them)" : ""}.`,
        ...types.map((t) => TYPE_RULES[t]),
        "Every question: `explanation` (why the answer is right, 1-3 sentences), `hint` (a nudge that does not give the answer away), `cites` (chunk label like C2 and a quote of 8-25 words copied exactly from that chunk).",
        "Test understanding, not trivia; vary difficulty from easy to hard; no two questions about the same fact; never \"all of the above\".",
        input.avoid?.length ? `Do not repeat these earlier questions: ${input.avoid.slice(0, 15).map((q) => JSON.stringify(q.slice(0, 120))).join("; ")}` : "",
        languageRule(input.locale),
        DATA_RULE,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { role: "user", content: `Topic: ${input.topicTitle}\n\n${materialBlock(input.chunks, input.nonce)}` },
  ];
}

export interface DraftItem {
  type: QuestionType;
  text: string;
  content: QuestionContent;
  answerKey: AnswerKey;
  explanation: string | null;
  hint: string | null;
  cites: Cite[];
  calc: CalcSpec | null;
}

const clean = (s: string | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const letters = "ABCDEFGH";

/** One raw question as an engine question, or null when it is unusable. `seed` fixes the option order. */
export function toDraftItem(raw: RawQuestion, allowed: readonly string[], byLabel: Map<string, RetrievalChunk>, seed: string): DraftItem | null {
  const type = raw.type.trim().toUpperCase() as QuestionType;
  if (!allowed.includes(type)) return null;
  const text = clean(raw.text, 2000);
  if (text.length < 8) return null;
  let content: unknown = {};
  let answerKey: unknown;
  let calc: CalcSpec | null = null;
  switch (type) {
    case "MULTIPLE_CHOICE": {
      const options = (raw.options ?? []).map((o) => clean(o, 500)).filter(Boolean);
      const ci = Math.trunc(Number(raw.correctIndex));
      if (options.length < 3 || !(ci >= 0 && ci < options.length) || new Set(options.map(foldText)).size !== options.length) return null;
      const order = seededShuffle(options.map((_, i) => i), seed);
      content = { options: order.map((i, k) => ({ key: letters[k], text: options[i] })) };
      answerKey = { correct: letters[order.indexOf(ci)] };
      break;
    }
    case "TRUE_FALSE":
      if (typeof raw.correct !== "boolean") return null;
      answerKey = { correct: raw.correct };
      break;
    case "SHORT_ANSWER": {
      const accepted = [...new Set((raw.accepted ?? []).map((a) => clean(a, 200)).filter(Boolean))];
      if (!accepted.length) return null;
      answerKey = { accepted, caseSensitive: false };
      break;
    }
    case "MATCHING": {
      const pairs = (raw.pairs ?? []).map((p) => ({ left: clean(p.left, 300), right: clean(p.right, 300) })).filter((p) => p.left && p.right);
      if (pairs.length < 3 || new Set(pairs.map((p) => foldText(p.right))).size !== pairs.length) return null;
      content = { left: pairs.map((p, i) => ({ key: `L${i + 1}`, text: p.left })), right: pairs.map((p, i) => ({ key: `R${i + 1}`, text: p.right })) };
      answerKey = { pairs: Object.fromEntries(pairs.map((_, i) => [`L${i + 1}`, `R${i + 1}`])) };
      break;
    }
    case "NUMERIC": {
      const value = Number(raw.value);
      if (!Number.isFinite(value)) return null;
      const tolerance = Math.max(Math.abs(Number(raw.tolerance) || 0), Math.abs(value) * 0.005);
      const unit = clean(raw.unit, 32);
      content = unit ? { unit } : {};
      answerKey = { value, tolerance: Number(tolerance.toPrecision(6)) };
      if (raw.formula) {
        const spec = { formula: clean(raw.formula, 300), variables: raw.variables ?? {} };
        const { verdict } = checkCalc(spec, value, tolerance);
        // A key its own formula contradicts is unreliable: drop the question rather than mark students wrong.
        if (verdict === "mismatch") return null;
        calc = { ...spec, ...(unit ? { unit } : {}), verified: verdict === "verified" };
      }
      break;
    }
    case "LONG_ANSWER": {
      const rubric = (raw.rubric ?? "").trim().slice(0, 2000);
      answerKey = rubric ? { rubric } : {};
      break;
    }
    default:
      return null;
  }
  const parsed = questionInputSchema.safeParse({ type, text, points: 1, content, answerKey });
  if (!parsed.success) return null;
  return {
    type,
    text,
    content: parsed.data.content,
    answerKey: parsed.data.answerKey,
    explanation: clean(raw.explanation, 1500) || null,
    hint: clean(raw.hint, 500) || null,
    cites: verifyCites(raw.cites, byLabel),
    calc,
  };
}

/** Usable, distinct questions, at most `count`. */
export function draftItems(raws: RawQuestion[], format: QuizFormat, count: number, byLabel: Map<string, RetrievalChunk>, seed: string): DraftItem[] {
  const allowed = FORMAT_TYPES[format];
  const seen = new Set<string>();
  const out: DraftItem[] = [];
  raws.forEach((raw, i) => {
    if (out.length >= count) return;
    const item = toDraftItem(raw, allowed, byLabel, `${seed}:${i}`);
    if (!item) return;
    const key = foldText(item.text);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  });
  return out;
}

/** Fewer than half of what was asked means the generation failed. */
export const enoughItems = (got: number, asked: number) => got >= Math.ceil(asked / 2);
