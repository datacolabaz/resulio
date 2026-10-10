import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { fileObjects, files, materials, providerWorkspaces, questionImportJobs, syllabusImportJobs, users } from "../../drizzle/schema";
import { requireDb } from "../db";
import { getPlatformSettings } from "../platformSettings";
import { r2ConfigFromEnv, uploadBackend } from "./r2";

/**
 * Admin storage summary, from file metadata only (never the base64 column). "Feature" is inferred
 * from what references a file: materials and import jobs name it directly; a file uploaded by
 * someone other than the workspace owner is a student's submission; the rest are task attachments
 * and syllabus content.
 */

export const STORAGE_FEATURES = ["MATERIAL", "QUESTION_IMPORT", "SYLLABUS_IMPORT", "STUDENT_SUBMISSION", "OTHER"] as const;
export type StorageFeature = (typeof STORAGE_FEATURES)[number];

export const FILE_TYPE_GROUPS = ["PDF", "IMAGE", "DOCUMENT", "SPREADSHEET", "PRESENTATION", "TEXT", "OTHER"] as const;
export type FileTypeGroup = (typeof FILE_TYPE_GROUPS)[number];

export function fileTypeGroup(mimeType: string): FileTypeGroup {
  const m = mimeType.toLowerCase();
  if (m === "application/pdf") return "PDF";
  if (m.startsWith("image/")) return "IMAGE";
  if (m.includes("spreadsheet") || m.includes("ms-excel") || m === "text/csv") return "SPREADSHEET";
  if (m.includes("presentation") || m.includes("powerpoint")) return "PRESENTATION";
  if (m.includes("wordprocessing") || m === "application/msword") return "DOCUMENT";
  if (m.startsWith("text/")) return "TEXT";
  return "OTHER";
}

/** Sums rows of one grouping into the fixed group list (groups without files are left out). */
export function groupTotals<K extends string>(rows: Array<{ key: K; count: number; bytes: number }>, order: readonly K[]) {
  const totals = new Map<K, { count: number; bytes: number }>();
  for (const r of rows) {
    const t = totals.get(r.key) ?? { count: 0, bytes: 0 };
    t.count += Number(r.count);
    t.bytes += Number(r.bytes);
    totals.set(r.key, t);
  }
  return order.filter((k) => totals.has(k)).map((k) => ({ key: k, ...totals.get(k)! }));
}

const n = (v: unknown) => Number(v ?? 0);

export async function storageSummary() {
  const db = requireDb();
  const hasData = sql`${files.dataBase64} <> ''`;
  const [total] = await db
    .select({
      count: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`,
      dbCount: sql<number>`coalesce(sum(case when ${hasData} then 1 else 0 end), 0)`,
      dbBytes: sql<number>`coalesce(sum(case when ${hasData} then ${files.sizeBytes} else 0 end), 0)`,
    })
    .from(files);
  const [inObjects] = await db
    .select({
      count: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`,
      bothCount: sql<number>`coalesce(sum(case when ${hasData} then 1 else 0 end), 0)`,
    })
    .from(files)
    .innerJoin(fileObjects, eq(fileObjects.fileId, files.id));

  const byMime = await db
    .select({ mimeType: files.mimeType, count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)` })
    .from(files)
    .groupBy(files.mimeType);

  const m = db.selectDistinct({ fileId: materials.fileId }).from(materials).where(isNotNull(materials.fileId)).as("m");
  const q = db.selectDistinct({ fileId: questionImportJobs.fileId }).from(questionImportJobs).as("q");
  const s = db.selectDistinct({ fileId: syllabusImportJobs.fileId }).from(syllabusImportJobs).where(isNotNull(syllabusImportJobs.fileId)).as("s");
  const feature = sql<StorageFeature>`case
    when ${m.fileId} is not null then 'MATERIAL'
    when ${q.fileId} is not null then 'QUESTION_IMPORT'
    when ${s.fileId} is not null then 'SYLLABUS_IMPORT'
    when ${providerWorkspaces.ownerUserId} is not null and ${files.uploadedBy} <> ${providerWorkspaces.ownerUserId} then 'STUDENT_SUBMISSION'
    else 'OTHER' end`;
  const byFeatureRows = await db
    .select({ key: feature, count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)` })
    .from(files)
    .leftJoin(providerWorkspaces, eq(providerWorkspaces.id, files.workspaceId))
    .leftJoin(m, eq(m.fileId, files.id))
    .leftJoin(q, eq(q.fileId, files.id))
    .leftJoin(s, eq(s.fileId, files.id))
    .groupBy(feature);

  const byTeacher = await db
    .select({
      userId: providerWorkspaces.ownerUserId,
      name: users.name,
      email: users.email,
      count: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`,
    })
    .from(files)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, files.workspaceId))
    .leftJoin(users, eq(users.id, providerWorkspaces.ownerUserId))
    .groupBy(providerWorkspaces.ownerUserId, users.name, users.email)
    .orderBy(desc(sql`coalesce(sum(${files.sizeBytes}), 0)`))
    .limit(20);

  const largest = await db
    .select({
      id: files.id,
      fileName: files.fileName,
      mimeType: files.mimeType,
      sizeBytes: files.sizeBytes,
      createdAt: files.createdAt,
      workspaceTitle: providerWorkspaces.title,
      uploaderName: users.name,
      inObjectStore: sql<number>`${fileObjects.fileId} is not null`,
    })
    .from(files)
    .leftJoin(providerWorkspaces, eq(providerWorkspaces.id, files.workspaceId))
    .leftJoin(users, eq(users.id, files.uploadedBy))
    .leftJoin(fileObjects, eq(fileObjects.fileId, files.id))
    .orderBy(desc(files.sizeBytes))
    .limit(20);

  const settings = await getPlatformSettings();
  const r2 = r2ConfigFromEnv();
  return {
    totalFiles: n(total?.count),
    totalBytes: n(total?.bytes),
    softQuotaBytes: settings["storage.softQuotaBytes"] || null,
    materialUploadLimitsMb: settings["storage.materialUploadLimitsMb"] ?? null,
    workspaceQuotaBytes: settings["storage.workspaceQuotaBytes"] || null,
    backend: {
      uploadsTo: uploadBackend(),
      r2Configured: !!r2,
      r2Bucket: r2?.bucket ?? null,
      /** Files whose bytes are still in MySQL, including copies already in R2 (kept until the CLI purge). */
      inDatabase: { count: n(total?.dbCount), bytes: n(total?.dbBytes) },
      inObjectStore: { count: n(inObjects?.count), bytes: n(inObjects?.bytes) },
      inBoth: n(inObjects?.bothCount),
    },
    byType: groupTotals(byMime.map((r) => ({ key: fileTypeGroup(r.mimeType), count: n(r.count), bytes: n(r.bytes) })), FILE_TYPE_GROUPS),
    byFeature: groupTotals(byFeatureRows.map((r) => ({ key: r.key, count: n(r.count), bytes: n(r.bytes) })), STORAGE_FEATURES),
    byTeacher: byTeacher.map((r) => ({ userId: r.userId, name: r.name, email: r.email, count: n(r.count), bytes: n(r.bytes) })),
    largest: largest.map((r) => ({ ...r, typeGroup: fileTypeGroup(r.mimeType), inObjectStore: Boolean(Number(r.inObjectStore)) })),
  };
}

/** Total bytes stored, for the dashboard. */
export async function storageTotalBytes() {
  const [row] = await requireDb().select({ bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)` }).from(files);
  return n(row?.bytes);
}
