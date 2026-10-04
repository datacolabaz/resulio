/** The owner's teaching workflow, shown as a step indicator in the syllabus builder. */
export const TEACHER_STEPS = ["create", "organize", "teach", "assign", "assess", "track"] as const;
export type TeacherStep = (typeof TEACHER_STEPS)[number];

/** The learning loop explained to students on their path page. */
export const STUDENT_STEPS = ["learn", "practice", "submit", "pass", "unlock", "progress"] as const;
export type StudentStep = (typeof STUDENT_STEPS)[number];

export type StepState = "done" | "current" | "todo";

/** Builder tab each step leads to. */
export const STEP_TAB: Record<TeacherStep, "settings" | "structure" | "access" | "analytics"> = {
  create: "settings",
  organize: "structure",
  teach: "structure",
  assign: "access",
  assess: "structure",
  track: "analytics",
};

const TEACHING_KINDS = new Set(["THEORY", "TEACHER_PRACTICE", "STUDENT_PRACTICE", "RESOURCE"]);

interface TreeShape {
  syllabus: { currentVersionId: string | null };
  modules: ReadonlyArray<{ items: ReadonlyArray<{ kind: string }>; lessons: ReadonlyArray<{ items: ReadonlyArray<{ kind: string }> }> }>;
  finalItems: ReadonlyArray<{ kind: string }>;
}

/**
 * Done flags come from the draft tree and the grants; "current" is the first step not done yet.
 * Track is never "done": once everything before it is, it stays the current step.
 */
export function teacherSteps(tree: TreeShape, grantStates: readonly string[]): Array<{ step: TeacherStep; state: StepState }> {
  const lessons = tree.modules.flatMap((m) => m.lessons);
  const lessonItems = lessons.flatMap((l) => l.items);
  const allItems = [...lessonItems, ...tree.modules.flatMap((m) => m.items), ...tree.finalItems];
  const done: Record<TeacherStep, boolean> = {
    create: true,
    organize: lessons.length > 0,
    teach: lessonItems.some((it) => TEACHING_KINDS.has(it.kind)),
    assign: !!tree.syllabus.currentVersionId && grantStates.some((s) => s === "ACTIVE" || s === "PENDING"),
    assess: allItems.some((it) => it.kind === "ASSESSMENT"),
    track: false,
  };
  const current = TEACHER_STEPS.find((s) => !done[s]) ?? "track";
  return TEACHER_STEPS.map((step) => ({ step, state: done[step] ? "done" : step === current ? "current" : "todo" }));
}

/** Lessons to badge after a version move; `changes` comes from the server path. */
export const lessonChange = (changes: Readonly<Record<string, "NEW" | "UPDATED">> | undefined, lessonId: string) => changes?.[lessonId] ?? null;

/** Student "continue learning" pick: active, unfinished, most recently used first (never-opened last). */
export function continueCandidates<C extends { access: string; progress: { completed: boolean; lastActivityAt: Date | string | null } | null }>(cards: readonly C[]): C[] {
  const time = (c: C) => (c.progress?.lastActivityAt ? new Date(c.progress.lastActivityAt).getTime() : 0);
  return cards.filter((c) => c.access === "ACTIVE" && !c.progress?.completed).sort((a, b) => time(b) - time(a));
}

/** "Used in N syllabi" lookup for the materials library. */
export const usageMap = (rows: ReadonlyArray<{ materialId: string; syllabi: number }> | undefined) => new Map((rows ?? []).map((r) => [r.materialId, r.syllabi]));
