import { describe, expect, it } from "vitest";
import { buildPopulation } from "./syllabus/analytics";
import { rosterSummary, sortRoster, type RosterRow } from "./syllabus/roster";

const NOW = new Date("2026-10-10T10:00:00Z");
const at = (d: string) => new Date(`2026-10-${d}T10:00:00Z`);
const grant = (over: Record<string, unknown>) => ({ status: "ACTIVE" as const, startsAt: null, endsAt: null, groupId: null, studentId: null, grantedAt: at("01"), ...over });

function scenario() {
  const grants = [
    grant({ groupId: "g1" }),
    grant({ groupId: "g2" }),
    grant({ studentId: 1 }),
    grant({ studentId: 5 }),
    grant({ studentId: 6, startsAt: at("20") }),
    grant({ studentId: 7, endsAt: at("05") }),
    grant({ studentId: 8, status: "REVOKED" }),
    grant({ groupId: "foreign" }),
  ];
  const enrollments = [
    { studentId: 1, viaGroupId: null, progressPct: 40 },
    { studentId: 7, viaGroupId: null, progressPct: 90 },
    { studentId: 9, viaGroupId: "g1", progressPct: 20 },
  ];
  const groups = [
    { id: "g1", name: "Data A", workspaceId: "ws" },
    { id: "g2", name: "Data B", workspaceId: "ws" },
    { id: "foreign", name: "Other", workspaceId: "ws_other" },
  ];
  const members = [
    { groupId: "g1", userId: 1 },
    { groupId: "g1", userId: 2 },
    { groupId: "g1", userId: 3 },
    { groupId: "g2", userId: 3 },
    { groupId: "g2", userId: 4 },
    { groupId: "foreign", userId: 99 },
  ];
  const built = buildPopulation({ workspaceId: "ws", grants, enrollments, groups, members, names: new Map(), now: NOW });
  return { grants, enrollments, built };
}

describe("syllabus card counts", () => {
  it("counts each student once across groups and individual grants", () => {
    const { grants, enrollments, built } = scenario();
    const summary = rosterSummary({ students: built.students, grants, ownGroupIds: built.groups.map((g) => g.id), enrollments, now: NOW });
    expect(summary).toEqual({
      students: 5, // 1 (group + individual), 2, 3 (two groups), 4, 5
      pending: 1, // 6
      ended: 3, // 7 expired, 8 revoked, 9 enrolled but no grant left
      total: 9,
      groups: 2, // the foreign group never counts
      individual: 3, // 1, 5 and 6 (starts later)
      enrolled: 3,
      averageProgressPct: 50,
    });
    expect(built.students.some((s) => s.studentId === 99)).toBe(false);
    expect(summary.students + summary.pending + summary.ended).toBe(summary.total);
  });

  it("has nothing to count for a syllabus nobody was given", () => {
    expect(rosterSummary({ students: [], grants: [], ownGroupIds: [], enrollments: [], now: NOW })).toEqual({
      students: 0,
      pending: 0,
      ended: 0,
      total: 0,
      groups: 0,
      individual: 0,
      enrolled: 0,
      averageProgressPct: 0,
    });
  });
});

describe("syllabus card student list order", () => {
  const row = (studentId: number, name: string, access: RosterRow["access"], progressPct: number | null, last: string | null): RosterRow => ({
    studentId,
    name,
    access,
    groups: [],
    individual: false,
    progressPct,
    completed: false,
    lastActivityAt: last ? at(last) : null,
  });
  const rows = () => [
    row(1, "Aysel", "ACTIVE", 40, "07"),
    row(2, "Murad", "ACTIVE", null, null),
    row(3, "Leyla", "EXPIRED", 90, "09"),
    row(4, "Nigar", "PENDING", null, null),
    row(5, "Orxan", "ACTIVE", 10, "09"),
  ];

  it("puts current students first, then by progress or by last activity", () => {
    expect(sortRoster(rows(), "progress").map((r) => r.studentId)).toEqual([1, 5, 2, 4, 3]);
    expect(sortRoster(rows(), "activity").map((r) => r.studentId)).toEqual([5, 1, 2, 4, 3]);
  });
});
