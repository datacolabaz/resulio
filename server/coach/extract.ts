import { COACH_DEFAULT_LIMITS } from "../../shared/coach";
import { extensionOf } from "../modules/files";
import { officeParts } from "../modules/textExtract";
import { pdfPageCount, pdfPageTexts } from "../questionBank/pdf";
import { normalizeText, virtualPages } from "./chunker";

/**
 * Pages of a coach material file. Text PDFs, DOCX, PPTX and TXT are read directly; PDF pages
 * without a text layer (scans) and images are reported for OCR.
 */

export class IngestError extends Error {
  constructor(public readonly code: "TOO_MANY_PAGES" | "FILE_TOO_LARGE" | "UNREADABLE" | "FILE_TYPE" | "NO_TEXT" | "OCR_LIMIT" | "OCR_UNSUPPORTED") {
    super(code);
  }
}

export type SourcePages =
  /** `texts[i]` is page i+1; `scanned` lists 1-based pages to read with OCR. */
  | { kind: "pages"; isPdf: boolean; texts: string[]; scanned: number[] }
  | { kind: "image" };

/** A page with fewer letters/digits than this has no usable text layer. */
export const SCANNED_PAGE_MIN_CHARS = 30;
/** At least this share of pages with a real text layer makes a PDF a "text PDF". */
export const TEXT_PDF_SHARE = 0.5;

const lettersOf = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "").length;
export const isScannedText = (text: string) => lettersOf(text) < SCANNED_PAGE_MIN_CHARS;

/**
 * Pages to send to OCR. In a scanned PDF every page with (nearly) no text layer; in a text PDF only
 * pages with no text at all — a title slide, a figure with a caption or a short closing page keeps
 * its few words instead of costing an OCR call (and a text PDF never waits on OCR for them).
 */
export function scannedPagesOf(texts: string[]): number[] {
  const letters = texts.map(lettersOf);
  const withText = letters.filter((n) => n >= SCANNED_PAGE_MIN_CHARS).length;
  const textPdf = texts.length > 0 && withText >= texts.length * TEXT_PDF_SHARE;
  return letters.flatMap((n, i) => ((textPdf ? n === 0 : n < SCANNED_PAGE_MIN_CHARS) ? [i + 1] : []));
}

export const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/** The file starts like its extension says (checked again after a direct upload, which the server never saw). */
export function looksLike(ext: string, bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024));
  if (ext === ".pdf") return head.includes("%PDF-");
  if (ext === ".docx" || ext === ".pptx") return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (ext === ".png") return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === ".jpg" || ext === ".jpeg") return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (ext === ".txt") return !head.includes(0);
  return false;
}

export async function extractSource(fileName: string, bytes: Buffer, maxPages = COACH_DEFAULT_LIMITS.maxPages): Promise<SourcePages> {
  const ext = extensionOf(fileName);
  if (!looksLike(ext, bytes)) throw new IngestError("FILE_TYPE");
  if (IMAGE_MIME[ext]) return { kind: "image" };
  const textPages = (texts: string[]): SourcePages => {
    if (texts.length > maxPages) throw new IngestError("TOO_MANY_PAGES");
    return { kind: "pages", isPdf: false, texts, scanned: [] };
  };
  if (ext === ".txt") return textPages(virtualPages(bytes.toString("utf8").replace(/^\uFEFF/, "")));
  if (ext === ".docx" || ext === ".pptx") {
    let parts: string[];
    try {
      parts = officeParts(bytes, ext);
    } catch {
      throw new IngestError("UNREADABLE");
    }
    if (ext === ".docx") return textPages(virtualPages(parts.join("\n\n")));
    return textPages(parts.map(normalizeText));
  }
  if (ext === ".pdf") {
    let count: number;
    let texts: string[];
    try {
      count = await pdfPageCount(bytes);
      if (count > maxPages) throw new IngestError("TOO_MANY_PAGES");
      texts = (await pdfPageTexts(bytes)).map(normalizeText);
    } catch (error) {
      if (error instanceof IngestError) throw error;
      throw new IngestError("UNREADABLE");
    }
    while (texts.length < count) texts.push("");
    return { kind: "pages", isPdf: true, texts, scanned: scannedPagesOf(texts) };
  }
  throw new IngestError("FILE_TYPE");
}
