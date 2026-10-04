import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  assessmentAssignments,
  assessments,
  assessmentStudentProgress,
  attempts,
  groupMembers,
  results,
  studentActivityEvents,
  taskSubmissions,
  users,
  type Assessment,
  type TaskAccessMode,
} from "../../drizzle/schema";
import type { ShareChannel } from "../../shared/shareTracking";
import {
  INACTIVITY_THRESHOLDS,
  type ActivityEntityType,
  type ActivityEventType,
  type ParticipantState,
} from "../../shared/assessment";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "./access";
import { ownedAssessment, resolveAssignment } from "./assessments";
import { participantState, throttleElapsed } from "./engine";
import { AppError } from "./errors";
import { activeStudentIdsOfGroups } from "./groups";
import * as shareTracking from "./shareTracking";
import { syllabusOwnedAssignments } from "./syllabusLinks";
import * as tasksModule from "./tasks";
import { workspaceOwnerId } from "./workspaces";

/** A repeated view inside this window neither writes an event nor touches the progress row. */
export const VIEW_THROTTLE_MS = 30 * 60_000;
/** At most one ASSESSMENT_AUTOSAVED event per attempt per window; the attempt row keeps exact times. */
export const AUTOSAVE_EVENT_THROTTLE_MS = 5 * 60_000;
export const HEARTBEAT_THROTTLE_MS = 30_000;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function recordEvent(
  db: DbOrTx,
  e: {
    userId: number;
    workspaceId: string;
    groupId?: string | null;
    entityType: ActivityEntityType;
    entityId: string;
    eventType: ActivityEventType;
    metadata?: Record<string, unknown>;
  },
) {
  await db.insert(studentActivityEvents).values({
    userId: e.userId,
    providerWorkspaceId: e.workspaceId,
    groupId: e.groupId ?? null,
    entityType: e.entityType,
    entityId: e.entityId,
    eventType: e.eventType,
    metadata: e.metadata ?? null,
  });
}

type ProgressPatch = {
  assignmentId?: number | null;
  versionId?: string | null;
  viewedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  expiredAt?: Date;
  latestActivityAt?: Date;
  activeAttemptId?: string | null;
  incrementAttempts?: boolean;
};

/** Upsert one student's progress row. First-occurrence timestamps (viewed, started) are never overwritten. */
export async function upsertAssessmentProgress(db: DbOrTx, assessmentId: string, studentId: number, p: ProgressPatch) {
  const set: Record<string, unknown> = {};
  if (p.assignmentId !== undefined) set.assignmentId = p.assignmentId;
  if (p.versionId !== undefined) set.versionId = p.versionId;
  if (p.viewedAt) set.viewedAt = sql`COALESCE(${assessmentStudentProgress.viewedAt}, VALUES(${assessmentStudentProgress.viewedAt}))`;
  if (p.startedAt) set.startedAt = sql`COALESCE(${assessmentStudentProgress.startedAt}, VALUES(${assessmentStudentProgress.startedAt}))`;
  if (p.completedAt) set.completedAt = p.completedAt;
  if (p.expiredAt) set.expiredAt = p.expiredAt;
  if (p.latestActivityAt) set.latestActivityAt = p.latestActivityAt;
  if (p.activeAttemptId !== undefined) set.activeAttemptId = p.activeAttemptId;
  if (p.incrementAttempts) set.attemptCount = sql`${assessmentStudentProgress.attemptCount} + 1`;
  await db
    .insert(assessmentStudentProgress)
    .values({
      assessmentId,
      studentId,
      assignmentId: p.assignmentId ?? null,
      versionId: p.versionId ?? null,
      viewedAt: p.viewedAt ?? null,
      startedAt: p.startedAt ?? null,
      completedAt: p.completedAt ?? null,
      expiredAt: p.expiredAt ?? null,
      latestActivityAt: p.latestActivityAt ?? null,
      activeAttemptId: p.activeAttemptId ?? null,
      attemptCount: p.incrementAttempts ? 1 : 0,
    })
    .onDuplicateKeyUpdate({ set: Object.keys(set).length ? set : { studentId } });
}

/** Student opened the assessment detail page. Access is verified; repeated views are throttled. */
export async function markAssessmentViewed(assessmentId: string, studentId: number) {
  const db = requireDb();
  const [a] = await db.select().from(assessments).where(eq(assessments.id, assessmentId)).limit(1);
  if (!a || a.status === "DRAFT") throw new AppError("NOT_FOUND");
  const assignment = await resolveAssignment(assessmentId, studentId, db);
  if (!assignment) throw new AppError("NO_ACCESS");
  const [existing] = await db
    .select({ viewedAt: assessmentStudentProgress.viewedAt, latestActivityAt: assessmentStudentProgress.latestActivityAt })
    .from(assessmentStudentProgress)
    .where(and(eq(assessmentStudentProgress.assessmentId, assessmentId), eq(assessmentStudentProgress.studentId, studentId)))
    .limit(1);
  const now = new Date();
  if (existing?.viewedAt && !throttleElapsed(existing.latestActivityAt, VIEW_THROTTLE_MS, now)) return { recorded: false };
  await db.transaction(async (tx) => {
    await upsertAssessmentProgress(tx, assessmentId, studentId, { assignmentId: assignment.id, viewedAt: now, latestActivityAt: now });
    await recordEvent(tx, {
      userId: studentId,
      workspaceId: a.providerWorkspaceId,
      groupId: assignment.groupId,
      entityType: "ASSESSMENT",
      entityId: assessmentId,
      eventType: "ASSESSMENT_VIEWED",
    });
  });
  return { recorded: true };
}

export async function setInactivityThreshold(
  scope: TeacherScope,
  assessmentId: string,
  minutes: (typeof INACTIVITY_THRESHOLDS)[number] | null,
) {
  await ownedAssessment(scope, assessmentId);
  await requireDb()
    .update(assessments)
    .set({ inactivityThresholdMinutes: minutes })
    .where(and(eq(assessments.id, assessmentId), eq(assessments.providerWorkspaceId, scope.workspaceId)));
  return { inactivityThresholdMinutes: minutes };
}

// ---------------------------------------------------------------------------
// Reads (teacher). Dashboard cards and the participants report share `buildParticipants`,
// so their counts always agree.
// ---------------------------------------------------------------------------

type AttemptRow = typeof attempts.$inferSelect;
type ProgressRow = typeof assessmentStudentProgress.$inferSelect;

export type Participant = {
  studentId: number;
  name: string;
  email: string | null;
  state: ParticipantState;
  onRoster: boolean;
  viewedAt: Date | null;
  startedAt: Date | null;
  lastActivityAt: Date | null;
  lastHeartbeatAt: Date | null;
  answeredCount: number;
  totalQuestionCount: number;
  remainingSeconds: number | null;
  submittedAt: Date | null;
  autoSubmitted: boolean;
  attemptId: string | null;
  attemptsUsed: number;
  resultId: string | null;
  percentage: number | null;
  pendingReviewCount: number;
};

export const STATE_ORDER: ParticipantState[] = [
  "INACTIVE",
  "IN_PROGRESS",
  "PENDING_REVIEW",
  "EXPIRED_NO_ANSWERS",
  "AUTO_SUBMITTED",
  "COMPLETED",
  "VIEWED",
  "NOT_STARTED",
];

export function emptyCounts(): Record<ParticipantState, number> {
  return { NOT_STARTED: 0, VIEWED: 0, IN_PROGRESS: 0, INACTIVE: 0, COMPLETED: 0, AUTO_SUBMITTED: 0, EXPIRED_NO_ANSWERS: 0, PENDING_REVIEW: 0 };
}

/** Pure: combine roster, progress, attempts and results into one row per student. */
export function buildParticipants(input: {
  assessment: Pick<Assessment, "inactivityThresholdMinutes">;
  rosterIds: number[];
  people: Map<number, { name: string | null; email: string | null }>;
  progress: Pick<ProgressRow, "studentId" | "viewedAt" | "latestActivityAt">[];
  attempts: AttemptRow[];
  results: { attemptId: string; id: string; percentage: number; pendingReviewCount: number }[];
  now?: Date;
}): Participant[] {
  const now = input.now ?? new Date();
  const roster = new Set(input.rosterIds);
  const ids = new Set<number>([...input.rosterIds, ...input.attempts.filter((x) => x.status !== "VOIDED").map((x) => x.studentId)]);
  const resultByAttempt = new Map(input.results.map((r) => [r.attemptId, r]));
  const out: Participant[] = [];
  for (const studentId of ids) {
    const mine = input.attempts.filter((x) => x.studentId === studentId).sort((x, y) => y.attemptNo - x.attemptNo);
    const counted = mine.filter((x) => x.status !== "VOIDED");
    const latest = counted[0] ?? null;
    const progress = input.progress.find((p) => p.studentId === studentId);
    const result = latest ? resultByAttempt.get(latest.id) : undefined;
    const person = input.people.get(studentId);
    const state = participantState(
      {
        viewedAt: progress?.viewedAt ?? null,
        attempt: latest,
        pendingReviewCount: result?.pendingReviewCount ?? null,
        thresholdMinutes: input.assessment.inactivityThresholdMinutes,
      },
      now,
    );
    const open = latest?.status === "IN_PROGRESS" && now < latest.deadlineAt;
    out.push({
      studentId,
      name: person?.name ?? "—",
      email: person?.email ?? null,
      state,
      onRoster: roster.has(studentId),
      viewedAt: progress?.viewedAt ?? null,
      startedAt: latest?.startedAt ?? null,
      lastActivityAt: latest?.lastActivityAt ?? latest?.startedAt ?? progress?.latestActivityAt ?? null,
      lastHeartbeatAt: latest?.lastHeartbeatAt ?? null,
      answeredCount: latest?.answeredCount ?? 0,
      totalQuestionCount: latest?.totalQuestionCount ?? 0,
      remainingSeconds: open && latest ? Math.max(0, Math.round((latest.deadlineAt.getTime() - now.getTime()) / 1000)) : null,
      submittedAt: latest?.submittedAt ?? null,
      autoSubmitted: latest?.status === "AUTO_SUBMITTED",
      attemptId: latest?.id ?? null,
      attemptsUsed: counted.length,
      resultId: result?.id ?? null,
      percentage: result?.percentage ?? null,
      pendingReviewCount: result?.pendingReviewCount ?? 0,
    });
  }
  return out.sort(
    (x, y) => STATE_ORDER.indexOf(x.state) - STATE_ORDER.indexOf(y.state) || x.name.localeCompare(y.name, "az"),
  );
}

export function summarize(participants: Participant[]) {
  const counts = emptyCounts();
  for (const p of participants) counts[p.state]++;
  const assigned = participants.filter((p) => p.onRoster).length;
  const scored = participants.flatMap((p) => (p.percentage !== null ? [p.percentage] : []));
  const latest = participants.reduce<Date | null>((m, p) => (p.lastActivityAt && (!m || p.lastActivityAt > m) ? p.lastActivityAt : m), null);
  return {
    assigned,
    /** Roster plus students who attempted before leaving the roster. */
    total: participants.length,
    counts,
    viewed: participants.filter((p) => p.viewedAt || p.startedAt).length,
    started: participants.filter((p) => p.startedAt).length,
    finished: counts.COMPLETED + counts.AUTO_SUBMITTED + counts.PENDING_REVIEW,
    averagePercentage: scored.length ? Math.round((scored.reduce((s, x) => s + x, 0) / scored.length) * 10) / 10 : null,
    latestActivityAt: latest,
  };
}

/** Loads everything `buildParticipants` needs for many assessments in a fixed number of queries. */
async function loadParticipantData(assessmentIds: string[], db: DbOrTx) {
  if (!assessmentIds.length) return { assignments: [], members: [], progress: [], attempts: [], results: [], people: new Map() };
  const allAssignments = await db
    .select()
    .from(assessmentAssignments)
    .where(and(inArray(assessmentAssignments.assessmentId, assessmentIds), eq(assessmentAssignments.status, "ACTIVE")));
  // Syllabus per-student rows are not the teacher's roster for this exam (their attempts still show).
  const syllabusOwned = await syllabusOwnedAssignments(allAssignments.map((r) => r.id), db);
  const assignmentRows = syllabusOwned.size ? allAssignments.filter((r) => !syllabusOwned.has(r.id)) : allAssignments;
  const groupIds = [...new Set(assignmentRows.flatMap((r) => (r.groupId ? [r.groupId] : [])))];
  const members = groupIds.length
    ? await db
        .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
        .from(groupMembers)
        .where(and(inArray(groupMembers.groupId, groupIds), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")))
    : [];
  const progress = await db.select().from(assessmentStudentProgress).where(inArray(assessmentStudentProgress.assessmentId, assessmentIds));
  const attemptRows = await db.select().from(attempts).where(inArray(attempts.assessmentId, assessmentIds));
  const attemptIds = attemptRows.map((x) => x.id);
  const resultRows = attemptIds.length
    ? await db
        .select({ attemptId: results.attemptId, id: results.id, percentage: results.percentage, pendingReviewCount: results.pendingReviewCount })
        .from(results)
        .where(inArray(results.attemptId, attemptIds))
    : [];
  const peopleIds = [
    ...new Set([...members.map((m) => m.userId), ...assignmentRows.flatMap((r) => (r.studentId ? [r.studentId] : [])), ...attemptRows.map((x) => x.studentId)]),
  ];
  const people = new Map<number, { name: string | null; email: string | null }>();
  if (peopleIds.length) {
    const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, peopleIds));
    for (const r of rows) people.set(r.id, { name: r.name, email: r.email });
  }
  return { assignments: assignmentRows, members, progress, attempts: attemptRows, results: resultRows, people };
}

function participantsFor(assessment: Assessment, data: Awaited<ReturnType<typeof loadParticipantData>>, now: Date) {
  const mine = data.assignments.filter((r) => r.assessmentId === assessment.id);
  const groupIds = new Set(mine.flatMap((r) => (r.groupId ? [r.groupId] : [])));
  const rosterIds = [
    ...new Set([...data.members.filter((m) => groupIds.has(m.groupId)).map((m) => m.userId), ...mine.flatMap((r) => (r.studentId ? [r.studentId] : []))]),
  ];
  const attemptRows = data.attempts.filter((x) => x.assessmentId === assessment.id);
  const attemptIds = new Set(attemptRows.map((x) => x.id));
  return buildParticipants({
    assessment,
    rosterIds,
    people: data.people,
    progress: data.progress.filter((p) => p.assessmentId === assessment.id),
    attempts: attemptRows,
    results: data.results.filter((r) => attemptIds.has(r.attemptId)),
    now,
  });
}

/** `/teacher/assessments/:id/participants` */
export async function assessmentParticipants(scope: TeacherScope, assessmentId: string) {
  const db = requireDb();
  const a = await ownedAssessment(scope, assessmentId, db);
  const now = new Date();
  const participants = participantsFor(a, await loadParticipantData([a.id], db), now);
  return {
    assessment: {
      id: a.id,
      title: a.settings.title,
      type: a.type,
      status: a.status,
      inactivityThresholdMinutes: a.inactivityThresholdMinutes,
    },
    serverNow: now,
    summary: summarize(participants),
    participants,
  };
}

const CARD_LIMIT = 12;
const PREVIEW_LIMIT = 5;

/** Dashboard activity cards for the most recent published assessments of the workspace. */
export async function assessmentActivityCards(scope: TeacherScope) {
  const db = requireDb();
  const rows = await db
    .select()
    .from(assessments)
    .where(and(eq(assessments.providerWorkspaceId, scope.workspaceId), ne(assessments.status, "DRAFT"), isNotNull(assessments.currentVersionId)))
    .orderBy(desc(assessments.updatedAt))
    .limit(CARD_LIMIT);
  const now = new Date();
  const data = await loadParticipantData(rows.map((a) => a.id), db);
  const cards = rows.map((a) => {
    const participants = participantsFor(a, data, now);
    const preview = (states: ParticipantState[], by: (p: Participant) => number = (p) => -(p.lastActivityAt?.getTime() ?? 0)) =>
      participants
        .filter((p) => states.includes(p.state))
        .sort((x, y) => by(x) - by(y))
        .slice(0, PREVIEW_LIMIT)
        .map((p) => ({
          studentId: p.studentId,
          name: p.name,
          lastActivityAt: p.lastActivityAt,
          submittedAt: p.submittedAt,
          answeredCount: p.answeredCount,
          totalQuestionCount: p.totalQuestionCount,
          percentage: p.percentage,
        }));
    return {
      id: a.id,
      title: a.settings.title,
      type: a.type,
      status: a.status,
      startAt: a.startAt,
      endAt: a.endAt,
      durationSeconds: a.settings.durationSeconds,
      inactivityThresholdMinutes: a.inactivityThresholdMinutes,
      summary: summarize(participants),
      preview: {
        finished: preview(["COMPLETED", "AUTO_SUBMITTED", "PENDING_REVIEW"], (p) => -(p.submittedAt?.getTime() ?? 0)),
        inProgress: preview(["IN_PROGRESS"]),
        inactive: preview(["INACTIVE"]),
        notStarted: preview(["NOT_STARTED", "VIEWED"], () => 0),
        expired: preview(["EXPIRED_NO_ANSWERS"]),
      },
    };
  });
  const [pending] = await db
    .select({ n: sql<number>`count(*)` })
    .from(results)
    .innerJoin(assessments, eq(assessments.id, results.assessmentId))
    .where(and(eq(assessments.providerWorkspaceId, scope.workspaceId), sql`${results.pendingReviewCount} > 0`));
  const [active] = await db
    .select({ n: sql<number>`count(*)` })
    .from(assessments)
    .where(
      and(
        eq(assessments.providerWorkspaceId, scope.workspaceId),
        eq(assessments.status, "PUBLISHED"),
        sql`(${assessments.startAt} IS NULL OR ${assessments.startAt} <= ${now})`,
        sql`(${assessments.endAt} IS NULL OR ${assessments.endAt} > ${now})`,
      ),
    );
  const totals = cards.reduce(
    (t, c) => ({
      ...t,
      inProgressNow: t.inProgressNow + c.summary.counts.IN_PROGRESS,
      inactiveNow: t.inactiveNow + c.summary.counts.INACTIVE,
    }),
    { activeAssessments: Number(active?.n ?? 0), inProgressNow: 0, inactiveNow: 0, pendingReview: Number(pending?.n ?? 0) },
  );
  return { serverNow: now, totals, cards };
}

// ---------------------------------------------------------------------------
// Material / task view & download tracking
// ---------------------------------------------------------------------------
//
// Unlike assessments (which have a dedicated `assessment_student_progress` row per student,
// updated on every view/heartbeat), materials and tasks only need a much lighter "has this
// student ever seen this" fact — so these write straight to `student_activity_events` and read
// the first occurrence back, instead of maintaining a second progress table.

/** Records a MATERIAL_VIEWED/ASSIGNMENT_VIEWED event the first time each item is seen by this
 *  student, in one batched existence check + one batched insert. Safe to call on every list
 *  fetch — after the first time, it's a single SELECT with nothing to insert. */
async function markFirstViews(
  entityType: Extract<ActivityEntityType, "MATERIAL" | "ASSIGNMENT">,
  eventType: Extract<ActivityEventType, "MATERIAL_VIEWED" | "ASSIGNMENT_VIEWED">,
  items: { id: string; providerWorkspaceId: string }[],
  studentId: number,
) {
  if (!items.length) return;
  const db = requireDb();
  const ids = items.map((m) => m.id);
  const existing = await db
    .select({ entityId: studentActivityEvents.entityId })
    .from(studentActivityEvents)
    .where(
      and(
        eq(studentActivityEvents.userId, studentId),
        eq(studentActivityEvents.entityType, entityType),
        eq(studentActivityEvents.eventType, eventType),
        inArray(studentActivityEvents.entityId, ids),
      ),
    );
  const seen = new Set(existing.map((e) => e.entityId));
  const toInsert = items.filter((m) => !seen.has(m.id));
  if (!toInsert.length) return;
  await db.insert(studentActivityEvents).values(
    toInsert.map((m) => ({
      userId: studentId,
      providerWorkspaceId: m.providerWorkspaceId,
      groupId: null,
      entityType,
      entityId: m.id,
      eventType,
    })),
  );
}

export const markMaterialsViewed = (items: { id: string; providerWorkspaceId: string }[], studentId: number) =>
  markFirstViews("MATERIAL", "MATERIAL_VIEWED", items, studentId);

export const markAssignmentsViewed = (items: { id: string; providerWorkspaceId: string }[], studentId: number) =>
  markFirstViews("ASSIGNMENT", "ASSIGNMENT_VIEWED", items, studentId);

type EligibleStudent = { studentId: number; name: string | null; email: string | null };

/** Every student this material/task reaches (active group members plus anyone individually
 *  targeted) — the full roster a "who's seen this" report needs, including those at zero. */
async function eligibleStudents(groupIds: string[], studentIds: number[]): Promise<EligibleStudent[]> {
  const memberIds = await activeStudentIdsOfGroups(groupIds);
  const ids = [...new Set([...memberIds, ...studentIds])];
  if (!ids.length) return [];
  const db = requireDb();
  const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => ({ studentId: id, name: byId.get(id)?.name ?? null, email: byId.get(id)?.email ?? null }))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "az"));
}

/** Individually listed students only count as a task's recipients while its link is open to anyone. */
const taskRosterStudentIds = (task: { accessMode: TaskAccessMode; studentIds: number[] }) => (task.accessMode === "GROUPS" ? [] : task.studentIds);

/** Teacher view of a material: who among the students it reaches has viewed and/or downloaded it. */
export async function materialActivity(scope: TeacherScope, materialId: string) {
  const material = await tasksModule.materialOf(scope, materialId);
  const roster = await eligibleStudents(material.groupIds, material.studentIds);
  if (!roster.length) return { eligible: [] };
  const db = requireDb();
  const events = await db
    .select({ userId: studentActivityEvents.userId, eventType: studentActivityEvents.eventType, createdAt: studentActivityEvents.createdAt })
    .from(studentActivityEvents)
    .where(
      and(
        eq(studentActivityEvents.entityType, "MATERIAL"),
        eq(studentActivityEvents.entityId, materialId),
        inArray(studentActivityEvents.userId, roster.map((r) => r.studentId)),
      ),
    );
  const firstOf = (userId: number, eventType: string) =>
    events
      .filter((e) => e.userId === userId && e.eventType === eventType)
      .reduce<Date | null>((min, e) => (!min || e.createdAt < min ? e.createdAt : min), null);
  return {
    eligible: roster.map((r) => ({
      ...r,
      viewedAt: firstOf(r.studentId, "MATERIAL_VIEWED"),
      downloadedAt: firstOf(r.studentId, "MATERIAL_DOWNLOADED"),
    })),
  };
}

/** Teacher view of a task: who among the students it reaches has viewed it (submission status
 *  itself already comes back with `teacher.tasks.list`, so this only adds "seen it or not"). */
export async function taskActivity(scope: TeacherScope, taskId: string) {
  const task = await tasksModule.assignmentOf(scope, taskId);
  const roster = await eligibleStudents(task.groupIds, taskRosterStudentIds(task));
  if (!roster.length) return { eligible: [] };
  const db = requireDb();
  const events = await db
    .select({ userId: studentActivityEvents.userId, createdAt: studentActivityEvents.createdAt })
    .from(studentActivityEvents)
    .where(
      and(
        eq(studentActivityEvents.entityType, "ASSIGNMENT"),
        eq(studentActivityEvents.entityId, taskId),
        eq(studentActivityEvents.eventType, "ASSIGNMENT_VIEWED"),
        inArray(studentActivityEvents.userId, roster.map((r) => r.studentId)),
      ),
    );
  const viewedAt = new Map(events.map((e) => [e.userId, e.createdAt]));
  return { eligible: roster.map((r) => ({ ...r, viewedAt: viewedAt.get(r.studentId) ?? null })) };
}

export type TaskEngagementStudent = {
  studentId: number;
  name: string | null;
  email: string | null;
  /** Recipient through the task's groups/individual list (vs. only seen via the public link). */
  onRoster: boolean;
  /** Channel of the student's first visit through the share link; null if they only used the dashboard. */
  channel: ShareChannel | null;
  openedAt: Date | null;
  lastOpenedAt: Date | null;
  openCount: number;
  downloadCount: number;
  lastDownloadAt: Date | null;
  joinedAt: Date | null;
  submittedAt: Date | null;
  submissionStatus: "SUBMITTED" | "LATE" | null;
};

/**
 * Teacher view of one task's share link and recipients, "Drive-style": per-channel funnel plus,
 * per identified student, when they first opened it (share link or dashboard), how many times
 * they downloaded its files, and whether/when they submitted. Visitors who never signed in are
 * only counted in aggregate. The teacher's own previews are excluded throughout.
 */
export async function taskEngagement(scope: TeacherScope, taskId: string) {
  const task = await tasksModule.assignmentOf(scope, taskId);
  const db = requireDb();
  const ownerId = await workspaceOwnerId(task.providerWorkspaceId);
  const excludeUserIds = [...new Set([scope.userId, task.createdBy, ...(ownerId ? [ownerId] : [])])];
  const excluded = new Set(excludeUserIds);

  const [roster, rows, submissions, activityRows] = await Promise.all([
    eligibleStudents(task.groupIds, taskRosterStudentIds(task)),
    shareTracking.shareEventsFor("TASK", task.shareCode),
    db
      .select({ studentId: taskSubmissions.studentId, status: taskSubmissions.status, submittedAt: taskSubmissions.submittedAt })
      .from(taskSubmissions)
      .where(eq(taskSubmissions.taskId, task.id)),
    db
      .select({ userId: studentActivityEvents.userId, eventType: studentActivityEvents.eventType, createdAt: studentActivityEvents.createdAt })
      .from(studentActivityEvents)
      .where(
        and(
          eq(studentActivityEvents.providerWorkspaceId, task.providerWorkspaceId),
          eq(studentActivityEvents.entityType, "ASSIGNMENT"),
          eq(studentActivityEvents.entityId, task.id),
          inArray(studentActivityEvents.eventType, ["ASSIGNMENT_VIEWED", "FILE_DOWNLOADED"]),
        ),
      ),
  ]);

  const submitted = submissions.filter((s) => !excluded.has(s.studentId) && (s.status === "SUBMITTED" || s.status === "LATE" || s.status === "REVIEWED"));
  const funnel = shareTracking.buildFunnel(rows, { excludeUserIds, submittedUserIds: submitted.map((s) => s.studentId) });
  const { userOf, personKey } = shareTracking.identifyPeople(rows);

  type Acc = Omit<TaskEngagementStudent, "name" | "email" | "onRoster">;
  const acc = new Map<number, Acc>();
  const entry = (studentId: number): Acc => {
    let e = acc.get(studentId);
    if (!e) {
      e = { studentId, channel: null, openedAt: null, lastOpenedAt: null, openCount: 0, downloadCount: 0, lastDownloadAt: null, joinedAt: null, submittedAt: null, submissionStatus: null };
      acc.set(studentId, e);
    }
    return e;
  };
  const earliest = (a: Date | null, b: Date) => (!a || b < a ? b : a);
  const latest = (a: Date | null, b: Date) => (!a || b > a ? b : a);

  for (const r of roster) entry(r.studentId);
  const anonymous = { visitors: new Set<string>(), opens: 0, downloads: 0 };
  for (const r of rows) {
    if (r.eventType === "CLICKED") continue;
    const userId = userOf(r);
    if (userId === null) {
      anonymous.visitors.add(personKey(r));
      if (r.eventType === "OPENED") anonymous.opens++;
      if (r.eventType === "DOWNLOADED") anonymous.downloads++;
      continue;
    }
    if (excluded.has(userId)) continue;
    const e = entry(userId);
    e.channel ??= r.channel;
    if (r.eventType === "OPENED") {
      e.openCount++;
      e.openedAt = earliest(e.openedAt, r.createdAt);
      e.lastOpenedAt = latest(e.lastOpenedAt, r.createdAt);
    } else if (r.eventType === "JOINED") {
      e.joinedAt = earliest(e.joinedAt, r.createdAt);
    } else if (r.eventType === "DOWNLOADED" && r.actorUserId === null) {
      // A signed-in download is already in student_activity_events (FILE_DOWNLOADED, below);
      // only downloads made before signing in on that browser are added from here.
      e.downloadCount++;
      e.lastDownloadAt = latest(e.lastDownloadAt, r.createdAt);
    }
  }
  for (const a of activityRows) {
    if (excluded.has(a.userId)) continue;
    const e = entry(a.userId);
    if (a.eventType === "ASSIGNMENT_VIEWED") {
      e.openedAt = earliest(e.openedAt, a.createdAt);
      e.lastOpenedAt = latest(e.lastOpenedAt, a.createdAt);
    } else {
      e.downloadCount++;
      e.lastDownloadAt = latest(e.lastDownloadAt, a.createdAt);
    }
  }
  for (const s of submitted) {
    const e = entry(s.studentId);
    e.submittedAt = s.submittedAt;
    e.submissionStatus = s.status === "LATE" ? "LATE" : "SUBMITTED";
  }

  const rosterById = new Map(roster.map((r) => [r.studentId, r]));
  const missing = [...acc.keys()].filter((id) => !rosterById.has(id));
  const people = new Map<number, { name: string | null; email: string | null }>();
  if (missing.length) {
    const found = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, missing));
    for (const p of found) people.set(p.id, { name: p.name, email: p.email });
  }
  const rank = (s: TaskEngagementStudent) => (s.submittedAt ? 0 : s.downloadCount > 0 ? 1 : s.openedAt ? 2 : 3);
  const students: TaskEngagementStudent[] = [...acc.values()]
    .map((e) => {
      const person = rosterById.get(e.studentId) ?? people.get(e.studentId);
      return { ...e, name: person?.name ?? null, email: person?.email ?? null, onRoster: rosterById.has(e.studentId) };
    })
    .sort((a, b) => rank(a) - rank(b) || (a.name ?? "").localeCompare(b.name ?? "", "az"));

  return {
    shareCode: task.shareCode,
    accessMode: task.accessMode,
    funnel,
    students,
    anonymous: { visitors: anonymous.visitors.size, opens: anonymous.opens, downloads: anonymous.downloads },
  };
}
