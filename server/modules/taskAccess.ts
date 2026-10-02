import type { TaskAccessMode } from "../../drizzle/schema";

/**
 * Pure access rules for a task's share link, its attached files, claiming and submitting — kept
 * free of database calls so every caller (public page query, file download route, claim/submit
 * mutations, student dashboard) applies the exact same decision, and so it is unit-testable.
 */

export type TaskAccessSubject = { accessMode: TaskAccessMode; groupIds: string[]; studentIds: number[] };

/**
 * OWNER: the workspace's teacher. ALLOWED: may see the task and its files. SIGN_IN_REQUIRED:
 * restricted task, anonymous visitor. DENIED: signed in, but not a member of any selected group.
 */
export type TaskViewerAccess = "OWNER" | "ALLOWED" | "SIGN_IN_REQUIRED" | "DENIED";

export type TaskViewer = { userId: number; managesWorkspace: boolean; groupIds: string[] };

const inAnyGroup = (task: Pick<TaskAccessSubject, "groupIds">, groupIds: string[]) => task.groupIds.some((g) => groupIds.includes(g));

/** Whether the task reaches this student as a recipient (dashboard list, submitting, attachment downloads). */
export function taskReachesStudent(task: TaskAccessSubject, studentId: number, studentGroupIds: string[]): boolean {
  if (inAnyGroup(task, studentGroupIds)) return true;
  return task.accessMode === "PUBLIC" && task.studentIds.includes(studentId);
}

/** What one visitor (null = not signed in) gets on the task's public share page. */
export function taskViewerAccess(task: TaskAccessSubject, viewer: TaskViewer | null): TaskViewerAccess {
  if (viewer?.managesWorkspace) return "OWNER";
  if (task.accessMode === "PUBLIC") return "ALLOWED";
  if (!viewer) return "SIGN_IN_REQUIRED";
  return inAnyGroup(task, viewer.groupIds) ? "ALLOWED" : "DENIED";
}

export const canSeeTaskContent = (access: TaskViewerAccess) => access === "OWNER" || access === "ALLOWED";

/**
 * Whether an `isPublic` file may still be served to anyone without a session. Task attachments
 * are uploaded public (the public task page links them), so a file attached only to restricted
 * tasks has to fall back to a per-user check. A material file, or one attached to at least one
 * open-link task, stays public; a file not (yet) attached to anything keeps its upload-time flag.
 */
export function fileOpenToAnyone(isPublic: boolean, attachedTo: Pick<TaskAccessSubject, "accessMode">[], isMaterialFile: boolean): boolean {
  if (!isPublic) return false;
  if (isMaterialFile || !attachedTo.length) return true;
  return attachedTo.some((t) => t.accessMode === "PUBLIC");
}

/** Who gets the "new task" notification and counts as the task's roster in teacher reports. */
export function rosterStudentIds(task: TaskAccessSubject, groupMemberIds: number[]): number[] {
  return [...new Set(task.accessMode === "GROUPS" ? groupMemberIds : [...groupMemberIds, ...task.studentIds])];
}
