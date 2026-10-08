import { z } from "zod";

/**
 * Course pacing set by the author: the course's total duration and cadence (lessons per week) and
 * each module's duration. Lesson minutes stay on the lesson (`estimatedMinutes`). Stored as one
 * JSON per syllabus (`syllabus_timing`) and frozen per version (`syllabus_version_timing`).
 */

export const DURATION_UNITS = ["WEEKS", "MONTHS"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const WEEKS_PER_MONTH = 52 / 12;
export const MAX_DURATION_VALUE = 520;
export const MAX_LESSONS_PER_WEEK = 21;

export const durationSchema = z.object({
  value: z.number().positive().max(MAX_DURATION_VALUE).transform((v) => Math.round(v * 10) / 10),
  unit: z.enum(DURATION_UNITS),
});
export type Duration = z.output<typeof durationSchema>;

export const courseTimingSchema = z.object({
  duration: durationSchema.nullable().default(null),
  lessonsPerWeek: z.number().int().min(1).max(MAX_LESSONS_PER_WEEK).nullable().default(null),
});
export type CourseTiming = z.output<typeof courseTimingSchema>;

export const syllabusTimingSchema = z.object({
  course: courseTimingSchema.default({ duration: null, lessonsPerWeek: null }),
  /** moduleId → duration; modules without a duration are absent. */
  modules: z.record(z.string().min(1).max(32), durationSchema).default({}),
});
export type SyllabusTiming = z.output<typeof syllabusTimingSchema>;

export function emptyTiming(): SyllabusTiming {
  return { course: { duration: null, lessonsPerWeek: null }, modules: {} };
}

/** Stored JSON → timing; malformed reads as empty rather than breaking the page. */
export function parseTiming(raw: unknown): SyllabusTiming {
  const parsed = syllabusTimingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyTiming();
}

export function hasCourseTiming(c: CourseTiming | null | undefined): c is CourseTiming {
  return !!c && (c.duration !== null || c.lessonsPerWeek !== null);
}

export const inWeeks = (d: Duration) => (d.unit === "WEEKS" ? d.value : d.value * WEEKS_PER_MONTH);

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Sum of durations, in months when every part is in months, else in weeks. Null for an empty list. */
export function sumDurations(parts: readonly Duration[]): Duration | null {
  if (!parts.length) return null;
  if (parts.every((p) => p.unit === "MONTHS")) return { value: round1(parts.reduce((s, p) => s + p.value, 0)), unit: "MONTHS" };
  return { value: round1(parts.reduce((s, p) => s + inWeeks(p), 0)), unit: "WEEKS" };
}

/** Same length within half a week (a month is 52/12 weeks). */
export function sameDuration(a: Duration, b: Duration): boolean {
  if (a.unit === b.unit) return Math.abs(a.value - b.value) < 0.05;
  return Math.abs(inWeeks(a) - inWeeks(b)) <= 0.5;
}

export interface TimingCheck {
  /** Sum of the modules that have a duration. */
  sum: Duration | null;
  /** Modules without a duration. */
  missing: number;
  /** The course total is set and differs from the sum of module durations (a warning, never a block). */
  mismatch: boolean;
}

export function checkModuleDurations(course: Duration | null, modules: ReadonlyArray<Duration | null | undefined>): TimingCheck {
  const set = modules.filter((d): d is Duration => !!d);
  const sum = sumDurations(set);
  return { sum, missing: modules.length - set.length, mismatch: !!course && !!sum && !sameDuration(course, sum) };
}

/** Lessons the cadence fits into a duration (e.g. 2 per week × 1 month ≈ 9). */
export function suggestedLessonCount(lessonsPerWeek: number | null, duration: Duration | null | undefined): number | null {
  if (!lessonsPerWeek || !duration) return null;
  return Math.round(lessonsPerWeek * inWeeks(duration));
}

/** Total of the lessons' minutes and how many lessons have none. */
export function lessonMinutes(lessons: ReadonlyArray<{ estimatedMinutes: number | null }>): { minutes: number; missing: number } {
  let minutes = 0;
  let missing = 0;
  for (const l of lessons) {
    if (l.estimatedMinutes) minutes += l.estimatedMinutes;
    else missing++;
  }
  return { minutes, missing };
}

/** Timing limited to the given modules (deleted modules' entries are dropped). */
export function timingFor(timing: SyllabusTiming, moduleIds: readonly string[]): SyllabusTiming {
  const keep = new Set(moduleIds);
  return { course: timing.course, modules: Object.fromEntries(Object.entries(timing.modules).filter(([id]) => keep.has(id))) };
}
