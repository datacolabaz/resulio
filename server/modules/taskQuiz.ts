import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { questions, taskQuizQuestions, tasks, type QuestionRow } from "../../drizzle/schema";
import type { QuestionInput } from "../../shared/assessment";
import { requireDb, type DbOrTx } from "../db";
import { createBankQuestion } from "../questionBank/bank";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";

/**
 * A task's optional auto-graded quiz: an ordered subset of the same workspace question bank the
 * exam system draws from (`task_quiz_questions`, a join table exactly like `assessmentQuestions`).
 * Grading a student's quiz answers reuses the exam engine's `gradeQuestion` directly -- see
 * `gradeTaskQuiz` in tasks.ts, called from `submitToTask`.
 *
 * Ownership is checked against `tasks` directly (not `tasks.ts`'s `assignmentOf`) to avoid a
 * circular import: tasks.ts calls into this module for quiz grading on submit.
 */

async function assignmentOf(scope: TeacherScope, id: string, db: DbOrTx = requireDb()) {
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

async function ownedQuestionForQuiz(scope: TeacherScope, id: string, db: DbOrTx = requireDb()): Promise<QuestionRow> {
  const [row] = await db
    .select()
    .from(questions)
    .where(and(eq(questions.id, id), eq(questions.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

/** The six auto-gradable question types (same set `ai.ts`'s task-quiz generation is restricted to
 *  -- see AI_QUESTION_TYPES). LONG_ANSWER, MATCHING and ORDERING are excluded: a task's quiz is
 *  meant to auto-score instantly, and LONG_ANSWER has no auto-gradable answer at all. */
const QUIZ_QUESTION_TYPES = new Set(["MULTIPLE_CHOICE", "MULTIPLE_SELECT", "TRUE_FALSE", "SHORT_ANSWER", "FILL_BLANK", "NUMERIC"]);

/** Quiz questions of a task, teacher's own eyes only (full content + answer key, like the bank/exam editor). */
export async function taskQuizRows(taskId: string, db: DbOrTx = requireDb()): Promise<QuestionRow[]> {
  const rows = await db
    .select({ q: questions })
    .from(taskQuizQuestions)
    .innerJoin(questions, eq(questions.id, taskQuizQuestions.questionId))
    .where(eq(taskQuizQuestions.taskId, taskId))
    .orderBy(asc(taskQuizQuestions.position));
  return rows.map((r) => r.q);
}

/** Quiz rows for several tasks at once, grouped by taskId -- used to build the student-facing
 *  task list without one query per task. Tasks with no quiz are simply absent from the map. */
export async function quizRowsForTasks(taskIds: string[], db: DbOrTx = requireDb()): Promise<Map<string, QuestionRow[]>> {
  if (!taskIds.length) return new Map();
  const rows = await db
    .select({ taskId: taskQuizQuestions.taskId, q: questions })
    .from(taskQuizQuestions)
    .innerJoin(questions, eq(questions.id, taskQuizQuestions.questionId))
    .where(inArray(taskQuizQuestions.taskId, taskIds))
    .orderBy(asc(taskQuizQuestions.position));
  const byTask = new Map<string, QuestionRow[]>();
  for (const r of rows) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r.q]);
  return byTask;
}

export async function addQuestionToTaskQuiz(scope: TeacherScope, taskId: string, questionId: string) {
  const db = requireDb();
  await assignmentOf(scope, taskId, db);
  const q = await ownedQuestionForQuiz(scope, questionId, db);
  if (!QUIZ_QUESTION_TYPES.has(q.type)) throw new AppError("INVALID_QUESTION");
  await db.transaction(async (tx) => {
    const [{ maxPos }] = await tx
      .select({ maxPos: sql<number>`coalesce(max(${taskQuizQuestions.position}), 0)` })
      .from(taskQuizQuestions)
      .where(eq(taskQuizQuestions.taskId, taskId));
    await tx
      .insert(taskQuizQuestions)
      .values({ taskId, questionId, position: Number(maxPos) + 1 })
      .onDuplicateKeyUpdate({ set: { questionId } });
  });
  return taskQuizRows(taskId);
}

/** Creates a new bank question (filed in `sectionId`, like any manually authored one) and attaches it to the task's quiz in one step. */
export async function createInTaskQuiz(scope: TeacherScope, taskId: string, input: QuestionInput, sectionId: string) {
  await assignmentOf(scope, taskId);
  const q = await createBankQuestion(scope, input, { sectionId });
  await addQuestionToTaskQuiz(scope, taskId, q.id);
  return q;
}

export async function removeQuestionFromTaskQuiz(scope: TeacherScope, taskId: string, questionId: string) {
  await assignmentOf(scope, taskId);
  await requireDb()
    .delete(taskQuizQuestions)
    .where(and(eq(taskQuizQuestions.taskId, taskId), eq(taskQuizQuestions.questionId, questionId)));
  return taskQuizRows(taskId);
}

export async function reorderTaskQuiz(scope: TeacherScope, taskId: string, questionIds: string[]) {
  const db = requireDb();
  await assignmentOf(scope, taskId);
  const current = await taskQuizRows(taskId, db);
  const currentIds = current.map((q) => q.id).sort();
  if (JSON.stringify(currentIds) !== JSON.stringify([...questionIds].sort())) throw new AppError("UNKNOWN_QUESTION");
  await db.transaction(async (tx) => {
    for (let i = 0; i < questionIds.length; i++) {
      await tx
        .update(taskQuizQuestions)
        .set({ position: i + 1 })
        .where(and(eq(taskQuizQuestions.taskId, taskId), eq(taskQuizQuestions.questionId, questionIds[i])));
    }
  });
  return taskQuizRows(taskId);
}
