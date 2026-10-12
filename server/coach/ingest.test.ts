import { describe, expect, it } from "vitest";
import { chunkPages, headingOf, normalizeText, splitLong, titleFromText, virtualPages, type PageText } from "./chunker";
import { isScannedText } from "./extract";
import { capPages, effectiveStatus, MATERIAL_STALE_MS } from "./materials";
import { fallbackTopics, normalizeTopics, segmentMessages } from "./segment";

const para = (n: number, word = "söz") => Array.from({ length: n }, () => word).join(" ") + ".";
const page = (n: number, text: string, extra: Partial<PageText> = {}): PageText => ({ page: n, text, method: "TEXT", quality: null, ...extra });

describe("text shaping", () => {
  it("normalizes line ends, control characters and blank runs", () => {
    expect(normalizeText("a\r\nb\u0007\n\n\n\nc  \n")).toBe("a\nb\n\nc");
  });
  it("splits long text into virtual pages at paragraph boundaries", () => {
    const text = Array.from({ length: 10 }, () => para(100)).join("\n\n");
    const pages = virtualPages(text, 1200);
    expect(pages.length).toBeGreaterThan(3);
    expect(pages.every((p) => p.length <= 1200)).toBe(true);
    expect(pages.join("\n\n").replace(/\s/g, "")).toBe(normalizeText(text).replace(/\s/g, ""));
  });
  it("splits an overlong paragraph at sentence ends", () => {
    const parts = splitLong("Birinci cümlə. İkinci cümlə! Üçüncü cümlə?", 20);
    expect(parts).toEqual(["Birinci cümlə.", "İkinci cümlə!", "Üçüncü cümlə?"]);
  });
  it("recognises numbered, all-caps and standalone headings, not sentences", () => {
    expect(headingOf("2.1 Hüceyrənin quruluşu")).toBe("2.1 Hüceyrənin quruluşu");
    expect(headingOf("FOTOSİNTEZ")).toBe("FOTOSİNTEZ");
    expect(headingOf("Fəsil 3 Genetika")).toBe("Fəsil 3 Genetika");
    expect(headingOf("Bu, uzun bir cümlədir və nöqtə ilə bitir.")).toBe("");
  });
  it("cuts fallback titles at a word boundary", () => {
    expect(titleFromText("Qısa başlıq\nmətn")).toBe("Qısa başlıq");
    const long = titleFromText("Bu çox uzun bir sətirdir ki, başlıq kimi tam göstərilə bilməz və kəsilməlidir", 40);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(41);
  });
  it("detects pages without a usable text layer", () => {
    expect(isScannedText("  \n 12 ")).toBe(true);
    expect(isScannedText(para(20))).toBe(false);
  });
});

describe("chunkPages", () => {
  it("keeps chunks within the size limits and tracks pages", () => {
    const pages = [page(1, [para(80), para(80), para(80)].join("\n\n")), page(2, [para(80), para(80)].join("\n\n"))];
    const chunks = chunkPages(pages, 600, 900);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 900)).toBe(true);
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0].pageFrom).toBe(1);
    expect(chunks.at(-1)!.pageTo).toBe(2);
  });
  it("starts a new chunk at a heading and carries it as the chunk heading", () => {
    const pages = [page(1, ["1. Giriş", para(60), "2. Əsas hissə", para(60)].join("\n\n"))];
    const chunks = chunkPages(pages, 300, 2000);
    expect(chunks.map((c) => c.heading)).toEqual(["1. Giriş", "2. Əsas hissə"]);
  });
  it("never mixes OCR and text-layer pages, and keeps the lowest OCR quality", () => {
    const pages = [page(1, para(20)), page(2, para(20), { method: "OCR", quality: 80 }), page(3, para(20), { method: "OCR", quality: 55 })];
    const chunks = chunkPages(pages, 5000, 9000);
    expect(chunks.map((c) => c.method)).toEqual(["TEXT", "OCR"]);
    expect(chunks[1].quality).toBe(55);
    expect(chunks[1].pageFrom).toBe(2);
  });
  it("caps whole pages at the character limit", () => {
    const pages = [page(1, "a".repeat(60)), page(2, "b".repeat(60)), page(3, "c".repeat(60))];
    expect(capPages(pages, 130).map((p) => p.page)).toEqual([1, 2]);
    expect(capPages([page(1, "x".repeat(500))], 100)[0].text.length).toBe(100);
  });
});

describe("topics", () => {
  const chunks = Array.from({ length: 8 }, (_, i) => ({ ord: i, pageFrom: i + 1, pageTo: i + 1, heading: i % 3 === 0 ? `Bölmə ${i / 3 + 1}` : "", text: para(10), method: "TEXT" as const, quality: null }));

  it("turns the model's starts into an ordered cover of all chunks", () => {
    const topics = normalizeTopics([{ title: "B", firstChunk: 4 }, { title: "A", firstChunk: 0 }, { title: "dup", firstChunk: 4 }, { title: "bad", firstChunk: 99 }], chunks)!;
    expect(topics.map((t) => [t.title, t.from, t.to])).toEqual([["A", 0, 3], ["B", 4, 7]]);
    expect(topics[1].pageFrom).toBe(5);
    expect(topics[1].pageTo).toBe(8);
  });
  it("moves the first topic to chunk 0 when the model skips the start", () => {
    const topics = normalizeTopics([{ title: "Only", firstChunk: 3 }], chunks)!;
    expect(topics).toHaveLength(1);
    expect([topics[0].from, topics[0].to]).toEqual([0, 7]);
  });
  it("rejects unusable answers", () => {
    expect(normalizeTopics([], chunks)).toBeNull();
    expect(normalizeTopics([{ title: " ", firstChunk: 0 }], chunks)).toBeNull();
  });
  it("falls back to headings, else fixed groups", () => {
    expect(fallbackTopics(chunks).map((t) => t.title)).toEqual(["Bölmə 1", "Bölmə 2", "Bölmə 3"]);
    const plain = chunks.map((c) => ({ ...c, heading: "" }));
    const groups = fallbackTopics(plain);
    expect(groups.map((t) => [t.from, t.to])).toEqual([[0, 5], [6, 7]]);
  });
  it("asks for titles in the student's app language", () => {
    const system = String(segmentMessages(chunks, "ru")[0].content);
    expect(system).toContain("Russian");
    expect(String(segmentMessages(chunks, "en")[0].content)).toContain("English");
  });
});

describe("material status", () => {
  const now = Date.now();
  it("shows a run that outlived a restart as interrupted", () => {
    expect(effectiveStatus({ status: "EXTRACTING", errorCode: null, updatedAt: new Date(now - MATERIAL_STALE_MS - 1) }, now)).toEqual({ status: "FAILED", errorCode: "INTERRUPTED" });
    expect(effectiveStatus({ status: "SEGMENTING", errorCode: null, updatedAt: new Date(now - 1000) }, now)).toEqual({ status: "SEGMENTING", errorCode: null });
    expect(effectiveStatus({ status: "READY", errorCode: null, updatedAt: new Date(0) }, now).status).toBe("READY");
  });
});
