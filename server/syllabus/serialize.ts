import type { SyllabusItemKind } from "../../shared/syllabus";
import type { EngineOutput, ItemEval, LessonResult, ModuleResult, VersionStructure } from "./types";

/**
 * Student-facing shapes. Content of a locked node never leaves the server: locked lessons are
 * `{id, title, position, status, lockReason}` only, and teacher-only fields are always stripped.
 */

/** Teacher-only parts removed; a teacher-practice solution only when the teacher chose to reveal it. */
export function studentItemContent(kind: SyllabusItemKind, content: Record<string, unknown>): Record<string, unknown> {
  if (kind !== "TEACHER_PRACTICE") return { ...content };
  const { teacherOnly, revealSolutionToStudents, ...rest } = content as { teacherOnly?: { solution?: unknown }; revealSolutionToStudents?: unknown };
  const solution = revealSolutionToStudents === true && typeof teacherOnly?.solution === "string" && teacherOnly.solution ? teacherOnly.solution : null;
  return { ...rest, solution };
}

const itemState = (e: ItemEval | undefined) => (e ? { state: e.state, available: e.available } : { state: "UNMET" as const, available: false });

export function studentPathView(structure: VersionStructure, out: EngineOutput) {
  const lessons = new Map<string, LessonResult>(out.lessons.map((l) => [l.id, l]));
  const modules = new Map<string, ModuleResult>(out.modules.map((m) => [m.id, m]));
  const finalEvals = new Map(out.finalItems.map((e) => [e.itemId, e]));
  return {
    progressPct: out.progressPct,
    completedLessons: out.completedLessons,
    totalLessons: out.totalLessons,
    completed: out.syllabusCompleted,
    currentModuleId: out.currentModuleId,
    currentLessonId: out.currentLessonId,
    modules: structure.modules.map((m) => {
      const mr = modules.get(m.id)!;
      const mEvals = new Map(mr.items.map((e) => [e.itemId, e]));
      const locked = mr.status === "LOCKED";
      return {
        id: m.id,
        title: m.title,
        position: m.position,
        status: mr.status,
        lockReason: mr.lockReason,
        completedLessons: mr.completedLessons,
        totalLessons: mr.totalLessons,
        description: locked ? null : m.description,
        estimatedMinutes: m.estimatedMinutes,
        objectives: locked ? [] : m.objectives,
        lessons: m.lessons.map((l) => {
          const lr = lessons.get(l.id)!;
          return lr.status === "LOCKED"
            ? { id: l.id, title: l.title, position: l.position, status: lr.status, lockReason: lr.lockReason, optional: lr.optional, estimatedMinutes: null }
            : { id: l.id, title: l.title, position: l.position, status: lr.status, lockReason: null, optional: lr.optional, estimatedMinutes: l.estimatedMinutes };
        }),
        assessments: m.items
          .filter((it) => it.kind === "ASSESSMENT")
          .map((it) => ({ id: it.id, title: it.title, required: it.required, ...itemState(mEvals.get(it.id)) })),
      };
    }),
    finalAssessments: structure.finalItems
      .filter((it) => it.kind === "ASSESSMENT")
      .map((it) => ({ id: it.id, title: it.title, required: it.required, ...itemState(finalEvals.get(it.id)) })),
  };
}

export interface FrozenItemContent {
  itemId: string;
  kind: SyllabusItemKind;
  content: Record<string, unknown>;
}

/** An unlocked lesson with its items; `contents` must already be limited to this lesson's items. */
export function studentLessonView(structure: VersionStructure, out: EngineOutput, lessonId: string, contents: readonly FrozenItemContent[]) {
  const module = structure.modules.find((m) => m.lessons.some((l) => l.id === lessonId));
  const lesson = module?.lessons.find((l) => l.id === lessonId);
  const lr = out.lessons.find((l) => l.id === lessonId);
  if (!module || !lesson || !lr) return null;
  const head = { id: lesson.id, moduleId: module.id, moduleTitle: module.title, title: lesson.title, position: lesson.position };
  if (lr.status === "LOCKED") return { locked: true as const, lesson: head, lockReason: lr.lockReason };
  const byId = new Map(contents.map((c) => [c.itemId, c]));
  const evals = new Map(lr.items.map((e) => [e.itemId, e]));
  const flat = structure.modules.flatMap((m) => m.lessons.map((l) => l.id));
  const idx = flat.indexOf(lessonId);
  const nextId = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;
  const next = nextId ? out.lessons.find((l) => l.id === nextId) : null;
  return {
    locked: false as const,
    lesson: { ...head, description: lesson.description, objectives: lesson.objectives, estimatedMinutes: lesson.estimatedMinutes },
    status: lr.status,
    optional: lr.optional,
    rules: {
      theory: lesson.rules.theory,
      teacherPractice: lesson.rules.teacherPractice,
      studentPractice: lesson.rules.studentPractice,
      assessment: lesson.rules.assessment,
      assessmentPassPct: lesson.rules.assessmentPassPct,
      practicePassPct: lesson.rules.practicePassPct,
      teacherApproval: lesson.rules.teacherApproval,
    },
    items: lesson.items.map((it) => {
      const frozen = byId.get(it.id);
      return {
        id: it.id,
        kind: it.kind,
        title: it.title,
        position: it.position,
        required: it.required,
        passPct: it.passPct,
        ...itemState(evals.get(it.id)),
        content: frozen ? studentItemContent(it.kind, frozen.content) : {},
      };
    }),
    nextLesson: next ? { id: next.id, unlocked: next.status !== "LOCKED" } : null,
  };
}
