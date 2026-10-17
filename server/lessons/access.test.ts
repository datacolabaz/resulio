import { describe, expect, it } from "vitest";
import { lessonJoinDecision, lessonReachesStudent, lessonRosterStudentIds } from "./access";

describe("lessonReachesStudent", () => {
  const lesson = { groupIds: ["g1"], studentIds: [42] };

  it("true when the student is in a selected group", () => {
    expect(lessonReachesStudent(lesson, 1, ["g1"])).toBe(true);
  });

  it("true when the student is individually selected, even in no selected group", () => {
    expect(lessonReachesStudent(lesson, 42, [])).toBe(true);
  });

  it("false otherwise", () => {
    expect(lessonReachesStudent(lesson, 99, ["g2"])).toBe(false);
  });
});

describe("lessonRosterStudentIds", () => {
  it("dedupes group members and individually-added students", () => {
    expect(lessonRosterStudentIds([1, 2, 3], [3, 4])).toEqual([1, 2, 3, 4]);
  });
});

describe("lessonJoinDecision", () => {
  const lesson = {
    groupIds: ["g1"],
    studentIds: [] as number[],
    startsAt: new Date("2026-10-19T10:00:00Z"),
    endsAt: new Date("2026-10-19T11:00:00Z"),
    status: "SCHEDULED" as const,
    joinWindowBeforeMin: 10,
    joinWindowAfterMin: 30,
  };

  it("the workspace owner may always join, outside the window and even if not a recipient", () => {
    const viewer = { userId: 1, managesWorkspace: true, studentId: null, studentGroupIds: [] };
    expect(lessonJoinDecision(lesson, viewer, new Date("2026-10-19T08:00:00Z"))).toBe("OWNER");
  });

  it("a non-recipient student is denied outright, even inside the time window", () => {
    const viewer = { userId: 2, managesWorkspace: false, studentId: 2, studentGroupIds: ["g2"] };
    expect(lessonJoinDecision(lesson, viewer, new Date("2026-10-19T10:30:00Z"))).toBe("DENIED");
  });

  it("a recipient too early gets NOT_YET_OPEN, not a bare denial", () => {
    const viewer = { userId: 3, managesWorkspace: false, studentId: 3, studentGroupIds: ["g1"] };
    expect(lessonJoinDecision(lesson, viewer, new Date("2026-10-19T08:00:00Z"))).toBe("NOT_YET_OPEN");
  });

  it("a recipient inside the window is ALLOWED", () => {
    const viewer = { userId: 3, managesWorkspace: false, studentId: 3, studentGroupIds: ["g1"] };
    expect(lessonJoinDecision(lesson, viewer, new Date("2026-10-19T09:55:00Z"))).toBe("ALLOWED");
  });

  it("a recipient after the closing grace gets CLOSED", () => {
    const viewer = { userId: 3, managesWorkspace: false, studentId: 3, studentGroupIds: ["g1"] };
    expect(lessonJoinDecision(lesson, viewer, new Date("2026-10-19T12:00:00Z"))).toBe("CLOSED");
  });

  it("a cancelled lesson is CLOSED for a recipient even mid-window", () => {
    const viewer = { userId: 3, managesWorkspace: false, studentId: 3, studentGroupIds: ["g1"] };
    expect(lessonJoinDecision({ ...lesson, status: "CANCELLED" }, viewer, new Date("2026-10-19T10:30:00Z"))).toBe("CLOSED");
  });
});
