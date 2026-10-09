/**
 * AI usage tracking, pricing and per-teacher limits. Shared by the server (logging, enforcement)
 * and the admin / teacher screens.
 */

/** Every product feature that calls the model. New values go last. */
export const AI_FEATURES = ["QUESTION_GENERATE", "QUESTION_IMPORT", "SYLLABUS_IMPORT", "SUBMISSION_REVIEW", "ANSWER_KEY_DRAFT", "OTHER"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_CALL_STATUSES = ["OK", "ERROR", "RATE_LIMITED"] as const;
export type AiCallStatus = (typeof AI_CALL_STATUSES)[number];

/** Price row used for models without their own row. */
export const AI_PRICE_FALLBACK_MODEL = "*";

/**
 * Limit values, for the global default and for a teacher's override alike:
 * - global default: null or 0 = unlimited (the initial state: nobody is limited until an admin sets a default);
 * - teacher override: null = use the global default, 0 = unlimited for this teacher, > 0 = that cap.
 * A monthly quota counts total tokens (prompt + completion, thinking included) since the start of the
 * calendar month in Baku time; the daily cap counts AI actions (one import, one review, one generate —
 * however many model requests each needs) since Baku midnight. An admin "reset" starts both counts
 * again from that moment for the current period.
 */
export type LimitValue = number | null;

export const AI_LIMIT_WARN_RATIO = 0.8;

/** Asia/Baku is UTC+4 all year (no DST since 2016). */
export const BAKU_OFFSET_MS = 4 * 60 * 60 * 1000;

/** Start of the Baku-time day or month containing `now`, as a UTC instant. */
export function periodStart(kind: "day" | "month", now: Date = new Date()): Date {
  const local = new Date(now.getTime() + BAKU_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const startLocal = kind === "day" ? Date.UTC(y, m, local.getUTCDate()) : Date.UTC(y, m, 1);
  return new Date(startLocal - BAKU_OFFSET_MS);
}

/** When the current day or month period ends (and its limit resets), as a UTC instant. */
export function nextPeriodStart(kind: "day" | "month", now: Date = new Date()): Date {
  const local = new Date(now.getTime() + BAKU_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const nextLocal = kind === "day" ? Date.UTC(y, m, local.getUTCDate() + 1) : Date.UTC(y, m + 1, 1);
  return new Date(nextLocal - BAKU_OFFSET_MS);
}

/** The cap that applies to one teacher; null = unlimited. */
export function effectiveLimit(globalDefault: LimitValue, override: LimitValue): number | null {
  if (override !== null && override !== undefined) return override > 0 ? override : null;
  return globalDefault && globalDefault > 0 ? globalDefault : null;
}

/** Cost of one call in micro-USD; prices are USD per million tokens, so one token costs `price` micro-USD. */
export function costMicroUsd(tokens: { prompt: number; completion: number; total: number }, price: { inputUsdPerMillion: number; outputUsdPerMillion: number }): number {
  // Gemini bills thinking as output; its OpenAI-compatible usage leaves thinking out of completion_tokens but in total_tokens.
  const prompt = Math.max(tokens.prompt, 0);
  const output = Math.max(tokens.completion, tokens.total - prompt, 0);
  const micro = prompt * price.inputUsdPerMillion + output * price.outputUsdPerMillion;
  return Math.max(0, Math.round(micro));
}

export const MICRO_USD = 1_000_000;
