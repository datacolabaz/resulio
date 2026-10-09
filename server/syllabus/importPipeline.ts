import { randomBytes } from "node:crypto";
import type { SyllabusImportError } from "../../shared/syllabusImport";
import { LlmHttpError, llmFailureReason, type Message } from "../_core/llm";
import {
  buildHeaderMessages,
  buildImportMessages,
  buildModuleMessages,
  describeUnreadableReply,
  EMPTY_SYLLABUS,
  fillSyllabus,
  jsonErrorOf,
  mergeParts,
  moduleFromJson,
  parseJsonLoose,
  shapeOf,
  splitTextChunks,
  structureFromJson,
  syllabusFromJson,
  type RawModule,
  type RawPart,
  type RawSyllabus,
} from "./importExtraction";
import { findModuleSections, isProjectSectionTitle, parseHeaderLocally, parseSectionLocally, type LocalModule, type ModuleSection } from "./importText";

/**
 * Reading a syllabus text with the model in small requests. When the text has module headings each
 * module is read by its own request (a reply stays far below any output limit, and nothing can move
 * between modules); a module the model cannot read is read from the text's own structure instead.
 * Text without module headings is read in parts that are halved when a reply is cut off or
 * unreadable. The model is injected (`Ask`), so the whole flow is unit-tested with canned replies.
 */

export type AskKind = "header" | "module" | "document";
export interface AskRequest {
  kind: AskKind;
  messages: Message[];
  /** "module 3", "part 2/4", … for logs and the job's technical detail. */
  label: string;
  /** 2+ when the previous reply was unreadable or cut off (the asker may allow a longer reply). */
  attempt?: number;
}
export interface AskReply {
  content: string;
  finishReason: string | null;
}
export type Ask = (req: AskRequest) => Promise<AskReply>;

/** A failure that ends the job; `detail` is the technical reason kept on the job and logged. */
export class ImportFailure extends Error {
  constructor(public readonly code: SyllabusImportError, public readonly detail: string, public readonly cause?: unknown) {
    super(`${code}: ${detail}`);
    this.name = "ImportFailure";
  }
}

export interface AiErrorInfo {
  code: SyllabusImportError;
  /** No later request can succeed either (bad key, unknown model): the job fails. */
  fatal: boolean;
  /** Later requests would most likely fail the same way (daily quota): stop asking, read the rest locally. */
  stopAsking: boolean;
  /** The same request may well succeed after a pause (rate window, 5xx, network error, time-out). */
  transient?: boolean;
  /** How long the provider asked to wait before the next request. */
  retryAfterMs?: number;
  detail: string;
}

/** A provider / network error → what it means for the run. */
export function classifyAiError(error: unknown): AiErrorInfo {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 400);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { code: "AI_TIMEOUT", fatal: false, stopAsking: false, transient: true, detail: `timeout: ${message}` };
  }
  const code = llmFailureReason(error);
  if (!(error instanceof LlmHttpError)) return { code, fatal: false, stopAsking: false, transient: true, detail: message };
  if (code === "AI_QUOTA") {
    const daily = error.quotaWindow === "day";
    return { code, fatal: false, stopAsking: daily, transient: !daily, retryAfterMs: error.retryAfterMs, detail: message };
  }
  const fatal = code === "AI_KEY_INVALID" || code === "AI_NOT_FOUND";
  return { code, fatal, stopAsking: false, transient: error.status >= 500 || error.status === 408, detail: message };
}

/** Asks per request for a transient provider error (a time-out is asked again only once). */
const TRANSIENT_ATTEMPTS = 4;
const TIMEOUT_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 2_000;
const MAX_WAIT_MS = 65_000;

/** Equal-jitter exponential backoff, at least what the provider asked for. */
function transientWait(info: AiErrorInfo, retry: number): number {
  const cap = Math.min(BACKOFF_BASE_MS * 2 ** retry, MAX_WAIT_MS);
  return Math.min(Math.max(cap / 2 + Math.random() * (cap / 2), info.retryAfterMs ?? 0), MAX_WAIT_MS);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A request that did not give a usable reply. */
class StepError extends Error {
  constructor(public readonly info: AiErrorInfo, public readonly cause?: unknown) {
    super(info.detail);
  }
}

const TRUNCATED = new Set(["length", "max_tokens", "MAX_TOKENS"]);

export interface RunnerOptions {
  ask: Ask;
  classify?: (error: unknown) => AiErrorInfo;
  /** Absolute time (ms) after which no new request starts; the rest is read locally or fails. */
  deadline?: number;
  /** True once the run no longer owns the job (retried or deleted): no new request starts. */
  shouldStop?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Asking with retries. An unreadable or cut-off reply is asked again once; a reply cut off twice is
 * used as far as it goes (`partial`). A transient provider error (rate window, 5xx, network, time-out)
 * is asked again after a backoff of at least the provider's retry delay; a 429 pauses every request
 * of the run, so parallel requests do not keep hitting the same rate window. A daily quota, or a 429
 * that outlasts the retries, stops asking for the rest of the run.
 */
export function createRunner(opts: RunnerOptions) {
  const classify = opts.classify ?? classifyAiError;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? (() => undefined);
  const state = { stopped: null as AiErrorInfo | null, lastProblem: null as AiErrorInfo | null, pauseUntil: 0 };

  const pastDeadline = (at: number) => opts.deadline !== undefined && at > opts.deadline;
  const outOfTime = (req: AskRequest) =>
    new StepError({ code: "AI_TIMEOUT", fatal: false, stopAsking: true, detail: `${req.label}: the import ran out of time before this request` });

  async function beforeAsking(req: AskRequest) {
    for (;;) {
      if (state.stopped) throw new StepError({ ...state.stopped, detail: `${req.label}: not sent, AI requests stopped after ${state.stopped.code}` });
      if (opts.shouldStop?.()) throw new StepError({ code: "INTERRUPTED", fatal: false, stopAsking: true, detail: `${req.label}: the run was replaced` });
      if (pastDeadline(Math.max(now(), state.pauseUntil))) throw outOfTime(req);
      const wait = state.pauseUntil - now();
      if (wait <= 0) return;
      await sleep(wait);
    }
  }

  async function askJson<T>(req: AskRequest, read: (value: unknown) => T | null, attempts = 2): Promise<{ value: T; partial: boolean }> {
    let partialValue: T | null = null;
    let problem: AiErrorInfo | null = null;
    let transientRetries = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await beforeAsking(req);
      let reply: AskReply;
      try {
        reply = await opts.ask(attempt > 1 ? { ...req, attempt } : req);
      } catch (error) {
        const info = classify(error);
        const labelled = { ...info, detail: `${req.label}: ${info.detail}` };
        state.lastProblem = labelled;
        if (info.fatal) {
          state.stopped = labelled;
          throw new ImportFailure(info.code, labelled.detail, error);
        }
        const limit = info.code === "AI_TIMEOUT" ? TIMEOUT_ATTEMPTS : TRANSIENT_ATTEMPTS;
        if (info.transient && !state.stopped && transientRetries + 1 < limit) {
          const wait = transientWait(info, transientRetries++);
          if (!pastDeadline(now() + wait)) {
            log(`${labelled.detail} — asking again in ${Math.round(wait / 1000)}s`);
            if (info.code === "AI_QUOTA") state.pauseUntil = Math.max(state.pauseUntil, now() + wait);
            else await sleep(wait);
            attempt--;
            continue;
          }
        }
        if (info.stopAsking || info.code === "AI_QUOTA") state.stopped ??= { ...labelled, stopAsking: true };
        throw new StepError(labelled, error);
      }
      const parsed = parseJsonLoose(reply.content);
      const value = parsed ? read(parsed.value) : null;
      const cutOff = TRUNCATED.has(reply.finishReason ?? "") || !!parsed?.repaired;
      if (value !== null && !cutOff) return { value, partial: false };
      const why = value !== null ? "reply cut off (repaired)" : parsed ? `unexpected JSON shape (${shapeOf(parsed.value)})` : jsonErrorOf(reply.content);
      problem = { code: "AI_OUTPUT", fatal: false, stopAsking: false, detail: `${req.label}, attempt ${attempt}: ${describeUnreadableReply(reply.content, reply.finishReason, why)}` };
      state.lastProblem = problem;
      log(problem.detail);
      if (value !== null) partialValue = value;
    }
    if (partialValue !== null) return { value: partialValue, partial: true };
    throw new StepError(problem!);
  }

  return { askJson, state };
}

export type Runner = ReturnType<typeof createRunner>;
export const isStepError = (e: unknown): e is StepError => e instanceof StepError;
export const stepErrorInfo = (e: unknown): AiErrorInfo | null => (e instanceof StepError ? e.info : null);

// ---------------------------------------------------------------------------
// Merging the model's reading with the text's own structure
// ---------------------------------------------------------------------------

function localToRaw(title: string, local: LocalModule): RawModule {
  return { title, continuesPrevious: false, isModule: true, ...local, duration: null };
}

const isEmptyAssessment = (a: RawModule["assessment"]) => !a.heading && !a.intro && !a.pipeline && !a.listIntro && !a.items.length;
const isEmptyModule = (m: RawModule) => !m.lessons.length && !m.projects.length && !m.objectives.length && !m.prerequisites.length && isEmptyAssessment(m.assessment);

/** Fields the model left empty taken from the text's own structure (for a reply cut off mid-way). */
function fillModule(ai: RawModule, local: LocalModule): RawModule {
  return {
    ...ai,
    description: ai.description || local.description,
    lessons: ai.lessons.length ? ai.lessons : local.lessons,
    projectsHeading: ai.projectsHeading || local.projectsHeading,
    projects: ai.projects.length ? ai.projects : local.projects,
    objectives: ai.objectives.length ? ai.objectives : local.objectives,
    prerequisites: ai.prerequisites.length ? ai.prerequisites : local.prerequisites,
    assessment: isEmptyAssessment(ai.assessment) ? local.assessment : ai.assessment,
  };
}

// ---------------------------------------------------------------------------
// The text flow
// ---------------------------------------------------------------------------

export interface ExtractResult {
  raw: RawPart;
  /** Titles of modules read from the text's structure because the model could not read them. */
  localModules: string[];
  /** Why each of those (and the course header, if it failed) could not be read by the model, in document order. */
  failures: string[];
  /** The last problem met on the way (kept as the job's technical detail even when it succeeded). */
  problem: AiErrorInfo | null;
}

export interface ExtractOptions extends RunnerOptions {
  /** Called once the number of requests is known, then after each finished request. */
  onPlan?: (total: number) => unknown;
  onStep?: (done: number) => unknown;
  concurrency?: number;
  nonce?: () => string;
}

/** Parallel model requests per run; free-tier rate windows are a few requests per minute. */
const DEFAULT_CONCURRENCY = 2;

async function pool<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const newNonce = () => randomBytes(6).toString("hex");

/** A syllabus text → the merged reading. Throws `ImportFailure` when nothing usable can be read. */
export async function extractFromText(text: string, opts: ExtractOptions): Promise<ExtractResult> {
  const plan = findModuleSections(text);
  return plan ? extractBySections(plan.preamble, plan.sections, opts) : extractByParts(text, opts);
}

async function extractBySections(preamble: string, sections: ModuleSection[], opts: ExtractOptions): Promise<ExtractResult> {
  const runner = createRunner(opts);
  const nonce = opts.nonce ?? newNonce;
  const total = sections.length + 1;
  let done = 0;
  const step = async () => opts.onStep?.(++done);
  await opts.onPlan?.(total);
  const localModules: string[] = [];
  /** Failure reason per request index (0 = header), so they are reported in document order. */
  const failures: Array<string | undefined> = [];
  const reasonOf = (error: unknown) => stepErrorInfo(error)?.detail ?? (error instanceof Error ? error.message : String(error));
  const titles = sections.filter((s) => s.numbered).map((s) => s.title);

  const readHeader = async (): Promise<RawSyllabus> => {
    const local = parseHeaderLocally(preamble);
    const localRaw = fillSyllabus(EMPTY_SYLLABUS, local);
    if (!preamble.trim()) return localRaw;
    try {
      const { value } = await runner.askJson({ kind: "header", messages: buildHeaderMessages({ text: preamble, moduleTitles: titles, nonce: nonce() }), label: "course header" }, syllabusFromJson);
      return fillSyllabus(value, local);
    } catch (error) {
      if (error instanceof ImportFailure) throw error;
      failures[0] = reasonOf(error);
      return localRaw;
    }
  };

  const readSection = async (section: ModuleSection, index: number): Promise<RawModule | null> => {
    const local = parseSectionLocally(section.text);
    try {
      const { value, partial } = await runner.askJson(
        { kind: "module", messages: buildModuleMessages({ title: section.title, text: section.text, index, total: sections.length, nonce: nonce() }), label: `module ${index + 1} "${section.title.slice(0, 60)}"` },
        moduleFromJson,
      );
      if (!section.numbered && !value.isModule) return null;
      const ai: RawModule = { ...value, title: section.title, isModule: true, continuesPrevious: false };
      return partial || isEmptyModule(ai) ? fillModule(ai, local) : ai;
    } catch (error) {
      if (error instanceof ImportFailure) throw error;
      if (!section.numbered && !isProjectSectionTitle(section.title)) return null;
      localModules.push(section.title);
      failures[index + 1] = reasonOf(error);
      return localToRaw(section.title, local);
    }
  };

  const [syllabus, ...modules] = await pool<null | ModuleSection, RawSyllabus | RawModule | null>([null, ...sections], opts.concurrency ?? DEFAULT_CONCURRENCY, async (item, i) => {
    const out = item === null ? await readHeader() : await readSection(item, i - 1);
    await step();
    return out;
  });
  const kept = (modules as Array<RawModule | null>).filter((m): m is RawModule => !!m);
  // Keep the document order of the module list for the local-reading notice.
  localModules.sort((a, b) => titles.indexOf(a) - titles.indexOf(b));
  return { raw: { syllabus: syllabus as RawSyllabus, modules: kept }, localModules, failures: failures.filter((f): f is string => !!f), problem: runner.state.lastProblem };
}

const MIN_SPLIT_CHARS = 1_500;

async function extractByParts(text: string, opts: ExtractOptions): Promise<ExtractResult> {
  const runner = createRunner(opts);
  const nonce = opts.nonce ?? newNonce;
  const chunks = splitTextChunks(text);
  if (!chunks.length) throw new ImportFailure("NO_TEXT", "the text is empty");
  await opts.onPlan?.(chunks.length);
  const outs: RawPart[] = [];

  const readChunk = async (chunk: string, index: number, depth: number): Promise<void> => {
    const label = `part ${index + 1}/${chunks.length}${depth ? ` (split ${depth})` : ""}`;
    const previousModules = mergeParts(outs).modules.map((m) => m.title);
    const canSplit = depth < 2 && chunk.length > MIN_SPLIT_CHARS;
    try {
      const { value, partial } = await runner.askJson(
        { kind: "document", messages: buildImportMessages({ parts: null, documentText: chunk, part: { index, total: chunks.length }, previousModules, nonce: nonce() }), label },
        structureFromJson,
        canSplit ? 1 : 2,
      );
      if (!partial || !canSplit) return void outs.push(value);
    } catch (error) {
      if (error instanceof ImportFailure) throw error;
      const info = stepErrorInfo(error);
      const splittable = info && (info.code === "AI_OUTPUT" || info.code === "AI_TIMEOUT") && !info.stopAsking;
      if (!canSplit || !splittable) throw new ImportFailure(info?.code ?? "AI_OUTPUT", info?.detail ?? String(error), (error as { cause?: unknown }).cause);
    }
    const halves = splitTextChunks(chunk, Math.ceil(chunk.length / 2) + 200);
    for (const half of halves) await readChunk(half, index, depth + 1);
  };

  for (const [i, chunk] of chunks.entries()) {
    await readChunk(chunk, i, 0);
    await opts.onStep?.(i + 1);
  }
  return { raw: mergeParts(outs), localModules: [], failures: [], problem: runner.state.lastProblem };
}
