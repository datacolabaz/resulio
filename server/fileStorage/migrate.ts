import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { fileObjects, files } from "../../drizzle/schema";
import { requireDb } from "../db";
import { objectKeyFor, redactR2Secrets, type ObjectStore } from "./r2";

/**
 * Moves file bytes from MySQL (files.dataBase64) to the object store. Shared by the
 * `files:to-r2` script and the admin background job.
 *
 * - "copy" uploads each file not yet recorded in file_objects, checks the stored size and MD5
 *   (ETag), then records it. The MySQL copy stays and is still what downloads read. An object
 *   already in the bucket with the same size and MD5 is recorded without re-uploading.
 * - "verify" re-checks every recorded object: present, right size and, while the MySQL copy
 *   exists, the same MD5.
 * - "purge" (script only) empties dataBase64 for files whose object is confirmed present.
 *
 * All modes are idempotent and resumable; copy and verify never write to `files`.
 */

export type MigrateMode = "copy" | "verify" | "purge";

export type FileOutcome =
  | { id: string; fileName: string; bytes: number; status: "copied" | "skipped" | "verified" | "purged" }
  | { id: string; fileName: string; bytes: number; status: "failed"; error: string };

export interface MigrateOptions {
  store: ObjectStore;
  mode: MigrateMode;
  /** false = only report what would happen. */
  apply: boolean;
  batchSize?: number;
  /** Files handled in parallel within a batch. */
  concurrency?: number;
  limit?: number;
  /** Resume after this file id (files are processed in id order). */
  after?: string;
  log?: (line: string) => void;
  onFile?: (outcome: FileOutcome) => void;
  /** Checked before each file; true stops the run (the current files finish first). */
  shouldStop?: () => boolean;
}

export interface MigrateReport {
  mode: MigrateMode;
  apply: boolean;
  candidates: number;
  bytes: number;
  done: number;
  /** Copy: already in the bucket with the same size and MD5, only recorded. */
  skipped: number;
  failed: Array<{ id: string; fileName: string; error: string }>;
  stopped: boolean;
  /** Last id of the last fully handled batch, for resuming. */
  cursor: string;
}

export const md5Hex = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");
/** Single-part ETags are the MD5 hex; multipart ones ("…-N") are not comparable. */
const isMd5 = (etag: string | null): etag is string => !!etag && /^[0-9a-f]{32}$/.test(etag);

const meta = { id: files.id, workspaceId: files.workspaceId, fileName: files.fileName, mimeType: files.mimeType, sizeBytes: files.sizeBytes };
type FileMeta = { id: string; workspaceId: string; fileName: string; mimeType: string; sizeBytes: number };
type StoredMeta = FileMeta & { objectKey: string; storedBytes: number; hasData: number | boolean };

async function nextCopyBatch(after: string, size: number): Promise<FileMeta[]> {
  return requireDb()
    .select(meta)
    .from(files)
    .leftJoin(fileObjects, eq(fileObjects.fileId, files.id))
    .where(and(gt(files.id, after), isNull(fileObjects.fileId), ne(files.dataBase64, "")))
    .orderBy(asc(files.id))
    .limit(size);
}

async function nextStoredBatch(after: string, size: number, bucket: string, onlyWithData: boolean): Promise<StoredMeta[]> {
  return requireDb()
    .select({ ...meta, objectKey: fileObjects.objectKey, storedBytes: fileObjects.sizeBytes, hasData: sql<number>`${files.dataBase64} <> ''` })
    .from(files)
    .innerJoin(fileObjects, eq(fileObjects.fileId, files.id))
    .where(and(gt(files.id, after), eq(fileObjects.bucket, bucket), onlyWithData ? ne(files.dataBase64, "") : undefined))
    .orderBy(asc(files.id))
    .limit(size);
}

async function mysqlBytes(id: string) {
  const [row] = await requireDb().select({ data: files.dataBase64 }).from(files).where(eq(files.id, id)).limit(1);
  return Buffer.from(row?.data ?? "", "base64");
}

async function copyOne(store: ObjectStore, file: FileMeta): Promise<"copied" | "skipped"> {
  const bytes = await mysqlBytes(file.id);
  if (!bytes.byteLength && file.sizeBytes > 0) throw new Error("no bytes in MySQL");
  const key = objectKeyFor(file);
  const md5 = md5Hex(bytes);
  const existing = await store.stat(key);
  const already = !!existing && existing.size === bytes.byteLength && existing.etag === md5;
  if (!already) {
    await store.put(key, bytes, file.mimeType);
    const stored = await store.stat(key);
    if (!stored || stored.size !== bytes.byteLength) throw new Error(`size check failed: stored ${stored?.size ?? "none"}, expected ${bytes.byteLength}`);
    if (isMd5(stored.etag) && stored.etag !== md5) throw new Error("checksum check failed: the stored MD5 differs from the MySQL copy");
  }
  await requireDb().insert(fileObjects).ignore().values({ fileId: file.id, backend: store.backend, bucket: store.bucket, objectKey: key, sizeBytes: bytes.byteLength });
  return already ? "skipped" : "copied";
}

async function verifyOne(store: ObjectStore, file: StoredMeta) {
  const stored = await store.stat(file.objectKey);
  if (!stored) throw new Error("object missing from the bucket");
  if (stored.size !== file.storedBytes) throw new Error(`size mismatch: bucket ${stored.size}, recorded ${file.storedBytes}`);
  if (!Number(file.hasData) || !isMd5(stored.etag)) return;
  const bytes = await mysqlBytes(file.id);
  if (bytes.byteLength !== stored.size) throw new Error(`size mismatch: bucket ${stored.size}, MySQL ${bytes.byteLength}`);
  if (md5Hex(bytes) !== stored.etag) throw new Error("checksum mismatch with the MySQL copy");
}

async function purgeOne(store: ObjectStore, file: StoredMeta) {
  const stored = await store.stat(file.objectKey);
  if (!stored || stored.size !== file.sizeBytes) throw new Error(`object missing or wrong size (${stored?.size ?? "none"} vs ${file.sizeBytes}); not purging`);
  await requireDb().update(files).set({ dataBase64: "" }).where(eq(files.id, file.id));
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export async function migrateFiles(opts: MigrateOptions): Promise<MigrateReport> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const batchSize = opts.batchSize ?? 50;
  const concurrency = opts.concurrency ?? 1;
  const report: MigrateReport = { mode: opts.mode, apply: opts.apply, candidates: 0, bytes: 0, done: 0, skipped: 0, failed: [], stopped: false, cursor: opts.after ?? "" };
  for (;;) {
    const left = opts.limit !== undefined ? opts.limit - report.candidates : batchSize;
    if (left <= 0) break;
    const size = Math.min(batchSize, left);
    const batch: Array<FileMeta | StoredMeta> =
      opts.mode === "copy" ? await nextCopyBatch(report.cursor, size) : await nextStoredBatch(report.cursor, size, opts.store.bucket, opts.mode === "purge");
    if (!batch.length) break;

    await eachLimited(batch, concurrency, async (file) => {
      if (report.stopped || opts.shouldStop?.()) {
        report.stopped = true;
        return;
      }
      report.candidates++;
      report.bytes += file.sizeBytes;
      if (!opts.apply) {
        log(`[dry-run] ${opts.mode} ${file.id} ${file.fileName} (${file.sizeBytes} B)`);
        return;
      }
      let outcome: FileOutcome;
      try {
        if (opts.mode === "copy") {
          const result = await copyOne(opts.store, file);
          if (result === "skipped") report.skipped++;
          outcome = { id: file.id, fileName: file.fileName, bytes: file.sizeBytes, status: result };
        } else if (opts.mode === "verify") {
          await verifyOne(opts.store, file as StoredMeta);
          outcome = { id: file.id, fileName: file.fileName, bytes: file.sizeBytes, status: "verified" };
        } else {
          await purgeOne(opts.store, file as StoredMeta);
          outcome = { id: file.id, fileName: file.fileName, bytes: file.sizeBytes, status: "purged" };
        }
        report.done++;
        log(`${opts.mode} ${outcome.status} ${file.id} ${file.fileName}`);
      } catch (error) {
        const message = redactR2Secrets(error instanceof Error ? error.message : String(error));
        report.failed.push({ id: file.id, fileName: file.fileName, error: message });
        outcome = { id: file.id, fileName: file.fileName, bytes: file.sizeBytes, status: "failed", error: message };
        log(`${opts.mode} FAILED ${file.id}: ${message}`);
      }
      opts.onFile?.(outcome);
    });
    if (report.stopped) break;
    report.cursor = batch[batch.length - 1].id;
  }
  return report;
}

/** How many files (and bytes) a copy or verify run would go through right now. */
export async function migrationTotals(mode: "copy" | "verify", bucket: string) {
  const db = requireDb();
  const [row] =
    mode === "copy"
      ? await db
          .select({ count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)` })
          .from(files)
          .leftJoin(fileObjects, eq(fileObjects.fileId, files.id))
          .where(and(isNull(fileObjects.fileId), ne(files.dataBase64, "")))
      : await db
          .select({ count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${fileObjects.sizeBytes}), 0)` })
          .from(fileObjects)
          .where(eq(fileObjects.bucket, bucket));
  return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
}

export interface MigrationPlan {
  bucket: string;
  /** Files only in MySQL that a copy would upload. */
  toCopy: { count: number; bytes: number; largestBytes: number };
  /** Files already recorded in this bucket. */
  inBucket: { count: number; bytes: number };
  /** Recorded in a different bucket (R2_BUCKET changed?): neither copied again nor downloadable. */
  inOtherBucket: number;
  /** Rows with neither MySQL bytes nor an object: nothing to copy. */
  missingData: number;
  /** A HEAD on a random key: 404 means the credentials and bucket work. */
  connection: { ok: true } | { ok: false; error: string };
}

/** Read-only overview for a dry run: counts from MySQL plus one HEAD request to the bucket. */
export async function migrationPlan(store: ObjectStore): Promise<MigrationPlan> {
  const db = requireDb();
  const n = (v: unknown) => Number(v ?? 0);
  const [toCopy] = await db
    .select({ count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`, largest: sql<number>`coalesce(max(${files.sizeBytes}), 0)` })
    .from(files)
    .leftJoin(fileObjects, eq(fileObjects.fileId, files.id))
    .where(and(isNull(fileObjects.fileId), ne(files.dataBase64, "")));
  const [missing] = await db
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .leftJoin(fileObjects, eq(fileObjects.fileId, files.id))
    .where(and(isNull(fileObjects.fileId), eq(files.dataBase64, "")));
  const [inBucket] = await db
    .select({ count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${fileObjects.sizeBytes}), 0)` })
    .from(fileObjects)
    .where(eq(fileObjects.bucket, store.bucket));
  const [elsewhere] = await db.select({ count: sql<number>`count(*)` }).from(fileObjects).where(ne(fileObjects.bucket, store.bucket));

  let connection: MigrationPlan["connection"] = { ok: true };
  try {
    await store.stat(`healthcheck/${randomUUID()}`);
  } catch (error) {
    connection = { ok: false, error: redactR2Secrets(error instanceof Error ? `${error.name}: ${error.message}` : String(error)) };
  }
  return {
    bucket: store.bucket,
    toCopy: { count: n(toCopy?.count), bytes: n(toCopy?.bytes), largestBytes: n(toCopy?.largest) },
    inBucket: { count: n(inBucket?.count), bytes: n(inBucket?.bytes) },
    inOtherBucket: n(elsewhere?.count),
    missingData: n(missing?.count),
    connection,
  };
}
