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
  SYLLABUS_IMPORT_DETAIL_MAX,
  SYLLABUS_IMPORT_TEXT_EXTENSIONS,
  parseImportDetail,
  syllabusImportStructureSchema,
  type SyllabusImportDetail,
  type SyllabusImportError,
  type SyllabusImportStructure,
} from "../../shared/syllabusImport";
import { isGeminiUrl } from "../_core/aiConfig";
import { ENV } from "../_core/env";
import { invokeLLM, LlmHttpError, type MessageContent } from "../_core/llm";
import { withAiUsage } from "../aiUsage/context";
import { assertAiAllowed } from "../aiUsage/limits";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { providerAlertFor, sendAiAlert } from "../modules/aiAlerts";
import { AppError } from "../modules/errors";
import { redactR2Secrets } from "../fileStorage/r2";
import { extensionOf, fileBytes, fileRow, MAX_FILE_BYTES } from "../modules/files";
import { extractDocument, renderDoc } from "../modules/textExtract";
import { planChunks } from "../questionBank/extraction";
import { filePart, pdfInputMode, type InputMode } from "../questionBank/importJobs";
import { pdfPageCount, pdfPageTexts, pdfSlice } from "../questionBank/pdf";
import { createFromStructure } from "./importCreate";
import { buildImportMessages, mergeParts, normalizeStructure, splitTextChunks, structureFromJson, type RawPart } from "./importExtraction";
import { createRunner, extractFromText, ImportFailure, stepErrorInfo, type Ask, type AskKind, type ExtractResult, type Runner } from "./importPipeline";
import { findModuleSections } from "./importText";

/**
 * Syllabus import jobs. The teacher's source (pasted text, a .docx read to text here, or a PDF/image
 * read by the model) is turned into the import structure in the background in small model requests
 * (server/syllabus/importPipeline.ts); the teacher reviews it and creates the draft. Same run
 * discipline as the question import: only the run whose id is on the row may write; a running job
 * touches its row every half minute, so one that outlives a restart is shown as interrupted soon.
 */

export const SYLLABUS_IMPORT_USAGE_KIND = "SYLLABUS_IMPORT";
const DAY_MS = 24 * 60 * 60 * 1000;
export const SYLLABUS_IMPORT_STALE_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 30_000;
/** No new model request starts after this; modules not read by then are read from the text. */
const RUN_BUDGET_MS = 12 * 60 * 1000;
const DETAIL_MAX = SYLLABUS_IMPORT_DETAIL_MAX;
const MIME_BY_EXT: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/**
 * Output tokens (Gemini counts its thinking in them, and a thinking model that runs out returns an
 * empty reply) and time per request kind. A request asked again after a cut-off or unreadable reply
 * gets twice the tokens, up to the cap.
 */
const REQUEST: Record<AskKind, { geminiTokens: number; tokens: number; timeoutMs: number }> = {
  header: { geminiTokens: 16_384, tokens: 4_000, timeoutMs: 90_000 },
  module: { geminiTokens: 32_768, tokens: 8_000, timeoutMs: 180_000 },
  document: { geminiTokens: 32_768, tokens: 16_000, timeoutMs: 240_000 },
};
const GEMINI_MAX_TOKENS = 65_536;
const OTHER_MAX_TOKENS = 16_000;

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

/** Model requests a text needs: the header and one per module, or one per part when it has no module headings. */
const textSteps = (text: string) => {
  const plan = findModuleSections(text);
  return plan ? plan.sections.length + 1 : splitTextChunks(text).length;
};

/** How a source is stored on the job, with the expected number of model requests (progress). */
async function prepareSource(scope: TeacherScope, input: { text?: string; fileId?: string }) {
  if (input.text !== undefined) {
    const text = checkText(input.text);
    return { fileId: null, fileName: "", mimeType: "text/plain", sizeBytes: Buffer.byteLength(text), sourceText: text, pageCount: null, chunkCount: textSteps(text) };
  }
  const file = await fileRow(input.fileId ?? "");
  if (!file || file.workspaceId !== scope.workspaceId) throw new AppError("FILE_NOT_FOUND");
  const ext = extensionOf(file.fileName);
  const base = { fileId: file.id, fileName: file.fileName.slice(0, 255), sizeBytes: file.sizeBytes };
  const bytes = async () => {
    const read = await importFileBytes({ fileId: file.id, providerWorkspaceId: scope.workspaceId });
    if ("bytes" in read) return Buffer.from(read.bytes);
    console.error(`[syllabusImport] ${read.missing}`);
    throw new AppError("FILE_NOT_FOUND");
  };
  if (ext === ".docx") {
    const doc = extractDocument(file.fileName, await bytes());
    if (!doc.ok) throw new AppError("SYLLABUS_IMPORT_UNREADABLE");
    const text = checkText(renderDoc(doc.doc));
    return { ...base, mimeType: "text/plain", sourceText: text, pageCount: null, chunkCount: textSteps(text) };
  }
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) throw new AppError("SYLLABUS_IMPORT_FILE_TYPE");
  if (mimeType !== "application/pdf") return { ...base, mimeType, sourceText: null, pageCount: 1, chunkCount: 1 };
  const pageCount = await pdfPageCount(new Uint8Array(await bytes()));
  if (pageCount > SYLLABUS_IMPORT_MAX_PAGES) throw new AppError("IMPORT_TOO_MANY_PAGES");
  return { ...base, mimeType, sourceText: null, pageCount, chunkCount: planChunks(pageCount, SYLLABUS_IMPORT_CHUNK_PAGES).length };
}

/** The daily limit counts imports (runs), whatever number of model requests each needs. */
async function checkDailyLimit(workspaceId: string) {
  if ((await usedInLastDay(workspaceId)) + 1 > ENV.syllabusImportDailyLimit) throw new AppError("IMPORT_DAILY_LIMIT");
}

export async function startImport(scope: TeacherScope, input: { text?: string; fileId?: string }) {
  if (!ENV.syllabusImportEnabled) throw new AppError("IMPORT_UNAVAILABLE");
  const source = await prepareSource(scope, input);
  await checkDailyLimit(scope.workspaceId);
  await assertAiAllowed(scope.userId);
  const id = nanoid();
  const runId = nanoid();
  await requireDb()
    .insert(syllabusImportJobs)
    .values({ id, providerWorkspaceId: scope.workspaceId, createdBy: scope.userId, ...source, status: "QUEUED", runId });
  scheduleRun(scope, id, runId);
  return jobView(await ownedJob(scope, id));
}

/** A new run of the same source with the current reading rules. */
export async function retryImport(scope: TeacherScope, id: string) {
  if (!ENV.syllabusImportEnabled) throw new AppError("IMPORT_UNAVAILABLE");
  const job = await ownedJob(scope, id);
  if (isBusy(job) || job.status === "COMPLETED") throw new AppError("IMPORT_BUSY");
  await checkDailyLimit(scope.workspaceId);
  await assertAiAllowed(scope.userId);
  const runId = nanoid();
  await requireDb()
    .update(syllabusImportJobs)
    .set({ status: "QUEUED", runId, errorCode: null, detail: null, chunksDone: 0, finishedAt: null, result: null })
    .where(eq(syllabusImportJobs.id, id));
  scheduleRun(scope, id, runId);
  return jobView(await ownedJob(scope, id));
}

function scheduleRun(scope: TeacherScope, jobId: string, runId: string) {
  withAiUsage({ feature: "SYLLABUS_IMPORT", userId: scope.userId, workspaceId: scope.workspaceId }, () => setImmediate(() => {
    runImport(jobId, runId).catch(async (error) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`[syllabusImport] job ${jobId} failed: INTERNAL — ${message}`, error);
      await setIfOurs(jobId, runId, { status: "FAILED", errorCode: "INTERNAL", detail: { message: message.slice(0, DETAIL_MAX) }, finishedAt: new Date() }).catch(() => false);
    });
  }));
}

async function setIfOurs(jobId: string, runId: string, patch: Partial<SyllabusImportJob>): Promise<boolean> {
  const [result] = await requireDb()
    .update(syllabusImportJobs)
    .set(patch)
    .where(and(eq(syllabusImportJobs.id, jobId), eq(syllabusImportJobs.runId, runId)));
  return result.affectedRows === 1;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const replyText = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p === "object" && "text" in p && typeof p.text === "string" ? p.text : "")).join("")
      : "";

/** The model request behind the pipeline's `Ask`. Retries are left to the pipeline, which paces all requests of a run together. */
export function makeAsk(): Ask {
  const gemini = isGeminiUrl(ENV.llm.baseUrl);
  return async ({ kind, messages, attempt = 1 }) => {
    const r = REQUEST[kind];
    const base = gemini ? r.geminiTokens : r.tokens;
    const result = await invokeLLM({
      messages,
      responseFormat: { type: "json_object" },
      maxTokens: Math.min(base * (attempt > 1 ? 2 : 1), Math.max(base, gemini ? GEMINI_MAX_TOKENS : OTHER_MAX_TOKENS)),
      model: ENV.syllabusImportModel || undefined,
      timeoutMs: r.timeoutMs,
      maxRetries: 0,
    });
    const choice = result.choices[0];
    return { content: replyText(choice?.message?.content), finishReason: choice?.finish_reason ?? null };
  };
}

interface FileCtx {
  job: SyllabusImportJob;
  bytes: Uint8Array;
  mode: InputMode;
  pageTexts: () => Promise<string[]>;
}

/**
 * A PDF read natively page range by page range (an image as a whole). A range whose reply is cut off
 * or unreadable is read again in halves; a range the provider refuses natively is read from its text.
 */
async function readFile(ctx: FileCtx, runner: Runner, onStep: (done: number) => Promise<unknown>): Promise<RawPart> {
  const config = ENV.llm;
  const { job } = ctx;
  const ranges = job.mimeType === "application/pdf" ? planChunks(job.pageCount ?? 1, SYLLABUS_IMPORT_CHUNK_PAGES) : [null];
  const outs: RawPart[] = [];
  const messagesFor = async (range: { from: number; to: number } | null, index: number) => {
    const base = { part: { index, total: ranges.length }, previousModules: mergeParts(outs).modules.map((m) => m.title), nonce: randomBytes(6).toString("hex") };
    if (!range) return buildImportMessages({ ...base, parts: [filePart(job.mimeType, ctx.bytes, job.fileName, config)] as MessageContent[] });
    if (ctx.mode === "native") {
      const whole = range.from === 1 && range.to === (job.pageCount ?? range.to);
      const slice = whole ? ctx.bytes : await pdfSlice(ctx.bytes, range.from, range.to);
      return buildImportMessages({ ...base, parts: [filePart("application/pdf", slice, job.fileName, config)] });
    }
    const texts = (await ctx.pageTexts()).slice(range.from - 1, range.to);
    if (!texts.some((t) => t.trim().length > 20)) throw new ImportFailure("NO_TEXT", `pages ${range.from}-${range.to} have no text`);
    return buildImportMessages({ ...base, parts: null, documentText: texts.join("\n\n") });
  };
  const readRange = async (range: { from: number; to: number } | null, index: number, depth: number): Promise<void> => {
    const label = range ? `pages ${range.from}-${range.to}` : "file";
    const canSplit = !!range && range.to > range.from && depth < 3;
    try {
      const { value, partial } = await runner.askJson({ kind: "document", messages: await messagesFor(range, index), label }, structureFromJson, canSplit ? 1 : 2);
      if (!partial || !canSplit) return void outs.push(value);
    } catch (error) {
      if (error instanceof ImportFailure) throw error;
      const cause = (error as { cause?: unknown }).cause;
      const refused = range && ctx.mode === "native" && !ENV.questionImportPdfMode && cause instanceof LlmHttpError && (cause.status === 400 || cause.status === 415);
      if (refused) {
        ctx.mode = "text";
        return readRange(range, index, depth);
      }
      const info = stepErrorInfo(error);
      const splittable = info && (info.code === "AI_OUTPUT" || info.code === "AI_TIMEOUT") && !info.stopAsking;
      if (!canSplit || !splittable) throw new ImportFailure(info?.code ?? "AI_OUTPUT", info?.detail ?? String(error), cause);
    }
    const mid = Math.floor((range!.from + range!.to) / 2);
    await readRange({ from: range!.from, to: mid }, index, depth + 1);
    await readRange({ from: mid + 1, to: range!.to }, index, depth + 1);
  };
  for (const [i, range] of ranges.entries()) {
    await readRange(range, i, 0);
    await onStep(i + 1);
  }
  return mergeParts(outs);
}

const FAILURE_LINE_MAX = 320;

/**
 * The technical detail kept on a READY job: one line per request the model could not answer (course
 * header, modules read from the text) with the provider's reason, else the last problem met on the way.
 */
export function importDetail(read: Pick<ExtractResult, "localModules" | "failures" | "problem">): SyllabusImportDetail | null {
  const lines = read.failures.length ? read.failures : read.problem ? [read.problem.detail] : [];
  const message = lines.map((l) => (l.length > FAILURE_LINE_MAX ? `${l.slice(0, FAILURE_LINE_MAX - 1)}…` : l)).join("\n").slice(0, DETAIL_MAX);
  if (!read.localModules.length && !message) return null;
  return { ...(read.localModules.length ? { localModules: read.localModules } : {}), ...(message ? { message } : {}) };
}

/**
 * The uploaded file's bytes, wherever they are kept: `files.dataBase64` (MySQL) or the object store
 * (R2, located through `file_objects`). A file that is gone or cannot be read gives the reason, with
 * any R2 credentials masked, instead of an exception.
 */
export async function importFileBytes(job: Pick<SyllabusImportJob, "fileId" | "providerWorkspaceId">): Promise<{ bytes: Uint8Array } | { missing: string }> {
  const file = job.fileId ? await fileRow(job.fileId) : null;
  if (!file || file.workspaceId !== job.providerWorkspaceId) return { missing: `file ${job.fileId ?? "-"} not found` };
  try {
    const bytes = await fileBytes(file);
    if (!bytes.byteLength && file.sizeBytes > 0) return { missing: `file ${file.id}: no stored content (neither in MySQL nor in the object store)` };
    return { bytes: new Uint8Array(bytes) };
  } catch (error) {
    const why = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { missing: redactR2Secrets(`file ${file.id} could not be read: ${why}`) };
  }
}

/** Runs one import. Every way out sets the job to READY or FAILED (with a reason that is logged). */
export async function runImport(jobId: string, runId: string) {
  const db = requireDb();
  const [job] = await db.select().from(syllabusImportJobs).where(eq(syllabusImportJobs.id, jobId)).limit(1);
  if (!job || job.runId !== runId) return;
  const fail = async (errorCode: SyllabusImportError, message = "") => {
    console.error(`[syllabusImport] job ${jobId} failed: ${errorCode}${message ? ` — ${message}` : ""}`);
    await setIfOurs(jobId, runId, { status: "FAILED", errorCode, detail: message ? { message: message.slice(0, DETAIL_MAX) } : null, finishedAt: new Date() });
  };
  if (!ENV.syllabusImportEnabled) return void (await fail("AI_UNAVAILABLE", "syllabus import is not configured"));

  let bytes: Uint8Array | null = null;
  if (job.sourceText === null) {
    const read = await importFileBytes(job);
    if ("missing" in read) return void (await fail("FILE_MISSING", read.missing));
    bytes = read.bytes;
  }
  if ((await usedInLastDay(job.providerWorkspaceId)) >= ENV.syllabusImportDailyLimit) return void (await fail("DAILY_LIMIT"));
  await db.insert(aiUsageEvents).values({ workspaceId: job.providerWorkspaceId, kind: SYLLABUS_IMPORT_USAGE_KIND, refId: jobId });
  const model = (ENV.syllabusImportModel || ENV.llm.model || "").slice(0, 120) || null;
  if (!(await setIfOurs(jobId, runId, { status: "PROCESSING", chunksDone: 0, model, updatedAt: new Date() }))) return;

  let ours = true;
  const heartbeat = setInterval(() => {
    setIfOurs(jobId, runId, { updatedAt: new Date() })
      .then((still) => void (ours = still))
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const onPlan = (total: number) => setIfOurs(jobId, runId, { chunkCount: total });
  const onStep = (done: number) => setIfOurs(jobId, runId, { chunksDone: done });
  const started = Date.now();
  const runnerOpts = {
    ask: makeAsk(),
    deadline: started + RUN_BUDGET_MS,
    shouldStop: () => !ours,
    log: (line: string) => console.warn(`[syllabusImport] job ${jobId}: ${line}`),
  };

  try {
    let read: ExtractResult;
    const isPdf = job.mimeType === "application/pdf";
    const mode: InputMode = isPdf ? pdfInputMode(ENV.llm, ENV.questionImportPdfMode) : "native";
    if (job.sourceText !== null) {
      read = await extractFromText(job.sourceText, { ...runnerOpts, onPlan, onStep });
    } else if (isPdf && mode === "text") {
      const text = (await pdfPageTexts(bytes!)).join("\n\n");
      if (text.trim().length < SYLLABUS_IMPORT_MIN_TEXT) return void (await fail("NO_TEXT", "the PDF has no text layer"));
      read = await extractFromText(text, { ...runnerOpts, onPlan, onStep });
    } else {
      let texts: Promise<string[]> | null = null;
      const runner = createRunner(runnerOpts);
      const raw = await readFile({ job, bytes: bytes!, mode, pageTexts: () => (texts ??= pdfPageTexts(bytes!)) }, runner, onStep);
      read = { raw, localModules: [], failures: [], problem: runner.state.lastProblem };
    }
    const structure = normalizeStructure(read.raw, job.fileName.replace(/\.[^.]+$/, ""));
    if (!structure) {
      const why = read.raw.modules.length ? `${read.raw.modules.length} module(s) read but none had a title` : "no module headings were found in the reply";
      return void (await fail("NO_MODULES", [why, read.problem?.detail].filter(Boolean).join("; ")));
    }
    const detail = importDetail(read);
    if (read.localModules.length) console.warn(`[syllabusImport] job ${jobId}: ${read.localModules.length} module(s) read without the model:\n${detail?.message ?? ""}`);
    await setIfOurs(jobId, runId, { status: "READY", errorCode: null, detail, result: structure as unknown as Record<string, unknown>, finishedAt: new Date() });
  } catch (error) {
    if (error instanceof ImportFailure) {
      if (error.code === "AI_KEY_INVALID" || error.code === "AI_NOT_FOUND" || error.code === "AI_QUOTA") {
        const alert = providerAlertFor((error as { cause?: unknown }).cause ?? error);
        if (alert) await sendAiAlert(job.providerWorkspaceId, alert).catch(() => undefined);
      }
      return void (await fail(error.code, error.detail));
    }
    if (error instanceof AppError && error.code === "IMPORT_PDF_UNREADABLE") return void (await fail("PDF_UNREADABLE", "the PDF could not be opened"));
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------
// Reads, create, delete
// ---------------------------------------------------------------------------

export function jobView(job: SyllabusImportJob, now = Date.now()) {
  const stale = (job.status === "QUEUED" || job.status === "PROCESSING") && now - job.updatedAt.getTime() > SYLLABUS_IMPORT_STALE_MS;
  const result = job.result ? syllabusImportStructureSchema.safeParse(job.result) : null;
  const unreadable = job.status === "READY" && !result?.success;
  return {
    id: job.id,
    source: job.fileId ? ("FILE" as const) : ("TEXT" as const),
    fileName: job.fileName,
    status: stale || unreadable ? ("FAILED" as const) : job.status,
    errorCode: stale ? "INTERRUPTED" : unreadable ? "INTERNAL" : job.errorCode,
    detail: parseImportDetail(job.detail),
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
