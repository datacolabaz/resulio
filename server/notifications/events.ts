import type { AnnouncementLanguage, AnnouncementTexts } from "../../shared/announcements";

/**
 * Notification domain events and the channels each may use. Adding an event: declare it here,
 * give it a renderer in render.ts, then call `dispatch` where it happens. See docs/NOTIFICATIONS.md.
 */

export const CHANNELS = ["IN_APP", "EMAIL", "PUSH"] as const;
export type Channel = (typeof CHANNELS)[number];

export const EVENT_TYPES = [
  "AI_GRADE_READY",
  "GRADE_RELEASED",
  "GRADE_UPDATED",
  "AI_LIMIT_80",
  "AI_LIMIT_REACHED",
  "AI_PROVIDER_ERROR",
  "ANSWER_KEY_DRAFTED",
  "SYLLABUS_ACCESS_GRANTED",
  "SYLLABUS_UNLOCKED",
  "SYLLABUS_APPROVAL_NEEDED",
  "SYLLABUS_COMPLETED",
  "SYLLABUS_AT_RISK_DIGEST",
  "TASK_ASSIGNED",
  "TASK_UPDATED",
  "MATERIAL_SHARED",
  "EXAM_RESULT_READY",
  "GROUP_MEMBER_JOINED",
  "GROUP_JOIN_DECIDED",
  "SYLLABUS_JOIN_REQUESTED",
  "SYLLABUS_JOIN_DECIDED",
  "ANNOUNCEMENT",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventData {
  AI_GRADE_READY: { submissionId: string; taskTitle: string; score: number; feedback: string; strengths: string[]; improvements: string[] };
  GRADE_RELEASED: { taskTitle: string; score: number | null };
  GRADE_UPDATED: { taskTitle: string; score: number | null };
  AI_LIMIT_80: { workspace: string; used: number; limit: number };
  AI_LIMIT_REACHED: { workspace: string; used: number; limit: number };
  AI_PROVIDER_ERROR: { workspace: string; problem: "AUTH" | "QUOTA" };
  /** Never carries the key itself. */
  ANSWER_KEY_DRAFTED: { taskId: string; taskTitle: string };
  /** `startsAt` (ISO) when the grant opens later. */
  SYLLABUS_ACCESS_GRANTED: { syllabusId: string; syllabusTitle: string; startsAt: string | null };
  /** One batched notice for lessons and modules that opened together. */
  SYLLABUS_UNLOCKED: { syllabusId: string; syllabusTitle: string; lessons: string[]; modules: string[]; lessonId: string | null };
  /** To the teacher: students waiting for an approval in one syllabus. */
  SYLLABUS_APPROVAL_NEEDED: { syllabusId: string; syllabusTitle: string; count: number; studentName: string | null };
  SYLLABUS_COMPLETED: { syllabusId: string; syllabusTitle: string; verificationCode: string | null };
  /** To the teacher, once a day: students flagged at risk in one syllabus (`names` holds at most five). */
  SYLLABUS_AT_RISK_DIGEST: { syllabusId: string; syllabusTitle: string; count: number; names: string[] };
  /** One task, or the open tasks of a group the student just joined (`total` may exceed `tasks.length`). Never the answer key or files. */
  TASK_ASSIGNED: { tasks: TaskNoticeItem[]; total: number; from: string };
  /** The deadline of a task the student already had moved. */
  TASK_UPDATED: { taskId: string; title: string; deadline: string; previousDeadline: string };
  /** A material became visible to the student (published now, or its scheduled time came). Never file names or links. */
  MATERIAL_SHARED: { materialId: string; title: string; excerpt: string; from: string };
  /** A final, released exam result, for exams whose teacher chose "e-mail results". Never the answers. */
  EXAM_RESULT_READY: ExamResultNotice;
  /**
   * To the group's teacher: a student joined through an invite link (informational), or with
   * `pending` (absent on older rows) asked to join through the group code and waits for approval.
   */
  GROUP_MEMBER_JOINED: { groupId: string; groupName: string; studentName: string | null; pending?: boolean };
  /** To the student: the teacher approved or declined their group code request. */
  GROUP_JOIN_DECIDED: { groupId: string; groupName: string; decision: "APPROVED" | "DECLINED" };
  /** To the teacher: a student asked, from the syllabus share page, to join a group (`groupName`) or to take part individually (null). */
  SYLLABUS_JOIN_REQUESTED: { requestId: string; syllabusId: string; syllabusTitle: string; studentName: string | null; groupName: string | null };
  /**
   * To the student: the teacher answered their request. `path` is where the notice leads;
   * `accessGranted` (absent on older rows) when accepting also opened the syllabus to them.
   */
  SYLLABUS_JOIN_DECIDED: { requestId: string; syllabusTitle: string; decision: "ACCEPTED" | "REJECTED"; groupName: string | null; note: string | null; path: string; accessGranted?: boolean };
  /** An admin's platform announcement (announcements.ts); the recipient's language is picked at render time. */
  ANNOUNCEMENT: { announcementId: number; language: AnnouncementLanguage; texts: AnnouncementTexts; url: string };
}

export interface ExamResultNotice {
  resultId: string;
  title: string;
  earnedPoints: number;
  totalPoints: number;
  percentage: number;
  correctCount: number;
  wrongCount: number;
  penalty: { ratio: number; wrongCount: number; penaltyPoints: number } | null;
}

export interface TaskNoticeItem {
  taskId: string;
  title: string;
  /** Plain-text start of the description, already shortened. */
  excerpt: string;
  /** ISO timestamp. */
  deadline: string;
}

export interface EventDefinition {
  /** Channels this event can go to; all are on by default unless the user opts out. */
  channels: readonly Channel[];
  /** Channels that stay off until the user turns them on. */
  defaultOff?: readonly Channel[];
}

export const EVENTS: Record<EventType, EventDefinition> = {
  // The one "result ready" notice of an automatic AI grade; replaces GRADE_RELEASED for it.
  AI_GRADE_READY: { channels: ["IN_APP", "EMAIL", "PUSH"] },
  GRADE_RELEASED: { channels: ["IN_APP", "EMAIL", "PUSH"] },
  GRADE_UPDATED: { channels: ["IN_APP", "EMAIL", "PUSH"] },
  AI_LIMIT_80: { channels: ["IN_APP", "PUSH"] },
  AI_LIMIT_REACHED: { channels: ["IN_APP", "PUSH"] },
  AI_PROVIDER_ERROR: { channels: ["IN_APP", "PUSH"] },
  // To the task's teacher: the AI drafted a missing answer key and grades with it; please review.
  ANSWER_KEY_DRAFTED: { channels: ["IN_APP", "PUSH"] },
  // Syllabus: e-mail only for the two notices a student should not miss; unlocks and approvals stay in-app.
  SYLLABUS_ACCESS_GRANTED: { channels: ["IN_APP", "EMAIL", "PUSH"] },
  SYLLABUS_UNLOCKED: { channels: ["IN_APP", "PUSH"] },
  SYLLABUS_APPROVAL_NEEDED: { channels: ["IN_APP", "PUSH"] },
  SYLLABUS_COMPLETED: { channels: ["IN_APP", "EMAIL", "PUSH"] },
  // Daily teacher digest: in-app by default, e-mail only when the teacher opts in.
  SYLLABUS_AT_RISK_DIGEST: { channels: ["IN_APP", "EMAIL"], defaultOff: ["EMAIL"] },
  TASK_ASSIGNED: { channels: ["IN_APP", "EMAIL", "PUSH"] },
  // A moved deadline: in-app by default, e-mail only when the student opts in.
  TASK_UPDATED: { channels: ["IN_APP", "EMAIL", "PUSH"], defaultOff: ["EMAIL"] },
  // Materials are frequent: in-app and push by default, e-mail only when the student opts in.
  MATERIAL_SHARED: { channels: ["IN_APP", "EMAIL", "PUSH"], defaultOff: ["EMAIL"] },
  // Only for exams whose teacher ticked "e-mail results"; the in-app "result ready" notice exists already.
  EXAM_RESULT_READY: { channels: ["EMAIL"] },
  GROUP_MEMBER_JOINED: { channels: ["IN_APP", "PUSH"] },
  GROUP_JOIN_DECIDED: { channels: ["IN_APP", "PUSH"] },
  SYLLABUS_JOIN_REQUESTED: { channels: ["IN_APP", "PUSH"] },
  SYLLABUS_JOIN_DECIDED: { channels: ["IN_APP", "PUSH"] },
  ANNOUNCEMENT: { channels: ["IN_APP", "PUSH"] },
};

export const isEventType = (v: string): v is EventType => (EVENT_TYPES as readonly string[]).includes(v);
export const isChannel = (v: string): v is Channel => (CHANNELS as readonly string[]).includes(v);
