/** The owner's teaching workflow, shown as a step indicator in the syllabus builder. */
export const TEACHER_STEPS = ["create", "organize", "teach", "assign", "assess", "track"] as const;
export type TeacherStep = (typeof TEACHER_STEPS)[number];

/** The learning loop explained to students on their path page. */
export const STUDENT_STEPS = ["learn", "practice", "submit", "pass", "unlock", "progress"] as const;
export type StudentStep = (typeof STUDENT_STEPS)[number];

/** "skipped": the step does not apply to this syllabus (e.g. nothing to grade). */
export type StepState = "done" | "current" | "todo" | "skipped";

/** Tabs of the syllabus builder, in display order. */
export const BUILDER_TABS = ["structure", "settings", "versions", "access", "students", "grading", "analytics"] as const;
export type BuilderTab = (typeof BUILDER_TABS)[number];

/** Builder tab each step leads to; every step lands somewhere, whatever its state. */
export const STEP_TAB: Record<TeacherStep, BuilderTab> = {
  create: "settings",
  organize: "structure",
  teach: "structure",
  assign: "access",
  assess: "grading",
  track: "analytics",
};

const TEACHING_KINDS = new Set(["THEORY", "TEACHER_PRACTICE", "STUDENT_PRACTICE", "RESOURCE"]);

type Rules = { teacherApproval?: boolean };
type ItemShape = { kind: string };
interface TreeShape<I extends ItemShape = ItemShape> {
  syllabus: { currentVersionId: string | null; effectiveRules?: Rules };
  modules: ReadonlyArray<{ effectiveRules?: Rules; items: ReadonlyArray<I>; lessons: ReadonlyArray<{ effectiveRules?: Rules; items: ReadonlyArray<I> }> }>;
  finalItems: ReadonlyArray<I>;
}

/** Steps a course can do without; they are never the "next step" unless work is waiting in them. */
export const OPTIONAL_STEPS: ReadonlySet<TeacherStep> = new Set<TeacherStep>(["assess"]);

/** What a teacher may have to check in this syllabus: tests, student practice, and teacher approvals. */
export function gradable<I extends ItemShape>(tree: TreeShape<I>) {
  const lessons = tree.modules.flatMap((m) => m.lessons);
  const items = [...lessons.flatMap((l) => l.items), ...tree.modules.flatMap((m) => m.items), ...tree.finalItems];
  const tests = items.filter((it) => it.kind === "ASSESSMENT");
  const practice = items.filter((it) => it.kind === "STUDENT_PRACTICE");
  const approvals = [tree.syllabus, ...tree.modules, ...lessons].some((n) => !!n.effectiveRules?.teacherApproval);
  return { tests, practice, approvals, any: tests.length > 0 || practice.length > 0 || approvals };
}

/**
 * Done flags come from the draft tree and the grants; "current" is the first required step not done
 * yet. Assess is skipped when nothing in the syllabus can be graded, and becomes the next step when
 * work is waiting (`waiting`: submissions and approvals not yet handled). Track is never "done".
 */
export function teacherSteps(
  tree: TreeShape,
  grantStates: readonly string[],
  waiting = 0,
): Array<{ step: TeacherStep; state: StepState; count?: number }> {
  const lessons = tree.modules.flatMap((m) => m.lessons);
  const lessonItems = lessons.flatMap((l) => l.items);
  const canGrade = gradable(tree).any;
  const done: Record<TeacherStep, boolean> = {
    create: true,
    organize: lessons.length > 0,
    teach: lessonItems.some((it) => TEACHING_KINDS.has(it.kind)),
    assign: !!tree.syllabus.currentVersionId && grantStates.some((s) => s === "ACTIVE" || s === "PENDING"),
    assess: false,
    track: false,
  };
  const required = TEACHER_STEPS.find((s) => !done[s] && !OPTIONAL_STEPS.has(s) && s !== "track");
  const current: TeacherStep = required ?? (canGrade && waiting > 0 ? "assess" : "track");
  return TEACHER_STEPS.map((step) => {
    const state: StepState = step === "assess" && !canGrade ? "skipped" : done[step] ? "done" : step === current ? "current" : "todo";
    return step === "assess" && canGrade && waiting > 0 ? { step, state, count: waiting } : { step, state };
  });
}

/** The step a teacher should go to next, unless it is the one they are already looking at. */
export function nextStepOtherThan(steps: ReadonlyArray<{ step: TeacherStep; state: StepState }>, here: TeacherStep): TeacherStep | null {
  const current = steps.find((s) => s.state === "current")?.step ?? null;
  return current === here ? null : current;
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
