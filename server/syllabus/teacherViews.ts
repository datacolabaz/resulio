import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  groupLearningSettings,
  syllabusApprovals,
  syllabusEnrollments,
  syllabusItemProgress,
  syllabusLessonProgress,
  users,
} from "../../drizzle/schema";
import type { ApprovalTargetType, UnlockTargetType } from "../../shared/syllabus";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { activeStudentIdsOfGroups, assertGroupOwner } from "../modules/groups";
import { isMissingTable } from "../notifications/preferences";
import { ownedSyllabus } from "./access";
import { grantState } from "./accessRules";
import { locateItem, locateLesson } from "./engine";
import * as progression from "./progression";
import { studentPathView } from "./serialize";
import * as store from "./store";

/** Teacher reads and per-student actions; every call is scoped to a syllabus of the teacher's workspace. */

async function ownedEnrollment(scope: TeacherScope, syllabusId: string, studentId: number) {
  await ownedSyllabus(scope, syllabusId);
  const enrollment = await store.enrollmentOf(syllabusId, studentId);
  if (!enrollment) throw new AppError("NOT_FOUND");
  return enrollment;
}

/** Everyone a grant reaches (incl. not started yet) with their progress summary. */
export async function students(scope: TeacherScope, syllabusId: string) {
  await ownedSyllabus(scope, syllabusId);
  const db = requireDb();
  const grants = await store.grantsForSyllabus(syllabusId);
  const now = new Date();
  const enrollments = await db.select().from(syllabusEnrollments).where(eq(syllabusEnrollments.syllabusId, syllabusId));
  const reached = new Map<number, { state: string; viaGroupId: string | null }>();
  const rank = (s: string) => ["ACTIVE", "PENDING", "EXPIRED", "REVOKED"].indexOf(s);
  for (const g of grants) {
    const state = grantState(g, now);
    const ids = g.studentId ? [g.studentId] : await activeStudentIdsOfGroups([g.groupId!]);
    for (const id of ids) {
      const prev = reached.get(id);
      if (!prev || rank(state) < rank(prev.state)) reached.set(id, { state, viaGroupId: g.groupId });
    }
  }
  const ids = [...new Set([...reached.keys(), ...enrollments.map((e) => e.studentId)])];
  const names = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const titles = new Map<string, string>();
  const labels = new Map<string, string>();
  for (const versionId of new Set(enrollments.map((e) => e.versionId))) {
    const v = await store.versionById(versionId);
    if (!v) continue;
    labels.set(versionId, v.version.label);
    for (const m of v.structure.modules) for (const l of m.lessons) titles.set(l.id, l.title);
  }
  return ids.map((id) => {
    const e = enrollments.find((x) => x.studentId === id);
    return {
      studentId: id,
      name: names.find((n) => n.id === id)?.name ?? "—",
      access: reached.get(id)?.state ?? "NONE",
      viaGroupId: reached.get(id)?.viaGroupId ?? null,
      enrollment: e
        ? {
            id: e.id,
            status: e.status,
            versionId: e.versionId,
            versionLabel: labels.get(e.versionId) ?? "",
            progressPct: e.progressPct,
            completedLessons: e.completedLessons,
            totalLessons: e.totalLessons,
            currentLessonTitle: e.currentLessonId ? (titles.get(e.currentLessonId) ?? null) : null,
            lastActivityAt: e.lastActivityAt,
            enrolledAt: e.enrolledAt,
            completedAt: e.completedAt,
          }
        : null,
    };
  });
}

export async function studentDetail(scope: TeacherScope, syllabusId: string, studentId: number) {
  const enrollment = await ownedEnrollment(scope, syllabusId, studentId);
  const state = await progression.current(enrollment);
  if (!state) throw new AppError("NOT_FOUND");
  const db = requireDb();
  const [lessonRows, itemRows, unlocks, approvals, [student]] = await Promise.all([
    db.select().from(syllabusLessonProgress).where(eq(syllabusLessonProgress.enrollmentId, enrollment.id)),
    db.select().from(syllabusItemProgress).where(eq(syllabusItemProgress.enrollmentId, enrollment.id)),
    progression.manualUnlocksOf(enrollment.id),
    db.select().from(syllabusApprovals).where(eq(syllabusApprovals.enrollmentId, enrollment.id)),
    db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, studentId)).limit(1),
  ]);
  return {
    student: { id: studentId, name: student?.name ?? "—" },
    enrollment: state.enrollment,
    path: studentPathView(state.structure, state.output),
    lessons: state.output.lessons.map((l) => {
      const row = lessonRows.find((r) => r.lessonId === l.id);
      return {
        id: l.id,
        status: l.status,
        unlockSource: l.unlockSource,
        optional: l.optional,
        items: l.items,
        unlockedAt: row?.unlockedAt ?? null,
        openedAt: row?.openedAt ?? null,
        completedAt: row?.completedAt ?? null,
        activeSeconds: row?.activeSeconds ?? 0,
      };
    }),
    items: itemRows.map((r) => ({ itemId: r.itemId, openedAt: r.openedAt, startedAt: r.startedAt, completedAt: r.completedAt, teacherMarkedAt: r.teacherMarkedAt })),
    manualUnlocks: unlocks,
    approvals,
  };
}

export async function manualUnlock(scope: TeacherScope, syllabusId: string, studentId: number, target: { type: UnlockTargetType; id: string }, reason: string) {
  const enrollment = await ownedEnrollment(scope, syllabusId, studentId);
  return progression.addManualUnlock({
    enrollment,
    workspaceId: scope.workspaceId,
    targetType: target.type,
    targetId: target.id,
    reason: reason.trim(),
    actorUserId: scope.userId,
    actorKind: "TEACHER",
  });
}

export async function revokeUnlock(scope: TeacherScope, syllabusId: string, studentId: number, unlockId: string) {
  const enrollment = await ownedEnrollment(scope, syllabusId, studentId);
  await progression.revokeManualUnlock(unlockId, enrollment.id, scope.userId);
  return { ok: true };
}

export async function decideApproval(
  scope: TeacherScope,
  syllabusId: string,
  studentId: number,
  target: { type: ApprovalTargetType; id: string },
  decision: "APPROVED" | "RETURNED",
  note: string,
) {
  const enrollment = await ownedEnrollment(scope, syllabusId, studentId);
  const version = await store.versionById(enrollment.versionId);
  if (!version) throw new AppError("NOT_FOUND");
  const valid =
    target.type === "SYLLABUS" ? target.id === "syllabus" : target.type === "MODULE" ? version.structure.modules.some((m) => m.id === target.id) : !!locateLesson(version.structure, target.id);
  if (!valid) throw new AppError("SYLLABUS_INVALID_TARGET");
  await requireDb()
    .insert(syllabusApprovals)
    .values({ id: nanoid(), enrollmentId: enrollment.id, targetType: target.type, targetId: target.id, decision, note: note.trim() || null, decidedBy: scope.userId });
  await progression.recompute(enrollment.id);
  return { ok: true };
}

/** TEACHER_MARKED rule: the teacher marks a teacher-practice item covered for some students or a whole group. */
export async function markTeacherPractice(scope: TeacherScope, syllabusId: string, itemId: string, who: { studentIds?: number[]; groupId?: string }) {
  await ownedSyllabus(scope, syllabusId);
  let studentIds = who.studentIds ?? [];
  if (who.groupId) {
    await assertGroupOwner(scope, who.groupId);
    studentIds = [...studentIds, ...(await activeStudentIdsOfGroups([who.groupId]))];
  }
  if (!studentIds.length) return { marked: 0 };
  const db = requireDb();
  const enrollments = await db
    .select()
    .from(syllabusEnrollments)
    .where(and(eq(syllabusEnrollments.syllabusId, syllabusId), inArray(syllabusEnrollments.studentId, [...new Set(studentIds)])));
  const now = new Date();
  let marked = 0;
  for (const e of enrollments) {
    const v = await store.versionById(e.versionId);
    const found = v ? locateItem(v.structure, itemId) : null;
    if (!found || found.item.kind !== "TEACHER_PRACTICE") continue;
    await db
      .insert(syllabusItemProgress)
      .values({ enrollmentId: e.id, itemId, syllabusId, lessonId: found.lesson?.id ?? null, kind: "TEACHER_PRACTICE", teacherMarkedAt: now, teacherMarkedBy: scope.userId })
      .onDuplicateKeyUpdate({ set: { teacherMarkedAt: now, teacherMarkedBy: scope.userId } });
    await progression.recompute(e.id);
    marked++;
  }
  return { marked };
}

/** Moves students (explicit list, a group, or everyone) to another version of the syllabus (Q2: never automatic). */
export async function moveStudents(scope: TeacherScope, syllabusId: string, versionId: string, who: { studentIds?: number[]; groupId?: string; all?: boolean }) {
  await ownedSyllabus(scope, syllabusId);
  const db = requireDb();
  let enrollments = await db.select().from(syllabusEnrollments).where(eq(syllabusEnrollments.syllabusId, syllabusId));
  if (!who.all) {
    const ids = new Set(who.studentIds ?? []);
    if (who.groupId) {
      await assertGroupOwner(scope, who.groupId);
      for (const id of await activeStudentIdsOfGroups([who.groupId])) ids.add(id);
    }
    enrollments = enrollments.filter((e) => ids.has(e.studentId));
  }
  let moved = 0;
  for (const e of enrollments) if ((await progression.moveEnrollment(e, versionId, scope.workspaceId)).moved) moved++;
  return { moved };
}

// ---------------------------------------------------------------------------
// Group setting: "İrəliləyiş qrupda görünsün" (sibling of "Ballar qrupda görünsün")
// ---------------------------------------------------------------------------

export async function groupLearningSettingsOf(scope: TeacherScope, groupId: string) {
  await assertGroupOwner(scope, groupId);
  return { groupId, progressVisibleToGroup: await store.progressVisibleToGroup(groupId) };
}

export async function setProgressVisibleToGroup(scope: TeacherScope, groupId: string, visible: boolean) {
  await assertGroupOwner(scope, groupId);
  try {
    await requireDb()
      .insert(groupLearningSettings)
      .values({ groupId, progressVisibleToGroup: visible })
      .onDuplicateKeyUpdate({ set: { progressVisibleToGroup: visible } });
  } catch (error) {
    if (isMissingTable(error)) throw new AppError("SYLLABUS_NOT_AVAILABLE");
    throw error;
  }
  return { groupId, progressVisibleToGroup: visible };
}
