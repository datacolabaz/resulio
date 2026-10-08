import type { Duration } from "../../shared/syllabusTiming";

/**
 * Reading a pasted / extracted syllabus text without the model: cleaning lines, finding the module
 * sections (so each module is read by its own small request and nothing can move between modules),
 * and a structural fallback reading of a section when the model cannot. Pure.
 */

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;
const LEADING_DECOR = /^(?:[\s\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]|>\s)+/u;
const BULLET = /^\s*(?:[-*•▪◦+‣–]|\d{1,2}[.)])\s+/u;

/** Markdown emphasis and code marks around words: `**x**`, `__x__`, `*x*`, `_x_`, `` `x` ``. */
function stripEmphasis(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])__(.+?)__(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/\*([^*\s](?:[^*]*?[^*\s])?)\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])_([^_\s](?:[^_]*?[^_\s])?)_(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/`([^`]*)`/g, "$1");
}

/** A list item or text line: bullets, heading marks, leading emojis and emphasis marks dropped; the words stay as written. */
export function cleanLine(s: string): string {
  let out = s.replace(/^\s*#{1,6}\s+/, "").replace(LEADING_DECOR, "");
  out = out.replace(BULLET, "").replace(LEADING_DECOR, "");
  return stripEmphasis(out).replace(/\s+/g, " ").trim();
}

/** A title: like a line, and without any emoji. */
export function cleanTitle(s: string): string {
  return cleanLine(s.replace(EMOJI, " ")).replace(/^[\s:–—-]+|[\s:]+$/g, "").trim();
}

/** Multi-line text: bullets kept as "- " lines, emphasis and leading emojis dropped, blank lines collapsed. */
export function cleanBlock(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => {
      if (!l.trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) return "";
      const item = BULLET.test(l.replace(LEADING_DECOR, ""));
      const text = cleanLine(l);
      return item && text ? `- ${text}` : text;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Case-, diacritics- and decoration-insensitive key for comparing headings. */
export function foldKey(s: string): string {
  return cleanTitle(s)
    .replace(/[əƏ]/g, "e")
    .replace(/[ıIİ]/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Module sections
// ---------------------------------------------------------------------------

const NOT_LETTER = "(?![\\p{L}\\p{N}])";
const UNIT_WORDS = "ay|həftə|hefte|modul|module|month|week|unit|part|bölmə|bolme|mərhələ|merhele|месяц|неделя|модуль|раздел|часть|блок";
/** "1-ci AY", "2-ci həftə", "Modul 3", "Module 3", "Month 4", "Week 5", "3-й месяц", "Модуль 2". */
const MODULE_NUMBERED = new RegExp(
  `^(?:\\d{1,2}\\s*-?\\s*(?:ci|cı|cu|cü|nci|ncı|ncu|ncü|st|nd|rd|th|й|ый|ий|ой)?\\.?\\s*(?:${UNIT_WORDS})${NOT_LETTER}` +
    `|(?:${UNIT_WORDS})\\s*(?:№|no\\.?|#)?\\s*\\d{1,2}${NOT_LETTER})`,
  "iu",
);

export const isNumberedModuleTitle = (title: string) => MODULE_NUMBERED.test(cleanTitle(title));

const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const BOLD_LINE = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const isItem = (l: string) => BULLET.test(l.replace(LEADING_DECOR, ""));

/** Heading level of a line: 1-6 markdown, 7 a whole bold line, null otherwise. */
function headingLevel(line: string): { level: number; text: string } | null {
  const md = MD_HEADING.exec(line);
  if (md) return { level: md[1].length, text: md[2] };
  const bold = BOLD_LINE.exec(line);
  if (bold && bold[1].length <= 200) return { level: 7, text: bold[1] };
  return null;
}

export interface ModuleSection {
  /** Title as written, without emojis and markdown marks. */
  title: string;
  /** The section's text, heading line included. */
  text: string;
  /** False for a same-level heading among numbered modules ("Vacib UI tələbi"): kept only if the model says it is course content. */
  numbered: boolean;
}

export interface SectionPlan {
  /** Text before the first module: the course title and overview. */
  preamble: string;
  sections: ModuleSection[];
}

/**
 * Splits the text at its module headings. Prefers numbered module headings ("1-ci AY", "Modul 2",
 * "Week 3") at the shallowest heading level that has at least two of them; else markdown headings at
 * the shallowest level with at least two; else plain numbered lines. Null when there is no such
 * structure (the whole text is then read in parts).
 */
export function findModuleSections(text: string): SectionPlan | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const heads = lines.map(headingLevel);
  let level = 0;
  let starts: number[] = [];
  let numberedRegime = true;

  for (let l = 1; l <= 7 && starts.length < 2; l++) {
    const found = heads.flatMap((h, i) => (h && h.level === l && isNumberedModuleTitle(h.text) ? [i] : []));
    if (found.length >= 2) [level, starts] = [l, found];
  }
  if (starts.length < 2) {
    const plain = lines.flatMap((line, i) => {
      if (heads[i] || BULLET.test(line.replace(LEADING_DECOR, ""))) return [];
      const t = cleanTitle(line);
      return t && t.length <= 150 && isNumberedModuleTitle(t) ? [i] : [];
    });
    if (plain.length >= 2) [level, starts] = [8, plain];
  }
  if (starts.length < 2) {
    numberedRegime = false;
    for (let l = 1; l <= 6 && starts.length < 2; l++) {
      const found = heads.flatMap((h, i) => (h && h.level === l ? [i] : []));
      if (found.length >= 2) [level, starts] = [l, found];
    }
  }
  if (starts.length < 2) return null;

  // Same-level headings after the first module also end a section (and are candidates themselves).
  const boundaries = level <= 7 ? heads.flatMap((h, i) => (h && h.level <= level && i > starts[0] ? [i] : [])) : starts.slice(1);
  const allStarts = [...new Set([...starts, ...(level <= 7 ? heads.flatMap((h, i) => (h && h.level === level && i > starts[0] ? [i] : [])) : [])])].sort((a, b) => a - b);
  const sections: ModuleSection[] = [];
  for (const s of allStarts) {
    const end = Math.min(boundaries.find((b) => b > s) ?? lines.length, lines.length);
    const body = lines.slice(s, end);
    while (body.length && (!body.at(-1)!.trim() || RULE.test(body.at(-1)!))) body.pop();
    const raw = heads[s]?.text ?? lines[s];
    const title = cleanTitle(raw);
    if (!title) continue;
    sections.push({ title, text: body.join("\n"), numbered: numberedRegime ? starts.includes(s) : true });
  }
  const preamble = lines
    .slice(0, starts[0])
    .filter((l) => !RULE.test(l))
    .join("\n")
    .trim();
  return { preamble, sections };
}

// ---------------------------------------------------------------------------
// Structural reading (fallback when the model cannot read a section)
// ---------------------------------------------------------------------------

type Kind = "topics" | "projects" | "objectives" | "prerequisites" | "assessment";
const W = "(?<![\\p{L}\\p{N}])";
const KINDS: Array<[Kind, RegExp]> = [
  ["prerequisites", new RegExp(`${W}(ilkin teleb|telebler|prerequisite|requirements|требовани|предварительн)`, "u")],
  ["objectives", new RegExp(`${W}(meqsed|objective|goals?${NOT_LETTER}|learning outcome|цел[иь]|задачи)`, "u")],
  ["assessment", new RegExp(`${W}(qiymetlendirme|assessment|evaluation|grading|оценивани|оценка|аттестац)`, "u")],
  ["projects", new RegExp(`${W}(layihe|project|проект|praktiki tapsiriq|capstone)`, "u")],
  ["topics", new RegExp(`${W}(movzu|topics?${NOT_LETTER}|lessons?${NOT_LETTER}|content|mundericat|dersler|темы|уроки|содержание)`, "u")],
];

function kindOf(heading: string): Kind | null {
  const k = foldKey(heading);
  return KINDS.find(([, re]) => re.test(k))?.[0] ?? null;
}

/** An unnumbered section that is still course work ("Yekun layihə", "Final Project", "Capstone"). */
export const isProjectSectionTitle = (title: string) => kindOf(title) === "projects" || /(?<![\p{L}\p{N}])(final|capstone|yekun|итогов)/u.test(foldKey(title));

/** Labels that open a part of a module when written as a plain line ("Mövzular:"), folded. */
const PLAIN_LABELS = new Set([
  "movzular", "movzu", "dersler", "topics", "lessons", "content", "темы", "уроки", "содержание",
  "praktiki layihe", "praktiki layiheler", "layihe", "layiheler", "project", "projects", "final project", "проект", "проекты",
  "meqsedler", "meqsed", "objectives", "goals", "learning outcomes", "цели",
  "ilkin telebler", "telebler", "prerequisites", "requirements", "требования",
  "modul uzre qiymetlendirme", "qiymetlendirme", "assessment", "evaluation", "оценивание",
]);

/**
 * A sub-heading inside a module: a markdown heading, a whole bold line, or a known label on its own
 * line that ends with ":" or is followed by a list ("Final Project" above a paragraph is text).
 */
function subHeading(lines: readonly string[], i: number): string | null {
  const line = lines[i];
  const h = headingLevel(line);
  if (h) return h.text;
  if (isItem(line)) return null;
  const t = cleanTitle(line);
  if (!PLAIN_LABELS.has(foldKey(t))) return null;
  const next = lines.slice(i + 1).find((l) => l.trim());
  return line.trim().endsWith(":") || (next !== undefined && isItem(next)) ? t : null;
}

interface Block {
  heading: string;
  kind: Kind | null;
  lines: string[];
}

export interface LocalModule {
  description: string;
  duration: Duration | null;
  lessons: Array<{ title: string; minutes: null; points: string[] }>;
  projectsHeading: string;
  projects: Array<{ title: string; description: string }>;
  objectives: string[];
  prerequisites: string[];
  assessment: { heading: string; intro: string; pipeline: string; listIntro: string; items: string[] };
}

/** One module section read by its sub-headings and lists, word for word. */
export function parseSectionLocally(section: string): LocalModule {
  const lines = section.replace(/\r\n?/g, "\n").split("\n").slice(1);
  const blocks: Block[] = [{ heading: "", kind: null, lines: [] }];
  for (const [i, line] of lines.entries()) {
    if (RULE.test(line)) continue;
    const h = subHeading(lines, i);
    if (h !== null) blocks.push({ heading: cleanTitle(h), kind: kindOf(h), lines: [] });
    else blocks.at(-1)!.lines.push(line);
  }
  const out: LocalModule = {
    description: "",
    duration: null,
    lessons: [],
    projectsHeading: "",
    projects: [],
    objectives: [],
    prerequisites: [],
    assessment: { heading: "", intro: "", pipeline: "", listIntro: "", items: [] },
  };
  for (const b of blocks) {
    const items = b.lines.filter(isItem).map(cleanLine).filter(Boolean);
    const paras = b.lines.filter((l) => l.trim() && !isItem(l)).map(cleanLine).filter(Boolean);
    const listOrParas = items.length ? items : paras;
    switch (b.kind) {
      case "topics":
        out.lessons.push(...listOrParas.map((title) => ({ title, minutes: null, points: [] })));
        break;
      case "objectives":
        out.objectives.push(...listOrParas);
        break;
      case "prerequisites":
        out.prerequisites.push(...listOrParas);
        break;
      case "projects": {
        out.projectsHeading ||= b.heading;
        const single = /final|capstone|yekun|итогов/i.test(foldKey(b.heading)) || (items.length > 0 && paras.length > 0);
        if (single) out.projects.push({ title: b.heading, description: cleanBlock(b.lines.join("\n")) });
        else if (items.length) out.projects.push(...items.map((title) => ({ title, description: "" })));
        else if (paras.length) out.projects.push({ title: paras[0], description: paras.slice(1).join("\n") });
        break;
      }
      case "assessment": {
        const a = out.assessment;
        let seenPipeline = false;
        let seenText = false;
        for (const raw of b.lines) {
          const p = cleanLine(raw);
          if (!p) continue;
          if (isItem(raw)) a.items.push(p);
          else if (p.includes("→") || p.includes("->")) {
            a.pipeline ||= p;
            seenPipeline = true;
          } else if (p.endsWith(":")) {
            if (!seenPipeline && !a.intro && !a.items.length) a.intro = p;
            else a.listIntro ||= p;
          } else if (!seenText && !a.items.length) a.heading = p;
          else a.items.push(p);
          seenText = true;
        }
        break;
      }
      default:
        if (b === blocks[0]) out.description = cleanBlock(b.lines.join("\n"));
        else if (!out.lessons.length && items.length) out.lessons.push(...items.map((title) => ({ title, minutes: null, points: [] })));
    }
  }
  return out;
}

const FIELD = (names: string) => new RegExp(`^(?:${names})\\s*:\\s*(.+)$`, "iu");
const DURATION_FIELD = FIELD("müddət|muddet|davamiyyət|duration|length|длительность|продолжительность|срок");
const LEVEL_FIELD = FIELD("səviyyə|seviyye|level|уровень");
const SUBJECT_FIELD = FIELD("fənn|fenn|sahə|subject|field|предмет|направление");

/** Course header from the text before the first module. */
export function parseHeaderLocally(preamble: string) {
  const lines = preamble.split("\n").map((l) => l.trim()).filter((l) => l && !RULE.test(l));
  const titleLine = lines.find((l) => headingLevel(l)) ?? lines[0] ?? "";
  const rest = lines.filter((l) => l !== titleLine).map(cleanLine).filter(Boolean);
  const field = (re: RegExp) => rest.map((l) => re.exec(l)?.[1]?.trim()).find(Boolean) ?? "";
  const all = preamble;
  const language = /[əƏğĞıİşŞ]/.test(all) ? "az" : /[\u0400-\u04FF]/.test(all) ? "ru" : /[a-z]/i.test(all) ? "en" : "";
  return {
    title: cleanTitle(headingLevel(titleLine)?.text ?? titleLine),
    description: rest.join("\n"),
    subject: field(SUBJECT_FIELD),
    level: field(LEVEL_FIELD),
    language,
    durationLabel: field(DURATION_FIELD),
  };
}
