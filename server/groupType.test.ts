import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { levelChoiceOf, typeDraftOf, typeFieldKeys, typePayload } from "../client/src/lib/groupForm";
import { groupFacts, groupFactsLine } from "../client/src/lib/format";
import type { User } from "../drizzle/schema";
import {
  classifyLegacyGroup,
  defaultGroupType,
  groupFieldsForType,
  levelKeyOf,
  looksLikeCourseLevel,
  looksLikeSchoolClass,
  normalizeLevel,
  subjectHint,
  workspaceGroupType,
} from "../shared/groupType";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import * as accessMod from "./modules/access";
import { planProfileBackfill, profileView } from "./modules/groupProfiles";
import * as groupsMod from "./modules/groups";
import { typeFieldsOf } from "./modules/groups";
import { appRouter } from "./routers";

vi.mock("./modules/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/access")>()),
  resolveWorkspace: vi.fn(),
}));
vi.mock("./modules/groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/groups")>()),
  createGroup: vi.fn(async () => ({ id: "g1" })),
  renameGroup: vi.fn(async () => ({ id: "g1" })),
}));

describe("legacy classification: the old combined 'Sinif / səviyyə' value", () => {
  it.each(["9A", "11 B", "10", "9-a", "5-ci sinif", "11-ci", "9-11", "IX", "XI b", "8 класс", "Grade 7", "7th grade", "orta məktəb", "Middle school"])(
    "%s → school class, value kept as Sinif",
    (grade) => {
      expect(classifyLegacyGroup({ subject: "", grade })).toEqual({ groupType: "SCHOOL", grade, level: "", reason: "CLASS_PATTERN" });
    },
  );

  it.each([
    ["Beginner", "BEGINNER"],
    ["orta", "INTERMEDIATE"],
    ["Orta səviyyə", "INTERMEDIATE"],
    ["Advanced", "ADVANCED"],
    ["İrəli", "ADVANCED"],
    ["Başlanğıc", "BEGINNER"],
    ["Начальный уровень", "BEGINNER"],
    ["Peşəkar", "PROFESSIONAL"],
  ])("%s → course, recognised level %s", (grade, level) => {
    expect(classifyLegacyGroup({ subject: "", grade })).toEqual({ groupType: "COURSE", grade: "", level, reason: "LEVEL_PATTERN" });
  });

  it.each(["B2", "A1-A2", "C1+", "Upper-Intermediate", "Junior", "Level 2", "1-ci səviyyə", "Elementary"])("%s → course, level kept as typed", (grade) => {
    expect(classifyLegacyGroup({ subject: "", grade })).toEqual({ groupType: "COURSE", grade: "", level: grade, reason: "LEVEL_PATTERN" });
  });

  it("does not take numbers outside 1–12 or CEFR codes for classes", () => {
    expect(looksLikeSchoolClass("13")).toBe(false);
    expect(looksLikeSchoolClass("A1")).toBe(false);
    expect(looksLikeSchoolClass("Level 9")).toBe(false);
    expect(looksLikeCourseLevel("9A")).toBe(false);
  });

  it("never drops an unrecognised value: it goes to the second field of the inferred type", () => {
    expect(classifyLegacyGroup({ subject: "Riyaziyyat", grade: "Abituriyent" })).toEqual({ groupType: "SCHOOL", grade: "Abituriyent", level: "", reason: "SUBJECT_HINT" });
    expect(classifyLegacyGroup({ subject: "AI Engineering", grade: "Qrup 3" })).toEqual({ groupType: "COURSE", grade: "", level: "Qrup 3", reason: "SUBJECT_HINT" });
    expect(classifyLegacyGroup({ subject: "", grade: "Qrup 3", teachingCategory: "SCHOOL" })).toMatchObject({ groupType: "SCHOOL", grade: "Qrup 3", reason: "WORKSPACE" });
    expect(classifyLegacyGroup({ subject: "", grade: "Qrup 3", teachingCategory: "OTHER" })).toEqual({ groupType: "COURSE", grade: "", level: "Qrup 3", reason: "DEFAULT" });
  });

  it("uses the subject, then the workspace, for groups with no value at all", () => {
    expect(classifyLegacyGroup({ subject: "İnformatika", grade: "" })).toMatchObject({ groupType: "SCHOOL", reason: "SUBJECT_HINT" });
    expect(classifyLegacyGroup({ subject: "Java", grade: "" })).toMatchObject({ groupType: "COURSE", reason: "SUBJECT_HINT" });
    expect(classifyLegacyGroup({ subject: "Ümumi", grade: "", teachingCategory: "UNIVERSITY_PREP" })).toMatchObject({ groupType: "SCHOOL", reason: "WORKSPACE" });
    expect(classifyLegacyGroup({ subject: "Ümumi", grade: "", providerType: "SCHOOL" })).toMatchObject({ groupType: "SCHOOL", reason: "WORKSPACE" });
    expect(classifyLegacyGroup({ subject: "", grade: "" })).toEqual({ groupType: "COURSE", grade: "", level: "", reason: "DEFAULT" });
  });

  it("the class/level value outranks the subject and workspace", () => {
    expect(classifyLegacyGroup({ subject: "Python", grade: "9A", teachingCategory: "IT" }).groupType).toBe("SCHOOL");
    expect(classifyLegacyGroup({ subject: "Riyaziyyat", grade: "Advanced", teachingCategory: "SCHOOL" }).groupType).toBe("COURSE");
  });

  it("subject hints stay silent when ambiguous", () => {
    expect(subjectHint("Python (İnformatika)")).toBeNull();
    expect(subjectHint("İngilis dili")).toBeNull();
    expect(subjectHint("UI/UX dizayn")).toBe("COURSE");
  });
});

describe("levels", () => {
  it("stores known levels as keys from any language or spelling, and anything else as typed", () => {
    expect(levelKeyOf("intermediate")).toBe("INTERMEDIATE");
    expect(levelKeyOf("ireli")).toBe("ADVANCED");
    expect(levelKeyOf("PROFESSIONAL")).toBe("PROFESSIONAL");
    expect(levelKeyOf("Pre-Intermediate")).toBeNull();
    expect(normalizeLevel("  Orta  ")).toBe("INTERMEDIATE");
    expect(normalizeLevel(" B2 ")).toBe("B2");
    expect(normalizeLevel("x".repeat(80))).toHaveLength(64);
  });
});

describe("new group default type", () => {
  it("follows the latest group, then the workspace category, then COURSE", () => {
    expect(defaultGroupType({ latestGroupType: "SCHOOL", teachingCategory: "IT" })).toBe("SCHOOL");
    expect(defaultGroupType({ latestGroupType: null, teachingCategory: "SCHOOL" })).toBe("SCHOOL");
    expect(defaultGroupType({ teachingCategory: "GRADUATION_EXAM" })).toBe("SCHOOL");
    expect(defaultGroupType({ teachingCategory: "IT" })).toBe("COURSE");
    expect(defaultGroupType({ teachingCategory: "OTHER" })).toBe("COURSE");
    expect(defaultGroupType({})).toBe("COURSE");
    expect(workspaceGroupType({ teachingCategory: "OTHER", providerType: "SCHOOL" })).toBe("SCHOOL");
  });
});

describe("stored fields per type", () => {
  it("a school class keeps Sinif and drops the level; a course keeps the level and drops Sinif", () => {
    const input = { subject: "  Riyaziyyat ", grade: " 9A ", level: "Beginner" };
    expect(groupFieldsForType({ groupType: "SCHOOL", ...input })).toEqual({ groupType: "SCHOOL", subject: "Riyaziyyat", grade: "9A", level: "" });
    expect(groupFieldsForType({ groupType: "COURSE", ...input })).toEqual({ groupType: "COURSE", subject: "Riyaziyyat", grade: "", level: "BEGINNER" });
  });

  it("infers the type when a caller sends none (seed, older client mid-deploy)", () => {
    expect(typeFieldsOf({ subject: "Ümumi", grade: "10" })).toEqual({ groupType: "SCHOOL", subject: "Ümumi", grade: "10", level: "" });
    expect(typeFieldsOf({ subject: "Java", grade: "Beginner" })).toEqual({ groupType: "COURSE", subject: "Java", grade: "", level: "BEGINNER" });
    expect(typeFieldsOf({ groupType: "COURSE", subject: "Java", grade: "9A", level: "Junior" })).toEqual({ groupType: "COURSE", subject: "Java", grade: "", level: "Junior" });
  });
});

describe("backfill and read-time view", () => {
  it("plans one row per unprofiled group with the classifier's reason, never touching study_groups", () => {
    const plan = planProfileBackfill([
      { id: "a", subject: "Riyaziyyat", grade: "9A" },
      { id: "b", subject: "AI Engineering", grade: "Beginner" },
      { id: "c", subject: "", grade: "Qrup 3", teachingCategory: "LANGUAGE" },
    ]);
    expect(plan).toEqual([
      { groupId: "a", groupType: "SCHOOL", level: "", source: "auto:CLASS_PATTERN" },
      { groupId: "b", groupType: "COURSE", level: "BEGINNER", source: "auto:LEVEL_PATTERN" },
      { groupId: "c", groupType: "COURSE", level: "Qrup 3", source: "auto:WORKSPACE" },
    ]);
  });

  it("a stored profile wins; the legacy grade of a course is not shown as Sinif", () => {
    expect(profileView({ subject: "Java", grade: "Beginner" }, { groupType: "COURSE", level: "BEGINNER" })).toEqual({ groupType: "COURSE", grade: "", level: "BEGINNER" });
    expect(profileView({ subject: "Riyaziyyat", grade: "9A" }, { groupType: "SCHOOL", level: "stale" })).toEqual({ groupType: "SCHOOL", grade: "9A", level: "" });
    expect(profileView({ subject: "", grade: "orta" }, undefined)).toEqual({ groupType: "COURSE", grade: "", level: "INTERMEDIATE" });
  });
});

describe("group form mapping", () => {
  it("starts a new group on the default type with empty fields", () => {
    expect(typeDraftOf(undefined, "SCHOOL")).toEqual({ groupType: "SCHOOL", subject: "", grade: "", levelChoice: "", levelText: "" });
  });

  it("opens a known level in the select and a free-text level under 'Other'", () => {
    expect(levelChoiceOf("ADVANCED")).toEqual({ levelChoice: "ADVANCED", levelText: "" });
    expect(levelChoiceOf("orta")).toEqual({ levelChoice: "INTERMEDIATE", levelText: "" });
    expect(levelChoiceOf("B2")).toEqual({ levelChoice: "OTHER", levelText: "B2" });
    expect(levelChoiceOf("")).toEqual({ levelChoice: "", levelText: "" });
  });

  it("sends only the chosen type's fields, keeping both while the teacher switches", () => {
    const draft = { ...typeDraftOf({ groupType: "COURSE", subject: "Java", grade: "", level: "Junior" }, "SCHOOL"), grade: "9A" };
    expect(typePayload(draft)).toEqual({ groupType: "COURSE", subject: "Java", grade: "", level: "Junior" });
    expect(typePayload({ ...draft, groupType: "SCHOOL" })).toEqual({ groupType: "SCHOOL", subject: "Java", grade: "9A", level: "" });
    expect(typePayload({ ...draft, levelChoice: "PROFESSIONAL" })).toMatchObject({ level: "PROFESSIONAL" });
  });

  it("labels the fields by type", () => {
    expect(typeFieldKeys("SCHOOL")).toMatchObject({ subject: "groups.field.subject", second: "groups.field.class" });
    expect(typeFieldKeys("COURSE")).toMatchObject({ subject: "groups.field.direction", second: "groups.field.level" });
  });

  it("displays labelled facts, localising known levels", () => {
    expect(groupFactsLine({ groupType: "SCHOOL", subject: "Riyaziyyat", grade: "9A", level: "" })).toBe("Fənn: Riyaziyyat · Sinif: 9A");
    expect(groupFactsLine({ groupType: "COURSE", subject: "AI Engineering", grade: "", level: "BEGINNER" })).toBe("İstiqamət: AI Engineering · Səviyyə: Başlanğıc");
    expect(groupFacts({ groupType: "COURSE", subject: "", grade: "", level: "B2" })).toEqual([{ label: "Səviyyə", value: "B2" }]);
  });
});

describe("teacher.groups API validation", () => {
  const user = { id: 7, openId: "google:7", name: "T", email: "t@example.com", accountStatus: "ACTIVE", sessionsValidAfter: null } as unknown as User;
  const caller = () =>
    appRouter.createCaller({
      user,
      session: null,
      req: { ip: "10.0.0.9", protocol: "https", headers: {} } as TrpcContext["req"],
      res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    });
  async function codeOf(p: Promise<unknown>) {
    try {
      await p;
      return "OK";
    } catch (e) {
      return e instanceof TRPCError ? e.code : `THROWN:${(e as Error).message}`;
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    vi.mocked(accessMod.resolveWorkspace).mockResolvedValue({ id: "ws1", ownerUserId: 7, teachingCategory: "IT", providerType: "TEACHER" } as never);
  });

  it("accepts both types and passes the fields through", async () => {
    expect(await codeOf(caller().teacher.groups.create({ name: "AI", groupType: "COURSE", subject: "AI Engineering", level: "BEGINNER" }))).toBe("OK");
    expect(groupsMod.createGroup).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ groupType: "COURSE", subject: "AI Engineering", level: "BEGINNER", grade: "" }));
    expect(await codeOf(caller().teacher.groups.create({ name: "9A", groupType: "SCHOOL", subject: "Riyaziyyat", grade: "9A" }))).toBe("OK");
  });

  it("still accepts a request without a type (the server infers it)", async () => {
    expect(await codeOf(caller().teacher.groups.create({ name: "Old client", subject: "Riyaziyyat", grade: "9A" }))).toBe("OK");
    expect(vi.mocked(groupsMod.createGroup).mock.calls[0][1].groupType).toBeUndefined();
  });

  it("rejects an unknown type and values longer than their columns", async () => {
    expect(await codeOf(caller().teacher.groups.create({ name: "X", groupType: "UNIVERSITY" as never }))).toBe("BAD_REQUEST");
    expect(await codeOf(caller().teacher.groups.create({ name: "X", groupType: "SCHOOL", grade: "x".repeat(33) }))).toBe("BAD_REQUEST");
    expect(await codeOf(caller().teacher.groups.create({ name: "X", groupType: "COURSE", level: "x".repeat(65) }))).toBe("BAD_REQUEST");
    expect(groupsMod.createGroup).not.toHaveBeenCalled();
  });

  it("an update that doesn't mention the type fields leaves them alone", async () => {
    expect(await codeOf(caller().teacher.groups.update({ id: "g1", patch: { name: "Renamed" } }))).toBe("OK");
    const patch = vi.mocked(groupsMod.renameGroup).mock.calls[0][2];
    expect(patch).toMatchObject({ name: "Renamed" });
    for (const key of ["groupType", "subject", "grade", "level"]) expect(patch[key as keyof typeof patch]).toBeUndefined();
  });
});
