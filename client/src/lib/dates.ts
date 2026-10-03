import { translate, type Locale } from "@/i18n/messages";

/**
 * The single place that turns instants into text.
 *   az / ru: 29.09.2026, 21:34
 *   en:      Sep 29, 2026, 21:34
 * Always 24-hour. Values are absolute instants (Date or ISO string) rendered in the viewer's
 * time zone unless `timeZone` is given.
 */
export type DateInput = Date | string | number | null | undefined;
export type DateOptions = { timeZone?: string };

const EMPTY = "—";

export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type Parts = { year: string; month: string; monthShort: string; day: string; hour: string; minute: string };

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(d: Date, timeZone?: string): Parts {
  const key = timeZone ?? "";
  let f = formatters.get(key);
  if (!f) {
    // en-US only as a source of stable numeric fields; the visible pattern is assembled below.
    f = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
    formatters.set(key, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  let short = formatters.get(`${key}|month`);
  if (!short) {
    short = new Intl.DateTimeFormat("en-US", { month: "short", timeZone });
    formatters.set(`${key}|month`, short);
  }
  return {
    year: p.year,
    month: p.month,
    monthShort: short.format(d),
    day: p.day,
    hour: p.hour === "24" ? "00" : p.hour,
    minute: p.minute,
  };
}

function dayText(p: Parts, locale: Locale) {
  return locale === "en" ? `${p.monthShort} ${Number(p.day)}, ${p.year}` : `${p.day}.${p.month}.${p.year}`;
}

const timeText = (p: Parts) => `${p.hour}:${p.minute}`;

export function formatDateTime(value: DateInput, locale: Locale, opts: DateOptions = {}): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  const p = parts(d, opts.timeZone);
  return `${dayText(p, locale)}, ${timeText(p)}`;
}

export function formatDay(value: DateInput, locale: Locale, opts: DateOptions = {}): string {
  const d = toDate(value);
  return d ? dayText(parts(d, opts.timeZone), locale) : EMPTY;
}

export function formatTime(value: DateInput, _locale: Locale, opts: DateOptions = {}): string {
  const d = toDate(value);
  return d ? timeText(parts(d, opts.timeZone)) : EMPTY;
}

const dayKey = (p: Parts) => `${p.year}-${p.month}-${p.day}`;

/** Compact axis label for a calendar day key (YYYY-MM-DD): az/ru "29.09", en "Sep 29". */
export function formatDayKeyShort(key: string, locale: Locale): string {
  const d = toDate(`${key}T12:00:00Z`);
  if (!d) return key;
  const p = parts(d, "UTC");
  return locale === "en" ? `${p.monthShort} ${Number(p.day)}` : `${p.day}.${p.month}`;
}

/** "just now", "5 min ago", "Today, 14:32", "Yesterday, 21:40", else the full date-time. `now` should be server-aligned. */
export function formatRelative(value: DateInput, locale: Locale, now: DateInput = Date.now(), opts: DateOptions = {}): string {
  const d = toDate(value);
  const n = toDate(now) ?? new Date();
  if (!d) return EMPTY;
  const diffMin = Math.floor((n.getTime() - d.getTime()) / 60_000);
  if (diffMin >= 0 && diffMin < 1) return translate(locale, "relative.now");
  if (diffMin >= 1 && diffMin < 60) return translate(locale, "relative.minutesAgo", { n: diffMin });
  const p = parts(d, opts.timeZone);
  if (dayKey(p) === dayKey(parts(n, opts.timeZone))) return translate(locale, "relative.today", { time: timeText(p) });
  if (dayKey(p) === dayKey(parts(new Date(n.getTime() - 86_400_000), opts.timeZone))) {
    return translate(locale, "relative.yesterday", { time: timeText(p) });
  }
  return formatDateTime(d, locale, opts);
}

export function formatDuration(seconds: number | null | undefined, locale: Locale): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EMPTY;
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return translate(locale, "duration.hm", { h, m });
  if (m) return sec ? translate(locale, "duration.ms", { m, s: sec }) : translate(locale, "duration.m", { m });
  return translate(locale, "duration.s", { s: sec });
}
