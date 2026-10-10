import { z } from "zod";
import { normalizeForMatch } from "./questionImport";

/**
 * Material templates: one base form (name, template, kind, file or link, sharing) plus the fields
 * each template adds. Shared by the form (what to render) and the API (what to accept). Codes are
 * stored, never labels; labels live in client/src/i18n/catalog/materials.ts. See docs/MATERIALS.md.
 */

export const MATERIAL_TEMPLATES = ["GENERAL", "SCHOOL_LESSON", "ACADEMIC_PREP", "IT", "DATA_ANALYTICS", "IELTS", "LANGUAGE", "PROJECT", "PRACTICE"] as const;
export type MaterialTemplate = (typeof MATERIAL_TEMPLATES)[number];

export const MATERIAL_KINDS = ["FILE", "LINK", "VIDEO", "PRESENTATION", "TASK", "DATASET", "CODE", "QUESTION_BANK", "OTHER"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const MATERIAL_STATUSES = ["DRAFT", "PUBLISHED"] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

/** LINK: anyone with the share link (the behaviour before templates); RECIPIENTS: only the chosen groups/students. */
export const MATERIAL_VISIBILITIES = ["LINK", "RECIPIENTS"] as const;
export type MaterialVisibility = (typeof MATERIAL_VISIBILITIES)[number];

export const CONTENT_ENTITY_TYPES = ["MATERIAL", "TASK"] as const;
export type ContentEntityType = (typeof CONTENT_ENTITY_TYPES)[number];

export const TAG_TYPES = ["TOPIC", "TECHNOLOGY"] as const;
export type TagType = (typeof TAG_TYPES)[number];

export const OPTION_SETS = {
  schoolPurpose: ["EXPLANATION", "PRACTICE", "HOMEWORK", "REVIEW"],
  examType: ["GRADUATION", "ADMISSION", "DIM", "SAT", "MASTERS", "OTHER"],
  difficulty: ["EASY", "MEDIUM", "HARD"],
  itDirection: ["FRONTEND", "BACKEND", "DATA_ANALYTICS", "DATA_SCIENCE", "DEVOPS", "UI_UX", "OTHER"],
  itLevel: ["BEGINNER", "INTERMEDIATE", "ADVANCED"],
  itPurpose: ["THEORY", "PRACTICE", "CASE_STUDY", "MINI_PROJECT", "CODING_CHALLENGE"],
  language: ["EN", "RU", "DE", "FR", "TR", "AR", "OTHER"],
  languageSkill: ["READING", "LISTENING", "WRITING", "SPEAKING", "GRAMMAR", "VOCABULARY"],
  ieltsModule: ["ACADEMIC", "GENERAL_TRAINING"],
  ieltsTaskType: ["WRITING_TASK_1", "WRITING_TASK_2", "SPEAKING_PART_1", "SPEAKING_PART_2", "SPEAKING_PART_3", "READING_PASSAGE", "LISTENING_SECTION"],
  cefr: ["A1", "A2", "B1", "B2", "C1", "C2"],
  feedbackFormat: ["TEACHER_REVIEW", "MODEL_ANSWER", "PEER_REVIEW", "AUTO_CHECK"],
  submissionFormat: ["FILE", "LINK", "GITHUB", "DRIVE", "OTHER"],
} as const satisfies Record<string, readonly string[]>;
export type OptionSet = keyof typeof OPTION_SETS;

/** Every field a template can add. Which ones are indexed columns, tags or JSON: see FIELD_STORAGE. */
export const FIELD_KEYS = [
  "subject",
  "grade",
  "topics",
  "technologies",
  "purpose",
  "dueAt",
  "examType",
  "difficulty",
  "questionCount",
  "durationMin",
  "targetScore",
  "direction",
  "level",
  "estimatedMinutes",
  "prerequisites",
  "repoUrl",
  "language",
  "skill",
  "module",
  "taskType",
  "targetBand",
  "feedbackFormat",
  "instructions",
  "submissionFormat",
  "gradingCriteria",
  "maxScore",
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export type FieldType = "select" | "tags" | "number" | "date" | "text" | "textarea" | "url";

export interface FieldDef {
  key: FieldKey;
  type: FieldType;
  /** select: the codes offered (labels: `material.opt.<optionSet>.<code>`). */
  optionSet?: OptionSet;
  /** select: "OTHER" (or no match) lets the teacher type their own value, stored as typed. */
  allowOther?: boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Label key suffix when the default `material.field.<key>` does not fit this template. */
  label?: string;
  /** Shown only while another field has one of these values. */
  showIf?: { key: FieldKey; values: readonly string[] };
  /** Pre-filled for a new material of this template. */
  defaultValue?: string;
}

export interface TemplateDef {
  /** Kinds offered, most likely first; the first one is the default. */
  kinds: readonly MaterialKind[];
  fields: readonly FieldDef[];
  /** New materials of this template go out as a task (with submissions) unless the teacher unticks it. */
  submissionByDefault?: boolean;
}

const minutes: FieldDef = { key: "estimatedMinutes", type: "number", min: 1, max: 6000 };
const dueAt: FieldDef = { key: "dueAt", type: "date" };
const topics: FieldDef = { key: "topics", type: "tags" };

export const TEMPLATES: Record<MaterialTemplate, TemplateDef> = {
  GENERAL: { kinds: ["FILE", "LINK", "VIDEO", "PRESENTATION", "OTHER"], fields: [topics, minutes] },
  SCHOOL_LESSON: {
    kinds: ["FILE", "PRESENTATION", "VIDEO", "LINK", "TASK", "OTHER"],
    fields: [
      { key: "subject", type: "text", max: 120 },
      { key: "grade", type: "text", max: 32 },
      { ...topics, label: "topic" },
      { key: "purpose", type: "select", optionSet: "schoolPurpose" },
      { ...dueAt, showIf: { key: "purpose", values: ["HOMEWORK", "PRACTICE"] } },
    ],
  },
  ACADEMIC_PREP: {
    kinds: ["FILE", "QUESTION_BANK", "PRESENTATION", "VIDEO", "LINK", "TASK", "OTHER"],
    fields: [
      { key: "examType", type: "select", optionSet: "examType", allowOther: true },
      { key: "subject", type: "text", max: 120 },
      { ...topics, label: "topic" },
      { key: "difficulty", type: "select", optionSet: "difficulty" },
      { key: "questionCount", type: "number", min: 1, max: 1000 },
      { key: "durationMin", type: "number", min: 1, max: 600 },
      { key: "targetScore", type: "text", max: 32 },
      dueAt,
    ],
  },
  IT: {
    kinds: ["LINK", "CODE", "FILE", "VIDEO", "DATASET", "PRESENTATION", "TASK", "OTHER"],
    fields: [
      { key: "direction", type: "select", optionSet: "itDirection", allowOther: true },
      { key: "technologies", type: "tags" },
      topics,
      { key: "level", type: "select", optionSet: "itLevel" },
      { key: "purpose", type: "select", optionSet: "itPurpose" },
      minutes,
      { key: "prerequisites", type: "textarea", max: 1000 },
      { key: "repoUrl", type: "url" },
    ],
  },
  DATA_ANALYTICS: {
    kinds: ["DATASET", "FILE", "LINK", "CODE", "VIDEO", "PRESENTATION", "TASK", "OTHER"],
    fields: [
      { key: "direction", type: "select", optionSet: "itDirection", allowOther: true, defaultValue: "DATA_ANALYTICS" },
      { key: "technologies", type: "tags" },
      topics,
      { key: "level", type: "select", optionSet: "itLevel" },
      { key: "purpose", type: "select", optionSet: "itPurpose" },
      minutes,
      { key: "prerequisites", type: "textarea", max: 1000 },
      { key: "repoUrl", type: "url" },
    ],
  },
  IELTS: {
    kinds: ["FILE", "VIDEO", "LINK", "PRESENTATION", "TASK", "OTHER"],
    fields: [
      { key: "skill", type: "select", optionSet: "languageSkill" },
      { key: "module", type: "select", optionSet: "ieltsModule" },
      { key: "taskType", type: "select", optionSet: "ieltsTaskType" },
      { key: "targetBand", type: "number", min: 1, max: 9, step: 0.5 },
      { key: "level", type: "select", optionSet: "cefr", label: "cefr" },
      topics,
      minutes,
      dueAt,
      { key: "feedbackFormat", type: "select", optionSet: "feedbackFormat" },
    ],
  },
  LANGUAGE: {
    kinds: ["FILE", "VIDEO", "LINK", "PRESENTATION", "TASK", "OTHER"],
    fields: [
      { key: "language", type: "select", optionSet: "language", allowOther: true },
      { key: "skill", type: "select", optionSet: "languageSkill" },
      { key: "level", type: "select", optionSet: "cefr", label: "cefr" },
      topics,
      minutes,
      dueAt,
      { key: "feedbackFormat", type: "select", optionSet: "feedbackFormat" },
    ],
  },
  PROJECT: {
    kinds: ["TASK", "FILE", "LINK", "CODE", "DATASET", "OTHER"],
    submissionByDefault: true,
    fields: [
      { key: "instructions", type: "textarea", max: 5000 },
      { key: "submissionFormat", type: "select", optionSet: "submissionFormat" },
      dueAt,
      { key: "gradingCriteria", type: "textarea", max: 5000 },
      minutes,
      { key: "maxScore", type: "number", min: 1, max: 1000 },
      topics,
    ],
  },
  PRACTICE: {
    kinds: ["TASK", "FILE", "LINK", "CODE", "DATASET", "OTHER"],
    submissionByDefault: true,
    fields: [
      { key: "instructions", type: "textarea", max: 5000 },
      { key: "submissionFormat", type: "select", optionSet: "submissionFormat" },
      dueAt,
      { key: "gradingCriteria", type: "textarea", max: 5000 },
      minutes,
      { key: "maxScore", type: "number", min: 1, max: 1000 },
      topics,
    ],
  },
};

export const isTemplate = (v: unknown): v is MaterialTemplate => typeof v === "string" && (MATERIAL_TEMPLATES as readonly string[]).includes(v);
export const isKind = (v: unknown): v is MaterialKind => typeof v === "string" && (MATERIAL_KINDS as readonly string[]).includes(v);

/** Where each field lives: an indexed column of content_meta, tag links, or the `extra` JSON. */
export const FIELD_STORAGE: Record<FieldKey, "column" | "tags" | "extra"> = {
  subject: "column",
  grade: "column",
  topics: "tags",
  technologies: "tags",
  purpose: "extra",
  dueAt: "column",
  examType: "column",
  difficulty: "column",
  questionCount: "extra",
  durationMin: "extra",
  targetScore: "extra",
  direction: "column",
  level: "column",
  estimatedMinutes: "column",
  prerequisites: "extra",
  repoUrl: "extra",
  language: "column",
  skill: "column",
  module: "extra",
  taskType: "extra",
  targetBand: "extra",
  feedbackFormat: "extra",
  instructions: "extra",
  submissionFormat: "extra",
  gradingCriteria: "extra",
  maxScore: "extra",
};

export const TAG_FIELD: Partial<Record<FieldKey, TagType>> = { topics: "TOPIC", technologies: "TECHNOLOGY" };

export const MAX_TAGS_PER_FIELD = 20;
export const MAX_TAG_LENGTH = 60;

/** A field's value as the API and the form carry it. */
export type FieldValue = string | number | Date | string[];
export type MaterialValues = Partial<Record<FieldKey, FieldValue>>;

export interface MaterialDetails {
  template: MaterialTemplate;
  kind: MaterialKind;
  values: MaterialValues;
}

/** Duplicate tags ("SQL Join" / "sql  join") collapse to one key; also how weak topics match tags. */
export function tagKey(name: string): string {
  return normalizeForMatch(name).slice(0, MAX_TAG_LENGTH);
}

/** Trimmed, control characters removed, length capped; empty and duplicate (by key) tags dropped. */
export function cleanTags(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH);
    const key = tagKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, MAX_TAGS_PER_FIELD);
}

/** http(s) only, no credentials, a real host; null otherwise. The server never fetches it. */
export function parseWebUrl(raw: string): URL | null {
  const text = raw.trim();
  if (!text || text.length > 2048 || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    if (!url.hostname.includes(".") || url.hostname.endsWith(".")) return null;
    return url;
  } catch {
    return null;
  }
}

export const LINK_PROVIDERS = ["youtube", "drive", "notion", "github", "vimeo", "loom", "other"] as const;
export type LinkProvider = (typeof LINK_PROVIDERS)[number];

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The host shown next to a link ("youtube.com"), or the text itself when it is not a valid link. */
export function linkHost(raw: string): string {
  return parseWebUrl(raw)?.hostname.replace(/^www\./, "") ?? raw;
}

/** For the link's icon and label only. */
export function linkProviderOf(raw: string): LinkProvider {
  const host = parseWebUrl(raw)?.hostname.toLowerCase() ?? "";
  if (hostIs(host, "youtube.com") || hostIs(host, "youtu.be")) return "youtube";
  if (hostIs(host, "drive.google.com") || hostIs(host, "docs.google.com")) return "drive";
  if (hostIs(host, "notion.so") || hostIs(host, "notion.site")) return "notion";
  if (hostIs(host, "github.com") || hostIs(host, "gist.github.com")) return "github";
  if (hostIs(host, "vimeo.com")) return "vimeo";
  if (hostIs(host, "loom.com")) return "loom";
  return "other";
}

const webUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => parseWebUrl(v) !== null, "INVALID_URL");
export const materialUrlSchema = webUrlSchema;

function fieldSchema(def: FieldDef) {
  switch (def.type) {
    case "select": {
      const codes = def.optionSet ? (OPTION_SETS[def.optionSet] as readonly string[]) : [];
      return z
        .string()
        .trim()
        .max(64)
        .refine((v) => v === "" || def.allowOther || codes.includes(v), "INVALID_OPTION");
    }
    case "tags":
      return z.array(z.string().max(200)).max(50).transform(cleanTags);
    case "number": {
      let n = z.number().finite();
      if (def.min !== undefined) n = n.min(def.min);
      if (def.max !== undefined) n = n.max(def.max);
      return def.step && def.step < 1 ? n : n.int();
    }
    case "date":
      return z.date();
    case "url":
      return z.union([z.literal(""), webUrlSchema]);
    case "textarea":
    case "text":
      return z.string().trim().max(def.max ?? 255);
  }
}

function valuesSchema(template: MaterialTemplate) {
  const shape: Record<string, z.ZodType> = {};
  for (const def of TEMPLATES[template].fields) shape[def.key] = fieldSchema(def).nullable().optional();
  return z.object(shape).strict();
}

/** The template-specific part of a save: one member per template, each accepting only its own fields. */
export const materialDetailsSchema = z.discriminatedUnion(
  "template",
  MATERIAL_TEMPLATES.map((template) =>
    z.object({
      template: z.literal(template),
      kind: z.enum(MATERIAL_KINDS),
      values: valuesSchema(template).default({}),
    }),
  ) as unknown as [z.ZodObject<{ template: z.ZodLiteral<MaterialTemplate> }>, ...z.ZodObject<{ template: z.ZodLiteral<MaterialTemplate> }>[]],
) as unknown as z.ZodType<MaterialDetails>;

/** Values with empty strings, null and empty lists dropped, and fields hidden by `showIf` removed. */
export function compactValues(template: MaterialTemplate, values: MaterialValues): MaterialValues {
  const out: MaterialValues = {};
  for (const def of TEMPLATES[template].fields) {
    const v = values[def.key];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (def.showIf) {
      const other = values[def.showIf.key];
      if (typeof other !== "string" || !def.showIf.values.includes(other)) continue;
    }
    out[def.key] = v;
  }
  return out;
}

/** The values a new material of this template starts with. */
export function templateDefaults(template: MaterialTemplate): MaterialValues {
  const out: MaterialValues = {};
  for (const def of TEMPLATES[template].fields) if (def.defaultValue) out[def.key] = def.defaultValue;
  return out;
}

/** Values that still apply after switching template (same field in both); the rest are dropped. */
export function carryValues(to: MaterialTemplate, values: MaterialValues): MaterialValues {
  const keys = new Set(TEMPLATES[to].fields.map((f) => f.key));
  const out: MaterialValues = { ...templateDefaults(to) };
  for (const [k, v] of Object.entries(values) as [FieldKey, FieldValue][]) {
    if (!keys.has(k)) continue;
    const def = TEMPLATES[to].fields.find((f) => f.key === k)!;
    if (def.type === "select" && typeof v === "string" && !def.allowOther && def.optionSet && !(OPTION_SETS[def.optionSet] as readonly string[]).includes(v)) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upload limits (direct-to-R2 uploads; the server upload stays at 8 MB)
// ---------------------------------------------------------------------------

export const SIZE_CLASSES = ["DOCUMENT", "PRESENTATION", "DATASET", "VIDEO"] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];

/** Defaults in MB; admins can change them (platform_settings `storage.materialUploadLimitsMb`). */
export const DEFAULT_UPLOAD_LIMITS_MB: Record<SizeClass, number> = { DOCUMENT: 50, PRESENTATION: 100, DATASET: 200, VIDEO: 500 };
/** `files.sizeBytes` is a signed INT, so nothing at or above 2 GiB can be recorded. */
export const MAX_UPLOAD_LIMIT_MB = 2000;

export const KIND_SIZE_CLASS: Record<MaterialKind, SizeClass> = {
  FILE: "DOCUMENT",
  LINK: "DOCUMENT",
  TASK: "DOCUMENT",
  QUESTION_BANK: "DOCUMENT",
  OTHER: "DOCUMENT",
  PRESENTATION: "PRESENTATION",
  DATASET: "DATASET",
  CODE: "DATASET",
  VIDEO: "VIDEO",
};

const DOC_TYPES = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
};
const MEDIA_TYPES = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};
const DATA_TYPES = {
  ".json": "application/json",
  ".parquet": "application/vnd.apache.parquet",
  ".zip": "application/zip",
  ".ipynb": "application/x-ipynb+json",
  ".sql": "application/sql",
  ".py": "text/x-python",
};

/** Extensions a material may upload, by size class. Never HTML, SVG or scripts a browser would run. */
export const UPLOAD_TYPES: Record<SizeClass, Record<string, string>> = {
  DOCUMENT: { ...DOC_TYPES, ...MEDIA_TYPES, ...DATA_TYPES },
  PRESENTATION: { ...DOC_TYPES, ".key": "application/vnd.apple.keynote" },
  DATASET: { ...DOC_TYPES, ...DATA_TYPES },
  VIDEO: { ...MEDIA_TYPES, ...DOC_TYPES },
};

/** Every extension any material upload accepts (the server's 8 MB route accepts these for materials). */
export const MATERIAL_UPLOAD_TYPES: Record<string, string> = Object.assign({}, ...SIZE_CLASSES.map((c) => UPLOAD_TYPES[c]));

export const MB = 1024 * 1024;

export function extensionOfName(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i === -1 ? "" : fileName.slice(i).toLowerCase();
}

export function uploadLimitBytes(kind: MaterialKind, limitsMb: Partial<Record<SizeClass, number>> | null | undefined): number {
  const cls = KIND_SIZE_CLASS[kind];
  return (limitsMb?.[cls] ?? DEFAULT_UPLOAD_LIMITS_MB[cls]) * MB;
}

/** The type to store for a direct upload of this kind, or an error code. */
export function directUploadType(kind: MaterialKind, fileName: string): { mimeType: string } | { error: "FILE_TYPE_NOT_ALLOWED" } {
  const mimeType = UPLOAD_TYPES[KIND_SIZE_CLASS[kind]][extensionOfName(fileName)];
  return mimeType ? { mimeType } : { error: "FILE_TYPE_NOT_ALLOWED" };
}

/** Kinds whose source is normally a link (the form opens on the link tab). */
export const LINK_FIRST_KINDS: readonly MaterialKind[] = ["LINK", "VIDEO"];

/** Kind guessed from a stored file type, for materials saved before templates. */
export function kindFromMime(mimeType: string | null | undefined): MaterialKind {
  const m = (mimeType ?? "").toLowerCase();
  if (m.includes("presentation") || m.includes("powerpoint")) return "PRESENTATION";
  if (m.includes("spreadsheet") || m.includes("ms-excel") || m === "text/csv") return "DATASET";
  if (m.startsWith("video/")) return "VIDEO";
  return "FILE";
}
