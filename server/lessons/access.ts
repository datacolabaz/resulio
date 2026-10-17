import type { LessonStatus } from "../../shared/lessonIntegration";
import { withinJoinWindow } from "../../shared/lessonIntegration";

/**
 * Pure access rules for a lesson's recipients and join link, kept free of database calls so every
 * caller (student dashboard list, join route, attendance/consent writes) applies the exact same
 * decision. Mirrors server/modules/taskAccess.ts, minus the "PUBLIC share link" case tasks have --
 * a lesson always has recipients, never an open link.
 */

export type LessonAccessSubject = { groupIds: string[]; studentIds: number[] };

/** Whether the lesson reaches this student at all (its roster), regardless of timing. */
export function lessonReachesStudent(lesson: LessonAccessSubject, studentId: number, studentGroupIds: string[]): boolean {
  if (lesson.groupIds.some((g) => studentGroupIds.includes(g))) return true;
  return lesson.studentIds.includes(studentId);
}

/** The lesson's roster for notifications and the teacher's attendance view. */
export function lessonRosterStudentIds(groupMemberIds: number[], studentIds: number[]): number[] {
  return [...new Set([...groupMemberIds, ...studentIds])];
}

export type LessonJoinDecision = "OWNER" | "ALLOWED" | "NOT_YET_OPEN" | "CLOSED" | "DENIED";

/**
 * What a signed-in user gets when hitting the gated join route right now. The teacher who owns
 * the workspace may always join (to start/host); a recipient student may join only inside the
 * window; anyone else is denied outright, never told whether the lesson even exists to them.
 */
export function lessonJoinDecision(
  lesson: { startsAt: Date; endsAt: Date; status: LessonStatus; joinWindowBeforeMin: number; joinWindowAfterMin: number } & LessonAccessSubject,
  viewer: { userId: number; managesWorkspace: boolean; studentId: number | null; studentGroupIds: string[] },
  now: Date,
): LessonJoinDecision {
  if (viewer.managesWorkspace) return "OWNER";
  if (viewer.studentId === null || !lessonReachesStudent(lesson, viewer.studentId, viewer.studentGroupIds)) return "DENIED";
  if (lesson.status === "CANCELLED") return "CLOSED";
  if (!withinJoinWindow(lesson, now)) {
    return now.getTime() < lesson.startsAt.getTime() - lesson.joinWindowBeforeMin * 60_000 ? "NOT_YET_OPEN" : "CLOSED";
  }
  return "ALLOWED";
}
