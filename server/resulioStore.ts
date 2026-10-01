import { nanoid } from "nanoid";
import type { QuestionInput } from "../shared/assessment";
import type { TeacherScope } from "./modules/access";

/**
 * In-memory store for Phase 2/3 modules (assignments, library, notifications, AI drafts).
 * Phase 1 (groups, assessments, attempts, results) is persisted in MySQL via server/modules.
 * Data here is lost on restart. Everything a provider creates is keyed by Provider Workspace.
 */

export type AssignmentStatus = "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "LATE" | "REVIEWED";

export type AssignmentRecord = {
  id: string;
  workspaceId: string;
  createdBy: number;
  shareCode: string;
  title: string;
  description: string;
  instructions: string;
  deadline: string;
  groupIds: string[];
  studentIds: number[];
  attachments: Array<{ name: string; size: string }>;
};

export type SubmissionRecord = {
  id: string;
  assignmentId: string;
  studentId: number;
  status: AssignmentStatus;
  files: Array<{ name: string }>;
  submittedAt?: string;
  comment?: string;
};

export type MaterialRecord = {
  id: string;
  workspaceId: string;
  createdBy: number;
  shareCode: string;
  title: string;
  description: string;
  subject: string;
  topic: string;
  fileName: string;
  groupIds: string[];
  studentIds: number[];
  uploadedAt: string;
};

export type NotificationRecord = {
  id: string;
  userId: number;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
};

export type AiDraft = {
  id: string;
  workspaceId: string;
  questions: Array<{ tempId: string; question: QuestionInput }>;
};

const nowIso = () => new Date().toISOString();
const newShareCode = () => nanoid(10).replace(/[-_]/g, "x").toUpperCase();

class ResulioStore {
  assignments: AssignmentRecord[] = [];
  submissions: SubmissionRecord[] = [];
  materials: MaterialRecord[] = [];
  notifications: NotificationRecord[] = [];
  aiUsage: Record<string, { used: number; limit: number }> = {};
  aiDrafts: AiDraft[] = [];

  studentAssignments(studentId: number, groupIds: string[]) {
    return this.assignments
      .filter((a) => a.studentIds.includes(studentId) || a.groupIds.some((g) => groupIds.includes(g)))
      .map((a) => ({
        ...a,
        submission: this.submissions.find((s) => s.assignmentId === a.id && s.studentId === studentId),
      }));
  }

  /** `notifyUserId` is the workspace owner, resolved by the caller from the database. */
  submitAssignment(studentId: number, groupIds: string[], assignmentId: string, files: string[], notifyUserId?: number) {
    const asg = this.studentAssignments(studentId, groupIds).find((a) => a.id === assignmentId);
    if (!asg) throw new Error("NOT_FOUND");
    let sub = this.submissions.find((s) => s.assignmentId === assignmentId && s.studentId === studentId);
    const late = new Date(asg.deadline).getTime() < Date.now();
    if (!sub) {
      sub = {
        id: nanoid(),
        assignmentId,
        studentId,
        status: late ? "LATE" : "SUBMITTED",
        files: files.map((name) => ({ name })),
        submittedAt: nowIso(),
      };
      this.submissions.push(sub);
    } else {
      sub.status = late ? "LATE" : "SUBMITTED";
      sub.files = files.map((name) => ({ name }));
      sub.submittedAt = nowIso();
    }
    this.notify(notifyUserId ?? asg.createdBy, "Yeni təslim", "Tələbə tapşırıq göndərdi");
    return sub;
  }

  workspaceAssignments(workspaceId: string) {
    return this.assignments.filter((a) => a.workspaceId === workspaceId);
  }

  /** Throws NOT_FOUND if the assignment doesn't exist or belongs to another workspace. */
  assignmentOf(scope: TeacherScope, id: string): AssignmentRecord {
    const row = this.assignments.find((a) => a.id === id && a.workspaceId === scope.workspaceId);
    if (!row) throw new Error("NOT_FOUND");
    return row;
  }

  createAssignment(
    scope: TeacherScope,
    input: Omit<AssignmentRecord, "id" | "workspaceId" | "createdBy" | "shareCode">,
    recipientIds: number[],
  ) {
    const row: AssignmentRecord = { id: nanoid(), workspaceId: scope.workspaceId, createdBy: scope.userId, shareCode: newShareCode(), ...input };
    this.assignments.push(row);
    for (const sid of new Set(recipientIds)) this.notify(sid, "Yeni tapşırıq", row.title);
    return row;
  }

  /**
   * Edits an existing assignment in place (fixing a forgotten recipient, a wrong deadline, etc.).
   * Does not re-notify recipients — `createAssignment` already did, and an edit is not a new
   * assignment; the caller can call `notify` itself for newly added recipients if it wants to.
   */
  updateAssignment(scope: TeacherScope, id: string, patch: Partial<Omit<AssignmentRecord, "id" | "workspaceId" | "createdBy" | "shareCode">>) {
    const row = this.assignmentOf(scope, id);
    Object.assign(row, patch);
    return row;
  }

  deleteAssignment(scope: TeacherScope, id: string) {
    const row = this.assignmentOf(scope, id);
    this.assignments = this.assignments.filter((a) => a.id !== row.id);
    this.submissions = this.submissions.filter((s) => s.assignmentId !== row.id);
    return { ok: true };
  }

  workspaceMaterials(workspaceId: string) {
    return this.materials.filter((m) => m.workspaceId === workspaceId);
  }

  /** Throws NOT_FOUND if the material doesn't exist or belongs to another workspace. */
  materialOf(scope: TeacherScope, id: string): MaterialRecord {
    const row = this.materials.find((m) => m.id === id && m.workspaceId === scope.workspaceId);
    if (!row) throw new Error("NOT_FOUND");
    return row;
  }

  createMaterial(scope: TeacherScope, input: Omit<MaterialRecord, "id" | "workspaceId" | "createdBy" | "uploadedAt" | "shareCode">) {
    const row: MaterialRecord = {
      id: nanoid(),
      workspaceId: scope.workspaceId,
      createdBy: scope.userId,
      shareCode: newShareCode(),
      uploadedAt: nowIso(),
      ...input,
    };
    this.materials.push(row);
    return row;
  }

  updateMaterial(scope: TeacherScope, id: string, patch: Partial<Omit<MaterialRecord, "id" | "workspaceId" | "createdBy" | "uploadedAt" | "shareCode">>) {
    const row = this.materialOf(scope, id);
    Object.assign(row, patch);
    return row;
  }

  deleteMaterial(scope: TeacherScope, id: string) {
    const row = this.materialOf(scope, id);
    this.materials = this.materials.filter((m) => m.id !== row.id);
    return { ok: true };
  }

  studentMaterials(studentId: number, groupIds: string[]) {
    return this.materials.filter(
      (m) => m.studentIds.includes(studentId) || m.groupIds.some((g) => groupIds.includes(g)),
    );
  }

  notify(userId: number, title: string, body: string) {
    this.notifications.unshift({ id: nanoid(), userId, title, body, read: false, createdAt: nowIso() });
    if (this.notifications.length > 5000) this.notifications.length = 5000;
  }

  markRead(userId: number, id: string) {
    const n = this.notifications.find((x) => x.id === id && x.userId === userId);
    if (n) n.read = true;
  }

  usageOf(workspaceId: string) {
    return this.aiUsage[workspaceId] ?? { used: 0, limit: 100 };
  }

  addAiDraft(workspaceId: string, questions: QuestionInput[]) {
    const usage = this.usageOf(workspaceId);
    if (usage.used + questions.length > usage.limit) throw new Error("AI_USAGE_LIMIT_REACHED");
    usage.used += questions.length;
    this.aiUsage[workspaceId] = usage;
    const draft: AiDraft = { id: nanoid(), workspaceId, questions: questions.map((question) => ({ tempId: nanoid(), question })) };
    this.aiDrafts.unshift(draft);
    if (this.aiDrafts.length > 500) this.aiDrafts.length = 500;
    return { draft, usage };
  }

  takeAiQuestions(workspaceId: string, draftId: string, tempIds: string[]) {
    const draft = this.aiDrafts.find((d) => d.id === draftId && d.workspaceId === workspaceId);
    if (!draft) throw new Error("NOT_FOUND");
    const selected = draft.questions.filter((q) => tempIds.includes(q.tempId));
    draft.questions = draft.questions.filter((q) => !tempIds.includes(q.tempId));
    return selected.map((q) => q.question);
  }
}

export const store = new ResulioStore();
