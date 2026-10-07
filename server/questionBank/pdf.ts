import { PDFDocument } from "pdf-lib";
import { AppError } from "../modules/errors";

/** Encrypted or damaged files are reported as unreadable rather than half-processed. */
async function load(bytes: Uint8Array) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    throw new AppError("IMPORT_PDF_UNREADABLE");
  }
}

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  return (await load(bytes)).getPageCount();
}

/** A new PDF holding pages `from`..`to` (1-based, inclusive), so each model request stays small. */
export async function pdfSlice(bytes: Uint8Array, from: number, to: number): Promise<Uint8Array> {
  const source = await load(bytes);
  const out = await PDFDocument.create();
  const indexes = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  for (const page of await out.copyPages(source, indexes)) out.addPage(page);
  return out.save();
}

/** Text of each page (empty for scanned pages); used for providers that cannot read PDFs. */
export async function pdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t) => t.replace(/[ \t]+\n/g, "\n").trim());
  } catch {
    throw new AppError("IMPORT_PDF_UNREADABLE");
  }
}
