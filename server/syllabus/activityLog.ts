import { learningActivity } from "../../drizzle/schema";
import type { LearningActivityType } from "../../shared/syllabus";
import { requireDb } from "../db";
import { isMissingTable } from "../notifications/preferences";

export interface ActivityRow {
  userId: number;
  workspaceId: string;
  syllabusId: string;
  versionId?: string | null;
  moduleId?: string | null;
  lessonId?: string | null;
  itemId?: string | null;
  taskId?: string | null;
  assessmentId?: string | null;
  groupId?: string | null;
  activityType: LearningActivityType;
  occurredAt?: Date;
  durationSeconds?: number | null;
  source: "CLIENT" | "SERVER";
  metadata?: Record<string, unknown> | null;
}

/** History only (never an input to progression), so a failed or missing table never fails the caller. */
export async function logActivity(rows: readonly ActivityRow[]) {
  if (!rows.length) return;
  const now = new Date();
  try {
    await requireDb()
      .insert(learningActivity)
      .values(rows.map((r) => ({ ...r, occurredAt: r.occurredAt ?? now, metadata: r.metadata ?? null })));
  } catch (error) {
    if (!isMissingTable(error)) console.warn("[Resulio] learning_activity write failed", error);
  }
}
