import { getLocale, translate, type Locale } from "@/i18n/messages";

const AZ_UNITS = ["cı", "ci", "ci", "cü", "cü", "ci", "cı", "ci", "ci", "cu"];
const AZ_TENS = ["", "cu", "ci", "cu", "cı", "ci", "cı", "ci", "ci", "cı"];

/** Azerbaijani written ordinal ("1-ci", "9-cu", ...): the suffix follows the vowel harmony of the last spoken word of the number. */
export function azOrdinal(n: number): string {
  const suffix = n % 10 !== 0 || n === 0 ? AZ_UNITS[n % 10] : n % 100 !== 0 ? AZ_TENS[(n % 100) / 10] : n % 1000 !== 0 ? AZ_UNITS[3] : AZ_UNITS[1];
  return `${n}-${suffix}`;
}

const nth = (n: number, locale: Locale) => (locale === "az" ? azOrdinal(n) : String(n));

/** The attempt in words: "Attempt 1" in English, an ordinal in Azerbaijani. */
export const attemptLabel = (n: number, locale: Locale = getLocale()) => translate(locale, "attempt.nth", { nth: nth(n, locale) });

/** Exam variant for history views only; everyday labels never name the variant. */
export const variantLabel = (n: number, locale: Locale = getLocale()) => translate(locale, "assessment.variantN", { nth: nth(n, locale) });

/** "{exam title} · {attempt}". */
export const resultTitle = (title: string, attemptNo: number, locale: Locale = getLocale()) => `${title} · ${attemptLabel(attemptNo, locale)}`;

/**
 * Rows to mark "earlier variant": a result on a superseded exam variant, but only when the same
 * student has results for that exam from more than one variant in the list; otherwise the variant
 * makes no difference to the reader.
 */
export function earlierVariantRows<R extends { id: string; studentId: number | null; assessmentId: string; versionId: string; latestVariant: boolean }>(rows: readonly R[]): Set<string> {
  const variants = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = `${r.studentId}:${r.assessmentId}`;
    const seen = variants.get(key) ?? new Set<string>();
    seen.add(r.versionId);
    variants.set(key, seen);
  }
  return new Set(rows.filter((r) => !r.latestVariant && (variants.get(`${r.studentId}:${r.assessmentId}`)?.size ?? 0) > 1).map((r) => r.id));
}
