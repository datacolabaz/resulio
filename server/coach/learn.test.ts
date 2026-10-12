import { describe, expect, it } from "vitest";
import { applyEdit, finishPack, packInputHash, packMessages, promptChunks } from "./packs";
import { bm25, foldText, quoteMatch, selectChunks, tokenize, verifyCites, type RetrievalChunk } from "./retrieval";

const chunk = (ord: number, text: string, heading = ""): RetrievalChunk => ({ id: `id${ord}`, ord, pageFrom: ord + 1, pageTo: ord + 1, heading, text });

const chunks = [
  chunk(0, "Fotosintez yaşıl bitkilərdə xlorofilin iştirakı ilə işıq enerjisinin kimyəvi enerjiyə çevrilməsidir.", "Fotosintez"),
  chunk(1, "Tənəffüs zamanı qlükoza oksidləşir və ATP şəklində enerji ayrılır.", "Tənəffüs"),
  chunk(2, "Mitoxondri hüceyrənin enerji stansiyası adlanır; burada ATP sintez olunur.", "Mitoxondri"),
];

describe("retrieval", () => {
  it("folds case and Azerbaijani letters so spellings match", () => {
    expect(foldText("Əİşığ ÇÖÜ")).toBe("eisig cou");
    expect(tokenize("Fotosintez və tənəffüs")).toEqual(["fotosi", "teneff"]);
  });
  it("ranks the chunk that matches the query first", () => {
    const scores = bm25(chunks, "ATP harada sintez olunur? mitoxondri");
    expect(scores.indexOf(Math.max(...scores))).toBe(2);
    expect(bm25(chunks, "")).toEqual([0, 0, 0]);
  });
  it("keeps everything that fits, else the best matches in reading order", () => {
    expect(selectChunks(chunks, "x", 10_000)).toHaveLength(3);
    expect(selectChunks(chunks, "mitoxondri ATP", 100).map((c) => c.ord)).toEqual([2]);
    expect(selectChunks(chunks, "mitoxondri ATP", 160).map((c) => c.ord)).toEqual([1, 2]);
  });
});

describe("citation check", () => {
  it("accepts verbatim quotes up to spacing, case and punctuation", () => {
    expect(quoteMatch("işıq enerjisinin kimyəvi enerjiyə çevrilməsidir", chunks[0].text)).toBe(1);
    expect(quoteMatch("ISIQ ENERJISININ   kimyevi enerjiye", chunks[0].text)).toBe(1);
  });
  it("rejects invented or too short quotes", () => {
    expect(quoteMatch("fotosintez gecə baş verir və oksigen udulur", chunks[0].text)).toBeLessThan(0.85);
    expect(quoteMatch("ATP", chunks[2].text)).toBe(0);
  });
  it("keeps only verified citations, mapped from prompt labels to chunks", () => {
    const { byLabel, prompt } = promptChunks(chunks);
    expect(prompt.map((p) => p.id)).toEqual(["C1", "C2", "C3"]);
    const cites = verifyCites(
      [
        { chunk: "C3", quote: "hüceyrənin enerji stansiyası adlanır" },
        { chunk: "C3", quote: "ribosom zülal sintez edir və nüvədə olur" },
        { chunk: "C9", quote: "hüceyrənin enerji stansiyası adlanır" },
      ],
      byLabel,
    );
    expect(cites).toEqual([{ chunkId: "id2", page: 3, quote: "hüceyrənin enerji stansiyası adlanır" }]);
  });
});

describe("summary packs", () => {
  it("the prompt asks for the student's app language and verbatim quotes", () => {
    const { prompt } = promptChunks(chunks);
    for (const [locale, name] of [["az", "Azerbaijani"], ["en", "English"], ["ru", "Russian"]] as const) {
      const system = String(packMessages({ format: "SHORT", topicTitle: "Bio", chunks: prompt, locale, nonce: "n" })[0].content);
      expect(system).toContain(name);
      expect(system).toMatch(/verbatim/);
    }
  });
  it("the cache key changes with language, kind and text", () => {
    const base = packInputHash({ kind: "SUMMARY_SHORT", locale: "az", chunks });
    expect(packInputHash({ kind: "SUMMARY_SHORT", locale: "az", chunks })).toBe(base);
    expect(packInputHash({ kind: "SUMMARY_SHORT", locale: "ru", chunks })).not.toBe(base);
    expect(packInputHash({ kind: "SUMMARY_EXAM", locale: "az", chunks })).not.toBe(base);
    expect(packInputHash({ kind: "SUMMARY_SHORT", locale: "az", chunks: [{ ...chunks[0], text: "dəyişdi" }, chunks[1], chunks[2]] })).not.toBe(base);
  });
  it("points without a verified quote are marked as general knowledge", () => {
    const { byLabel } = promptChunks(chunks);
    const pack = finishPack(
      {
        title: " Enerji ",
        sections: [
          {
            heading: "Əsas",
            points: [
              { text: "Mitoxondri enerji verir.", cites: [{ chunk: "C3", quote: "Mitoxondri hüceyrənin enerji stansiyası adlanır" }] },
              { text: "Uydurma fakt.", cites: [{ chunk: "C1", quote: "bu cümlə materialda heç yoxdur əsla" }] },
              { text: "  ", cites: [] },
            ],
          },
          { heading: "Boş", points: [] },
        ],
        concepts: [{ term: "ATP", definition: "Enerji daşıyıcısı.", cites: [] }],
      },
      byLabel,
      "fallback",
    );
    expect(pack.title).toBe("Enerji");
    expect(pack.sections).toHaveLength(1);
    expect(pack.sections[0].points.map((p) => p.grounding)).toEqual(["MATERIAL", "GENERAL"]);
    expect(pack.concepts?.[0].grounding).toBe("GENERAL");
  });
  it("edits replace exactly one point or definition", () => {
    const content = { title: "T", sections: [{ heading: "H", points: [{ text: "a", cites: [], grounding: "GENERAL" as const }] }], concepts: [{ term: "x", definition: "d", cites: [], grounding: "GENERAL" as const }] };
    expect(applyEdit(content, { section: 0, point: 0 }, "b")?.sections[0].points[0].text).toBe("b");
    expect(applyEdit(content, { concept: 0 }, "e")?.concepts?.[0].definition).toBe("e");
    expect(applyEdit(content, { section: 1, point: 0 }, "b")).toBeNull();
    expect(content.sections[0].points[0].text).toBe("a");
  });
});
