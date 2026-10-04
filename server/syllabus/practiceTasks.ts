import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { syllabi, syllabusPracticeTasks, taskAnswerKeys, taskGradingSettings, tasks } from "../../drizzle/schema";
import { studentPracticeContentSchema, TIMESTAMP_MAX } from "../../shared/syllabus";
import type { DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";

/**
 * STUDENT_PRACTICE items submit into a hidden `tasks` row so the existing submission, AI review,
 * auto-grade and teacher grading paths work unchanged. The container reaches nobody through the
 * normal task paths (GROUPS mode with no groups), and never shows in the teacher's task list.
 */

/** "Never closes" for the task engine, but inside the TIMESTAMP range (a 2099 date failed every insert). */
export const CONTAINER_DEADLINE = TIMESTAMP_MAX;
const shareCode = () => nanoid(10).replace(/[-_]/g, "x").toUpperCase();

function taskFields(title: string, content: Record<string, unknown>) {
  const c = studentPracticeContentSchema.parse(content);
  return { title: title.slice(0, 255) || "Praktika", description: c.instructions, instructions: c.expectedResult, attachments: c.attachments, autoGrade: c.evaluation === "AI_AUTO" };
}

async function setAutoGrade(db: DbOrTx, taskId: string, autoGrade: boolean) {
  try {
    await db.insert(taskGradingSettings).values({ taskId, autoGrade }).onDuplicateKeyUpdate({ set: { autoGrade } });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
}

export async function createContainer(
  db: DbOrTx,
  owner: { workspaceId: string; userId: number },
  link: { syllabusId: string; itemId: string; versionId: string | null },
  title: string,
  content: Record<string, unknown>,
) {
  const id = nanoid();
  const { autoGrade, ...fields } = taskFields(title, content);
  await db.insert(tasks).values({
    id,
    providerWorkspaceId: owner.workspaceId,
    createdBy: owner.userId,
    shareCode: shareCode(),
    ...fields,
    deadline: CONTAINER_DEADLINE,
    groupIds: [],
    studentIds: [],
    accessMode: "GROUPS",
  });
  await db.insert(syllabusPracticeTasks).values({ taskId: id, ...link });
  await setAutoGrade(db, id, autoGrade);
  return id;
}

/** Removes every container of a never-published syllabus (with keys and grading switches). */
export async function deleteContainers(db: DbOrTx, workspaceId: string, syllabusId: string) {
  const rows = await db.select({ taskId: syllabusPracticeTasks.taskId }).from(syllabusPracticeTasks).where(eq(syllabusPracticeTasks.syllabusId, syllabusId));
  const taskIds = rows.map((r) => r.taskId);
  if (!taskIds.length) return;
  await db.delete(taskAnswerKeys).where(inArray(taskAnswerKeys.taskId, taskIds));
  try {
    await db.delete(taskGradingSettings).where(inArray(taskGradingSettings.taskId, taskIds));
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  await db.delete(tasks).where(and(inArray(tasks.id, taskIds), eq(tasks.providerWorkspaceId, workspaceId)));
  await db.delete(syllabusPracticeTasks).where(eq(syllabusPracticeTasks.syllabusId, syllabusId));
}

/** Keeps the draft container in step with the item (the frozen copies of versions are never touched). */
export async function syncContainer(db: DbOrTx, taskId: string, title: string, content: Record<string, unknown>) {
  const { autoGrade, ...fields } = taskFields(title, content);
  await db.update(tasks).set(fields).where(eq(tasks.id, taskId));
  await setAutoGrade(db, taskId, autoGrade);
}

/**
 * Saving the answer key of a draft container is a draft change: the key is part of the publish hash,
 * so the builder must show "unpublished changes". Frozen (published) containers are left alone.
 */
export async function markDraftChangedForContainer(db: DbOrTx, taskId: string) {
  try {
    const [link] = await db
      .select({ syllabusId: syllabusPracticeTasks.syllabusId })
      .from(syllabusPracticeTasks)
      .where(and(eq(syllabusPracticeTasks.taskId, taskId), isNull(syllabusPracticeTasks.versionId)))
      .limit(1);
    if (!link) return false;
    await db
      .update(syllabi)
      .set({ draftRevision: sql`${syllabi.draftRevision} + 1`, hasDraftChanges: true })
      .where(eq(syllabi.id, link.syllabusId));
    return true;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

export async function answerKeyOf(db: DbOrTx, taskId: string) {
  const [row] = await db.select({ answerKey: taskAnswerKeys.answerKey }).from(taskAnswerKeys).where(eq(taskAnswerKeys.taskId, taskId)).limit(1);
  return row?.answerKey ?? null;
}

/** A frozen (or duplicated) copy of a container, including its hidden answer key and grading switch. */
export async function cloneContainer(
  db: DbOrTx,
  sourceTaskId: string,
  owner: { workspaceId: string; userId: number },
  link: { syllabusId: string; itemId: string; versionId: string | null },
  title: string,
  content: Record<string, unknown>,
) {
  const id = await createContainer(db, owner, link, title, content);
  const [key] = await db.select().from(taskAnswerKeys).where(eq(taskAnswerKeys.taskId, sourceTaskId)).limit(1);
  if (key?.answerKey) {
    await db.insert(taskAnswerKeys).values({ taskId: id, answerKey: key.answerKey, source: key.source, draftStatus: key.draftStatus, updatedByUserId: key.updatedByUserId });
  }
  return id;
}
