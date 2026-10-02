import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { files, tasks, type FileRow } from "../../drizzle/schema";
import { requireDb } from "../db";
import { managedWorkspaces } from "./access";
import { AppError } from "./errors";
import { activeGroupIdsOfStudent } from "./groups";

/**
 * File storage for task attachments, material files, and student submission files. Content is
 * kept as base64 text on the `files` row (see drizzle/schema.ts for why) rather than on disk or a
 * third-party bucket — this app is self-hosted on Railway against its own MySQL, and leaning on
 * that same database (already the durable store for everything else — see the tasks/materials
 * migration this replaces the "beta: file name only" placeholder for) needs no new service or
 * credentials to work in production.
 */

/** 8 MB covers worksheets, slide decks, and scanned pages comfortably while staying well under
 *  typical MySQL max_allowed_packet defaults. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const ALLOWED_FILE_TYPES: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i === -1 ? "" : fileName.slice(i).toLowerCase();
}

/** Throws FILE_TOO_LARGE / FILE_TYPE_NOT_ALLOWED; otherwise returns the mime type to store. */
export function assertAllowedUpload(fileName: string, sizeBytes: number): string {
  if (sizeBytes > MAX_FILE_BYTES) throw new AppError("FILE_TOO_LARGE");
  const mimeType = ALLOWED_FILE_TYPES[extensionOf(fileName)];
  if (!mimeType) throw new AppError("FILE_TYPE_NOT_ALLOWED");
  return mimeType;
}

export interface SavedFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

export async function saveFile(input: {
  workspaceId: string;
  uploadedBy: number;
  fileName: string;
  buffer: Buffer;
  isPublic: boolean;
}): Promise<SavedFile> {
  const mimeType = assertAllowedUpload(input.fileName, input.buffer.byteLength);
  const id = nanoid();
  const name = input.fileName.slice(0, 255);
  await requireDb()
    .insert(files)
    .values({
      id,
      workspaceId: input.workspaceId,
      uploadedBy: input.uploadedBy,
      fileName: name,
      mimeType,
      sizeBytes: input.buffer.byteLength,
      dataBase64: input.buffer.toString("base64"),
      isPublic: input.isPublic,
    });
  return { id, name, size: input.buffer.byteLength, mimeType };
}

export async function fileRow(id: string): Promise<FileRow | null> {
  const [row] = await requireDb().select().from(files).where(eq(files.id, id)).limit(1);
  return row ?? null;
}

async function teacherOwnsWorkspace(workspaceId: string, userId: number) {
  const owned = await managedWorkspaces(userId);
  return owned.some((w) => w.id === workspaceId);
}

/** The file is their own upload, or a task attachment on a task that reaches them. */
async function studentCanReach(file: FileRow, studentId: number) {
  if (file.uploadedBy === studentId) return true;
  const groupIds = await activeGroupIdsOfStudent(studentId);
  const workspaceTasks = await requireDb().select().from(tasks).where(eq(tasks.providerWorkspaceId, file.workspaceId));
  return workspaceTasks.some(
    (task) =>
      (task.studentIds.includes(studentId) || task.groupIds.some((g) => groupIds.includes(g))) &&
      task.attachments.some((a) => a.fileId === file.id),
  );
}

/** Throws FORBIDDEN unless `userId` may download this file: anyone for a public (material) file,
 *  the owning teacher for their workspace's files, or a student who the file actually reaches. */
export async function assertCanDownload(file: FileRow, userId: number) {
  if (file.isPublic) return;
  if (await teacherOwnsWorkspace(file.workspaceId, userId)) return;
  if (await studentCanReach(file, userId)) return;
  throw new AppError("FORBIDDEN");
}
