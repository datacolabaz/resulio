import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { coachChunks, coachMaterials, coachPageReports, coachTopics, type CoachMaterialRow } from "../../drizzle/schema";
import {
  COACH_MAX_CHARS,
  COACH_MAX_PASTE_CHARS,
  COACH_UPLOAD_EXTENSIONS,
  coachUploadLimits,
  materialStage,
  type CoachLocale,
  type MaterialError,
  type MaterialGoal,
  type MaterialPageReport,
  type MaterialProgress,
} from "../../shared/coach";
import { requireDb } from "../db";
import { uploadSigner } from "../fileStorage/r2";
import { AppError } from "../modules/errors";
import { deleteFile, extensionOf, fileBytes, fileRow, saveFile, ALLOWED_FILE_TYPES } from "../modules/files";
import { createLimiter, generateStructured, withCoachAi } from "./ai";
import { chunkPages, normalizeText, titleFromText, type DraftChunk, type PageText } from "./chunker";
import { IngestError } from "./extract";
import { coachModels } from "./models";
import { readPagesWithOcr } from "./ocr";
import { assertCoachAiAllowed, assertDailyCap, coachLimits } from "./quota";
import { fallbackTopics, finishTopics, normalizeTopics, segmentJsonSchema, segmentMessages, segmentSchema, startsOf, titleMessages, titlesJsonSchema, titlesSchema, type DraftTopic, type TopicPlan } from "./segment";
import { logEvent } from "./store";
import { AI_TITLE_MAX_WORDS, casingHints, chunkMaterial, frontMatterOf, introTitle, tocStarts, topicWord, usableTitle, type TocEntry } from "./structure";

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

/** Live progress of runs in this process (runs are in-process too); gone after a restart, like the run. */
const runProgress = new Map<string, MaterialProgress & { runId: string }>();

export function progressOf(m: Pick<CoachMaterialRow, "id" | "runId">, status: CoachMaterialRow["status"]): MaterialProgress | null {
  const p = runProgress.get(m.id);
  if (!p || p.runId !== m.runId || !inFlight(status)) return null;
  return { step: p.step, done: p.done, total: p.total };
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
    progress: progressOf(m, status),
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
  return {
    ...materialView(m, topics.length),
    pages: m.status === "READY" ? await pageReportOf(id) : null,
    topics: topics.map((t) => ({ id: t.id, ord: t.ord, title: t.title, pageFrom: t.pageFrom, pageTo: t.pageTo })),
  };
}

/** The page report of the last run; null for materials made before reports existed (or if the table is not there yet). */
export async function pageReportOf(materialId: string): Promise<MaterialPageReport | null> {
  try {
    const [row] = await requireDb().select({ report: coachPageReports.report }).from(coachPageReports).where(eq(coachPageReports.materialId, materialId)).limit(1);
    return row?.report ?? null;
  } catch (error) {
    console.warn("[coach] page report unavailable", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function savePageReport(materialId: string, studentId: number, report: MaterialPageReport) {
  try {
    await requireDb().insert(coachPageReports).values({ materialId, studentId, report }).onDuplicateKeyUpdate({ set: { report } });
  } catch (error) {
    console.warn("[coach] page report not saved", materialId, error instanceof Error ? error.message : error);
  }
}

async function assertCanAdd(studentId: number) {
  const limits = await coachLimits();
  if (limits.maxMaterials > 0) {
    const [row] = await requireDb().select({ n: count() }).from(coachMaterials).where(eq(coachMaterials.studentId, studentId));
    if (Number(row?.n ?? 0) >= limits.maxMaterials) throw new AppError("COACH_MATERIAL_LIMIT");
  }
  await assertDailyCap(studentId, "UPLOAD", limits.uploadsPerDay);
}

/** The size and page limits in force now: `coach.limits`, reduced to 8 MB when files cannot go to R2. */
export async function uploadLimits() {
  return coachUploadLimits(await coachLimits(), uploadSigner() !== null);
}

/** Checked before the bytes are stored (API upload) or before a direct upload is signed. */
export async function assertUploadAllowed(studentId: number, fileName: string, sizeBytes: number) {
  if (!COACH_FILE_TYPES[extensionOf(fileName)]) throw new AppError("COACH_FILE_TYPE");
  if (sizeBytes <= 0 || sizeBytes > (await uploadLimits()).maxBytes) throw new AppError("FILE_TOO_LARGE");
  await assertCanAdd(studentId);
}

const cleanTitle = (title: string | undefined, fallback: string) => (title?.replace(/\s+/g, " ").trim() || fallback).slice(0, 200) || "—";

export async function createFromFile(studentId: number, input: { fileId: string; title?: string; goal: MaterialGoal; locale: CoachLocale }) {
  const file = await fileRow(input.fileId);
  if (!file || file.uploadedBy !== studentId || file.workspaceId !== coachWorkspaceId(studentId)) throw new AppError("FILE_NOT_FOUND");
  const [used] = await requireDb().select({ id: coachMaterials.id }).from(coachMaterials).where(eq(coachMaterials.fileId, file.id)).limit(1);
  if (used) throw new AppError("COACH_BUSY");
  if (!COACH_FILE_TYPES[extensionOf(file.fileName)]) throw new AppError("COACH_FILE_TYPE");
  if (file.sizeBytes > (await uploadLimits()).maxBytes) throw new AppError("FILE_TOO_LARGE");
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
  async (ids) => void (await requireDb().delete(coachPageReports).where(inArray(coachPageReports.materialId, ids))),
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
// Recognised text: review and corrections
// ---------------------------------------------------------------------------

export const CHUNK_EDIT_MAX_CHARS = 20_000;

export async function materialChunks(studentId: number, id: string) {
  const m = await ownedMaterial(studentId, id);
  const rows = await requireDb().select().from(coachChunks).where(eq(coachChunks.materialId, id)).orderBy(asc(coachChunks.ord));
  return {
    material: materialView(m),
    pages: await pageReportOf(id),
    chunks: rows.map((c) => ({ id: c.id, ord: c.ord, topicId: c.topicId, pageFrom: c.pageFrom, pageTo: c.pageTo, heading: c.heading, text: c.text, method: c.method, quality: c.quality, edited: c.edited })),
  };
}

/** Hooks run after chunk text changed (generated content made from the old text is dropped). */
const textChangeHooks: ((materialId: string, topicIds: string[]) => Promise<void>)[] = [];
export function onMaterialTextChange(fn: (materialId: string, topicIds: string[]) => Promise<void>) {
  textChangeHooks.push(fn);
}

export async function updateChunk(studentId: number, materialId: string, chunkId: string, text: string) {
  const m = await ownedMaterial(studentId, materialId);
  if (m.status !== "READY") throw new AppError("COACH_NOT_READY");
  const clean = normalizeText(text);
  if (!clean) throw new AppError("COACH_NOT_ENOUGH_CONTENT");
  if (clean.length > CHUNK_EDIT_MAX_CHARS) throw new AppError("FILE_TOO_LARGE");
  const db = requireDb();
  const [chunk] = await db.select().from(coachChunks).where(and(eq(coachChunks.id, chunkId), eq(coachChunks.materialId, materialId))).limit(1);
  if (!chunk) throw new AppError("NOT_FOUND");
  if (chunk.text === clean) return { ok: true as const, changed: false };
  await db.update(coachChunks).set({ text: clean, edited: true }).where(eq(coachChunks.id, chunkId));
  await db.update(coachMaterials).set({ textRevision: m.textRevision + 1, charCount: Math.max(0, m.charCount - chunk.text.length + clean.length) }).where(eq(coachMaterials.id, materialId));
  for (const hook of textChangeHooks) await hook(materialId, chunk.topicId ? [chunk.topicId] : []);
  return { ok: true as const, changed: true };
}

interface PlacedChunk {
  chunk: DraftChunk;
  ord: number;
  topicId: string | null;
}

/**
 * Where late pages go in a ready material: each new chunk right before the first chunk of a later
 * page, in the topic whose pages cover it (else the topic before it, else the first). Existing
 * chunks keep their order and shift by `by` from `fromOrd` on (applied from the last insertion
 * point down); topics whose range a page falls outside of grow to include it.
 */
export function placeRecovered(
  existing: { ord: number; pageFrom: number }[],
  topics: { id: string; ord: number; pageFrom: number; pageTo: number }[],
  fresh: DraftChunk[],
): { shifts: { fromOrd: number; by: number }[]; inserts: PlacedChunk[]; ranges: { id: string; pageFrom: number; pageTo: number }[] } {
  const sorted = [...existing].sort((a, b) => a.ord - b.ord);
  const end = sorted.length ? sorted[sorted.length - 1].ord + 1 : 0;
  const byTopic = [...topics].sort((a, b) => a.ord - b.ord);
  const topicFor = (page: number) => byTopic.find((t) => page >= t.pageFrom && page <= t.pageTo) ?? [...byTopic].reverse().find((t) => t.pageFrom <= page) ?? byTopic[0] ?? null;
  const groups = new Map<number, DraftChunk[]>();
  for (const c of [...fresh].sort((a, b) => a.pageFrom - b.pageFrom)) {
    const at = sorted.find((e) => e.pageFrom > c.pageFrom)?.ord ?? end;
    groups.set(at, [...(groups.get(at) ?? []), c]);
  }
  const shifts: { fromOrd: number; by: number }[] = [];
  const inserts: PlacedChunk[] = [];
  let before = 0;
  for (const at of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(at)!;
    group.forEach((chunk, i) => inserts.push({ chunk, ord: at + before + i, topicId: topicFor(chunk.pageFrom)?.id ?? null }));
    shifts.push({ fromOrd: at, by: group.length });
    before += group.length;
  }
  const ranges = new Map<string, { id: string; pageFrom: number; pageTo: number }>();
  for (const { chunk, topicId } of inserts) {
    const t = topicId ? (ranges.get(topicId) ?? byTopic.find((x) => x.id === topicId)) : null;
    if (t && (chunk.pageFrom < t.pageFrom || chunk.pageTo > t.pageTo)) ranges.set(t.id, { id: t.id, pageFrom: Math.min(t.pageFrom, chunk.pageFrom), pageTo: Math.max(t.pageTo, chunk.pageTo) });
  }
  return { shifts: shifts.reverse(), inserts, ranges: [...ranges.values()] };
}

/**
 * Pages recognised after the material was ready (a background OCR retry) join it in place: topics,
 * their ids and everything attached to them stay; content generated from the topics that got new
 * text is dropped so it is made again with it. Returns the number of chunks added.
 */
export async function addRecoveredPages(materialId: string, pages: PageText[]): Promise<number> {
  const fresh = chunkPages([...pages].sort((a, b) => a.page - b.page));
  if (!fresh.length) return 0;
  const db = requireDb();
  const touched = await db.transaction(async (tx) => {
    const [m] = await tx.select().from(coachMaterials).where(eq(coachMaterials.id, materialId)).for("update");
    if (!m || m.status !== "READY") return null;
    const existing = await tx.select({ ord: coachChunks.ord, pageFrom: coachChunks.pageFrom }).from(coachChunks).where(eq(coachChunks.materialId, materialId));
    const topics = await tx.select({ id: coachTopics.id, ord: coachTopics.ord, pageFrom: coachTopics.pageFrom, pageTo: coachTopics.pageTo }).from(coachTopics).where(eq(coachTopics.materialId, materialId));
    const plan = placeRecovered(existing, topics, fresh);
    for (const s of plan.shifts) {
      await tx.update(coachChunks).set({ ord: sql`${coachChunks.ord} + ${s.by}` }).where(and(eq(coachChunks.materialId, materialId), gte(coachChunks.ord, s.fromOrd)));
    }
    await tx.insert(coachChunks).values(
      plan.inserts.map(({ chunk, ord, topicId }) => ({ id: nanoid(), materialId, studentId: m.studentId, topicId, ord, pageFrom: chunk.pageFrom, pageTo: chunk.pageTo, heading: chunk.heading, text: chunk.text, method: chunk.method, quality: chunk.quality })),
    );
    for (const r of plan.ranges) await tx.update(coachTopics).set({ pageFrom: r.pageFrom, pageTo: r.pageTo }).where(eq(coachTopics.id, r.id));
    const added = fresh.reduce((n, c) => n + c.text.length, 0);
    await tx.update(coachMaterials).set({ charCount: m.charCount + added, ocrPages: m.ocrPages + pages.length, textRevision: m.textRevision + 1, updatedAt: m.updatedAt }).where(eq(coachMaterials.id, materialId));
    return [...new Set(plan.inserts.flatMap((p) => (p.topicId ? [p.topicId] : [])))];
  });
  if (!touched) return 0;
  for (const hook of textChangeHooks) await hook(materialId, touched);
  return fresh.length;
}

/** The student checked the recognised text: the warning goes away. */
export async function markReviewed(studentId: number, materialId: string) {
  await ownedMaterial(studentId, materialId);
  await requireDb().update(coachMaterials).set({ needsReview: false }).where(eq(coachMaterials.id, materialId));
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Processing run
// ---------------------------------------------------------------------------

/** Material runs at the same time in this process; the rest wait as QUEUED ("Fayl yoxlanılır"). */
export const MATERIAL_RUN_CONCURRENCY = 3;
const materialRunSlot = createLimiter(MATERIAL_RUN_CONCURRENCY);

function scheduleRun(studentId: number, materialId: string, runId: string, locale: CoachLocale) {
  withCoachAi(studentId, "COACH_INGEST", () =>
    setImmediate(() => {
      materialRunSlot(() => runMaterial(materialId, runId, locale))
        .catch(async (error) => {
          console.error("[coach] material run failed", materialId, error instanceof Error ? error.message : error);
          await finish(materialId, runId, { status: "FAILED", errorCode: "INTERNAL" }).catch(() => false);
        })
        .finally(() => {
          if (runProgress.get(materialId)?.runId === runId) runProgress.delete(materialId);
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

/** Heartbeats closer than this are kept in memory only. */
const HEARTBEAT_MS = 20_000;

/**
 * Records progress for the status line and, at most every HEARTBEAT_MS, touches `updatedAt` so a
 * long OCR run is not mistaken for one that died in a restart. False when the run was replaced
 * (retry) or the material deleted: the caller stops.
 */
function progressReporter(materialId: string, runId: string) {
  let lastBeat = Date.now();
  return async (p: MaterialProgress): Promise<boolean> => {
    runProgress.set(materialId, { ...p, runId });
    if (Date.now() - lastBeat < HEARTBEAT_MS && p.done < p.total) return true;
    lastBeat = Date.now();
    return progress(materialId, runId, { updatedAt: new Date() });
  };
}

/** Reads the pages of a material: text layers directly, scanned pages and images through OCR (ocr.ts). */
export interface PageReader {
  (input: { material: CoachMaterialRow; bytes: Buffer; locale: CoachLocale; onProgress?: (p: MaterialProgress) => Promise<boolean> }): Promise<{
    pages: PageText[];
    pageCount: number;
    ocrPages: number;
    ocrScore: number | null;
    needsReview: boolean;
    /** Scanned pages left unread because of the OCR caps (or a provider that cannot read PDFs). */
    ocrSkipped: number;
    /** Scanned pages the provider failed on (after retries). */
    ocrFailed: number;
    /** Of those, pages left for the background retries (report.pending). */
    ocrPending?: number;
    report: MaterialPageReport;
  }>;
}

/** Hooks run (not awaited) once a material is READY, e.g. preparing the first topic's summary. */
export interface ReadyMaterial {
  studentId: number;
  materialId: string;
  locale: CoachLocale;
  firstTopicId: string | null;
}
const readyHooks: ((m: ReadyMaterial) => Promise<void>)[] = [];
export function onMaterialReady(fn: (m: ReadyMaterial) => Promise<void>) {
  readyHooks.push(fn);
}

const AI_ERRORS: Partial<Record<string, MaterialError>> = {
  COACH_AI_BUSY: "AI_QUOTA",
  COACH_AI_EXHAUSTED: "AI_EXHAUSTED",
  COACH_AI_CONFIG: "AI_CONFIG",
  COACH_AI_TIMEOUT: "AI_TIMEOUT",
  COACH_AI_UNSUPPORTED: "OCR_UNSUPPORTED",
  COACH_AI_UNAVAILABLE: "AI_UNAVAILABLE",
  AI_UNAVAILABLE: "AI_UNAVAILABLE",
  AI_INVALID_OUTPUT: "AI_UNAVAILABLE",
  COACH_MONTHLY_LIMIT: "AI_LIMIT",
  COACH_DAILY_LIMIT: "AI_LIMIT",
};

/** Why a run stopped, as the student sees it. */
export function materialErrorOf(error: unknown): MaterialError {
  if (error instanceof IngestError) return error.code;
  if (error instanceof AppError) return AI_ERRORS[error.code] ?? "INTERNAL";
  return "UNREADABLE";
}

/** The notice on a READY material: unread pages (failures) first, then pages left out by the caps. */
export function readyWarning(read: { ocrFailed: number; ocrSkipped: number }): MaterialError | null {
  if (read.ocrFailed > 0) return "OCR_PARTIAL";
  if (read.ocrSkipped > 0) return "OCR_LIMIT";
  return null;
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

/**
 * Topic segmentation never blocks a material for long. A table of contents that matches the text
 * gives the topics without AI; otherwise one lite call (no retries, short timeout), and anything
 * else (no answer in time, rate limit, unusable output) gives the heading-based topics. Every
 * source then gets readable titles and balanced lengths (`finishTopics`).
 */
export const SEGMENT_TIMEOUT_MS = 20_000;

export type TopicSource = "TOC" | "AI" | "HEADINGS";

export const defaultTopicPlan = (locale: CoachLocale): TopicPlan => ({ locale, hints: new Map(), names: [], minPages: 2, maxPages: 6 });

export async function segmentTopics(
  studentId: number,
  chunks: DraftChunk[],
  locale: CoachLocale,
  generate: typeof generateStructured = generateStructured,
  plan: TopicPlan & { toc?: TocEntry[] } = defaultTopicPlan(locale),
): Promise<{ topics: DraftTopic[]; source: TopicSource }> {
  const fromToc = plan.toc?.length ? tocStarts(plan.toc, chunks) : null;
  if (fromToc) return { topics: finishTopics(fromToc, chunks, plan), source: "TOC" };
  const headings = () => ({ topics: finishTopics(startsOf(fallbackTopics(chunks)), chunks, plan), source: "HEADINGS" as const });
  if (chunks.length <= 2) return headings();
  try {
    await assertCoachAiAllowed(studentId);
    const { lite } = await coachModels();
    const { data } = await generate({
      model: lite,
      messages: segmentMessages(chunks, locale, { min: plan.minPages, max: plan.maxPages }),
      schema: segmentSchema,
      jsonSchema: segmentJsonSchema,
      maxTokens: 4096,
      timeoutMs: SEGMENT_TIMEOUT_MS,
      retry: { attempts: 1 },
    });
    const topics = normalizeTopics(data.topics, chunks);
    return topics ? { topics: finishTopics(startsOf(topics), chunks, plan), source: "AI" } : headings();
  } catch (error) {
    console.warn("[coach] segmentation fell back to headings", error instanceof AppError ? error.code : error instanceof Error ? error.message : error);
    return headings();
  }
}

export const TITLE_TIMEOUT_MS = 15_000;

/**
 * Topics with no heading of their own get a short model-written title (one lite call for all of
 * them, ≤ AI_TITLE_MAX_WORDS words, checked like any title); without an answer, "Mövzu N".
 */
export async function titleUntitled(
  studentId: number,
  topics: DraftTopic[],
  chunks: DraftChunk[],
  plan: Pick<TopicPlan, "locale" | "hints" | "names">,
  generate: typeof generateStructured = generateStructured,
): Promise<DraftTopic[]> {
  const missing = topics.filter((t) => !t.title);
  if (!missing.length) return topics;
  const named = new Map<number, string>();
  try {
    await assertCoachAiAllowed(studentId);
    const { lite } = await coachModels();
    const excerpts = missing.map((t) => ({ n: t.ord + 1, text: chunks.slice(t.from, t.to + 1).map((c) => c.text).join("\n").slice(0, 1200) }));
    const { data } = await generate({
      model: lite,
      messages: titleMessages(excerpts, plan.locale),
      schema: titlesSchema,
      jsonSchema: titlesJsonSchema,
      maxTokens: 1024,
      timeoutMs: TITLE_TIMEOUT_MS,
      retry: { attempts: 1 },
    });
    for (const x of data.titles) {
      const title = usableTitle(x.title, plan.hints, plan.names, AI_TITLE_MAX_WORDS);
      if (title && title.length <= 60) named.set(Math.trunc(x.n), title);
    }
  } catch (error) {
    console.warn("[coach] topic titles fell back to numbers", error instanceof AppError ? error.code : error instanceof Error ? error.message : error);
  }
  return topics.map((t) => (t.title ? t : { ...t, title: named.get(t.ord + 1) ?? `${topicWord(plan.locale)} ${t.ord + 1}` }));
}

/**
 * Chunks and topics of a material's pages: front matter (title page, table of contents, a short
 * preface) belongs to no topic, a preface with real content becomes "Giriş", the rest is split
 * into topics. Topic and chunk ranges are positions in the returned `chunks`.
 */
export async function structureMaterial(studentId: number, pages: PageText[], locale: CoachLocale, generate: typeof generateStructured = generateStructured) {
  const front = frontMatterOf(pages);
  const { chunks, intro, bodyFrom } = chunkMaterial(pages, front);
  const body = chunks.slice(bodyFrom).map((c, i) => ({ ...c, ord: i }));
  const limits = await coachLimits();
  const plan = { locale, hints: casingHints(pages.map((p) => p.text)), names: front.names, minPages: limits.topicMinPages, maxPages: limits.topicMaxPages, toc: front.toc };
  const { topics: bodyTopics, source } = await segmentTopics(studentId, body, locale, generate, plan);
  const introTopic: DraftTopic[] = intro ? [{ ord: 0, title: introTitle(locale), from: intro.from, to: intro.to, pageFrom: chunks[intro.from].pageFrom, pageTo: chunks[intro.to].pageTo }] : [];
  const placed = [...introTopic, ...bodyTopics.map((t) => ({ ...t, from: t.from + bodyFrom, to: t.to + bodyFrom }))].map((t, i) => ({ ...t, ord: i }));
  const topics = await titleUntitled(studentId, placed, chunks, plan, generate);
  return { chunks, topics, source, frontPages: front.kinds.length };
}

export async function runMaterial(materialId: string, runId: string, locale: CoachLocale, reader: PageReader = readPagesWithOcr) {
  const db = requireDb();
  const startedAt = Date.now();
  const [material] = await db.select().from(coachMaterials).where(eq(coachMaterials.id, materialId)).limit(1);
  if (!material || material.runId !== runId) return;
  if (!(await progress(materialId, runId, { status: "EXTRACTING" }))) return;
  runProgress.set(materialId, { step: "READING", done: 0, total: 0, runId });

  const file = material.fileId ? await fileRow(material.fileId) : null;
  if (!file) {
    await finish(materialId, runId, { status: "FAILED", errorCode: "FILE_MISSING" });
    return;
  }
  let read;
  try {
    read = await reader({ material, bytes: await fileBytes(file), locale, onProgress: progressReporter(materialId, runId) });
  } catch (error) {
    const code = materialErrorOf(error);
    if (!(error instanceof IngestError)) console.warn("[coach] extraction failed", materialId, error instanceof AppError ? error.code : error instanceof Error ? error.message : error);
    await finish(materialId, runId, { status: "FAILED", errorCode: code });
    return;
  }
  const pages = capPages(read.pages.filter((p) => p.text.trim()));
  const charCount = pages.reduce((n, p) => n + p.text.length, 0);
  if (pages.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0) < 50) {
    await finish(materialId, runId, { status: "FAILED", errorCode: read.ocrFailed + (read.ocrPending ?? 0) > 0 ? "OCR_PARTIAL" : "NO_TEXT", pageCount: read.pageCount, ocrPages: read.ocrPages });
    return;
  }
  const extractedAt = Date.now();
  runProgress.set(materialId, { step: "TOPICS", done: read.pageCount, total: read.pageCount, runId });
  if (!(await progress(materialId, runId, { status: "SEGMENTING", pageCount: read.pageCount, charCount, ocrPages: read.ocrPages }))) return;
  const { chunks, topics, source, frontPages } = await structureMaterial(material.studentId, pages, locale);

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
      .set({ status: "READY", errorCode: readyWarning(read), ocrScore: read.ocrScore, needsReview: read.needsReview, textRevision: material.textRevision + 1 })
      .where(eq(coachMaterials.id, materialId));
    return true;
  });
  if (!stillOurs) return;
  await savePageReport(materialId, material.studentId, read.report);
  const timing = { extractMs: extractedAt - startedAt, topicsMs: Date.now() - extractedAt, topicSource: source };
  const stats = { pages: read.pageCount, chunks: chunks.length, topics: topics.length, frontPages, ocrPages: read.ocrPages, ocrFailed: read.ocrFailed, ocrPending: read.ocrPending ?? 0, lowPages: read.report.low.length, ...timing };
  console.info("[coach] material ready", materialId, stats);
  await logEvent(material.studentId, "MATERIAL_READY", materialId, stats);
  const ready: ReadyMaterial = { studentId: material.studentId, materialId, locale, firstTopicId: topicIds[0] ?? null };
  for (const hook of readyHooks) void hook(ready).catch((error) => console.warn("[coach] ready hook failed", materialId, error instanceof Error ? error.message : error));
}
