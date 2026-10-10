import { describe, expect, it } from "vitest";
import { maxBytesFor, precheck, type UploadConfig } from "../client/src/lib/materialUpload";
import {
  MB,
  TEMPLATES,
  carryValues,
  cleanTags,
  compactValues,
  defaultTemplate,
  fieldsFor,
  kindFromMime,
  materialDetailsSchema,
  parseWebUrl,
  prefillFromGroups,
  savesAsTask,
  templateFromSubject,
  uploadLimitBytes,
  type ProfileGroup,
} from "../shared/materialTemplates";
import type { ContentMetaRow } from "../drizzle/schema";
import { checkDirectUpload, partLength, planUpload } from "./materials/directUpload";
import { legacyMeta, metaFromRow, rowFromDetails, visibleToStudents } from "./materials/meta";
import { materialRecipients, planMaterialNotices } from "./materials/notify";
import { assertMaterialSource, defaultDetails, resolvePublishing } from "./materials/service";

const NOW = new Date("2026-10-10T12:00:00Z");
const later = new Date("2026-10-11T09:00:00Z");
const earlier = new Date("2026-10-09T09:00:00Z");

describe("material templates", () => {
  it("every template's fields have unique keys and select fields an option set", () => {
    for (const [name, def] of Object.entries(TEMPLATES)) {
      const keys = def.fields.map((f) => f.key);
      expect(new Set(keys).size, name).toBe(keys.length);
      for (const f of def.fields) if (f.type === "select") expect(f.optionSet, `${name}.${f.key}`).toBeTruthy();
    }
  });

  it("saves as a task for the TASK kind or when submission is required", () => {
    expect(savesAsTask("TASK", false)).toBe(true);
    expect(savesAsTask("FILE", true)).toBe(true);
    expect(savesAsTask("LINK", false)).toBe(false);
  });

  it("picks the template from group subjects, then category, then the last one used", () => {
    expect(templateFromSubject("IELTS Writing")).toBe("IELTS");
    expect(templateFromSubject("Data Analitika")).toBe("DATA_ANALYTICS");
    expect(templateFromSubject("Riyaziyyat")).toBeNull();
    expect(defaultTemplate({ groupSubjects: ["Java", "IELTS"], teachingCategory: "IT", lastUsed: "LANGUAGE" })).toBe("IELTS");
    expect(defaultTemplate({ groupSubjects: ["Java"], teachingCategory: "SCHOOL", lastUsed: "LANGUAGE" })).toBe("SCHOOL_LESSON");
    expect(defaultTemplate({ groupSubjects: [], teachingCategory: "OTHER", lastUsed: "LANGUAGE" })).toBe("LANGUAGE");
    expect(defaultTemplate({ groupSubjects: [], teachingCategory: null, lastUsed: "bogus" })).toBe("GENERAL");
  });

  it("splits fields into main and more, and promotes on request", () => {
    const main = fieldsFor("IELTS", "main", {}).map((f) => f.key);
    const more = fieldsFor("IELTS", "more", {}).map((f) => f.key);
    expect(more).toContain("dueAt");
    expect(main).not.toContain("dueAt");
    expect(fieldsFor("IELTS", "main", {}, ["dueAt"]).map((f) => f.key)).toContain("dueAt");
    expect([...main, ...more].sort()).toEqual(TEMPLATES.IELTS.fields.map((f) => f.key).sort());
  });

  it("drops empty values and values of hidden fields", () => {
    expect(compactValues("SCHOOL_LESSON", { topics: [], subject: "", grade: "9A", purpose: "LESSON", dueAt: later })).toEqual({ grade: "9A", purpose: "LESSON" });
    expect(compactValues("SCHOOL_LESSON", { purpose: "HOMEWORK", dueAt: later })).toEqual({ purpose: "HOMEWORK", dueAt: later });
  });

  it("shows a conditional field only when its condition holds", () => {
    expect(fieldsFor("SCHOOL_LESSON", "main", { purpose: "LESSON" }).map((f) => f.key)).not.toContain("dueAt");
    expect(fieldsFor("SCHOOL_LESSON", "main", { purpose: "HOMEWORK" }).map((f) => f.key)).toContain("dueAt");
  });

  it("carries only values the target template has", () => {
    const out = carryValues("SCHOOL_LESSON", { topics: ["Kəsrlər"], technologies: ["SQL"] });
    expect(out.topics).toEqual(["Kəsrlər"]);
    expect(out).not.toHaveProperty("technologies");
  });

  it("cleans tags: trims, collapses duplicates by key, caps the count", () => {
    expect(cleanTags(["  SQL ", "sql", "", "JOIN\u0007"])).toEqual(["SQL", "JOIN"]);
    expect(cleanTags(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(20);
  });

  it("accepts only http(s) links with a real host", () => {
    expect(parseWebUrl("https://youtube.com/watch?v=1")).not.toBeNull();
    expect(parseWebUrl("javascript:alert(1)")).toBeNull();
    expect(parseWebUrl("https://user:pw@example.com")).toBeNull();
    expect(parseWebUrl("http://localhost")).toBeNull();
    expect(materialDetailsSchema.safeParse({ template: "IT", kind: "LINK", values: { repoUrl: "ftp://x.com" } }).success).toBe(false);
    expect(materialDetailsSchema.safeParse({ template: "IT", kind: "LINK", values: { examType: "SAT" } }).success).toBe(false);
  });
});

describe("prefill from group profiles", () => {
  const school = (grade: string, subject = "Riyaziyyat"): ProfileGroup => ({ groupType: "SCHOOL", subject, grade, level: null });
  const course = (subject: string, level: string | null): ProfileGroup => ({ groupType: "COURSE", subject, grade: "", level });

  it("fills subject and grade for school groups that agree", () => {
    expect(prefillFromGroups("SCHOOL_LESSON", [school("9A"), school("9A")], {})).toEqual({ subject: "Riyaziyyat", grade: "9A" });
    expect(prefillFromGroups("SCHOOL_LESSON", [school("9A"), school("9B")], {})).toEqual({ subject: "Riyaziyyat" });
  });

  it("never overwrites what the teacher typed", () => {
    expect(prefillFromGroups("SCHOOL_LESSON", [school("9A")], { subject: "Fizika" })).toEqual({ grade: "9A" });
  });

  it("maps course subjects to a direction and level to the template's option", () => {
    expect(prefillFromGroups("IT", [course("Data Analytics", "PROFESSIONAL")], {})).toMatchObject({ direction: "DATA_ANALYTICS", level: "ADVANCED" });
    expect(prefillFromGroups("IT", [course("Java", "INTERMEDIATE")], {})).toMatchObject({ direction: "Java", level: "INTERMEDIATE" });
  });

  it("does nothing for mixed group types", () => {
    expect(prefillFromGroups("IT", [school("9A"), course("Java", null)], {})).toEqual({});
  });
});

describe("upload limits", () => {
  const config: UploadConfig = { direct: true, serverMaxBytes: 8 * MB, limitsMb: { DOCUMENT: 50, PRESENTATION: 100, DATASET: 200, VIDEO: 500 } };
  const file = (name: string, size: number) => ({ name, size }) as File;

  it("uses per-kind limits with direct uploads, the server limit without", () => {
    expect(maxBytesFor("VIDEO", config)).toBe(500 * MB);
    expect(maxBytesFor("VIDEO", { ...config, direct: false })).toBe(8 * MB);
    expect(uploadLimitBytes("DATASET", { DATASET: 300 })).toBe(300 * MB);
    expect(uploadLimitBytes("CODE", null)).toBe(200 * MB);
  });

  it("checks type and size before sending", () => {
    expect(precheck(file("a.mp4", 10 * MB), "VIDEO", config)).toBeNull();
    expect(precheck(file("a.html", 10), "FILE", config)).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(precheck(file("a.svg", 10), "FILE", config)).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(precheck(file("a.pdf", 60 * MB), "FILE", config)).toBe("FILE_TOO_LARGE");
    expect(precheck(file("a.pdf", 0), "FILE", config)).toBe("FILE_TOO_LARGE");
  });

  it("server check: type, kind limit, then quota", () => {
    const base = { kind: "DATASET" as const, fileName: "x.zip", limitsMb: null, quotaBytes: null, usedBytes: 0 };
    expect(checkDirectUpload({ ...base, sizeBytes: 120 * MB })).toEqual({ ok: true, mimeType: "application/zip" });
    expect(checkDirectUpload({ ...base, fileName: "x.exe", sizeBytes: 1 })).toEqual({ ok: false, error: "FILE_TYPE_NOT_ALLOWED" });
    expect(checkDirectUpload({ ...base, sizeBytes: 201 * MB })).toEqual({ ok: false, error: "FILE_TOO_LARGE" });
    expect(checkDirectUpload({ ...base, sizeBytes: 50 * MB, quotaBytes: 100 * MB, usedBytes: 60 * MB })).toEqual({ ok: false, error: "STORAGE_QUOTA_EXCEEDED" });
  });

  it("plans one PUT up to 100 MB, 16 MB parts above", () => {
    expect(planUpload(100 * MB)).toEqual({ mode: "single", partSize: null, partCount: 1 });
    const plan = planUpload(120 * MB);
    expect(plan).toEqual({ mode: "multipart", partSize: 16 * MB, partCount: 8 });
    expect(partLength(120 * MB, 16 * MB, 8)).toBe(8 * MB);
    expect(partLength(120 * MB, 16 * MB, 1)).toBe(16 * MB);
  });
});

describe("publishing", () => {
  it("keeps current values the save leaves out and treats a past time as now", () => {
    const current = { status: "DRAFT" as const, publishAt: null, visibility: "RECIPIENTS" as const, notify: false, url: "https://a.com" };
    expect(resolvePublishing(current, { status: "PUBLISHED" }, NOW)).toEqual({ ...current, status: "PUBLISHED" });
    expect(resolvePublishing(null, { publishAt: earlier }, NOW).publishAt).toBeNull();
    expect(resolvePublishing(null, { publishAt: later }, NOW).publishAt).toEqual(later);
    expect(resolvePublishing(current, { url: "  " }, NOW).url).toBeNull();
  });

  it("is visible only when published and its time has come", () => {
    expect(visibleToStudents({ status: "PUBLISHED", publishAt: null }, NOW)).toBe(true);
    expect(visibleToStudents({ status: "PUBLISHED", publishAt: later }, NOW)).toBe(false);
    expect(visibleToStudents({ status: "DRAFT", publishAt: null }, NOW)).toBe(false);
  });

  it("requires exactly one source, and a link for LINK", () => {
    expect(() => assertMaterialSource({ url: null, fileName: "" }, "FILE")).toThrow("MATERIAL_SOURCE_REQUIRED");
    expect(() => assertMaterialSource({ url: "https://a.com", fileName: "a.pdf" }, "FILE")).toThrow("MATERIAL_SOURCE_REQUIRED");
    expect(() => assertMaterialSource({ url: null, fileName: "a.pdf" }, "LINK")).toThrow("MATERIAL_SOURCE_REQUIRED");
    expect(() => assertMaterialSource({ url: "https://a.com", fileName: "" }, "LINK")).not.toThrow();
  });

  it("older clients get GENERAL with the kind from the source", () => {
    expect(defaultDetails({ topic: "VLOOKUP", mimeType: "application/vnd.ms-excel" }, null)).toEqual({ template: "GENERAL", kind: "DATASET", values: { topics: ["VLOOKUP"] } });
    expect(defaultDetails({ topic: "", mimeType: null }, "https://a.com").kind).toBe("LINK");
    expect(kindFromMime("video/mp4")).toBe("VIDEO");
  });
});

describe("notices", () => {
  it("announces to everyone when it goes live, else only to newly reached students", () => {
    expect(planMaterialNotices({ wasVisible: false, isVisible: true, before: [], after: [1, 2, 2], notify: true })).toEqual([1, 2]);
    expect(planMaterialNotices({ wasVisible: true, isVisible: true, before: [1], after: [1, 3], notify: true })).toEqual([3]);
    expect(planMaterialNotices({ wasVisible: false, isVisible: false, before: [], after: [1], notify: true })).toEqual([]);
    expect(planMaterialNotices({ wasVisible: false, isVisible: true, before: [], after: [1], notify: false })).toEqual([]);
  });

  it("reaches active student members and listed students, never the teacher", () => {
    const members = [
      { groupId: "g1", userId: 1, status: "ACTIVE", membershipRole: "STUDENT" },
      { groupId: "g1", userId: 2, status: "REMOVED", membershipRole: "STUDENT" },
      { groupId: "g1", userId: 9, status: "ACTIVE", membershipRole: "TEACHER" },
      { groupId: "g2", userId: 3, status: "ACTIVE", membershipRole: "STUDENT" },
    ] as never;
    expect(materialRecipients({ groupIds: ["g1"], studentIds: [4, 9] }, members, 9).sort()).toEqual([1, 4]);
  });
});

describe("meta rows", () => {
  it("round-trips form values through the stored row", () => {
    const details = {
      template: "IT" as const,
      kind: "LINK" as const,
      values: { direction: "BACKEND", level: "BEGINNER", technologies: ["SQL"], topics: ["JOIN"], estimatedMinutes: 45, repoUrl: "https://github.com/x/y" },
    };
    const { columns, tags } = rowFromDetails(details, "Java");
    expect(columns).toMatchObject({ template: "IT", kind: "LINK", direction: "BACKEND", level: "BEGINNER", dueAt: null, estimatedMinutes: 45 });
    expect(rowFromDetails({ ...details, values: { ...details.values, dueAt: later } }).columns.dueAt).toBeNull();
    expect(tags).toEqual({ TOPIC: ["JOIN"], TECHNOLOGY: ["SQL"] });
    const row = { ...columns, status: "PUBLISHED", publishAt: null, visibility: "LINK", notify: true, notifiedAt: null, url: "https://youtube.com/x" } as unknown as ContentMetaRow;
    const view = metaFromRow(row, tags, "Java");
    expect(view.values).toMatchObject(details.values);
    expect(view.legacy).toBe(false);
  });

  it("describes a material saved before templates as a published GENERAL file", () => {
    expect(legacyMeta({ mimeType: "application/pdf", subject: "", topic: "VLOOKUP" })).toMatchObject({
      template: "GENERAL",
      kind: "FILE",
      status: "PUBLISHED",
      visibility: "LINK",
      values: { topics: ["VLOOKUP"] },
      legacy: true,
    });
  });
});
