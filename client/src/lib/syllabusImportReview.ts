import type { ImportLesson, ImportModule, ImportProject, SyllabusImportStructure } from "@shared/syllabusImport";
import { hasModuleDetails, type ModuleDetails } from "@shared/syllabusModuleDetails";
import { checkModuleDurations, type Duration } from "@shared/syllabusTiming";

/** Edits on the review screen before the syllabus is created. Pure: each returns a new structure. */

export type Review = SyllabusImportStructure;
export type ReviewTiming = Review["timing"];

function moved<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

const without = <T>(list: readonly T[], index: number) => list.filter((_, i) => i !== index);
const replaced = <T>(list: readonly T[], index: number, patch: Partial<T>) => list.map((x, i) => (i === index ? { ...x, ...patch } : x));

const editModule = (s: Review, mi: number, fn: (m: ImportModule) => ImportModule): Review => ({ ...s, modules: s.modules.map((m, i) => (i === mi ? fn(m) : m)) });

export const reviewEdit = {
  syllabus: (s: Review, patch: Partial<Pick<Review, "title" | "description" | "subject" | "level">>): Review => ({ ...s, ...patch }),
  timing: (s: Review, patch: Partial<ReviewTiming>): Review => ({ ...s, timing: { ...s.timing, ...patch } }),

  renameModule: (s: Review, mi: number, title: string) => editModule(s, mi, (m) => ({ ...m, title })),
  moduleDuration: (s: Review, mi: number, duration: Duration | null) => editModule(s, mi, (m) => ({ ...m, duration })),
  moveModule: (s: Review, mi: number, delta: -1 | 1): Review => ({ ...s, modules: moved(s.modules, mi, delta) }),
  removeModule: (s: Review, mi: number): Review => ({ ...s, modules: without(s.modules, mi) }),

  renameLesson: (s: Review, mi: number, li: number, title: string) => editModule(s, mi, (m) => ({ ...m, lessons: replaced<ImportLesson>(m.lessons, li, { title }) })),
  lessonMinutes: (s: Review, mi: number, li: number, minutes: number | null) => editModule(s, mi, (m) => ({ ...m, lessons: replaced<ImportLesson>(m.lessons, li, { minutes }) })),
  moveLesson: (s: Review, mi: number, li: number, delta: -1 | 1) => editModule(s, mi, (m) => ({ ...m, lessons: moved(m.lessons, li, delta) })),
  removeLesson: (s: Review, mi: number, li: number) => editModule(s, mi, (m) => ({ ...m, lessons: without(m.lessons, li) })),

  renameProject: (s: Review, mi: number, pi: number, title: string) => editModule(s, mi, (m) => ({ ...m, projects: replaced<ImportProject>(m.projects, pi, { title }) })),
  removeProject: (s: Review, mi: number, pi: number) => editModule(s, mi, (m) => ({ ...m, projects: without(m.projects, pi) })),
};

/** Counts for the summary line. */
export function reviewStats(s: Review) {
  return {
    modules: s.modules.length,
    lessons: s.modules.reduce((n, m) => n + m.lessons.length, 0),
    projects: s.modules.reduce((n, m) => n + m.projects.length, 0),
    withBlocks: s.modules.filter((m) => hasModuleDetails(m.details as ModuleDetails)).length,
  };
}

export type ReviewProblem = "NO_TITLE" | "NO_MODULES" | "EMPTY_MODULE_TITLE" | "EMPTY_LESSON_TITLE" | "EMPTY_PROJECT_TITLE";

/** What blocks "Create": the same rules the server's schema enforces, as messages instead of a 400. */
export function reviewProblems(s: Review): ReviewProblem[] {
  const out = new Set<ReviewProblem>();
  if (!s.title.trim()) out.add("NO_TITLE");
  if (!s.modules.length) out.add("NO_MODULES");
  for (const m of s.modules) {
    if (!m.title.trim()) out.add("EMPTY_MODULE_TITLE");
    if (m.lessons.some((l) => !l.title.trim())) out.add("EMPTY_LESSON_TITLE");
    if (m.projects.some((p) => !p.title.trim())) out.add("EMPTY_PROJECT_TITLE");
  }
  return [...out];
}

/** Module durations summed against the course total. */
export const reviewTimingCheck = (s: Review) => checkModuleDurations(s.timing.duration, s.modules.map((m) => m.duration));
