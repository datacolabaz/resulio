import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  sqlLabConfigs,
  sqlLabSubmissions,
  tasks,
  type SqlLabConfig,
  type SqlLabGradeMode,
  type SqlLabSubmission,
} from "../../drizzle/schema";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";
import { extensionOf, fileBytes, fileRow } from "./files";
import {
  compareSqlResults,
  parseDataset,
  runSandboxedQuery,
  SANDBOX_MAX_RESULT_ROWS,
  SANDBOX_PREVIEW_ROWS,
  SandboxExecutionError,
} from "./sqlSandbox";
import { taskReachesStudent } from "./taskAccess";

/**
 * SQL Practice Lab: a task-level add-on, exactly one optional `sql_lab_configs` row per task (see
 * drizzle/schema.ts for the full design note). Mirrors taskQuiz.ts's shape on purpose -- same kind
 * of "optional thing attached to a task" module -- including its fix for the same problem: tasks.ts
 * needs this module (to attach a task's SQL lab info to the student task list), so ownership here is
 * checked against `tasks` directly instead of importing tasks.ts's `assignmentOf`, to avoid a cycle.
 */

async function assignmentOf(
  scope: TeacherScope,
  id: string,
  db: DbOrTx = requireDb()
) {
  const [row] = await db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.id, id), eq(tasks.providerWorkspaceId, scope.workspaceId))
    )
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

/** Teacher's own view: everything, including the reference query and expected result (the "answer key"). */
export async function sqlLabConfigOf(
  scope: TeacherScope,
  taskId: string
): Promise<SqlLabConfig | null> {
  await assignmentOf(scope, taskId);
  const [row] = await requireDb()
    .select()
    .from(sqlLabConfigs)
    .where(eq(sqlLabConfigs.taskId, taskId))
    .limit(1);
  return row ?? null;
}

export interface SaveSqlLabConfigInput {
  datasetFileId: string;
  referenceQuery: string;
  gradeMode: SqlLabGradeMode;
}

/**
 * Validates the dataset + reference query by actually running them through the same sandbox a
 * student's submission will be graded against, then stores the result as the "expected" answer.
 * Re-running this (teacher edits the reference query, say) fully replaces the previous config.
 *
 * The dataset file is also added to the task's own `attachments` (if not already there) so the
 * existing file-access rules (server/modules/files.ts: `downloadAccess`/`tasksAttaching`) cover it
 * for free -- a student the task reaches can fetch the raw CSV bytes to load into DuckDB-Wasm in
 * their browser, with no new access-control code. This only touches the `attachments` column
 * directly (not tasks.ts's `updateAssignment`) so attaching a dataset never fires a "task updated"
 * notification to students.
 */
export async function saveSqlLabConfig(
  scope: TeacherScope,
  taskId: string,
  input: SaveSqlLabConfigInput
): Promise<SqlLabConfig> {
  const db = requireDb();
  const task = await assignmentOf(scope, taskId, db);
  const file = await fileRow(input.datasetFileId);
  if (!file || file.workspaceId !== scope.workspaceId)
    throw new AppError("NOT_FOUND");
  if (extensionOf(file.fileName) !== ".csv")
    throw new AppError("FILE_TYPE_NOT_ALLOWED");

  const csvText = (await fileBytes(file)).toString("utf-8");
  let dataset: ReturnType<typeof parseDataset>;
  try {
    dataset = parseDataset(csvText);
  } catch (e) {
    if (e instanceof SandboxExecutionError)
      throw new AppError("SQL_LAB_DATASET_INVALID");
    throw e;
  }

  let reference: Awaited<ReturnType<typeof runSandboxedQuery>>;
  try {
    reference = await runSandboxedQuery(csvText, input.referenceQuery, {
      maxRows: SANDBOX_MAX_RESULT_ROWS,
    });
  } catch (e) {
    if (e instanceof SandboxExecutionError)
      throw new AppError("SQL_LAB_REFERENCE_QUERY_FAILED");
    throw e;
  }

  if (!task.attachments.some(a => a.fileId === file.id)) {
    await db
      .update(tasks)
      .set({
        attachments: [
          ...task.attachments,
          { fileId: file.id, name: file.fileName, size: file.sizeBytes },
        ],
      })
      .where(eq(tasks.id, taskId));
  }

  const existing = await requireDb()
    .select({ id: sqlLabConfigs.id })
    .from(sqlLabConfigs)
    .where(eq(sqlLabConfigs.taskId, taskId))
    .limit(1);
  const values = {
    taskId,
    datasetFileId: file.id,
    datasetColumns: dataset.columns,
    referenceQuery: input.referenceQuery,
    gradeMode: input.gradeMode,
    expectedColumns: reference.columns,
    expectedRows: reference.rows,
    createdBy: scope.userId,
  };
  if (existing.length) {
    await db
      .update(sqlLabConfigs)
      .set(values)
      .where(eq(sqlLabConfigs.taskId, taskId));
  } else {
    await db.insert(sqlLabConfigs).values({ id: nanoid(), ...values });
  }
  return (await sqlLabConfigOf(scope, taskId))!;
}

export async function removeSqlLabConfig(scope: TeacherScope, taskId: string) {
  await assignmentOf(scope, taskId);
  await requireDb()
    .delete(sqlLabSubmissions)
    .where(eq(sqlLabSubmissions.taskId, taskId));
  await requireDb()
    .delete(sqlLabConfigs)
    .where(eq(sqlLabConfigs.taskId, taskId));
  return { ok: true };
}

/** Student-safe projection: dataset shape + grading mode, never the reference query or expected
 *  result (the task's "answer key" equivalent -- teacher eyes only, same rule as answerKey.ts). */
export interface StudentSqlLabConfig {
  datasetFileId: string;
  datasetColumns: string[];
  gradeMode: SqlLabGradeMode;
}

function toStudentConfig(row: SqlLabConfig): StudentSqlLabConfig {
  return {
    datasetFileId: row.datasetFileId,
    datasetColumns: row.datasetColumns,
    gradeMode: row.gradeMode,
  };
}

/** SQL lab configs for several tasks at once, keyed by taskId -- used to build the student-facing
 *  task list the same way quizRowsForTasks feeds `quiz` (see tasks.ts's studentAssignments). */
export async function sqlLabConfigsForTasks(
  taskIds: string[],
  db: DbOrTx = requireDb()
): Promise<Map<string, StudentSqlLabConfig>> {
  if (!taskIds.length) return new Map();
  const rows = await db
    .select()
    .from(sqlLabConfigs)
    .where(inArray(sqlLabConfigs.taskId, taskIds));
  return new Map(rows.map(r => [r.taskId, toStudentConfig(r)]));
}

/** What a student may see of their own SQL lab submission -- the grade is always visible (unlike a
 *  task's manual grade) since this is auto-graded instantly, with no teacher release step. */
export function studentSqlLabSubmissionView(s: SqlLabSubmission) {
  return {
    queryText: s.queryText,
    status: s.status,
    resultColumns: s.resultColumns,
    resultRowsPreview: s.resultRowsPreview,
    resultRowCount: s.resultRowCount,
    errorMessage: s.errorMessage,
    autoScore: s.autoScore,
    executionMs: s.executionMs,
    serverExecutedAt: s.serverExecutedAt,
  };
}
export type StudentSqlLabSubmissionView = ReturnType<
  typeof studentSqlLabSubmissionView
>;

export async function sqlLabSubmissionsForStudent(
  studentId: number,
  taskIds: string[],
  db: DbOrTx = requireDb()
): Promise<Map<string, StudentSqlLabSubmissionView>> {
  if (!taskIds.length) return new Map();
  const rows = await db
    .select()
    .from(sqlLabSubmissions)
    .where(
      and(
        eq(sqlLabSubmissions.studentId, studentId),
        inArray(sqlLabSubmissions.taskId, taskIds)
      )
    );
  return new Map(rows.map(r => [r.taskId, studentSqlLabSubmissionView(r)]));
}

export const MAX_SQL_LAB_QUERY_CHARS = 20_000;

/**
 * The student's "Göndər": never trusts whatever the browser's own DuckDB-Wasm preview showed --
 * re-runs the submitted query text independently, from scratch, in the same sandbox executor used
 * for the teacher's reference query (see server/modules/sqlSandbox.ts), against the dataset read
 * fresh from storage. Only this server-side result ever becomes the grade.
 */
export async function submitSqlLabQuery(
  studentId: number,
  groupIds: string[],
  taskId: string,
  queryText: string
): Promise<StudentSqlLabSubmissionView> {
  const db = requireDb();
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task) throw new AppError("NOT_FOUND");
  if (!taskReachesStudent(task, studentId, groupIds))
    throw new AppError(
      task.accessMode === "GROUPS" ? "TASK_NO_ACCESS" : "NOT_FOUND"
    );
  const [config] = await db
    .select()
    .from(sqlLabConfigs)
    .where(eq(sqlLabConfigs.taskId, taskId))
    .limit(1);
  if (!config) throw new AppError("SQL_LAB_NOT_CONFIGURED");

  const file = await fileRow(config.datasetFileId);
  if (!file) throw new AppError("SQL_LAB_DATASET_INVALID");
  const csvText = (await fileBytes(file)).toString("utf-8");
  const text = queryText.trim().slice(0, MAX_SQL_LAB_QUERY_CHARS);

  const id = nanoid();
  const submissionId = nanoid();
  const now = new Date();
  let values: Omit<SqlLabSubmission, "id" | "serverExecutedAt">;
  try {
    const result = await runSandboxedQuery(csvText, text, {
      maxRows: SANDBOX_MAX_RESULT_ROWS,
    });
    const comparison = compareSqlResults(
      { columns: config.expectedColumns, rows: config.expectedRows },
      { columns: result.columns, rows: result.rows },
      config.gradeMode
    );
    values = {
      submissionId,
      taskId,
      studentId,
      queryText: text,
      status: comparison.correct ? "CORRECT" : "WRONG",
      resultColumns: result.columns,
      resultRowsPreview: result.rows.slice(0, SANDBOX_PREVIEW_ROWS),
      resultRowCount: result.rowCount,
      errorMessage: null,
      autoScore: comparison.correct ? 100 : 0,
      executionMs: result.elapsedMs,
    };
  } catch (e) {
    if (!(e instanceof SandboxExecutionError)) throw e;
    values = {
      submissionId,
      taskId,
      studentId,
      queryText: text,
      status: "ERROR",
      resultColumns: null,
      resultRowsPreview: null,
      resultRowCount: null,
      errorMessage: e.message,
      autoScore: 0,
      executionMs: 0,
    };
  }

  const [existing] = await db
    .select({ id: sqlLabSubmissions.id })
    .from(sqlLabSubmissions)
    .where(
      and(
        eq(sqlLabSubmissions.taskId, taskId),
        eq(sqlLabSubmissions.studentId, studentId)
      )
    )
    .limit(1);
  if (existing) {
    await db
      .update(sqlLabSubmissions)
      .set({ ...values, serverExecutedAt: now })
      .where(eq(sqlLabSubmissions.id, existing.id));
  } else {
    await db
      .insert(sqlLabSubmissions)
      .values({ id, ...values, serverExecutedAt: now });
  }
  const [row] = await db
    .select()
    .from(sqlLabSubmissions)
    .where(
      and(
        eq(sqlLabSubmissions.taskId, taskId),
        eq(sqlLabSubmissions.studentId, studentId)
      )
    )
    .limit(1);
  return studentSqlLabSubmissionView(row);
}
