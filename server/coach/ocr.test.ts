import { describe, expect, it } from "vitest";
import { OCR_LOW_QUALITY } from "../../shared/coach";
import { AppError } from "../modules/errors";
import { IngestError } from "./extract";
import { materialErrorOf } from "./materials";
import { batches, densityScore, garbageRatio, isLowQuality, ocrMessages, pageQuality, planOcrPages, summarizeQuality } from "./ocr";

const printed = "Fotosintez yaşıl bitkilərdə işıq enerjisinin kimyəvi enerjiyə çevrilməsi prosesidir. ".repeat(6);

describe("OCR quality heuristic", () => {
  it("garbage ratio counts odd symbols and unreadable markers", () => {
    expect(garbageRatio(printed)).toBe(0);
    expect(garbageRatio("x² + y = 5, α ≤ β (§2)")).toBe(0);
    expect(garbageRatio("ab\uFFFD\uFFFD")).toBe(0.5);
    expect(garbageRatio("söz [?] söz")).toBeGreaterThan(0.2);
    expect(garbageRatio("")).toBe(1);
  });
  it("density grows with the amount of text, up to a full page", () => {
    expect(densityScore("")).toBe(0);
    expect(densityScore("abc")).toBeLessThan(0.05);
    expect(densityScore(printed)).toBe(1);
  });
  it("a clean, dense, confident page scores high", () => {
    expect(pageQuality(printed, 0.95)).toBeGreaterThanOrEqual(95);
    expect(isLowQuality(pageQuality(printed, 0.95))).toBe(false);
  });
  it("low confidence, little text or garbage pull the score below the threshold", () => {
    expect(pageQuality(printed, 0.1)).toBeLessThan(OCR_LOW_QUALITY);
    expect(pageQuality("[?] [?] ab", 0.9)).toBeLessThan(OCR_LOW_QUALITY);
    expect(pageQuality("", 1)).toBeLessThan(OCR_LOW_QUALITY);
  });
  it("is deterministic and clamps odd confidence values", () => {
    expect(pageQuality(printed, 0.7)).toBe(pageQuality(printed, 0.7));
    expect(pageQuality(printed, 7)).toBe(pageQuality(printed, 1));
    expect(pageQuality(printed, Number.NaN)).toBe(pageQuality(printed, 0));
  });
  it("the worst page decides whether the student is asked to check", () => {
    expect(summarizeQuality([])).toEqual({ ocrScore: null, needsReview: false });
    expect(summarizeQuality([90, 85])).toEqual({ ocrScore: 85, needsReview: false });
    expect(summarizeQuality([90, 40])).toEqual({ ocrScore: 40, needsReview: true });
  });
});

describe("OCR caps", () => {
  const scanned = Array.from({ length: 40 }, (_, i) => i + 1);
  it("reads at most the per-material cap", () => {
    expect(planOcrPages(scanned, 30, 200)).toEqual({ read: scanned.slice(0, 30), skipped: 10 });
  });
  it("stops at what is left of the month", () => {
    expect(planOcrPages(scanned, 30, 12)).toEqual({ read: scanned.slice(0, 12), skipped: 28 });
    expect(planOcrPages(scanned, 30, 0)).toEqual({ read: [], skipped: 40 });
  });
  it("0 per-material cap means no per-material limit", () => {
    expect(planOcrPages(scanned, 0, 1000).read).toHaveLength(40);
  });
  it("batches pages for the model", () => {
    expect(batches([1, 2, 3, 4, 5, 6, 7], 5)).toEqual([[1, 2, 3, 4, 5], [6, 7]]);
  });
});

describe("OCR prompt and errors", () => {
  it("transcribes in the original language and never translates", () => {
    const system = String(ocrMessages({ type: "text", text: "x" }, 3, "n1")[0].content);
    expect(system).toMatch(/original language/);
    expect(system).toMatch(/Never translate/);
    expect(system).toContain("1..3");
  });
  it("maps failures to what the student sees", () => {
    expect(materialErrorOf(new IngestError("OCR_LIMIT"))).toBe("OCR_LIMIT");
    expect(materialErrorOf(new AppError("COACH_MONTHLY_LIMIT"))).toBe("AI_LIMIT");
    expect(materialErrorOf(new AppError("COACH_AI_BUSY"))).toBe("AI_QUOTA");
    expect(materialErrorOf(new Error("x"))).toBe("UNREADABLE");
  });
});
