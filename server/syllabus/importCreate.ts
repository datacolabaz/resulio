import type { SyllabusImportStructure } from "../../shared/syllabusImport";
import { hasModuleDetails } from "../../shared/syllabusModuleDetails";
import { hasCourseTiming } from "../../shared/syllabusTiming";
import type { TeacherScope } from "../modules/access";
import * as authoring from "./authoring";

/**
 * The reviewed import structure → an ordinary draft syllabus, built through the normal authoring
 * functions (like sample.ts), so manual and imported syllabi are the same thing in the builder.
 */

type PlanItem =
  | { kind: "THEORY"; title: string; content: { blocks: Array<{ type: "markdown"; md: string }> } }
  | { kind: "STUDENT_PRACTICE"; title: string; content: { instructions: string; evaluation: "TEACHER"; submissionType: "TEXT_OR_FILE" } };

/**
 * Pure. Module → module (title, description, duration, end-of-module blocks); each lesson → a lesson
 * (its sub-points, if any, as one theory item listing them); the module's projects → one last lesson
 * named after the source heading, one teacher-graded practice task per project. Lessons without
 * minutes of their own get the course-wide lesson length when the source gave one.
 */
export function importPlan(s: SyllabusImportStructure) {
  return {
    syllabus: {
      title: s.title,
      description: s.description,
      subject: s.subject,
      level: s.level,
      language: s.language,
      estimatedDurationLabel: s.durationLabel,
    },
    course: { duration: s.timing.duration, lessonsPerWeek: s.timing.lessonsPerWeek },
    modules: s.modules.map((m) => ({
      title: m.title,
      description: m.description,
      duration: m.duration,
      details: m.details,
      lessons: [
        ...m.lessons.map((l) => ({
          title: l.title,
          estimatedMinutes: l.minutes ?? s.timing.lessonMinutes,
          items: l.points.length
            ? [{ kind: "THEORY" as const, title: l.title, content: { blocks: [{ type: "markdown" as const, md: l.points.map((p) => `- ${p}`).join("\n") }] } }]
            : ([] as PlanItem[]),
        })),
        ...(m.projects.length
          ? [
              {
                title: m.projectsHeading || m.projects[0].title,
                estimatedMinutes: null,
                items: m.projects.map(
                  (p): PlanItem => ({ kind: "STUDENT_PRACTICE", title: p.title, content: { instructions: p.description, evaluation: "TEACHER", submissionType: "TEXT_OR_FILE" } }),
                ),
              },
            ]
          : []),
      ],
    })),
  };
}

/** All or nothing: if any step fails, the half-built draft is removed before the error surfaces. */
export async function createFromStructure(scope: TeacherScope, structure: SyllabusImportStructure) {
  const plan = importPlan(structure);
  const syllabus = await authoring.createSyllabus(scope, plan.syllabus);
  try {
    if (hasCourseTiming(plan.course)) await authoring.updateCourseTiming(scope, syllabus.id, plan.course);
    for (const m of plan.modules) {
      const mod = await authoring.createModule(scope, syllabus.id, { title: m.title, description: m.description });
      if (hasModuleDetails(m.details)) await authoring.updateModuleDetails(scope, mod.id, m.details);
      if (m.duration) await authoring.updateModuleDuration(scope, mod.id, m.duration);
      for (const l of m.lessons) {
        const lesson = await authoring.createLesson(scope, mod.id, { title: l.title, estimatedMinutes: l.estimatedMinutes });
        for (const it of l.items) await authoring.createItem(scope, syllabus.id, { scope: "LESSON", lessonId: lesson.id }, it);
      }
    }
  } catch (error) {
    await authoring.discardDraft(scope, syllabus.id).catch((cleanup) => console.error("[syllabus] import cleanup failed", { syllabusId: syllabus.id }, cleanup));
    throw error;
  }
  return syllabus;
}
