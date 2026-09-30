import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import type { StudentAnswer } from "@shared/assessment";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { useState } from "react";

export type RenderQuestion = {
  id: string;
  position: number;
  type: string;
  text: string;
  points: number;
  imageUrl?: string | null;
  options?: { key: string; text: string }[];
  left?: { key: string; text: string }[];
  right?: { key: string; text: string }[];
  items?: { key: string; text: string }[];
  blankCount?: number;
  unit?: string;
};

const optionText = (type: string, o: { key: string; text: string }) =>
  type === "TRUE_FALSE" ? (o.key === "TRUE" ? t("common.true") : t("common.false")) : o.text;

const optionBadge = (type: string, key: string) =>
  type === "TRUE_FALSE" ? (key === "TRUE" ? t("common.trueShort") : t("common.falseShort")) : key;

/**
 * Renders one question for answering. The question text labels the answer group, so assistive
 * technology announces the question, each option, and whether it is selected or disabled.
 * Correctness is never rendered here; review screens show it separately.
 */
export function QuestionRenderer({
  q,
  value,
  onChange,
  disabled,
}: {
  q: RenderQuestion;
  value: StudentAnswer | undefined;
  onChange: (v: StudentAnswer) => void;
  disabled?: boolean;
}) {
  const promptId = `q-${q.id}-prompt`;
  const hintId = `q-${q.id}-hint`;
  const name = `q-${q.id}`;

  return (
    <div className="space-y-4">
      <div id={promptId} className="whitespace-pre-wrap break-words text-base leading-relaxed">{q.text}</div>
      {q.imageUrl && <img src={q.imageUrl} alt="" className="max-h-72 rounded-xl border" />}

      {(q.type === "MULTIPLE_CHOICE" || q.type === "TRUE_FALSE") && (
        <div role="radiogroup" aria-labelledby={promptId} aria-disabled={disabled || undefined} className="grid gap-2">
          {(q.options ?? []).map((o) => {
            const selected = value === o.key;
            return (
              <label
                key={o.key}
                className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"} ${selected ? "border-link bg-info-surface ring-1 ring-link" : "border-input bg-card hover:bg-muted"}`}
              >
                <input
                  type="radio"
                  name={name}
                  value={o.key}
                  checked={selected}
                  disabled={disabled}
                  onChange={() => onChange(o.key)}
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${selected ? "border-link bg-link text-link-foreground" : "border-input"}`}
                >
                  {selected ? <Check className="h-3.5 w-3.5" /> : optionBadge(q.type, o.key)}
                </span>
                <span className="min-w-0 flex-1 break-words">
                  {q.type !== "TRUE_FALSE" && <span className="sr-only">{o.key}. </span>}
                  {optionText(q.type, o)}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {q.type === "MULTIPLE_SELECT" && (
        <div role="group" aria-labelledby={`${promptId} ${hintId}`} className="grid gap-2">
          <div id={hintId} className="text-xs text-muted-foreground">{t("renderer.multiHint")}</div>
          {(q.options ?? []).map((o) => {
            const list = Array.isArray(value) ? value : [];
            const selected = list.includes(o.key);
            return (
              <label
                key={o.key}
                className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"} ${selected ? "border-link bg-info-surface ring-1 ring-link" : "border-input bg-card hover:bg-muted"}`}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-link"
                  disabled={disabled}
                  checked={selected}
                  onChange={(e) => onChange(e.target.checked ? [...list, o.key] : list.filter((k) => k !== o.key))}
                />
                <span className="font-semibold">{o.key}</span>
                <span className="min-w-0 flex-1 break-words">{o.text}</span>
              </label>
            );
          })}
        </div>
      )}

      {q.type === "SHORT_ANSWER" && (
        <Input aria-labelledby={promptId} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} placeholder={t("renderer.shortPlaceholder")} />
      )}

      {q.type === "LONG_ANSWER" && (
        <Textarea aria-labelledby={promptId} disabled={disabled} rows={8} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} placeholder={t("renderer.longPlaceholder")} />
      )}

      {q.type === "NUMERIC" && (
        <div className="flex items-center gap-2">
          <Input
            aria-labelledby={promptId}
            disabled={disabled}
            inputMode="decimal"
            className="max-w-xs"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value.replace(/[^\d.,\-+eE]/g, ""))}
            placeholder={t("renderer.numberPlaceholder")}
          />
          {q.unit && <span className="text-sm text-muted-foreground">{q.unit}</span>}
        </div>
      )}

      {q.type === "FILL_BLANK" && (
        <div role="group" aria-labelledby={promptId} className="grid gap-2">
          {Array.from({ length: q.blankCount ?? 1 }, (_, i) => {
            const list = Array.isArray(value) ? value : [];
            return (
              <label key={i} className="flex items-center gap-2 text-sm">
                <span className="w-20 shrink-0 text-muted-foreground">{t("renderer.blank", { n: i + 1 })}</span>
                <Input
                  disabled={disabled}
                  value={list[i] ?? ""}
                  onChange={(e) => {
                    const next = Array.from({ length: q.blankCount ?? 1 }, (_, j) => list[j] ?? "");
                    next[i] = e.target.value;
                    onChange(next);
                  }}
                />
              </label>
            );
          })}
        </div>
      )}

      {q.type === "MATCHING" && (
        <div role="group" aria-labelledby={promptId} className="grid gap-2">
          {(q.left ?? []).map((l) => {
            const map = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
            return (
              <label key={l.key} className="grid items-center gap-2 rounded-xl border bg-card p-3 text-sm sm:grid-cols-2">
                <span className="break-words">{l.text}</span>
                <select
                  disabled={disabled}
                  aria-label={t("renderer.matchFor", { item: l.text })}
                  className="w-full rounded-lg border border-input bg-card px-3 py-2 text-foreground"
                  value={map[l.key] ?? ""}
                  onChange={(e) => {
                    const next = { ...map };
                    if (e.target.value) next[l.key] = e.target.value;
                    else delete next[l.key];
                    onChange(next);
                  }}
                >
                  <option value="">{t("renderer.choose")}</option>
                  {(q.right ?? []).map((r) => <option key={r.key} value={r.key}>{r.text}</option>)}
                </select>
              </label>
            );
          })}
        </div>
      )}

      {q.type === "ORDERING" && <OrderingInput q={q} value={value} onChange={onChange} disabled={disabled} promptId={promptId} />}
    </div>
  );
}

function OrderingInput({
  q,
  value,
  onChange,
  disabled,
  promptId,
}: {
  q: RenderQuestion;
  value: StudentAnswer | undefined;
  onChange: (v: StudentAnswer) => void;
  disabled?: boolean;
  promptId: string;
}) {
  const items = q.items ?? [];
  const [announcement, setAnnouncement] = useState("");
  const order = Array.isArray(value) && value.length === items.length ? value : items.map((i) => i.key);
  const textOf = (key: string) => items.find((it) => it.key === key)?.text ?? key;
  const move = (i: number, dir: -1 | 1) => {
    const next = [...order];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setAnnouncement(t("renderer.orderAnnounce", { item: textOf(String(next[j])), n: j + 1 }));
  };
  return (
    <div role="group" aria-labelledby={promptId} className="grid gap-2">
      <div className="text-xs text-muted-foreground">
        {t("renderer.orderingHint")}
        {!Array.isArray(value) && ` ${t("renderer.orderingUnanswered")}`}
      </div>
      <ol className="grid gap-2">
        {order.map((key, i) => {
          const text = textOf(String(key));
          return (
            <li key={key} className="flex items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm">
              <span className="w-6 shrink-0 text-muted-foreground" aria-hidden>{i + 1}.</span>
              <span className="min-w-0 flex-1 break-words">{text}</span>
              <button
                type="button"
                disabled={disabled || i === 0}
                onClick={() => move(i, -1)}
                className="rounded p-1 hover:bg-muted disabled:cursor-not-allowed disabled:text-border-strong disabled:hover:bg-transparent"
                aria-label={t("renderer.moveUp", { item: text })}
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                disabled={disabled || i === order.length - 1}
                onClick={() => move(i, 1)}
                className="rounded p-1 hover:bg-muted disabled:cursor-not-allowed disabled:text-border-strong disabled:hover:bg-transparent"
                aria-label={t("renderer.moveDown", { item: text })}
              >
                <ArrowDown className="h-4 w-4" aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
      {!Array.isArray(value) && !disabled && (
        <button type="button" className="self-start text-xs text-link underline-offset-4 hover:underline" onClick={() => onChange(order)}>
          {t("renderer.acceptOrder")}
        </button>
      )}
    </div>
  );
}
