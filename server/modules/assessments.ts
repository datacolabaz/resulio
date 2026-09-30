import { and, asc, desc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  assessmentAssignments,
  assessmentQuestions,
  assessments,
  assessmentVersions,
  groups,
  providerWorkspaces,
  questions,
  users,
  versionQuestions,
  type Assessment,
  type AssessmentAssignment,
  type QuestionRow,
} from "../../drizzle/schema";
import {
  assessmentSettingsSchema,
  questionInputSchema,
  type AssessmentSettings,
  type AssessmentType,
  type AssignmentOverrides,
  type QuestionInput,
  type Schedule,
  type Targets,
} from "../../shared/assessment";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "./access";
import { liveStatus, toStudentQuestion, type FrozenQuestion } from "./engine";
import { AppError } from "./errors";
import { activeGroupIdsOfStudent, activeStudentIdsOfGroups, teacherStudentIds } from "./groups";

export const DEFAULT_SETTINGS: AssessmentSettings = {
  title: "Yeni imtahan",
  description: "",
  instructions: "",
  subject: "",
  durationSeconds: 45 * 60,
  attemptsAllowed: 1,
  randomize: false,
  releaseMode: "IMMEDIATE",
  reviewMode: "FULL",
  showCorrectAnswers: false,
  showExplanations: false,
};

// ---------------------------------------------------------------------------
// Ownership helpers
// ---------------------------------------------------------------------------

export async function ownedAssessment(scope: TeacherScope, id: string, db: DbOrTx = requireDb()) {
  const [row] = await db
    .select()
    .from(assessments)
    .where(and(eq(assessments.id, id), eq(assessments.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

async function ownedQuestion(scope: TeacherScope, id: string, db: DbOrTx = requireDb()) {
  const [row] = await db
    .select()
    .from(questions)
    .where(and(eq(questions.id, id), eq(questions.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

async function markDraftChanged(assessmentId: string, db: DbOrTx) {
  await db.update(assessments).set({ hasDraftChanges: true }).where(eq(assessments.id, assessmentId));
}

// ---------------------------------------------------------------------------
// Draft lifecycle
// ---------------------------------------------------------------------------

export async function createAssessment(scope: TeacherScope, input: { type: AssessmentType; settings?: Partial<AssessmentSettings> }) {
  const db = requireDb();
  const id = nanoid();
  const settings = assessmentSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...input.settings });
  await db.insert(assessments).values({
    id,
    providerWorkspaceId: scope.workspaceId,
    createdBy: scope.userId,
    type: input.type,
    settings,
    shareCode: nanoid(10).replace(/[-_]/g, "x").toUpperCase(),
  });
  return ownedAssessment(scope, id);
}

export async function updateSettings(scope: TeacherScope, id: string, patch: Partial<AssessmentSettings>) {
  const db = requireDb();
  const a = await ownedAssessment(scope, id);
  if (a.status === "CLOSED") throw new AppError("CLOSED");
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const settings = assessmentSettingsSchema.parse({ ...a.settings, ...defined });
  await db.update(assessments).set({ settings, hasDraftChanges: true }).where(eq(assessments.id, id));
  return ownedAssessment(scope, id);
}

/** The availability window is operational and may be changed after publishing (e.g. extend a deadline). */
export async function updateSchedule(scope: TeacherScope, id: string, schedule: Schedule) {
  const db = requireDb();
  await ownedAssessment(scope, id);
  await db
    .update(assessments)
    .set({ startAt: schedule.startAt, endAt: schedule.endAt, timezone: schedule.timezone })
    .where(eq(assessments.id, id));
  return ownedAssessment(scope, id);
}

/**
 * Replace the set of assignees. Unchanged assignees keep their row (and pinned version);
 * removed ones are revoked, new ones are pinned to the current published version.
 */
export async function setTargets(scope: TeacherScope, id: string, targets: Targets, overrides?: AssignmentOverrides) {
  const db = requireDb();
  const a = await ownedAssessment(scope, id);
  const groupIds = [...new Set(targets.groupIds)];
  const studentIds = [...new Set(targets.studentIds)];
  if (groupIds.length) {
    const owned = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.providerWorkspaceId, scope.workspaceId), inArray(groups.id, groupIds)));
    if (owned.length !== groupIds.length) throw new AppError("FORBIDDEN");
  }
  if (studentIds.length) {
    const own = new Set(await teacherStudentIds(scope));
    if (!studentIds.every((s) => own.has(s))) throw new AppError("FORBIDDEN");
  }
  await db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(assessmentAssignments)
      .where(and(eq(assessmentAssignments.assessmentId, id), eq(assessmentAssignments.status, "ACTIVE")));
    const keep = (r: AssessmentAssignment) =>
      (r.groupId && groupIds.includes(r.groupId)) || (r.studentId && studentIds.includes(r.studentId));
    const revoke = current.filter((r) => !keep(r)).map((r) => r.id);
    if (revoke.length) {
      await tx.update(assessmentAssignments).set({ status: "REVOKED" }).where(inArray(assessmentAssignments.id, revoke));
    }
    const o = overrides ?? null;
    const overrideValues = o
      ? {
          availableFrom: o.availableFrom,
          availableUntil: o.availableUntil,
          durationOverrideSeconds: o.durationSeconds,
          attemptLimitOverride: o.attemptsAllowed,
        }
      : {};
    const kept = current.filter(keep);
    if (o && kept.length) {
      await tx.update(assessmentAssignments).set(overrideValues).where(inArray(assessmentAssignments.id, kept.map((r) => r.id)));
    }
    const rows = [
      ...groupIds
        .filter((g) => !current.some((r) => r.groupId === g))
        .map((groupId) => ({ groupId, studentId: null as number | null })),
      ...studentIds
        .filter((s) => !current.some((r) => r.studentId === s))
        .map((studentId) => ({ groupId: null as string | null, studentId })),
    ].map((r) => ({
      ...r,
      ...overrideValues,
      assessmentId: id,
      assessmentVersionId: a.currentVersionId,
      assignedBy: scope.userId,
    }));
    if (rows.length) await tx.insert(assessmentAssignments).values(rows);
  });
  return assignmentsOf(id);
}

export async function activeAssignments(assessmentId: string, db: DbOrTx = requireDb()) {
  return db
    .select()
    .from(assessmentAssignments)
    .where(and(eq(assessmentAssignments.assessmentId, assessmentId), eq(assessmentAssignments.status, "ACTIVE")));
}

export async function getTargets(assessmentId: string, db: DbOrTx = requireDb()): Promise<Targets> {
  const rows = await activeAssignments(assessmentId, db);
  return {
    groupIds: rows.flatMap((r) => (r.groupId ? [r.groupId] : [])),
    studentIds: rows.flatMap((r) => (r.studentId ? [r.studentId] : [])),
  };
}

/** Assignment rows with display names and pinned version numbers, for the teacher. */
export async function assignmentsOf(assessmentId: string) {
  const db = requireDb();
  const rows = await activeAssignments(assessmentId, db);
  const versionIds = [...new Set(rows.flatMap((r) => (r.assessmentVersionId ? [r.assessmentVersionId] : [])))];
  const versions = versionIds.length
    ? await db.select().from(assessmentVersions).where(inArray(assessmentVersions.id, versionIds))
    : [];
  const groupIds = rows.flatMap((r) => (r.groupId ? [r.groupId] : []));
  const studentIds = rows.flatMap((r) => (r.studentId ? [r.studentId] : []));
  const groupRows = groupIds.length ? await db.select().from(groups).where(inArray(groups.id, groupIds)) : [];
  const studentRows = studentIds.length ? await db.select().from(users).where(inArray(users.id, studentIds)) : [];
  return rows.map((r) => ({
    id: r.id,
    groupId: r.groupId,
    studentId: r.studentId,
    label: r.groupId
      ? (groupRows.find((g) => g.id === r.groupId)?.name ?? "—")
      : (studentRows.find((s) => s.id === r.studentId)?.name ?? "—"),
    versionNo: versions.find((v) => v.id === r.assessmentVersionId)?.versionNo ?? null,
    availableFrom: r.availableFrom,
    availableUntil: r.availableUntil,
    durationOverrideSeconds: r.durationOverrideSeconds,
    attemptLimitOverride: r.attemptLimitOverride,
    assignedAt: r.assignedAt,
  }));
}

export async function assignedStudentIds(assessmentId: string, db: DbOrTx = requireDb()) {
  const t = await getTargets(assessmentId, db);
  const fromGroups = await activeStudentIdsOfGroups(t.groupIds, db);
  return [...new Set([...fromGroups, ...t.studentIds])];
}

/**
 * The assignment through which a student takes an assessment. An individual assignment wins
 * over a group assignment; among equals the most recent wins.
 */
export async function resolveAssignment(assessmentId: string, studentId: number, db: DbOrTx = requireDb()) {
  const rows = await activeAssignments(assessmentId, db);
  const individual = rows.filter((r) => r.studentId === studentId);
  if (individual.length) return individual.sort((x, y) => y.assignedAt.getTime() - x.assignedAt.getTime())[0];
  const mine = await activeGroupIdsOfStudent(studentId, db);
  const viaGroup = rows.filter((r) => r.groupId && mine.includes(r.groupId));
  return viaGroup.sort((x, y) => y.assignedAt.getTime() - x.assignedAt.getTime())[0] ?? null;
}

/** Assessments visible to a student through an active group or individual assignment. */
export async function accessibleAssessmentIds(studentId: number, db: DbOrTx = requireDb()) {
  const groupIds = await activeGroupIdsOfStudent(studentId, db);
  const conds = [eq(assessmentAssignments.studentId, studentId)];
  if (groupIds.length) conds.push(inArray(assessmentAssignments.groupId, groupIds));
  const rows = await db
    .select({ id: assessmentAssignments.assessmentId })
    .from(assessmentAssignments)
    .where(and(eq(assessmentAssignments.status, "ACTIVE"), or(...conds)));
  return [...new Set(rows.map((r) => r.id))];
}

// ---------------------------------------------------------------------------
// Questions (bank + draft composition)
// ---------------------------------------------------------------------------

function questionValues(input: QuestionInput) {
  return {
    type: input.type,
    text: input.text,
    points: input.points,
    difficulty: input.difficulty,
    topic: input.topic,
    skill: input.skill,
    tags: input.tags,
    explanation: input.explanation ?? null,
    imageUrl: input.imageUrl ?? null,
    content: input.content,
    answerKey: input.answerKey,
  };
}

export function parseQuestion(raw: unknown): QuestionInput {
  const parsed = questionInputSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("INVALID_QUESTION");
  return parsed.data;
}

export async function createQuestion(scope: TeacherScope, input: QuestionInput, source: "MANUAL" | "AI" = "MANUAL", db: DbOrTx = requireDb()) {
  const id = nanoid();
  await db
    .insert(questions)
    .values({ id, providerWorkspaceId: scope.workspaceId, createdBy: scope.userId, source, ...questionValues(input) });
  return ownedQuestion(scope, id, db);
}

export async function updateQuestion(scope: TeacherScope, id: string, input: QuestionInput) {
  const db = requireDb();
  await ownedQuestion(scope, id);
  await db.transaction(async (tx) => {
    await tx.update(questions).set(questionValues(input)).where(eq(questions.id, id));
    const linked = await tx
      .select({ assessmentId: assessmentQuestions.assessmentId })
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.questionId, id));
    for (const l of linked) await markDraftChanged(l.assessmentId, tx);
  });
  return ownedQuestion(scope, id);
}

export async function addQuestionToAssessment(scope: TeacherScope, assessmentId: string, questionId: string) {
  const db = requireDb();
  const a = await ownedAssessment(scope, assessmentId);
  if (a.status === "CLOSED") throw new AppError("CLOSED");
  await ownedQuestion(scope, questionId);
  await db.transaction(async (tx) => {
    const [{ maxPos }] = await tx
      .select({ maxPos: sql<number>`coalesce(max(${assessmentQuestions.position}), 0)` })
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentId, assessmentId));
    await tx
      .insert(assessmentQuestions)
      .values({ assessmentId, questionId, position: Number(maxPos) + 1 })
      .onDuplicateKeyUpdate({ set: { questionId } });
    await markDraftChanged(assessmentId, tx);
  });
  return draftQuestions(assessmentId);
}

export async function createQuestionInAssessment(scope: TeacherScope, assessmentId: string, input: QuestionInput) {
  await ownedAssessment(scope, assessmentId);
  const q = await createQuestion(scope, input);
  await addQuestionToAssessment(scope, assessmentId, q.id);
  return q;
}

export async function removeQuestionFromAssessment(scope: TeacherScope, assessmentId: string, questionId: string) {
  const db = requireDb();
  await ownedAssessment(scope, assessmentId);
  await db.transaction(async (tx) => {
    await tx
      .delete(assessmentQuestions)
      .where(and(eq(assessmentQuestions.assessmentId, assessmentId), eq(assessmentQuestions.questionId, questionId)));
    await markDraftChanged(assessmentId, tx);
  });
  return draftQuestions(assessmentId);
}

export async function reorderQuestions(scope: TeacherScope, assessmentId: string, questionIds: string[]) {
  const db = requireDb();
  await ownedAssessment(scope, assessmentId);
  const current = await draftQuestions(assessmentId);
  const currentIds = current.map((q) => q.id).sort();
  if (JSON.stringify(currentIds) !== JSON.stringify([...questionIds].sort())) throw new AppError("UNKNOWN_QUESTION");
  await db.transaction(async (tx) => {
    for (const [i, questionId] of questionIds.entries()) {
      await tx
        .update(assessmentQuestions)
        .set({ position: i + 1 })
        .where(and(eq(assessmentQuestions.assessmentId, assessmentId), eq(assessmentQuestions.questionId, questionId)));
    }
    await markDraftChanged(assessmentId, tx);
  });
  return draftQuestions(assessmentId);
}

export async function draftQuestions(assessmentId: string, db: DbOrTx = requireDb()): Promise<QuestionRow[]> {
  const rows = await db
    .select({ q: questions, position: assessmentQuestions.position })
    .from(assessmentQuestions)
    .innerJoin(questions, eq(questions.id, assessmentQuestions.questionId))
    .where(eq(assessmentQuestions.assessmentId, assessmentId))
    .orderBy(asc(assessmentQuestions.position));
  return rows.map((r) => r.q);
}

export async function questionBank(
  scope: TeacherScope,
  filter: { topic?: string; difficulty?: string; type?: string; source?: string; search?: string },
) {
  const conds = [eq(questions.providerWorkspaceId, scope.workspaceId)];
  if (filter.topic) conds.push(eq(questions.topic, filter.topic));
  if (filter.difficulty) conds.push(eq(questions.difficulty, filter.difficulty as "EASY"));
  if (filter.type) conds.push(eq(questions.type, filter.type));
  if (filter.source) conds.push(eq(questions.source, filter.source as "MANUAL"));
  if (filter.search) conds.push(like(questions.text, `%${filter.search.replace(/[%_]/g, "")}%`));
  return requireDb()
    .select()
    .from(questions)
    .where(and(...conds))
    .orderBy(desc(questions.updatedAt))
    .limit(200);
}

// ---------------------------------------------------------------------------
// Publishing: immutable versions
// ---------------------------------------------------------------------------

/**
 * Freeze the draft into a new immutable version. Assignments that were never pinned get
 * the new version; already pinned assignments move only when `moveAssignments` is set.
 * In-progress attempts always stay on the version they started with.
 */
export async function publish(scope: TeacherScope, assessmentId: string, opts: { moveAssignments?: boolean } = {}) {
  const db = requireDb();
  return db.transaction(async (tx) => {
    const [a] = await tx
      .select()
      .from(assessments)
      .where(and(eq(assessments.id, assessmentId), eq(assessments.providerWorkspaceId, scope.workspaceId)))
      .for("update");
    if (!a) throw new AppError("NOT_FOUND");
    if (a.status === "CLOSED") throw new AppError("CLOSED");
    const draft = await draftQuestions(assessmentId, tx);
    if (!draft.length) throw new AppError("NO_QUESTIONS");
    for (const q of draft) parseQuestion({ ...q, explanation: q.explanation ?? undefined, imageUrl: q.imageUrl ?? undefined });

    if (a.currentVersionId && !a.hasDraftChanges) {
      const [current] = await tx.select().from(assessmentVersions).where(eq(assessmentVersions.id, a.currentVersionId));
      await tx
        .update(assessmentAssignments)
        .set({ assessmentVersionId: current.id })
        .where(
          and(
            eq(assessmentAssignments.assessmentId, assessmentId),
            eq(assessmentAssignments.status, "ACTIVE"),
            opts.moveAssignments ? undefined : isNull(assessmentAssignments.assessmentVersionId),
          ),
        );
      return { versionId: current.id, versionNo: current.versionNo, created: false };
    }

    const [{ maxNo }] = await tx
      .select({ maxNo: sql<number>`coalesce(max(${assessmentVersions.versionNo}), 0)` })
      .from(assessmentVersions)
      .where(eq(assessmentVersions.assessmentId, assessmentId));
    const versionId = nanoid();
    const versionNo = Number(maxNo) + 1;

    await tx
      .update(assessmentVersions)
      .set({ status: "ARCHIVED" })
      .where(and(eq(assessmentVersions.assessmentId, assessmentId), eq(assessmentVersions.status, "PUBLISHED")));
    await tx.insert(assessmentVersions).values({
      id: versionId,
      assessmentId,
      versionNo,
      settings: a.settings,
      publishedBy: scope.userId,
    });
    await tx.insert(versionQuestions).values(
      draft.map((q, i) => ({
        id: nanoid(),
        versionId,
        sourceQuestionId: q.id,
        position: i + 1,
        type: q.type,
        text: q.text,
        points: q.points,
        difficulty: q.difficulty,
        topic: q.topic,
        skill: q.skill,
        explanation: q.explanation,
        imageUrl: q.imageUrl,
        content: q.content,
        answerKey: q.answerKey,
      })),
    );
    await tx
      .update(assessments)
      .set({ status: "PUBLISHED", currentVersionId: versionId, hasDraftChanges: false })
      .where(eq(assessments.id, assessmentId));
    await tx
      .update(assessmentAssignments)
      .set({ assessmentVersionId: versionId })
      .where(
        and(
          eq(assessmentAssignments.assessmentId, assessmentId),
          eq(assessmentAssignments.status, "ACTIVE"),
          opts.moveAssignments ? undefined : isNull(assessmentAssignments.assessmentVersionId),
        ),
      );
    return { versionId, versionNo, created: true };
  });
}

export async function closeAssessment(scope: TeacherScope, id: string) {
  await ownedAssessment(scope, id);
  await requireDb().update(assessments).set({ status: "CLOSED" }).where(eq(assessments.id, id));
  return { ok: true };
}

export async function loadVersion(versionId: string, db: DbOrTx = requireDb()) {
  const [version] = await db.select().from(assessmentVersions).where(eq(assessmentVersions.id, versionId)).limit(1);
  if (!version) throw new AppError("NOT_FOUND");
  const qs = await db
    .select()
    .from(versionQuestions)
    .where(eq(versionQuestions.versionId, versionId))
    .orderBy(asc(versionQuestions.position));
  return { version, questions: qs as FrozenQuestion[] };
}

export async function versionsOf(scope: TeacherScope, assessmentId: string) {
  await ownedAssessment(scope, assessmentId);
  return requireDb()
    .select()
    .from(assessmentVersions)
    .where(eq(assessmentVersions.assessmentId, assessmentId))
    .orderBy(desc(assessmentVersions.versionNo));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function summary(a: Assessment, now = new Date()) {
  return {
    id: a.id,
    type: a.type,
    status: a.status,
    liveStatus: liveStatus(a, now),
    title: a.settings.title,
    subject: a.settings.subject,
    durationSeconds: a.settings.durationSeconds,
    startAt: a.startAt,
    endAt: a.endAt,
    timezone: a.timezone,
    shareCode: a.shareCode,
    currentVersionId: a.currentVersionId,
    hasDraftChanges: a.hasDraftChanges,
    createdAt: a.createdAt,
  };
}

export async function listForTeacher(scope: TeacherScope, filter: { type?: AssessmentType; liveStatus?: string }) {
  const conds = [eq(assessments.providerWorkspaceId, scope.workspaceId)];
  if (filter.type) conds.push(eq(assessments.type, filter.type));
  const rows = await requireDb().select().from(assessments).where(and(...conds)).orderBy(desc(assessments.createdAt));
  const now = new Date();
  return rows.map((a) => summary(a, now)).filter((s) => (filter.liveStatus ? s.liveStatus === filter.liveStatus : true));
}

/** Full teacher view including the draft answer key. Never exposed to students. */
export async function teacherDetail(scope: TeacherScope, id: string) {
  const a = await ownedAssessment(scope, id);
  const [draft, targets, assignments, versions] = await Promise.all([
    draftQuestions(id),
    getTargets(id),
    assignmentsOf(id),
    versionsOf(scope, id),
  ]);
  return { ...summary(a), settings: a.settings, questions: draft, targets, assignments, versions };
}

/** Student preview of the draft: same whitelist projection students get. */
export async function studentPreview(scope: TeacherScope, id: string) {
  const a = await ownedAssessment(scope, id);
  const draft = await draftQuestions(id);
  return {
    title: a.settings.title,
    instructions: a.settings.instructions,
    durationSeconds: a.settings.durationSeconds,
    questions: draft.map((q, i) =>
      toStudentQuestion({ ...(q as unknown as FrozenQuestion), position: i + 1 }, `preview:${q.id}`),
    ),
  };
}

export async function publicByShareCode(shareCode: string) {
  const db = requireDb();
  const [row] = await db
    .select({ a: assessments, providerName: providerWorkspaces.publicDisplayName, providerTitle: providerWorkspaces.title })
    .from(assessments)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, assessments.providerWorkspaceId))
    .where(and(eq(assessments.shareCode, shareCode), isNotNull(assessments.currentVersionId)))
    .limit(1);
  if (!row) return null;
  const { version, questions: qs } = await loadVersion(row.a.currentVersionId!, db);
  return {
    id: row.a.id,
    type: row.a.type,
    liveStatus: liveStatus(row.a),
    title: version.settings.title,
    description: version.settings.description,
    instructions: version.settings.instructions,
    subject: version.settings.subject,
    teacherName: row.providerName || row.providerTitle,
    startAt: row.a.startAt,
    endAt: row.a.endAt,
    timezone: row.a.timezone,
    durationSeconds: version.settings.durationSeconds,
    attemptsAllowed: version.settings.attemptsAllowed,
    questionCount: qs.length,
  };
}
