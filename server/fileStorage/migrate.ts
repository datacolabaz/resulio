import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { fileObjects, files } from "../../drizzle/schema";
import { requireDb } from "../db";
import { objectKeyFor, type ObjectStore } from "./r2";

/**
 * Moves file bytes from MySQL (files.dataBase64) to the object store, in two separate steps:
 * "copy" uploads each file, checks the stored size and records it in file_objects (the MySQL copy
 * stays and is still what downloads read); "purge" then empties dataBase64 only for files whose
 * object is confirmed present with the right size. Both are idempotent and resumable.
 */

export interface MigrateOptions {
  store: ObjectStore;
  mode: "copy" | "purge";
  /** false = only report what would happen. */
  apply: boolean;
  batchSize?: number;
  limit?: number;
  log?: (line: string) => void;
}

export interface MigrateReport {
  mode: "copy" | "purge";
  apply: boolean;
  candidates: number;
  bytes: number;
  done: number;
  failed: Array<{ id: string; error: string }>;
}

const meta = { id: files.id, workspaceId: files.workspaceId, fileName: files.fileName, mimeType: files.mimeType, sizeBytes: files.sizeBytes };

async function nextCopyBatch(after: string, size: number) {
  return requireDb()
    .select(meta)
    .from(files)
    .leftJoin(fileObjects, eq(fileObjects.fileId, files.id))
    .where(and(gt(files.id, after), isNull(fileObjects.fileId), ne(files.dataBase64, "")))
    .orderBy(asc(files.id))
    .limit(size);
}

async function nextPurgeBatch(after: string, size: number, bucket: string) {
  return requireDb()
    .select({ ...meta, objectKey: fileObjects.objectKey })
    .from(files)
    .innerJoin(fileObjects, eq(fileObjects.fileId, files.id))
    .where(and(gt(files.id, after), eq(fileObjects.bucket, bucket), ne(files.dataBase64, "")))
    .orderBy(asc(files.id))
    .limit(size);
}

export async function migrateFiles(opts: MigrateOptions): Promise<MigrateReport> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const batchSize = opts.batchSize ?? 50;
  const report: MigrateReport = { mode: opts.mode, apply: opts.apply, candidates: 0, bytes: 0, done: 0, failed: [] };
  const db = requireDb();
  let after = "";
  for (;;) {
    const left = opts.limit !== undefined ? opts.limit - report.candidates : batchSize;
    if (left <= 0) break;
    const batch = opts.mode === "copy" ? await nextCopyBatch(after, Math.min(batchSize, left)) : await nextPurgeBatch(after, Math.min(batchSize, left), opts.store.bucket);
    if (!batch.length) break;
    after = batch[batch.length - 1].id;
    for (const file of batch) {
      report.candidates++;
      report.bytes += file.sizeBytes;
      if (!opts.apply) {
        log(`[dry-run] ${opts.mode} ${file.id} ${file.fileName} (${file.sizeBytes} B)`);
        continue;
      }
      try {
        if (opts.mode === "copy") {
          const [row] = await db.select({ data: files.dataBase64 }).from(files).where(eq(files.id, file.id)).limit(1);
          const bytes = Buffer.from(row?.data ?? "", "base64");
          const key = objectKeyFor(file);
          await opts.store.put(key, bytes, file.mimeType);
          const stored = await opts.store.head(key);
          if (stored !== bytes.byteLength) throw new Error(`size check failed: stored ${stored ?? "none"}, expected ${bytes.byteLength}`);
          await db.insert(fileObjects).ignore().values({ fileId: file.id, backend: opts.store.backend, bucket: opts.store.bucket, objectKey: key, sizeBytes: bytes.byteLength });
        } else {
          const objectKey = (file as typeof file & { objectKey: string }).objectKey;
          const stored = await opts.store.head(objectKey);
          if (stored === null || stored !== file.sizeBytes) throw new Error(`object missing or wrong size (${stored ?? "none"} vs ${file.sizeBytes}); not purging`);
          await db.update(files).set({ dataBase64: "" }).where(eq(files.id, file.id));
        }
        report.done++;
        log(`${opts.mode} ok ${file.id} ${file.fileName}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.failed.push({ id: file.id, error: message });
        log(`${opts.mode} FAILED ${file.id}: ${message}`);
      }
    }
  }
  return report;
}

/** Files still only in MySQL, and files already in the object store (for the script's summary line). */
export async function migrationStatus() {
  const db = requireDb();
  const [inDb] = await db
    .select({ count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)` })
    .from(files)
    .leftJoin(fileObjects, eq(fileObjects.fileId, files.id))
    .where(isNull(fileObjects.fileId));
  const [inStore] = await db.select({ count: sql<number>`count(*)` }).from(fileObjects);
  return { onlyInDatabase: Number(inDb?.count ?? 0), onlyInDatabaseBytes: Number(inDb?.bytes ?? 0), inObjectStore: Number(inStore?.count ?? 0) };
}
