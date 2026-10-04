import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMessageKey } from "../client/src/i18n/messages";
import { parseItemContent, studentPracticeContentSchema, TIMESTAMP_MAX, TIMESTAMP_MIN } from "../shared/syllabus";
import { AppError, errorDetails, toTrpcError } from "./modules/errors";
import * as authoring from "./syllabus/authoring";
import { CONTAINER_DEADLINE, createContainer } from "./syllabus/practiceTasks";
import { createSampleSyllabus, samplePlan, type SampleLocale } from "./syllabus/sample";

vi.mock("./syllabus/authoring", () => ({
  createSyllabus: vi.fn(),
  createModule: vi.fn(),
  createLesson: vi.fn(),
  createItem: vi.fn(),
  discardDraft: vi.fn(),
}));

const a = vi.mocked(authoring);
const SCOPE = { workspaceId: "ws1", userId: 7 };
const LOCALES: SampleLocale[] = ["az", "en", "ru"];

function wireAuthoring() {
  let n = 0;
  a.createSyllabus.mockResolvedValue({ id: "syl1" } as never);
  a.createModule.mockImplementation(async () => ({ id: `m${++n}` }) as never);
  a.createLesson.mockImplementation(async () => ({ id: `l${++n}` }) as never);
  a.createItem.mockImplementation(async () => ({ id: `i${++n}` }) as never);
  a.discardDraft.mockResolvedValue({ ok: true });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("sample syllabus plan", () => {
  it("fits every column and passes teacher-input validation in each language", () => {
    for (const locale of LOCALES) {
      const plan = samplePlan(locale);
      expect(plan.syllabus.title.length).toBeLessThanOrEqual(255);
      expect(plan.syllabus.subject.length).toBeLessThanOrEqual(120);
      expect(plan.syllabus.level.length).toBeLessThanOrEqual(64);
      expect(plan.syllabus.language.length).toBeLessThanOrEqual(64);
      expect(plan.syllabus.estimatedDurationLabel.length).toBeLessThanOrEqual(64);
      for (const m of plan.modules) {
        expect(m.title.length).toBeGreaterThan(0);
        expect(m.title.length).toBeLessThanOrEqual(255);
        for (const l of m.lessons) {
          expect(l.title.length).toBeLessThanOrEqual(255);
          expect(l.objectives.every((o) => o.length > 0 && o.length <= 300)).toBe(true);
          for (const it of l.items) {
            expect(it.title.length).toBeLessThanOrEqual(255);
            expect(() => parseItemContent(it.kind, it.content)).not.toThrow();
            if (it.kind === "STUDENT_PRACTICE") expect(studentPracticeContentSchema.safeParse(it.content).success).toBe(true);
          }
        }
      }
    }
  });
});

describe("practice container", () => {
  it("writes a deadline inside the MySQL TIMESTAMP range and fills every NOT NULL column", async () => {
    expect(CONTAINER_DEADLINE.getTime()).toBeLessThanOrEqual(Date.UTC(2038, 0, 19, 3, 14, 7));
    expect(CONTAINER_DEADLINE.getTime()).toBeGreaterThan(Date.now());
    expect(TIMESTAMP_MIN.getTime()).toBeGreaterThan(0);
    expect(TIMESTAMP_MAX.getTime()).toBeLessThanOrEqual(Date.UTC(2038, 0, 19, 3, 14, 7));

    const inserts: Array<Record<string, unknown>> = [];
    const done = { onDuplicateKeyUpdate: () => Promise.resolve(), then: (ok: () => void, fail: (e: unknown) => void) => Promise.resolve().then(ok, fail) };
    const db = { insert: () => ({ values: (v: Record<string, unknown>) => (inserts.push(v), done) }) };
    const plan = samplePlan("az");
    const practice = plan.modules.flatMap((m) => m.lessons.flatMap((l) => l.items)).filter((i) => i.kind === "STUDENT_PRACTICE");
    expect(practice.length).toBeGreaterThan(0);
    for (const it of practice) {
      inserts.length = 0;
      await createContainer(db as never, SCOPE, { syllabusId: "syl1", itemId: "i1", versionId: null }, it.title, parseItemContent(it.kind, it.content) as Record<string, unknown>);
      const task = inserts[0];
      expect((task.deadline as Date).getTime()).toBeLessThanOrEqual(TIMESTAMP_MAX.getTime());
      for (const col of ["title", "description", "instructions"]) expect(typeof task[col]).toBe("string");
      for (const col of ["groupIds", "studentIds", "attachments"]) expect(Array.isArray(task[col])).toBe(true);
      expect(String(task.shareCode).length).toBeLessThanOrEqual(16);
      expect(inserts[1]).toMatchObject({ taskId: task.id, syllabusId: "syl1", itemId: "i1", versionId: null });
    }
  });
});

describe("createSampleSyllabus", () => {
  it("builds the plan through the authoring functions, items placed in their lesson", async () => {
    wireAuthoring();
    const plan = samplePlan("en");
    await expect(createSampleSyllabus(SCOPE, "en")).resolves.toEqual({ id: "syl1" });
    expect(a.createSyllabus).toHaveBeenCalledWith(SCOPE, plan.syllabus);
    expect(a.createModule).toHaveBeenCalledTimes(plan.modules.length);
    expect(a.createLesson).toHaveBeenCalledTimes(plan.modules.flatMap((m) => m.lessons).length);
    const items = plan.modules.flatMap((m) => m.lessons.flatMap((l) => l.items));
    expect(a.createItem).toHaveBeenCalledTimes(items.length);
    for (const call of a.createItem.mock.calls) {
      expect(call[1]).toBe("syl1");
      expect(call[2]).toMatchObject({ scope: "LESSON", lessonId: expect.stringMatching(/^l\d+$/) });
    }
    expect(a.discardDraft).not.toHaveBeenCalled();
  });

  it("removes the half-built draft and rethrows when a step fails", async () => {
    wireAuthoring();
    const boom = new Error("Incorrect datetime value");
    a.createItem.mockImplementation(async (_s, _id, _p, input) => {
      if (input.kind === "STUDENT_PRACTICE") throw boom;
      return { id: "ok" } as never;
    });
    await expect(createSampleSyllabus(SCOPE, "az")).rejects.toBe(boom);
    expect(a.discardDraft).toHaveBeenCalledWith(SCOPE, "syl1");
  });

  it("still surfaces the original error when the cleanup fails too", async () => {
    wireAuthoring();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new AppError("SYLLABUS_INVALID_CONTENT");
    a.createModule.mockRejectedValue(boom);
    a.discardDraft.mockRejectedValue(new Error("db gone"));
    await expect(createSampleSyllabus(SCOPE, "ru")).rejects.toBe(boom);
  });
});

describe("error reporting", () => {
  it("every syllabus error code and the common codes a syllabus page can hit have a translation", () => {
    const source = readFileSync(new URL("./modules/errors.ts", import.meta.url), "utf8");
    const syllabusCodes = [...source.matchAll(/\| "(SYLLABUS_[A-Z_]+)"/g)].map((x) => x[1]);
    expect(syllabusCodes).toContain("SYLLABUS_DB_NOT_READY");
    const common = ["NOT_FOUND", "FORBIDDEN", "RATE_LIMITED", "NO_WORKSPACE", "NO_ACCESS", "NOT_PUBLISHED", "NO_ATTEMPTS_LEFT", "CLOSED", "NOT_STARTED", "NOT_DRAFT"];
    const files = ["FILE_NOT_FOUND", "FILE_TOO_LARGE", "FILE_TYPE_NOT_ALLOWED", "SUBMISSION_EMPTY", "SUBMISSION_ALREADY_GRADED", "TASK_NO_ACCESS"];
    const keys = [...syllabusCodes, ...common, ...files, "INVALID_INPUT", "INTERNAL_ERROR"].map((c) => `error.${c}`);
    expect(keys.filter((k) => !isMessageKey(k))).toEqual([]);
  });

  it("logs unexpected errors with where they happened and the driver details, but never sends them", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const driver = Object.assign(new Error("Incorrect datetime value"), { errno: 1292, code: "ER_TRUNCATED_WRONG_VALUE", sqlMessage: "Incorrect datetime value: '2099-12-31 23:59:59.000' for column 'deadline'" });
    const wrapped = new Error("Failed query: insert into `tasks` ...", { cause: driver });
    const err = toTrpcError(wrapped, { path: "teacher.syllabus.createSample", type: "mutation", userId: 7, workspaceId: "ws1" });
    expect(err).toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "INTERNAL_ERROR" });
    expect(log).toHaveBeenCalledWith(
      "[Resulio] Unexpected error",
      expect.objectContaining({ path: "teacher.syllabus.createSample", userId: 7, workspaceId: "ws1", errno: 1292, code: "ER_TRUNCATED_WRONG_VALUE" }),
      wrapped,
    );
    expect(errorDetails(new Error("plain"))).toEqual({});
  });
});
