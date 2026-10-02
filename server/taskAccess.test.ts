import { describe, expect, it } from "vitest";
import {
  canSeeTaskContent,
  fileOpenToAnyone,
  rosterStudentIds,
  taskReachesStudent,
  taskViewerAccess,
  type TaskAccessSubject,
} from "./modules/taskAccess";

const publicTask: TaskAccessSubject = { accessMode: "PUBLIC", groupIds: ["g1"], studentIds: [7] };
const groupsTask: TaskAccessSubject = { accessMode: "GROUPS", groupIds: ["g1", "g2"], studentIds: [7] };

describe("taskViewerAccess", () => {
  it("lets anyone, signed in or not, see an open-link task", () => {
    expect(taskViewerAccess(publicTask, null)).toBe("ALLOWED");
    expect(taskViewerAccess(publicTask, { userId: 99, managesWorkspace: false, groupIds: [] })).toBe("ALLOWED");
  });

  it("asks an anonymous visitor of a group-restricted task to sign in", () => {
    expect(taskViewerAccess(groupsTask, null)).toBe("SIGN_IN_REQUIRED");
  });

  it("allows a member of any one of the selected groups", () => {
    expect(taskViewerAccess(groupsTask, { userId: 5, managesWorkspace: false, groupIds: ["g2"] })).toBe("ALLOWED");
  });

  it("denies a signed-in student outside the selected groups, even one listed individually or who claimed the link earlier", () => {
    expect(taskViewerAccess(groupsTask, { userId: 7, managesWorkspace: false, groupIds: ["other"] })).toBe("DENIED");
    expect(taskViewerAccess(groupsTask, { userId: 8, managesWorkspace: false, groupIds: [] })).toBe("DENIED");
  });

  it("always lets the owning teacher in, in either mode", () => {
    const owner = { userId: 1, managesWorkspace: true, groupIds: [] };
    expect(taskViewerAccess(groupsTask, owner)).toBe("OWNER");
    expect(taskViewerAccess(publicTask, owner)).toBe("OWNER");
  });

  it("treats a restricted task with no groups as closed to every student", () => {
    const empty: TaskAccessSubject = { accessMode: "GROUPS", groupIds: [], studentIds: [7] };
    expect(taskViewerAccess(empty, { userId: 7, managesWorkspace: false, groupIds: ["g1"] })).toBe("DENIED");
  });

  it("only exposes content for OWNER and ALLOWED", () => {
    expect(canSeeTaskContent("OWNER")).toBe(true);
    expect(canSeeTaskContent("ALLOWED")).toBe(true);
    expect(canSeeTaskContent("SIGN_IN_REQUIRED")).toBe(false);
    expect(canSeeTaskContent("DENIED")).toBe(false);
  });
});

describe("taskReachesStudent (dashboard, claim, submit, attachment download)", () => {
  it("reaches group members and individually listed students of an open-link task", () => {
    expect(taskReachesStudent(publicTask, 3, ["g1"])).toBe(true);
    expect(taskReachesStudent(publicTask, 7, [])).toBe(true);
    expect(taskReachesStudent(publicTask, 3, [])).toBe(false);
  });

  it("reaches only group members of a restricted task", () => {
    expect(taskReachesStudent(groupsTask, 3, ["g1"])).toBe(true);
    expect(taskReachesStudent(groupsTask, 7, [])).toBe(false);
    expect(taskReachesStudent(groupsTask, 7, ["g3"])).toBe(false);
  });
});

describe("fileOpenToAnyone", () => {
  it("never opens a private file", () => {
    expect(fileOpenToAnyone(false, [], true)).toBe(false);
    expect(fileOpenToAnyone(false, [{ accessMode: "PUBLIC" }], false)).toBe(false);
  });

  it("keeps attachments of open-link tasks and material files public", () => {
    expect(fileOpenToAnyone(true, [{ accessMode: "PUBLIC" }], false)).toBe(true);
    expect(fileOpenToAnyone(true, [{ accessMode: "GROUPS" }], true)).toBe(true);
    expect(fileOpenToAnyone(true, [], false)).toBe(true);
  });

  it("closes a public-flagged file that is attached only to restricted tasks", () => {
    expect(fileOpenToAnyone(true, [{ accessMode: "GROUPS" }], false)).toBe(false);
    expect(fileOpenToAnyone(true, [{ accessMode: "GROUPS" }, { accessMode: "GROUPS" }], false)).toBe(false);
  });

  it("stays open while any open-link task still attaches it", () => {
    expect(fileOpenToAnyone(true, [{ accessMode: "GROUPS" }, { accessMode: "PUBLIC" }], false)).toBe(true);
  });
});

describe("rosterStudentIds", () => {
  it("adds individually listed students only for open-link tasks, de-duplicated", () => {
    expect(rosterStudentIds(publicTask, [3, 7]).sort()).toEqual([3, 7]);
    expect(rosterStudentIds({ ...publicTask, studentIds: [9] }, [3]).sort()).toEqual([3, 9]);
    expect(rosterStudentIds(groupsTask, [3, 4])).toEqual([3, 4]);
  });
});
