import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Syllabus, SyllabusAccessGrant, User } from "../drizzle/schema";
import { resolveRules } from "../shared/syllabus";
import { normalizeShareCode, SHARE_CODE_LENGTH } from "../shared/syllabusJoin";
import { emptyModuleDetails } from "../shared/syllabusModuleDetails";
import { emptyTiming } from "../shared/syllabusTiming";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import * as accessMod from "./modules/access";
import { AppError } from "./modules/errors";
import * as groups from "./modules/groups";
import * as taskNotify from "./modules/taskNotify";
import * as dispatcher from "./notifications/dispatcher";
import { renderNotification } from "./notifications/render";
import { appRouter } from "./routers";
import { assertStudentAccess } from "./syllabus/access";
import * as availability from "./syllabus/availability";
import * as joinStore from "./syllabus/joinStore";
import { isShareable, joinRequestRejection, openKeyOf, publicSyllabusView, selectUpcomingGroups, startOfBakuDay, type ListingCandidate } from "./syllabus/joinRules";
import * as notify from "./syllabus/notify";
import * as store from "./syllabus/store";
import type { ItemStub, VersionStructure } from "./syllabus/types";

// ---------------------------------------------------------------------------
// In-memory stand-in for the share-link / listing / join-request tables
// ---------------------------------------------------------------------------

type Req = {
  id: string;
  syllabusId: string;
  workspaceId: string;
  studentId: number;
  type: "GROUP" | "INDIVIDUAL";
  groupId: string | null;
  message: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELLED";
  openKey: string | null;
  decisionNote: string | null;
  decidedBy: number | null;
  decidedAt: Date | null;
  createdAt: Date;
};

const mem = vi.hoisted(() => ({
  links: new Map<string, { syllabusId: string; code: string; active: boolean; createdBy: number; createdAt: Date; updatedAt: Date }>(),
  listings: new Set<string>(),
  requests: [] as Req[],
  groups: new Map<string, ListingCandidate>(),
  members: new Map<number, string[]>(),
  users: new Map<number, { name: string; email: string }>(),
}));

const dup = () => Object.assign(new Error("Duplicate entry"), { errno: 1062, code: "ER_DUP_ENTRY" });

vi.mock("./syllabus/joinStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("./syllabus/joinStore")>();
  const listingKey = (s: string, g: string) => `${s}|${g}`;
  return {
    isDuplicateKey: real.isDuplicateKey,
    shareLinkOf: vi.fn(async (syllabusId: string) => mem.links.get(syllabusId) ?? null),
    shareLinkByCode: vi.fn(async (code: string) => [...mem.links.values()].find((l) => l.code === code) ?? null),
    shareLinksOf: vi.fn(async (ids: string[]) => ids.flatMap((id) => (mem.links.has(id) ? [mem.links.get(id)!] : []))),
    insertShareLink: vi.fn(async (row: { syllabusId: string; code: string; createdBy: number }) => {
      if (mem.links.has(row.syllabusId) || [...mem.links.values()].some((l) => l.code === row.code)) throw dup();
      mem.links.set(row.syllabusId, { ...row, active: true, createdAt: new Date(), updatedAt: new Date() });
    }),
    updateShareLink: vi.fn(async (syllabusId: string, patch: { code?: string; active?: boolean }) => {
      if (patch.code && [...mem.links.values()].some((l) => l.code === patch.code && l.syllabusId !== syllabusId)) throw dup();
      const row = mem.links.get(syllabusId);
      if (row) Object.assign(row, patch);
    }),
    listedGroupIds: vi.fn(async (syllabusId: string) => [...mem.listings].filter((k) => k.startsWith(`${syllabusId}|`)).map((k) => k.split("|")[1])),
    setListing: vi.fn(async (syllabusId: string, groupId: string, listed: boolean) => {
      if (listed) mem.listings.add(listingKey(syllabusId, groupId));
      else mem.listings.delete(listingKey(syllabusId, groupId));
    }),
    listingCandidates: vi.fn(async (ids: string[]) => ids.flatMap((id) => (mem.groups.has(id) ? [mem.groups.get(id)!] : []))),
    teacherOfWorkspace: vi.fn(async (workspaceId: string) =>
      workspaceId === "ws_teacher" ? { ownerUserId: 7, name: "Teacher A", avatarUrl: "https://img.example/a.png" } : { ownerUserId: 99, name: "Teacher B", avatarUrl: null },
    ),
    userName: vi.fn(async (id: number) => mem.users.get(id)?.name ?? null),
    groupName: vi.fn(async (id: string) => mem.groups.get(id)?.name ?? null),
    insertRequest: vi.fn(async (row: Req) => {
      if (row.openKey && mem.requests.some((r) => r.openKey === row.openKey)) throw dup();
      mem.requests.push({ decisionNote: null, decidedBy: null, decidedAt: null, createdAt: new Date(), ...row });
    }),
    requestById: vi.fn(async (id: string) => mem.requests.find((r) => r.id === id) ?? null),
    requestByOpenKey: vi.fn(async (key: string) => mem.requests.find((r) => r.openKey === key) ?? null),
    requestsOfStudentForSyllabus: vi.fn(async (syllabusId: string, studentId: number) => mem.requests.filter((r) => r.syllabusId === syllabusId && r.studentId === studentId).reverse()),
    closeRequest: vi.fn(async (id: string, patch: { status: Req["status"]; decidedBy: number | null; decisionNote: string | null }) => {
      const row = mem.requests.find((r) => r.id === id && r.status === "PENDING");
      if (!row) return false;
      Object.assign(row, patch, { openKey: null, decidedAt: new Date() });
      return true;
    }),
    reopenRequest: vi.fn(async (request: Req, openKey: string) => {
      const row = mem.requests.find((r) => r.id === request.id)!;
      Object.assign(row, { status: "PENDING", openKey, decidedBy: null, decidedAt: null, decisionNote: null });
    }),
    requestsOfSyllabus: vi.fn(async (syllabusId: string) =>
      mem.requests
        .filter((r) => r.syllabusId === syllabusId)
        .map((r) => ({
          ...r,
          groupName: r.groupId ? (mem.groups.get(r.groupId)?.name ?? null) : null,
          studentName: mem.users.get(r.studentId)?.name ?? null,
          studentEmail: mem.users.get(r.studentId)?.email ?? null,
          studentAvatarUrl: null,
        })),
    ),
    pendingCountsOfWorkspace: vi.fn(async (workspaceId: string) => {
      const counts = new Map<string, number>();
      for (const r of mem.requests) if (r.workspaceId === workspaceId && r.status === "PENDING") counts.set(r.syllabusId, (counts.get(r.syllabusId) ?? 0) + 1);
      return [...counts].map(([syllabusId, count]) => ({ syllabusId, count }));
    }),
    requestsOfStudent: vi.fn(async (studentId: number) =>
      mem.requests
        .filter((r) => r.studentId === studentId)
        .map((r) => ({
          id: r.id,
          type: r.type,
          status: r.status,
          groupName: r.groupId ? (mem.groups.get(r.groupId)?.name ?? null) : null,
          decisionNote: r.decisionNote,
          decidedAt: r.decidedAt,
          createdAt: r.createdAt,
          syllabusTitle: "Python",
          shareCode: mem.links.get(r.syllabusId)?.code ?? null,
          shareActive: mem.links.get(r.syllabusId)?.active ?? null,
        })),
    ),
  };
});

vi.mock("./modules/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/access")>()),
  resolveWorkspace: vi.fn(),
  resolveAccess: vi.fn(),
  platformRolesOf: vi.fn(async () => []),
}));
vi.mock("./modules/groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/groups")>()),
  activeGroupIdsOfStudent: vi.fn(async (userId: number) => mem.members.get(userId) ?? []),
  assertGroupOwner: vi.fn(async (scope: { workspaceId: string }, groupId: string) => {
    const g = mem.groups.get(groupId);
    if (!g || g.workspaceId !== scope.workspaceId) throw new AppError("NOT_FOUND");
    return { id: g.id, name: g.name, providerWorkspaceId: g.workspaceId };
  }),
  addMemberById: vi.fn(async (_scope: unknown, groupId: string, studentId: number) => {
    const list = mem.members.get(studentId) ?? [];
    if (list.includes(groupId)) throw new AppError("ALREADY_MEMBER");
    mem.members.set(studentId, [...list, groupId]);
    return { studentId, status: "ACTIVE" as const };
  }),
}));
vi.mock("./modules/taskNotify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/taskNotify")>()),
  notifyOpenTasksOnJoin: vi.fn(),
}));
vi.mock("./syllabus/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syllabus/notify")>()),
  announceGroupJoin: vi.fn(),
}));
vi.mock("./notifications/dispatcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notifications/dispatcher")>()),
  dispatch: vi.fn(),
  dispatchMany: vi.fn(),
}));
vi.mock("./syllabus/availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syllabus/availability")>()),
  syllabusEnabledFor: vi.fn(),
  assertSyllabusEnabled: vi.fn(),
}));
vi.mock("./syllabus/store", () => ({
  syllabusById: vi.fn(),
  versionById: vi.fn(),
  versionItems: vi.fn(async () => []),
  moduleDetailsOfVersion: vi.fn(async () => new Map()),
  timingOfVersion: vi.fn(async () => emptyTiming()),
  grantsForSyllabus: vi.fn(),
  grantsReachingStudent: vi.fn(async () => []),
  enrollmentOf: vi.fn(async () => null),
  enrollmentsOfStudent: vi.fn(async () => []),
  syllabiByIds: vi.fn(async () => []),
  progressVisibleToGroup: vi.fn(async () => true),
  groupById: vi.fn(async () => null),
  activeMembersWithNames: vi.fn(async () => []),
  enrollmentsOfStudents: vi.fn(async () => []),
  groupsByIds: vi.fn(async (ids: string[]) => ids.flatMap((id) => (mem.groups.has(id) ? [{ id, name: mem.groups.get(id)!.name, workspaceId: mem.groups.get(id)!.workspaceId }] : []))),
  completionOf: vi.fn(async () => null),
}));

const m = {
  access: vi.mocked(accessMod),
  groups: vi.mocked(groups),
  availability: vi.mocked(availability),
  store: vi.mocked(store),
  joinStore: vi.mocked(joinStore),
  dispatch: vi.mocked(dispatcher.dispatch),
  notifyTasks: vi.mocked(taskNotify.notifyOpenTasksOnJoin),
  announce: vi.mocked(notify.announceGroupJoin),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = 7;
const OTHER_TEACHER = 99;
const STUDENT = 21;
const STRANGER = 22;
/** 16:00 in Baku on 1 June. */
const NOW = new Date("2026-06-01T12:00:00Z");
const day = (iso: string) => new Date(iso);

const SYLLABUS = {
  id: "syl1",
  providerWorkspaceId: "ws_teacher",
  createdBy: OWNER,
  title: "Python",
  description: "draft description",
  status: "PUBLISHED",
  currentVersionId: "v1",
  archivedAt: null,
} as unknown as Syllabus;

const item = (id: string, kind: ItemStub["kind"], title: string, extra: Partial<ItemStub> = {}): ItemStub => ({
  id,
  kind,
  scope: "LESSON",
  title,
  position: 0,
  required: true,
  assessmentId: kind === "ASSESSMENT" ? "assess_secret" : null,
  assessmentVersionId: kind === "ASSESSMENT" ? "assessv_secret" : null,
  taskId: kind === "STUDENT_PRACTICE" ? "task_secret" : null,
  passPct: 70,
  retry: null,
  ...extra,
});

const STRUCTURE: VersionStructure = {
  formatVersion: 1,
  rules: resolveRules(),
  finalItems: [item("fin_a", "ASSESSMENT", "Final exam", { scope: "SYLLABUS" }), item("fin_p", "STUDENT_PRACTICE", "Capstone app", { scope: "SYLLABUS" })],
  modules: [
    {
      id: "mod_secret_1",
      title: "Basics",
      description: "SECRET module description",
      position: 1,
      estimatedMinutes: 120,
      objectives: [],
      prerequisitesText: "",
      rules: resolveRules(),
      items: [item("ma1", "ASSESSMENT", "Module 1 quiz", { scope: "MODULE" })],
      lessons: [
        {
          id: "les_secret_1",
          moduleId: "mod_secret_1",
          title: "Variables",
          description: "SECRET lesson body",
          position: 1,
          estimatedMinutes: 45,
          objectives: ["SECRET lesson objective"],
          rules: resolveRules(),
          items: [item("th1", "THEORY", "SECRET theory item"), item("sp1", "STUDENT_PRACTICE", "Calculator project")],
        },
        {
          id: "les_secret_2",
          moduleId: "mod_secret_1",
          title: "Loops",
          description: "SECRET lesson body 2",
          position: 2,
          estimatedMinutes: 45,
          objectives: [],
          rules: resolveRules(),
          items: [item("res1", "RESOURCE", "SECRET resource")],
        },
      ],
    },
  ],
};

const META = {
  title: "Python (published)",
  description: "Learn Python from scratch.",
  subject: "Programming",
  level: "Beginner",
  language: "az",
  estimatedDurationLabel: "3 months",
  estimatedHours: 36,
  coverFileId: "file_secret_cover",
};

function grant(over: Partial<SyllabusAccessGrant> = {}): SyllabusAccessGrant {
  return {
    id: `gr_${over.groupId ?? over.studentId ?? "x"}`,
    syllabusId: "syl1",
    groupId: null,
    studentId: null,
    status: "ACTIVE",
    startsAt: null,
    endsAt: null,
    note: "SECRET grant note",
    grantedBy: OWNER,
    grantedAt: day("2026-01-01T00:00:00Z"),
    revokedBy: null,
    revokedAt: null,
    ...over,
  };
}

const group = (id: string, startDate: Date | null, over: Partial<ListingCandidate> = {}): ListingCandidate => ({
  id,
  name: `Group ${id}`,
  workspaceId: "ws_teacher",
  startDate,
  classSchedule: [{ day: "MON", time: "18:00" }] as ListingCandidate["classSchedule"],
  scheduleVisible: true,
  format: "ONLINE",
  language: "az",
  ...over,
});

function seedGroups() {
  const all = [
    group("soon", day("2026-06-10T10:00:00Z")),
    group("today", day("2026-05-31T21:00:00Z")),
    group("past", day("2026-05-31T19:00:00Z")),
    group("far", day("2026-09-15T10:00:00Z")),
    group("unlisted", day("2026-06-12T10:00:00Z")),
    group("revoked", day("2026-06-12T10:00:00Z")),
    group("foreign", day("2026-06-12T10:00:00Z"), { workspaceId: "ws_other" }),
    group("nostart", null),
    group("hidden", day("2026-06-20T10:00:00Z"), { scheduleVisible: false }),
  ];
  for (const g of all) mem.groups.set(g.id, g);
  for (const id of ["soon", "today", "past", "far", "revoked", "foreign", "nostart", "hidden"]) mem.listings.add(`syl1|${id}`);
}

const GRANTS = [
  grant({ groupId: "soon" }),
  grant({ groupId: "today" }),
  grant({ groupId: "past" }),
  grant({ groupId: "far" }),
  grant({ groupId: "unlisted" }),
  grant({ groupId: "revoked", status: "REVOKED" }),
  grant({ groupId: "foreign" }),
  grant({ groupId: "nostart" }),
  grant({ groupId: "hidden", startsAt: day("2026-07-01T00:00:00Z") }),
  grant({ groupId: "current" }),
];

function user(id: number): User {
  return { id, openId: `google:${id}`, name: `User ${id}`, email: `u${id}@example.com`, accountStatus: "ACTIVE", sessionsValidAfter: null } as unknown as User;
}

function caller(u: User | null) {
  const ctx: TrpcContext = {
    user: u,
    session: null,
    req: { ip: "10.0.0.9", protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
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

const teacher = () => caller(user(OWNER)).teacher.syllabus;
const otherTeacher = () => caller(user(OTHER_TEACHER)).teacher.syllabus;

async function sharedCode() {
  return (await teacher().ensureShareLink({ id: "syl1" })).code;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetRateLimits();
  mem.links.clear();
  mem.listings.clear();
  mem.requests.length = 0;
  mem.groups.clear();
  mem.members.clear();
  mem.users.clear();
  for (const id of [OWNER, OTHER_TEACHER, STUDENT, STRANGER]) mem.users.set(id, { name: `User ${id}`, email: `u${id}@example.com` });
  mem.members.set(STUDENT, ["current"]);
  seedGroups();
  m.access.resolveWorkspace.mockImplementation(async (userId: number) =>
    userId === OWNER ? ({ id: "ws_teacher", ownerUserId: OWNER } as never) : userId === OTHER_TEACHER ? ({ id: "ws_other", ownerUserId: OTHER_TEACHER } as never) : null,
  );
  m.availability.syllabusEnabledFor.mockResolvedValue(true);
  m.availability.assertSyllabusEnabled.mockResolvedValue(undefined);
  m.store.syllabusById.mockImplementation(async (id: string) => (id === "syl1" ? SYLLABUS : null));
  m.store.versionById.mockResolvedValue({ version: { id: "v1", status: "PUBLISHED", meta: META } as never, structure: STRUCTURE });
  m.store.grantsForSyllabus.mockResolvedValue(GRANTS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe("share codes", () => {
  it("accepts only well-formed codes, case-insensitively", () => {
    expect(normalizeShareCode(" abcdefghjkmn ")).toBe("ABCDEFGHJKMN");
    expect(normalizeShareCode("ABCDEFGHJKM")).toBeNull();
    expect(normalizeShareCode("ABCDEFGHJKMNP")).toBeNull();
    expect(normalizeShareCode("ABCDEFGHJKM0")).toBeNull();
    expect(normalizeShareCode("ABCDEFGHJK'1")).toBeNull();
  });

  it("is shareable only when published and not archived", () => {
    expect(isShareable({ currentVersionId: "v1", status: "PUBLISHED", archivedAt: null })).toBe(true);
    expect(isShareable({ currentVersionId: null, status: "DRAFT", archivedAt: null })).toBe(false);
    expect(isShareable({ currentVersionId: "v1", status: "ARCHIVED", archivedAt: new Date() })).toBe(false);
  });
});

describe("upcoming groups", () => {
  it("starts the window at midnight in Baku", () => {
    expect(startOfBakuDay(NOW).toISOString()).toBe("2026-05-31T20:00:00.000Z");
    expect(startOfBakuDay(day("2026-05-31T20:30:00Z")).toISOString()).toBe("2026-05-31T20:00:00.000Z");
  });

  it("keeps listed, granted groups of the workspace that start today..+90 days", () => {
    const candidates = [...mem.groups.values()];
    const listed = [...mem.listings].map((k) => k.split("|")[1]);
    const picked = selectUpcomingGroups({ workspaceId: "ws_teacher", candidates, listedGroupIds: listed, grants: GRANTS, now: NOW });
    expect(picked.map((g) => g.id)).toEqual(["today", "soon", "hidden"]);
    expect(picked.find((g) => g.id === "hidden")!.classSchedule).toEqual([]);
    expect(picked.find((g) => g.id === "soon")!.classSchedule).toEqual([{ day: "MON", time: "18:00" }]);
    expect(Object.keys(picked[0]).sort()).toEqual(["classSchedule", "format", "id", "language", "name", "startDate"]);
  });

  it("drops a group whose grant has expired", () => {
    const grants = [grant({ groupId: "soon", endsAt: day("2026-05-30T00:00:00Z") })];
    expect(selectUpcomingGroups({ workspaceId: "ws_teacher", candidates: [mem.groups.get("soon")!], listedGroupIds: ["soon"], grants, now: NOW })).toEqual([]);
  });
});

describe("public syllabus view whitelist", () => {
  const details = new Map([["mod_secret_1", { ...emptyModuleDetails(), objectives: ["Write small programs"] }]]);
  const view = publicSyllabusView({ meta: META, structure: STRUCTURE, details, timing: emptyTiming(), teacher: { name: "Teacher A", avatarUrl: null } });

  it("carries the outline: titles, lesson names, projects, assessments and end-of-module blocks", () => {
    expect(view.title).toBe("Python (published)");
    expect(view.modules[0].lessons).toEqual([
      { title: "Variables", projects: ["Calculator project"] },
      { title: "Loops", projects: [] },
    ]);
    expect(view.modules[0].assessments).toEqual(["Module 1 quiz"]);
    expect(view.modules[0].details?.objectives).toEqual(["Write small programs"]);
    expect(view.finalProjects).toEqual(["Capstone app"]);
    expect(view.finalAssessments).toEqual(["Final exam"]);
    expect(view.lessonCount).toBe(2);
  });

  it("never carries ids, descriptions of modules or lessons, item content, files or rules", () => {
    const json = JSON.stringify(view);
    for (const leak of ["SECRET", "_secret", "file_secret_cover", "passPct", "rules", "th1", "sp1", "ma1", "fin_a", "draft description"]) expect(json).not.toContain(leak);
  });
});

describe("request rules", () => {
  const base = { isOwner: false, hasAccess: false, upcomingGroupIds: ["soon"], memberGroupIds: [] as string[] };
  it("GROUP needs one of the upcoming groups the student is not in yet", () => {
    expect(joinRequestRejection({ ...base, type: "GROUP", groupId: "soon" })).toBeNull();
    expect(joinRequestRejection({ ...base, type: "GROUP", groupId: "far" })).toBe("JOIN_REQUEST_GROUP_UNAVAILABLE");
    expect(joinRequestRejection({ ...base, type: "GROUP", groupId: null })).toBe("JOIN_REQUEST_GROUP_UNAVAILABLE");
    expect(joinRequestRejection({ ...base, type: "GROUP", groupId: "soon", memberGroupIds: ["soon"] })).toBe("ALREADY_MEMBER");
  });
  it("INDIVIDUAL only while no group is upcoming and the student has no access yet", () => {
    expect(joinRequestRejection({ ...base, type: "INDIVIDUAL", groupId: null })).toBe("JOIN_REQUEST_GROUP_AVAILABLE");
    expect(joinRequestRejection({ ...base, upcomingGroupIds: [], type: "INDIVIDUAL", groupId: null })).toBeNull();
    expect(joinRequestRejection({ ...base, upcomingGroupIds: [], hasAccess: true, type: "INDIVIDUAL", groupId: null })).toBe("SYLLABUS_ALREADY_HAS_ACCESS");
  });
  it("the owner can never request", () => {
    expect(joinRequestRejection({ ...base, isOwner: true, type: "GROUP", groupId: "soon" })).toBe("SYLLABUS_OWN_REQUEST");
  });
  it("one open key per student, syllabus, type and group", () => {
    expect(openKeyOf({ syllabusId: "s", studentId: 1, type: "GROUP", groupId: "g" })).toBe("s:1:GROUP:g");
    expect(openKeyOf({ syllabusId: "s", studentId: 1, type: "INDIVIDUAL", groupId: null })).toBe("s:1:INDIVIDUAL:");
  });
});

// ---------------------------------------------------------------------------
// Teacher: share link
// ---------------------------------------------------------------------------

describe("share link lifecycle", () => {
  it("is created on first copy, then reused", async () => {
    expect((await teacher().shareLink({ id: "syl1" })).link).toBeNull();
    const first = await teacher().ensureShareLink({ id: "syl1" });
    expect(first.active).toBe(true);
    expect(first.code).toHaveLength(SHARE_CODE_LENGTH);
    expect(normalizeShareCode(first.code)).toBe(first.code);
    expect((await teacher().ensureShareLink({ id: "syl1" })).code).toBe(first.code);
    expect(m.joinStore.insertShareLink).toHaveBeenCalledTimes(1);
  });

  it("retries a colliding code", async () => {
    m.joinStore.insertShareLink.mockRejectedValueOnce(dup());
    const link = await teacher().ensureShareLink({ id: "syl1" });
    expect(m.joinStore.insertShareLink).toHaveBeenCalledTimes(2);
    expect(mem.links.get("syl1")?.code).toBe(link.code);
  });

  it("regenerating kills the old link; turning off makes the page 404 and on brings the same code back", async () => {
    const old = await sharedCode();
    const fresh = await teacher().regenerateShareLink({ id: "syl1" });
    expect(fresh.code).not.toBe(old);
    expect(await codeOf(caller(null).public.syllabus({ code: old }))).toBe("NOT_FOUND:NOT_FOUND");
    expect((await caller(null).public.syllabus({ code: fresh.code })).syllabus.title).toBe("Python (published)");

    await teacher().setShareLinkActive({ id: "syl1", active: false });
    expect(await codeOf(caller(null).public.syllabus({ code: fresh.code }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await teacher().ensureShareLink({ id: "syl1" })).toEqual({ code: fresh.code, active: false });

    await teacher().setShareLinkActive({ id: "syl1", active: true });
    expect((await caller(null).public.syllabus({ code: fresh.code.toLowerCase() })).code).toBe(fresh.code);
  });

  it("needs a published, not archived syllabus", async () => {
    m.store.syllabusById.mockResolvedValue({ ...SYLLABUS, currentVersionId: null, status: "DRAFT" } as Syllabus);
    expect(await codeOf(teacher().ensureShareLink({ id: "syl1" }))).toBe("PRECONDITION_FAILED:SYLLABUS_NOT_PUBLISHED");
    expect((await teacher().shareLink({ id: "syl1" })).shareable).toBe(false);
    m.store.syllabusById.mockResolvedValue({ ...SYLLABUS, status: "ARCHIVED", archivedAt: new Date() } as Syllabus);
    expect(await codeOf(teacher().ensureShareLink({ id: "syl1" }))).toBe("PRECONDITION_FAILED:SYLLABUS_ARCHIVED");
    expect(await codeOf(teacher().regenerateShareLink({ id: "syl1" }))).toBe("PRECONDITION_FAILED:SYLLABUS_ARCHIVED");
  });

  it("belongs to the owner's workspace only", async () => {
    await sharedCode();
    for (const call of [
      otherTeacher().shareLink({ id: "syl1" }),
      otherTeacher().ensureShareLink({ id: "syl1" }),
      otherTeacher().regenerateShareLink({ id: "syl1" }),
      otherTeacher().setShareLinkActive({ id: "syl1", active: false }),
      otherTeacher().groupListings({ id: "syl1" }),
      otherTeacher().setGroupListed({ id: "syl1", groupId: "soon", listed: false }),
      otherTeacher().joinRequests({ id: "syl1" }),
    ]) {
      expect(await codeOf(call)).toBe("NOT_FOUND:NOT_FOUND");
    }
    expect(mem.links.get("syl1")?.active).toBe(true);
    expect(await codeOf(caller(user(STUDENT)).teacher.syllabus.ensureShareLink({ id: "syl1" }))).toBe("FORBIDDEN:NO_WORKSPACE");
  });

  it("is behind the syllabus feature flag for the teacher", async () => {
    m.availability.assertSyllabusEnabled.mockRejectedValue(new AppError("SYLLABUS_NOT_AVAILABLE"));
    expect(await codeOf(teacher().ensureShareLink({ id: "syl1" }))).toBe("FORBIDDEN:SYLLABUS_NOT_AVAILABLE");
  });
});

describe("group listing opt-in", () => {
  it("lists the syllabus' granted groups with their upcoming state, and only granted groups can be listed", async () => {
    const rows = await teacher().groupListings({ id: "syl1" });
    const byId = new Map(rows.map((r) => [r.groupId, r]));
    expect(byId.has("revoked")).toBe(false);
    expect(byId.has("foreign")).toBe(false);
    expect(byId.get("soon")).toMatchObject({ listed: true, upcoming: true });
    expect(byId.get("unlisted")).toMatchObject({ listed: false, upcoming: true });
    expect(byId.get("far")).toMatchObject({ listed: true, upcoming: false });

    await teacher().setGroupListed({ id: "syl1", groupId: "unlisted", listed: true });
    expect(mem.listings.has("syl1|unlisted")).toBe(true);
    expect(await codeOf(teacher().setGroupListed({ id: "syl1", groupId: "revoked", listed: true }))).toBe("BAD_REQUEST:SYLLABUS_INVALID_TARGET");
    expect(await codeOf(teacher().setGroupListed({ id: "syl1", groupId: "foreign", listed: true }))).toBe("NOT_FOUND:NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Public page
// ---------------------------------------------------------------------------

describe("public page", () => {
  it("shows the published outline and only this syllabus' upcoming groups to anyone", async () => {
    const code = await sharedCode();
    const page = await caller(null).public.syllabus({ code });
    expect(page.viewer).toBeNull();
    expect(page.syllabus.teacher).toEqual({ name: "Teacher A", avatarUrl: "https://img.example/a.png" });
    expect(page.groups.map((g) => g.id)).toEqual(["today", "soon", "hidden"]);
    const json = JSON.stringify(page);
    for (const leak of ["SECRET", "_secret", "syl1", "v1\"", "ws_teacher", "current", "Group far", "Group unlisted", "Group revoked", "Group foreign", "u21@", "ownerUserId", "grantedBy"]) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it("answers 404 for unknown, malformed, unpublished, archived, flag-off or not-migrated", async () => {
    const code = await sharedCode();
    const pub = () => caller(null).public.syllabus({ code });
    expect(await codeOf(caller(null).public.syllabus({ code: "ZZZZZZZZZZZZ" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(caller(null).public.syllabus({ code: "../../etc" }))).toBe("NOT_FOUND:NOT_FOUND");

    m.store.syllabusById.mockResolvedValueOnce({ ...SYLLABUS, currentVersionId: null } as Syllabus);
    expect(await codeOf(pub())).toBe("NOT_FOUND:NOT_FOUND");
    m.store.syllabusById.mockResolvedValueOnce({ ...SYLLABUS, status: "ARCHIVED", archivedAt: new Date() } as Syllabus);
    expect(await codeOf(pub())).toBe("NOT_FOUND:NOT_FOUND");
    m.availability.syllabusEnabledFor.mockResolvedValueOnce(false);
    expect(await codeOf(pub())).toBe("NOT_FOUND:NOT_FOUND");
    m.joinStore.shareLinkByCode.mockRejectedValueOnce(Object.assign(new Error("no table"), { errno: 1146 }));
    expect(await codeOf(pub())).toBe("NOT_FOUND:NOT_FOUND");
    expect((await pub()).code).toBe(code);
  });

  it("rate-limits misses per visitor", async () => {
    let last = "";
    for (let i = 0; i < 31; i++) last = await codeOf(caller(null).public.syllabus({ code: "ZZZZZZZZZZZZ" }));
    expect(last).toBe("TOO_MANY_REQUESTS:RATE_LIMITED");
  });

  it("tells a signed-in visitor only about themselves", async () => {
    const code = await sharedCode();
    const owner = (await caller(user(OWNER)).public.syllabus({ code })).viewer!;
    expect(owner).toMatchObject({ isOwner: true, hasAccess: false, requests: [], syllabusId: "syl1" });

    const stranger = (await caller(user(STRANGER)).public.syllabus({ code })).viewer!;
    expect(stranger).toMatchObject({ isOwner: false, hasAccess: false, memberGroupIds: [], syllabusId: null });

    // STUDENT is in "current", which holds a live grant (not listed, not upcoming).
    const student = (await caller(user(STUDENT)).public.syllabus({ code })).viewer!;
    expect(student).toMatchObject({ isOwner: false, hasAccess: true, memberGroupIds: [], syllabusId: "syl1" });
  });
});

// ---------------------------------------------------------------------------
// Student requests
// ---------------------------------------------------------------------------

describe("join requests", () => {
  it("a GROUP request for an upcoming group is stored once and notifies the teacher once", async () => {
    const code = await sharedCode();
    const s = caller(user(STRANGER)).student.syllabus;
    const first = await s.joinRequest({ code, type: "GROUP", groupId: "soon", message: "  Evenings suit me  " });
    expect(first).toMatchObject({ status: "PENDING", created: true });
    const again = await s.joinRequest({ code, type: "GROUP", groupId: "soon", message: "again" });
    expect(again).toEqual({ id: first.id, status: "PENDING", created: false });
    expect(mem.requests).toHaveLength(1);
    expect(mem.requests[0]).toMatchObject({ syllabusId: "syl1", workspaceId: "ws_teacher", studentId: STRANGER, type: "GROUP", groupId: "soon", message: "Evenings suit me" });
    expect(m.dispatch).toHaveBeenCalledTimes(1);
    expect(m.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ event: "SYLLABUS_JOIN_REQUESTED", userId: OWNER, dedupeKey: `syl-join-req:${first.id}`, data: expect.objectContaining({ groupName: "Group soon", syllabusTitle: "Python" }) }),
    );
    const viewer = (await caller(user(STRANGER)).public.syllabus({ code })).viewer!;
    expect(viewer.requests.map((r) => [r.type, r.status, r.groupName])).toEqual([["GROUP", "PENDING", "Group soon"]]);
  });

  it("a racing duplicate insert returns the stored request", async () => {
    const code = await sharedCode();
    m.joinStore.requestByOpenKey.mockResolvedValueOnce(null);
    const s = caller(user(STRANGER)).student.syllabus;
    const first = await s.joinRequest({ code, type: "GROUP", groupId: "soon", message: "" });
    m.joinStore.requestByOpenKey.mockResolvedValueOnce(null);
    expect(await s.joinRequest({ code, type: "GROUP", groupId: "soon", message: "" })).toEqual({ id: first.id, status: "PENDING", created: false });
    expect(mem.requests).toHaveLength(1);
  });

  it("GROUP needs a group the page offers right now", async () => {
    const code = await sharedCode();
    const s = caller(user(STRANGER)).student.syllabus;
    for (const groupId of ["far", "past", "unlisted", "revoked", "foreign", "nostart", "current", "nope"]) {
      expect(await codeOf(s.joinRequest({ code, type: "GROUP", groupId, message: "" })), groupId).toBe("PRECONDITION_FAILED:JOIN_REQUEST_GROUP_UNAVAILABLE");
    }
    expect(await codeOf(s.joinRequest({ code, type: "GROUP", message: "" }))).toBe("PRECONDITION_FAILED:JOIN_REQUEST_GROUP_UNAVAILABLE");
    mem.members.set(STRANGER, ["soon"]);
    expect(await codeOf(s.joinRequest({ code, type: "GROUP", groupId: "soon", message: "" }))).toBe("CONFLICT:ALREADY_MEMBER");
    expect(mem.requests).toHaveLength(0);
  });

  it("INDIVIDUAL only when no group is upcoming", async () => {
    const code = await sharedCode();
    const s = caller(user(STRANGER)).student.syllabus;
    expect(await codeOf(s.joinRequest({ code, type: "INDIVIDUAL", message: "" }))).toBe("PRECONDITION_FAILED:JOIN_REQUEST_GROUP_AVAILABLE");
    mem.listings.clear();
    const page = await caller(user(STRANGER)).public.syllabus({ code });
    expect(page.groups).toEqual([]);
    expect(await s.joinRequest({ code, type: "INDIVIDUAL", message: "1:1 please" })).toMatchObject({ created: true });
    expect(await codeOf(caller(user(STUDENT)).student.syllabus.joinRequest({ code, type: "INDIVIDUAL", message: "" }))).toBe("CONFLICT:SYLLABUS_ALREADY_HAS_ACCESS");
  });

  it("the owner cannot request, a visitor must sign in, and the message is bounded", async () => {
    const code = await sharedCode();
    expect(await codeOf(caller(user(OWNER)).student.syllabus.joinRequest({ code, type: "GROUP", groupId: "soon", message: "" }))).toBe("FORBIDDEN:SYLLABUS_OWN_REQUEST");
    expect(await codeOf(caller(null).student.syllabus.joinRequest({ code, type: "GROUP", groupId: "soon", message: "" }))).toMatch(/^UNAUTHORIZED/);
    expect(await codeOf(caller(user(STRANGER)).student.syllabus.joinRequest({ code, type: "GROUP", groupId: "soon", message: "x".repeat(1001) }))).toMatch(/^BAD_REQUEST/);
    await teacher().setShareLinkActive({ id: "syl1", active: false });
    expect(await codeOf(caller(user(STRANGER)).student.syllabus.joinRequest({ code, type: "GROUP", groupId: "soon", message: "" }))).toBe("NOT_FOUND:NOT_FOUND");
  });

  it("the student can withdraw their own pending request, then ask again", async () => {
    const code = await sharedCode();
    const s = caller(user(STRANGER)).student.syllabus;
    const { id } = await s.joinRequest({ code, type: "GROUP", groupId: "soon", message: "" });
    expect(await codeOf(caller(user(STUDENT)).student.syllabus.cancelJoinRequest({ requestId: id }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await s.cancelJoinRequest({ requestId: id })).toEqual({ id, status: "CANCELLED" });
    expect(await codeOf(s.cancelJoinRequest({ requestId: id }))).toBe("CONFLICT:JOIN_REQUEST_NOT_PENDING");
    const again = await s.joinRequest({ code, type: "GROUP", groupId: "soon", message: "" });
    expect(again.created).toBe(true);
    expect(again.id).not.toBe(id);
    expect((await s.myJoinRequests()).map((r) => r.status).sort()).toEqual(["CANCELLED", "PENDING"]);
  });
});

// ---------------------------------------------------------------------------
// Teacher decisions
// ---------------------------------------------------------------------------

describe("accepting and rejecting", () => {
  async function requestAs(studentId: number, type: "GROUP" | "INDIVIDUAL", groupId?: string) {
    const code = mem.links.get("syl1")?.code ?? (await sharedCode());
    if (type === "INDIVIDUAL") mem.listings.clear();
    const res = await caller(user(studentId)).student.syllabus.joinRequest({ code, type, groupId, message: "hi" });
    m.dispatch.mockClear();
    return res.id;
  }

  it("accepting a GROUP request adds the student like 'add student' does and tells them", async () => {
    const id = await requestAs(STRANGER, "GROUP", "soon");
    expect((await teacher().joinRequestCounts()).find((c) => c.syllabusId === "syl1")?.count).toBe(1);
    expect(await teacher().decideJoinRequest({ requestId: id, decision: "ACCEPTED", note: "Welcome" })).toEqual({ id, status: "ACCEPTED" });
    expect(m.groups.addMemberById).toHaveBeenCalledWith({ workspaceId: "ws_teacher", userId: OWNER }, "soon", STRANGER);
    expect(m.notifyTasks).toHaveBeenCalledWith("soon", STRANGER);
    expect(m.announce).toHaveBeenCalledWith("soon", STRANGER);
    expect(mem.members.get(STRANGER)).toEqual(["soon"]);
    expect(mem.requests[0]).toMatchObject({ status: "ACCEPTED", decidedBy: OWNER, decisionNote: "Welcome", openKey: null });
    expect(m.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ event: "SYLLABUS_JOIN_DECIDED", userId: STRANGER, dedupeKey: `syl-join-decided:${id}`, data: expect.objectContaining({ decision: "ACCEPTED", groupName: "Group soon", path: "/student/groups" }) }),
    );
    expect(await teacher().joinRequestCounts()).toEqual([]);
    expect(await codeOf(teacher().decideJoinRequest({ requestId: id, decision: "REJECTED" }))).toBe("CONFLICT:JOIN_REQUEST_NOT_PENDING");
  });

  it("an already-member student is just marked accepted, without join notices", async () => {
    const id = await requestAs(STRANGER, "GROUP", "soon");
    mem.members.set(STRANGER, ["soon"]);
    expect((await teacher().decideJoinRequest({ requestId: id, decision: "ACCEPTED" })).status).toBe("ACCEPTED");
    expect(m.notifyTasks).not.toHaveBeenCalled();
    expect(m.announce).not.toHaveBeenCalled();
  });

  it("a failed membership leaves the request pending", async () => {
    const id = await requestAs(STRANGER, "GROUP", "soon");
    m.groups.addMemberById.mockRejectedValueOnce(new AppError("STUDENT_NOT_FOUND"));
    expect(await codeOf(teacher().decideJoinRequest({ requestId: id, decision: "ACCEPTED" }))).toBe("NOT_FOUND:STUDENT_NOT_FOUND");
    expect(mem.requests[0]).toMatchObject({ status: "PENDING", decidedBy: null });
    expect(mem.requests[0].openKey).toBe(openKeyOf(mem.requests[0]));
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("accepting an INDIVIDUAL request records the decision and opens nothing", async () => {
    const id = await requestAs(STRANGER, "INDIVIDUAL");
    await teacher().decideJoinRequest({ requestId: id, decision: "ACCEPTED" });
    expect(m.groups.addMemberById).not.toHaveBeenCalled();
    expect(mem.requests[0].status).toBe("ACCEPTED");
    expect(m.dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: "SYLLABUS_JOIN_DECIDED", data: expect.objectContaining({ groupName: null, path: `/syllabus/${mem.links.get("syl1")!.code}` }) }));
    expect(await codeOf(assertStudentAccess(STRANGER, "syl1"))).toBe("NOT_FOUND");
  });

  it("rejecting keeps an optional reason and lets the student ask again", async () => {
    const id = await requestAs(STRANGER, "GROUP", "soon");
    await teacher().decideJoinRequest({ requestId: id, decision: "REJECTED", note: "  Group is full  " });
    expect(mem.requests[0]).toMatchObject({ status: "REJECTED", decisionNote: "Group is full" });
    expect(m.groups.addMemberById).not.toHaveBeenCalled();
    expect(m.dispatch).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ decision: "REJECTED", note: "Group is full" }) }));
    const code = mem.links.get("syl1")!.code;
    expect((await caller(user(STRANGER)).student.syllabus.joinRequest({ code, type: "GROUP", groupId: "soon", message: "" })).created).toBe(true);
  });

  it("only the owning workspace sees or decides a request", async () => {
    const id = await requestAs(STRANGER, "GROUP", "soon");
    expect(await codeOf(otherTeacher().decideJoinRequest({ requestId: id, decision: "ACCEPTED" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await otherTeacher().joinRequestCounts()).toEqual([]);
    expect(await codeOf(caller(user(STRANGER)).teacher.syllabus.decideJoinRequest({ requestId: id, decision: "ACCEPTED" }))).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(await codeOf(caller(user(STRANGER)).teacher.syllabus.joinRequests({ id: "syl1" }))).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(mem.requests[0].status).toBe("PENDING");
    const rows = await teacher().joinRequests({ id: "syl1" });
    expect(rows.map((r) => [r.studentEmail, r.groupName, r.message])).toEqual([["u22@example.com", "Group soon", "hi"]]);
  });
});

// ---------------------------------------------------------------------------
// The link opens no content
// ---------------------------------------------------------------------------

describe("no access through the link", () => {
  it("a visitor with a pending request still cannot open the syllabus or its lessons", async () => {
    const code = await sharedCode();
    await caller(user(STRANGER)).student.syllabus.joinRequest({ code, type: "GROUP", groupId: "soon", message: "" });
    expect(await codeOf(assertStudentAccess(STRANGER, "syl1"))).toBe("NOT_FOUND");
    const s = caller(user(STRANGER)).student.syllabus;
    expect(await codeOf(s.path({ id: "syl1" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await codeOf(s.lesson({ id: "syl1", lessonId: "les_secret_1" }))).toBe("NOT_FOUND:NOT_FOUND");
  });

  it("the decision notice renders in every language", () => {
    for (const locale of ["az", "en", "ru"] as const) {
      const accepted = renderNotification("SYLLABUS_JOIN_DECIDED", { requestId: "r", syllabusTitle: "Python", decision: "ACCEPTED", groupName: "A", note: null, path: "/student/groups" }, { locale, email: null }, "");
      const requested = renderNotification("SYLLABUS_JOIN_REQUESTED", { requestId: "r", syllabusId: "s", syllabusTitle: "Python", studentName: null, groupName: null }, { locale, email: null }, "");
      expect(accepted.path).toBe("/student/groups");
      expect(requested.path).toBe("/teacher/syllabus/s?tab=requests");
      for (const text of [accepted.title, accepted.body, requested.title, requested.body]) expect(text).not.toMatch(/Å|Ã|Ä/);
    }
  });
});
