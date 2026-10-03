import { and, eq, inArray } from "drizzle-orm";
import { groupMembers, groups, studentActivityEvents, taskSubmissions, tasks, users } from "../../drizzle/schema";
import { requireDb } from "../db";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";
import { assertGroupOwner } from "./groups";

/**
 * Motivation views: who turned a task in first, day-by-day group activity, per-student stats and
 * the group leaderboard. The pure functions below do the counting; the DB functions only load rows.
 * Students only ever receive names, ranks and first-place counts of their classmates.
 */

export const ACTIVITY_TIME_ZONE = "Asia/Baku";
export const FIRST_SUBMITTER_PLACES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar day (YYYY-MM-DD) of an instant in the given zone. */
export function dayKey(d: Date, timeZone = ACTIVITY_TIME_ZONE): string {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timeZone, f);
  }
  return f.format(d);
}

/** The last `count` calendar days up to and including today, oldest first. */
export function lastDays(now: Date, count: number, timeZone = ACTIVITY_TIME_ZONE): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const key = dayKey(new Date(now.getTime() - i * DAY_MS), timeZone);
    if (out[out.length - 1] !== key) out.push(key);
  }
  return out;
}

export interface DailyActivity {
  day: string;
  opens: number;
  submissions: number;
}

/** Zero-filled per-day counts; events outside the window are ignored. */
export function dailyActivity(days: string[], opens: Date[], submissions: Date[], timeZone = ACTIVITY_TIME_ZONE): DailyActivity[] {
  const rows = new Map(days.map((day) => [day, { day, opens: 0, submissions: 0 }]));
  for (const d of opens) {
    const row = rows.get(dayKey(d, timeZone));
    if (row) row.opens++;
  }
  for (const d of submissions) {
    const row = rows.get(dayKey(d, timeZone));
    if (row) row.submissions++;
  }
  return days.map((day) => rows.get(day)!);
}

export interface SubmissionFact {
  taskId: string;
  studentId: number;
  firstSubmittedAt: Date | null;
  submittedAt: Date | null;
}

const firstAt = (s: SubmissionFact) => s.firstSubmittedAt ?? s.submittedAt;

/** The earliest submitters of one task among `memberIds`, ties broken by student id for stability. */
export function firstSubmitters(subs: SubmissionFact[], memberIds: ReadonlySet<number>, limit = FIRST_SUBMITTER_PLACES) {
  return subs
    .filter((s) => memberIds.has(s.studentId) && firstAt(s))
    .map((s) => ({ studentId: s.studentId, at: firstAt(s)! }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.studentId - b.studentId)
    .slice(0, limit)
    .map((s, i) => ({ ...s, place: i + 1 }));
}

export interface StudentStats {
  studentId: number;
  submitted: number;
  onTime: number;
  late: number;
  firstPlaces: number;
  podiums: number;
  opened: number;
  lastSubmittedAt: Date | null;
}

/** Per-student counts over the given tasks; on time means the first submission met the deadline. */
export function studentStats(
  memberIds: number[],
  taskList: Array<{ id: string; deadline: Date }>,
  subs: SubmissionFact[],
  openedTaskIdsByStudent: ReadonlyMap<number, ReadonlySet<string>> = new Map(),
): StudentStats[] {
  const members = new Set(memberIds);
  const taskIds = new Set(taskList.map((t) => t.id));
  const deadline = new Map(taskList.map((t) => [t.id, t.deadline]));
  const stats = new Map<number, StudentStats>(
    memberIds.map((id) => [id, { studentId: id, submitted: 0, onTime: 0, late: 0, firstPlaces: 0, podiums: 0, opened: 0, lastSubmittedAt: null }]),
  );
  const byTask = new Map<string, SubmissionFact[]>();
  for (const s of subs) {
    if (!taskIds.has(s.taskId) || !members.has(s.studentId) || !firstAt(s)) continue;
    byTask.set(s.taskId, [...(byTask.get(s.taskId) ?? []), s]);
    const st = stats.get(s.studentId)!;
    st.submitted++;
    if (firstAt(s)!.getTime() <= deadline.get(s.taskId)!.getTime()) st.onTime++;
    else st.late++;
    const last = s.submittedAt ?? firstAt(s)!;
    if (!st.lastSubmittedAt || last > st.lastSubmittedAt) st.lastSubmittedAt = last;
  }
  for (const list of byTask.values()) {
    for (const f of firstSubmitters(list, members)) {
      const st = stats.get(f.studentId)!;
      st.podiums++;
      if (f.place === 1) st.firstPlaces++;
    }
  }
  for (const [studentId, opened] of openedTaskIdsByStudent) {
    const st = stats.get(studentId);
    if (st) st.opened = [...opened].filter((id) => taskIds.has(id)).length;
  }
  return [...stats.values()];
}

/** Competition ranking (1, 1, 3): more submissions, then more on time, then more first places. */
export function rankStudents<T extends StudentStats>(rows: T[]): Array<T & { rank: number }> {
  const sorted = [...rows].sort((a, b) => b.submitted - a.submitted || b.onTime - a.onTime || b.firstPlaces - a.firstPlaces || a.studentId - b.studentId);
  let rank = 0;
  return sorted.map((r, i) => {
    const prev = sorted[i - 1];
    if (!prev || prev.submitted !== r.submitted || prev.onTime !== r.onTime || prev.firstPlaces !== r.firstPlaces) rank = i + 1;
    return { ...r, rank };
  });
}

export const onTimeRate = (s: Pick<StudentStats, "submitted" | "onTime">) => (s.submitted ? Math.round((s.onTime / s.submitted) * 100) : 0);

export interface GradeFact {
  taskId: string;
  studentId: number;
  score: number | null;
  feedbackReleasedAt: Date | null;
}

export interface ScoreBoardRow {
  name: string | null;
  isYou: boolean;
  /** One entry per column in `tasks`; null = no released score. */
  scores: Array<number | null>;
  total: number;
  average: number | null;
  gradedCount: number;
  rank: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Released task scores of a group as students may see them. Only grades the teacher released
 * count. With `visible` off the board holds the viewer's own row only. Rows carry names and
 * numbers — never ids, e-mails, feedback or AI output.
 */
export function groupScoreBoard(input: {
  visible: boolean;
  viewerId: number;
  members: Array<{ studentId: number; name: string | null }>;
  tasks: Array<{ id: string; title: string }>;
  grades: GradeFact[];
}): { visible: boolean; tasks: Array<{ id: string; title: string }>; rows: ScoreBoardRow[] } {
  const subjects = input.visible ? input.members : input.members.filter((m) => m.studentId === input.viewerId);
  const subjectIds = new Set(subjects.map((m) => m.studentId));
  const taskIds = new Set(input.tasks.map((t) => t.id));
  const released = new Map<string, number>();
  for (const g of input.grades) {
    if (!g.feedbackReleasedAt || g.score === null || !Number.isFinite(g.score)) continue;
    if (!subjectIds.has(g.studentId) || !taskIds.has(g.taskId)) continue;
    released.set(`${g.studentId}:${g.taskId}`, g.score);
  }
  const columns = input.tasks.filter((t) => subjects.some((m) => released.has(`${m.studentId}:${t.id}`)));
  const rows = subjects.map((m) => {
    const scores = columns.map((t) => released.get(`${m.studentId}:${t.id}`) ?? null);
    const graded = scores.filter((s): s is number => s !== null);
    const sum = graded.reduce((a, b) => a + b, 0);
    return { studentId: m.studentId, name: m.name, isYou: m.studentId === input.viewerId, scores, total: round1(sum), average: graded.length ? round1(sum / graded.length) : null, gradedCount: graded.length };
  });
  const ranked = rows
    .filter((r) => r.average !== null)
    .sort((a, b) => b.average! - a.average! || b.total - a.total || a.studentId - b.studentId);
  const rankOf = new Map<number, number>();
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    rankOf.set(r.studentId, prev && prev.average === r.average && prev.total === r.total ? rankOf.get(prev.studentId)! : i + 1);
  });
  const ordered = [...ranked, ...rows.filter((r) => r.average === null).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))];
  return {
    visible: input.visible,
    tasks: columns.map((t) => ({ id: t.id, title: t.title })),
    rows: ordered.map((r) => ({
      name: r.name,
      isYou: r.isYou,
      scores: r.scores,
      total: r.total,
      average: r.average,
      gradedCount: r.gradedCount,
      rank: rankOf.get(r.studentId) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function groupData(groupId: string, workspaceId: string) {
  const db = requireDb();
  const members = await db
    .select({ studentId: users.id, name: users.name, email: users.email })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")));
  const groupTasks = (await db.select({ id: tasks.id, title: tasks.title, deadline: tasks.deadline, groupIds: tasks.groupIds }).from(tasks).where(eq(tasks.providerWorkspaceId, workspaceId)))
    .filter((t) => t.groupIds.includes(groupId))
    .map(({ groupIds: _g, ...t }) => t);
  const taskIds = groupTasks.map((t) => t.id);
  const memberIds = members.map((m) => m.studentId);
  const subs: Array<SubmissionFact & GradeFact> = taskIds.length
    ? await db
        .select({
          taskId: taskSubmissions.taskId,
          studentId: taskSubmissions.studentId,
          firstSubmittedAt: taskSubmissions.firstSubmittedAt,
          submittedAt: taskSubmissions.submittedAt,
          score: taskSubmissions.score,
          feedbackReleasedAt: taskSubmissions.feedbackReleasedAt,
        })
        .from(taskSubmissions)
        .where(inArray(taskSubmissions.taskId, taskIds))
    : [];
  const views = taskIds.length && memberIds.length
    ? await db
        .select({ userId: studentActivityEvents.userId, taskId: studentActivityEvents.entityId, createdAt: studentActivityEvents.createdAt })
        .from(studentActivityEvents)
        .where(
          and(
            eq(studentActivityEvents.providerWorkspaceId, workspaceId),
            eq(studentActivityEvents.entityType, "ASSIGNMENT"),
            eq(studentActivityEvents.eventType, "ASSIGNMENT_VIEWED"),
            inArray(studentActivityEvents.entityId, taskIds),
            inArray(studentActivityEvents.userId, memberIds),
          ),
        )
    : [];
  const opened = new Map<number, Set<string>>();
  for (const v of views) opened.set(v.userId, (opened.get(v.userId) ?? new Set()).add(v.taskId));
  const ranked = rankStudents(studentStats(memberIds, groupTasks, subs, opened));
  return { members, groupTasks, subs, views, ranked, memberSet: new Set(memberIds) };
}

const tasksNewestFirst = <T extends { deadline: Date }>(list: T[]) => [...list].sort((a, b) => b.deadline.getTime() - a.deadline.getTime());

export async function teacherGroupActivity(scope: TeacherScope, groupId: string, days: number) {
  await assertGroupOwner(scope, groupId);
  const d = await groupData(groupId, scope.workspaceId);
  const nameOf = new Map(d.members.map((m) => [m.studentId, m]));
  const window = lastDays(new Date(), days);
  return {
    days: dailyActivity(
      window,
      d.views.map((v) => v.createdAt),
      d.subs.filter((s) => d.memberSet.has(s.studentId)).map(firstAt).filter((x): x is Date => !!x),
    ),
    taskCount: d.groupTasks.length,
    students: d.ranked.map((r) => ({ ...r, onTimeRate: onTimeRate(r), name: nameOf.get(r.studentId)?.name ?? null, email: nameOf.get(r.studentId)?.email ?? null })),
    tasks: tasksNewestFirst(d.groupTasks).slice(0, 20).map((t) => {
      const subs = d.subs.filter((s) => s.taskId === t.id);
      return {
        id: t.id,
        title: t.title,
        deadline: t.deadline,
        submittedCount: subs.filter((s) => d.memberSet.has(s.studentId)).length,
        firstSubmitters: firstSubmitters(subs, d.memberSet).map((f) => ({ ...f, name: nameOf.get(f.studentId)?.name ?? null })),
      };
    }),
  };
}

async function activeMembership(userId: number, groupId: string) {
  const [row] = await requireDb()
    .select({ id: groups.id, name: groups.name, workspaceId: groups.providerWorkspaceId, scoresVisible: groups.scoresVisibleToGroup })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")))
    .limit(1);
  return row ?? null;
}

const scoreBoardOf = (d: Awaited<ReturnType<typeof groupData>>, visible: boolean, viewerId: number) =>
  groupScoreBoard({
    visible,
    viewerId,
    members: d.members,
    tasks: [...d.groupTasks].sort((a, b) => a.deadline.getTime() - b.deadline.getTime()),
    grades: d.subs,
  });

/**
 * Leaderboard for a group member: classmates' names, ranks and first places, plus their released
 * scores when the teacher allows it for this group; full activity stats only for themselves.
 */
export async function studentGroupBoard(userId: number, groupId: string) {
  const group = await activeMembership(userId, groupId);
  if (!group) throw new AppError("NOT_FOUND");
  const d = await groupData(groupId, group.workspaceId);
  const nameOf = new Map(d.members.map((m) => [m.studentId, m.name]));
  const me = d.ranked.find((r) => r.studentId === userId) ?? null;
  return {
    group: { id: group.id, name: group.name },
    scores: scoreBoardOf(d, group.scoresVisible, userId),
    me: me ? { rank: me.rank, of: d.ranked.length, submitted: me.submitted, onTime: me.onTime, onTimeRate: onTimeRate(me), firstPlaces: me.firstPlaces, podiums: me.podiums } : null,
    leaderboard: d.ranked.map((r) => ({ rank: r.rank, name: nameOf.get(r.studentId) ?? null, firstPlaces: r.firstPlaces, isYou: r.studentId === userId })),
    tasks: tasksNewestFirst(d.groupTasks).slice(0, 10).map((t) => ({
      id: t.id,
      title: t.title,
      deadline: t.deadline,
      firstSubmitters: firstSubmitters(d.subs.filter((s) => s.taskId === t.id), d.memberSet).map((f) => ({
        place: f.place,
        name: nameOf.get(f.studentId) ?? null,
        isYou: f.studentId === userId,
      })),
    })),
  };
}

/** The student's own activity and progress across all their groups and tasks. */
export async function studentProfile(userId: number) {
  const db = requireDb();
  const memberships = await db
    .select({ id: groups.id, name: groups.name, workspaceId: groups.providerWorkspaceId, scoresVisible: groups.scoresVisibleToGroup })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, userId), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")));

  const mySubs = await db
    .select({
      taskId: taskSubmissions.taskId,
      firstSubmittedAt: taskSubmissions.firstSubmittedAt,
      submittedAt: taskSubmissions.submittedAt,
      score: taskSubmissions.score,
      feedbackReleasedAt: taskSubmissions.feedbackReleasedAt,
      title: tasks.title,
      deadline: tasks.deadline,
    })
    .from(taskSubmissions)
    .innerJoin(tasks, eq(tasks.id, taskSubmissions.taskId))
    .where(eq(taskSubmissions.studentId, userId));

  const own = studentStats([userId], mySubs.map((s) => ({ id: s.taskId, deadline: s.deadline })), mySubs.map((s) => ({ ...s, studentId: userId })))[0];

  const groupRanks: Array<{ groupId: string; name: string; rank: number; of: number; scores: ReturnType<typeof groupScoreBoard> }> = [];
  const firstPlaceTasks = new Set<string>();
  const podiumTasks = new Set<string>();
  for (const g of memberships) {
    const d = await groupData(g.id, g.workspaceId);
    const me = d.ranked.find((r) => r.studentId === userId);
    if (me) groupRanks.push({ groupId: g.id, name: g.name, rank: me.rank, of: d.ranked.length, scores: scoreBoardOf(d, g.scoresVisible, userId) });
    for (const t of d.groupTasks) {
      for (const f of firstSubmitters(d.subs.filter((s) => s.taskId === t.id), d.memberSet)) {
        if (f.studentId !== userId) continue;
        podiumTasks.add(t.id);
        if (f.place === 1) firstPlaceTasks.add(t.id);
      }
    }
  }

  const views = await db
    .select({ createdAt: studentActivityEvents.createdAt })
    .from(studentActivityEvents)
    .where(and(eq(studentActivityEvents.userId, userId), eq(studentActivityEvents.entityType, "ASSIGNMENT"), eq(studentActivityEvents.eventType, "ASSIGNMENT_VIEWED")));

  const released = mySubs
    .filter((s) => s.feedbackReleasedAt && s.score !== null)
    .sort((a, b) => b.feedbackReleasedAt!.getTime() - a.feedbackReleasedAt!.getTime())
    .map((s) => ({ taskId: s.taskId, title: s.title, score: s.score!, releasedAt: s.feedbackReleasedAt! }));

  return {
    totals: {
      submitted: own.submitted,
      onTime: own.onTime,
      late: own.late,
      onTimeRate: onTimeRate(own),
      firstPlaces: firstPlaceTasks.size,
      podiums: podiumTasks.size,
      averageScore: released.length ? Math.round((released.reduce((s, r) => s + r.score, 0) / released.length) * 10) / 10 : null,
    },
    groups: groupRanks,
    releasedScores: released.slice(0, 20),
    activity: dailyActivity(
      lastDays(new Date(), 30),
      views.map((v) => v.createdAt),
      mySubs.map((s) => s.firstSubmittedAt ?? s.submittedAt).filter((x): x is Date => !!x),
    ),
  };
}
