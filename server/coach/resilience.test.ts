import { describe, expect, it, vi } from "vitest";
import { COACH_DEFAULT_LIMITS, coachFileProblem, coachUploadLimits } from "../../shared/coach";
import { LlmHttpError, type InvokeResult } from "../_core/llm";
import { AppError } from "../modules/errors";
import { aiFailureOf, backoffMs, coachAiError, createLimiter, DEFAULT_RETRY, generateStructured, isRetryable, withRetries, type RetryPolicy } from "./ai";
import { looksLike, scannedPagesOf } from "./extract";
import type { DraftChunk } from "./chunker";
import { materialErrorOf, placeRecovered, readyWarning } from "./materials";
import { recogniseBatches, stopsOcr } from "./ocr";
import { z } from "zod";

const MB = 1024 * 1024;
const http = (status: number, message = "", hints: ConstructorParameters<typeof LlmHttpError>[2] = {}) => new LlmHttpError(status, `LLM invoke failed: ${status} – ${message}`, hints);
const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({ ...DEFAULT_RETRY, sleep: vi.fn(async () => undefined), random: () => 0.5, ...over });

describe("provider failures are classified, 'busy' only for a per-minute 429", () => {
  it.each([
    [http(429, "Resource exhausted, retry in 8s", { retryAfterMs: 8000, quotaWindow: "minute" }), "BUSY"],
    [http(429, "Resource exhausted"), "BUSY"],
    [http(429, "GenerateRequestsPerDayPerProjectPerModel", { quotaWindow: "day" }), "EXHAUSTED"],
    [http(429, "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro", { quotaWindow: "day" }), "CONFIG"],
    [http(401, "API key not valid"), "CONFIG"],
    [http(404, "models/gemini-3.5-flash is not found"), "CONFIG"],
    [http(504, "Deadline exceeded"), "TIMEOUT"],
    [timeout(), "TIMEOUT"],
    [http(400, "Unsupported MIME type: application/pdf"), "UNSUPPORTED"],
    [http(500, "Internal error"), "UNAVAILABLE"],
    [new Error("LLM is not configured: set AI_API_KEY"), "CONFIG"],
    [new TypeError("fetch failed"), "UNAVAILABLE"],
  ])("%s → %s", (error, expected) => {
    expect(aiFailureOf(error)).toBe(expected);
  });

  it("maps to stable codes the material and the UI understand", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(materialErrorOf(coachAiError(http(429)))).toBe("AI_QUOTA");
    expect(materialErrorOf(coachAiError(http(429, "x", { quotaWindow: "day" })))).toBe("AI_EXHAUSTED");
    expect(materialErrorOf(coachAiError(http(404)))).toBe("AI_CONFIG");
    expect(materialErrorOf(coachAiError(timeout()))).toBe("AI_TIMEOUT");
    expect(materialErrorOf(coachAiError(http(503)))).toBe("AI_UNAVAILABLE");
    expect(materialErrorOf(new AppError("AI_INVALID_OUTPUT"))).toBe("AI_UNAVAILABLE");
    expect(materialErrorOf(new AppError("COACH_MONTHLY_LIMIT"))).toBe("AI_LIMIT");
    expect(materialErrorOf(new AppError("FORBIDDEN"))).toBe("INTERNAL");
  });

  it("retries only what another try can fix", () => {
    expect(isRetryable(http(429))).toBe(true);
    expect(isRetryable(http(503))).toBe(true);
    expect(isRetryable(timeout())).toBe(true);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryable(http(429, "x", { quotaWindow: "day" }))).toBe(false);
    expect(isRetryable(http(429, "limit: 0"))).toBe(false);
    expect(isRetryable(http(404))).toBe(false);
    expect(isRetryable(http(400))).toBe(false);
  });
});

describe("withRetries", () => {
  it("retries a rate limit with backoff, then succeeds", async () => {
    const p = policy();
    const fn = vi.fn().mockRejectedValueOnce(http(429)).mockRejectedValueOnce(http(503)).mockResolvedValue("ok");
    await expect(withRetries(fn, p)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(vi.mocked(p.sleep).mock.calls.map(([ms]) => ms)).toEqual([1500, 3000]);
  });
  it("gives up after the configured attempts", async () => {
    const fn = vi.fn().mockRejectedValue(http(429));
    await expect(withRetries(fn, policy({ attempts: 3 }))).rejects.toMatchObject({ status: 429 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("does not retry configuration errors", async () => {
    const fn = vi.fn().mockRejectedValue(http(404));
    await expect(withRetries(fn, policy())).rejects.toMatchObject({ status: 404 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("retries a timeout only once (each try can take the full timeout)", async () => {
    const fn = vi.fn().mockRejectedValue(timeout());
    await expect(withRetries(fn, policy({ attempts: 5 }))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("backoffMs", () => {
  const p = { baseMs: 2000, maxMs: 20_000 };
  it("grows exponentially with jitter in [cap/2, cap]", () => {
    expect(backoffMs(0, { ...p, random: () => 0 })).toBe(1000);
    expect(backoffMs(0, { ...p, random: () => 1 })).toBe(2000);
    expect(backoffMs(2, { ...p, random: () => 0 })).toBe(4000);
    expect(backoffMs(10, { ...p, random: () => 1 })).toBe(20_000);
  });
  it("honours the provider's retry-after, capped", () => {
    expect(backoffMs(0, { ...p, random: () => 0 }, 8000)).toBe(8000);
    expect(backoffMs(0, { ...p, random: () => 0 }, 120_000)).toBe(20_000);
  });
});

describe("createLimiter", () => {
  it("never runs more than max tasks and runs them all", async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it("frees the slot when a task throws", async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(limit(async () => "next")).resolves.toBe("next");
  });
});

describe("generateStructured", () => {
  it("turns off the HTTP-layer retries so attempts are not multiplied", async () => {
    const result: InvokeResult = { id: "x", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }] };
    const invoke = vi.fn(async () => result);
    await generateStructured({ model: "m", messages: [], schema: z.object({ ok: z.boolean() }), jsonSchema: { name: "t", schema: {} }, invoke });
    expect(invoke.mock.calls[0][0]).toMatchObject({ maxRetries: 0 });
  });
});

describe("recogniseBatches", () => {
  const read = (fail: (group: number[]) => unknown) => async (group: number[]) => {
    const error = fail(group);
    if (error) throw error;
    return group.map((page) => ({ page, text: "t", quality: 90 }));
  };

  it("keeps the batches that worked", async () => {
    const out = await recogniseBatches([[1, 2], [3, 4], [5]], read((g) => (g[0] === 3 ? new AppError("COACH_AI_BUSY") : null)), { parallel: 2 });
    expect(out.recognised.map((p) => p.page)).toEqual([1, 2, 5]);
    expect(out.failed).toEqual([3, 4]);
    expect(out.error).toBeInstanceOf(AppError);
  });
  it("stops after a failure no other batch can get past", async () => {
    const calls: number[] = [];
    const out = await recogniseBatches([[1], [2], [3], [4]], read((g) => (calls.push(g[0]), new AppError("COACH_AI_CONFIG"))), { parallel: 1 });
    expect(calls).toEqual([1]);
    expect(out.failed).toEqual([1, 2, 3, 4]);
  });
  it("stops when the run is cancelled", async () => {
    const out = await recogniseBatches([[1], [2], [3]], read(() => null), { parallel: 1, onBatch: (done) => done < 1 });
    expect(out.recognised.map((p) => p.page)).toEqual([1]);
    expect(out.failed).toEqual([2, 3]);
  });
  it("knows which failures end OCR", () => {
    expect(stopsOcr(new AppError("COACH_AI_BUSY"))).toBe(false);
    expect(stopsOcr(new AppError("COACH_AI_TIMEOUT"))).toBe(false);
    expect(stopsOcr(new AppError("COACH_AI_EXHAUSTED"))).toBe(true);
    expect(stopsOcr(new AppError("COACH_MONTHLY_LIMIT"))).toBe(true);
  });
});

describe("scanned page detection", () => {
  const full = "Prosessor və yaddaş qurğuları kompüterin əsas hissələridir. ".repeat(5);
  it("in a text PDF only pages with no letters at all go to OCR", () => {
    expect(scannedPagesOf([full, "Part 2", full, "", full, "Fig. 3"])).toEqual([4]);
  });
  it("in a scanned PDF near-empty pages go to OCR too", () => {
    expect(scannedPagesOf(["", "", "Part 3", full])).toEqual([1, 2, 3]);
  });
  it("checks the file signature", () => {
    expect(looksLike(".pdf", Buffer.from("%PDF-1.7\n"))).toBe(true);
    expect(looksLike(".pdf", Buffer.from("<html>"))).toBe(false);
    expect(looksLike(".docx", Buffer.from("PK\u0003\u0004"))).toBe(true);
    expect(looksLike(".png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(looksLike(".jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(looksLike(".txt", Buffer.from("salam"))).toBe(true);
    expect(looksLike(".txt", Buffer.from([0x61, 0x00, 0x62]))).toBe(false);
  });
});

describe("upload limits", () => {
  it("50 MB and 300 pages with direct storage uploads by default", () => {
    const l = coachUploadLimits(COACH_DEFAULT_LIMITS, true);
    expect(l).toMatchObject({ direct: true, maxBytes: 50 * MB, maxPages: 300, ocrPages: 30, ocrPagesPerMonth: 200, reducedByStorage: false });
  });
  it("stays at 8 MB when files are stored in the database, and says so", () => {
    expect(coachUploadLimits(COACH_DEFAULT_LIMITS, false)).toMatchObject({ maxBytes: 8 * MB, reducedByStorage: true });
    expect(coachUploadLimits({ ...COACH_DEFAULT_LIMITS, maxUploadMb: 5 }, false)).toMatchObject({ maxBytes: 5 * MB, reducedByStorage: false });
  });
  it("is configurable within hard caps; 0 means the default", () => {
    expect(coachUploadLimits({ ...COACH_DEFAULT_LIMITS, maxUploadMb: 100, maxPages: 500 }, true)).toMatchObject({ maxBytes: 100 * MB, maxPages: 500 });
    expect(coachUploadLimits({ ...COACH_DEFAULT_LIMITS, maxUploadMb: 10_000, maxPages: 99_999 }, true)).toMatchObject({ maxBytes: 200 * MB, maxPages: 1000 });
    expect(coachUploadLimits({ ...COACH_DEFAULT_LIMITS, maxUploadMb: 0, maxPages: 0 }, true)).toMatchObject({ maxBytes: 50 * MB, maxPages: 300 });
  });
  it("the form checks type and size before uploading", () => {
    expect(coachFileProblem({ name: "aparat teminati 1.pdf", size: 12 * MB }, 50 * MB)).toBeNull();
    expect(coachFileProblem({ name: "Slides.PPTX", size: 1 }, 50 * MB)).toBeNull();
    expect(coachFileProblem({ name: "big.pdf", size: 51 * MB }, 50 * MB)).toBe("SIZE");
    expect(coachFileProblem({ name: "empty.pdf", size: 0 }, 50 * MB)).toBe("SIZE");
    expect(coachFileProblem({ name: "notes.doc", size: 10 }, 50 * MB)).toBe("TYPE");
    expect(coachFileProblem({ name: "README", size: 10 }, 50 * MB)).toBe("TYPE");
  });
  it("partial OCR outranks the OCR cap as the material's warning", () => {
    expect(readyWarning({ ocrFailed: 2, ocrSkipped: 3 })).toBe("OCR_PARTIAL");
    expect(readyWarning({ ocrFailed: 0, ocrSkipped: 3 })).toBe("OCR_LIMIT");
    expect(readyWarning({ ocrFailed: 0, ocrSkipped: 0 })).toBeNull();
  });
});

describe("late pages join a ready material in place", () => {
  const chunk = (pageFrom: number, pageTo = pageFrom): DraftChunk => ({ ord: 0, pageFrom, pageTo, heading: "", text: `p${pageFrom}`, method: "OCR", quality: 90 });
  // Chunks of pages 2-26, 29-30, 33-40 (27-28 and 31-32 were missing); topics 2-26, 29-40.
  const existing = [
    { ord: 0, pageFrom: 2 },
    { ord: 1, pageFrom: 14 },
    { ord: 2, pageFrom: 26 },
    { ord: 3, pageFrom: 29 },
    { ord: 4, pageFrom: 33 },
  ];
  const topics = [
    { id: "A", ord: 0, pageFrom: 2, pageTo: 26 },
    { id: "B", ord: 1, pageFrom: 29, pageTo: 40 },
  ];

  it("puts each page between its neighbours, in the topic covering it, growing a topic to include it", () => {
    const plan = placeRecovered(existing, topics, [chunk(31, 32), chunk(27, 28)]);
    expect(plan.inserts.map((p) => [p.chunk.pageFrom, p.ord, p.topicId])).toEqual([
      [27, 3, "A"],
      [31, 5, "B"],
    ]);
    // Applied from the last insertion point down: ords >= 4 move by 1, then ords >= 3 by 1.
    expect(plan.shifts).toEqual([
      { fromOrd: 4, by: 1 },
      { fromOrd: 3, by: 1 },
    ]);
    expect(plan.ranges).toEqual([{ id: "A", pageFrom: 2, pageTo: 28 }]);
  });

  it("pages after the last chunk go to the end of the last topic", () => {
    const plan = placeRecovered(existing, topics, [chunk(41), chunk(42)]);
    expect(plan.inserts.map((p) => [p.ord, p.topicId])).toEqual([
      [5, "B"],
      [6, "B"],
    ]);
    expect(plan.shifts).toEqual([{ fromOrd: 5, by: 2 }]);
    expect(plan.ranges).toEqual([{ id: "B", pageFrom: 29, pageTo: 42 }]);
  });
});
