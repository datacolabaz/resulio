import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isMessageKey, t } from "@/i18n/messages";
import { questionTypeLabel } from "@/lib/format";
import { QUESTION_TYPES, questionInputSchema, type QuestionInput, type QuestionType } from "@shared/assessment";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";

type Choice = { key: string; text: string };
type Pair = { left: string; right: string };

type Draft = {
  type: QuestionType;
  text: string;
  points: number;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  topic: string;
  skill: string;
  explanation: string;
  options: Choice[];
  correct: string[];
  tf: boolean;
  accepted: string;
  caseSensitive: boolean;
  rubric: string;
  pairs: Pair[];
  items: string[];
  blanks: string[];
  numericValue: string;
  tolerance: string;
  unit: string;
};

const LETTERS = "ABCDEFGHIJ";
const BLANK = /_{3,}/g;

const emptyDraft = (type: QuestionType): Draft => ({
  type,
  text: "",
  points: 1,
  difficulty: "MEDIUM",
  topic: "",
  skill: "",
  explanation: "",
  options: [{ key: "A", text: "" }, { key: "B", text: "" }, { key: "C", text: "" }, { key: "D", text: "" }],
  correct: [],
  tf: true,
  accepted: "",
  caseSensitive: false,
  rubric: "",
  pairs: [{ left: "", right: "" }, { left: "", right: "" }, { left: "", right: "" }],
  items: ["", "", ""],
  blanks: [""],
  numericValue: "",
  tolerance: "0",
  unit: "",
});

/** Load a stored question (bank row or QuestionInput) into editor state. */
export function draftFromQuestion(q: { type: string; text: string; points: number; difficulty: string; topic: string; skill?: string; explanation?: string | null; content: unknown; answerKey: unknown }): Draft {
  const d = emptyDraft(q.type as QuestionType);
  const c = (q.content ?? {}) as Record<string, any>;
  const k = (q.answerKey ?? {}) as Record<string, any>;
  Object.assign(d, {
    text: q.text,
    points: q.points,
    difficulty: q.difficulty,
    topic: q.topic ?? "",
    skill: q.skill ?? "",
    explanation: q.explanation ?? "",
  });
  switch (q.type) {
    case "MULTIPLE_CHOICE":
    case "MULTIPLE_SELECT":
      d.options = c.options ?? d.options;
      d.correct = Array.isArray(k.correct) ? k.correct : k.correct ? [k.correct] : [];
      break;
    case "TRUE_FALSE":
      d.tf = Boolean(k.correct);
      break;
    case "SHORT_ANSWER":
      d.accepted = (k.accepted ?? []).join("\n");
      d.caseSensitive = Boolean(k.caseSensitive);
      break;
    case "LONG_ANSWER":
      d.rubric = k.rubric ?? "";
      break;
    case "MATCHING":
      d.pairs = (c.left ?? []).map((l: Choice) => ({
        left: l.text,
        right: (c.right ?? []).find((r: Choice) => r.key === k.pairs?.[l.key])?.text ?? "",
      }));
      break;
    case "ORDERING":
      d.items = (k.order ?? []).map((key: string) => (c.items ?? []).find((i: Choice) => i.key === key)?.text ?? "");
      break;
    case "FILL_BLANK":
      d.blanks = (k.blanks ?? []).map((b: string[]) => b.join(", "));
      d.caseSensitive = Boolean(k.caseSensitive);
      break;
    case "NUMERIC":
      d.numericValue = String(k.value ?? "");
      d.tolerance = String(k.tolerance ?? 0);
      d.unit = c.unit ?? "";
      break;
  }
  return d;
}

const splitList = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function toInput(d: Draft): unknown {
  const base = {
    text: d.text,
    points: Number(d.points),
    difficulty: d.difficulty,
    topic: d.topic,
    skill: d.skill,
    tags: [],
    explanation: d.explanation.trim() || undefined,
  };
  const options = d.options.filter((o) => o.text.trim());
  switch (d.type) {
    case "MULTIPLE_CHOICE":
      return { ...base, type: d.type, content: { options }, answerKey: { correct: d.correct[0] ?? "" } };
    case "MULTIPLE_SELECT":
      return { ...base, type: d.type, content: { options }, answerKey: { correct: d.correct.filter((c) => options.some((o) => o.key === c)) } };
    case "TRUE_FALSE":
      return { ...base, type: d.type, content: {}, answerKey: { correct: d.tf } };
    case "SHORT_ANSWER":
      return { ...base, type: d.type, content: {}, answerKey: { accepted: splitList(d.accepted), caseSensitive: d.caseSensitive } };
    case "LONG_ANSWER":
      return { ...base, type: d.type, content: {}, answerKey: d.rubric.trim() ? { rubric: d.rubric.trim() } : {} };
    case "MATCHING": {
      const rows = d.pairs.filter((p) => p.left.trim() && p.right.trim());
      return {
        ...base,
        type: d.type,
        content: {
          left: rows.map((p, i) => ({ key: `L${i + 1}`, text: p.left })),
          right: rows.map((p, i) => ({ key: `R${i + 1}`, text: p.right })),
        },
        answerKey: { pairs: Object.fromEntries(rows.map((_, i) => [`L${i + 1}`, `R${i + 1}`])) },
      };
    }
    case "ORDERING": {
      const items = d.items.filter((i) => i.trim()).map((text, i) => ({ key: `I${i + 1}`, text }));
      return { ...base, type: d.type, content: { items }, answerKey: { order: items.map((i) => i.key) } };
    }
    case "FILL_BLANK": {
      const blankCount = Math.max(1, (d.text.match(BLANK) ?? []).length);
      return {
        ...base,
        type: d.type,
        content: { blankCount },
        answerKey: { blanks: d.blanks.slice(0, blankCount).map(splitList), caseSensitive: d.caseSensitive },
      };
    }
    case "NUMERIC":
      return {
        ...base,
        type: d.type,
        content: d.unit.trim() ? { unit: d.unit.trim() } : {},
        answerKey: { value: Number(d.numericValue.replace(",", ".")), tolerance: Number(d.tolerance.replace(",", ".")) || 0 },
      };
  }
}

function issueText(issue: { message: string; path: PropertyKey[] } | undefined) {
  const key = `editor.issue.${issue?.message ?? ""}`;
  if (isMessageKey(key)) return t(key);
  return t("editor.issue.generic", { path: issue?.path.map(String).join(".") ?? "", message: issue?.message ?? "" });
}

const selectClass = "mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-foreground";
const label = "text-foreground-secondary";
const iconButton = "rounded p-1 text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:text-border-strong disabled:hover:bg-transparent";
const removeButton = "rounded p-1 text-muted-foreground hover:bg-danger-surface hover:text-destructive";

export function QuestionEditor({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  hideTopic,
}: {
  initial?: Draft;
  submitLabel?: string;
  busy?: boolean;
  onSubmit: (q: QuestionInput) => void | Promise<void>;
  onCancel?: () => void;
  /** The question is filed in a bank section chosen elsewhere; its topic text is the section name. */
  hideTopic?: boolean;
}) {
  const uid = useId();
  const [d, setD] = useState<Draft>(initial ?? emptyDraft("MULTIPLE_CHOICE"));
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((cur) => ({ ...cur, [key]: value }));
  const blankCount = Math.max(1, (d.text.match(BLANK) ?? []).length);

  const submit = async () => {
    const parsed = questionInputSchema.safeParse(toInput(d));
    if (!parsed.success) {
      setError(issueText(parsed.error.issues[0]));
      return;
    }
    setError(null);
    await onSubmit(parsed.data);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-sm sm:col-span-2">
          <span className={label}>{t("editor.type")}</span>
          <select
            className={selectClass}
            value={d.type}
            onChange={(e) => setD({ ...emptyDraft(e.target.value as QuestionType), text: d.text, points: d.points, topic: d.topic, skill: d.skill, difficulty: d.difficulty })}
          >
            {QUESTION_TYPES.map((type) => <option key={type} value={type}>{questionTypeLabel(type)}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className={label}>{t("editor.points")}</span>
          <Input type="number" min={0.5} step={0.5} value={d.points} onChange={(e) => set("points", Number(e.target.value))} />
        </label>
        <label className="text-sm">
          <span className={label}>{t("common.difficulty")}</span>
          <select className={selectClass} value={d.difficulty} onChange={(e) => set("difficulty", e.target.value as Draft["difficulty"])}>
            {(["EASY", "MEDIUM", "HARD"] as const).map((v) => <option key={v} value={v}>{t(`common.difficulty.${v}`)}</option>)}
          </select>
        </label>
      </div>

      <label className="block text-sm">
        <span className={label}>{d.type === "FILL_BLANK" ? t("editor.textBlanks") : t("editor.text")}</span>
        <Textarea rows={3} value={d.text} onChange={(e) => set("text", e.target.value)} />
      </label>

      {(d.type === "MULTIPLE_CHOICE" || d.type === "MULTIPLE_SELECT") && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm text-foreground-secondary">{d.type === "MULTIPLE_SELECT" ? t("editor.optionsMulti") : t("editor.optionsSingle")}</legend>
          {d.options.map((o, i) => (
            <div key={o.key} className="flex items-center gap-2">
              <input
                type={d.type === "MULTIPLE_SELECT" ? "checkbox" : "radio"}
                name={`${uid}-correct`}
                className="accent-link"
                aria-label={t("editor.optionCorrect", { key: o.key })}
                checked={d.correct.includes(o.key)}
                onChange={(e) =>
                  set(
                    "correct",
                    d.type === "MULTIPLE_SELECT"
                      ? e.target.checked ? [...d.correct, o.key] : d.correct.filter((c) => c !== o.key)
                      : [o.key],
                  )
                }
              />
              <span className="w-5 text-sm font-semibold" aria-hidden>{o.key}</span>
              <Input aria-label={t("editor.optionText", { key: o.key })} value={o.text} onChange={(e) => set("options", d.options.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              {d.options.length > 2 && (
                <button
                  type="button"
                  className={removeButton}
                  onClick={() => {
                    const rest = d.options.filter((_, j) => j !== i).map((x, j) => ({ ...x, key: LETTERS[j] }));
                    setD({ ...d, options: rest, correct: [] });
                  }}
                  aria-label={t("editor.removeOption", { key: o.key })}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              )}
            </div>
          ))}
          {d.options.length < 10 && (
            <Button type="button" variant="outline" size="sm" onClick={() => set("options", [...d.options, { key: LETTERS[d.options.length], text: "" }])}>
              <Plus className="mr-1 h-4 w-4" aria-hidden /> {t("editor.addOption")}
            </Button>
          )}
        </fieldset>
      )}

      {d.type === "TRUE_FALSE" && (
        <fieldset className="flex gap-4 text-sm">
          <legend className="sr-only">{t("editor.numericValue")}</legend>
          <label className="flex items-center gap-2"><input type="radio" name={`${uid}-tf`} className="accent-link" checked={d.tf} onChange={() => set("tf", true)} /> {t("common.true")}</label>
          <label className="flex items-center gap-2"><input type="radio" name={`${uid}-tf`} className="accent-link" checked={!d.tf} onChange={() => set("tf", false)} /> {t("common.false")}</label>
        </fieldset>
      )}

      {d.type === "SHORT_ANSWER" && (
        <div className="space-y-2">
          <label className="block text-sm">
            <span className={label}>{t("editor.accepted")}</span>
            <Textarea rows={3} value={d.accepted} onChange={(e) => set("accepted", e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-link" checked={d.caseSensitive} onChange={(e) => set("caseSensitive", e.target.checked)} /> {t("editor.caseSensitive")}</label>
        </div>
      )}

      {d.type === "LONG_ANSWER" && (
        <label className="block text-sm">
          <span className={label}>{t("editor.rubric")}</span>
          <Textarea rows={3} value={d.rubric} onChange={(e) => set("rubric", e.target.value)} />
          <span className="mt-1 block text-xs text-muted-foreground">{t("editor.rubricNote")}</span>
        </label>
      )}

      {d.type === "MATCHING" && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm text-foreground-secondary">{t("editor.pairs")}</legend>
          {d.pairs.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input placeholder={t("editor.left")} aria-label={t("editor.pairLeft", { n: i + 1 })} value={p.left} onChange={(e) => set("pairs", d.pairs.map((x, j) => (j === i ? { ...x, left: e.target.value } : x)))} />
              <span className="text-muted-foreground" aria-hidden>→</span>
              <Input placeholder={t("editor.right")} aria-label={t("editor.pairRight", { n: i + 1 })} value={p.right} onChange={(e) => set("pairs", d.pairs.map((x, j) => (j === i ? { ...x, right: e.target.value } : x)))} />
              {d.pairs.length > 2 && (
                <button type="button" className={removeButton} onClick={() => set("pairs", d.pairs.filter((_, j) => j !== i))} aria-label={t("editor.removePair", { n: i + 1 })}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              )}
            </div>
          ))}
          {d.pairs.length < 12 && (
            <Button type="button" variant="outline" size="sm" onClick={() => set("pairs", [...d.pairs, { left: "", right: "" }])}>
              <Plus className="mr-1 h-4 w-4" aria-hidden /> {t("editor.addPair")}
            </Button>
          )}
        </fieldset>
      )}

      {d.type === "ORDERING" && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm text-foreground-secondary">{t("editor.ordering")}</legend>
          {d.items.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-5 text-sm text-muted-foreground" aria-hidden>{i + 1}.</span>
              <Input aria-label={t("editor.item", { n: i + 1 })} value={item} onChange={(e) => set("items", d.items.map((x, j) => (j === i ? e.target.value : x)))} />
              <button type="button" className={iconButton} disabled={i === 0} onClick={() => { const n = [...d.items]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set("items", n); }} aria-label={t("editor.itemUp", { n: i + 1 })}><ArrowUp className="h-4 w-4" aria-hidden /></button>
              <button type="button" className={iconButton} disabled={i === d.items.length - 1} onClick={() => { const n = [...d.items]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; set("items", n); }} aria-label={t("editor.itemDown", { n: i + 1 })}><ArrowDown className="h-4 w-4" aria-hidden /></button>
              {d.items.length > 2 && (
                <button type="button" className={removeButton} onClick={() => set("items", d.items.filter((_, j) => j !== i))} aria-label={t("editor.removeItem", { n: i + 1 })}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              )}
            </div>
          ))}
          {d.items.length < 12 && (
            <Button type="button" variant="outline" size="sm" onClick={() => set("items", [...d.items, ""])}>
              <Plus className="mr-1 h-4 w-4" aria-hidden /> {t("editor.addItem")}
            </Button>
          )}
        </fieldset>
      )}

      {d.type === "FILL_BLANK" && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm text-foreground-secondary">{t("editor.blanks", { count: blankCount })}</legend>
          {Array.from({ length: blankCount }, (_, i) => (
            <label key={i} className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-sm text-muted-foreground">{t("editor.blank", { n: i + 1 })}</span>
              <Input value={d.blanks[i] ?? ""} onChange={(e) => { const n = [...d.blanks]; n[i] = e.target.value; set("blanks", n); }} />
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-link" checked={d.caseSensitive} onChange={(e) => set("caseSensitive", e.target.checked)} /> {t("editor.caseSensitive")}</label>
        </fieldset>
      )}

      {d.type === "NUMERIC" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm"><span className={label}>{t("editor.numericValue")}</span><Input inputMode="decimal" value={d.numericValue} onChange={(e) => set("numericValue", e.target.value)} /></label>
          <label className="text-sm"><span className={label}>{t("editor.tolerance")}</span><Input inputMode="decimal" value={d.tolerance} onChange={(e) => set("tolerance", e.target.value)} /></label>
          <label className="text-sm"><span className={label}>{t("editor.unit")}</span><Input value={d.unit} onChange={(e) => set("unit", e.target.value)} /></label>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {!hideTopic && <label className="text-sm"><span className={label}>{t("common.topic")}</span><Input value={d.topic} onChange={(e) => set("topic", e.target.value)} placeholder={t("editor.topicPlaceholder")} /></label>}
        <label className="text-sm"><span className={label}>{t("common.skill")}</span><Input value={d.skill} onChange={(e) => set("skill", e.target.value)} placeholder={t("editor.skillPlaceholder")} /></label>
      </div>
      <label className="block text-sm">
        <span className={label}>{t("editor.explanation")}</span>
        <Textarea rows={2} value={d.explanation} onChange={(e) => set("explanation", e.target.value)} />
      </label>

      {error && <div role="alert" className="rounded-lg bg-danger-surface p-2 text-sm text-destructive">{error}</div>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>}
        <Button type="button" disabled={busy} onClick={() => void submit()}>{submitLabel ?? t("common.save")}</Button>
      </div>
    </div>
  );
}
