/**
 * Teacher-side preview of a stored question: the lettered options with the correct ones marked and
 * a one-line summary of the expected answer. Pure and tolerant of loosely-shaped JSON, so it can render
 * bank rows, draft rows, import items and AI drafts alike. Never use it for student payloads.
 */

export type PreviewOption = { key: string; letter: string; text: string; correct: boolean };

export type AnswerSummary =
  | { kind: "choice"; letters: string[] }
  | { kind: "boolean"; value: boolean }
  | { kind: "text"; value: string }
  | null;

export type QuestionPreview = { options: PreviewOption[]; answer: AnswerSummary };

type Loose = { type: string; content?: unknown; answerKey?: unknown };
type Entry = { key: string; text: string };

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHOICE_TYPES = new Set(["MULTIPLE_CHOICE", "MULTIPLE_SELECT"]);

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function entries(v: unknown): Entry[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw, i) => {
    if (typeof raw === "string") return { key: LETTERS[i] ?? String(i + 1), text: raw };
    const o = record(raw);
    return { key: String(o.key ?? LETTERS[i] ?? i + 1), text: String(o.text ?? "") };
  });
}

function textAnswer(q: Loose, content: Record<string, unknown>, key: Record<string, unknown>): string {
  switch (q.type) {
    case "SHORT_ANSWER":
      return strings(key.accepted).join(" / ");
    case "FILL_BLANK":
      return (Array.isArray(key.blanks) ? key.blanks : []).map((b) => strings(b).join(" / ")).join("; ");
    case "NUMERIC": {
      if (typeof key.value !== "number") return "";
      const tolerance = typeof key.tolerance === "number" && key.tolerance > 0 ? ` ± ${key.tolerance}` : "";
      const unit = typeof content.unit === "string" && content.unit ? ` ${content.unit}` : "";
      return `${key.value}${tolerance}${unit}`;
    }
    case "LONG_ANSWER":
      return typeof key.rubric === "string" ? key.rubric : "";
    case "MATCHING": {
      const right = new Map(entries(content.right).map((r) => [r.key, r.text]));
      const pairs = record(key.pairs);
      return entries(content.left)
        .map((l) => `${l.text} → ${right.get(String(pairs[l.key] ?? "")) ?? "?"}`)
        .join("; ");
    }
    case "ORDERING": {
      const items = new Map(entries(content.items).map((i) => [i.key, i.text]));
      return strings(key.order)
        .map((k) => items.get(k) ?? k)
        .join(" → ");
    }
    default:
      return "";
  }
}

export function questionPreview(q: Loose): QuestionPreview {
  const content = record(q.content);
  const key = record(q.answerKey);
  if (CHOICE_TYPES.has(q.type)) {
    const correct = new Set(Array.isArray(key.correct) ? strings(key.correct) : typeof key.correct === "string" ? [key.correct] : []);
    const options = entries(content.options).map((o, i) => ({ ...o, letter: LETTERS[i] ?? o.key, correct: correct.has(o.key) }));
    const letters = options.filter((o) => o.correct).map((o) => o.letter);
    return { options, answer: letters.length ? { kind: "choice", letters } : null };
  }
  if (q.type === "TRUE_FALSE") {
    return { options: [], answer: typeof key.correct === "boolean" ? { kind: "boolean", value: key.correct } : null };
  }
  const value = textAnswer(q, content, key);
  return { options: [], answer: value ? { kind: "text", value } : null };
}
