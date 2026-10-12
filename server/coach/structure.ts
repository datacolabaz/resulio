import type { CoachLocale } from "../../shared/coach";
import { chunkPages, type DraftChunk, type PageText } from "./chunker";
import { foldText } from "./retrieval";

/**
 * The shape of a material before topics are made (pure): front matter (title/author page, table
 * of contents, preface), the table of contents as topic boundaries, readable titles (sentence case
 * with Azerbaijani İ/i and I/ı, never a person's name) and topics of balanced length.
 */

const lowerAz = (s: string) => s.toLocaleLowerCase("az");
const upperAz = (s: string) => s.toLocaleUpperCase("az");
const lettersOf = (s: string) => (s.match(/\p{L}/gu) ?? []).length;
const linesOf = (s: string) => s.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

// `\b` only knows ASCII letters: word edges are spelled out so Cyrillic and ə/ş/ğ work.
const TOC_TITLE = /^(mündəricat|mündəricə|mündərəcat|mundericat|içindəkilər|содержание|оглавление|contents|table of contents)(?![\p{L}\p{N}])/u;
const PREFACE_TITLE = /^(ön ?söz|annotasiya|rəy|rəyçi(lər)?|elmi redaktor|redaktor|предисловие|аннотация|рецензент(ы)?|от автора|preface|foreword|abstract|acknowledg(e)?ments?)(?![\p{L}\p{N}])/u;
const BIBLIOGRAPHY = /^(ədəbiyyat|istifadə (olunmuş|edilmiş) ədəbiyyat|литература|список литературы|библиография|references|bibliography)(?![\p{L}\p{N}])/u;
const TITLE_PAGE_SIGNS = /(?<![\p{L}\p{N}])(universitet|kafedra|fakültə|nazirliyi|müəllif|tərtib|dərs vəsaiti|mühazirə|metodik|bakı|университет|кафедра|министерство|автор|составител|учебное пособие|лекци|university|department|faculty|ministry|author|lecture notes|textbook)/u;
const YEAR = /\b(19|20)\d{2}\b/;

/** A line of a table of contents: a title, dot leaders or spaces, a page number. */
const TOC_LINE = /^(.*?\p{L}.*?)(?:\s*[.·…_\-–—]{2,}\s*|\s+)(\d{1,4})$/u;

/** "1.", "2.3", "§4", "IV.", "Mövzu 3:", "Тема 2.", "Chapter 5 -" at the start of a title. */
export function stripNumbering(title: string): string {
  const stripped = title
    .replace(/^(mövzu|fəsil|bölmə|mühazirə|тема|глава|раздел|лекция|topic|chapter|section|lecture)\s*(№\s*)?\d+[.):\s–—-]*/iu, "")
    .replace(/^(\d+(\.\d+)*[.)]?|§\s*\d+|[IVXLC]+[.)])\s+/u, "")
    .trim();
  // "Fəsil 2" alone is the whole title, not a prefix.
  return lettersOf(stripped) ? stripped : title.trim();
}

export interface TocEntry {
  title: string;
  /** The page number printed in the table of contents. */
  page: number;
}

export function tocEntriesOf(text: string): TocEntry[] {
  const out: TocEntry[] = [];
  for (const line of linesOf(text)) {
    const m = TOC_LINE.exec(line);
    if (!m) continue;
    const title = stripNumbering(m[1]).replace(/[\s.·…_\-–—]+$/u, "").trim();
    if (lettersOf(title) < 3 || title.length > 120 || TOC_TITLE.test(lowerAz(title))) continue;
    out.push({ title, page: Number(m[2]) });
  }
  return out;
}

const nonDecreasing = (entries: TocEntry[]) => entries.every((e, i) => i === 0 || e.page >= entries[i - 1].page);

/** A table-of-contents page: titled "Mündəricat"/"Содержание"/"Contents", or mostly "title … page" lines. */
export function isTocPage(text: string): boolean {
  const lines = linesOf(text);
  const entries = tocEntriesOf(text);
  const titled = lines.slice(0, 3).some((l) => TOC_TITLE.test(lowerAz(l)));
  if (titled && entries.length >= 2) return true;
  return entries.length >= 5 && entries.length >= lines.length * 0.6 && nonDecreasing(entries);
}

/** Pages below this many letters at the start of a material are a cover, a title or a blank page. */
export const SHORT_PAGE_LETTERS = 250;
/** A preface with at least this much text is kept as an introduction topic. */
export const INTRO_MIN_LETTERS = 600;

export type FrontKind = "SKIP" | "INTRO";

export interface FrontMatter {
  /** Leading pages (by position in `pages`) that are front matter, with what to do with each. */
  kinds: FrontKind[];
  toc: TocEntry[];
  /** Names found on the title page (the author): never a topic title. */
  names: string[];
}

/**
 * Front matter at the start of a material: cover/title/author pages (short, or with institution,
 * author and year signs), table-of-contents pages, and a preface (kept as "Giriş" only when it
 * has real content). Stops at the first page of content; looks at most at the first 15 pages and
 * never takes every page.
 */
export function frontMatterOf(pages: Pick<PageText, "text">[]): FrontMatter {
  const kinds: FrontKind[] = [];
  const toc: TocEntry[] = [];
  const names: string[] = [];
  const limit = Math.min(15, Math.max(0, pages.length - 1), Math.ceil(pages.length * 0.4));
  // Slides are short pages of content: "short" is relative to the material's typical page.
  const sorted = pages.map((p) => lettersOf(p.text)).sort((a, b) => a - b);
  const short = Math.min(SHORT_PAGE_LETTERS, Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 0.3));
  let inToc = false;
  for (let i = 0; i < limit; i++) {
    const text = pages[i].text;
    const lines = linesOf(text);
    const first = lowerAz(lines[0] ?? "");
    const letters = lettersOf(text);
    const entries = tocEntriesOf(text);
    if (isTocPage(text) || (inToc && entries.length >= 3 && entries.length >= lines.length * 0.5)) {
      toc.push(...entries);
      kinds.push("SKIP");
      inToc = true;
      continue;
    }
    inToc = false;
    if (PREFACE_TITLE.test(first)) {
      kinds.push(letters >= INTRO_MIN_LETTERS ? "INTRO" : "SKIP");
      continue;
    }
    const titlePage = letters < short || (letters < 900 && TITLE_PAGE_SIGNS.test(lowerAz(text)) && (YEAR.test(text) || lines.some(looksLikePersonName)));
    if (!titlePage) break;
    names.push(...lines.filter(looksLikePersonName));
    kinds.push("SKIP");
  }
  return { kinds, toc: nonDecreasingRun(toc), names };
}

/** The entries in order, dropping any whose page goes backwards (a sub-list or a misread line). */
function nonDecreasingRun(entries: TocEntry[]): TocEntry[] {
  const out: TocEntry[] = [];
  for (const e of entries) if (!out.length || e.page >= out.at(-1)!.page) out.push(e);
  return out;
}

export interface MaterialChunks {
  chunks: DraftChunk[];
  /** Chunk range of a preface with real content (the "Giriş" topic), inclusive. */
  intro: { from: number; to: number } | null;
  /** First chunk of the content; topics are made from chunks[bodyFrom..]. */
  bodyFrom: number;
}

/**
 * Chunks with front matter kept apart: front pages are chunked on their own so no chunk mixes a
 * table of contents with the first page of content. Front matter chunks belong to no topic.
 */
export function chunkMaterial(pages: PageText[], front: Pick<FrontMatter, "kinds">): MaterialChunks {
  const kinds = front.kinds.length < pages.length ? front.kinds : [];
  const chunks: DraftChunk[] = [];
  const push = (part: DraftChunk[]) => {
    const start = chunks.length;
    for (const c of part) chunks.push({ ...c, ord: chunks.length });
    return { from: start, to: chunks.length - 1 };
  };
  let intro: MaterialChunks["intro"] = null;
  for (let i = 0; i < kinds.length; ) {
    let j = i;
    while (j < kinds.length && kinds[j] === kinds[i]) j++;
    const range = push(chunkPages(pages.slice(i, j)));
    if (kinds[i] === "INTRO" && !intro && range.to >= range.from) intro = range;
    i = j;
  }
  const bodyFrom = chunks.length;
  push(chunkPages(pages.slice(kinds.length)));
  if (bodyFrom >= chunks.length) return { chunks: chunkPages(pages), intro: null, bodyFrom: 0 };
  return { chunks, intro, bodyFrom };
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const NAME_SUFFIX = /(ov|ova|yev|yeva|ev|eva|zadə|zade|bəyli|ов|ова|ев|ева|ин|ина|ский|ская|ович|овна|евич|евна)$/u;
const ACADEMIC = /(^|\s)(prof|dos|dosent|professor|baş müəllim|müəllim|t\.?\s?e\.?\s?n|f\.?-?r\.?\s?e\.?\s?d|k\.?\s?t\.?\s?n|доц|проф|к\.\s?т\.\s?н)(\.|\s|$)/iu;

/** "İlkin Abbasov", "A. B. Məmmədov", "Əli Vəli oğlu", "dos. Həsənov", "Иванов И.И." — not a topic. */
export function looksLikePersonName(title: string): boolean {
  const s = title.replace(/\s+/g, " ").trim();
  if (!s || s.length > 60 || /\d/.test(s)) return false;
  const words = s.replace(/[.,]/g, " ").split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  if (ACADEMIC.test(lowerAz(s)) && words.some((w) => /^\p{Lu}\p{Ll}+$/u.test(w))) return true;
  const patronymic = (w: string) => /^(oğlu|qızı|oglu|qizi)$/iu.test(w);
  if (!words.every((w) => /^\p{Lu}/u.test(w) || patronymic(w))) return false;
  if (words.some(patronymic)) return true;
  const initials = words.filter((w) => /^\p{Lu}$/u.test(w)).length;
  const full = words.filter((w) => /^\p{Lu}\p{Ll}{1,}$/u.test(w));
  if (initials && full.length >= 1 && initials + full.length === words.length) return true;
  return words.length <= 3 && full.length === words.length && full.slice(1).some((w) => NAME_SUFFIX.test(lowerAz(w)));
}

/**
 * How words are written mid-sentence in the material: "Neyman" stays capitalised and "USB"/"EHM"
 * stay upper case when an all-caps heading is turned into sentence case. Key: lower-cased word.
 */
export function casingHints(texts: string[], maxChars = 300_000): Map<string, string> {
  const counts = new Map<string, { lower: number; title: number; upper: number; titleForm: string; upperForm: string }>();
  let seen = 0;
  for (const text of texts) {
    if (seen > maxChars) break;
    seen += text.length;
    for (const line of text.split("\n")) {
      // An all-caps heading says nothing about how its words are written.
      const letters = line.replace(/[^\p{L}]/gu, "");
      if (letters.length >= 4 && letters === upperAz(letters)) continue;
      for (const m of line.matchAll(/(^|[^\p{L}\p{M}])(\p{L}[\p{L}\p{M}]*)/gu)) {
        const word = m[2];
        const start = (m.index ?? 0) + m[1].length;
        const last = line.slice(Math.max(0, start - 6), start).trimEnd();
        // Sentence and line starts are capitalised anyway: they say nothing about the word.
        if (!last || /[.!?:;•\-–—]$/u.test(last)) continue;
        const key = lowerAz(word);
        const c = counts.get(key) ?? { lower: 0, title: 0, upper: 0, titleForm: "", upperForm: "" };
        if (word === key) c.lower++;
        else if (word.length >= 2 && word === upperAz(word)) (c.upper++, (c.upperForm = word));
        else if (word[0] === upperAz(word[0]) && word.slice(1) === lowerAz(word.slice(1))) (c.title++, (c.titleForm = word));
        counts.set(key, c);
      }
    }
  }
  const hints = new Map<string, string>();
  for (const [key, c] of counts) {
    if (c.upper >= 2 && c.upper > c.lower + c.title && key.length <= 6) hints.set(key, c.upperForm);
    else if (c.title >= 2 && c.title > c.lower * 2) hints.set(key, c.titleForm);
  }
  return hints;
}

const capitalise = (s: string) => (s ? upperAz(s[0]) + s.slice(1) : s);

/** One word of an all-caps title in sentence case: the material's own spelling, else lower case. */
function recase(word: string, hints: Map<string, string>): string {
  const m = /^([^\p{L}]*)([\p{L}\p{M}'’-]*)(.*)$/u.exec(word);
  if (!m || !m[2]) return word;
  const core = m[2]
    .split(/([-'’])/)
    .map((part) => (/^[-'’]$/.test(part) || !part ? part : (hints.get(lowerAz(part)) ?? lowerAz(part))))
    .join("");
  return m[1] + core + m[3];
}

/** "Periferiya Hissəsi": every word capitalised, which Azerbaijani and Russian titles never are. */
function isTitleCase(words: string[]): boolean {
  const lettered = words.map((w) => w.replace(/[^\p{L}]/gu, "")).filter(Boolean);
  return lettered.length >= 2 && lettered.every((w) => /^\p{Lu}\p{Ll}+$/u.test(w));
}

/**
 * A short, readable topic title: numbering and trailing punctuation removed, ALL CAPS turned into
 * sentence case (Azerbaijani-aware, the material's own spelling for names and acronyms), first
 * letter capitalised, at most `max` characters cut at a word.
 */
export function normalizeTitle(raw: string, hints: Map<string, string> = new Map(), max = 80): string {
  let s = stripNumbering(raw.replace(/\s+/g, " ").trim())
    .replace(/^["'«“„]+|["'»”]+$/gu, "")
    .replace(/[\s.:;,–—-]+$/u, "")
    .trim();
  const letters = s.replace(/[^\p{L}]/gu, "");
  const allCaps = letters.length >= 4 && letters === upperAz(letters) && letters !== lowerAz(letters);
  const words = s.split(" ");
  if (allCaps && !(words.length === 1 && letters.length <= 5)) s = words.map((w) => recase(w, hints)).join(" ");
  else if (isTitleCase(words)) s = words.map((w, i) => (i === 0 ? w : recase(w, hints))).join(" ");
  s = capitalise(s);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/u, "")}…`;
}

const INTRO_TITLE: Record<CoachLocale, string> = { az: "Giriş", en: "Introduction", ru: "Введение" };
const TOPIC_WORD: Record<CoachLocale, string> = { az: "Mövzu", en: "Topic", ru: "Тема" };
const AND: Record<CoachLocale, string> = { az: "və", en: "and", ru: "и" };
export const introTitle = (locale: CoachLocale) => INTRO_TITLE[locale];

export const topicWord = (locale: CoachLocale) => TOPIC_WORD[locale];
/** Longest proposed title kept (table of contents, model, heading); longer is a sentence, not a heading. */
export const TITLE_MAX_WORDS = 12;
/** A heading found in the text names a topic only when it is this short. */
export const HEADING_TITLE_MAX_WORDS = 8;
/** Titles the model writes for topics without a heading. */
export const AI_TITLE_MAX_WORDS = 6;

/**
 * A proposed title as shown, or "" when it is no title: empty, cut off ("…"), a sentence (too many
 * words), a person's name, a table-of-contents label or just a number.
 */
export function usableTitle(raw: string, hints: Map<string, string>, names: string[] = [], maxWords = TITLE_MAX_WORDS): string {
  const line = raw.replace(/\s+/g, " ").trim();
  if (!line || /(…|\.\.\.)$/u.test(line)) return "";
  const title = normalizeTitle(line, hints, Number.POSITIVE_INFINITY);
  const banned = new Set(names.map((n) => foldText(n)));
  const words = title.split(" ").filter(Boolean).length;
  if (words > maxWords || title.length > 90 || lettersOf(title) < 3 || /^\d+$/.test(title)) return "";
  if (looksLikePersonName(title) || banned.has(foldText(title)) || TOC_TITLE.test(lowerAz(title))) return "";
  return title;
}

/** The topic's first real heading when the proposed title is no title; "" when it has none (never a sentence of its text). */
export function contentTitle(chunks: Pick<DraftChunk, "heading" | "text">[], hints: Map<string, string>, names: string[] = []): string {
  for (const c of chunks) {
    const title = c.heading ? usableTitle(c.heading, hints, names, HEADING_TITLE_MAX_WORDS) : "";
    if (title) return title;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Topic boundaries
// ---------------------------------------------------------------------------

export interface TopicStart {
  /** First chunk (index into the body chunks). */
  from: number;
  title: string;
}

const sameTitle = (a: string, b: string) => {
  const fa = foldText(stripNumbering(a));
  const fb = foldText(stripNumbering(b));
  if (!fa || !fb) return false;
  const n = Math.min(fa.length, fb.length, 30);
  return n >= 6 && fa.slice(0, n) === fb.slice(0, n);
};

/**
 * Topic starts from the table of contents: an entry starts where its title appears as a heading,
 * otherwise at its printed page shifted by the offset the found headings show (printed page 1 is
 * often PDF page 5). Null when the table cannot be matched to the text.
 */
export function tocStarts(toc: TocEntry[], body: Pick<DraftChunk, "pageFrom" | "pageTo" | "heading" | "text">[]): TopicStart[] | null {
  const entries = toc.filter((e) => !BIBLIOGRAPHY.test(lowerAz(e.title)));
  if (entries.length < 2 || !body.length) return null;
  const found = new Map<number, number>();
  let cursor = 0;
  entries.forEach((e, i) => {
    for (let c = cursor; c < body.length; c++) {
      const chunk = body[c];
      const head = chunk.heading || linesOf(chunk.text)[0] || "";
      if (sameTitle(head, e.title) || (foldText(e.title).length >= 8 && foldText(chunk.text.slice(0, 160)).startsWith(foldText(e.title).slice(0, 30)))) {
        found.set(i, c);
        cursor = c + 1;
        return;
      }
    }
  });
  const offsets = new Map<number, number>();
  for (const [i, c] of found) {
    const d = body[c].pageFrom - entries[i].page;
    offsets.set(d, (offsets.get(d) ?? 0) + 1);
  }
  const offset = offsets.size ? [...offsets.entries()].sort((a, b) => b[1] - a[1])[0][0] : body[0].pageFrom - entries[0].page;
  const lastPage = body.at(-1)!.pageTo;
  const starts: TopicStart[] = [];
  let mapped = 0;
  entries.forEach((e, i) => {
    let from = found.get(i);
    if (from === undefined) {
      const target = e.page + offset;
      if (target > lastPage) return;
      from = body.findIndex((c) => c.pageFrom >= target);
      if (from === -1) return;
    }
    mapped++;
    // Entries on the same page (sub-sections) collapse into the first.
    if (starts.length && from <= starts.at(-1)!.from) return;
    starts.push({ from, title: e.title });
  });
  if (starts.length < 2 || mapped < entries.length * 0.6) return null;
  starts[0] = { ...starts[0], from: 0 };
  return starts;
}

export interface BalanceOptions {
  /** Topics shorter than this are merged into a neighbour (0 = never). */
  minPages: number;
  /** Topics longer than this are split at headings (0 = never). */
  maxPages: number;
  maxTopics: number;
  locale: CoachLocale;
  hints?: Map<string, string>;
}

interface Span extends TopicStart {
  to: number;
  /** The titles merged into this topic with their page counts, biggest first decides. */
  parts: { title: string; pages: number }[];
}

const pagesOf = (chunks: Pick<DraftChunk, "pageFrom" | "pageTo">[], from: number, to: number) => chunks[to].pageTo - chunks[from].pageFrom + 1;

function spansOf(starts: TopicStart[], chunks: Pick<DraftChunk, "pageFrom" | "pageTo">[]): Span[] {
  return starts.map((s, i) => {
    const to = i + 1 < starts.length ? starts[i + 1].from - 1 : chunks.length - 1;
    return { ...s, to, parts: [{ title: s.title, pages: pagesOf(chunks, s.from, to) }] };
  });
}

const headingStart = (chunks: Pick<DraftChunk, "heading">[], j: number) => !!chunks[j].heading && chunks[j].heading !== chunks[j - 1]?.heading;

/** Splits one long topic into parts of about equal pages, at headings when there is one near the cut. */
function splitSpan(span: Span, chunks: Pick<DraftChunk, "pageFrom" | "pageTo" | "heading">[], maxPages: number, hints: Map<string, string>): Span[] {
  const pages = pagesOf(chunks, span.from, span.to);
  if (pages <= maxPages || span.to <= span.from) return [span];
  const parts = Math.ceil(pages / maxPages);
  const first = chunks[span.from].pageFrom;
  const cuts: number[] = [];
  for (let k = 1; k < parts; k++) {
    const want = first + Math.round((k * pages) / parts);
    const after = cuts.at(-1) ?? span.from;
    let best = -1;
    for (let j = after + 1; j <= span.to; j++) {
      const p = chunks[j].pageFrom;
      if (p >= want - 1 && p <= want + 1 && headingStart(chunks, j)) {
        best = j;
        break;
      }
    }
    if (best === -1) best = chunks.findIndex((c, j) => j > after && j <= span.to && c.pageFrom >= want);
    if (best !== -1 && best > after) cuts.push(best);
  }
  if (!cuts.length) return [span];
  const bounds = [span.from, ...cuts];
  let numbered = 1;
  return bounds.map((from, i) => {
    const to = i + 1 < bounds.length ? bounds[i + 1] - 1 : span.to;
    const heading = chunks[from].heading;
    const own = i > 0 && headingStart(chunks, from) && heading && !sameTitle(heading, span.title) && !looksLikePersonName(heading);
    const title = i === 0 ? span.title : own ? usableTitle(heading, hints, [], HEADING_TITLE_MAX_WORDS) || (span.title && `${span.title} (${++numbered})`) : span.title && `${span.title} (${++numbered})`;
    return { from, to, title, parts: [{ title, pages: pagesOf(chunks, from, to) }] };
  });
}

function joinTitle(all: Span["parts"], locale: CoachLocale, hints: Map<string, string>): string {
  const parts = all.filter((p) => p.title);
  if (!parts.length) return "";
  if (parts.length === 2) {
    const [a, b] = parts;
    const firstWord = b.title.split(" ")[0] ?? "";
    const keep = hints.has(lowerAz(firstWord)) || (firstWord.length >= 2 && firstWord === upperAz(firstWord));
    const second = keep ? b.title : lowerAz(b.title[0] ?? "") + b.title.slice(1);
    const joined = `${a.title} ${AND[locale]} ${second}`;
    if (joined.length <= 70) return joined;
  }
  return [...parts].sort((x, y) => y.pages - x.pages)[0].title;
}

function mergeSpans(a: Span, b: Span): Span {
  return { from: a.from, to: b.to, title: a.title, parts: [...a.parts, ...b.parts] };
}

/**
 * Topics of a sensible length: long ones split at headings (or evenly), short ones merged into
 * the smaller neighbour when the result stays within `maxPages`, and at most `maxTopics`.
 */
export function balanceTopics(starts: TopicStart[], chunks: Pick<DraftChunk, "pageFrom" | "pageTo" | "heading">[], opts: BalanceOptions): TopicStart[] {
  if (!starts.length || !chunks.length) return starts;
  const hints = opts.hints ?? new Map<string, string>();
  const span = chunks.at(-1)!.pageTo - chunks[0].pageFrom + 1;
  const maxPages = opts.maxPages > 0 ? Math.max(opts.maxPages, Math.ceil(span / opts.maxTopics)) : 0;
  let spans = spansOf(starts, chunks);
  if (maxPages > 0) spans = spans.flatMap((s) => splitSpan(s, chunks, maxPages, hints));
  const size = (s: Span) => pagesOf(chunks, s.from, s.to);
  if (opts.minPages > 0) {
    const kept = new Set<Span>();
    for (;;) {
      const small = spans.filter((s) => size(s) < opts.minPages && !kept.has(s)).sort((a, b) => size(a) - size(b))[0];
      if (!small || spans.length < 2) break;
      const i = spans.indexOf(small);
      const options = [i - 1, i + 1]
        .filter((j) => j >= 0 && j < spans.length)
        .map((j) => ({ j, merged: j < i ? mergeSpans(spans[j], small) : mergeSpans(small, spans[j]) }))
        .filter((o) => maxPages === 0 || size(o.merged) <= maxPages)
        .sort((x, y) => size(spans[x.j]) - size(spans[y.j]));
      if (!options.length) {
        kept.add(small);
        continue;
      }
      const { j, merged } = options[0];
      spans.splice(Math.min(i, j), 2, merged);
    }
  }
  while (spans.length > opts.maxTopics) {
    let best = 0;
    for (let i = 1; i < spans.length - 1; i++) if (size(spans[i]) + size(spans[i + 1]) < size(spans[best]) + size(spans[best + 1])) best = i;
    spans.splice(best, 2, mergeSpans(spans[best], spans[best + 1]));
  }
  return spans.map((s) => ({ from: s.from, title: s.parts.length > 1 ? joinTitle(s.parts, opts.locale, hints) : s.title }));
}

/**
 * Final titles: a real heading (proposed, else the topic's own first heading), normalised; "" when
 * there is none — `titleUntitled` (materials.ts) then asks for a short one.
 */
export function finishTitles(starts: TopicStart[], chunks: Pick<DraftChunk, "heading" | "text">[], opts: { hints: Map<string, string>; names?: string[]; locale: CoachLocale }): TopicStart[] {
  return starts.map((s, i) => {
    const to = i + 1 < starts.length ? starts[i + 1].from : chunks.length;
    return { from: s.from, title: usableTitle(s.title, opts.hints, opts.names) || contentTitle(chunks.slice(s.from, to), opts.hints, opts.names) };
  });
}
