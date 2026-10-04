/** Pure helpers of the student syllabus pages (kept free of React and i18n so they are unit-tested). */

export type LockReason =
  | { code: "PREVIOUS_LESSON"; lessonId: string; title: string }
  | { code: "PREVIOUS_MODULE"; moduleId: string; title: string }
  | { code: "MODULE_LESSONS"; moduleId: string; title: string }
  | { code: "ALL_MODULES" };

interface PathShape {
  modules: ReadonlyArray<{ id: string; lessons: ReadonlyArray<{ id: string }> }>;
}

/** What a lock reason points at, with the number the student sees in the path ("Modul 2", "Dərs 4"). */
export function lockTarget(reason: LockReason | null | undefined, path: PathShape): { kind: "lesson" | "module" | "all"; n: number; title: string } | null {
  if (!reason) return null;
  if (reason.code === "ALL_MODULES") return { kind: "all", n: 0, title: "" };
  if (reason.code === "PREVIOUS_LESSON") {
    for (const m of path.modules) {
      const i = m.lessons.findIndex((l) => l.id === reason.lessonId);
      if (i >= 0) return { kind: "lesson", n: i + 1, title: reason.title };
    }
    return { kind: "lesson", n: 0, title: reason.title };
  }
  const i = path.modules.findIndex((m) => m.id === reason.moduleId);
  return { kind: "module", n: i + 1, title: reason.title };
}

export type NodeVisual = "done" | "current" | "open" | "waiting" | "locked";

/** ✅ done · 🔵 current · open · ⏳ waiting (review/approval) · 🔒 locked. */
export function nodeVisual(status: string, isCurrent: boolean): NodeVisual {
  if (status === "COMPLETED") return "done";
  if (status === "LOCKED") return "locked";
  if (status === "AWAITING_REVIEW" || status === "AWAITING_APPROVAL") return "waiting";
  return isCurrent ? "current" : "open";
}

export function pct(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

/** Only in-app paths of this area may be a return target (no open redirect). */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /^\/student\/syllabus\/[A-Za-z0-9_-]+(\/lessons\/[A-Za-z0-9_-]+)?$/.test(raw) ? raw : null;
}

/** Remaining time as whole minutes (rounded up), for cooldowns. */
export function minutesUntil(at: Date | string | null | undefined, now = Date.now()): number {
  if (!at) return 0;
  const ms = new Date(at).getTime() - now;
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}
