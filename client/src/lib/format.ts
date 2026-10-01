import { getLocale, isMessageKey, t } from "@/i18n/messages";
import { formatDateTime, formatDay, formatDuration, formatRelative, formatTime, type DateInput } from "@/lib/dates";

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const key = `error.${message}`;
  if (isMessageKey(key)) return t(key);
  return message && message.length < 120 ? message : t("error.INTERNAL_ERROR");
}

export const fmtDateTime = (value: DateInput) => formatDateTime(value, getLocale());
export const fmtDay = (value: DateInput) => formatDay(value, getLocale());
export const fmtTime = (value: DateInput) => formatTime(value, getLocale());
export const fmtRelative = (value: DateInput, now: DateInput = Date.now()) => formatRelative(value, getLocale(), now);
export const fmtDuration = (seconds: number | null | undefined) => formatDuration(seconds, getLocale());

/** Countdown text for the exam timer, e.g. 04:59 or 1:02:03. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** "start – end", or the "unlimited" label when neither bound is set. */
export function fmtWindow(start: DateInput, end: DateInput): string {
  return start || end ? `${fmtDateTime(start)} – ${fmtDateTime(end)}` : t("assessment.unlimitedWindow");
}

/** Value for <input type="datetime-local"> in the browser's local time. */
export function toLocalInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function label(prefix: string, value: string | null | undefined): string {
  if (!value) return "—";
  const key = `${prefix}.${value}`;
  return isMessageKey(key) ? t(key) : value;
}

export const typeLabel = (v: string | null | undefined) => label("assessmentType", v);
export const liveLabel = (v: string | null | undefined) => label("live", v);
export const questionTypeLabel = (v: string | null | undefined) => label("questionType", v);
export const itemStatusLabel = (v: string | null | undefined) => label("itemStatus", v);
export const releaseLabel = (v: string | null | undefined) => label("release", v);
export const reviewLabel = (v: string | null | undefined) => label("review", v);
export const difficultyLabel = (v: string | null | undefined) => label("common.difficulty", v);
export const subscriptionLabel = (v: string | null | undefined) => label("subscription", v);
export const providerLabel = (v: string | null | undefined) => label("provider", v);
export const groupFormatLabel = (v: string | null | undefined) => label("groups.format", v);
export const joinPolicyLabel = (v: string | null | undefined) => label("groups.joinPolicy", v);
export const teachingCategoryLabel = (v: string | null | undefined) => label("teachingCategory", v);
/** Known subcategory keys get their catalog label; anything else (free text the teacher typed) is shown as-is. */
export const teachingSubcategoryLabel = (v: string | null | undefined) => label("teachingSubcategory", v);
export const partnerStatusLabel = (v: string | null | undefined) => label("partnerStatus", v);
export const heldLabel = (v: string | null | undefined) => {
  const key = `held.${v ?? ""}`;
  return isMessageKey(key) ? t(key) : t("held.default");
};

export const ITEM_STATUS_COLORS: Record<string, string> = {
  CORRECT: "border-success/40 bg-success-surface",
  WRONG: "border-destructive/40 bg-danger-surface",
  UNANSWERED: "border-border bg-muted",
  PENDING_REVIEW: "border-warning/40 bg-warning-surface",
};

/** Human-readable rendering of any stored answer or correct answer. */
export function answerText(
  value: unknown,
  q: { options?: { key: string; text: string }[]; left?: { key: string; text: string }[]; right?: { key: string; text: string }[]; items?: { key: string; text: string }[] },
): string {
  if (value === null || value === undefined || value === "") return "—";
  const find = (list: { key: string; text: string }[] | undefined, k: string) => list?.find((o) => o.key === k)?.text ?? k;
  if (typeof value === "boolean") return value ? t("common.true") : t("common.false");
  if (typeof value === "string") {
    if (value === "TRUE") return t("common.true");
    if (value === "FALSE") return t("common.false");
    return q.options ? find(q.options, value) : value;
  }
  if (Array.isArray(value)) {
    if (q.items) return value.map((k) => find(q.items, String(k))).join(" → ");
    if (q.options) return value.map((k) => find(q.options, String(k))).join(", ");
    return value.map(String).join(" | ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, string>)
      .map(([l, r]) => `${find(q.left, l)} → ${find(q.right, r)}`)
      .join("; ");
  }
  return String(value);
}
