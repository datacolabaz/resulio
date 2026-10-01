import { nanoid } from "nanoid";
import type { QuestionInput } from "../shared/assessment";

/**
 * In-memory store for AI-draft scratch state and per-workspace AI usage quotas.
 * Assignments, materials, and notifications used to live here too, but were lost on every
 * server restart (every Railway deploy) — they're now persisted in MySQL via
 * server/modules/tasks.ts and server/modules/notifications.ts. This file is deliberately kept
 * in-memory: it's low-stakes scratch state (AI generation drafts and quota counters), not data
 * a teacher or student would be upset to lose on a deploy.
 */

export type AiDraft = {
  id: string;
  workspaceId: string;
  questions: Array<{ tempId: string; question: QuestionInput }>;
};

class ResulioStore {
  aiUsage: Record<string, { used: number; limit: number }> = {};
  aiDrafts: AiDraft[] = [];

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
