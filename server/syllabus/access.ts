import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { groups, syllabusAccessGrants, users, type Syllabus } from "../../drizzle/schema";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { activeGroupIdsOfStudent, assertGroupOwner, teacherStudentIds } from "../modules/groups";
import { logActivity } from "./activityLog";
import { bestGrantState, effectiveGrant, grantState } from "./accessRules";
import { syllabusEnabledFor } from "./availability";
import { announceGrants } from "./notify";
import * as store from "./store";

/**
 * Who may open a syllabus. Grants live beside the syllabus; revoking or expiring one never touches
 * the enrollment or its progress, so granting again restores everything.
 */

export async function ownedSyllabus(scope: TeacherScope, id: string) {
  const row = await store.syllabusById(id);
  if (!row || row.providerWorkspaceId !== scope.workspaceId) throw new AppError("NOT_FOUND");
  return row;
}

export interface GrantInput {
  groupIds: string[];
  studentIds: number[];
  startsAt: Date | null;
  endsAt: Date | null;
  note?: string;
}

/**
 * The dialog decides the shape: a group grant also covers students who join the group later; a
 * group with some students unchecked arrives as individual grants. Either way every id is checked
 * against the teacher's workspace here.
 */
export async function grantAccess(scope: TeacherScope, syllabusId: string, input: GrantInput, now = new Date()) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  if (syllabus.archivedAt) throw new AppError("SYLLABUS_ARCHIVED");
  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) throw new AppError("SYLLABUS_INVALID_TARGET");
  if (input.endsAt && input.endsAt <= now) throw new AppError("SYLLABUS_INVALID_TARGET");
  const groupIds = [...new Set(input.groupIds)];
  const studentIds = [...new Set(input.studentIds)];
  for (const g of groupIds) await assertGroupOwner(scope, g);
  if (studentIds.length) {
    const own = new Set(await teacherStudentIds(scope));
    if (!studentIds.every((s) => own.has(s))) throw new AppError("FORBIDDEN");
  }
  const rows = [
    ...groupIds.map((groupId) => ({ groupId, studentId: null as number | null })),
    ...studentIds.map((studentId) => ({ groupId: null as string | null, studentId })),
  ].map((r) => ({ id: nanoid(), syllabusId, ...r, startsAt: input.startsAt, endsAt: input.endsAt, note: input.note?.trim() || null, grantedBy: scope.userId }));
  const before = rows.length ? await store.grantsForSyllabus(syllabusId) : [];
  if (rows.length) await requireDb().insert(syllabusAccessGrants).values(rows);
  announceGrants(
    syllabus,
    before,
    rows.map((r) => ({ ...r, status: "ACTIVE" as const, grantedAt: now, revokedAt: null, revokedBy: null })),
  );
  await logActivity(
    studentIds.map((userId) => ({ userId, workspaceId: scope.workspaceId, syllabusId, activityType: "ACCESS_GRANTED" as const, source: "SERVER" as const })),
  );
  return listGrants(scope, syllabusId);
}

/**
 * An accepted individual join request opens the syllabus to that student. The request is the
 * student's own consent, so unlike `grantAccess` they need not be in one of the teacher's groups.
 * A student who already has a live individual grant gets no second one.
 */
export async function grantFromJoinRequest(scope: TeacherScope, syllabus: Syllabus, studentId: number, now = new Date()) {
  const before = await store.grantsForSyllabus(syllabus.id);
  if (before.some((g) => g.studentId === studentId && grantState(g, now) === "ACTIVE")) return false;
  const row = { id: nanoid(), syllabusId: syllabus.id, groupId: null, studentId, startsAt: null, endsAt: null, note: null, grantedBy: scope.userId };
  await store.insertGrants([row]);
  announceGrants(syllabus, before, [{ ...row, status: "ACTIVE", grantedAt: now, revokedAt: null, revokedBy: null }]);
  await logActivity([{ userId: studentId, workspaceId: scope.workspaceId, syllabusId: syllabus.id, activityType: "ACCESS_GRANTED", source: "SERVER" }]);
  return true;
}

async function ownedGrant(scope: TeacherScope, syllabusId: string, grantId: string) {
  await ownedSyllabus(scope, syllabusId);
  const [row] = await requireDb()
    .select()
    .from(syllabusAccessGrants)
    .where(and(eq(syllabusAccessGrants.id, grantId), eq(syllabusAccessGrants.syllabusId, syllabusId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

/** Revoke keeps the row (history) and every enrollment/progress row untouched. */
export async function revokeGrant(scope: TeacherScope, syllabusId: string, grantId: string) {
  const row = await ownedGrant(scope, syllabusId, grantId);
  if (row.status !== "REVOKED") {
    await requireDb()
      .update(syllabusAccessGrants)
      .set({ status: "REVOKED", revokedAt: new Date(), revokedBy: scope.userId })
      .where(eq(syllabusAccessGrants.id, grantId));
    if (row.studentId) {
      await logActivity([{ userId: row.studentId, workspaceId: scope.workspaceId, syllabusId, activityType: "ACCESS_REVOKED", source: "SERVER" }]);
    }
  }
  return listGrants(scope, syllabusId);
}

export async function updateGrantDates(scope: TeacherScope, syllabusId: string, grantId: string, dates: { startsAt: Date | null; endsAt: Date | null }) {
  const row = await ownedGrant(scope, syllabusId, grantId);
  if (row.status === "REVOKED") throw new AppError("INVALID_TRANSITION");
  if (dates.startsAt && dates.endsAt && dates.endsAt <= dates.startsAt) throw new AppError("SYLLABUS_INVALID_TARGET");
  await requireDb().update(syllabusAccessGrants).set(dates).where(eq(syllabusAccessGrants.id, grantId));
  return listGrants(scope, syllabusId);
}

export async function listGrants(scope: TeacherScope, syllabusId: string) {
  await ownedSyllabus(scope, syllabusId);
  const db = requireDb();
  const rows = await store.grantsForSyllabus(syllabusId);
  const groupIds = [...new Set(rows.flatMap((r) => (r.groupId ? [r.groupId] : [])))];
  const studentIds = [...new Set(rows.flatMap((r) => (r.studentId ? [r.studentId] : [])))];
  const [groupRows, studentRows] = await Promise.all([
    groupIds.length ? db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds)) : [],
    studentIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, studentIds)) : [],
  ]);
  const now = new Date();
  return rows
    .map((r) => ({
      id: r.id,
      groupId: r.groupId,
      studentId: r.studentId,
      label: r.groupId ? (groupRows.find((g) => g.id === r.groupId)?.name ?? "—") : (studentRows.find((s) => s.id === r.studentId)?.name ?? "—"),
      state: grantState(r, now),
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      note: r.note,
      grantedAt: r.grantedAt,
      revokedAt: r.revokedAt,
    }))
    .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime());
}

// ---------------------------------------------------------------------------
// Student side
// ---------------------------------------------------------------------------

export interface StudentAccess {
  syllabus: Syllabus;
  groupIds: string[];
  grant: Awaited<ReturnType<typeof store.grantsForSyllabus>>[number];
}

/**
 * The one gate for every student read/write: the feature is on for the syllabus's workspace, the
 * syllabus is published, and a grant reaches the student right now (individual first, then group).
 */
export async function assertStudentAccess(userId: number, syllabusId: string, now = new Date()): Promise<StudentAccess> {
  const syllabus = await store.syllabusById(syllabusId);
  if (!syllabus || !(await syllabusEnabledFor(syllabus.providerWorkspaceId))) throw new AppError("NOT_FOUND");
  const groupIds = await activeGroupIdsOfStudent(userId);
  const grants = await store.grantsForSyllabus(syllabusId);
  const grant = effectiveGrant(grants, userId, groupIds, now);
  if (!grant) {
    const state = bestGrantState(grants, userId, groupIds, now);
    if (!state) throw new AppError("NOT_FOUND");
    throw new AppError("SYLLABUS_NO_ACCESS");
  }
  if (!syllabus.currentVersionId) throw new AppError("SYLLABUS_NOT_PUBLISHED");
  return { syllabus, groupIds, grant };
}
