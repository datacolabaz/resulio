import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { COACH_DEFAULT_LIMITS, OCR_LOW_QUALITY, type CoachLimits } from "../../shared/coach";
import { LlmHttpError, type InvokeParams, type InvokeResult } from "../_core/llm";
import { AppError } from "../modules/errors";
import { DEFAULT_RETRY } from "./ai";
import { IngestError } from "./extract";
import { materialErrorOf, readyWarning, segmentTopics, SEGMENT_TIMEOUT_MS, structureMaterial } from "./materials";
import { readPagesWithOcr } from "./ocr";
import { AUTHOR, aparatPages, aparatPagesWithoutToc } from "./outline.fixture";
import { chunkMaterial, frontMatterOf } from "./structure";
import type { DraftChunk } from "./chunker";
import type { CoachMaterialRow } from "../../drizzle/schema";

/**
 * Material processing with a stubbed provider: reproduces the production failure (a mostly-text
 * PDF failing as "AI busy" because one OCR batch was rate-limited) and checks the fixes.
 */

const h = vi.hoisted(() => ({
  invoke: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  limits: {} as Partial<CoachLimits>,
}));

vi.mock("../_core/llm", async (orig) => ({ ...(await orig<typeof import("../_core/llm")>()), invokeLLM: (p: InvokeParams) => h.invoke(p) }));
vi.mock("../db", () => {
  const rows = [{ n: 0 }];
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (res: (v: unknown) => void) => res(rows) : () => chain),
  });
  return { requireDb: () => chain };
});
vi.mock("./quota", async (orig) => {
  const real = await orig<typeof import("./quota")>();
  return { ...real, assertCoachAiAllowed: async () => undefined, coachLimits: async () => real.mergeLimits(h.limits) };
});
vi.mock("./models", () => ({ coachModels: async () => ({ main: "main-m", lite: "lite-m", pro: "pro-m", ocr: "ocr-m" }) }));
vi.mock("./store", async (orig) => ({ ...(await orig<typeof import("./store")>()), logEvent: async () => undefined }));

const reply = (content: unknown): InvokeResult => ({ id: "x", created: 1, model: "ocr-m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }] });
const pagesIn = (p: InvokeParams) => Number(/Transcribe the (\d+)/.exec(JSON.stringify(p.messages))?.[1] ?? 0);
const ocrReply = (p: InvokeParams) => reply({ pages: Array.from({ length: pagesIn(p) }, (_, i) => ({ page: i + 1, text: `Tanınmış mətn, səhifə ${i + 1}. `.repeat(20), confidence: 0.95 })) });
const rateLimited = (message = "Resource has been exhausted. Please retry in 1s.") => new LlmHttpError(429, `LLM invoke failed: 429 – RESOURCE_EXHAUSTED ${message}`, { retryAfterMs: 1000 });

type Kind = "text" | "sparse" | "scan";
async function pdf(kinds: Kind[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  kinds.forEach((kind, i) => {
    const page = doc.addPage([595, 842]);
    if (kind === "scan") return void page.drawRectangle({ x: 50, y: 50, width: 495, height: 742, color: rgb(0.85, 0.85, 0.85) });
    if (kind === "sparse") return void page.drawText(`Part ${i + 1}`, { x: 60, y: 760, size: 32, font });
    page.drawText(`${i + 1}. Processor and memory`, { x: 50, y: 790, size: 16, font });
    for (let l = 0; l < 20; l++) page.drawText(`Line ${l + 1}: the processor fetches, decodes and executes instructions.`, { x: 50, y: 750 - l * 18, size: 10, font });
  });
  return Buffer.from(await doc.save());
}

const material = (fileName = "aparat teminati 1.pdf") => ({ id: "m1", studentId: 7, fileName }) as CoachMaterialRow;
const read = async (kinds: Kind[], onProgress?: Parameters<typeof readPagesWithOcr>[0]["onProgress"]) => readPagesWithOcr({ material: material(), bytes: await pdf(kinds), locale: "az", onProgress });
const repeat = <T,>(n: number, v: T) => Array.from({ length: n }, () => v);

const originalSleep = DEFAULT_RETRY.sleep;
beforeAll(() => {
  vi.stubEnv("AI_API_KEY", "test-key");
  vi.stubEnv("AI_API_URL", "https://generativelanguage.googleapis.com/v1beta/openai/");
  vi.stubEnv("COACH_PDF_MODE", "");
  DEFAULT_RETRY.sleep = async () => undefined;
});
afterAll(() => {
  DEFAULT_RETRY.sleep = originalSleep;
  vi.unstubAllEnvs();
});
beforeEach(() => {
  h.invoke = vi.fn(async (p: InvokeParams) => ocrReply(p));
  h.limits = {};
});

describe("text PDFs never wait on OCR", () => {
  it("keeps the few words of slide-like pages instead of sending them to OCR", async () => {
    const out = await read([...repeat(9, "text" as const), "sparse"]);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(out.pageCount).toBe(10);
    expect(out.pages).toHaveLength(10);
    expect(out.ocrPages).toBe(0);
  });
});

describe("OCR failures (the production report)", () => {
  it("one rate-limited batch no longer fails the whole material", async () => {
    // 8 text pages + 12 scanned → OCR batches of 5, 5 and 2 pages; the 2-page batch is always 429.
    h.invoke = vi.fn(async (p: InvokeParams) => {
      if (pagesIn(p) === 2) throw rateLimited();
      return ocrReply(p);
    });
    const out = await read([...repeat(8, "text" as const), ...repeat(12, "scan" as const)]);
    expect(out.ocrPages).toBe(10);
    expect(out.ocrFailed).toBe(2);
    expect(out.pages.map((p) => p.page)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    // Unread pages are listed as such; they do not make the recognised ones look poor.
    expect(out.needsReview).toBe(false);
    expect(out.ocrScore).toBeGreaterThanOrEqual(OCR_LOW_QUALITY);
    expect(out.report).toEqual({ low: [], image: [], failed: [19, 20], skipped: [] });
    expect(readyWarning(out)).toBe("OCR_PARTIAL");
    // The failing batch was retried (bounded) before giving up.
    expect(h.invoke.mock.calls.filter(([p]) => pagesIn(p as InvokeParams) === 2)).toHaveLength(DEFAULT_RETRY.attempts);
  });

  it("lists poorly recognised pages and names picture pages instead of warning about them", async () => {
    // 40 text pages + scans at 41-44: page 42 is a diagram (a caption), 43 is unreadable.
    h.invoke = vi.fn(async () =>
      reply({
        pages: [
          { page: 1, text: "Prosessorun quruluşu və iş prinsipi. ".repeat(15), confidence: 0.95 },
          { page: 2, text: "Şəkil 3. Sxem", confidence: 0.4 },
          { page: 3, text: "Ya§ddaş ¤¤ ¤ qurğ¶u ¤¤¤ [?] [?] ".repeat(20), confidence: 0.3 },
          { page: 4, text: "Daxiletmə qurğuları: klaviatura, siçan. ".repeat(15), confidence: 0.9 },
        ],
      }),
    );
    const out = await read([...repeat(40, "text" as const), ...repeat(4, "scan" as const)]);
    expect(out.report.image).toEqual([42]);
    expect(out.report.low).toEqual([43]);
    // One poor page of 44 is below the review share: no material-wide warning.
    expect(out.needsReview).toBe(false);
  });

  it("asks for a review when a meaningful share of pages is poorly recognised", async () => {
    h.invoke = vi.fn(async (p: InvokeParams) => reply({ pages: Array.from({ length: pagesIn(p) }, (_, i) => ({ page: i + 1, text: "Ya§ddaş ¤¤ ¤ qurğ¶u ¤¤¤ [?] ".repeat(20), confidence: 0.3 })) }));
    const out = await read([...repeat(6, "text" as const), ...repeat(4, "scan" as const)]);
    expect(out.report.low).toEqual([7, 8, 9, 10]);
    expect(out.needsReview).toBe(true);
  });

  it("text pages still make a material when every OCR call fails", async () => {
    h.invoke = vi.fn(async () => {
      throw rateLimited();
    });
    const out = await read([...repeat(6, "text" as const), ...repeat(4, "scan" as const)]);
    expect(out.pages).toHaveLength(6);
    expect(out.ocrFailed).toBe(4);
    expect(readyWarning(out)).toBe("OCR_PARTIAL");
  });

  it("'busy' only for a genuine per-minute rate limit", async () => {
    h.invoke = vi.fn(async () => {
      throw rateLimited();
    });
    const error = await read(repeat(3, "scan")).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(materialErrorOf(error)).toBe("AI_QUOTA");
  });

  it("a model this key has no quota for is a configuration error, and stops further calls", async () => {
    h.invoke = vi.fn(async () => {
      throw new LlmHttpError(429, "LLM invoke failed: 429 – Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-x", { quotaWindow: "day" });
    });
    const error = await read(repeat(25, "scan")).catch((e) => e);
    expect(materialErrorOf(error)).toBe("AI_CONFIG");
    expect(h.invoke.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("an unknown model (404) is a configuration error, not 'busy'", async () => {
    h.invoke = vi.fn(async () => {
      throw new LlmHttpError(404, "LLM invoke failed: 404 – models/gemini-3.5-flash-lite is not found");
    });
    expect(materialErrorOf(await read(repeat(3, "scan")).catch((e) => e))).toBe("AI_CONFIG");
  });

  it("the daily quota is reported as exhausted", async () => {
    h.invoke = vi.fn(async () => {
      throw new LlmHttpError(429, "LLM invoke failed: 429 – [quota GenerateRequestsPerDayPerProjectPerModel] exhausted", { quotaWindow: "day" });
    });
    expect(materialErrorOf(await read(repeat(3, "scan")).catch((e) => e))).toBe("AI_EXHAUSTED");
  });

  it("timeouts are retried once per batch, then reported as timeouts", async () => {
    h.invoke = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(materialErrorOf(await read(repeat(3, "scan")).catch((e) => e))).toBe("AI_TIMEOUT");
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });
});

describe("OCR speed and progress", () => {
  it("reads at most two batches of a material at a time", async () => {
    let active = 0;
    let peak = 0;
    h.invoke = vi.fn(async (p: InvokeParams) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return ocrReply(p);
    });
    const out = await read(repeat(20, "scan"));
    expect(out.ocrPages).toBe(20);
    expect(peak).toBe(2);
  });

  it("reports pages done and stops when the run is cancelled", async () => {
    const seen: number[] = [];
    const out = await read(repeat(30, "scan"), async (p) => {
      seen.push(p.done);
      return p.done < 10;
    });
    expect(seen[0]).toBe(0);
    expect(seen.every((d, i) => i === 0 || d > seen[i - 1])).toBe(true);
    expect(h.invoke.mock.calls.length).toBeLessThan(6);
    expect(out.ocrFailed).toBeGreaterThan(0);
  });

  it("recognises only the first pages up to the per-material cap", async () => {
    h.limits = { ocrPagesPerMaterial: 10 };
    const out = await read(repeat(14, "scan"));
    expect(out.ocrPages).toBe(10);
    expect(out.ocrSkipped).toBe(4);
    expect(readyWarning(out)).toBe("OCR_LIMIT");
  });
});

describe("upload checks after the bytes arrive", () => {
  it("enforces the configured page limit", async () => {
    h.limits = { maxPages: 5 };
    const error = await read(repeat(6, "text")).catch((e) => e);
    expect(error).toBeInstanceOf(IngestError);
    expect(materialErrorOf(error)).toBe("TOO_MANY_PAGES");
  });
  it("rejects a file whose contents do not match its extension", async () => {
    const error = await readPagesWithOcr({ material: material("notes.pdf"), bytes: Buffer.from("PK\u0003\u0004 not a pdf"), locale: "az" }).catch((e) => e);
    expect(materialErrorOf(error)).toBe("FILE_TYPE");
  });
  it("allows 300 pages by default", () => {
    expect(COACH_DEFAULT_LIMITS.maxPages).toBe(300);
    expect(COACH_DEFAULT_LIMITS.maxUploadMb).toBe(50);
  });
});

describe("topic segmentation never blocks a material", () => {
  const chunks: DraftChunk[] = Array.from({ length: 12 }, (_, i) => ({ ord: i, pageFrom: i + 1, pageTo: i + 1, heading: i % 4 === 0 ? `Bölmə ${i / 4 + 1}` : "", text: "mətn ".repeat(50), method: "TEXT", quality: null }));

  it("one lite call with a short timeout and no retries", async () => {
    const generate = vi.fn(async () => ({ data: { topics: [{ title: "A", firstChunk: 0 }, { title: "B", firstChunk: 6 }] }, model: "lite-m" }));
    const out = await segmentTopics(7, chunks, "az", generate as never);
    expect(out.source).toBe("AI");
    expect(out.topics.map((t) => t.title)).toEqual(["A", "B"]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]).toMatchObject([{ model: "lite-m", timeoutMs: SEGMENT_TIMEOUT_MS, retry: { attempts: 1 } }]);
    expect(SEGMENT_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
  });

  it("falls back to headings when the AI times out or is rate-limited", async () => {
    for (const code of ["COACH_AI_TIMEOUT", "COACH_AI_BUSY", "COACH_AI_CONFIG"] as const) {
      const generate = vi.fn(async () => {
        throw new AppError(code);
      });
      const out = await segmentTopics(7, chunks, "az", generate as never);
      expect(out.source).toBe("HEADINGS");
      expect(out.topics.map((t) => t.title)).toEqual(["Bölmə 1", "Bölmə 2", "Bölmə 3"]);
    }
  });
});

describe("topics of the production material (title page, table of contents, 40 pages)", () => {
  const view = (out: Awaited<ReturnType<typeof structureMaterial>>) => out.topics.map((t) => `${t.title} ${t.pageFrom}–${t.pageTo}`);

  it("follows the table of contents without an AI call, skipping the title page", async () => {
    const generate = vi.fn(async () => {
      throw new Error("not called");
    });
    const out = await structureMaterial(7, aparatPages(), "az", generate as never);
    expect(generate).not.toHaveBeenCalled();
    expect(out.source).toBe("TOC");
    expect(out.frontPages).toBe(2);
    expect(view(out)).toEqual([
      "EHM-lərin nəsillərə görə xüsusiyyətləri 3–6",
      "Kompüterin struktur sxemi və tərkibi 7–10",
      "Con fon Neyman arxitekturası 11–12",
      "Periferiya hissəsi 13–17",
      "Ana plata və sistem bloku daxili qurluşu 18–22",
      "USB 23–28",
      "Yaddaş qurğuları 29–32",
      "Operativ yaddaş 33–37",
      "Xarici yaddaş qurğuları 38–42",
    ]);
    // Front matter chunks belong to no topic.
    expect(out.topics[0].from).toBeGreaterThan(0);
    expect(out.chunks[out.topics[0].from].pageFrom).toBe(3);
  });

  it("an AI answer naming the author as topic 1 still gives readable, balanced topics", async () => {
    const pages = aparatPagesWithoutToc();
    const { chunks: all, bodyFrom } = chunkMaterial(pages, frontMatterOf(pages));
    const at = (page: number) => all.slice(bodyFrom).findIndex((c) => c.pageFrom >= page);
    const generate = vi.fn(async () => ({
      data: {
        topics: [
          { title: AUTHOR, firstChunk: at(3) },
          { title: "Periferiya Hissəsi", firstChunk: at(13) },
          { title: "ana plata", firstChunk: at(18) },
          { title: "sistem bloku daxili qurluşu", firstChunk: at(19) },
          { title: "USB", firstChunk: at(23) },
          { title: "YADDAŞ QURĞULARI", firstChunk: at(29) },
        ],
      },
      model: "lite-m",
    }));
    const out = await structureMaterial(7, pages, "az", generate as never);
    expect(out.source).toBe("AI");
    expect(view(out)).toEqual([
      "EHM-lərin nəsillərə görə xüsusiyyətləri 3–6",
      "Kompüterin struktur sxemi və tərkibi 7–12",
      "Periferiya hissəsi 13–17",
      "Ana plata və sistem bloku daxili qurluşu 18–22",
      "USB 23–28",
      "Yaddaş qurğuları 29–32",
      "Operativ yaddaş 33–37",
      "Xarici yaddaş qurğuları 38–42",
    ]);
    // The prompt asks for topics of the configured size and never a person's name as a title.
    const prompt = JSON.stringify((generate.mock.calls[0] as unknown[])[0]);
    expect(prompt).toContain("about 2-6 pages");
    expect(prompt).toContain("never use a person's name");
    // Front matter is not sent to the model as content.
    expect(prompt).not.toContain(AUTHOR);
  });

  it("topic sizes follow coach.limits", async () => {
    h.limits = { topicMinPages: 0, topicMaxPages: 0 };
    const out = await structureMaterial(7, aparatPages(), "az", vi.fn() as never);
    expect(view(out).at(-1)).toBe("Yaddaş qurğuları 29–42");
    expect(out.topics.find((t) => t.title === "Ana plata")).toBeDefined();
  });
});
