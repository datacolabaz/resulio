import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimChunkReload, isChunkLoadError } from "../client/src/lib/lazyPage";
import type { SyllabusImportJob } from "../drizzle/schema";
import { parseImportDetail } from "../shared/syllabusImport";
import type { ObjectStore } from "./fileStorage/r2";

const mocks = vi.hoisted(() => ({
  results: [] as unknown[][],
  store: null as Partial<ObjectStore> | null,
}));

vi.mock("./db", () => {
  const chain = (result: () => unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
          return () => chain(result);
        },
      },
    );
  return { requireDb: () => ({ select: () => chain(() => mocks.results.shift() ?? []) }) };
});
vi.mock("./fileStorage/r2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fileStorage/r2")>()),
  objectStore: () => mocks.store,
}));

const { importFileBytes, jobView } = await import("./syllabus/importJobs");

const STRUCTURE = {
  title: "Java",
  timing: { duration: null, lessonsPerWeek: 2, lessonMinutes: 90 },
  modules: [{ title: "1-ci AY — Java Fundamentals", lessons: [{ title: "Intro" }], details: {} }],
};

function job(patch: Partial<SyllabusImportJob> = {}): SyllabusImportJob {
  const now = new Date();
  return {
    id: "job1",
    providerWorkspaceId: "ws1",
    createdBy: 1,
    fileId: "f1",
    fileName: "syllabus.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    sourceText: null,
    status: "READY",
    errorCode: null,
    detail: null,
    pageCount: 2,
    chunkCount: 1,
    chunksDone: 1,
    inputMode: null,
    model: null,
    runId: "run1",
    result: STRUCTURE,
    syllabusId: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    ...patch,
  };
}

describe("import job detail read leniently", () => {
  it("keeps the current shape", () => {
    expect(parseImportDetail({ message: "module 2: 429", localModules: ["A", "B"] })).toEqual({ message: "module 2: 429", localModules: ["A", "B"] });
    expect(parseImportDetail(null)).toBeNull();
    expect(parseImportDetail({})).toBeNull();
  });

  it("turns legacy and hand-written shapes into strings", () => {
    expect(parseImportDetail("AI_QUOTA: exhausted")).toEqual({ message: "AI_QUOTA: exhausted" });
    expect(parseImportDetail('{"message":"double encoded"}')).toEqual({ message: "double encoded" });
    expect(parseImportDetail({ localModules: "Module A", message: { code: 429 } })).toEqual({ localModules: ["Module A"], message: '{"code":429}' });
    expect(parseImportDetail({ localModules: [{ title: " Module A " }, "", null, 7] })).toEqual({ localModules: ["Module A", "7"] });
    expect(parseImportDetail({ message: ["a", { b: 1 }] })).toEqual({ message: '["a",{"b":1}]' });
    expect(parseImportDetail(["x"])).toEqual({ message: '["x"]' });
  });

  it("caps what it keeps", () => {
    const d = parseImportDetail({ message: "x".repeat(5_000), localModules: Array.from({ length: 100 }, (_, i) => `M${i}`.padEnd(400, "!")) });
    expect(d!.message!.length).toBe(2_000);
    expect(d!.localModules).toHaveLength(60);
    expect(d!.localModules![0].length).toBe(255);
  });
});

describe("job view", () => {
  it("serves only renderable detail, whatever the row holds", () => {
    expect(jobView(job({ detail: "plain" as never })).detail).toEqual({ message: "plain" });
    const view = jobView(job({ detail: { localModules: [{ title: "M1" }], message: { status: "RESOURCE_EXHAUSTED" } } as never }));
    expect(view.detail).toEqual({ localModules: ["M1"], message: '{"status":"RESOURCE_EXHAUSTED"}' });
    expect(view.status).toBe("READY");
    expect(view.result?.modules[0].details.objectives).toEqual([]);
  });

  it("reports a result in an older shape as a failed job instead of passing it on", () => {
    const view = jobView(job({ result: { title: "Old", modules: [{ title: "M1", lessons: [{ title: "L1" }] }] } }));
    expect(view).toMatchObject({ status: "FAILED", errorCode: "INTERNAL", result: null });
  });

  it("shows a run that stopped touching its row as interrupted", () => {
    const old = new Date(Date.now() - 10 * 60_000);
    expect(jobView(job({ status: "PROCESSING", result: null, updatedAt: old }))).toMatchObject({ status: "FAILED", errorCode: "INTERRUPTED" });
  });
});

describe("uploaded file bytes for an import", () => {
  const pdf = Buffer.from("%PDF-1.7 test");
  const row = (patch: Record<string, unknown> = {}) => ({ id: "f1", workspaceId: "ws1", fileName: "syllabus.pdf", sizeBytes: pdf.length, dataBase64: "", ...patch });
  const location = { fileId: "f1", backend: "r2", bucket: "resulio-files", objectKey: "files/ws1/f1.pdf", sizeBytes: pdf.length };

  beforeEach(() => {
    mocks.results = [];
    mocks.store = null;
    process.env.R2_SECRET_ACCESS_KEY = "super-secret-key";
  });

  it("reads a file kept in MySQL", async () => {
    mocks.results = [[row({ dataBase64: pdf.toString("base64") })]];
    const read = await importFileBytes({ fileId: "f1", providerWorkspaceId: "ws1" });
    expect("bytes" in read && Buffer.from(read.bytes).equals(pdf)).toBe(true);
  });

  it("reads a file kept in R2 through file_objects", async () => {
    const get = vi.fn(async () => pdf);
    mocks.store = { backend: "r2", bucket: "resulio-files", get };
    mocks.results = [[row()], [location]];
    const read = await importFileBytes({ fileId: "f1", providerWorkspaceId: "ws1" });
    expect(get).toHaveBeenCalledWith("files/ws1/f1.pdf");
    expect("bytes" in read && Buffer.from(read.bytes).equals(pdf)).toBe(true);
  });

  it("explains an R2 file whose bucket is not configured", async () => {
    mocks.results = [[row()], [location]];
    const read = await importFileBytes({ fileId: "f1", providerWorkspaceId: "ws1" });
    expect(read).toEqual({ missing: expect.stringContaining("FILE_NOT_FOUND") });
  });

  it("explains a failed R2 read without leaking credentials", async () => {
    mocks.store = { backend: "r2", bucket: "resulio-files", get: async () => Promise.reject(new Error("AccessDenied for super-secret-key")) };
    mocks.results = [[row()], [location]];
    const read = await importFileBytes({ fileId: "f1", providerWorkspaceId: "ws1" });
    expect("missing" in read && read.missing).toMatch(/could not be read: Error: AccessDenied for \*\*\*/);
  });

  it("does not read another workspace's file, a missing row or empty content", async () => {
    mocks.results = [[row({ workspaceId: "other" })]];
    expect(await importFileBytes({ fileId: "f1", providerWorkspaceId: "ws1" })).toEqual({ missing: "file f1 not found" });
    expect(await importFileBytes({ fileId: null, providerWorkspaceId: "ws1" })).toEqual({ missing: "file - not found" });
    mocks.results = [[row()], []];
    expect(await importFileBytes({ fileId: "f1", providerWorkspaceId: "ws1" })).toEqual({ missing: expect.stringContaining("no stored content") });
  });
});

describe("lazy pages after a deploy", () => {
  it("recognises a missing chunk", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://resulio.co/assets/SyllabusImportPage-cWNJ9Ozc.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/index.css"))).toBe(true);
    expect(isChunkLoadError(new TypeError("titles.map is not a function"))).toBe(false);
  });

  it("reloads once per window, never in a loop", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(claimChunkReload(storage, 1_000_000)).toBe(true);
    expect(claimChunkReload(storage, 1_010_000)).toBe(false);
    expect(claimChunkReload(storage, 1_040_000)).toBe(true);
    expect(claimChunkReload(null)).toBe(false);
  });
});
