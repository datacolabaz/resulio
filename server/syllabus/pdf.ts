import fontkit from "@pdf-lib/fontkit";
import type { Request, Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { hitRateLimit } from "../_core/rateLimit";
import { AppError } from "../modules/errors";
import { contentDisposition } from "../fileStorage/r2";
import * as joinRequests from "./joinRequests";
import type { PublicSyllabusView } from "./joinRules";

/**
 * A real, downloadable PDF of a published syllabus' public page -- same content and same access
 * gate as `joinRequests.publicSyllabus` (the public page itself), just rendered as a file instead
 * of HTML. The base-14 PDF fonts only cover WinAnsi, which has no "ə", "ı"/"İ", "ğ" or "ş", so the
 * text is drawn with embedded DejaVu Sans (full Latin Extended + Cyrillic coverage, Bitstream Vera
 * license -- see server/assets/fonts/LICENSE), via pdf-lib's fontkit integration.
 */

/**
 * `server/assets/fonts` next to this module in dev (tsx, unbundled), or next to the repo root once
 * esbuild has flattened the server into a single `dist/index.js` (same two-candidate shape as
 * `resolveMigrationsFolder` in autoMigrate.ts, for the same reason: `import.meta.url` of the bundle
 * points at `dist/`, not at this file's original folder).
 */
function resolveFontsFolder(moduleUrl = import.meta.url, cwd = process.cwd()): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [path.resolve(here, "../assets/fonts"), path.resolve(here, "../server/assets/fonts"), path.resolve(cwd, "server/assets/fonts")];
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, "DejaVuSans.ttf")));
  if (!found) throw new Error(`syllabus PDF fonts not found (tried: ${candidates.join(", ")})`);
  return found;
}

let fontBytes: { regular: Buffer; bold: Buffer } | null = null;
function loadFontBytes() {
  if (!fontBytes) {
    const dir = resolveFontsFolder();
    fontBytes = {
      regular: fs.readFileSync(path.join(dir, "DejaVuSans.ttf")),
      bold: fs.readFileSync(path.join(dir, "DejaVuSans-Bold.ttf")),
    };
  }
  return fontBytes;
}

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.42, 0.44, 0.49);
const RULE = rgb(0.82, 0.83, 0.86);

/** Greedy word-wrap at `maxWidth` for one font/size -- pdf-lib draws single lines only. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = words[0]!;
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/** Draws top-to-bottom, adding pages as content runs out of room; collects page refs for the footer pass at the end. */
class Writer {
  doc: PDFDocument;
  regular: PDFFont;
  bold: PDFFont;
  page: PDFPage;
  y: number;
  pages: PDFPage[] = [];

  private constructor(doc: PDFDocument, regular: PDFFont, bold: PDFFont) {
    this.doc = doc;
    this.regular = regular;
    this.bold = bold;
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  static async create(): Promise<Writer> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const { regular, bold } = loadFontBytes();
    const regularFont = await doc.embedFont(regular, { subset: true });
    const boldFont = await doc.embedFont(bold, { subset: true });
    return new Writer(doc, regularFont, boldFont);
  }

  private addPage() {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  /** Reserves `h` of vertical space, starting a new page first if it doesn't fit. */
  ensure(h: number) {
    if (this.y - h < MARGIN) this.addPage();
  }

  gap(h: number) {
    this.y -= h;
  }

  rule() {
    this.ensure(10);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_WIDTH - MARGIN, y: this.y }, thickness: 1, color: RULE });
    this.y -= 14;
  }

  text(value: string, opts: { size: number; font?: PDFFont; color?: ReturnType<typeof rgb>; maxWidth?: number; lineGap?: number; indent?: number } = { size: 11 }) {
    const font = opts.font ?? this.regular;
    const color = opts.color ?? INK;
    const indent = opts.indent ?? 0;
    const maxWidth = opts.maxWidth ?? CONTENT_WIDTH - indent;
    const lineHeight = opts.size * 1.32 + (opts.lineGap ?? 0);
    for (const line of wrap(value, font, opts.size, maxWidth)) {
      this.ensure(lineHeight);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y - opts.size, size: opts.size, font, color });
      this.y -= lineHeight;
    }
  }

  /** A bullet list with a hanging indent so wrapped lines align under the text, not the bullet. */
  bullets(items: readonly string[], opts: { size?: number; indent?: number } = {}) {
    const size = opts.size ?? 10.5;
    const indent = opts.indent ?? 14;
    const textIndent = indent + 10;
    const lineHeight = size * 1.32;
    for (const item of items) {
      const lines = wrap(item, this.regular, size, CONTENT_WIDTH - textIndent);
      lines.forEach((line, i) => {
        this.ensure(lineHeight);
        if (i === 0) this.page.drawText("•", { x: MARGIN + indent, y: this.y - size, size, font: this.regular, color: MUTED });
        this.page.drawText(line, { x: MARGIN + textIndent, y: this.y - size, size, font: this.regular, color: INK });
        this.y -= lineHeight;
      });
    }
  }
}

function factsLine(s: PublicSyllabusView): string {
  const parts: string[] = [];
  if (s.subject) parts.push(s.subject);
  if (s.level) parts.push(s.level);
  if (s.estimatedDurationLabel) parts.push(s.estimatedDurationLabel);
  else if (s.estimatedHours !== null) parts.push(`≈ ${s.estimatedHours} saat`);
  parts.push(`${s.moduleCount} modul`);
  parts.push(`${s.lessonCount} dərs`);
  return parts.join("   ·   ");
}

export async function buildSyllabusPdf(s: PublicSyllabusView, code: string): Promise<Uint8Array> {
  const w = await Writer.create();

  w.text(s.title, { size: 20, font: w.bold });
  w.gap(6);
  w.text(`Müəllim: ${s.teacher.name}`, { size: 11, color: MUTED });
  w.gap(2);
  w.text(factsLine(s), { size: 10, color: MUTED });
  if (s.description) {
    w.gap(10);
    w.text(s.description, { size: 11 });
  }
  w.gap(14);
  w.rule();

  w.text("Proqram", { size: 14, font: w.bold });
  w.gap(8);

  s.modules.forEach((m, i) => {
    w.ensure(26);
    const heading = m.duration ? `Modul ${i + 1}: ${m.title}   ·   ${m.duration}` : `Modul ${i + 1}: ${m.title}`;
    w.text(heading, { size: 13, font: w.bold });
    w.gap(4);

    if (m.lessons.length) {
      w.text("Dərslər", { size: 10.5, font: w.bold, color: MUTED });
      w.gap(2);
      m.lessons.forEach((l, j) => {
        w.text(`${j + 1}. ${l.title}`, { size: 10.5, indent: 14 });
        if (l.projects.length) w.bullets(l.projects, { indent: 28 });
      });
      w.gap(4);
    }
    if (m.projects.length) {
      w.text("Praktik layihələr", { size: 10.5, font: w.bold, color: MUTED });
      w.gap(2);
      w.bullets(m.projects);
      w.gap(4);
    }
    if (m.assessments.length) {
      w.text("Modul yoxlamaları", { size: 10.5, font: w.bold, color: MUTED });
      w.gap(2);
      w.bullets(m.assessments);
      w.gap(4);
    }
    const d = m.details;
    if (d) {
      if (d.objectives.length) {
        w.text("Məqsədlər", { size: 10.5, font: w.bold, color: MUTED });
        w.gap(2);
        w.bullets(d.objectives);
        w.gap(4);
      }
      if (d.prerequisites.length) {
        w.text("Tələblər", { size: 10.5, font: w.bold, color: MUTED });
        w.gap(2);
        w.bullets(d.prerequisites);
        w.gap(4);
      }
      const a = d.assessment;
      if (a.heading || a.intro || a.pipeline || a.listIntro || a.items.length) {
        w.text("Qiymətləndirmə", { size: 10.5, font: w.bold, color: MUTED });
        w.gap(2);
        if (a.heading) w.text(a.heading, { size: 10.5, font: w.bold });
        if (a.intro) w.text(a.intro, { size: 10.5 });
        if (a.pipeline) w.text(a.pipeline, { size: 10.5 });
        if (a.listIntro) w.text(a.listIntro, { size: 10.5 });
        if (a.items.length) w.bullets(a.items);
        w.gap(4);
      }
    }
    w.gap(10);
  });

  if (s.finalProjects.length || s.finalAssessments.length) {
    w.rule();
    w.text("Yekun layihə və qiymətləndirmə", { size: 13, font: w.bold });
    w.gap(6);
    if (s.finalProjects.length) w.bullets(s.finalProjects);
    if (s.finalAssessments.length) w.bullets(s.finalAssessments);
  }

  // Footer pass: page numbers plus the link back, once the real page count is known.
  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    const label = `resulio.co/syllabus/${code}   ·   ${i + 1}/${total}`;
    p.drawText(label, { x: MARGIN, y: MARGIN / 2, size: 8.5, font: w.regular, color: MUTED });
  });

  return w.doc.save();
}

const PDF_FILENAME_MAX = 80;

/** `GET /api/public/syllabus-pdf/:code`: same gate as the public page (joinRequests.publicSyllabus), rendered as a file. */
export async function syllabusPdfRoute(req: Request, res: Response) {
  res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow");
  if (hitRateLimit(`syllabus-pdf:${req.ip ?? "unknown"}`, 20, 60_000)) {
    res.status(429).json({ error: "RATE_LIMITED" });
    return;
  }
  const code = String(req.params.code ?? "");
  try {
    const { syllabus } = await joinRequests.publicSyllabus(code, null);
    const bytes = await buildSyllabusPdf(syllabus, code);
    const fileName = `${(syllabus.title || "syllabus").slice(0, PDF_FILENAME_MAX).replace(/[/\\]/g, "-")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", contentDisposition(fileName));
    res.send(Buffer.from(bytes));
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.code === "NOT_FOUND" ? 404 : 400).json({ error: error.code });
      return;
    }
    console.error("[syllabus-pdf] build failed:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}
