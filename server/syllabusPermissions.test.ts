import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Syllabus, SyllabusAccessGrant, SyllabusEnrollment, User } from "../drizzle/schema";
import { resolveRules } from "../shared/syllabus";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import * as accessMod from "./modules/access";
import { AppError } from "./modules/errors";
import * as groups from "./modules/groups";
import { appRouter } from "./routers";
import { assertStudentAccess, ownedSyllabus } from "./syllabus/access";
import * as availability from "./syllabus/availability";
import { computeProgress } from "./syllabus/engine";
import * as learning from "./syllabus/learning";
import * as progression from "./syllabus/progression";
import * as store from "./syllabus/store";
import type { ItemStub, VersionStructure } from "./syllabus/types";

vi.mock("./modules/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/access")>()),
  resolveWorkspace: vi.fn(),
  resolveAccess: vi.fn(),
  platformRolesOf: vi.fn(async () => []),
}));
vi.mock("./modules/groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/groups")>()),
  activeGroupIdsOfStudent: vi.fn(),
}));
vi.mock("./syllabus/availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syllabus/availability")>()),
  syllabusEnabledFor: vi.fn(),
  assertSyllabusEnabled: vi.fn(),
}));
vi.mock("./syllabus/store", () => ({
  syllabusById: vi.fn(),
  versionById: vi.fn(),
  versionItems: vi.fn(),
  moduleDetailsOfVersion: vi.fn(async () => new Map()),
  grantsForSyllabus: vi.fn(),
  grantsReachingStudent: vi.fn(),
  enrollmentOf: vi.fn(),
  enrollmentsOfStudent: vi.fn(),
  syllabiByIds: vi.fn(),
  progressVisibleToGroup: vi.fn(),
  groupById: vi.fn(),
  activeMembersWithNames: vi.fn(),
  enrollmentsOfStudents: vi.fn(),
  groupsByIds: vi.fn(),
  completionOf: vi.fn(),
}));
vi.mock("./syllabus/progression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syllabus/progression")>()),
  current: vi.fn(),
  enroll: vi.fn(),
  recompute: vi.fn(),
}));

const m = {
  access: vi.mocked(accessMod),
  groups: vi.mocked(groups),
  availability: vi.mocked(availability),
  store: vi.mocked(store),
  progression: vi.mocked(progression),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUDENT = 21;
const NOW = new Date("2026-06-01T12:00:00Z");

const SYLLABUS = {
  id: "syl1",
  providerWorkspaceId: "ws_teacher",
  ownerUserId: 7,
  title: "Python",
  description: "",
  subject: "",
  level: "",
  coverFileId: null,
  currentVersionId: "v1",
  archivedAt: null,
} as unknown as Syllabus;

const ENROLLMENT = {
  id: "en1",
  syllabusId: "syl1",
  studentId: STUDENT,
  versionId: "v1",
  status: "ACTIVE",
} as unknown as SyllabusEnrollment;

function grant(over: Partial<SyllabusAccessGrant> = {}): SyllabusAccessGrant {
  return {
    id: "g1",
    syllabusId: "syl1",
    groupId: "grp1",
    studentId: null,
    status: "ACTIVE",
    startsAt: null,
    endsAt: null,
    note: null,
    grantedBy: 7,
    grantedAt: new Date("2026-01-01"),
    revokedBy: null,
    revokedAt: null,
    ...over,
  };
}

const stub = (id: string, kind: ItemStub["kind"]): ItemStub => ({
  id,
  kind,
  scope: "LESSON",
  title: id,
  position: 0,
  required: true,
  assessmentId: kind === "ASSESSMENT" ? "as1" : null,
  assessmentVersionId: kind === "ASSESSMENT" ? "asv1" : null,
  taskId: null,
  passPct: null,
  retry: null,
});

const rules = resolveRules();
const STRUCTURE: VersionStructure = {
  formatVersion: 1,
  rules,
  finalItems: [],
  modules: [
    {
      id: "m1",
      title: "Basics",
      description: "secret module description",
      position: 1,
      estimatedMinutes: null,
      objectives: ["obj"],
      prerequisitesText: "",
      rules,
      items: [],
      lessons: [
        { id: "l1", moduleId: "m1", title: "Intro", description: "", position: 1, estimatedMinutes: 10, objectives: [], rules, items: [stub("th1", "THEORY"), stub("tp1", "TEACHER_PRACTICE")] },
        { id: "l2", moduleId: "m1", title: "Loops", description: "loops body", position: 2, estimatedMinutes: 10, objectives: ["x"], rules, items: [stub("th2", "THEORY"), stub("a2", "ASSESSMENT")] },
      ],
    },
  ],
};

function enrolledState() {
  const output = computeProgress({
    structure: STRUCTURE,
    facts: new Map(),
    prevModules: new Map(),
    prevLessons: new Map(),
    openedLessons: new Set(),
    manualModules: new Set(),
    manualLessons: new Set(),
    approvals: new Set(),
  });
  return { enrollment: ENROLLMENT, structure: STRUCTURE, output };
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof TRPCError) return `${e.code}:${e.message}`;
    if (e instanceof AppError) return e.code;
    return `THROWN:${(e as Error).message}`;
  }
}

function user(id: number): User {
  return { id, openId: `google:${id}`, name: "U", email: `u${id}@example.com`, accountStatus: "ACTIVE", sessionsValidAfter: null } as unknown as User;
}

function caller(u: User) {
  const ctx: TrpcContext = {
    user: u,
    session: null,
    req: { ip: "10.0.0.9", protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

beforeEach(() => {
  resetRateLimits();
  m.availability.syllabusEnabledFor.mockResolvedValue(true);
  m.availability.assertSyllabusEnabled.mockResolvedValue(undefined);
  m.groups.activeGroupIdsOfStudent.mockResolvedValue(["grp1"]);
  m.store.syllabusById.mockResolvedValue(SYLLABUS);
  m.store.grantsForSyllabus.mockResolvedValue([grant()]);
  m.store.enrollmentOf.mockResolvedValue(ENROLLMENT);
  m.store.versionItems.mockResolvedValue([]);
  m.store.progressVisibleToGroup.mockResolvedValue(true);
  m.store.groupById.mockResolvedValue({ id: "grp1", name: "Qrup A", workspaceId: "ws_teacher" });
  m.progression.current.mockResolvedValue(enrolledState());
});
afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Teacher side
// ---------------------------------------------------------------------------

describe("teacher isolation", () => {
  it("a syllabus of another workspace looks like it does not exist", async () => {
    expect(await codeOf(ownedSyllabus({ workspaceId: "ws_other", userId: 99 }, "syl1"))).toBe("NOT_FOUND");
    await expect(ownedSyllabus({ workspaceId: "ws_teacher", userId: 7 }, "syl1")).resolves.toBe(SYLLABUS);
    m.store.syllabusById.mockResolvedValue(null);
    expect(await codeOf(ownedSyllabus({ workspaceId: "ws_teacher", userId: 7 }, "missing"))).toBe("NOT_FOUND");
  });

  it("teacher syllabus procedures require an owned workspace and the feature flag", async () => {
    m.access.resolveWorkspace.mockResolvedValue(null);
    expect(await codeOf(caller(user(7)).teacher.syllabus.list())).toBe("FORBIDDEN:NO_WORKSPACE");

    m.access.resolveWorkspace.mockResolvedValue({ id: "ws_other", ownerUserId: 99 } as never);
    m.availability.assertSyllabusEnabled.mockRejectedValue(new AppError("SYLLABUS_NOT_AVAILABLE"));
    expect(await codeOf(caller(user(99)).teacher.syllabus.list())).toBe("FORBIDDEN:SYLLABUS_NOT_AVAILABLE");
    expect(m.availability.assertSyllabusEnabled).toHaveBeenCalledWith("ws_other");
    expect(await codeOf(caller(user(99)).teacher.syllabus.createSample({ locale: "az" }))).toBe("FORBIDDEN:SYLLABUS_NOT_AVAILABLE");
    expect(await codeOf(caller(user(99)).teacher.syllabus.preview({ id: "syl1" }))).toBe("FORBIDDEN:SYLLABUS_NOT_AVAILABLE");
    expect(await codeOf(caller(user(99)).teacher.syllabus.publishPreview({ id: "syl1" }))).toBe("FORBIDDEN:SYLLABUS_NOT_AVAILABLE");
  });

  it("another teacher cannot read a syllabus through the router", async () => {
    m.access.resolveWorkspace.mockResolvedValue({ id: "ws_other", ownerUserId: 99 } as never);
    expect(await codeOf(caller(user(99)).teacher.syllabus.get({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(caller(user(99)).teacher.syllabus.grants({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(caller(user(99)).teacher.syllabus.preview({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(caller(user(99)).teacher.syllabus.publishPreview({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Student access gate
// ---------------------------------------------------------------------------

describe("student access gate", () => {
  it("allows a student reached by an active group grant", async () => {
    const a = await assertStudentAccess(STUDENT, "syl1", NOW);
    expect(a.grant.id).toBe("g1");
    expect(a.groupIds).toEqual(["grp1"]);
  });

  it("hides the syllabus entirely when the feature is off for its workspace", async () => {
    m.availability.syllabusEnabledFor.mockResolvedValue(false);
    expect(await codeOf(assertStudentAccess(STUDENT, "syl1", NOW))).toBe("NOT_FOUND");
  });

  it("hides it from students no grant reaches (other groups, other students)", async () => {
    m.groups.activeGroupIdsOfStudent.mockResolvedValue(["grp_other"]);
    m.store.grantsForSyllabus.mockResolvedValue([grant(), grant({ id: "g2", groupId: null, studentId: 999 })]);
    expect(await codeOf(assertStudentAccess(STUDENT, "syl1", NOW))).toBe("NOT_FOUND");
  });

  it("says NO_ACCESS (not NOT_FOUND) for an expired, pending or revoked grant", async () => {
    for (const g of [
      grant({ endsAt: new Date("2026-05-01") }),
      grant({ startsAt: new Date("2026-07-01") }),
      grant({ status: "REVOKED", revokedAt: new Date("2026-05-01") }),
    ]) {
      m.store.grantsForSyllabus.mockResolvedValue([g]);
      expect(await codeOf(assertStudentAccess(STUDENT, "syl1", NOW))).toBe("SYLLABUS_NO_ACCESS");
    }
  });

  it("re-granting after a revoke restores access", async () => {
    m.store.grantsForSyllabus.mockResolvedValue([grant({ status: "REVOKED" }), grant({ id: "g3", groupId: null, studentId: STUDENT })]);
    expect((await assertStudentAccess(STUDENT, "syl1", NOW)).grant.id).toBe("g3");
  });

  it("refuses an unpublished syllabus", async () => {
    m.store.syllabusById.mockResolvedValue({ ...SYLLABUS, currentVersionId: null });
    expect(await codeOf(assertStudentAccess(STUDENT, "syl1", NOW))).toBe("SYLLABUS_NOT_PUBLISHED");
  });
});

// ---------------------------------------------------------------------------
// Locked content never leaves the server
// ---------------------------------------------------------------------------

describe("locked content", () => {
  it("a locked lesson returns only its title and lock reason, and its content is never loaded", async () => {
    const view = await learning.lesson(STUDENT, "syl1", "l2");
    expect(m.store.versionItems).toHaveBeenCalledWith("v1", []);
    expect(view).toEqual({
      locked: true,
      lesson: { id: "l2", moduleId: "m1", moduleTitle: "Basics", title: "Loops", position: 2 },
      lockReason: { code: "PREVIOUS_LESSON", lessonId: "l1", title: "Intro" },
    });
    expect(JSON.stringify(view)).not.toContain("loops body");
  });

  it("an unlocked lesson loads only its own items and strips teacher-only fields", async () => {
    m.store.versionItems.mockResolvedValue([
      { itemId: "th1", kind: "THEORY", content: { blocks: [{ type: "markdown", md: "Salam" }] } },
      { itemId: "tp1", kind: "TEACHER_PRACTICE", content: { problem: "P", teacherOnly: { solution: "SECRET", notes: "NOTE" }, revealSolutionToStudents: false } },
    ] as never);
    const view = await learning.lesson(STUDENT, "syl1", "l1");
    expect(m.store.versionItems).toHaveBeenCalledWith("v1", ["th1", "tp1"]);
    expect(view?.locked).toBe(false);
    const text = JSON.stringify(view);
    expect(text).toContain("Salam");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("NOTE");
  });

  it("the path view omits descriptions of locked lessons", async () => {
    m.store.versionById.mockResolvedValue({ version: { label: "v1.0" }, structure: STRUCTURE } as never);
    const path = await learning.learningPath(STUDENT, "syl1");
    const l2 = path.modules[0].lessons[1];
    expect(l2).toEqual({ id: "l2", title: "Loops", position: 2, status: "LOCKED", lockReason: expect.any(Object), optional: false, estimatedMinutes: null });
  });

  it("actions on locked items are refused before touching the database", async () => {
    expect(await codeOf(learning.completeTheory(STUDENT, "syl1", "th2"))).toBe("SYLLABUS_LOCKED");
    expect(await codeOf(learning.startAssessment(STUDENT, "syl1", "a2"))).toBe("SYLLABUS_LOCKED");
    expect(await codeOf(learning.completeTheory(STUDENT, "syl1", "not_in_version"))).toBe("NOT_FOUND");
  });

  it("the student router returns the locked shape too, and refuses students without a grant", async () => {
    const c = caller(user(STUDENT));
    expect(await c.student.syllabus.lesson({ id: "syl1", lessonId: "l2" })).toMatchObject({ locked: true });
    m.store.grantsForSyllabus.mockResolvedValue([]);
    expect(await codeOf(c.student.syllabus.lesson({ id: "syl1", lessonId: "l1" }))).toBe("NOT_FOUND:NOT_FOUND");
  });

  it("revoked access keeps the enrollment but blocks content", async () => {
    m.store.grantsForSyllabus.mockResolvedValue([grant({ status: "REVOKED" })]);
    expect(await codeOf(learning.lesson(STUDENT, "syl1", "l1"))).toBe("SYLLABUS_NO_ACCESS");
    expect(m.store.versionItems).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Groupmate visibility (Q7)
// ---------------------------------------------------------------------------

describe("groupmate progress visibility", () => {
  beforeEach(() => {
    m.store.activeMembersWithNames.mockResolvedValue([
      { studentId: STUDENT, name: "Mən" },
      { studentId: 22, name: "Aysel" },
      { studentId: 23, name: "Murad" },
    ]);
    m.store.enrollmentsOfStudents.mockResolvedValue([
      { ...ENROLLMENT, progressPct: 25, completedLessons: 1, totalLessons: 4, currentModuleId: "m1" },
      { ...ENROLLMENT, id: "en2", studentId: 22, progressPct: 100, completedLessons: 4, totalLessons: 4, currentModuleId: null, status: "COMPLETED" },
    ] as never);
    m.store.versionById.mockResolvedValue({ version: { label: "v1.0" }, structure: STRUCTURE } as never);
  });

  it("shows groupmates' progress fields only while the setting is on (default)", async () => {
    const res = await learning.groupProgress(STUDENT, "syl1", "grp1");
    expect(res.group).toEqual({ id: "grp1", name: "Qrup A" });
    expect(res.members.map((r) => [r.name, r.progressPct, r.started, r.completed, r.isMe])).toEqual([
      ["Aysel", 100, true, true, false],
      ["Mən", 25, true, false, true],
      ["Murad", 0, false, false, false],
    ]);
    expect(res.members[1].currentModuleTitle).toBe("Basics");
    for (const row of res.members) {
      expect(Object.keys(row).sort()).toEqual(
        ["completed", "completedLessons", "currentModuleTitle", "isMe", "name", "progressPct", "started", "studentId", "totalLessons"].sort(),
      );
    }
  });

  it("is refused when the teacher turns the setting off", async () => {
    m.store.progressVisibleToGroup.mockResolvedValue(false);
    expect(await codeOf(learning.groupProgress(STUDENT, "syl1", "grp1"))).toBe("SYLLABUS_PROGRESS_HIDDEN");
    expect(m.store.activeMembersWithNames).not.toHaveBeenCalled();
  });

  it("is refused for a group the student is not in, a foreign group, or a group without a grant", async () => {
    expect(await codeOf(learning.groupProgress(STUDENT, "syl1", "grp_other"))).toBe("NOT_FOUND");

    m.store.groupById.mockResolvedValue({ id: "grp1", name: "X", workspaceId: "ws_other" });
    expect(await codeOf(learning.groupProgress(STUDENT, "syl1", "grp1"))).toBe("NOT_FOUND");

    m.store.groupById.mockResolvedValue({ id: "grp1", name: "Qrup A", workspaceId: "ws_teacher" });
    m.groups.activeGroupIdsOfStudent.mockResolvedValue(["grp1", "grp2"]);
    m.store.grantsForSyllabus.mockResolvedValue([grant({ groupId: "grp2" })]);
    expect(await codeOf(learning.groupProgress(STUDENT, "syl1", "grp1"))).toBe("NOT_FOUND");
  });

  it("the router maps the hidden setting to FORBIDDEN", async () => {
    m.store.progressVisibleToGroup.mockResolvedValue(false);
    expect(await codeOf(caller(user(STUDENT)).student.syllabus.groupProgress({ id: "syl1", groupId: "grp1" }))).toBe("FORBIDDEN:SYLLABUS_PROGRESS_HIDDEN");
  });
});

// ---------------------------------------------------------------------------
// Student progression UI (Phase 3)
// ---------------------------------------------------------------------------

describe("student overview and nav flag", () => {
  beforeEach(() => {
    m.store.versionById.mockResolvedValue({ version: { label: "v1.0" }, structure: STRUCTURE } as never);
    m.store.groupsByIds.mockResolvedValue([{ id: "grp1", name: "Qrup A", workspaceId: "ws_teacher" }] as never);
  });

  it("active access returns the path with progress summary and the student's granted groups", async () => {
    const res = await learning.overview(STUDENT, "syl1");
    expect(res.mode).toBe("ACTIVE");
    expect(res.path?.groups).toEqual([{ id: "grp1", name: "Qrup A" }]);
    expect(res.path?.summary.theory).toEqual({ total: 2, completed: 0 });
    expect(res.path?.completion).toBeNull();
    expect(m.store.completionOf).not.toHaveBeenCalled();
  });

  it("ended access shows progress only — no content is loaded", async () => {
    m.store.grantsForSyllabus.mockResolvedValue([grant({ status: "REVOKED", revokedAt: new Date("2026-05-01") })]);
    m.store.enrollmentOf.mockResolvedValue(null);
    const res = await learning.overview(STUDENT, "syl1");
    expect(res).toMatchObject({ mode: "ENDED", path: null, ended: { access: "REVOKED", progress: null, modules: [] } });
    expect(m.store.versionItems).not.toHaveBeenCalled();
  });

  it("students no grant reaches get NOT_FOUND, not an ended view", async () => {
    m.store.grantsForSyllabus.mockResolvedValue([]);
    expect(await codeOf(learning.overview(STUDENT, "syl1"))).toBe("NOT_FOUND");
    expect(await codeOf(caller(user(STUDENT)).student.syllabus.overview({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
  });

  it("the nav flag is on only when an enabled, published syllabus reaches the student, and never throws", async () => {
    m.store.grantsReachingStudent.mockResolvedValue([grant()]);
    m.store.enrollmentsOfStudent.mockResolvedValue([]);
    m.store.syllabiByIds.mockResolvedValue([SYLLABUS]);
    expect(await caller(user(STUDENT)).student.syllabus.enabled()).toEqual({ enabled: true });

    m.availability.syllabusEnabledFor.mockResolvedValue(false);
    expect(await caller(user(STUDENT)).student.syllabus.enabled()).toEqual({ enabled: false });

    m.availability.syllabusEnabledFor.mockResolvedValue(true);
    m.store.syllabiByIds.mockResolvedValue([{ ...SYLLABUS, currentVersionId: null }]);
    expect(await caller(user(STUDENT)).student.syllabus.enabled()).toEqual({ enabled: false });

    m.store.grantsReachingStudent.mockRejectedValue(new Error("Table 'syllabus_access_grants' doesn't exist"));
    expect(await caller(user(STUDENT)).student.syllabus.enabled()).toEqual({ enabled: false });
  });

  it("another teacher cannot see the students, approvals or a student's detail", async () => {
    m.access.resolveWorkspace.mockResolvedValue({ id: "ws_other", ownerUserId: 99 } as never);
    const c = caller(user(99));
    expect(await codeOf(c.teacher.syllabus.students({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(c.teacher.syllabus.approvals({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(c.teacher.syllabus.student({ id: "syl1", studentId: STUDENT }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(c.teacher.syllabus.manualUnlock({ id: "syl1", studentId: STUDENT, targetType: "LESSON", targetId: "l2", reason: "sick leave" }))).toBe("NOT_FOUND:NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Analytics privacy (§41)
// ---------------------------------------------------------------------------

describe("analytics privacy", () => {
  it("another teacher gets NOT_FOUND for the analytics, a timeline and the risk settings", async () => {
    m.access.resolveWorkspace.mockResolvedValue({ id: "ws_other", ownerUserId: 99 } as never);
    const c = caller(user(99));
    expect(await codeOf(c.teacher.syllabus.analytics({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(c.teacher.syllabus.analytics({ id: "syl1", groupId: "grp1" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(c.teacher.syllabus.analyticsTimeline({ id: "syl1", studentId: STUDENT }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(c.teacher.syllabus.analyticsSettings({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
    const settings = { thresholds: { inactiveDays: 7, failedAttempts: 2, progressGapPct: 25, stuckDays: 14, missingPractice: 2, practiceGraceDays: 7 }, digestEnabled: true };
    expect(await codeOf(c.teacher.syllabus.saveAnalyticsSettings({ id: "syl1", settings }))).toBe("NOT_FOUND:NOT_FOUND");
  });

  it("a student cannot call the teacher analytics", async () => {
    m.access.resolveWorkspace.mockResolvedValue(null);
    const c = caller(user(STUDENT));
    expect(await codeOf(c.teacher.syllabus.analytics({ id: "syl1" }))).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(await codeOf(c.teacher.syllabus.analyticsTimeline({ id: "syl1", studentId: STUDENT }))).toBe("FORBIDDEN:NO_WORKSPACE");
  });

  it("a student sees only their own history, and only with an enrollment in an enabled syllabus", async () => {
    const c = caller(user(STUDENT));
    m.store.enrollmentOf.mockResolvedValue(null);
    expect(await codeOf(c.student.syllabus.activity({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(m.store.enrollmentOf).toHaveBeenCalledWith("syl1", STUDENT);

    m.store.enrollmentOf.mockResolvedValue(ENROLLMENT);
    m.availability.syllabusEnabledFor.mockResolvedValue(false);
    expect(await codeOf(c.student.syllabus.activity({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
  });

  it("rejects bad threshold values before anything is saved", async () => {
    m.access.resolveWorkspace.mockResolvedValue({ id: "ws_teacher", ownerUserId: 7 } as never);
    const settings = { thresholds: { inactiveDays: 0, failedAttempts: 2, progressGapPct: 25, stuckDays: 14, missingPractice: 2, practiceGraceDays: 7 }, digestEnabled: true };
    expect(await codeOf(caller(user(7)).teacher.syllabus.saveAnalyticsSettings({ id: "syl1", settings }))).toMatch(/^BAD_REQUEST/);
  });

  it("admin analytics needs the syllabus.view permission", async () => {
    expect(await codeOf(caller(user(5)).admin.syllabus.analytics({ syllabusId: "syl1" }))).toBe("FORBIDDEN:NOT_ADMIN");
    m.access.platformRolesOf.mockResolvedValue(["PARTNER_ADMIN"]);
    expect(await codeOf(caller(user(5)).admin.syllabus.analytics({ syllabusId: "syl1" }))).toBe("FORBIDDEN:NOT_ADMIN");
  });
});

