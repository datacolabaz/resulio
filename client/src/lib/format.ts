import { getLocale, isMessageKey, t, type MessageKey } from "@/i18n/messages";
import { nextPeriodStart } from "@shared/aiUsage";
import { formatDateTime, formatDay, formatDayKeyShort, formatDuration, formatRelative, formatTime, type DateInput } from "@/lib/dates";
import { GROUP_LEVELS, type GroupLevel, type GroupType } from "@shared/groupType";
import { sortBySchedule, type ClassScheduleEntry } from "@shared/schedule";

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const key = `error.${message}`;
  if (message === "AI_TEACHER_MONTHLY_LIMIT" || message === "AI_TEACHER_DAILY_LIMIT") {
    return t(key as MessageKey, { date: fmtDay(nextPeriodStart(message === "AI_TEACHER_MONTHLY_LIMIT" ? "month" : "day")) });
  }
  if (isMessageKey(key)) return t(key);
  // Input validation failures arrive as a JSON list of issues, never meant for people.
  if (/^\s*[[{]/.test(message)) return t(message.includes("DATE_OUT_OF_RANGE") ? "error.DATE_OUT_OF_RANGE" : "error.INVALID_INPUT");
  return message && message.length < 120 ? message : t("error.INTERNAL_ERROR");
}

export const fmtDateTime = (value: DateInput) => formatDateTime(value, getLocale());
export const fmtDay = (value: DateInput) => formatDay(value, getLocale());
export const fmtDayKeyShort = (key: string) => formatDayKeyShort(key, getLocale());
export const fmtTime = (value: DateInput) => formatTime(value, getLocale());
export const fmtRelative = (value: DateInput, now: DateInput = Date.now()) => formatRelative(value, getLocale(), now);
export const fmtDuration = (seconds: number | null | undefined) => formatDuration(seconds, getLocale());

export const fmtNumber = (value: number, maxFractionDigits = 0) => new Intl.NumberFormat(getLocale(), { maximumFractionDigits: maxFractionDigits }).format(value);
/** 1.2K / 3.4M style, for token counts. */
export const fmtCompact = (value: number) => new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(value);
/** US dollars; small amounts keep more decimals so a few cents of AI spend do not show as $0.00. */
export const fmtUsd = (value: number) =>
  new Intl.NumberFormat(getLocale(), { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 1 ? 4 : 2 }).format(value);

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
export const referralSourceLabel = (v: string | null | undefined) => label("referralSource", v);
export const shareChannelLabel = (v: string | null | undefined) => label("shareChannel", v);
/** Known subcategory keys get their catalog label; anything else (free text the teacher typed) is shown as-is. */
export const teachingSubcategoryLabel = (v: string | null | undefined) => label("teachingSubcategory", v);
/** Known language codes (az/ru/en) get their catalog label; legacy free-text values are shown as-is. */
export const groupLanguageLabel = (v: string | null | undefined) => label("groupLanguage", v);
/** A known level key in the reader's language; a level the teacher typed themselves, as typed. */
export const groupLevelLabel = (v: string) => ((GROUP_LEVELS as readonly string[]).includes(v) ? t(`groups.level.${v as GroupLevel}`) : v);

/** The group's Fənn + Sinif (school class) or İstiqamət + Səviyyə (course), labelled, skipping empty ones. */
export function groupFacts(g: { groupType?: GroupType; subject: string; grade: string; level?: string }): { label: string; value: string }[] {
  const facts =
    g.groupType === "SCHOOL"
      ? [
          { label: t("groups.field.subject"), value: g.subject },
          { label: t("groups.field.class"), value: g.grade },
        ]
      : [
          { label: t("groups.field.direction"), value: g.subject },
          { label: t("groups.field.level"), value: groupLevelLabel(g.level ?? "") },
        ];
  return facts.filter((f) => f.value.trim());
}

/** e.g. "Fənn: Riyaziyyat · Sinif: 9A"; "" when neither is set. */
export const groupFactsLine = (g: Parameters<typeof groupFacts>[0]) => groupFacts(g).map((f) => `${f.label}: ${f.value}`).join(" · ");
/** e.g. "Çərşənbə 17:00, Şənbə 11:00", sorted Monday-first; "" when the group has no weekly schedule. */
export function scheduleSummary(entries: readonly ClassScheduleEntry[] | null | undefined): string {
  if (!entries?.length) return "";
  return sortBySchedule(entries).map((e) => `${t(`weekday.full.${e.day}`)} ${e.time}`).join(", ");
}
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
