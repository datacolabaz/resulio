import { describe, expect, it } from "vitest";
import { groupExamStatsView } from "./modules/analytics";

/**
 * `groupExamStatsView` is the redaction boundary between a teacher's full `groupAnalytics` result
 * (which carries other students' names and individual scores in `ranking`/`history`) and what a
 * group MEMBER is allowed to see of their own group. These tests pin that boundary directly,
 * without needing a database -- see the approval's requirement that exam-result sharing stay
 * off by default and never expose another student's individual result, name or answers.
 */
describe("groupExamStatsView", () => {
  const group = { id: "g1", name: "Riyaziyyat 101" };

  // A realistic full groupAnalytics() result -- including the per-student fields that must never
  // leak to a classmate.
  const full = {
    studentCount: 12,
    averageScore: 74,
    topics: [{ topic: "Cəbr", questionCount: 10, accuracyPercentage: 60, classification: "WEAK" as const }],
    weakTopics: [{ topic: "Cəbr", questionCount: 10, accuracyPercentage: 60, classification: "WEAK" as const }],
    strongTopics: [{ topic: "Həndəsə", questionCount: 8, accuracyPercentage: 90, classification: "STRONG" as const }],
    weakQuestions: [{ questionId: "q1", sourceQuestionId: "sq1", text: "2x+3=7 həllini tap", topic: "Cəbr", flagged: false, accuracyPercentage: 40 }],
    strongQuestions: [{ questionId: "q2", sourceQuestionId: "sq2", text: "Üçbucağın sahəsi", topic: "Həndəsə", flagged: false, accuracyPercentage: 95 }],
    progress: [{ assessmentId: "a1", label: "1-ci imtahan", averageScore: 70 }],
    // Fields a real groupAnalytics() result carries that must NEVER reach a group member.
    group: { id: "g1", name: "Riyaziyyat 101", subject: "Riyaziyyat", grade: "9" },
    history: [{ id: "a1", title: "1-ci imtahan", completedCount: 11, participationRate: 92, averageScore: 70, medianScore: 72 }],
    ranking: [{ studentId: 1, studentName: "Aysel Məmmədova", percentage: 95, durationSeconds: 1200, examCount: 3 }],
  } as Parameters<typeof groupExamStatsView>[2];

  it("OFF: returns only {group, visible:false} -- no stats at all", () => {
    const v = groupExamStatsView(group, false, full);
    expect(v).toEqual({ group, visible: false });
  });

  it("OFF (no `full` given): same minimal shape", () => {
    expect(groupExamStatsView(group, false)).toEqual({ group, visible: false });
    expect(groupExamStatsView(group, true)).toEqual({ group, visible: false });
  });

  it("ON: exposes only the allow-listed aggregate fields", () => {
    const v = groupExamStatsView(group, true, full);
    expect(v.visible).toBe(true);
    expect(Object.keys(v).sort()).toEqual(
      ["averageScore", "group", "progress", "strongQuestions", "strongTopics", "studentCount", "topics", "visible", "weakQuestions", "weakTopics"].sort(),
    );
    expect(v.studentCount).toBe(12);
    expect(v.averageScore).toBe(74);
  });

  it("ON: never a student name, id, or anything from ranking/history", () => {
    const v = groupExamStatsView(group, true, full);
    const text = JSON.stringify(v);
    for (const secret of ["Aysel", "studentId", "studentName", "ranking", "history", "participationRate", "medianScore", "examCount", "durationSeconds"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("ON: question rows carry only text/topic/accuracy -- never ids or flag state", () => {
    const v = groupExamStatsView(group, true, full);
    expect(v.weakQuestions).toEqual([{ text: "2x+3=7 həllini tap", topic: "Cəbr", accuracyPercentage: 40 }]);
    expect(v.strongQuestions).toEqual([{ text: "Üçbucağın sahəsi", topic: "Həndəsə", accuracyPercentage: 95 }]);
    const text = JSON.stringify(v);
    for (const secret of ["questionId", "sourceQuestionId", "flagged"]) expect(text).not.toContain(secret);
  });
});
