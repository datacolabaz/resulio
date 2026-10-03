import { inflateRawSync } from "node:zlib";
import { extensionOf } from "./files";

/**
 * Plain-text extraction for submission pre-review. Handles .txt/.csv directly and the Office Open
 * XML formats (.docx, .pptx, .xlsx) through a minimal ZIP reader. PDF, legacy .doc/.ppt/.xls and
 * images are reported as unsupported — the teacher reviews those by hand.
 */

export const MAX_EXTRACTED_CHARS = 100_000;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

export type ExtractResult = { ok: true; text: string } | { ok: false; reason: "UNSUPPORTED_TYPE" | "UNREADABLE" };

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function zipEntries(buf: Buffer): ZipEntry[] {
  const minEocd = 22;
  if (buf.length < minEocd) throw new Error("not a zip");
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - minEocd - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLen > buf.length) throw new Error("bad central directory");
    entries.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      localHeaderOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localHeaderOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new Error("bad local header");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error("truncated entry");
  const raw = buf.subarray(start, end);
  if (entry.method === 0) {
    if (raw.length > MAX_ENTRY_BYTES) throw new Error("entry too large");
    return raw;
  }
  if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new Error("unsupported compression");
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** Paragraph/line ends become newlines; every other tag is dropped. */
export function officeXmlToText(xml: string): string {
  const text = xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>|<a:br\/>|<\/w:p>|<\/a:p>|<\/si>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeXmlEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const slideNumber = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

function officeText(buf: Buffer, ext: string): string {
  const entries = zipEntries(buf);
  let parts: ZipEntry[];
  if (ext === ".docx") parts = entries.filter((e) => e.name === "word/document.xml");
  else if (ext === ".pptx") parts = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => slideNumber(a.name) - slideNumber(b.name));
  else parts = entries.filter((e) => e.name === "xl/sharedStrings.xml");
  if (!parts.length) throw new Error("no text part");
  return parts.map((e) => officeXmlToText(readEntry(buf, e).toString("utf8"))).join("\n\n");
}

export function extractSubmissionText(fileName: string, buf: Buffer): ExtractResult {
  const ext = extensionOf(fileName);
  try {
    let text: string;
    if (ext === ".txt" || ext === ".csv") text = buf.toString("utf8").replace(/^\uFEFF/, "");
    else if (ext === ".docx" || ext === ".pptx" || ext === ".xlsx") text = officeText(buf, ext);
    else return { ok: false, reason: "UNSUPPORTED_TYPE" };
    return { ok: true, text: text.slice(0, MAX_EXTRACTED_CHARS) };
  } catch {
    return { ok: false, reason: "UNREADABLE" };
  }
}
