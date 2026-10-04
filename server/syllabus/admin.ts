import { eq, sql } from "drizzle-orm";
import { providerWorkspaces, syllabi, syllabusCompletions, syllabusEnrollments } from "../../drizzle/schema";
import type { UnlockTargetType } from "../../shared/syllabus";
import { requireDb } from "../db";
import { appendAudit } from "../modules/admin/audit";
import type { AdminContext } from "../modules/admin/authz";
import { AppError } from "../modules/errors";
import { envEnables, guardTables, SYLLABUS_FLAG, setWorkspaceEnabled, syllabusEnabledFor } from "./availability";
import * as progression from "./progression";
import * as store from "./store";

/** Platform admin: the per-workspace flag toggle, aggregate counts, and audited per-student overrides. */

async function assertWorkspace(workspaceId: string) {
  const [w] = await requireDb().select({ id: providerWorkspaces.id }).from(providerWorkspaces).where(eq(providerWorkspaces.id, workspaceId)).limit(1);
  if (!w) throw new AppError("NOT_FOUND");
}

export async function workspaceFlag(workspaceId: string) {
  await assertWorkspace(workspaceId);
  return { workspaceId, enabled: await syllabusEnabledFor(workspaceId), envForced: envEnables(workspaceId) };
}

export async function toggleWorkspace(admin: AdminContext, workspaceId: string, enabled: boolean, reason: string) {
  await assertWorkspace(workspaceId);
  const result = await setWorkspaceEnabled(workspaceId, enabled, admin.userId);
  await appendAudit(
    requireDb(),
    admin,
    { action: "FEATURE_FLAG_CHANGED", targetType: "FEATURE_FLAG", targetId: SYLLABUS_FLAG, workspaceId, before: { enabled: result.before }, after: { enabled: result.after, override: enabled }, reason },
    admin.meta,
  );
  return { workspaceId, ...result };
}

/** Counts only — no titles, content or student data. */
export async function overview() {
  return guardTables(async () => {
    const db = requireDb();
    const [[s], [e], [c]] = await Promise.all([
      db.select({ total: sql<number>`count(*)`, published: sql<number>`sum(case when ${syllabi.currentVersionId} is not null then 1 else 0 end)` }).from(syllabi),
      db.select({ n: sql<number>`count(*)` }).from(syllabusEnrollments),
      db.select({ n: sql<number>`count(*)` }).from(syllabusCompletions),
    ]);
    return { syllabi: Number(s?.total ?? 0), published: Number(s?.published ?? 0), enrollments: Number(e?.n ?? 0), completions: Number(c?.n ?? 0) };
  });
}

async function enrollmentFor(syllabusId: string, studentId: number) {
  const syllabus = await store.syllabusById(syllabusId);
  if (!syllabus) throw new AppError("NOT_FOUND");
  const enrollment = await store.enrollmentOf(syllabusId, studentId);
  if (!enrollment) throw new AppError("NOT_FOUND");
  return { syllabus, enrollment };
}

export async function manualUnlock(
  admin: AdminContext,
  input: { syllabusId: string; studentId: number; targetType: UnlockTargetType; targetId: string; reason: string },
) {
  return guardTables(async () => {
    const { syllabus, enrollment } = await enrollmentFor(input.syllabusId, input.studentId);
    return progression.addManualUnlock(
      {
        enrollment,
        workspaceId: syllabus.providerWorkspaceId,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        actorUserId: admin.userId,
        actorKind: "ADMIN",
      },
      (tx, unlockId) =>
        appendAudit(
          tx,
          admin,
          {
            action: "SYLLABUS_MANUAL_UNLOCK",
            targetType: "SYLLABUS_ENROLLMENT",
            targetId: enrollment.id,
            workspaceId: syllabus.providerWorkspaceId,
            userId: input.studentId,
            after: { unlockId, syllabusId: syllabus.id, targetType: input.targetType, targetId: input.targetId },
            reason: input.reason,
          },
          admin.meta,
        ),
    );
  });
}

export async function revokeUnlock(admin: AdminContext, input: { syllabusId: string; studentId: number; unlockId: string; reason: string }) {
  return guardTables(async () => {
    const { syllabus, enrollment } = await enrollmentFor(input.syllabusId, input.studentId);
    await progression.revokeManualUnlock(input.unlockId, enrollment.id, admin.userId, (tx, unlockId) =>
      appendAudit(
        tx,
        admin,
        {
          action: "SYLLABUS_UNLOCK_REVOKED",
          targetType: "SYLLABUS_ENROLLMENT",
          targetId: enrollment.id,
          workspaceId: syllabus.providerWorkspaceId,
          userId: input.studentId,
          after: { unlockId, syllabusId: syllabus.id },
          reason: input.reason,
        },
        admin.meta,
      ),
    );
    return { ok: true };
  });
}
