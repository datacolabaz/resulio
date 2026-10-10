import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { fileObjects, files, uploadSessions, type UploadSession } from "../../drizzle/schema";
import { DEFAULT_UPLOAD_LIMITS_MB, MB, directUploadType, uploadLimitBytes, type MaterialKind, type SizeClass } from "../../shared/materialTemplates";
import { requireDb } from "../db";
import { objectKeyFor, uploadSigner, type UploadSigner } from "../fileStorage/r2";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { MAX_FILE_BYTES, type SavedFile } from "../modules/files";
import { isMissingTable } from "../notifications/preferences";
import { getPlatformSettings } from "../platformSettings";

/**
 * Large material files go straight from the browser to R2 (docs/MATERIALS.md, "Large uploads"):
 * 1. `start` checks type, per-kind size limit and the workspace quota, records a PENDING session
 *    and returns a signed PUT (≤ 100 MB) or opens a multipart upload;
 * 2. the browser PUTs the bytes (parts via `partUrls`), with progress and cancel;
 * 3. `complete` finishes the multipart upload, HEADs the object (size and type must match what
 *    was signed) and only then writes the `files` + `file_objects` rows.
 * PENDING sessions past `expiresAt` are aborted and their objects deleted by the sweeper.
 */

export const SINGLE_PUT_MAX_BYTES = 100 * MB;
export const PART_SIZE = 16 * MB;
/** Long enough for a 100 MB PUT on a slow line; parts are signed in small batches. */
export const PUT_URL_TTL_SECONDS = 30 * 60;
export const PART_URL_TTL_SECONDS = 15 * 60;
export const MAX_PART_URLS_PER_CALL = 20;
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60_000;

export interface UploadPlan {
  mode: "single" | "multipart";
  partSize: number | null;
  partCount: number;
}

/** Pure: one PUT up to 100 MB, otherwise 16 MB parts (at most 10 000 by S3 rules; limits keep it far below). */
export function planUpload(sizeBytes: number): UploadPlan {
  if (sizeBytes <= SINGLE_PUT_MAX_BYTES) return { mode: "single", partSize: null, partCount: 1 };
  return { mode: "multipart", partSize: PART_SIZE, partCount: Math.ceil(sizeBytes / PART_SIZE) };
}

/** Pure: the exact length of part `n` (1-based). */
export function partLength(sizeBytes: number, partSize: number, n: number): number {
  return Math.max(0, Math.min(partSize, sizeBytes - (n - 1) * partSize));
}

export type UploadCheck = { ok: true; mimeType: string } | { ok: false; error: "FILE_TYPE_NOT_ALLOWED" | "FILE_TOO_LARGE" | "STORAGE_QUOTA_EXCEEDED" };

/** Pure: whether a direct upload of this file may start. */
export function checkDirectUpload(input: {
  kind: MaterialKind;
  fileName: string;
  sizeBytes: number;
  limitsMb: Partial<Record<SizeClass, number>> | null;
  quotaBytes: number | null;
  usedBytes: number;
}): UploadCheck {
  const type = directUploadType(input.kind, input.fileName);
  if ("error" in type) return { ok: false, error: type.error };
  if (input.sizeBytes <= 0 || input.sizeBytes > uploadLimitBytes(input.kind, input.limitsMb)) return { ok: false, error: "FILE_TOO_LARGE" };
  if (input.quotaBytes && input.usedBytes + input.sizeBytes > input.quotaBytes) return { ok: false, error: "STORAGE_QUOTA_EXCEEDED" };
  return { ok: true, mimeType: type.mimeType };
}

/** Bytes the workspace stores plus bytes reserved by uploads in progress. */
export async function workspaceUsedBytes(workspaceId: string): Promise<number> {
  const db = requireDb();
  const [stored] = await db.select({ bytes: sql<string | number | null>`sum(${files.sizeBytes})` }).from(files).where(eq(files.workspaceId, workspaceId));
  let pending = 0;
  try {
    const [row] = await db
      .select({ bytes: sql<string | number | null>`sum(${uploadSessions.sizeBytes})` })
      .from(uploadSessions)
      .where(and(eq(uploadSessions.workspaceId, workspaceId), eq(uploadSessions.status, "PENDING")));
    pending = Number(row?.bytes ?? 0);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return Number(stored?.bytes ?? 0) + pending;
}

/** Throws STORAGE_QUOTA_EXCEEDED when `extraBytes` more would pass the workspace's hard quota. */
export async function assertWorkspaceQuota(workspaceId: string, extraBytes: number) {
  const quota = (await getPlatformSettings())["storage.workspaceQuotaBytes"];
  if (!quota) return;
  if ((await workspaceUsedBytes(workspaceId)) + extraBytes > quota) throw new AppError("STORAGE_QUOTA_EXCEEDED");
}

/** What the material form needs to pick an upload path and show limits. */
export async function uploadConfig(workspaceId: string) {
  const settings = await getPlatformSettings();
  const limitsMb = { ...DEFAULT_UPLOAD_LIMITS_MB, ...(settings["storage.materialUploadLimitsMb"] ?? {}) };
  const quotaBytes = settings["storage.workspaceQuotaBytes"] || null;
  return {
    direct: uploadSigner() !== null,
    serverMaxBytes: MAX_FILE_BYTES,
    limitsMb,
    quota: quotaBytes ? { limitBytes: quotaBytes, usedBytes: await workspaceUsedBytes(workspaceId) } : null,
  };
}

function requireSigner(): UploadSigner {
  const signer = uploadSigner();
  if (!signer) throw new AppError("DIRECT_UPLOAD_UNAVAILABLE");
  return signer;
}

export async function startUpload(scope: TeacherScope, input: { fileName: string; sizeBytes: number; kind: MaterialKind }) {
  const signer = requireSigner();
  const settings = await getPlatformSettings();
  const quotaBytes = settings["storage.workspaceQuotaBytes"] || null;
  const check = checkDirectUpload({
    ...input,
    limitsMb: settings["storage.materialUploadLimitsMb"] ?? null,
    quotaBytes,
    usedBytes: quotaBytes ? await workspaceUsedBytes(scope.workspaceId) : 0,
  });
  if (!check.ok) throw new AppError(check.error);
  const fileName = input.fileName.trim().slice(0, 255);
  const fileId = nanoid();
  const objectKey = objectKeyFor({ id: fileId, workspaceId: scope.workspaceId, fileName });
  const plan = planUpload(input.sizeBytes);
  const multipartId = plan.mode === "multipart" ? await signer.createMultipart(objectKey, check.mimeType) : null;
  const id = nanoid();
  await requireDb()
    .insert(uploadSessions)
    .values({
      id,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      fileId,
      fileName,
      mimeType: check.mimeType,
      sizeBytes: input.sizeBytes,
      bucket: signer.bucket,
      objectKey,
      multipartId,
      partSize: plan.partSize,
      expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS),
    });
  if (plan.mode === "single") {
    const url = await signer.presignPut(objectKey, { contentType: check.mimeType, contentLength: input.sizeBytes, expiresIn: PUT_URL_TTL_SECONDS });
    return { sessionId: id, mode: "single" as const, url, contentType: check.mimeType, partSize: null, partCount: 1 };
  }
  return { sessionId: id, mode: "multipart" as const, url: null, contentType: check.mimeType, partSize: plan.partSize, partCount: plan.partCount };
}

async function pendingSession(scope: TeacherScope, sessionId: string): Promise<UploadSession> {
  const [row] = await requireDb()
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.workspaceId, scope.workspaceId), eq(uploadSessions.userId, scope.userId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  if (row.status !== "PENDING" || row.expiresAt.getTime() <= Date.now()) throw new AppError("UPLOAD_NOT_PENDING");
  return row;
}

export async function partUrls(scope: TeacherScope, sessionId: string, partNumbers: number[]) {
  const signer = requireSigner();
  const s = await pendingSession(scope, sessionId);
  if (!s.multipartId || !s.partSize) throw new AppError("UPLOAD_NOT_PENDING");
  const count = Math.ceil(s.sizeBytes / s.partSize);
  const wanted = [...new Set(partNumbers)].filter((n) => Number.isInteger(n) && n >= 1 && n <= count).slice(0, MAX_PART_URLS_PER_CALL);
  return Promise.all(
    wanted.map(async (n) => ({ partNumber: n, url: await signer.presignPart(s.objectKey, s.multipartId!, n, partLength(s.sizeBytes, s.partSize!, n), PART_URL_TTL_SECONDS) })),
  );
}

/** Verifies the object and records the file; the session flips to COMPLETED exactly once. */
export async function completeUpload(scope: TeacherScope, sessionId: string): Promise<SavedFile> {
  const signer = requireSigner();
  const s = await pendingSession(scope, sessionId);
  if (s.multipartId) {
    try {
      await signer.completeMultipart(s.objectKey, s.multipartId);
    } catch (error) {
      console.warn("[uploads] complete failed", s.id, error instanceof Error ? error.message : error);
      throw new AppError("UPLOAD_INCOMPLETE");
    }
  }
  const head = await signer.head(s.objectKey);
  const type = (head?.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!head || head.size !== s.sizeBytes || type !== s.mimeType.toLowerCase()) {
    // Wrong bytes in the slot: never keep them; the teacher retries with a new session.
    await signer.remove(s.objectKey).catch(() => undefined);
    await requireDb().update(uploadSessions).set({ status: "ABORTED" }).where(eq(uploadSessions.id, s.id));
    throw new AppError("UPLOAD_INCOMPLETE");
  }
  const db = requireDb();
  await db.transaction(async (tx) => {
    const [claimed] = await tx.update(uploadSessions).set({ status: "COMPLETED" }).where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.status, "PENDING")));
    if (claimed.affectedRows !== 1) throw new AppError("UPLOAD_NOT_PENDING");
    await tx.insert(files).values({
      id: s.fileId,
      workspaceId: s.workspaceId,
      uploadedBy: s.userId,
      fileName: s.fileName,
      mimeType: s.mimeType,
      sizeBytes: s.sizeBytes,
      dataBase64: "",
      // Same as the server upload of a material: whether anyone may open it is decided per download.
      isPublic: true,
    });
    await tx.insert(fileObjects).values({ fileId: s.fileId, backend: "r2", bucket: s.bucket, objectKey: s.objectKey, sizeBytes: s.sizeBytes });
  });
  return { id: s.fileId, name: s.fileName, size: s.sizeBytes, mimeType: s.mimeType };
}

async function discard(signer: UploadSigner, s: Pick<UploadSession, "objectKey" | "multipartId">) {
  if (s.multipartId) await signer.abortMultipart(s.objectKey, s.multipartId).catch(() => undefined);
  await signer.remove(s.objectKey).catch(() => undefined);
}

export async function abortUpload(scope: TeacherScope, sessionId: string) {
  const signer = requireSigner();
  const s = await pendingSession(scope, sessionId);
  const [result] = await requireDb().update(uploadSessions).set({ status: "ABORTED" }).where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.status, "PENDING")));
  if (result.affectedRows === 1) await discard(signer, s);
  return { ok: true };
}

/** Abandoned uploads: PENDING past their expiry are aborted in the bucket and marked EXPIRED. */
export async function runUploadSweep(now: Date = new Date()): Promise<number> {
  const db = requireDb();
  let stale: UploadSession[];
  try {
    stale = await db.select().from(uploadSessions).where(and(eq(uploadSessions.status, "PENDING"), lt(uploadSessions.expiresAt, now))).limit(100);
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  if (!stale.length) return 0;
  const signer = uploadSigner();
  let done = 0;
  for (const s of stale) {
    const [result] = await db.update(uploadSessions).set({ status: "EXPIRED" }).where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.status, "PENDING")));
    if (result.affectedRows !== 1) continue;
    if (signer && signer.bucket === s.bucket) await discard(signer, s);
    done++;
  }
  // Finished sessions only matter for a while (debugging); keep the table small.
  await db
    .delete(uploadSessions)
    .where(and(inArray(uploadSessions.status, ["COMPLETED", "ABORTED", "EXPIRED"]), lt(uploadSessions.expiresAt, new Date(now.getTime() - 30 * UPLOAD_SESSION_TTL_MS))));
  return done;
}
