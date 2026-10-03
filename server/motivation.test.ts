import { describe, expect, it } from "vitest";
import {
  dailyActivity,
  dayKey,
  firstSubmitters,
  groupScoreBoard,
  lastDays,
  onTimeRate,
  rankStudents,
  studentStats,
  type SubmissionFact,
} from "./modules/motivation";

const at = (iso: string) => new Date(iso);
const sub = (taskId: string, studentId: number, first: string | null, last: string | null = first): SubmissionFact => ({
  taskId,
  studentId,
  firstSubmittedAt: first ? at(first) : null,
  submittedAt: last ? at(last) : null,
});

describe("first submitters", () => {
  const members = new Set([1, 2, 3, 4]);

  it("orders by first submission, keeps the top 3, ignores non-members", () => {
    const list = [
      sub("t", 3, "2026-05-01T10:05:00Z"),
      sub("t", 9, "2026-05-01T09:00:00Z"),
      sub("t", 1, "2026-05-01T10:00:00Z"),
      sub("t", 4, "2026-05-01T11:00:00Z"),
      sub("t", 2, "2026-05-01T10:01:00Z"),
    ];
    expect(firstSubmitters(list, members).map((f) => [f.place, f.studentId])).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it("a resubmission does not move a student down: the first time counts", () => {
    const list = [sub("t", 1, "2026-05-01T10:00:00Z", "2026-05-03T10:00:00Z"), sub("t", 2, "2026-05-02T10:00:00Z")];
    expect(firstSubmitters(list, members)[0].studentId).toBe(1);
  });

  it("falls back to submittedAt for rows from before firstSubmittedAt existed, and breaks ties by id", () => {
    const legacy: SubmissionFact = { taskId: "t", studentId: 4, firstSubmittedAt: null, submittedAt: at("2026-05-01T09:00:00Z") };
    const tie = [sub("t", 3, "2026-05-01T10:00:00Z"), sub("t", 2, "2026-05-01T10:00:00Z")];
    expect(firstSubmitters([...tie, legacy], members).map((f) => f.studentId)).toEqual([4, 2, 3]);
  });

  it("skips rows without any submission time", () => {
    expect(firstSubmitters([sub("t", 1, null)], members)).toEqual([]);
  });
});

describe("daily activity", () => {
  it("buckets by Baku calendar day and zero-fills", () => {
    const now = at("2026-05-03T12:00:00Z");
    const days = lastDays(now, 3);
    expect(days).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);
    // 21:30 UTC on May 1 is already May 2 in Baku (UTC+4).
    const rows = dailyActivity(days, [at("2026-05-01T21:30:00Z"), at("2026-05-03T08:00:00Z")], [at("2026-05-01T10:00:00Z"), at("2026-04-20T10:00:00Z")]);
    expect(rows).toEqual([
      { day: "2026-05-01", opens: 0, submissions: 1 },
      { day: "2026-05-02", opens: 1, submissions: 0 },
      { day: "2026-05-03", opens: 1, submissions: 0 },
    ]);
  });

  it("formats day keys as YYYY-MM-DD", () => {
    expect(dayKey(at("2026-12-31T20:00:00Z"))).toBe("2027-01-01");
    expect(dayKey(at("2026-12-31T20:00:00Z"), "UTC")).toBe("2026-12-31");
  });
});

describe("student stats and ranking", () => {
  const taskList = [
    { id: "a", deadline: at("2026-05-01T12:00:00Z") },
    { id: "b", deadline: at("2026-05-05T12:00:00Z") },
  ];
  const subs = [
    sub("a", 1, "2026-05-01T09:00:00Z"),
    sub("a", 2, "2026-05-01T10:00:00Z"),
    sub("a", 3, "2026-05-02T10:00:00Z"),
    sub("b", 2, "2026-05-04T10:00:00Z"),
    sub("b", 1, "2026-05-04T11:00:00Z", "2026-05-06T11:00:00Z"),
    sub("x", 1, "2026-05-04T11:00:00Z"),
  ];

  it("counts submissions, on time by first submission, first places and opens", () => {
    const stats = studentStats([1, 2, 3, 4], taskList, subs, new Map([[3, new Set(["a", "b", "zzz"])]]));
    const by = new Map(stats.map((s) => [s.studentId, s]));
    expect(by.get(1)).toMatchObject({ submitted: 2, onTime: 2, late: 0, firstPlaces: 1, podiums: 2 });
    expect(by.get(2)).toMatchObject({ submitted: 2, onTime: 2, firstPlaces: 1, podiums: 2 });
    expect(by.get(3)).toMatchObject({ submitted: 1, onTime: 0, late: 1, firstPlaces: 0, podiums: 1, opened: 2 });
    expect(by.get(4)).toMatchObject({ submitted: 0, firstPlaces: 0, lastSubmittedAt: null });
    expect(by.get(1)!.lastSubmittedAt).toEqual(at("2026-05-06T11:00:00Z"));
  });

  it("ranks with ties sharing a place", () => {
    const ranked = rankStudents(studentStats([1, 2, 3, 4], taskList, subs));
    expect(ranked.map((r) => [r.studentId, r.rank])).toEqual([[1, 1], [2, 1], [3, 3], [4, 4]]);
  });

  it("computes the on-time rate", () => {
    expect(onTimeRate({ submitted: 3, onTime: 2 })).toBe(67);
    expect(onTimeRate({ submitted: 0, onTime: 0 })).toBe(0);
  });
});

describe("group score board visibility", () => {
  const released = at("2026-05-02T10:00:00Z");
  const members = [
    { studentId: 1, name: "Aysel", email: "aysel@example.com" },
    { studentId: 2, name: "Murad", email: "murad@example.com" },
    { studentId: 3, name: "Nigar", email: "nigar@example.com" },
  ];
  const taskList = [
    { id: "a", title: "Task A" },
    { id: "b", title: "Task B" },
    { id: "c", title: "Task C" },
  ];
  // Rows straight from the DB may carry more than the board should ever pass on.
  const grades = [
    { taskId: "a", studentId: 1, score: 90, feedbackReleasedAt: released, teacherFeedback: "private note", suggestedScore: 12, aiFeedback: "AI text", comment: "answer body" },
    { taskId: "b", studentId: 1, score: 70, feedbackReleasedAt: released },
    { taskId: "a", studentId: 2, score: 80, feedbackReleasedAt: released },
    { taskId: "b", studentId: 2, score: 95, feedbackReleasedAt: null },
    { taskId: "c", studentId: 3, score: null, feedbackReleasedAt: released },
    { taskId: "a", studentId: 99, score: 100, feedbackReleasedAt: released },
  ];
  const board = (visible: boolean, viewerId = 2) => groupScoreBoard({ visible, viewerId, members, tasks: taskList, grades });

  it("ON: shows every member's released scores per task, ranked by average", () => {
    const b = board(true);
    expect(b.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(b.rows.map((r) => [r.name, r.scores, r.average, r.total, r.rank, r.isYou])).toEqual([
      ["Aysel", [90, 70], 80, 160, 1, false],
      ["Murad", [80, null], 80, 80, 2, true],
      ["Nigar", [null, null], null, 0, null, false],
    ]);
  });

  it("never counts unreleased scores, scores of non-members, or released rows without a score", () => {
    const b = board(true);
    const murad = b.rows.find((r) => r.name === "Murad")!;
    expect(murad.scores).not.toContain(95);
    expect(JSON.stringify(b)).not.toContain("100");
    expect(b.tasks.some((t) => t.id === "c")).toBe(false);
  });

  it("OFF: only the viewer's own released scores", () => {
    const b = board(false);
    expect(b.visible).toBe(false);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]).toMatchObject({ name: "Murad", isYou: true, scores: [80], average: 80 });
    expect(b.tasks.map((t) => t.id)).toEqual(["a"]);
    const text = JSON.stringify(b);
    expect(text).not.toContain("Aysel");
    expect(text).not.toContain("90");
  });

  it("never passes on e-mails, ids, feedback, AI output or submission contents", () => {
    for (const visible of [true, false]) {
      const b = board(visible, 1);
      const text = JSON.stringify(b);
      for (const secret of ["@example.com", "private note", "AI text", "answer body", "suggestedScore", "studentId", "feedback"]) {
        expect(text).not.toContain(secret);
      }
      for (const row of b.rows) expect(Object.keys(row).sort()).toEqual(["average", "gradedCount", "isYou", "name", "rank", "scores", "total"]);
    }
  });

  it("ties on average and total share a rank", () => {
    const b = groupScoreBoard({
      visible: true,
      viewerId: 1,
      members: members.slice(0, 2),
      tasks: taskList,
      grades: [
        { taskId: "a", studentId: 1, score: 50, feedbackReleasedAt: released },
        { taskId: "a", studentId: 2, score: 50, feedbackReleasedAt: released },
      ],
    });
    expect(b.rows.map((r) => r.rank)).toEqual([1, 1]);
  });
});
