import { COACH_MAX_PAGES } from "../../shared/coach";
import { extensionOf } from "../modules/files";
import { officeParts } from "../modules/textExtract";
import { pdfPageCount, pdfPageTexts } from "../questionBank/pdf";
import { normalizeText, virtualPages } from "./chunker";

/**
 * Pages of a coach material file. Text PDFs, DOCX, PPTX and TXT are read directly; PDF pages
 * without a text layer (scans) and images are reported for OCR.
 */

export class IngestError extends Error {
  constructor(public readonly code: "TOO_MANY_PAGES" | "UNREADABLE" | "FILE_TYPE" | "NO_TEXT" | "OCR_LIMIT") {
    super(code);
  }
}

export type SourcePages =
  /** `texts[i]` is page i+1; `scanned` lists 1-based pages whose text layer is (nearly) empty. */
  | { kind: "pages"; isPdf: boolean; texts: string[]; scanned: number[] }
  | { kind: "image" };

/** A page with fewer letters/digits than this has no usable text layer. */
export const SCANNED_PAGE_MIN_CHARS = 30;

export const isScannedText = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "").length < SCANNED_PAGE_MIN_CHARS;

export const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

export async function extractSource(fileName: string, bytes: Buffer): Promise<SourcePages> {
  const ext = extensionOf(fileName);
  if (IMAGE_MIME[ext]) return { kind: "image" };
  if (ext === ".txt") return textPages(virtualPages(bytes.toString("utf8").replace(/^\uFEFF/, "")));
  if (ext === ".docx" || ext === ".pptx") {
    let parts: string[];
    try {
      parts = officeParts(bytes, ext);
    } catch {
      throw new IngestError("UNREADABLE");
    }
    if (ext === ".docx") return textPages(virtualPages(parts.join("\n\n")));
    if (parts.length > COACH_MAX_PAGES) throw new IngestError("TOO_MANY_PAGES");
    return textPages(parts.map(normalizeText));
  }
  if (ext === ".pdf") {
    let count: number;
    let texts: string[];
    try {
      count = await pdfPageCount(bytes);
      if (count > COACH_MAX_PAGES) throw new IngestError("TOO_MANY_PAGES");
      texts = (await pdfPageTexts(bytes)).map(normalizeText);
    } catch (error) {
      if (error instanceof IngestError) throw error;
      throw new IngestError("UNREADABLE");
    }
    while (texts.length < count) texts.push("");
    return { kind: "pages", isPdf: true, texts, scanned: texts.flatMap((t, i) => (isScannedText(t) ? [i + 1] : [])) };
  }
  throw new IngestError("FILE_TYPE");
}

function textPages(texts: string[]): SourcePages {
  if (texts.length > COACH_MAX_PAGES) throw new IngestError("TOO_MANY_PAGES");
  return { kind: "pages", isPdf: false, texts, scanned: [] };
}
