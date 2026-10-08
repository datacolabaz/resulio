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
/** Characters of text per model request; split at headings/blank lines. */
export const SYLLABUS_IMPORT_CHUNK_CHARS = 18_000;

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
