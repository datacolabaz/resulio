import { and, eq, inArray } from "drizzle-orm";
import { files } from "../../drizzle/schema";
import type { ServerLocale } from "../_core/locale";
import { requireDb } from "../db";
import { ALLOWED_FILE_TYPES, extensionOf, fileBytes, MAX_FILE_BYTES } from "./files";
import { extractDocument, renderDoc, type ExtractedDoc } from "./textExtract";

/**
 * What the AI gets to see about a task: title, description, the teacher's attached files and the
 * hidden answer key, fitted into a size budget. Shared by submission review and answer-key drafts.
 */

/** Removes control characters and obvious contact details before anything leaves the server. */
export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+\d{1,3}[\s.-]?\(?\d[\d\s().-]{6,}\d|\b0\(?\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/g, "[phone]")
    .replace(/<<<|>>>/g, "«");
}

export const CUT_MARK = "\n… [shortened]";

export function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, max - CUT_MARK.length)) + CUT_MARK, truncated: true };
}

export const LANGUAGE_NAME: Record<ServerLocale, string> = { az: "Azerbaijani", en: "English", ru: "Russian" };

export interface TaskAttachmentDoc {
  name: string;
  /** Null when the file is missing, not this workspace's, or has no text extractor. */
  doc: ExtractedDoc | null;
}

/** Text of the teacher's attachments, with at most `maxRows` data rows per spreadsheet table. */
export function renderAttachments(attachments: TaskAttachmentDoc[], maxRows = Number.POSITIVE_INFINITY): string {
  return attachments
    .map((a, i) => {
      const name = sanitizeForPrompt(a.name).slice(0, 120);
      return a.doc ? `[Attachment ${i + 1}: ${name}]\n${renderDoc(a.doc, maxRows).trim()}` : `[Attachment ${i + 1}: ${name} — no text could be read]`;
    })
    .join("\n\n");
}

/** Dataset rows are the first thing to go when content is too long. */
export const ROW_CAPS = [Number.POSITIVE_INFINITY, 50, 20, 10, 3];

/** Loads the teacher's attachments of a task; only files of the task's own workspace are read. */
export async function loadTaskAttachments(workspaceId: string, attachments: Array<{ fileId: string; name: string }>): Promise<TaskAttachmentDoc[]> {
  const ids = attachments.map((a) => a.fileId).slice(0, 20);
  if (!ids.length) return [];
  const rows = await requireDb()
    .select()
    .from(files)
    .where(and(inArray(files.id, ids), eq(files.workspaceId, workspaceId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Promise.all(
    attachments.slice(0, 20).map(async (a): Promise<TaskAttachmentDoc> => {
      const row = byId.get(a.fileId);
      if (!row || !ALLOWED_FILE_TYPES[extensionOf(row.fileName)] || row.sizeBytes > MAX_FILE_BYTES) return { name: a.name, doc: null };
      const result = extractDocument(row.fileName, await fileBytes(row));
      return { name: row.fileName, doc: result.ok ? result.doc : null };
    }),
  );
}

export const REVIEW_LIMITS = { answerKey: 8_000, task: 6_000, student: 24_000, total: 60_000 };

export interface ReviewTask {
  title: string;
  /** Description and instructions. */
  text: string;
  answerKey?: { text: string; aiDraft: boolean } | null;
  /** Rendered teacher attachments. */
  attachments?: string;
  /** Feedback language: the student's. */
  locale?: ServerLocale;
}

/**
 * Fits task, answer key, student content and teacher attachments into `limits.total`, in that
 * priority: answer key > task description > student answers > teacher attachments > dataset
 * rows. Spreadsheet tables are shortened first (same row cap for every file), then text is cut.
 */
export function fitReviewContext(
  input: {
    title: string;
    description: string;
    answerKey: { text: string; aiDraft: boolean } | null;
    attachments: TaskAttachmentDoc[];
    /** Length of the student's content (before cutting) at a given row cap. */
    studentChars: (maxRows: number) => number;
  },
  limits = REVIEW_LIMITS,
): { task: Omit<ReviewTask, "locale">; rowCap: number } {
  const answerKey = input.answerKey?.text.trim()
    ? { text: clip(sanitizeForPrompt(input.answerKey.text.trim()), limits.answerKey).text, aiDraft: input.answerKey.aiDraft }
    : null;
  const title = sanitizeForPrompt(input.title).slice(0, 255);
  const text = clip(sanitizeForPrompt(input.description.trim()), limits.task).text;
  const fixed = title.length + text.length + (answerKey?.text.length ?? 0);

  let rowCap = ROW_CAPS[ROW_CAPS.length - 1];
  let attachments = "";
  for (const cap of ROW_CAPS) {
    rowCap = cap;
    const student = input.studentChars(cap);
    attachments = renderAttachments(input.attachments, cap);
    if (student <= limits.student && fixed + student + attachments.length <= limits.total) break;
  }
  const room = limits.total - fixed - Math.min(input.studentChars(rowCap), limits.student);
  return { task: { title, text, answerKey, attachments: clip(attachments, Math.max(0, room)).text }, rowCap };
}
