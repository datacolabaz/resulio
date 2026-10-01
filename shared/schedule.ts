/**
 * A teaching group's weekly class schedule: zero or more (day, time) entries, since a group can
 * meet on several different days of the week, each possibly at its own time (e.g. Wednesday
 * 17:00 and Saturday 11:00). Stored as a single JSON column (`groups.classSchedule`) rather than
 * a fixed set of day columns, so a group can have any number of entries without a migration.
 * `day` is validated against WEEK_DAYS by zod at the API boundary but is plain varchar-in-JSON at
 * the DB level (same free-text-over-enum precedent as `users.targetExam`), and `time` is a
 * "HH:MM" 24-hour string validated by CLASS_TIME_PATTERN.
 */

export const WEEK_DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

export interface ClassScheduleEntry {
  day: WeekDay;
  time: string;
}

/** Matches a 24-hour "HH:MM" time string, e.g. "09:30" or "17:00". */
export const CLASS_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Offered values for a group's teaching language. `groups.language` stays a free-text varchar
 * (see drizzle/schema.ts) rather than a DB enum, so this list can grow without a migration — but
 * the form only ever offers this controlled set, instead of a free-text field.
 */
export const GROUP_LANGUAGES = ["az", "ru", "en"] as const;
export type GroupLanguage = (typeof GROUP_LANGUAGES)[number];

export function sortBySchedule(entries: readonly ClassScheduleEntry[]): ClassScheduleEntry[] {
  return [...entries].sort((a, b) => {
    const dayDiff = WEEK_DAYS.indexOf(a.day) - WEEK_DAYS.indexOf(b.day);
    return dayDiff !== 0 ? dayDiff : a.time.localeCompare(b.time);
  });
}
