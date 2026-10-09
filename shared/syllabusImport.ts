import { z } from "zod";
import { moduleDetailsSchema } from "./syllabusModuleDetails";
import { courseTimingSchema, durationSchema } from "./syllabusTiming";

/**
 * "Create a syllabus from a file or text (AI)": the teacher pastes the syllabus they already have or
 * uploads it; the server turns it into this structure in the background; the teacher reviews it and
 * the reviewed structure becomes an ordinary draft syllabus (server/syllabus/importCreate.ts).
 */

export const SYLLABUS_IMPORT_STATUSES = ["QUEUED", "PROCESSING", "READY", "FAILED", "COMPLETED"] as const;
export type SyllabusImportStatus = (typeof SYLLABUS_IMPORT_STATUSES)[number];

/** Why a job FAILED; shown as `simport.failed.<code>`. */
export const SYLLABUS_IMPORT_ERRORS = [
  "PDF_UNREADABLE",
  "UNREADABLE",
  "NO_TEXT",
  "NO_MODULES",
  "AI_OUTPUT",
  "AI_KEY_INVALID",
  "AI_NOT_FOUND",
  "AI_QUOTA",
  "AI_REQUEST_FAILED",
  "AI_TIMEOUT",
  "AI_UNAVAILABLE",
  "DAILY_LIMIT",
  "FILE_MISSING",
  "INTERRUPTED",
  "INTERNAL",
] as const;
export type SyllabusImportError = (typeof SYLLABUS_IMPORT_ERRORS)[number];

/** Uploaded and read on the server. */
export const SYLLABUS_IMPORT_FILE_EXTENSIONS = [".pdf", ".docx", ".png", ".jpg", ".jpeg"] as const;
/** Read in the browser and sent as text. */
export const SYLLABUS_IMPORT_TEXT_EXTENSIONS = [".txt", ".md"] as const;

export const SYLLABUS_IMPORT_MIN_TEXT = 40;
export const SYLLABUS_IMPORT_MAX_TEXT = 200_000;
export const SYLLABUS_IMPORT_MAX_PAGES = 60;
/** PDF pages per model request. */
export const SYLLABUS_IMPORT_CHUNK_PAGES = 6;
/** Characters of text per model request when the text has no module headings; split at headings/blank lines. */
export const SYLLABUS_IMPORT_CHUNK_CHARS = 8_000;

/** Extra facts about a job: why it failed (technical), or which modules were read without the model. */
export interface SyllabusImportDetail {
  message?: string;
  /** Titles of modules the model could not read; they were read from the text's own structure. */
  localModules?: string[];
}

export const SYLLABUS_IMPORT_DETAIL_MAX = 2_000;
const DETAIL_TITLE_MAX = 255;
const DETAIL_MODULES_MAX = 60;

const detailText = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "";
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
};

const moduleTitle = (v: unknown): string => {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object" && typeof (v as { title?: unknown }).title === "string") return (v as { title: string }).title.trim();
  return detailText(v).trim();
};

/**
 * A job's stored `detail` as the page can render it: plain strings only. Rows written by older
 * versions or by hand (a bare string, a message object, titles as objects) are read leniently
 * rather than reaching the page as objects React cannot render.
 */
export function parseImportDetail(raw: unknown): SyllabusImportDetail | null {
  if (raw === null || raw === undefined) return null;
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      /* a plain message */
    }
  }
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const message = detailText(obj ? obj.message : value).trim().slice(0, SYLLABUS_IMPORT_DETAIL_MAX);
  const rawModules = obj?.localModules;
  const list = Array.isArray(rawModules) ? rawModules : rawModules === undefined || rawModules === null ? [] : [rawModules];
  const localModules = list.map(moduleTitle).filter(Boolean).map((t) => t.slice(0, DETAIL_TITLE_MAX)).slice(0, DETAIL_MODULES_MAX);
  if (!message && !localModules.length) return null;
  return { ...(localModules.length ? { localModules } : {}), ...(message ? { message } : {}) };
}

const title = z.string().trim().min(1).max(255);
const line = z.string().trim().min(1).max(500);

export const importLessonSchema = z.object({
  title,
  /** null = not stated in the source. */
  minutes: z.number().int().min(1).max(10_000).nullable().default(null),
  /** Sub-points listed under the lesson in the source; become a theory item listing them. */
  points: z.array(line).max(50).default([]),
});

export const importProjectSchema = z.object({
  title,
  description: z.string().trim().max(5_000).default(""),
});

export const importModuleSchema = z.object({
  title,
  description: z.string().trim().max(5_000).default(""),
  duration: durationSchema.nullable().default(null),
  lessons: z.array(importLessonSchema).max(100).default([]),
  /** The source's heading for the projects ("Praktiki layihə", "Final Project"); a default when empty. */
  projectsHeading: z.string().trim().max(255).default(""),
  projects: z.array(importProjectSchema).max(20).default([]),
  details: moduleDetailsSchema,
});

export const syllabusImportStructureSchema = z.object({
  title,
  description: z.string().trim().max(20_000).default(""),
  subject: z.string().trim().max(120).default(""),
  level: z.string().trim().max(64).default(""),
  language: z.string().trim().max(64).default(""),
  /** Free-text duration as written ("9 ay"), kept in the syllabus' duration label. */
  durationLabel: z.string().trim().max(64).default(""),
  timing: courseTimingSchema.extend({
    /** Applied to every lesson that has no minutes of its own. */
    lessonMinutes: z.number().int().min(1).max(10_000).nullable().default(null),
  }),
  modules: z.array(importModuleSchema).min(1).max(60),
});

export type ImportLesson = z.output<typeof importLessonSchema>;
export type ImportProject = z.output<typeof importProjectSchema>;
export type ImportModule = z.output<typeof importModuleSchema>;
export type SyllabusImportStructure = z.output<typeof syllabusImportStructureSchema>;
export type SyllabusImportStructureInput = z.input<typeof syllabusImportStructureSchema>;
