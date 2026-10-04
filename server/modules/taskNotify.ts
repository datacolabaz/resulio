import { createHash } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import { groupMembers, groups, providerWorkspaces, taskSubmissions, tasks, users, type Task } from "../../drizzle/schema";
import { requireDb } from "../db";
import { dispatch, dispatchManyNow, reserve, type DispatchInput } from "../notifications/dispatcher";
import type { TaskNoticeItem } from "../notifications/events";
import { TASK_NOTICE_MAX_ITEMS, taskExcerpt } from "../notifications/templates";
import { syllabusContainerTaskIds } from "./syllabusLinks";
import { rosterStudentIds, type TaskAccessSubject } from "./taskAccess";

/**
 * "New task" notices (TASK_ASSIGNED) through the shared dispatcher, never blocking the save:
 * - create: every student the task reaches; edit: only students it newly reaches;
 * - a deadline moved by at least an hour: TASK_UPDATED to students it already reached;
 * - a student joining a group: one batched notice for the group's open tasks.
 * One dedupe key per (task, student), so re-saves and re-joins never notify twice.
 */

export const DEADLINE_NOTICE_MIN_SHIFT_MS = 60 * 60_000;

export interface MemberRow {
  groupId: string;
  userId: number;
  status: string;
  membershipRole: string;
}

/** Pure: active student members of the task's groups, plus the individually picked students of an open-link task; never the teacher. */
export function taskRecipients(task: TaskAccessSubject, members: MemberRow[], teacherId: number): number[] {
  const inTask = new Set(task.groupIds);
  const fromGroups = members.filter((m) => inTask.has(m.groupId) && m.status === "ACTIVE" && m.membershipRole === "STUDENT").map((m) => m.userId);
  return rosterStudentIds(task, fromGroups).filter((id) => id !== teacherId);
}

export interface TaskSaveNotices {
  assigned: number[];
  deadlineMoved: number[];
}

/** Pure: who hears about one save. `before` is null on create. */
export function planTaskSaveNotices(input: {
  before: { recipients: number[]; deadline: Date } | null;
  after: { recipients: number[]; deadline: Date };
  notify: boolean;
}): TaskSaveNotices {
  const after = [...new Set(input.after.recipients)];
  if (!input.notify) return { assigned: [], deadlineMoved: [] };
  if (!input.before) return { assigned: after, deadlineMoved: [] };
  const had = new Set(input.before.recipients);
  const moved = Math.abs(input.after.deadline.getTime() - input.before.deadline.getTime()) >= DEADLINE_NOTICE_MIN_SHIFT_MS;
  return { assigned: after.filter((id) => !had.has(id)), deadlineMoved: moved ? after.filter((id) => had.has(id)) : [] };
}

export const taskAssignedKey = (taskId: string, userId: number) => `task-assigned:${taskId}:${userId}`;
export const taskDeadlineKey = (taskId: string, userId: number, deadline: Date) => `task-deadline:${taskId}:${userId}:${deadline.getTime()}`;
const joinBatchKey = (userId: number, taskIds: string[]) =>
  `task-join:${userId}:${createHash("sha256").update([...taskIds].sort().join("|")).digest("hex").slice(0, 24)}`;

/** What a notice may say about a task: title, a short description excerpt and the deadline — never the answer key or files. */
export function taskNoticeItem(task: Pick<Task, "id" | "title" | "description" | "deadline">): TaskNoticeItem {
  return { taskId: task.id, title: task.title, excerpt: taskExcerpt(task.description), deadline: task.deadline.toISOString() };
}

type SavedTask = Pick<Task, "id" | "title" | "description" | "deadline">;

/** Pure: the dispatches for one save. */
export function taskSaveDispatches(task: SavedTask, plan: TaskSaveNotices, from: string, previousDeadline: Date | null): DispatchInput[] {
  const item = taskNoticeItem(task);
  const assigned: DispatchInput[] = plan.assigned.map((userId) => ({
    event: "TASK_ASSIGNED",
    userId,
    dedupeKey: taskAssignedKey(task.id, userId),
    data: { tasks: [item], total: 1, from },
  }));
  const moved: DispatchInput[] = previousDeadline
    ? plan.deadlineMoved.map((userId) => ({
        event: "TASK_UPDATED",
        userId,
        dedupeKey: taskDeadlineKey(task.id, userId, task.deadline),
        data: { taskId: task.id, title: task.title, deadline: item.deadline, previousDeadline: previousDeadline.toISOString() },
      }))
    : [];
  return [...assigned, ...moved];
}

/** Pure: a group's tasks worth announcing to a student who just joined it, soonest deadline first. */
export function openTasksForJoin<T extends Pick<Task, "id" | "groupIds" | "deadline" | "createdBy">>(
  rows: T[],
  input: { groupId: string; userId: number; submitted: ReadonlySet<string>; containers: ReadonlySet<string>; now: Date },
): T[] {
  return rows
    .filter((t) => t.groupIds.includes(input.groupId) && t.deadline > input.now && t.createdBy !== input.userId)
    .filter((t) => !input.submitted.has(t.id) && !input.containers.has(t.id))
    .sort((a, b) => a.deadline.getTime() - b.deadline.getTime());
}

async function memberRows(groupIds: string[]): Promise<MemberRow[]> {
  if (!groupIds.length) return [];
  return requireDb()
    .select({ groupId: groupMembers.groupId, userId: groupMembers.userId, status: groupMembers.status, membershipRole: groupMembers.membershipRole })
    .from(groupMembers)
    .where(inArray(groupMembers.groupId, groupIds));
}

/** Who the notice says it is from: the workspace's public name, else the teacher's name, else the workspace title. */
async function senderName(workspaceId: string, teacherId: number): Promise<string> {
  const db = requireDb();
  const [ws] = await db.select({ display: providerWorkspaces.publicDisplayName, title: providerWorkspaces.title }).from(providerWorkspaces).where(eq(providerWorkspaces.id, workspaceId)).limit(1);
  if (ws?.display.trim()) return ws.display.trim();
  const [teacher] = await db.select({ name: users.name }).from(users).where(eq(users.id, teacherId)).limit(1);
  return teacher?.name?.trim() || ws?.title.trim() || "";
}

/**
 * After a task is created (`before` null) or edited. Runs in the background; `notify` false
 * (the teacher unticked "Tələbələrə bildiriş göndər") sends nothing for this save.
 */
export function notifyTaskSaved(input: {
  task: Task;
  before: (TaskAccessSubject & { deadline: Date }) | null;
  notify: boolean;
  teacherId: number;
}) {
  if (!input.notify) return;
  setImmediate(() => {
    void (async () => {
      const { task, before } = input;
      const members = await memberRows([...new Set([...task.groupIds, ...(before?.groupIds ?? [])])]);
      const plan = planTaskSaveNotices({
        before: before ? { recipients: taskRecipients(before, members, input.teacherId), deadline: before.deadline } : null,
        after: { recipients: taskRecipients(task, members, input.teacherId), deadline: task.deadline },
        notify: true,
      });
      if (!plan.assigned.length && !plan.deadlineMoved.length) return;
      const from = await senderName(task.providerWorkspaceId, task.createdBy);
      await dispatchManyNow(taskSaveDispatches(task, plan, from, before?.deadline ?? null));
    })().catch((error) => console.error("[tasks] task notices failed", error instanceof Error ? error.message : error));
  });
}

/**
 * A student became an active member of a group: one notice listing the group's open tasks
 * (future deadline, not yet submitted) they have not been told about. Background, best effort.
 */
export function notifyOpenTasksOnJoin(groupId: string, userId: number) {
  setImmediate(() => {
    void (async () => {
      const db = requireDb();
      const [group] = await db.select({ workspaceId: groups.providerWorkspaceId }).from(groups).where(eq(groups.id, groupId)).limit(1);
      if (!group) return;
      const now = new Date();
      const rows = await db.select().from(tasks).where(and(eq(tasks.providerWorkspaceId, group.workspaceId), gt(tasks.deadline, now)));
      const inGroup = rows.filter((t) => t.groupIds.includes(groupId));
      if (!inGroup.length) return;
      const ids = inGroup.map((t) => t.id);
      const [subs, containers] = await Promise.all([
        db.select({ taskId: taskSubmissions.taskId }).from(taskSubmissions).where(and(eq(taskSubmissions.studentId, userId), inArray(taskSubmissions.taskId, ids))),
        syllabusContainerTaskIds(ids),
      ]);
      const open = openTasksForJoin(inGroup, { groupId, userId, submitted: new Set(subs.map((s) => s.taskId)), containers, now });
      const fresh: Task[] = [];
      for (const t of open) {
        if (await reserve({ event: "TASK_ASSIGNED", userId, dedupeKey: taskAssignedKey(t.id, userId), reason: "BATCHED" })) fresh.push(t);
      }
      if (!fresh.length) return;
      const from = await senderName(group.workspaceId, fresh[0].createdBy);
      dispatch({
        event: "TASK_ASSIGNED",
        userId,
        dedupeKey: joinBatchKey(userId, fresh.map((t) => t.id)),
        data: { tasks: fresh.slice(0, TASK_NOTICE_MAX_ITEMS).map(taskNoticeItem), total: fresh.length, from },
      });
    })().catch((error) => console.error("[tasks] join notices failed", error instanceof Error ? error.message : error));
  });
}
