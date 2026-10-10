import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateRangeError, existingAccess, selectionFromPreset, type ExistingGrant } from "../client/src/lib/grantSelection";
import {
  emptySelection,
  isChecked,
  planSelection as planGrant,
  searchStudents,
  setStudentChecked,
  toggleGroup,
  type PickStudent,
} from "../client/src/lib/groupStudentSelection";
import * as db from "./db";
import * as groups from "./modules/groups";
import { AppError } from "./modules/errors";
import { grantAccess } from "./syllabus/access";
import * as store from "./syllabus/store";

vi.mock("./db", async (importOriginal) => ({ ...(await importOriginal<typeof import("./db")>()), requireDb: vi.fn() }));
vi.mock("./modules/groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/groups")>()),
  assertGroupOwner: vi.fn(),
  teacherStudentIds: vi.fn(),
}));
vi.mock("./syllabus/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syllabus/store")>()),
  syllabusById: vi.fn(),
  grantsForSyllabus: vi.fn(),
}));
vi.mock("./syllabus/notify", async (importOriginal) => ({ ...(await importOriginal<typeof import("./syllabus/notify")>()), announceGrants: vi.fn() }));
vi.mock("./syllabus/activityLog", () => ({ logActivity: vi.fn(async () => undefined) }));

const NOW = new Date("2026-10-09T08:00:00Z");

// ---------------------------------------------------------------------------
// Dialog selection → grant plan
// ---------------------------------------------------------------------------

const st = (id: number, groupIds: string[], name = `S${id}`): PickStudent => ({ id, name, email: `s${id}@x.az`, groupIds });
const STUDENTS = [st(1, ["prog"]), st(2, ["prog"]), st(3, ["prog", "data"]), st(4, ["data"]), st(5, ["info"])];
const none = existingAccess([], STUDENTS);

describe("grant dialog plan", () => {
  it("a selected group with every student checked becomes one group grant", () => {
    const sel = toggleGroup(emptySelection(), "prog", STUDENTS);
    expect(planGrant(sel, STUDENTS, none)).toEqual({ groupIds: ["prog"], studentIds: [], partialGroupIds: [], studentCount: 3 });
  });

  it("an empty group is still a group grant, for students who join later", () => {
    const sel = toggleGroup(emptySelection(), "empty", STUDENTS);
    expect(planGrant(sel, STUDENTS, none)).toMatchObject({ groupIds: ["empty"], studentIds: [], studentCount: 0 });
  });

  it("unchecking a student turns the group into individual grants for the rest", () => {
    let sel = toggleGroup(emptySelection(), "prog", STUDENTS);
    sel = setStudentChecked(sel, STUDENTS[1], false);
    expect(planGrant(sel, STUDENTS, none)).toEqual({ groupIds: [], studentIds: [1, 3], partialGroupIds: ["prog"], studentCount: 2 });
    expect(isChecked(sel, STUDENTS[1], none)).toBe(false);
    expect(isChecked(sel, STUDENTS[0], none)).toBe(true);
  });

  it("re-checking restores the group grant", () => {
    let sel = toggleGroup(emptySelection(), "prog", STUDENTS);
    sel = setStudentChecked(setStudentChecked(sel, STUDENTS[1], false), STUDENTS[1], true);
    expect(planGrant(sel, STUDENTS, none).groupIds).toEqual(["prog"]);
  });

  it("everyone unchecked grants nothing", () => {
    let sel = toggleGroup(emptySelection(), "info", STUDENTS);
    sel = setStudentChecked(sel, STUDENTS[4], false);
    expect(planGrant(sel, STUDENTS, none)).toMatchObject({ groupIds: [], studentIds: [], partialGroupIds: ["info"] });
  });

  it("a student covered by a whole group is not granted again through a partial one", () => {
    let sel = toggleGroup(toggleGroup(emptySelection(), "prog", STUDENTS), "data", STUDENTS);
    sel = setStudentChecked(sel, STUDENTS[3], false);
    expect(planGrant(sel, STUDENTS, none)).toEqual({ groupIds: ["prog"], studentIds: [], partialGroupIds: ["data"], studentCount: 3 });
  });

  it("existing live grants: the group is skipped and already-reached students stay out of the plan", () => {
    const grants: ExistingGrant[] = [
      { groupId: "data", studentId: null, state: "ACTIVE" },
      { groupId: null, studentId: 1, state: "PENDING" },
      { groupId: "info", studentId: null, state: "REVOKED" },
      { groupId: null, studentId: 2, state: "EXPIRED" },
    ];
    const access = existingAccess(grants, STUDENTS);
    expect([...access.groups]).toEqual(["data"]);
    expect([...access.students].sort()).toEqual([1, 3, 4]);
    const sel = toggleGroup(toggleGroup(emptySelection(), "prog", STUDENTS), "data", STUDENTS);
    expect(planGrant(sel, STUDENTS, access)).toEqual({ groupIds: ["prog"], studentIds: [], partialGroupIds: [], studentCount: 1 });
    expect(isChecked(emptySelection(), STUDENTS[0], access)).toBe(true);
  });

  it("individual picks without a group become individual grants", () => {
    const sel = setStudentChecked(setStudentChecked(emptySelection(), STUDENTS[4], true), STUDENTS[0], true);
    expect(planGrant(sel, STUDENTS, none)).toEqual({ groupIds: [], studentIds: [5, 1], partialGroupIds: [], studentCount: 2 });
    expect(planGrant(setStudentChecked(sel, STUDENTS[4], false), STUDENTS, none).studentIds).toEqual([1]);
  });

  it("selecting a group absorbs its individually picked members; leaving it forgets its unchecks", () => {
    let sel = setStudentChecked(emptySelection(), STUDENTS[0], true);
    sel = toggleGroup(sel, "prog", STUDENTS);
    expect(sel.extra).toEqual([]);
    sel = setStudentChecked(sel, STUDENTS[1], false);
    sel = toggleGroup(sel, "prog", STUDENTS);
    expect(sel).toEqual({ groupIds: [], excluded: [], extra: [] });
  });

  it("restore preset: groups whole, students individually", () => {
    const sel = selectionFromPreset({ groupIds: ["info"], studentIds: [4] });
    expect(planGrant(sel, STUDENTS, none)).toMatchObject({ groupIds: ["info"], studentIds: [4] });
  });

  it("search folds case and Azerbaijani letters and matches email", () => {
    const people = [st(1, [], "Əli Qabilzadə"), st(2, [], "İlkin Şıxəliyev"), st(3, [], "Narmin")];
    expect(searchStudents(people, "ALI qab").map((s) => s.id)).toEqual([1]);
    expect(searchStudents(people, "ali").map((s) => s.id)).toEqual([1, 2]);
    expect(searchStudents(people, "ilkin sixali").map((s) => s.id)).toEqual([2]);
    expect(searchStudents(people, "s3@").map((s) => s.id)).toEqual([3]);
    expect(searchStudents(people, "   ")).toEqual([]);
  });

  it("dates: optional, end after start and in the future", () => {
    const d = (iso: string) => new Date(iso);
    expect(dateRangeError(null, null, NOW)).toBeNull();
    expect(dateRangeError(d("2026-10-12T09:00:00Z"), null, NOW)).toBeNull();
    expect(dateRangeError(d("2026-10-12T09:00:00Z"), d("2026-10-12T09:00:00Z"), NOW)).toBe("badRange");
    expect(dateRangeError(null, d("2026-10-01T00:00:00Z"), NOW)).toBe("endPast");
    expect(dateRangeError(d("2026-10-12T09:00:00Z"), d("2027-01-31T00:00:00Z"), NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Server: grantAccess still trusts nothing from the client
// ---------------------------------------------------------------------------

describe("grantAccess", () => {
  const SCOPE = { workspaceId: "ws1", userId: 7 } as never;
  let inserted: Array<Record<string, unknown>>;

  beforeEach(() => {
    inserted = [];
    vi.mocked(db.requireDb).mockReturnValue({
      insert: () => ({ values: async (rows: Array<Record<string, unknown>>) => void inserted.push(...rows) }),
    } as never);
    vi.mocked(store.syllabusById).mockImplementation(async (id: string) => (id === "syl1" ? { id, providerWorkspaceId: "ws1", archivedAt: null, currentVersionId: "v1" } : { id, providerWorkspaceId: "other", archivedAt: null }) as never);
    vi.mocked(store.grantsForSyllabus).mockResolvedValue([]);
    vi.mocked(groups.assertGroupOwner).mockImplementation(async (_s, groupId: string) => {
      if (groupId.startsWith("foreign")) throw new AppError("NOT_FOUND");
      return {} as never;
    });
    vi.mocked(groups.teacherStudentIds).mockResolvedValue([1, 2, 3]);
  });
  afterEach(() => vi.clearAllMocks());

  const input = (over: Partial<Parameters<typeof grantAccess>[2]> = {}) => ({ groupIds: [], studentIds: [], startsAt: null, endsAt: null, ...over });

  it("a whole group becomes one group row (covers later members)", async () => {
    await grantAccess(SCOPE, "syl1", input({ groupIds: ["prog", "prog"] }), NOW);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ syllabusId: "syl1", groupId: "prog", studentId: null, grantedBy: 7 });
  });

  it("a partial group arrives as individual rows only", async () => {
    await grantAccess(SCOPE, "syl1", input({ studentIds: [1, 3] }), NOW);
    expect(inserted.map((r) => [r.groupId, r.studentId])).toEqual([
      [null, 1],
      [null, 3],
    ]);
  });

  it("keeps dates and a trimmed note on every row", async () => {
    const startsAt = new Date("2026-10-12T09:00:00Z");
    const endsAt = new Date("2027-01-31T00:00:00Z");
    await grantAccess(SCOPE, "syl1", input({ groupIds: ["prog"], studentIds: [2], startsAt, endsAt, note: "  trial  " }), NOW);
    expect(inserted.every((r) => r.startsAt === startsAt && r.endsAt === endsAt && r.note === "trial")).toBe(true);
  });

  it("rejects a group of another workspace before writing", async () => {
    await expect(grantAccess(SCOPE, "syl1", input({ groupIds: ["prog", "foreign1"] }), NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(inserted).toEqual([]);
  });

  it("rejects a student outside the teacher's groups before writing", async () => {
    await expect(grantAccess(SCOPE, "syl1", input({ studentIds: [1, 99] }), NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inserted).toEqual([]);
  });

  it("rejects a syllabus of another workspace", async () => {
    await expect(grantAccess(SCOPE, "syl_other", input({ groupIds: ["prog"] }), NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(groups.assertGroupOwner).not.toHaveBeenCalled();
  });

  it("rejects an end before the start or already past", async () => {
    const at = (iso: string) => new Date(iso);
    await expect(grantAccess(SCOPE, "syl1", input({ groupIds: ["prog"], startsAt: at("2026-11-01T00:00:00Z"), endsAt: at("2026-10-20T00:00:00Z") }), NOW)).rejects.toMatchObject({ code: "SYLLABUS_INVALID_TARGET" });
    await expect(grantAccess(SCOPE, "syl1", input({ groupIds: ["prog"], endsAt: at("2026-10-01T00:00:00Z") }), NOW)).rejects.toMatchObject({ code: "SYLLABUS_INVALID_TARGET" });
    expect(inserted).toEqual([]);
  });
});
