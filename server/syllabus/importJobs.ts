import { randomBytes } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { aiUsageEvents, syllabusImportJobs, type SyllabusImportJob } from "../../drizzle/schema";
import {
  SYLLABUS_IMPORT_CHUNK_PAGES,
  SYLLABUS_IMPORT_FILE_EXTENSIONS,
  SYLLABUS_IMPORT_MAX_PAGES,
  SYLLABUS_IMPORT_MAX_TEXT,
  SYLLABUS_IMPORT_MIN_TEXT,
  SYLLABUS_IMPORT_TEXT_EXTENSIONS,
  syllabusImportStructureSchema,
  type SyllabusImportError,
  type SyllabusImportStructure,
} from "../../shared/syllabusImport";
import { isGeminiUrl } from "../_core/aiConfig";
import { ENV } from "../_core/env";
import { invokeLLM, LlmHttpError, llmFailureReason, type MessageContent } from "../_core/llm";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { providerAlertFor, sendAiAlert } from "../modules/aiAlerts";
import { AppError } from "../modules/errors";
import { extensionOf, fileRow, MAX_FILE_BYTES } from "../modules/files";
import { extractDocument, renderDoc } from "../modules/textExtract";
import { planChunks } from "../questionBank/extraction";
import { filePart, pdfInputMode, type InputMode } from "../questionBank/importJobs";
import { pdfPageCount, pdfPageTexts, pdfSlice } from "../questionBank/pdf";
import { createFromStructure } from "./importCreate";
import { buildImportMessages, mergeParts, normalizeStructure, parseImportOutput, splitTextChunks, type RawPart } from "./importExtraction";

/**
 * Syllabus import jobs. The teacher's source (pasted text, a .docx read to text here, or a PDF/image
 * read by the model) is turned into the import structure in the background, part by part; the
 * teacher reviews it and creates the draft. Same run discipline as the question import: only the
 * run whose id is on the row may write, and a run that outlives a restart goes stale.
 */

export const SYLLABUS_IMPORT_USAGE_KIND = "SYLLABUS_IMPORT";
const DAY_MS = 24 * 60 * 60 * 1000;
export const SYLLABUS_IMPORT_STALE_MS = 20 * 60 * 1000;
const PART_TIMEOUT_MS = 180_000;
const MIME_BY_EXT: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

async function usedInLastDay(workspaceId: string) {
  const [row] = await requireDb()
    .select({ n: sql<number>`count(*)` })
    .from(aiUsageEvents)
    .where(and(eq(aiUsageEvents.workspaceId, workspaceId), eq(aiUsageEvents.kind, SYLLABUS_IMPORT_USAGE_KIND), gte(aiUsageEvents.createdAt, new Date(Date.now() - DAY_MS))));
  return Number(row?.n ?? 0);
}

export async function importAvailability(scope: TeacherScope) {
  const limit = ENV.syllabusImportDailyLimit;
  const used = ENV.syllabusImportEnabled ? await usedInLastDay(scope.workspaceId) : 0;
  return {
    enabled: ENV.syllabusImportEnabled,
    maxBytes: MAX_FILE_BYTES,
    maxPages: SYLLABUS_IMPORT_MAX_PAGES,
    maxTextChars: SYLLABUS_IMPORT_MAX_TEXT,
    fileExtensions: [...SYLLABUS_IMPORT_FILE_EXTENSIONS],
    textExtensions: [...SYLLABUS_IMPORT_TEXT_EXTENSIONS],
    dailyLimit: limit,
    remainingToday: Math.max(0, limit - used),
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function ownedJob(scope: TeacherScope, id: string): Promise<SyllabusImportJob> {
  const [job] = await requireDb()
    .select()
    .from(syllabusImportJobs)
    .where(and(eq(syllabusImportJobs.id, id), eq(syllabusImportJobs.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!job) throw new AppError("NOT_FOUND");
  return job;
}

const isBusy = (job: Pick<SyllabusImportJob, "status" | "updatedAt">, now = Date.now()) =>
  (job.status === "QUEUED" || job.status === "PROCESSING") && now - job.updatedAt.getTime() <= SYLLABUS_IMPORT_STALE_MS;

function checkText(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < SYLLABUS_IMPORT_MIN_TEXT || trimmed.length > SYLLABUS_IMPORT_MAX_TEXT) throw new AppError("SYLLABUS_IMPORT_TEXT_LENGTH");
  return trimmed;
}

/** What a source costs in model requests and how it is stored on the job. */
async function prepareSource(scope: TeacherScope, input: { text?: string; fileId?: string }) {
  if (input.text !== undefined) {
    const text = checkText(input.text);
    return { fileId: null, fileName: "", mimeType: "text/plain", sizeBytes: Buffer.byteLength(text), sourceText: text, pageCount: null, chunkCount: splitTextChunks(text).length };
  }
  const file = await fileRow(input.fileId ?? "");
  if (!file || file.workspaceId !== scope.workspaceId) throw new AppError("FILE_NOT_FOUND");
  const ext = extensionOf(file.fileName);
  const base = { fileId: file.id, fileName: file.fileName.slice(0, 255), sizeBytes: file.sizeBytes };
  if (ext === ".docx") {
    const doc = extractDocument(file.fileName, Buffer.from(file.dataBase64, "base64"));
    if (!doc.ok) throw new AppError("SYLLABUS_IMPORT_UNREADABLE");
    const text = checkText(renderDoc(doc.doc));
    return { ...base, mimeType: "text/plain", sourceText: text, pageCount: null, chunkCount: splitTextChunks(text).length };
  }
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) throw new AppError("SYLLABUS_IMPORT_FILE_TYPE");
  if (mimeType !== "application/pdf") return { ...base, mimeType, sourceText: null, pageCount: 1, chunkCount: 1 };
  const pageCount = await pdfPageCount(new Uint8Array(Buffer.from(file.dataBase64, "base64")));
  if (pageCount > SYLLABUS_IMPORT_MAX_PAGES) throw new AppError("IMPORT_TOO_MANY_PAGES");
  return { ...base, mimeType, sourceText: null, pageCount, chunkCount: planChunks(pageCount, SYLLABUS_IMPORT_CHUNK_PAGES).length };
}

export async function startImport(scope: TeacherScope, input: { text?: string; fileId?: string }) {
  if (!ENV.syllabusImportEnabled) throw new AppError("IMPORT_UNAVAILABLE");
  const source = await prepareSource(scope, input);
  if ((await usedInLastDay(scope.workspaceId)) + source.chunkCount > ENV.syllabusImportDailyLimit) throw new AppError("IMPORT_DAILY_LIMIT");
  const id = nanoid();
  const runId = nanoid();
  await requireDb()
    .insert(syllabusImportJobs)
    .values({ id, providerWorkspaceId: scope.workspaceId, createdBy: scope.userId, ...source, status: "QUEUED", runId });
  scheduleRun(id, runId);
  return jobView(await ownedJob(scope, id));
}

export async function retryImport(scope: TeacherScope, id: string) {
  if (!ENV.syllabusImportEnabled) throw new AppError("IMPORT_UNAVAILABLE");
  const job = await ownedJob(scope, id);
  if (isBusy(job) || job.status === "COMPLETED") throw new AppError("IMPORT_BUSY");
  if ((await usedInLastDay(scope.workspaceId)) + job.chunkCount > ENV.syllabusImportDailyLimit) throw new AppError("IMPORT_DAILY_LIMIT");
  const runId = nanoid();
  await requireDb()
    .update(syllabusImportJobs)
    .set({ status: "QUEUED", runId, errorCode: null, chunksDone: 0, finishedAt: null, result: null })
    .where(eq(syllabusImportJobs.id, id));
  scheduleRun(id, runId);
  return jobView(await ownedJob(scope, id));
}

function scheduleRun(jobId: string, runId: string) {
  setImmediate(() => {
    runImport(jobId, runId).catch(async (error) => {
      console.error("[syllabusImport] run failed", error);
      await setIfOurs(jobId, runId, { status: "FAILED", errorCode: "INTERNAL", finishedAt: new Date() }).catch(() => false);
    });
  });
}

async function setIfOurs(jobId: string, runId: string, patch: Partial<SyllabusImportJob>): Promise<boolean> {
  const [result] = await requireDb()
    .update(syllabusImportJobs)
    .set(patch)
    .where(and(eq(syllabusImportJobs.id, jobId), eq(syllabusImportJobs.runId, runId)));
  return result.affectedRows === 1;
}

class PartError extends Error {
  constructor(public readonly code: SyllabusImportError) {
    super(code);
  }
}

interface Part {
  /** Text of this part, or a PDF page range / the whole image read by the model. */
  text: string | null;
  range: { from: number; to: number } | null;
}

/** Reads one part; a PDF the provider refuses natively is retried once from its extracted text. */
async function readPart(
  ctx: { job: SyllabusImportJob; bytes: Uint8Array | null; mode: InputMode; pageTexts: () => Promise<string[]> },
  part: Part,
  where: { index: number; total: number },
  previousModules: string[],
): Promise<{ out: RawPart; mode: InputMode }> {
  const config = ENV.llm;
  const nonce = randomBytes(6).toString("hex");
  let mode = ctx.mode;
  const base = { part: where, previousModules, nonce };
  const messagesFor = async (m: InputMode) => {
    if (part.text !== null) return buildImportMessages({ ...base, parts: null, documentText: part.text });
    if (!part.range) return buildImportMessages({ ...base, parts: [filePart(ctx.job.mimeType, ctx.bytes!, ctx.job.fileName, config)] as MessageContent[] });
    if (m === "native") {
      const whole = part.range.from === 1 && part.range.to === (ctx.job.pageCount ?? part.range.to);
      const slice = whole ? ctx.bytes! : await pdfSlice(ctx.bytes!, part.range.from, part.range.to);
      return buildImportMessages({ ...base, parts: [filePart("application/pdf", slice, ctx.job.fileName, config)] });
    }
    const texts = (await ctx.pageTexts()).slice(part.range.from - 1, part.range.to);
    if (!texts.some((t) => t.trim().length > 20)) throw new PartError("NO_TEXT");
    return buildImportMessages({ ...base, parts: null, documentText: texts.join("\n\n") });
  };
  const call = async (m: InputMode) =>
    invokeLLM({
      messages: await messagesFor(m),
      responseFormat: { type: "json_object" },
      maxTokens: isGeminiUrl(config.baseUrl) ? 32_768 : 16_000,
      model: ENV.syllabusImportModel || undefined,
      timeoutMs: PART_TIMEOUT_MS,
    });
  let result;
  try {
    result = await call(mode);
  } catch (error) {
    const refused = part.range && mode === "native" && !ENV.questionImportPdfMode && error instanceof LlmHttpError && (error.status === 400 || error.status === 415);
    if (!refused || llmFailureReason(error) === "AI_KEY_INVALID") throw error;
    mode = "text";
    result = await call(mode);
  }
  const content = result.choices[0]?.message?.content;
  const out = parseImportOutput(typeof content === "string" ? content : "");
  if (!out) throw new PartError("AI_OUTPUT");
  return { out, mode };
}

/** A missing part would silently drop modules, so any failed part fails the whole job (the teacher retries). */
export async function runImport(jobId: string, runId: string) {
  const db = requireDb();
  const [job] = await db.select().from(syllabusImportJobs).where(eq(syllabusImportJobs.id, jobId)).limit(1);
  if (!job || job.runId !== runId) return;
  const fail = (errorCode: SyllabusImportError) => setIfOurs(jobId, runId, { status: "FAILED", errorCode, finishedAt: new Date() });
  if (!ENV.syllabusImportEnabled) return void (await fail("AI_UNAVAILABLE"));

  let bytes: Uint8Array | null = null;
  if (job.sourceText === null) {
    const file = job.fileId ? await fileRow(job.fileId) : null;
    if (!file || file.workspaceId !== job.providerWorkspaceId) return void (await fail("FILE_MISSING"));
    bytes = new Uint8Array(Buffer.from(file.dataBase64, "base64"));
  }
  const isPdf = job.mimeType === "application/pdf";
  const parts: Part[] =
    job.sourceText !== null
      ? splitTextChunks(job.sourceText).map((text) => ({ text, range: null }))
      : isPdf
        ? planChunks(job.pageCount ?? 1, SYLLABUS_IMPORT_CHUNK_PAGES).map((range) => ({ text: null, range }))
        : [{ text: null, range: null }];
  if (!(await setIfOurs(jobId, runId, { status: "PROCESSING", chunksDone: 0, chunkCount: parts.length }))) return;

  let texts: Promise<string[]> | null = null;
  const ctx = { job, bytes, mode: isPdf ? pdfInputMode(ENV.llm, ENV.questionImportPdfMode) : ("native" as InputMode), pageTexts: () => (texts ??= pdfPageTexts(bytes!)) };
  const outs: RawPart[] = [];
  for (const [i, part] of parts.entries()) {
    if ((await usedInLastDay(job.providerWorkspaceId)) >= ENV.syllabusImportDailyLimit) return void (await fail("DAILY_LIMIT"));
    await db.insert(aiUsageEvents).values({ workspaceId: job.providerWorkspaceId, kind: SYLLABUS_IMPORT_USAGE_KIND, refId: jobId });
    try {
      const read = await readPart(ctx, part, { index: i, total: parts.length }, mergeParts(outs).modules.map((m) => m.title));
      ctx.mode = read.mode;
      outs.push(read.out);
    } catch (error) {
      if (error instanceof PartError) return void (await fail(error.code));
      if (error instanceof AppError && error.code === "IMPORT_PDF_UNREADABLE") return void (await fail("PDF_UNREADABLE"));
      console.warn("[syllabusImport] part failed", jobId, i, error);
      const alert = providerAlertFor(error);
      if (alert) await sendAiAlert(job.providerWorkspaceId, alert).catch(() => undefined);
      return void (await fail(llmFailureReason(error)));
    }
    const model = (ENV.syllabusImportModel || ENV.llm.model || "").slice(0, 120) || null;
    if (!(await setIfOurs(jobId, runId, { chunksDone: i + 1, inputMode: isPdf ? ctx.mode : null, model }))) return;
  }
  const structure = normalizeStructure(mergeParts(outs), job.fileName.replace(/\.[^.]+$/, ""));
  if (!structure) return void (await fail("NO_MODULES"));
  await setIfOurs(jobId, runId, { status: "READY", errorCode: null, result: structure as unknown as Record<string, unknown>, finishedAt: new Date() });
}

// ---------------------------------------------------------------------------
// Reads, create, delete
// ---------------------------------------------------------------------------

function jobView(job: SyllabusImportJob, now = Date.now()) {
  const stale = (job.status === "QUEUED" || job.status === "PROCESSING") && now - job.updatedAt.getTime() > SYLLABUS_IMPORT_STALE_MS;
  const result = job.result ? syllabusImportStructureSchema.safeParse(job.result) : null;
  return {
    id: job.id,
    source: job.fileId ? ("FILE" as const) : ("TEXT" as const),
    fileName: job.fileName,
    status: stale ? ("FAILED" as const) : job.status,
    errorCode: stale ? "INTERRUPTED" : job.errorCode,
    pageCount: job.pageCount,
    chunkCount: job.chunkCount,
    chunksDone: job.chunksDone,
    syllabusId: job.syllabusId,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    result: result?.success ? result.data : null,
  };
}

export async function getImport(scope: TeacherScope, id: string) {
  return jobView(await ownedJob(scope, id));
}

/** Recent jobs not turned into a syllabus yet (for "continue where you left off"). */
export async function listOpenImports(scope: TeacherScope) {
  const rows = await requireDb()
    .select()
    .from(syllabusImportJobs)
    .where(and(eq(syllabusImportJobs.providerWorkspaceId, scope.workspaceId), gte(syllabusImportJobs.createdAt, new Date(Date.now() - 7 * DAY_MS))))
    .orderBy(desc(syllabusImportJobs.createdAt))
    .limit(10);
  return rows.filter((j) => j.status !== "COMPLETED").map((j) => ({ ...jobView(j), result: null, title: (j.result as { title?: string } | null)?.title ?? null }));
}

/**
 * The reviewed structure becomes a draft owned by the teacher. Creating twice from the same job
 * returns the syllabus made the first time (a double click must not make two).
 */
export async function createFromImport(scope: TeacherScope, id: string, structure: SyllabusImportStructure) {
  const job = await ownedJob(scope, id);
  if (job.status === "COMPLETED" && job.syllabusId) return { id: job.syllabusId };
  if (job.status !== "READY") throw new AppError("IMPORT_BUSY");
  const claimed = await requireDb()
    .update(syllabusImportJobs)
    .set({ status: "COMPLETED" })
    .where(and(eq(syllabusImportJobs.id, id), eq(syllabusImportJobs.status, "READY")));
  if (claimed[0].affectedRows !== 1) throw new AppError("IMPORT_BUSY");
  try {
    const syllabus = await createFromStructure(scope, structure);
    await requireDb().update(syllabusImportJobs).set({ syllabusId: syllabus.id }).where(eq(syllabusImportJobs.id, id));
    return { id: syllabus.id };
  } catch (error) {
    await requireDb().update(syllabusImportJobs).set({ status: "READY" }).where(eq(syllabusImportJobs.id, id));
    throw error;
  }
}

export async function deleteImport(scope: TeacherScope, id: string) {
  await ownedJob(scope, id);
  await requireDb().delete(syllabusImportJobs).where(eq(syllabusImportJobs.id, id));
  return { ok: true };
}
