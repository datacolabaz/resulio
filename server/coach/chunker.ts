import type { ChunkMethod } from "../../shared/coach";

/**
 * Pure text shaping for coach materials: pages → chunks (the unit of retrieval and citation).
 * Formats without real pages (pasted text, DOCX, TXT) get "virtual pages" of ~3000 characters so
 * citations still point somewhere the student can find.
 */

export const VIRTUAL_PAGE_CHARS = 3000;
export const CHUNK_TARGET_CHARS = 1500;
export const CHUNK_MAX_CHARS = 2400;

export interface PageText {
  page: number;
  text: string;
  method: ChunkMethod;
  /** OCR quality score 0-100; null for text layers. */
  quality: number | null;
}

export interface DraftChunk {
  ord: number;
  pageFrom: number;
  pageTo: number;
  heading: string;
  text: string;
  method: ChunkMethod;
  quality: number | null;
}

/** Unifies line ends and spacing; drops control characters (keeps tabs and newlines). */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const paragraphsOf = (text: string) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/** Splits one long text at paragraph (or sentence) boundaries into pages of at most `size` characters. */
export function virtualPages(text: string, size = VIRTUAL_PAGE_CHARS): string[] {
  const pages: string[] = [];
  let current = "";
  for (const piece of paragraphsOf(normalizeText(text)).flatMap((p) => splitLong(p, size))) {
    if (current && current.length + piece.length + 2 > size) {
      pages.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) pages.push(current);
  return pages;
}

/** A paragraph longer than `max` split at sentence ends, or hard-cut when there are none. */
export function splitLong(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) return [paragraph];
  const sentences = paragraph.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g) ?? [paragraph];
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (s.length > max) {
      if (current) out.push(current.trim()), (current = "");
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
      continue;
    }
    if (current.length + s.length > max) out.push(current.trim()), (current = "");
    current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

/**
 * A heading-like line: short, no sentence end, and numbered ("2.1 ...", "§3", "Fəsil 4"), all caps,
 * or followed by a longer paragraph. Returns the heading text or "".
 */
export function headingOf(paragraph: string): string {
  const first = paragraph.split("\n")[0].trim();
  if (!first || first.length > 90 || first.length < 3) return "";
  if (/[.,;:!?]$/.test(first) && !/^\d+(\.\d+)*\.$/.test(first.split(" ")[0])) return "";
  const numbered = /^(\d+(\.\d+)*[.)]?|§\s*\d+|[IVXLC]+\.)\s+\S/.test(first) || /^(fəsil|bölmə|mövzu|chapter|section|topic|глава|раздел|тема)\s+\d+/i.test(first);
  const letters = first.replace(/[^\p{L}]/gu, "");
  const caps = letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  const standalone = paragraph.includes("\n") ? false : first.split(/\s+/).length <= 10;
  return numbered || caps || standalone ? first : "";
}

/**
 * Packs page paragraphs into chunks of ~CHUNK_TARGET_CHARS (never above CHUNK_MAX_CHARS). A new
 * heading starts a new chunk once the current one has some body; a chunk never mixes OCR and
 * text-layer pages so its quality stays meaningful.
 */
export function chunkPages(pages: PageText[], target = CHUNK_TARGET_CHARS, max = CHUNK_MAX_CHARS): DraftChunk[] {
  const chunks: DraftChunk[] = [];
  let cur: DraftChunk | null = null;
  let lastHeading = "";
  const flush = () => {
    if (cur && cur.text.trim()) chunks.push({ ...cur, ord: chunks.length, text: cur.text.trim() });
    cur = null;
  };
  for (const page of pages) {
    for (const para of paragraphsOf(normalizeText(page.text)).flatMap((p) => splitLong(p, max))) {
      const heading = headingOf(para);
      const c = cur as DraftChunk | null;
      const switchMethod = c && c.method !== page.method;
      const startsSection = heading && c && c.text.length >= target / 3;
      const overflow = c && c.text.length + para.length + 2 > max;
      const full = c && c.text.length >= target;
      if (c && (switchMethod || startsSection || overflow || full)) flush();
      if (heading) lastHeading = heading;
      if (!cur) {
        cur = { ord: 0, pageFrom: page.page, pageTo: page.page, heading: (heading || lastHeading).slice(0, 255), text: "", method: page.method, quality: page.quality };
      }
      const open = cur as DraftChunk;
      open.text = open.text ? `${open.text}\n\n${para}` : para;
      open.pageTo = page.page;
      if (page.quality !== null) open.quality = open.quality === null ? page.quality : Math.min(open.quality, page.quality);
    }
  }
  flush();
  return chunks;
}

/** First words of a text as a fallback title (no ellipsis inside words). */
export function titleFromText(text: string, max = 60): string {
  const line = normalizeText(text).split("\n").find((l) => l.trim().length > 2)?.trim() ?? "";
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}
