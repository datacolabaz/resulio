import type { Cite } from "../../shared/coach";

/**
 * In-process retrieval and citation checks over a material's chunks (pure). MySQL 9 Community has
 * no vector distance function, and a student's material is small, so BM25 over tokens is enough.
 */

export interface RetrievalChunk {
  id: string;
  ord: number;
  pageFrom: number;
  pageTo: number;
  heading: string;
  text: string;
}

/** Lowercase, letters/digits only, diacritics folded (ə→e, ı→i, ş→s …) so spelling variants match. */
export function foldText(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .replace(/ə/g, "e")
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const STOP = new Set(
  "ve ile bu o da de ki bir ucun her ne nedir kimi olan olur edir the a an of to in and or is are for on with by as at be it this that what how why и в во на с по для что как это или не".split(" "),
);

export function tokenize(text: string): string[] {
  return foldText(text)
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 6 ? w.slice(0, 6) : w));
}

/** BM25 scores of every chunk for the query (k1 = 1.4, b = 0.75). */
export function bm25(chunks: RetrievalChunk[], query: string, k1 = 1.4, b = 0.75): number[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !chunks.length) return chunks.map(() => 0);
  const docs = chunks.map((c) => tokenize(`${c.heading} ${c.text}`));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    return q.reduce((score, t) => {
      const f = tf.get(t) ?? 0;
      if (!f) return score;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
      return score + idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }, 0);
  });
}

/**
 * The chunks to put in a prompt: all of them when they fit `maxChars`, else the best BM25 matches
 * for the query, back in reading order.
 */
export function selectChunks<T extends RetrievalChunk>(chunks: T[], query: string, maxChars: number, minScore = 0): T[] {
  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  if (total <= maxChars && minScore <= 0) return chunks;
  const scores = bm25(chunks, query);
  const ranked = chunks.map((c, i) => ({ c, s: scores[i] })).filter((x) => x.s > minScore).sort((a, b) => b.s - a.s || a.c.ord - b.c.ord);
  const picked: T[] = [];
  let used = 0;
  for (const { c } of ranked) {
    if (used + c.text.length > maxChars) continue;
    picked.push(c);
    used += c.text.length;
  }
  return picked.sort((a, b) => a.ord - b.ord);
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** Quotes shorter than this (folded) cannot prove anything. */
const MIN_QUOTE_CHARS = 12;

/** Token-overlap similarity of the quote against its best window in the chunk (0..1). */
export function quoteMatch(quote: string, chunkText: string): number {
  const q = foldText(quote);
  const doc = foldText(chunkText);
  if (q.length < MIN_QUOTE_CHARS) return 0;
  if (doc.includes(q)) return 1;
  const qt = q.split(" ");
  const dt = doc.split(" ");
  if (!qt.length || dt.length < qt.length / 2) return 0;
  const want = new Map<string, number>();
  for (const t of qt) want.set(t, (want.get(t) ?? 0) + 1);
  const size = qt.length;
  let best = 0;
  for (let start = 0; start <= Math.max(0, dt.length - size); start++) {
    const have = new Map(want);
    let hit = 0;
    for (const t of dt.slice(start, start + size)) {
      const n = have.get(t) ?? 0;
      if (n > 0) hit++, have.set(t, n - 1);
    }
    best = Math.max(best, hit / size);
    if (best === 1) break;
  }
  return best;
}

export const QUOTE_MATCH_MIN = 0.85;

/**
 * Keeps only citations whose quote is really in the cited chunk (verbatim up to spacing,
 * punctuation and diacritics). The quote kept is the model's, already in the source language.
 */
export function verifyCites(raw: { chunk: string; quote: string }[] | undefined, chunks: Map<string, RetrievalChunk>): Cite[] {
  const out: Cite[] = [];
  for (const r of raw ?? []) {
    const chunk = chunks.get(String(r.chunk ?? "").trim());
    const quote = String(r.quote ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!chunk || !quote) continue;
    if (quoteMatch(quote, chunk.text) < QUOTE_MATCH_MIN) continue;
    if (out.some((c) => c.chunkId === chunk.id && c.quote === quote)) continue;
    out.push({ chunkId: chunk.id, page: chunk.pageFrom, quote });
    if (out.length >= 3) break;
  }
  return out;
}
