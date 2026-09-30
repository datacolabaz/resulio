import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  assessments,
  attempts,
  groups,
  resultItems,
  results,
  users,
  versionQuestions,
} from "../../drizzle/schema";
import { requireDb } from "../db";
import { assignedStudentIds, getTargets, ownedAssessment, summary } from "./assessments";
import {
  bestPerStudent,
  questionStats,
  rank,
  round1,
  scoreDistribution,
  summarizeScores,
  topicStats,
  type ItemRow,
} from "./engine";
import { visibilityForResults } from "./attempts";
import { activeStudentIdsOfGroups, assertGroupOwner, assertTeacherHasStudent } from "./groups";
import type { TeacherScope } from "./access";

async function resultsOfAssessments(assessmentIds: string[]) {
  if (!assessmentIds.length) return [];
  return requireDb()
    .select({ r: results, studentName: users.name })
    .from(results)
    .innerJoin(users, eq(users.id, results.studentId))
    .where(inArray(results.assessmentId, assessmentIds));
}

async function itemsOfResults(resultIds: string[]): Promise<(ItemRow & { resultId: string })[]> {
  if (!resultIds.length) return [];
  const rows = await requireDb().select().from(resultItems).where(inArray(resultItems.resultId, resultIds));
  return rows.map((r) => ({
    resultId: r.resultId,
    questionId: r.versionQuestionId,
    status: r.status,
    earned: r.earned,
    topic: r.topic,
    skill: r.skill,
  }));
}

/** Exam-level overview: participation, completion, distribution and averages. */
export async function assessmentAnalytics(scope: TeacherScope, assessmentId: string) {
  const db = requireDb();
  const a = await ownedAssessment(scope, assessmentId);
  const assigned = await assignedStudentIds(assessmentId);
  const rows = await resultsOfAssessments([assessmentId]);
  const best = bestPerStudent(rows.map((x) => ({ ...x.r, studentName: x.studentName })));
  const started = await db
    .selectDistinct({ studentId: attempts.studentId })
    .from(attempts)
    .where(eq(attempts.assessmentId, assessmentId));
  const scores = best.map((r) => r.percentage);
  const stats = summarizeScores(scores);
  const assignedCount = assigned.length;
  const startedCount = started.length;
  const completedCount = best.length;
  return {
    assessment: summary(a),
    assignedCount,
    startedCount,
    completedCount,
    participationRate: assignedCount ? round1((completedCount / assignedCount) * 100) : 0,
    completionRate: startedCount ? round1((completedCount / startedCount) * 100) : 0,
    averageScore: stats.average,
    medianScore: stats.median,
    highestScore: stats.highest,
    lowestScore: stats.lowest,
    averageDurationSeconds: best.length ? Math.round(best.reduce((s, r) => s + r.durationSeconds, 0) / best.length) : 0,
    pendingReviewCount: best.reduce((s, r) => s + r.pendingReviewCount, 0),
    distribution: scoreDistribution(scores),
  };
}

export async function ranking(scope: TeacherScope, assessmentId: string) {
  await ownedAssessment(scope, assessmentId);
  const rows = await resultsOfAssessments([assessmentId]);
  const best = bestPerStudent(rows.map((x) => ({ ...x.r, studentName: x.studentName })));
  return rank(best).map((r) => ({
    rank: r.rank,
    resultId: r.id,
    studentId: r.studentId,
    studentName: r.studentName,
    percentage: r.percentage,
    earnedPoints: r.earnedPoints,
    totalPoints: r.totalPoints,
    correctCount: r.correctCount,
    totalQuestions: r.correctCount + r.wrongCount + r.unansweredCount + r.pendingReviewCount,
    durationSeconds: r.durationSeconds,
    pendingReviewCount: r.pendingReviewCount,
  }));
}

/** Per-question accuracy across every version of the assessment, hardest first. */
export async function questionAnalytics(scope: TeacherScope, assessmentId: string) {
  const db = requireDb();
  await ownedAssessment(scope, assessmentId);
  const rows = await resultsOfAssessments([assessmentId]);
  const items = await itemsOfResults(rows.map((r) => r.r.id));
  const versionIds = [...new Set(rows.map((r) => r.r.versionId))];
  const qs = versionIds.length
    ? await db.select().from(versionQuestions).where(inArray(versionQuestions.versionId, versionIds)).orderBy(asc(versionQuestions.position))
    : [];
  const questions = qs.map((q) => {
    const stats = questionStats(items.filter((i) => i.questionId === q.id), q.points);
    return { questionId: q.id, versionId: q.versionId, position: q.position, text: q.text, type: q.type, topic: q.topic, ...stats };
  });
  return {
    questions: [...questions].sort((x, y) => x.accuracyPercentage - y.accuracyPercentage),
    mostMissed: questions.filter((q) => q.attempts > 0).sort((x, y) => y.wrongPercentage - x.wrongPercentage).slice(0, 5),
    topics: topicStats(items),
    skills: topicStats(items.filter((i) => i.skill), "skill"),
  };
}

export async function groupAnalytics(scope: TeacherScope, groupId: string) {
  const db = requireDb();
  const group = await assertGroupOwner(scope, groupId);
  const memberIds = await activeStudentIdsOfGroups([groupId]);
  const teacherAssessments = await db
    .select()
    .from(assessments)
    .where(eq(assessments.providerWorkspaceId, scope.workspaceId))
    .orderBy(desc(assessments.createdAt));
  const related: typeof teacherAssessments = [];
  for (const a of teacherAssessments) {
    const t = await getTargets(a.id);
    if (t.groupIds.includes(groupId)) related.push(a);
  }
  const rows = (await resultsOfAssessments(related.map((a) => a.id))).filter((r) => memberIds.includes(r.r.studentId));
  const items = await itemsOfResults(rows.map((r) => r.r.id));

  const byAssessment = related.map((a) => {
    const best = bestPerStudent(rows.filter((r) => r.r.assessmentId === a.id).map((r) => r.r));
    const s = summarizeScores(best.map((b) => b.percentage));
    return {
      ...summary(a),
      completedCount: best.length,
      participationRate: memberIds.length ? round1((best.length / memberIds.length) * 100) : 0,
      averageScore: s.average,
      medianScore: s.median,
    };
  });

  const perStudent = new Map<number, { studentId: number; studentName: string | null; scores: number[]; totalDuration: number }>();
  for (const r of rows) {
    const cur = perStudent.get(r.r.studentId) ?? { studentId: r.r.studentId, studentName: r.studentName, scores: [], totalDuration: 0 };
    cur.scores.push(r.r.percentage);
    cur.totalDuration += r.r.durationSeconds;
    perStudent.set(r.r.studentId, cur);
  }
  const studentRanking = rank(
    [...perStudent.values()].map((s) => ({
      studentId: s.studentId,
      studentName: s.studentName,
      percentage: round1(s.scores.reduce((x, y) => x + y, 0) / s.scores.length),
      durationSeconds: s.totalDuration,
      examCount: s.scores.length,
    })),
  );

  const vqIds = [...new Set(items.map((i) => i.questionId))];
  const vqs = vqIds.length ? await db.select().from(versionQuestions).where(inArray(versionQuestions.id, vqIds)) : [];
  const questionRows = vqs
    .map((q) => ({ questionId: q.id, text: q.text, topic: q.topic, ...questionStats(items.filter((i) => i.questionId === q.id), q.points) }))
    .filter((q) => q.attempts > 0);
  const allScores = byAssessment.filter((a) => a.completedCount > 0);
  const topics = topicStats(items);

  return {
    group: { id: group.id, name: group.name, subject: group.subject, grade: group.grade },
    studentCount: memberIds.length,
    averageScore: allScores.length ? round1(allScores.reduce((s, a) => s + a.averageScore, 0) / allScores.length) : 0,
    history: byAssessment,
    ranking: studentRanking,
    weakQuestions: [...questionRows].sort((a, b) => a.accuracyPercentage - b.accuracyPercentage).slice(0, 5),
    strongQuestions: [...questionRows].sort((a, b) => b.accuracyPercentage - a.accuracyPercentage).slice(0, 5),
    weakTopics: topics.filter((t) => t.classification === "WEAK"),
    strongTopics: topics.filter((t) => t.classification === "STRONG"),
    topics,
    progress: byAssessment
      .filter((a) => a.completedCount > 0)
      .reverse()
      .map((a) => ({ assessmentId: a.id, label: a.title, averageScore: a.averageScore })),
  };
}

export async function groupsOverview(scope: TeacherScope) {
  const db = requireDb();
  const gs = await db.select().from(groups).where(eq(groups.providerWorkspaceId, scope.workspaceId));
  const out = [];
  for (const g of gs) {
    const ga = await groupAnalytics(scope, g.id);
    out.push({
      groupId: g.id,
      name: g.name,
      studentCount: ga.studentCount,
      examCount: ga.history.filter((h) => h.completedCount > 0).length,
      averageScore: ga.averageScore,
      participation: ga.history.length
        ? round1(ga.history.reduce((s, h) => s + h.participationRate, 0) / ga.history.length)
        : 0,
      weakTopics: ga.weakTopics.slice(0, 3).map((t) => t.topic),
    });
  }
  return out;
}

/** Progress series and topic strengths for one student. */
export async function studentProgress(studentId: number, scope?: TeacherScope) {
  const db = requireDb();
  if (scope) await assertTeacherHasStudent(scope, studentId);
  const conds = [eq(results.studentId, studentId)];
  if (scope) conds.push(eq(assessments.providerWorkspaceId, scope.workspaceId));
  const rows = await db
    .select({ r: results, a: assessments, assignmentId: attempts.assignmentId })
    .from(results)
    .innerJoin(assessments, eq(assessments.id, results.assessmentId))
    .innerJoin(attempts, eq(attempts.id, results.attemptId))
    .where(and(...conds))
    .orderBy(asc(results.completedAt));
  let visible = rows;
  if (!scope) {
    const vis = await visibilityForResults(rows.map((x) => ({ result: x.r, assessment: x.a, assignmentId: x.assignmentId })));
    visible = rows.filter((x) => vis.get(x.r.id)?.released);
  }
  const items = await itemsOfResults(visible.map((x) => x.r.id));
  const scores = visible.map((x) => x.r.percentage);
  return {
    series: visible.map((x) => ({
      resultId: x.r.id,
      assessmentId: x.a.id,
      type: x.a.type,
      label: x.a.settings.title,
      percentage: x.r.percentage,
      completedAt: x.r.completedAt,
    })),
    summary: summarizeScores(scores),
    topics: topicStats(items),
    skills: topicStats(items.filter((i) => i.skill), "skill"),
  };
}

/** Analytics "Students" tab: per-student averages across the teacher's assessments. */
export async function studentsAnalytics(scope: TeacherScope) {
  const db = requireDb();
  const list = await db.select({ id: assessments.id }).from(assessments).where(eq(assessments.providerWorkspaceId, scope.workspaceId));
  const rows = await resultsOfAssessments(list.map((a) => a.id));
  const per = new Map<number, { studentId: number; studentName: string | null; scores: number[]; durationSeconds: number; last: Date }>();
  for (const x of rows) {
    const cur = per.get(x.r.studentId) ?? { studentId: x.r.studentId, studentName: x.studentName, scores: [], durationSeconds: 0, last: x.r.completedAt };
    cur.scores.push(x.r.percentage);
    cur.durationSeconds += x.r.durationSeconds;
    if (x.r.completedAt > cur.last) cur.last = x.r.completedAt;
    per.set(x.r.studentId, cur);
  }
  return rank(
    [...per.values()].map((s) => ({
      studentId: s.studentId,
      studentName: s.studentName,
      percentage: round1(s.scores.reduce((a, b) => a + b, 0) / s.scores.length),
      durationSeconds: s.durationSeconds,
      resultCount: s.scores.length,
      lastCompletedAt: s.last,
    })),
  );
}

/** Analytics "Topics" tab across every assessment of the teacher. */
export async function topicsAnalytics(scope: TeacherScope) {
  const db = requireDb();
  const list = await db.select({ id: assessments.id }).from(assessments).where(eq(assessments.providerWorkspaceId, scope.workspaceId));
  const rows = await resultsOfAssessments(list.map((a) => a.id));
  const items = await itemsOfResults(rows.map((r) => r.r.id));
  return { topics: topicStats(items), skills: topicStats(items.filter((i) => i.skill), "skill") };
}

export async function teacherOverview(scope: TeacherScope) {
  const db = requireDb();
  const list = await db.select().from(assessments).where(eq(assessments.providerWorkspaceId, scope.workspaceId));
  const rows = await resultsOfAssessments(list.map((a) => a.id));
  const s = summarizeScores(rows.map((r) => r.r.percentage));
  const items = await itemsOfResults(rows.map((r) => r.r.id));
  return {
    averageScore: s.average,
    medianScore: s.median,
    highestScore: s.highest,
    lowestScore: s.lowest,
    resultCount: s.count,
    weakTopics: topicStats(items).filter((t) => t.classification === "WEAK").slice(0, 5),
  };
}

export async function teacherDashboard(scope: TeacherScope) {
  const db = requireDb();
  const now = new Date();
  const list = await db.select().from(assessments).where(eq(assessments.providerWorkspaceId, scope.workspaceId)).orderBy(desc(assessments.createdAt));
  const summaries = list.map((a) => summary(a, now));
  const rows = await resultsOfAssessments(list.map((a) => a.id));
  const recent = [...rows]
    .sort((x, y) => y.r.completedAt.getTime() - x.r.completedAt.getTime())
    .slice(0, 6)
    .map((x) => ({
      id: x.r.id,
      studentId: x.r.studentId,
      studentName: x.studentName,
      percentage: x.r.percentage,
      completedAt: x.r.completedAt,
      assessmentTitle: list.find((a) => a.id === x.r.assessmentId)?.settings.title ?? "",
    }));
  const perStudent = new Map<number, { id: number; name: string | null; scores: number[] }>();
  for (const x of rows) {
    const cur = perStudent.get(x.r.studentId) ?? { id: x.r.studentId, name: x.studentName, scores: [] };
    cur.scores.push(x.r.percentage);
    perStudent.set(x.r.studentId, cur);
  }
  const weakStudents = [...perStudent.values()]
    .map((s) => ({ id: s.id, name: s.name, averageScore: round1(s.scores.reduce((a, b) => a + b, 0) / s.scores.length) }))
    .filter((s) => s.averageScore < 60)
    .sort((a, b) => a.averageScore - b.averageScore)
    .slice(0, 6);
  const overview = await teacherOverview(scope);
  return {
    upcoming: summaries.filter((s) => s.liveStatus === "SCHEDULED" || s.liveStatus === "ACTIVE").slice(0, 6),
    drafts: summaries.filter((s) => s.liveStatus === "DRAFT").length,
    recentResults: recent,
    weakStudents,
    weakTopics: overview.weakTopics,
    averageScore: overview.averageScore,
  };
}
