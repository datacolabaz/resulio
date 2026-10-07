import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  aiUsageEvents,
  questionImportItems,
  questionImportJobs,
  questionMeta,
  questions,
  type QuestionImportItem,
  type QuestionImportJob,
} from "../../drizzle/schema";
import { questionInputSchema, type QuestionInput } from "../../shared/assessment";
import {
  BLOCKING_ISSUES,
  IMPORT_CHUNK_PAGES,
  IMPORT_EXTENSIONS,
  IMPORT_MAX_PAGES,
  IMPORT_MAX_QUESTIONS,
  type ImportIssue,
  type ImportJobError,
} from "../../shared/questionImport";
import { isGeminiUrl } from "../_core/aiConfig";
import { ENV } from "../_core/env";
import { invokeLLM, LlmHttpError, llmFailureReason, type MessageContent } from "../_core/llm";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { providerAlertFor, sendAiAlert } from "../modules/aiAlerts";
import { createQuestion } from "../modules/assessments";
import { AppError } from "../modules/errors";
import { extensionOf, fileRow, MAX_FILE_BYTES } from "../modules/files";
import { buildExtractionMessages, findDuplicates, normalizeItem, orderDrafts, parseExtraction, planChunks, type ImportDraft, type TopicRef } from "./extraction";
import { pdfPageCount, pdfPageTexts, pdfSlice } from "./pdf";
import { descendantIds, ensureTopic, ownedTopic, PATH_SEPARATOR, topicPaths, topicsOf } from "./topics";

/**
 * Question import: an uploaded PDF/image becomes reviewable drafts in the background, then the
 * teacher accepts them into the bank. Same run discipline as the submission AI review: the job row
 * holds a run id, only that run may write results, and a run that outlives a restart goes stale.
 */

export const IMPORT_USAGE_KIND = "QUESTION_IMPORT";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A job still QUEUED/PROCESSING after this long was cut off by a restart; the teacher may retry. */
export const IMPORT_STALE_MS = 20 * 60 * 1000;
const CHUNK_TIMEOUT_MS = 180_000;
const BANK_SCAN_LIMIT = 5000;

const MIME_BY_EXT: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

export type InputMode = "native" | "text";

/** How a PDF reaches the model: Gemini and OpenAI read PDFs, Manus takes file_url; others get the text. */
export function pdfInputMode(config: { source: "ai" | "manus" | null; baseUrl: string }, forced: "native" | "text" | ""): InputMode {
  if (forced) return forced;
  if (config.source === "manus" || isGeminiUrl(config.baseUrl)) return "native";
  try {
    return new URL(config.baseUrl).hostname === "api.openai.com" ? "native" : "text";
  } catch {
    return "text";
  }
}

export function filePart(mimeType: string, bytes: Uint8Array, fileName: string, config: { source: "ai" | "manus" | null; baseUrl: string }): MessageContent {
  const url = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  if (mimeType.startsWith("image/")) return { type: "image_url", image_url: { url, detail: "high" } };
  if (config.source === "manus") return { type: "file_url", file_url: { url, mime_type: "application/pdf" } };
  if (isGeminiUrl(config.baseUrl)) return { type: "image_url", image_url: { url } };
  return { type: "file", file: { filename: fileName, file_data: url } };
}

// ---------------------------------------------------------------------------
// Usage cap
// ---------------------------------------------------------------------------

async function usedInLastDay(workspaceId: string) {
  const [row] = await requireDb()
    .select({ n: sql<number>`count(*)` })
    .from(aiUsageEvents)
    .where(and(eq(aiUsageEvents.workspaceId, workspaceId), eq(aiUsageEvents.kind, IMPORT_USAGE_KIND), gte(aiUsageEvents.createdAt, new Date(Date.now() - DAY_MS))));
  return Number(row?.n ?? 0);
}

export async function importAvailability(scope: TeacherScope) {
  const limit = ENV.questionImportDailyLimit;
  const used = ENV.questionImportEnabled ? await usedInLastDay(scope.workspaceId) : 0;
  return {
    enabled: ENV.questionImportEnabled,
    maxBytes: MAX_FILE_BYTES,
    maxPages: IMPORT_MAX_PAGES,
    extensions: [...IMPORT_EXTENSIONS],
    dailyLimit: limit,
    remainingToday: Math.max(0, limit - used),
  };
}

// ---------------------------------------------------------------------------
// Start and run
// ---------------------------------------------------------------------------

async function ownedJob(scope: TeacherScope, id: string): Promise<QuestionImportJob> {
  const [job] = await requireDb()
    .select()
    .from(questionImportJobs)
    .where(and(eq(questionImportJobs.id, id), eq(questionImportJobs.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!job) throw new AppError("NOT_FOUND");
  return job;
}

async function loadFile(workspaceId: string, fileId: string) {
  const file = await fileRow(fileId);
  if (!file || file.workspaceId !== workspaceId) throw new AppError("FILE_NOT_FOUND");
  const mimeType = MIME_BY_EXT[extensionOf(file.fileName)];
  if (!mimeType) throw new AppError("IMPORT_FILE_TYPE");
  return { file, mimeType, bytes: new Uint8Array(Buffer.from(file.dataBase64, "base64")) };
}

const isBusy = (job: Pick<QuestionImportJob, "status" | "updatedAt">, now = Date.now()) =>
  (job.status === "QUEUED" || job.status === "PROCESSING") && now - job.updatedAt.getTime() <= IMPORT_STALE_MS;

export async function startImport(scope: TeacherScope, input: { fileId: string; topicId?: string | null }) {
  if (!ENV.questionImportEnabled) throw new AppError("IMPORT_UNAVAILABLE");
  const { file, mimeType, bytes } = await loadFile(scope.workspaceId, input.fileId);
  const pageCount = mimeType === "application/pdf" ? await pdfPageCount(bytes) : 1;
  if (pageCount > IMPORT_MAX_PAGES) throw new AppError("IMPORT_TOO_MANY_PAGES");
  if (input.topicId) await ownedTopic(scope, input.topicId);
  const chunkCount = mimeType === "application/pdf" ? planChunks(pageCount, IMPORT_CHUNK_PAGES).length : 1;
  const used = await usedInLastDay(scope.workspaceId);
  if (used + chunkCount > ENV.questionImportDailyLimit) throw new AppError("IMPORT_DAILY_LIMIT");

  const id = nanoid();
  const runId = nanoid();
  await requireDb()
    .insert(questionImportJobs)
    .values({
      id,
      providerWorkspaceId: scope.workspaceId,
      createdBy: scope.userId,
      fileId: file.id,
      fileName: file.fileName,
      mimeType,
      sizeBytes: file.sizeBytes,
      status: "QUEUED",
      defaultTopicId: input.topicId ?? null,
      pageCount,
      chunkCount,
      runId,
    });
  scheduleRun(id, runId);
  return jobView(await ownedJob(scope, id));
}

export async function retryImport(scope: TeacherScope, id: string) {
  if (!ENV.questionImportEnabled) throw new AppError("IMPORT_UNAVAILABLE");
  const job = await ownedJob(scope, id);
  if (isBusy(job)) throw new AppError("IMPORT_BUSY");
  if (job.status === "COMPLETED" || (job.status === "READY" && (await acceptedCount(id)) > 0)) throw new AppError("IMPORT_BUSY");
  const used = await usedInLastDay(scope.workspaceId);
  if (used + job.chunkCount > ENV.questionImportDailyLimit) throw new AppError("IMPORT_DAILY_LIMIT");
  const runId = nanoid();
  await requireDb()
    .update(questionImportJobs)
    .set({ status: "QUEUED", runId, errorCode: null, chunksDone: 0, finishedAt: null })
    .where(eq(questionImportJobs.id, id));
  scheduleRun(id, runId);
  return jobView(await ownedJob(scope, id));
}

function scheduleRun(jobId: string, runId: string) {
  setImmediate(() => {
    runImport(jobId, runId).catch(async (error) => {
      console.error("[questionImport] run failed", error);
      await finishRun(jobId, runId, { status: "FAILED", errorCode: "INTERNAL" }).catch(() => false);
    });
  });
}

async function finishRun(jobId: string, runId: string, patch: Partial<QuestionImportJob>): Promise<boolean> {
  const [result] = await requireDb()
    .update(questionImportJobs)
    .set({ ...patch, finishedAt: new Date() })
    .where(and(eq(questionImportJobs.id, jobId), eq(questionImportJobs.runId, runId)));
  return result.affectedRows === 1;
}

async function progress(jobId: string, runId: string, patch: Partial<QuestionImportJob>): Promise<boolean> {
  const [result] = await requireDb()
    .update(questionImportJobs)
    .set(patch)
    .where(and(eq(questionImportJobs.id, jobId), eq(questionImportJobs.runId, runId)));
  return result.affectedRows === 1;
}

class ChunkError extends Error {
  constructor(public readonly code: ImportJobError) {
    super(code);
  }
}

interface Chunk {
  range: { from: number; to: number } | null;
  /** Page offset added to the model's chunk-relative page numbers. */
  pageOffset: number;
}

/** Reads one chunk with the model; falls back from the native PDF to its text once if the provider refuses the file. */
async function readChunk(
  ctx: { job: QuestionImportJob; bytes: Uint8Array; topics: TopicRef[]; mode: InputMode; pageTexts: () => Promise<string[]> },
  chunk: Chunk,
): Promise<{ drafts: Omit<ImportDraft, "sourceIndex">[]; mode: InputMode }> {
  const config = ENV.llm;
  const nonce = randomBytes(6).toString("hex");
  const isPdf = ctx.job.mimeType === "application/pdf";
  let mode = ctx.mode;
  const messagesFor = async (m: InputMode) => {
    if (!isPdf) return buildExtractionMessages({ parts: [filePart(ctx.job.mimeType, ctx.bytes, ctx.job.fileName, config)], pageRange: null, topics: ctx.topics, nonce });
    const range = chunk.range!;
    if (m === "native") {
      const slice = range.from === 1 && range.to === (ctx.job.pageCount ?? range.to) ? ctx.bytes : await pdfSlice(ctx.bytes, range.from, range.to);
      return buildExtractionMessages({ parts: [filePart("application/pdf", slice, ctx.job.fileName, config)], pageRange: range, topics: ctx.topics, nonce });
    }
    const texts = (await ctx.pageTexts()).slice(range.from - 1, range.to);
    const documentText = texts.map((t, i) => `--- page ${i + 1} ---\n${t}`).join("\n\n");
    if (!texts.some((t) => t.trim().length > 20)) throw new ChunkError("NO_TEXT");
    return buildExtractionMessages({ parts: null, documentText, pageRange: range, topics: ctx.topics, nonce });
  };
  const call = async (m: InputMode) =>
    invokeLLM({
      messages: await messagesFor(m),
      responseFormat: { type: "json_object" },
      maxTokens: isGeminiUrl(config.baseUrl) ? 32_768 : 16_000,
      model: ENV.questionImportModel || undefined,
      timeoutMs: CHUNK_TIMEOUT_MS,
    });
  let result;
  try {
    result = await call(mode);
  } catch (error) {
    const providerRefusedFile = isPdf && mode === "native" && !ENV.questionImportPdfMode && error instanceof LlmHttpError && (error.status === 400 || error.status === 415);
    if (!providerRefusedFile || llmFailureReason(error) === "AI_KEY_INVALID") throw error;
    mode = "text";
    result = await call(mode);
  }
  const content = result.choices[0]?.message?.content;
  const parsed = parseExtraction(typeof content === "string" ? content : "");
  if (!parsed) throw new ChunkError("AI_OUTPUT");
  const drafts = parsed.items.map((raw) => normalizeItem(raw, { topics: ctx.topics, pageOffset: chunk.pageOffset, sourceIndex: 0 }));
  return { drafts, mode };
}

export async function runImport(jobId: string, runId: string) {
  const db = requireDb();
  const [job] = await db.select().from(questionImportJobs).where(eq(questionImportJobs.id, jobId)).limit(1);
  if (!job || job.runId !== runId) return;
  const scope: TeacherScope = { workspaceId: job.providerWorkspaceId, userId: job.createdBy };
  if (!ENV.questionImportEnabled) {
    await finishRun(jobId, runId, { status: "FAILED", errorCode: "AI_UNAVAILABLE" });
    return;
  }
  let loaded;
  try {
    loaded = await loadFile(job.providerWorkspaceId, job.fileId);
  } catch {
    await finishRun(jobId, runId, { status: "FAILED", errorCode: "FILE_MISSING" });
    return;
  }
  if (!(await progress(jobId, runId, { status: "PROCESSING", chunksDone: 0 }))) return;

  const allTopics = await topicsOf(job.providerWorkspaceId);
  const paths = topicPaths(allTopics);
  const scoped = job.defaultTopicId ? descendantIds(allTopics, job.defaultTopicId) : allTopics.map((t) => t.id);
  const topics: TopicRef[] = scoped.map((id) => ({ id, path: paths.get(id) ?? "" })).filter((t) => t.path);

  const isPdf = job.mimeType === "application/pdf";
  const chunks: Chunk[] = isPdf
    ? planChunks(job.pageCount ?? 1, IMPORT_CHUNK_PAGES).map((range) => ({ range, pageOffset: range.from - 1 }))
    : [{ range: null, pageOffset: 0 }];
  let texts: Promise<string[]> | null = null;
  const ctx = {
    job,
    bytes: loaded.bytes,
    topics,
    mode: isPdf ? pdfInputMode(ENV.llm, ENV.questionImportPdfMode) : ("native" as InputMode),
    pageTexts: () => (texts ??= pdfPageTexts(loaded.bytes)),
  };

  const drafts: ImportDraft[] = [];
  const failures: ImportJobError[] = [];
  for (const [i, chunk] of chunks.entries()) {
    if (drafts.length >= IMPORT_MAX_QUESTIONS) break;
    if ((await usedInLastDay(job.providerWorkspaceId)) >= ENV.questionImportDailyLimit) {
      failures.push("DAILY_LIMIT");
      break;
    }
    await db.insert(aiUsageEvents).values({ workspaceId: job.providerWorkspaceId, kind: IMPORT_USAGE_KIND, refId: jobId });
    try {
      const out = await readChunk(ctx, chunk);
      ctx.mode = out.mode;
      for (const d of out.drafts) drafts.push({ ...d, sourceIndex: drafts.length });
    } catch (error) {
      if (error instanceof ChunkError) failures.push(error.code);
      else if (error instanceof AppError && error.code === "IMPORT_PDF_UNREADABLE") failures.push("PDF_UNREADABLE");
      else {
        console.warn("[questionImport] chunk failed", jobId, i, error);
        const alert = providerAlertFor(error);
        if (alert) await sendAiAlert(job.providerWorkspaceId, alert).catch(() => undefined);
        failures.push(llmFailureReason(error));
      }
      // A bad key or exhausted quota fails every following chunk the same way.
      if (["AI_KEY_INVALID", "AI_NOT_FOUND", "AI_QUOTA"].includes(failures.at(-1)!)) break;
    }
    if (!(await progress(jobId, runId, { chunksDone: i + 1, inputMode: ctx.mode, model: (ENV.questionImportModel || ENV.llm.model || "").slice(0, 120) || null }))) return;
  }

  const kept = drafts.slice(0, IMPORT_MAX_QUESTIONS);
  if (!kept.length) {
    await finishRun(jobId, runId, { status: "FAILED", errorCode: failures[0] ?? "NO_QUESTIONS" });
    return;
  }
  const rows = await buildItems(scope, job, kept, paths);
  const stillOurs = await db.transaction(async (tx) => {
    const [current] = await tx.select({ runId: questionImportJobs.runId }).from(questionImportJobs).where(eq(questionImportJobs.id, jobId)).for("update");
    if (current?.runId !== runId) return false;
    await tx.delete(questionImportItems).where(eq(questionImportItems.jobId, jobId));
    for (let i = 0; i < rows.length; i += 100) await tx.insert(questionImportItems).values(rows.slice(i, i + 100));
    return true;
  });
  if (stillOurs) await finishRun(jobId, runId, { status: "READY", errorCode: failures[0] ?? null });
}

/** Duplicate flags, default topic and the system order, ready to insert. */
async function buildItems(scope: TeacherScope, job: QuestionImportJob, drafts: ImportDraft[], paths: Map<string, string>) {
  const bank = await requireDb()
    .select({ id: questions.id, text: questions.text, content: questions.content })
    .from(questions)
    .where(eq(questions.providerWorkspaceId, scope.workspaceId))
    .orderBy(desc(questions.updatedAt))
    .limit(BANK_SCAN_LIMIT);
  const dups = findDuplicates(
    drafts.map((d) => ({ text: String(d.question.text ?? ""), content: d.question.content })),
    bank,
  );
  const defaultPath = job.defaultTopicId ? paths.get(job.defaultTopicId) ?? "" : "";
  const labelled = drafts.map((d, i) => {
    const issues: ImportIssue[] = [...d.issues];
    if (dups[i].duplicateOfQuestionId) issues.push("DUPLICATE_IN_BANK");
    if (dups[i].duplicateInFile) issues.push("DUPLICATE_IN_FILE");
    const topicId = d.topicId ?? (d.proposedTopic ? null : job.defaultTopicId);
    const topicLabel = topicId ? paths.get(topicId) ?? "" : [defaultPath, d.proposedTopic ?? ""].filter(Boolean).join(PATH_SEPARATOR);
    return { ...d, issues, topicId, topicLabel, duplicateOfQuestionId: dups[i].duplicateOfQuestionId };
  });
  return orderDrafts(labelled).map((d, i) => ({
    id: nanoid(),
    jobId: job.id,
    providerWorkspaceId: scope.workspaceId,
    position: i + 1,
    status: "PENDING" as const,
    question: d.question,
    issues: d.issues,
    topicId: d.topicId,
    proposedTopic: d.topicId ? null : d.proposedTopic,
    answerSource: d.answerSource,
    confidence: d.confidence,
    sourcePage: d.sourcePage,
    sourceNumber: d.sourceNumber,
    duplicateOfQuestionId: d.duplicateOfQuestionId,
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function jobView(job: QuestionImportJob, now = Date.now()) {
  const stale = (job.status === "QUEUED" || job.status === "PROCESSING") && now - job.updatedAt.getTime() > IMPORT_STALE_MS;
  return {
    id: job.id,
    fileId: job.fileId,
    fileName: job.fileName,
    mimeType: job.mimeType,
    sizeBytes: job.sizeBytes,
    status: stale ? ("FAILED" as const) : job.status,
    errorCode: stale ? "INTERRUPTED" : job.errorCode,
    defaultTopicId: job.defaultTopicId,
    pageCount: job.pageCount,
    chunkCount: job.chunkCount,
    chunksDone: job.chunksDone,
    inputMode: job.inputMode,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

async function acceptedCount(jobId: string) {
  const [row] = await requireDb()
    .select({ n: sql<number>`count(*)` })
    .from(questionImportItems)
    .where(and(eq(questionImportItems.jobId, jobId), eq(questionImportItems.status, "ACCEPTED")));
  return Number(row?.n ?? 0);
}

export async function listImports(scope: TeacherScope) {
  const db = requireDb();
  const jobs = await db
    .select()
    .from(questionImportJobs)
    .where(eq(questionImportJobs.providerWorkspaceId, scope.workspaceId))
    .orderBy(desc(questionImportJobs.createdAt))
    .limit(50);
  if (!jobs.length) return [];
  const counts = await db
    .select({ jobId: questionImportItems.jobId, status: questionImportItems.status, n: sql<number>`count(*)` })
    .from(questionImportItems)
    .where(inArray(questionImportItems.jobId, jobs.map((j) => j.id)))
    .groupBy(questionImportItems.jobId, questionImportItems.status);
  return jobs.map((j) => {
    const of = (s: string) => Number(counts.find((c) => c.jobId === j.id && c.status === s)?.n ?? 0);
    return { ...jobView(j), pending: of("PENDING"), accepted: of("ACCEPTED"), rejected: of("REJECTED") };
  });
}

export function itemView(item: QuestionImportItem) {
  return {
    id: item.id,
    position: item.position,
    status: item.status,
    question: item.question,
    issues: item.issues,
    blocking: item.issues.some((i) => BLOCKING_ISSUES.includes(i)),
    topicId: item.topicId,
    proposedTopic: item.proposedTopic,
    answerSource: item.answerSource,
    confidence: item.confidence,
    sourcePage: item.sourcePage,
    sourceNumber: item.sourceNumber,
    duplicateOfQuestionId: item.duplicateOfQuestionId,
    questionId: item.questionId,
  };
}

export async function importDetail(scope: TeacherScope, id: string) {
  const job = await ownedJob(scope, id);
  const items = await requireDb().select().from(questionImportItems).where(eq(questionImportItems.jobId, id)).orderBy(asc(questionImportItems.position));
  const dupIds = [...new Set(items.map((i) => i.duplicateOfQuestionId).filter((x): x is string => !!x))];
  const dupTexts = dupIds.length
    ? await requireDb()
        .select({ id: questions.id, text: questions.text })
        .from(questions)
        .where(and(eq(questions.providerWorkspaceId, scope.workspaceId), inArray(questions.id, dupIds)))
    : [];
  return { job: jobView(job), items: items.map(itemView), duplicates: Object.fromEntries(dupTexts.map((d) => [d.id, d.text.slice(0, 300)])) };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

async function ownedItem(scope: TeacherScope, id: string): Promise<QuestionImportItem> {
  const [item] = await requireDb()
    .select()
    .from(questionImportItems)
    .where(and(eq(questionImportItems.id, id), eq(questionImportItems.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!item) throw new AppError("NOT_FOUND");
  return item;
}

/** Edits clear the flags they resolve: a teacher-saved question is valid and its answer is the teacher's. */
export async function updateItem(
  scope: TeacherScope,
  id: string,
  patch: { question?: QuestionInput; topicId?: string | null; proposedTopic?: string | null },
) {
  const item = await ownedItem(scope, id);
  if (item.status === "ACCEPTED") throw new AppError("IMPORT_BUSY");
  const set: Partial<QuestionImportItem> = {};
  if (patch.question) {
    const before = item.question as { answerKey?: unknown };
    const answerChanged = JSON.stringify(before.answerKey) !== JSON.stringify(patch.question.answerKey);
    set.question = patch.question as unknown as Record<string, unknown>;
    const resolved: ImportIssue[] = ["INVALID_QUESTION", "ANSWER_MISSING", "TYPE_CHANGED"];
    if (answerChanged) resolved.push("ANSWER_MISMATCH", "AI_ANSWER", "LOW_CONFIDENCE");
    set.issues = item.issues.filter((i) => !resolved.includes(i));
    if (answerChanged || item.issues.includes("ANSWER_MISSING")) {
      set.answerSource = "TEACHER";
      set.confidence = "HIGH";
    }
  }
  if (patch.topicId !== undefined) {
    if (patch.topicId) await ownedTopic(scope, patch.topicId);
    set.topicId = patch.topicId;
    if (patch.topicId) set.proposedTopic = null;
  }
  if (patch.proposedTopic !== undefined) {
    set.proposedTopic = patch.proposedTopic?.trim().slice(0, 120) || null;
    if (set.proposedTopic) set.topicId = null;
  }
  if (Object.keys(set).length) await requireDb().update(questionImportItems).set(set).where(eq(questionImportItems.id, id));
  return itemView(await ownedItem(scope, id));
}

export async function rejectItems(scope: TeacherScope, ids: string[], rejected: boolean) {
  await requireDb()
    .update(questionImportItems)
    .set({ status: rejected ? "REJECTED" : "PENDING" })
    .where(
      and(
        eq(questionImportItems.providerWorkspaceId, scope.workspaceId),
        inArray(questionImportItems.id, ids),
        inArray(questionImportItems.status, ["PENDING", "REJECTED"]),
      ),
    );
  return { ok: true };
}

/**
 * Saves pending items into the bank, each under its topic (a proposed topic is created on first
 * use, beneath the job's default topic if one was chosen). Items with blocking issues are skipped
 * and reported, never silently saved.
 */
export async function acceptItems(scope: TeacherScope, jobId: string, ids: string[] | "ALL", opts: { skipDuplicates?: boolean } = {}) {
  const db = requireDb();
  const job = await ownedJob(scope, jobId);
  if (isBusy(job)) throw new AppError("IMPORT_BUSY");
  const conds = [eq(questionImportItems.jobId, jobId), eq(questionImportItems.status, "PENDING")];
  if (ids !== "ALL") conds.push(inArray(questionImportItems.id, ids.length ? ids : ["-"]));
  const items = await db.select().from(questionImportItems).where(and(...conds)).orderBy(asc(questionImportItems.position));

  const accepted: string[] = [];
  const skipped: { id: string; reason: "INVALID" | "DUPLICATE" }[] = [];
  const topicCache = new Map<string, string>();
  for (const item of items) {
    const parsed = questionInputSchema.safeParse(item.question);
    if (!parsed.success || item.issues.some((i) => BLOCKING_ISSUES.includes(i))) {
      skipped.push({ id: item.id, reason: "INVALID" });
      continue;
    }
    if (opts.skipDuplicates && (item.issues.includes("DUPLICATE_IN_BANK") || item.issues.includes("DUPLICATE_IN_FILE"))) {
      skipped.push({ id: item.id, reason: "DUPLICATE" });
      continue;
    }
    await db.transaction(async (tx) => {
      let topicId = item.topicId;
      let topicName: string | null = null;
      if (topicId) {
        const topic = await ownedTopic(scope, topicId, tx).catch(() => null);
        topicId = topic?.id ?? null;
        topicName = topic?.name ?? null;
      }
      if (!topicId && item.proposedTopic) {
        const key = item.proposedTopic.toLowerCase();
        const cached = topicCache.get(key);
        const topic = cached ? await ownedTopic(scope, cached, tx) : await ensureTopic(scope, item.proposedTopic, job.defaultTopicId, tx);
        topicCache.set(key, topic.id);
        topicId = topic.id;
        topicName = topic.name;
      }
      if (!topicId && job.defaultTopicId) {
        const topic = await ownedTopic(scope, job.defaultTopicId, tx).catch(() => null);
        topicId = topic?.id ?? null;
        topicName = topic?.name ?? null;
      }
      const question = { ...parsed.data, topic: (topicName ?? parsed.data.topic).slice(0, 120) };
      const row = await createQuestion(scope, question, "AI", tx);
      await tx.insert(questionMeta).values({
        questionId: row.id,
        providerWorkspaceId: scope.workspaceId,
        topicId,
        importJobId: job.id,
        sourceFileName: job.fileName.slice(0, 255),
        sourcePage: item.sourcePage,
        sourceNumber: item.sourceNumber,
        answerSource: item.answerSource,
        aiConfidence: item.confidence,
      });
      await tx
        .update(questionImportItems)
        .set({ status: "ACCEPTED", questionId: row.id, topicId })
        .where(and(eq(questionImportItems.id, item.id), eq(questionImportItems.status, "PENDING")));
    });
    accepted.push(item.id);
  }
  const [left] = await db
    .select({ n: sql<number>`count(*)` })
    .from(questionImportItems)
    .where(and(eq(questionImportItems.jobId, jobId), eq(questionImportItems.status, "PENDING")));
  if (Number(left?.n ?? 0) === 0 && job.status === "READY") {
    await db.update(questionImportJobs).set({ status: "COMPLETED" }).where(eq(questionImportJobs.id, jobId));
  }
  return { accepted: accepted.length, skipped };
}

/**
 * Drops the job and its drafts; questions already accepted stay in the bank. The uploaded file is
 * kept: it is an ordinary workspace file and may be used elsewhere. A running job notices on its
 * next progress write and stops.
 */
export async function deleteImport(scope: TeacherScope, id: string) {
  await ownedJob(scope, id);
  await requireDb().transaction(async (tx) => {
    await tx.delete(questionImportItems).where(eq(questionImportItems.jobId, id));
    await tx.delete(questionImportJobs).where(eq(questionImportJobs.id, id));
  });
  return { ok: true };
}
