import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialPageReport } from "../../shared/coach";
import { AppError } from "../modules/errors";
import type { OcrOutcome, OcrPage } from "./ocr";

const h = vi.hoisted(() => ({
  report: null as MaterialPageReport | null,
  material: { id: "m1", studentId: 7, status: "READY", fileId: "f1", fileName: "aparat.pdf", errorCode: null as string | null, updatedAt: new Date(0) },
  ocr: vi.fn(),
  added: [] as number[][],
  updates: [] as Record<string, unknown>[],
}));

vi.mock("../db", () => {
  const chain = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    Object.assign(q, { from: () => q, where: () => q, limit: () => q, then: (res: (v: unknown) => unknown) => Promise.resolve(rows()).then(res) });
    return q;
  };
  return {
    requireDb: () => ({
      select: () => chain(() => [h.material]),
      update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => void (h.updates.push(v), Object.assign(h.material, v)) }) }),
    }),
  };
});
vi.mock("../modules/files", () => ({ fileRow: async () => ({ id: "f1" }), fileBytes: async () => Buffer.from("%PDF-") }));
vi.mock("./quota", () => ({ assertCoachAiAllowed: async () => undefined }));
vi.mock("./materials", () => ({
  pageReportOf: async () => h.report,
  savePageReport: async (_id: string, _s: number, r: MaterialPageReport) => void (h.report = r),
  addRecoveredPages: async (_id: string, pages: { page: number }[]) => void h.added.push(pages.map((p) => p.page)),
  ownedMaterial: async () => h.material,
  materialDetail: async () => ({ id: "m1", pages: h.report }),
  onMaterialReady: () => undefined,
}));
vi.mock("./ocr", async (orig) => ({ ...(await orig<typeof import("./ocr")>()), ocrPagesOf: (...args: unknown[]) => h.ocr(...args) }));

const page = (n: number): OcrPage => ({ page: n, text: `Səhifə ${n}: yaddaş qurğuları haqqında mətn. `.repeat(10), quality: 90 });
const outcome = (pages: number[], ok: number[]): OcrOutcome => ({ recognised: ok.map(page), failed: pages.filter((p) => !ok.includes(p)), error: ok.length === pages.length ? null : new AppError("COACH_AI_BUSY") });
const empty = (): MaterialPageReport => ({ low: [], image: [], failed: [], skipped: [] });

let mod: typeof import("./ocrRetry");
beforeEach(async () => {
  vi.useFakeTimers();
  mod = await import("./ocrRetry");
  h.report = { ...empty(), pending: [27, 28, 31, 32], retries: 0, retryAt: null };
  h.material.errorCode = null;
  h.added = [];
  h.updates = [];
  h.ocr.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60_000);

describe("background OCR retries", () => {
  it("fails twice, then recovers the pages in place after 1, 3 and 10 minutes", async () => {
    h.ocr
      .mockImplementationOnce(async (_m, _b, pages: number[]) => outcome(pages, []))
      .mockImplementationOnce(async (_m, _b, pages: number[]) => outcome(pages, [27, 28]))
      .mockImplementationOnce(async (_m, _b, pages: number[]) => outcome(pages, pages));
    mod.resumeOcrRetry("m1", h.report);
    await minutes(0.9);
    expect(h.ocr).not.toHaveBeenCalled();
    await minutes(0.2);
    expect(h.ocr).toHaveBeenCalledTimes(1);
    expect(h.report).toMatchObject({ pending: [27, 28, 31, 32], retries: 1, failed: [] });
    await minutes(3);
    expect(h.ocr.mock.calls[1][2]).toEqual([27, 28, 31, 32]);
    expect(h.added).toEqual([[27, 28]]);
    expect(h.report).toMatchObject({ pending: [31, 32], retries: 2, failed: [] });
    await minutes(10);
    expect(h.ocr.mock.calls[2][2]).toEqual([31, 32]);
    expect(h.added).toEqual([[27, 28], [31, 32]]);
    expect(h.report).toMatchObject({ pending: [], failed: [], retryAt: null });
    expect(h.material.errorCode).toBeNull();
  });

  it("after the last try the pages are failed; 'Yenidən cəhd et' tries once more without a new upload", async () => {
    h.ocr.mockImplementation(async (_m, _b, pages: number[]) => outcome(pages, []));
    mod.resumeOcrRetry("m1", h.report);
    await minutes(1 + 3 + 10 + 1);
    expect(h.ocr).toHaveBeenCalledTimes(3);
    expect(h.report).toMatchObject({ pending: [], failed: [27, 28, 31, 32] });
    expect(h.material.errorCode).toBe("OCR_PARTIAL");

    h.ocr.mockImplementation(async (_m, _b, pages: number[]) => outcome(pages, pages));
    const detail = await mod.retryFailedPages(7, "m1");
    expect(detail.pages).toMatchObject({ failed: [], pending: [27, 28, 31, 32] });
    expect(h.material.errorCode).toBeNull();
    await minutes(0.01);
    expect(h.ocr).toHaveBeenCalledTimes(4);
    expect(h.added).toEqual([[27, 28, 31, 32]]);
    expect(h.report).toMatchObject({ pending: [], failed: [] });
  });

  it("a stop no retry can pass (limit reached) ends the retries at once", () => {
    const next = mod.nextReport({ ...empty(), pending: [5, 6], retries: 0 }, { recognised: [], failed: [5, 6], error: new AppError("COACH_MONTHLY_LIMIT") });
    expect(next).toMatchObject({ pending: [], failed: [5, 6] });
  });

  it("recognised picture pages are named, not added as failures", () => {
    const pic: OcrPage = { page: 6, text: "Şəkil 2", quality: 40 };
    const next = mod.nextReport({ ...empty(), pending: [5, 6], retries: 1 }, { recognised: [page(5), pic], failed: [], error: null }, 0);
    expect(next).toEqual({ low: [], image: [6], failed: [], skipped: [], pending: [], retries: 2, retryAt: null });
  });

  it("schedules the next try at the next delay", () => {
    const next = mod.nextReport({ ...empty(), pending: [5], retries: 0 }, { recognised: [], failed: [5], error: new AppError("COACH_AI_TIMEOUT") }, 0);
    expect(next.retryAt).toBe(new Date(mod.OCR_RETRY_DELAYS_MS[1]).toISOString());
  });
});
