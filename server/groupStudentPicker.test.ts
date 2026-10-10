import { describe, expect, it } from "vitest";
import { existingAccess } from "../client/src/lib/grantSelection";
import {
  emptySelection,
  isChecked,
  planSelection,
  recipientsPayload,
  searchStudents,
  selectionFromTargets,
  setStudentChecked,
  shareSummary,
  toggleGroup,
  uncheckedCount,
  type PickStudent,
} from "../client/src/lib/groupStudentSelection";

const st = (id: number, groupIds: string[], name = `S${id}`): PickStudent => ({ id, name, email: `s${id}@x.az`, groupIds });
const GROUPS = [{ id: "prog" }, { id: "data" }, { id: "info" }, { id: "empty" }];
// prog: 1 2 3 · data: 3 4 5 · info: 6 7
const STUDENTS = [st(1, ["prog"]), st(2, ["prog"]), st(3, ["prog", "data"]), st(4, ["data"]), st(5, ["data"]), st(6, ["info"]), st(7, ["info"])];
const S = (id: number) => STUDENTS.find((s) => s.id === id)!;

const pick = (...steps: Array<(sel: ReturnType<typeof emptySelection>) => ReturnType<typeof emptySelection>>) => steps.reduce((sel, f) => f(sel), emptySelection());
const group = (id: string) => (sel: ReturnType<typeof emptySelection>) => toggleGroup(sel, id, STUDENTS);
const uncheck = (id: number) => (sel: ReturnType<typeof emptySelection>) => setStudentChecked(sel, S(id), false);
const check = (id: number) => (sel: ReturnType<typeof emptySelection>) => setStudentChecked(sel, S(id), true);

describe("picker: students follow groups", () => {
  it("no group selected: nobody is checked and nothing is saved", () => {
    expect(STUDENTS.some((s) => isChecked(emptySelection(), s))).toBe(false);
    expect(recipientsPayload(emptySelection(), STUDENTS)).toEqual({ groupIds: [], studentIds: [] });
  });

  it("selecting a group checks exactly its students", () => {
    const sel = pick(group("prog"));
    expect(STUDENTS.filter((s) => isChecked(sel, s)).map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it("search is case-, accent- and Azerbaijani-letter-insensitive", () => {
    const people = [st(1, [], "Əli Qabilzadə"), st(2, [], "İlkin Şıxəliyev"), st(3, [], "Narmin")];
    expect(searchStudents(people, "ALI qab").map((s) => s.id)).toEqual([1]);
    expect(searchStudents(people, "ilkin sixali").map((s) => s.id)).toEqual([2]);
    expect(searchStudents(people, "s3@x").map((s) => s.id)).toEqual([3]);
  });

  it("an existing-access set locks students and skips the group (syllabus)", () => {
    const access = existingAccess([{ groupId: "info", studentId: null, state: "ACTIVE" }, { groupId: null, studentId: 1, state: "ACTIVE" }], STUDENTS);
    expect(planSelection(pick(group("prog"), group("info")), STUDENTS, access)).toEqual({ groupIds: ["prog"], studentIds: [], partialGroupIds: [], studentCount: 2 });
  });
});

describe("picker: saved targets reopen as they were saved", () => {
  const reopen = (targets: { groupIds: string[]; studentIds: number[] }) => selectionFromTargets(targets, GROUPS, STUDENTS);
  const roundTrip = (targets: { groupIds: string[]; studentIds: number[] }) => {
    const { selection, kept } = reopen(targets);
    return recipientsPayload(selection, STUDENTS, { kept });
  };

  it("a saved group reopens selected with all students checked", () => {
    const { selection } = reopen({ groupIds: ["prog"], studentIds: [] });
    expect(selection).toEqual({ groupIds: ["prog"], excluded: [], extra: [] });
  });

  it("some students of a group reopen as a partial group", () => {
    const { selection } = reopen({ groupIds: [], studentIds: [1, 3] });
    expect(selection.groupIds).toEqual(["prog"]);
    expect(STUDENTS.filter((s) => isChecked(selection, s)).map((s) => s.id)).toEqual([1, 3]);
    expect(planSelection(selection, STUDENTS).partialGroupIds).toEqual(["prog"]);
  });

  it("a student in two groups doesn't open the second group too", () => {
    expect(reopen({ groupIds: [], studentIds: [3] }).selection.groupIds).toEqual(["prog"]);
    expect(reopen({ groupIds: [], studentIds: [3, 4] }).selection.groupIds).toEqual(["data"]);
    expect(reopen({ groupIds: [], studentIds: [1, 3, 4] }).selection.groupIds.sort()).toEqual(["data", "prog"]);
  });

  it("every student of a group saved one by one stays individual (not silently turned into a group)", () => {
    const { selection } = reopen({ groupIds: [], studentIds: [6, 7] });
    expect(selection).toEqual({ groupIds: [], excluded: [], extra: [6, 7] });
  });

  it("ids the picker cannot show are kept", () => {
    expect(reopen({ groupIds: ["ghost", "info"], studentIds: [99, 1] }).kept).toEqual([99]);
    expect(roundTrip({ groupIds: ["info"], studentIds: [99, 1] })).toEqual({ groupIds: ["info"], studentIds: [1, 99] });
  });

  it("round trip is lossless for every combination on the fixture", () => {
    const groupSets = [[], ["prog"], ["data"], ["prog", "info"], ["empty"]];
    const ids = STUDENTS.map((s) => s.id);
    for (const groupIds of groupSets) {
      for (let mask = 0; mask < 1 << ids.length; mask++) {
        const studentIds = ids.filter((_, i) => mask & (1 << i));
        const covered = new Set(STUDENTS.filter((s) => s.groupIds.some((g) => groupIds.includes(g))).map((s) => s.id));
        const out = roundTrip({ groupIds, studentIds });
        expect([...out.groupIds].sort()).toEqual([...groupIds].sort());
        expect([...out.studentIds].sort()).toEqual(studentIds.filter((id) => !covered.has(id)).sort());
      }
    }
  });
});

describe("form payloads", () => {
  it("material: whole group → group; partial → its checked students; share-link joiners kept", () => {
    expect(recipientsPayload(pick(group("prog")), STUDENTS)).toEqual({ groupIds: ["prog"], studentIds: [] });
    expect(recipientsPayload(pick(group("prog"), uncheck(2)), STUDENTS)).toEqual({ groupIds: [], studentIds: [1, 3] });
    expect(recipientsPayload(pick(group("info"), check(4)), STUDENTS, { kept: [42] })).toEqual({ groupIds: ["info"], studentIds: [4, 42] });
  });

  it("task with open link: same mapping as materials", () => {
    expect(recipientsPayload(pick(group("data"), uncheck(5), check(1)), STUDENTS)).toEqual({ groupIds: [], studentIds: [3, 4, 1] });
  });

  it("restricted task: every selected group whole, never individual students", () => {
    const sel = pick(group("prog"), uncheck(2), check(6));
    expect(recipientsPayload(sel, STUDENTS, { groupsOnly: true, kept: [42] })).toEqual({ groupIds: ["prog"], studentIds: [] });
  });

  it("exam: a student in two selected groups counts once; a whole group covers them", () => {
    const sel = pick(group("prog"), group("data"), uncheck(4));
    expect(recipientsPayload(sel, STUDENTS)).toEqual({ groupIds: ["prog"], studentIds: [5] });
    expect(planSelection(sel, STUDENTS).studentCount).toBe(4);
  });

  it("deselecting a group forgets its unchecks; selecting it absorbs individual picks", () => {
    const sel = pick(check(1), group("prog"), uncheck(2), group("prog"));
    expect(sel).toEqual({ groupIds: [], excluded: [], extra: [] });
  });

  it("removing a group drops only its own students; shared members and individual picks stay", () => {
    const sel = pick(group("prog"), group("data"), check(6), group("prog"));
    expect(STUDENTS.filter((s) => isChecked(sel, s)).map((s) => s.id)).toEqual([3, 4, 5, 6]);
  });
});

describe("compact picker: share summary", () => {
  const NAMED = [
    { id: "prog", name: "Proqramlaşdırma" },
    { id: "data", name: "Data Analitika" },
    { id: "info", name: "Info" },
  ];
  const summary = (sel: ReturnType<typeof emptySelection>) => shareSummary(planSelection(sel, STUDENTS), NAMED);

  it("whole groups: their names and how many students they reach (a shared member once)", () => {
    expect(summary(pick(group("data"), group("prog")))).toEqual({ groupNames: ["Data Analitika", "Proqramlaşdırma"], groupStudents: 5, students: 0 });
  });

  it("a group with someone left out counts as selected students only", () => {
    expect(summary(pick(group("prog"), uncheck(2)))).toEqual({ groupNames: [], groupStudents: 0, students: 2 });
  });

  it("whole group plus individual picks", () => {
    expect(summary(pick(group("info"), check(1)))).toEqual({ groupNames: ["Info"], groupStudents: 2, students: 1 });
  });

  it("nothing selected", () => {
    expect(summary(emptySelection())).toEqual({ groupNames: [], groupStudents: 0, students: 0 });
  });

  it("counts left-out members of selected groups only", () => {
    expect(uncheckedCount(pick(group("prog"), uncheck(2), uncheck(3)), STUDENTS)).toBe(2);
    expect(uncheckedCount(pick(group("prog"), uncheck(2), group("prog")), STUDENTS)).toBe(0);
  });
});
