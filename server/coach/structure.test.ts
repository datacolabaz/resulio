import { describe, expect, it } from "vitest";
import { pageList, reviewNeeded } from "../../shared/coach";
import { chunkPages, type DraftChunk, type PageText } from "./chunker";
import { pageReport } from "./ocr";
import { AUTHOR, aparatPages, bodyPages } from "./outline.fixture";
import {
  balanceTopics,
  casingHints,
  chunkMaterial,
  finishTitles,
  frontMatterOf,
  isTocPage,
  looksLikePersonName,
  normalizeTitle,
  stripNumbering,
  tocEntriesOf,
  tocStarts,
} from "./structure";

const page = (n: number, text: string): PageText => ({ page: n, text, method: "TEXT", quality: null });
const onePerPage = (pages: number, headings: Record<number, string> = {}): DraftChunk[] =>
  Array.from({ length: pages }, (_, i) => ({ ord: i, pageFrom: i + 1, pageTo: i + 1, heading: headings[i + 1] ?? "", text: "mətn ".repeat(200), method: "TEXT", quality: null }));
const pagesOf = (starts: { from: number }[], chunks: DraftChunk[]) =>
  starts.map((s, i) => {
    const to = i + 1 < starts.length ? starts[i + 1].from - 1 : chunks.length - 1;
    return [chunks[s.from].pageFrom, chunks[to].pageTo];
  });

describe("titles", () => {
  const hints = casingHints(aparatPages().map((p) => p.text));

  it("turns ALL CAPS into sentence case with the material's own spelling of names and acronyms", () => {
    expect(hints.get("neyman")).toBe("Neyman");
    expect(hints.get("ehm")).toBe("EHM");
    // Words of all-caps headings ("8.1. OPERATİV YADDAŞ") are not taken for acronyms.
    expect(hints.has("yaddaş")).toBe(false);
    expect(normalizeTitle("CON FON NEYMAN ARXİTEKTURASI", hints)).toBe("Con fon Neyman arxitekturası");
    expect(normalizeTitle("1. EHM-LƏRİN NƏSİLLƏRƏ GÖRƏ XÜSUSİYYƏTLƏRİ", hints)).toBe("EHM-lərin nəsillərə görə xüsusiyyətləri");
  });

  it("is Azerbaijani-aware: İ→i and I→ı", () => {
    expect(normalizeTitle("İNFORMATİKA")).toBe("İnformatika");
    expect(normalizeTitle("QARŞILIQLI ƏLAQƏ")).toBe("Qarşılıqlı əlaqə");
    expect(normalizeTitle("ilk interfeys")).toBe("İlk interfeys");
  });

  it("capitalises lowercase starts and drops Title Case", () => {
    expect(normalizeTitle("sistem bloku daxili qurluşu")).toBe("Sistem bloku daxili qurluşu");
    expect(normalizeTitle("Periferiya Hissəsi")).toBe("Periferiya hissəsi");
    expect(normalizeTitle("Con Fon Neyman", hints)).toBe("Con fon Neyman");
  });

  it("keeps short acronyms, removes numbering and keeps titles short", () => {
    expect(normalizeTitle("7. USB")).toBe("USB");
    expect(normalizeTitle("Mövzu 3: Prosessorlar.")).toBe("Prosessorlar");
    expect(normalizeTitle("Fəsil 2")).toBe("Fəsil 2");
    expect(stripNumbering("Bölmə 1")).toBe("Bölmə 1");
    const long = normalizeTitle("Prosessorun daxili quruluşu, registrlər, arifmetik-məntiqi qurğu və idarəetmə qurğusunun iş prinsipləri", hints, 60);
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });

  it("recognises person names (never a topic)", () => {
    for (const name of [AUTHOR, "A. B. Məmmədov", "Əli Vəli oğlu", "dos. Həsənov Rauf", "Иванов И. И.", "Səbinə Quliyeva"]) expect(looksLikePersonName(name)).toBe(true);
    for (const title of ["Periferiya hissəsi", "Con fon Neyman arxitekturası", "USB", "Azərbaycan Texniki Universiteti", "Operativ yaddaş"]) expect(looksLikePersonName(title)).toBe(false);
  });

  it("replaces a name with the topic's own heading", () => {
    const chunks = chunkPages(bodyPages(3, 8));
    const [first] = finishTitles([{ from: 0, title: AUTHOR }], chunks, { hints, names: [AUTHOR], locale: "az" });
    expect(first.title).toBe("EHM-lərin nəsillərə görə xüsusiyyətləri");
  });
});

describe("front matter", () => {
  it("skips the title/author page and the table of contents, and reads the TOC", () => {
    const front = frontMatterOf(aparatPages());
    expect(front.kinds).toEqual(["SKIP", "SKIP"]);
    expect(front.names).toContain(AUTHOR);
    expect(front.toc.map((e) => e.page)).toEqual([1, 5, 9, 11, 16, 17, 21, 27]);
    expect(front.toc[2].title).toBe("CON FON NEYMAN ARXİTEKTURASI");
  });

  it("recognises TOC pages in all three languages and with plain spacing", () => {
    expect(isTocPage("Содержание\nВведение ..... 3\nПроцессор ..... 7")).toBe(true);
    expect(isTocPage("Contents\nIntroduction 1\nMemory 9\nStorage 14")).toBe(true);
    expect(isTocPage("Prosessor əmrləri oxuyur.\nYaddaş 4 hissədən ibarətdir və 2 növü var.")).toBe(false);
    expect(tocEntriesOf("2.3 Operativ yaddaş …… 14")).toEqual([{ title: "Operativ yaddaş", page: 14 }]);
  });

  it("keeps a preface with real content as an introduction, and drops a short one", () => {
    const preface = `Ön söz\n${"Bu vəsait tələbələr üçün kompüter arxitekturasının əsaslarını izah edir. ".repeat(12)}`;
    const pages = [page(1, "APARAT TƏMİNATI\nBakı 2023"), page(2, preface), ...bodyPages(3, 12)];
    const front = frontMatterOf(pages);
    expect(front.kinds).toEqual(["SKIP", "INTRO"]);
    const { chunks, intro, bodyFrom } = chunkMaterial(pages, front);
    expect(intro).not.toBeNull();
    expect(chunks[intro!.from].pageFrom).toBe(2);
    expect(chunks[bodyFrom].pageFrom).toBe(3);
    expect(frontMatterOf([page(1, "Ön söz\nQısa qeyd."), ...bodyPages(3, 12)]).kinds).toEqual(["SKIP"]);
  });

  it("does not swallow a slide deck whose pages are all short", () => {
    const slide = (n: number) => page(n, `Slayd ${n}: prosessor\n• Əmrləri oxuyur və icra edir\n• Yaddaşla şin vasitəsilə işləyir\n• Tezlik və nüvə sayı sürəti təyin edir`);
    const pages = [page(1, `Kompüter arxitekturası\nMühazirə 1\n${AUTHOR}`), ...Array.from({ length: 19 }, (_, i) => slide(i + 2))];
    expect(frontMatterOf(pages).kinds).toEqual(["SKIP"]);
  });

  it("never takes every page", () => {
    expect(frontMatterOf([page(1, "Qısa"), page(2, "Qısa")]).kinds.length).toBeLessThan(2);
  });
});

describe("table of contents as topic boundaries", () => {
  const pages = aparatPages();
  const front = frontMatterOf(pages);
  const { chunks, bodyFrom } = chunkMaterial(pages, front);
  const body = chunks.slice(bodyFrom);

  it("maps entries to their headings and the printed pages to PDF pages", () => {
    const starts = tocStarts(front.toc, body)!;
    expect(starts).not.toBeNull();
    // Printed page 1 is PDF page 3; "USB" is too short to match by text and is placed by its page.
    expect(pagesOf(starts, body).map(([from]) => from)).toEqual([3, 7, 11, 13, 18, 19, 23, 29]);
  });

  it("is not used when it does not match the text", () => {
    expect(tocStarts([{ title: "Tamamilə başqa mövzu", page: 300 }, { title: "Digər mövzu", page: 400 }], body)).toBeNull();
    expect(tocStarts([{ title: "Tək mövzu", page: 1 }], body)).toBeNull();
  });
});

describe("balanced topics", () => {
  const opts = { minPages: 2, maxPages: 6, maxTopics: 30, locale: "az" as const };

  it("splits an oversized topic at its headings", () => {
    const chunks = onePerPage(14, { 5: "Operativ yaddaş", 10: "Xarici yaddaş" });
    const out = balanceTopics([{ from: 0, title: "Yaddaş qurğuları" }], chunks, opts);
    expect(out.map((t) => t.title)).toEqual(["Yaddaş qurğuları", "Operativ yaddaş", "Xarici yaddaş"]);
    expect(pagesOf(out, chunks)).toEqual([[1, 4], [5, 9], [10, 14]]);
  });

  it("splits evenly when there are no headings", () => {
    const chunks = onePerPage(12);
    const out = balanceTopics([{ from: 0, title: "Prosessor" }], chunks, opts);
    expect(out.map((t) => t.title)).toEqual(["Prosessor", "Prosessor (2)"]);
    expect(pagesOf(out, chunks)).toEqual([[1, 6], [7, 12]]);
  });

  it("merges a one-page topic into its smaller neighbour", () => {
    const chunks = onePerPage(10);
    const out = balanceTopics(
      [
        { from: 0, title: "Periferiya hissəsi" },
        { from: 5, title: "Ana plata" },
        { from: 6, title: "Sistem bloku" },
      ],
      chunks,
      opts,
    );
    expect(out.map((t) => t.title)).toEqual(["Periferiya hissəsi", "Ana plata və sistem bloku"]);
    expect(pagesOf(out, chunks)).toEqual([[1, 5], [6, 10]]);
  });

  it("is configurable (0 = never split or merge)", () => {
    const chunks = onePerPage(12);
    const starts = [{ from: 0, title: "A" }, { from: 1, title: "B" }];
    expect(balanceTopics(starts, chunks, { ...opts, minPages: 0, maxPages: 0 })).toEqual(starts);
    const short = balanceTopics(starts, chunks, { ...opts, maxPages: 3 });
    expect(short.length).toBeGreaterThan(3);
    expect(pagesOf(short, chunks).every(([from, to]) => to - from + 1 <= 3)).toBe(true);
  });

  it("keeps within the topic cap", () => {
    const chunks = onePerPage(60);
    expect(balanceTopics([{ from: 0, title: "A" }], chunks, { ...opts, maxTopics: 5 }).length).toBeLessThanOrEqual(5);
  });
});

describe("OCR page report", () => {
  const ocr = (page: number, text: string, quality: number) => ({ page, text, quality });

  it("names picture pages instead of counting them as poor recognition", () => {
    const report = pageReport(
      [ocr(5, "Prosessor ".repeat(40), 30), ocr(6, "Şəkil 2. Sxem", 20), ocr(7, "Yaddaş ".repeat(40), 90)],
      [9],
      [12, 13],
    );
    expect(report).toEqual({ low: [5], image: [6], failed: [9], skipped: [12, 13] });
  });

  it("asks for a review only when a meaningful share of pages is poor", () => {
    expect(reviewNeeded(0, 10)).toBe(false);
    expect(reviewNeeded(1, 42)).toBe(false);
    expect(reviewNeeded(3, 42)).toBe(false);
    expect(reviewNeeded(5, 42)).toBe(true);
    expect(reviewNeeded(1, 3)).toBe(true);
  });

  it("lists pages compactly", () => {
    expect(pageList([5, 9, 12])).toBe("5, 9, 12");
    expect(pageList([3, 5, 6, 7, 12])).toBe("3, 5–7, 12");
    expect(pageList(Array.from({ length: 30 }, (_, i) => i * 2 + 1), 3)).toBe("1, 3, 5, …");
  });
});
