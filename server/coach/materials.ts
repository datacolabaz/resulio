import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { coachChunks, coachMaterials, coachTopics, type CoachMaterialRow } from "../../drizzle/schema";
import {
  COACH_MAX_CHARS,
  COACH_MAX_PASTE_CHARS,
  COACH_UPLOAD_EXTENSIONS,
  materialStage,
  type CoachLocale,
  type MaterialError,
  type MaterialGoal,
} from "../../shared/coach";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { deleteFile, extensionOf, fileBytes, fileRow, saveFile, ALLOWED_FILE_TYPES } from "../modules/files";
import { generateStructured, withCoachAi } from "./ai";
import { chunkPages, normalizeText, titleFromText, type DraftChunk, type PageText } from "./chunker";
import { extractSource, IngestError } from "./extract";
import { coachModels } from "./models";
import { assertCoachAiAllowed, assertDailyCap, coachLimits } from "./quota";
import { fallbackTopics, normalizeTopics, segmentJsonSchema, segmentMessages, segmentSchema, type DraftTopic } from "./segment";
import { logEvent } from "./store";

/**
 * A student's own materials: upload/paste → extract pages → chunks → topics. Files live in `files`
 * under the private workspace id `coach-u<studentId>` (no provider workspace has such an id, so
 * no teacher can reach them; downloads are allowed to the uploader only).
 */

export const coachWorkspaceId = (studentId: number) => `coach-u${studentId}`;
export const MATERIAL_STALE_MS = 15 * 60 * 1000;

export const COACH_FILE_TYPES: Record<string, string> = Object.fromEntries(COACH_UPLOAD_EXTENSIONS.map((ext) => [ext, ALLOWED_FILE_TYPES[ext]]));

const inFlight = (s: CoachMaterialRow["status"]) => s === "QUEUED" || s === "EXTRACTING" || s === "SEGMENTING";

/** A run that outlived a restart is shown as failed (INTERRUPTED) so the student can retry it. */
export function effectiveStatus(m: Pick<CoachMaterialRow, "status" | "errorCode" | "updatedAt">, now = Date.now()) {
  if (inFlight(m.status) && now - m.updatedAt.getTime() > MATERIAL_STALE_MS) return { status: "FAILED" as const, errorCode: "INTERRUPTED" as MaterialError };
  return { status: m.status, errorCode: m.errorCode ?? null };
}

export function materialView(m: CoachMaterialRow, topicCount = 0) {
  const { status, errorCode } = effectiveStatus(m);
  return {
    id: m.id,
    title: m.title,
    source: m.source,
    goal: m.goal,
    fileId: m.fileId,
    fileName: m.fileName,
    sizeBytes: m.sizeBytes,
    pageCount: m.pageCount,
    status,
    stage: materialStage(status),
    errorCode,
    needsReview: m.needsReview,
    ocrPages: m.ocrPages,
    topicCount,
    createdAt: m.createdAt,
    lastOpenedAt: m.lastOpenedAt,
  };
}
export type CoachMaterialView = ReturnType<typeof materialView>;

export async function ownedMaterial(studentId: number, id: string): Promise<CoachMaterialRow> {
  const [m] = await requireDb()
    .select()
    .from(coachMaterials)
    .where(and(eq(coachMaterials.id, id), eq(coachMaterials.studentId, studentId)))
    .limit(1);
  if (!m) throw new AppError("NOT_FOUND");
  return m;
}

export async function listMaterials(studentId: number) {
  const db = requireDb();
  const rows = await db.select().from(coachMaterials).where(eq(coachMaterials.studentId, studentId)).orderBy(desc(coachMaterials.createdAt));
  if (!rows.length) return [];
  const counts = await db
    .select({ materialId: coachTopics.materialId, n: count() })
    .from(coachTopics)
    .where(inArray(coachTopics.materialId, rows.map((r) => r.id)))
    .groupBy(coachTopics.materialId);
  const byId = new Map(counts.map((c) => [c.materialId, Number(c.n)]));
  return rows.map((r) => materialView(r, byId.get(r.id) ?? 0));
}

export async function topicsOf(materialId: string) {
  return requireDb().select().from(coachTopics).where(eq(coachTopics.materialId, materialId)).orderBy(asc(coachTopics.ord));
}

export async function materialDetail(studentId: number, id: string) {
  const m = await ownedMaterial(studentId, id);
  const topics = await topicsOf(id);
  if (m.status === "READY") await requireDb().update(coachMaterials).set({ lastOpenedAt: new Date(), updatedAt: m.updatedAt }).where(eq(coachMaterials.id, id));
  return { ...materialView(m, topics.length), topics: topics.map((t) => ({ id: t.id, ord: t.ord, title: t.title, pageFrom: t.pageFrom, pageTo: t.pageTo })) };
}

async function assertCanAdd(studentId: number) {
  const limits = await coachLimits();
  if (limits.maxMaterials > 0) {
    const [row] = await requireDb().select({ n: count() }).from(coachMaterials).where(eq(coachMaterials.studentId, studentId));
    if (Number(row?.n ?? 0) >= limits.maxMaterials) throw new AppError("COACH_MATERIAL_LIMIT");
  }
  await assertDailyCap(studentId, "UPLOAD", limits.uploadsPerDay);
}

/** Checked by the upload endpoint before the bytes are stored. */
export async function assertUploadAllowed(studentId: number, fileName: string) {
  if (!COACH_FILE_TYPES[extensionOf(fileName)]) throw new AppError("COACH_FILE_TYPE");
  await assertCanAdd(studentId);
}

const cleanTitle = (title: string | undefined, fallback: string) => (title?.replace(/\s+/g, " ").trim() || fallback).slice(0, 200) || "—";

export async function createFromFile(studentId: number, input: { fileId: string; title?: string; goal: MaterialGoal; locale: CoachLocale }) {
  const file = await fileRow(input.fileId);
  if (!file || file.uploadedBy !== studentId || file.workspaceId !== coachWorkspaceId(studentId)) throw new AppError("FILE_NOT_FOUND");
  const [used] = await requireDb().select({ id: coachMaterials.id }).from(coachMaterials).where(eq(coachMaterials.fileId, file.id)).limit(1);
  if (used) throw new AppError("COACH_BUSY");
  await assertCanAdd(studentId);
  const baseName = file.fileName.replace(/\.[^.]+$/, "");
  return insertAndRun(studentId, {
    title: cleanTitle(input.title, baseName),
    source: "UPLOAD",
    goal: input.goal,
    fileId: file.id,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  }, input.locale);
}

export async function createFromText(studentId: number, input: { text: string; title?: string; goal: MaterialGoal; locale: CoachLocale }) {
  const text = normalizeText(input.text);
  if (text.replace(/\s/g, "").length < 50) throw new AppError("COACH_NOT_ENOUGH_CONTENT");
  if (text.length > COACH_MAX_PASTE_CHARS) throw new AppError("FILE_TOO_LARGE");
  await assertCanAdd(studentId);
  const title = cleanTitle(input.title, titleFromText(text));
  const saved = await saveFile({
    workspaceId: coachWorkspaceId(studentId),
    uploadedBy: studentId,
    fileName: `${title.replace(/[\\/:*?"<>|]/g, " ").slice(0, 120)}.txt`,
    buffer: Buffer.from(text, "utf8"),
    isPublic: false,
    allowedTypes: { ".txt": "text/plain" },
  });
  return insertAndRun(studentId, { title, source: "TEXT", goal: input.goal, fileId: saved.id, fileName: saved.name, mimeType: saved.mimeType, sizeBytes: saved.size }, input.locale);
}

async function insertAndRun(studentId: number, values: Omit<typeof coachMaterials.$inferInsert, "id" | "studentId" | "runId" | "status">, locale: CoachLocale) {
  const id = nanoid();
  const runId = nanoid();
  await requireDb().insert(coachMaterials).values({ ...values, id, studentId, runId, status: "QUEUED" });
  await logEvent(studentId, "UPLOAD", id, { source: values.source });
  scheduleRun(studentId, id, runId, locale);
  return materialView(await ownedMaterial(studentId, id));
}

export async function retryMaterial(studentId: number, id: string, locale: CoachLocale) {
  const m = await ownedMaterial(studentId, id);
  if (effectiveStatus(m).status !== "FAILED") throw new AppError("COACH_BUSY");
  const runId = nanoid();
  await requireDb().update(coachMaterials).set({ status: "QUEUED", errorCode: null, runId }).where(eq(coachMaterials.id, id));
  scheduleRun(studentId, id, runId, locale);
  return materialView(await ownedMaterial(studentId, id));
}

export async function renameMaterial(studentId: number, id: string, title: string) {
  await ownedMaterial(studentId, id);
  await requireDb().update(coachMaterials).set({ title: cleanTitle(title, "—") }).where(eq(coachMaterials.id, id));
  return materialView(await ownedMaterial(studentId, id));
}

/**
 * Every row that belongs to one material. Later phases register their tables here so deleting a
 * material (or all coach data) never leaves orphans.
 */
const materialCascade: ((materialIds: string[]) => Promise<void>)[] = [
  async (ids) => void (await requireDb().delete(coachChunks).where(inArray(coachChunks.materialId, ids))),
  async (ids) => void (await requireDb().delete(coachTopics).where(inArray(coachTopics.materialId, ids))),
];
export function onMaterialDelete(fn: (materialIds: string[]) => Promise<void>) {
  materialCascade.push(fn);
}

export async function deleteMaterials(studentId: number, ids: string[]) {
  if (!ids.length) return 0;
  const db = requireDb();
  const rows = await db.select().from(coachMaterials).where(and(eq(coachMaterials.studentId, studentId), inArray(coachMaterials.id, ids)));
  if (!rows.length) return 0;
  const owned = rows.map((r) => r.id);
  // Stop any run still in flight: it checks runId before every write.
  await db.update(coachMaterials).set({ runId: null }).where(inArray(coachMaterials.id, owned));
  for (const step of materialCascade) await step(owned);
  await db.delete(coachMaterials).where(inArray(coachMaterials.id, owned));
  for (const r of rows) if (r.fileId) await deleteFile(r.fileId).catch((error) => console.warn("[coach] file delete failed", r.fileId, error instanceof Error ? error.message : error));
  return owned.length;
}

export async function deleteMaterial(studentId: number, id: string) {
  await ownedMaterial(studentId, id);
  await deleteMaterials(studentId, [id]);
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Processing run
// ---------------------------------------------------------------------------

function scheduleRun(studentId: number, materialId: string, runId: string, locale: CoachLocale) {
  withCoachAi(studentId, "COACH_INGEST", () =>
    setImmediate(() => {
      runMaterial(materialId, runId, locale).catch(async (error) => {
        console.error("[coach] material run failed", materialId, error instanceof Error ? error.message : error);
        await finish(materialId, runId, { status: "FAILED", errorCode: "INTERNAL" }).catch(() => false);
      });
    }),
  );
}

async function progress(materialId: string, runId: string, patch: Partial<CoachMaterialRow>): Promise<boolean> {
  const [result] = await requireDb()
    .update(coachMaterials)
    .set(patch)
    .where(and(eq(coachMaterials.id, materialId), eq(coachMaterials.runId, runId)));
  return result.affectedRows === 1;
}
const finish = progress;

/** Reads the pages of a material; OCR of scanned pages and images is plugged in here (ocrPages). */
export interface PageReader {
  (input: { material: CoachMaterialRow; bytes: Buffer; locale: CoachLocale }): Promise<{ pages: PageText[]; pageCount: number; ocrPages: number; ocrScore: number | null; needsReview: boolean }>;
}

export const readPagesDirect: PageReader = async ({ material, bytes }) => {
  const source = await extractSource(material.fileName ?? "", bytes);
  if (source.kind === "image") throw new IngestError("NO_TEXT");
  const scanned = new Set(source.scanned);
  const pages = source.texts.flatMap((text, i) => (scanned.has(i + 1) ? [] : [{ page: i + 1, text, method: "TEXT" as const, quality: null }]));
  return { pages, pageCount: source.texts.length, ocrPages: 0, ocrScore: null, needsReview: false };
};

let pageReader: PageReader = readPagesDirect;
export function setPageReader(reader: PageReader) {
  pageReader = reader;
}

/** Keeps whole pages up to the character cap. */
export function capPages(pages: PageText[], max = COACH_MAX_CHARS): PageText[] {
  const out: PageText[] = [];
  let total = 0;
  for (const p of pages) {
    if (total + p.text.length > max) {
      if (!out.length) out.push({ ...p, text: p.text.slice(0, max) });
      break;
    }
    out.push(p);
    total += p.text.length;
  }
  return out;
}

async function segment(studentId: number, chunks: DraftChunk[], locale: CoachLocale): Promise<DraftTopic[]> {
  if (chunks.length <= 2) return fallbackTopics(chunks);
  try {
    await assertCoachAiAllowed(studentId);
    const { lite } = await coachModels();
    const { data } = await generateStructured({ model: lite, messages: segmentMessages(chunks, locale), schema: segmentSchema, jsonSchema: segmentJsonSchema, maxTokens: 4096, timeoutMs: 90_000 });
    return normalizeTopics(data.topics, chunks) ?? fallbackTopics(chunks);
  } catch (error) {
    console.warn("[coach] segmentation fell back to headings", error instanceof Error ? error.message : error);
    return fallbackTopics(chunks);
  }
}

export async function runMaterial(materialId: string, runId: string, locale: CoachLocale) {
  const db = requireDb();
  const [material] = await db.select().from(coachMaterials).where(eq(coachMaterials.id, materialId)).limit(1);
  if (!material || material.runId !== runId) return;
  if (!(await progress(materialId, runId, { status: "EXTRACTING" }))) return;

  const file = material.fileId ? await fileRow(material.fileId) : null;
  if (!file) {
    await finish(materialId, runId, { status: "FAILED", errorCode: "FILE_MISSING" });
    return;
  }
  let read;
  try {
    read = await pageReader({ material, bytes: await fileBytes(file), locale });
  } catch (error) {
    const code: MaterialError = error instanceof IngestError ? error.code : error instanceof AppError && error.code === "COACH_AI_BUSY" ? "AI_QUOTA" : "UNREADABLE";
    if (!(error instanceof IngestError)) console.warn("[coach] extraction failed", materialId, error instanceof Error ? error.message : error);
    await finish(materialId, runId, { status: "FAILED", errorCode: code });
    return;
  }
  const pages = capPages(read.pages.filter((p) => p.text.trim()));
  const charCount = pages.reduce((n, p) => n + p.text.length, 0);
  if (pages.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0) < 50) {
    await finish(materialId, runId, { status: "FAILED", errorCode: "NO_TEXT", pageCount: read.pageCount, ocrPages: read.ocrPages });
    return;
  }
  const chunks = chunkPages(pages);
  if (!(await progress(materialId, runId, { status: "SEGMENTING", pageCount: read.pageCount, charCount, ocrPages: read.ocrPages }))) return;
  const topics = await segment(material.studentId, chunks, locale);

  const topicIds = topics.map(() => nanoid());
  const topicOfChunk = (ord: number) => topicIds[topics.findIndex((t) => ord >= t.from && ord <= t.to)] ?? null;
  const stillOurs = await db.transaction(async (tx) => {
    const [current] = await tx.select({ runId: coachMaterials.runId }).from(coachMaterials).where(eq(coachMaterials.id, materialId)).for("update");
    if (current?.runId !== runId) return false;
    await tx.delete(coachChunks).where(eq(coachChunks.materialId, materialId));
    await tx.delete(coachTopics).where(eq(coachTopics.materialId, materialId));
    if (topics.length) {
      await tx.insert(coachTopics).values(topics.map((t, i) => ({ id: topicIds[i], materialId, studentId: material.studentId, ord: t.ord, title: t.title, pageFrom: t.pageFrom, pageTo: t.pageTo })));
    }
    const rows = chunks.map((c) => ({ id: nanoid(), materialId, studentId: material.studentId, topicId: topicOfChunk(c.ord), ord: c.ord, pageFrom: c.pageFrom, pageTo: c.pageTo, heading: c.heading, text: c.text, method: c.method, quality: c.quality }));
    for (let i = 0; i < rows.length; i += 100) await tx.insert(coachChunks).values(rows.slice(i, i + 100));
    await tx
      .update(coachMaterials)
      .set({ status: "READY", errorCode: null, ocrScore: read.ocrScore, needsReview: read.needsReview, textRevision: material.textRevision + 1 })
      .where(eq(coachMaterials.id, materialId));
    return true;
  });
  if (stillOurs) await logEvent(material.studentId, "MATERIAL_READY", materialId, { pages: read.pageCount, chunks: chunks.length, topics: topics.length, ocrPages: read.ocrPages });
}
