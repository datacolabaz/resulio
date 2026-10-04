/**
 * Groupmate progress (owner decision Q7): members of a group see each other's syllabus progress
 * unless the teacher turns `group_learning_settings.progressVisibleToGroup` off (default ON). It is a
 * sibling of `study_groups.scoresVisibleToGroup` rather than a reuse, because progress and scores are
 * different things to hide. Only progress fields leave the server — never answers, feedback, scores
 * or activity times.
 */

export interface GroupmateSource {
  studentId: number;
  name: string | null;
}

export interface GroupmateEnrollment {
  studentId: number;
  progressPct: number;
  completedLessons: number;
  totalLessons: number;
  currentModuleId: string | null;
  status: "ACTIVE" | "COMPLETED";
}

export interface GroupmateRow {
  studentId: number;
  name: string;
  isMe: boolean;
  started: boolean;
  completed: boolean;
  progressPct: number;
  completedLessons: number;
  totalLessons: number;
  currentModuleTitle: string | null;
}

export function groupmateRows(
  members: readonly GroupmateSource[],
  enrollments: readonly GroupmateEnrollment[],
  moduleTitles: ReadonlyMap<string, string>,
  viewerId: number,
): GroupmateRow[] {
  const byStudent = new Map(enrollments.map((e) => [e.studentId, e]));
  return members
    .map((m) => {
      const e = byStudent.get(m.studentId);
      return {
        studentId: m.studentId,
        name: m.name ?? "—",
        isMe: m.studentId === viewerId,
        started: !!e,
        completed: e?.status === "COMPLETED",
        progressPct: e?.progressPct ?? 0,
        completedLessons: e?.completedLessons ?? 0,
        totalLessons: e?.totalLessons ?? 0,
        currentModuleTitle: e?.currentModuleId ? (moduleTitles.get(e.currentModuleId) ?? null) : null,
      };
    })
    .sort((a, b) => b.progressPct - a.progressPct || a.name.localeCompare(b.name));
}

export const DEFAULT_PROGRESS_VISIBLE_TO_GROUP = true;
