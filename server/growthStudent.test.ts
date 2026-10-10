import { beforeEach, describe, expect, it, vi } from "vitest";
import { statusLabel } from "../client/src/components/growth/Mastery";
import type { StatRow } from "./growth/mastery";
import { onlyReleased } from "./growth/released";
import { AppError } from "./modules/errors";

const mocks = vi.hoisted(() => ({
  groups: [] as { groupId: string; name: string; workspaceId: string }[],
  released: new Set<string>(),
  stats: [] as StatRow[],
}));

vi.mock("./db", () => ({ requireDb: () => ({}), getDb: () => null }));
vi.mock("./growth/availability", () => ({
  studentGrowthGroups: async () => mocks.groups,
  studentGroupWorkspace: async (_userId: number, groupId: string) => {
    const hit = mocks.groups.find((g) => g.groupId === groupId);
    if (!hit) throw new AppError("NOT_FOUND");
    return hit;
  },
}));
vi.mock("./growth/released", async (importActual) => ({
  ...(await importActual<typeof import("./growth/released")>()),
  releasedResultIds: async () => mocks.released,
}));
vi.mock("./growth/weakness", () => ({ studentStats: async () => mocks.stats }));

const { studentSpaces, studentWeaknessMap } = await import("./growth/studentView");

const day = (n: number) => new Date(Date.UTC(2026, 8, n));
const row = (resultId: string, n: number, earned: number, possible = 4): StatRow => ({
  resultId,
  completedAt: day(n),
  origin: "EXAM",
  questionCount: possible,
  pendingCount: 0,
  earned,
  possible,
  wrongPoints: possible - earned,
  dimension: "TOPIC",
  topicKey: "qt:frac",
  questionTopicId: "frac",
  label: "Kəsrlər",
});

beforeEach(() => {
  mocks.groups = [
    { groupId: "g1", name: "9A", workspaceId: "w1" },
    { groupId: "g2", name: "9A əlavə", workspaceId: "w1" },
    { groupId: "g3", name: "Fizika", workspaceId: "w2" },
  ];
  mocks.released = new Set();
  mocks.stats = [];
});

describe("student topic map", () => {
  it("groups the student's groups by teacher workspace", async () => {
    expect(await studentSpaces(7)).toEqual([
      { groupId: "g1", groups: ["9A", "9A əlavə"] },
      { groupId: "g3", groups: ["Fizika"] },
    ]);
  });

  it("refuses a group the student is not an active member of", async () => {
    await expect(studentWeaknessMap(7, "other")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses released results only", async () => {
    mocks.stats = [row("r1", 1, 4), row("r2", 2, 0), row("r3", 3, 0)];
    mocks.released = new Set(["r1"]);
    const map = await studentWeaknessMap(7, "g1");
    expect(map.topics).toHaveLength(1);
    expect(map.topics[0]).toMatchObject({ topicKey: "qt:frac", evidenceCount: 4 });
    expect(map.topics[0].mastery).toBeGreaterThan(75);
    expect(onlyReleased(mocks.stats, mocks.released).map((s) => s.resultId)).toEqual(["r1"]);
  });

  it("shows nothing when no result is released yet", async () => {
    mocks.stats = [row("r1", 1, 0)];
    const map = await studentWeaknessMap(7, "g1");
    expect(map).toEqual({ topics: [], skills: [], gains: [] });
  });
});

describe("labels", () => {
  it("calls a critical topic a priority topic for students", () => {
    expect(statusLabel("CRITICAL", "teacher")).toBe("Kritik zəiflik");
    expect(statusLabel("CRITICAL", "student")).toBe("Prioritet mövzu");
    expect(statusLabel("REVIEW", "student")).toBe("Təkrar lazımdır");
  });
});
