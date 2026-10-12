import { z } from "zod";
import { COACH_DEFAULT_LIMITS, type CoachLimits } from "../../shared/coach";

/** Per-feature coach caps (shared/coach.ts COACH_DEFAULT_LIMITS); a missing key uses its default. */
export const coachLimitsSetting = z
  .object(Object.fromEntries(Object.keys(COACH_DEFAULT_LIMITS).map((k) => [k, z.number().int().min(0).max(100_000)])) as Record<keyof CoachLimits, z.ZodNumber>)
  .partial()
  .nullable();

const modelName = z.string().trim().max(120);
/** Coach model names; switches at once, no restart. A missing name falls back to the COACH_* env vars. */
export const coachModelsSetting = z.object({ main: modelName, lite: modelName, pro: modelName, ocr: modelName }).partial().nullable();
