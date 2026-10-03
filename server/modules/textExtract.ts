import { inflateRawSync } from "node:zlib";
import { extensionOf } from "./files";

/**
 * Text extraction for AI review of submissions and task attachments. Handles .txt directly, .csv
 * and .xlsx as spreadsheets (cell addresses, formulas and their cached values), and .docx/.pptx
 * through a minimal ZIP reader. PDF, legacy .doc/.ppt/.xls and images are reported as
 * unsupported — the teacher reviews those by hand.
 */

export const MAX_EXTRACTED_CHARS = 100_000;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
/** Per sheet, cells outside tables beyond this are elided from the middle. */
const MAX_LOOSE_CELLS = 600;

type ExtractFailure = { ok: false; reason: "UNSUPPORTED_TYPE" | "UNREADABLE" };
export type ExtractResult = { ok: true; text: string } | ExtractFailure;

export interface SheetCell {
  ref: string;
  row: number;
  col: number;
  /** Displayed value: cached result for formula cells, ISO text for dates. */
  value: string;
  /** Without the leading "=". */
  formula?: string;
}
export interface Sheet {
  name: string;
  cells: SheetCell[];
}
export type ExtractedDoc = { kind: "text"; text: string } | { kind: "sheets"; sheets: Sheet[] };
export type DocResult = { ok: true; doc: ExtractedDoc } | ExtractFailure;

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

function officeText(buf: Buffer, ext: ".docx" | ".pptx"): string {
  const entries = zipEntries(buf);
  const parts =
    ext === ".docx"
      ? entries.filter((e) => e.name === "word/document.xml")
      : entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => slideNumber(a.name) - slideNumber(b.name));
  if (!parts.length) throw new Error("no text part");
  return parts.map((e) => officeXmlToText(readEntry(buf, e).toString("utf8"))).join("\n\n");
}

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------

export function columnName(col: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const columnNumber = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(ref);
  return m ? { col: columnNumber(m[1]), row: Number(m[2]) } : null;
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Text of an <si>/<is> element: its <t> runs, without phonetic hints. */
const runText = (xml: string) =>
  decodeXmlEntities([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

/**
 * Moves the relative references of a shared formula from its anchor cell to another cell
 * (Excel stores the text once, on the anchor). Text inside string literals is left alone.
 */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/(^|[^A-Za-z0-9_.$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(!])/g, (whole, pre: string, colAbs: string, letters: string, rowAbs: string, digits: string) => {
            const col = colAbs ? columnNumber(letters) : columnNumber(letters) + dCol;
            const row = rowAbs ? Number(digits) : Number(digits) + dRow;
            return col < 1 || row < 1 ? whole : `${pre}${colAbs}${columnName(col)}${rowAbs}${row}`;
          }),
    )
    .join("");
}

function isDateFormat(id: number, code: string | undefined): boolean {
  if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
  if (!code) return false;
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/[\\_*]./g, "");
  return /[dmyhs]/i.test(bare);
}

/** Indexes of cell styles (the `s` attribute) that display a date or time. */
function dateStyles(xml: string | null): Set<number> {
  const styles = new Set<number>();
  if (!xml) return styles;
  const custom = new Map<number, string>();
  for (const [tag] of xml.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(tag, "numFmtId")), decodeXmlEntities(attr(tag, "formatCode") ?? ""));
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  [...cellXfs.matchAll(/<xf\b[^>]*>/g)].forEach(([tag], i) => {
    const id = Number(attr(tag, "numFmtId") ?? 0);
    if (isDateFormat(id, custom.get(id))) styles.add(i);
  });
  return styles;
}

function excelDate(serial: number, date1904: boolean): string {
  const iso = new Date(Date.UTC(1899, 11, 30) + Math.round((serial + (date1904 ? 1462 : 0)) * 86_400_000)).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

const formatNumber = (raw: string) => {
  const n = Number(raw);
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : raw;
};

function parseWorksheet(xml: string, strings: string[], dates: Set<number>, date1904: boolean): SheetCell[] {
  const cells: SheetCell[] = [];
  const shared = new Map<string, { formula: string; row: number; col: number }>();
  let rowNo = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    rowNo = Number(attr(rowMatch[1], "r")) || rowNo + 1;
    let colNo = 0;
    for (const cellMatch of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? "";
      const pos = parseRef(attr(attrs, "r") ?? "");
      const row = pos?.row ?? rowNo;
      const col = pos?.col ?? colNo + 1;
      colNo = col;

      let formula: string | undefined;
      const f = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
      if (f) {
        const text = f[2] ? decodeXmlEntities(f[2]) : "";
        const si = attr(f[1], "si");
        if (attr(f[1], "t") === "shared" && si !== null) {
          const anchor = shared.get(si);
          if (text) shared.set(si, { formula: text, row, col });
          else if (anchor) formula = shiftFormula(anchor.formula, row - anchor.row, col - anchor.col);
        }
        if (text) formula = text;
      }

      const type = attr(attrs, "t") ?? "n";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (type === "inlineStr") value = runText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
      else if (raw !== undefined) {
        const v = decodeXmlEntities(raw);
        if (type === "s") value = strings[Number(v)] ?? "";
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (type === "str" || type === "e") value = v;
        else if (dates.has(Number(attr(attrs, "s") ?? 0)) && Number.isFinite(Number(v))) value = excelDate(Number(v), date1904);
        else value = formatNumber(v);
      }
      value = value.replace(/\s+/g, " ").trim();
      if (!value && !formula) continue;
      cells.push({ ref: `${columnName(col)}${row}`, row, col, value, ...(formula ? { formula } : {}) });
    }
  }
  return cells;
}

function xlsxSheets(buf: Buffer): Sheet[] {
  const entries = zipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = (name: string) => {
    const entry = byName.get(name);
    return entry ? readEntry(buf, entry).toString("utf8") : null;
  };
  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new Error("no workbook");
  const strings = [...(read("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1]));
  const dates = dateStyles(read("xl/styles.xml"));
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  const targets = new Map<string, string>();
  for (const [tag] of (read("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const target = attr(tag, "Target");
    if (target) targets.set(attr(tag, "Id") ?? "", target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  return [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(([tag], i) => {
    const path = targets.get(attr(tag, "r:id") ?? "") ?? `xl/worksheets/sheet${i + 1}.xml`;
    const xml = read(path);
    return { name: decodeXmlEntities(attr(tag, "name") ?? `Sheet${i + 1}`), cells: xml ? parseWorksheet(xml, strings, dates, date1904) : [] };
  });
}

/** RFC 4180-ish; the delimiter (`,` `;` or tab) is whichever is most common in the first line. */
export function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"].reduce((best, d) => (first.split(d).length > first.split(best).length ? d : best), ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && !field) quoted = true;
    else if (ch === delimiter) row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

function csvSheet(text: string): Sheet {
  const cells: SheetCell[] = [];
  parseCsv(text).forEach((values, r) =>
    values.forEach((raw, c) => {
      const value = raw.replace(/\s+/g, " ").trim();
      if (value) cells.push({ ref: `${columnName(c + 1)}${r + 1}`, row: r + 1, col: c + 1, value });
    }),
  );
  return { name: "CSV", cells };
}

const cellValue = (c: SheetCell) => c.value.replace(/\|/g, "/");

/** One line per cell, e.g. `Sheet1!B8: =COUNTIF(B2:B6,"*Pro*") → 3` or `Sheet1!B9: 3`. */
export const formatCell = (sheet: string, c: SheetCell) =>
  c.formula ? `${sheet}!${c.ref}: =${c.formula} → ${c.value || "(no value)"}` : `${sheet}!${c.ref}: ${c.value}`;

/**
 * Runs of ≥2 consecutive rows with ≥3 filled cells each (data tables) are printed as a compact
 * grid with column letters and row numbers, keeping the header and at most `maxRows` data rows.
 * Every other cell (labels, answers) is listed with its address.
 */
export function renderSheet(sheet: Sheet, maxRows = Number.POSITIVE_INFINITY): string {
  if (!sheet.cells.length) return `=== Sheet: ${sheet.name} === (empty)`;
  const byRow = new Map<number, SheetCell[]>();
  for (const c of [...sheet.cells].sort((a, b) => a.row - b.row || a.col - b.col)) byRow.set(c.row, [...(byRow.get(c.row) ?? []), c]);
  const rows = [...byRow.keys()];
  const dense = (r: number) => (byRow.get(r)?.length ?? 0) >= 3;

  const tables: number[][] = [];
  for (const r of rows) {
    const last = tables.at(-1);
    if (dense(r) && last && last.at(-1) === r - 1) last.push(r);
    else if (dense(r)) tables.push([r]);
  }
  const tableStart = new Map(tables.filter((t) => t.length >= 2).map((t) => [t[0], t]));
  const inTable = new Set([...tableStart.values()].flat());

  const out: string[] = [`=== Sheet: ${sheet.name} ===`];
  const loose: string[] = [];
  const flushLoose = () => {
    if (loose.length > MAX_LOOSE_CELLS) {
      const half = MAX_LOOSE_CELLS / 2;
      loose.splice(half, loose.length - MAX_LOOSE_CELLS, `… ${loose.length - MAX_LOOSE_CELLS} more cells not shown`);
    }
    out.push(...loose.splice(0));
  };
  for (const r of rows) {
    const table = tableStart.get(r);
    if (table) {
      flushLoose();
      const cells = table.flatMap((tr) => byRow.get(tr)!);
      const minCol = Math.min(...cells.map((c) => c.col));
      const maxCol = Math.max(...cells.map((c) => c.col));
      const cols = Array.from({ length: maxCol - minCol + 1 }, (_, i) => minCol + i);
      const shown = table.slice(0, 1 + Math.max(0, Math.min(maxRows, table.length - 1)));
      const range = `${columnName(minCol)}${table[0]}:${columnName(maxCol)}${table.at(-1)}`;
      out.push(`[Table ${sheet.name}!${range}: header row ${table[0]} + ${table.length - 1} data rows; a cell's address is its column letter + row number]`);
      out.push(`row | ${cols.map(columnName).join(" | ")}`);
      for (const tr of shown) {
        const byCol = new Map(byRow.get(tr)!.map((c) => [c.col, c]));
        out.push(`${tr} | ${cols.map((col) => { const c = byCol.get(col); return !c ? "" : c.formula ? `${cellValue(c)} {=${c.formula}}` : cellValue(c); }).join(" | ")}`);
      }
      const hidden = table.length - shown.length;
      if (hidden > 0) out.push(`… ${hidden} more data rows not shown (rows ${table[shown.length]}–${table.at(-1)})`);
    } else if (!inTable.has(r)) {
      loose.push(...byRow.get(r)!.map((c) => formatCell(sheet.name, c)));
    }
  }
  flushLoose();
  return out.join("\n");
}

export function renderDoc(doc: ExtractedDoc, maxRows = Number.POSITIVE_INFINITY): string {
  return doc.kind === "text" ? doc.text : doc.sheets.map((s) => renderSheet(s, maxRows)).join("\n\n");
}

export function extractDocument(fileName: string, buf: Buffer): DocResult {
  const ext = extensionOf(fileName);
  try {
    const text = () => buf.toString("utf8").replace(/^\uFEFF/, "");
    if (ext === ".txt") return { ok: true, doc: { kind: "text", text: text() } };
    if (ext === ".csv") return { ok: true, doc: { kind: "sheets", sheets: [csvSheet(text())] } };
    if (ext === ".xlsx") return { ok: true, doc: { kind: "sheets", sheets: xlsxSheets(buf) } };
    if (ext === ".docx" || ext === ".pptx") return { ok: true, doc: { kind: "text", text: officeText(buf, ext) } };
    return { ok: false, reason: "UNSUPPORTED_TYPE" };
  } catch {
    return { ok: false, reason: "UNREADABLE" };
  }
}

export function extractSubmissionText(fileName: string, buf: Buffer): ExtractResult {
  const result = extractDocument(fileName, buf);
  return result.ok ? { ok: true, text: renderDoc(result.doc).slice(0, MAX_EXTRACTED_CHARS) } : result;
}
