/**
 * Which modules of a syllabus page are expanded. Modules start collapsed (title, counts, progress);
 * what the reader opens or closes is remembered per syllabus for the browser session.
 */

const KEY_PREFIX = "resulio-syllabus-open:";

type Store = Pick<Storage, "getItem" | "setItem">;

export const openModulesKey = (view: string, syllabusId: string) => `${KEY_PREFIX}${view}:${syllabusId}`;

/** The remembered open modules that still exist, or null when nothing was remembered. */
export function readOpenModules(storage: Store | null, key: string, moduleIds: readonly string[]): string[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return null;
    const known = new Set(moduleIds);
    return saved.filter((id): id is string => typeof id === "string" && known.has(id));
  } catch {
    return null;
  }
}

export function writeOpenModules(storage: Store | null, key: string, open: Iterable<string>) {
  try {
    storage?.setItem(key, JSON.stringify([...open]));
  } catch {
    /* storage full or blocked: the state just is not remembered */
  }
}

interface StudentPathShape {
  currentModuleId: string | null;
  currentLessonId: string | null;
  modules: ReadonlyArray<{ id: string; lessons: ReadonlyArray<{ id: string; status: string }> }>;
}

const UNTOUCHED = new Set(["AVAILABLE", "LOCKED"]);

/** A student sees the module of their current (next) lesson open, and none before they have started. */
export function studentDefaultOpen(path: StudentPathShape): string[] {
  const started = path.modules.some((m) => m.lessons.some((l) => !UNTOUCHED.has(l.status)));
  if (!started) return [];
  const byLesson = path.currentLessonId ? path.modules.find((m) => m.lessons.some((l) => l.id === path.currentLessonId)) : undefined;
  const id = byLesson?.id ?? path.currentModuleId;
  return id && path.modules.some((m) => m.id === id) ? [id] : [];
}
