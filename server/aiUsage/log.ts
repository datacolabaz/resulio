import { costMicroUsd, type AiCallStatus } from "../../shared/aiUsage";
import { aiRequestLogs } from "../../drizzle/schema";
import { setLlmCallListener, type LlmCallEvent } from "../_core/llm";
import { requireDb } from "../db";
import { currentAiUsage, type AiUsageContext } from "./context";
import { loadPrices, priceFor, type PriceTable } from "./pricing";

export type AiLogRow = typeof aiRequestLogs.$inferInsert;

/** Gemini bills an image or a PDF page at a few hundred tokens; one part is counted as one page. */
const TOKENS_PER_MEDIA_PART = 258;
const CHARS_PER_TOKEN = 4;

function walk(value: unknown, acc: { chars: number; media: number }) {
  if (typeof value === "string") {
    acc.chars += value.length;
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walk(v, acc);
    return;
  }
  if (!value || typeof value !== "object") return;
  const part = value as { type?: unknown; text?: unknown; content?: unknown };
  if (part.type === "image_url" || part.type === "file" || part.type === "file_url") {
    acc.media++;
    return;
  }
  if (typeof part.text === "string") acc.chars += part.text.length;
  if (part.content !== undefined) walk(part.content, acc);
}

/** Rough token count (≈4 characters per token, a flat amount per image or file) for replies without `usage`. */
export function estimateTokens(content: unknown): number {
  const acc = { chars: 0, media: 0 };
  walk(content, acc);
  return Math.ceil(acc.chars / CHARS_PER_TOKEN) + acc.media * TOKENS_PER_MEDIA_PART;
}

export function callStatus(event: Pick<LlmCallEvent, "ok" | "httpStatus">): AiCallStatus {
  if (event.ok) return "OK";
  return event.httpStatus === 429 ? "RATE_LIMITED" : "ERROR";
}

const int = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** The log row for one call. A failed call is logged with zero tokens: nothing was billed for it. */
export function buildLogRow(event: LlmCallEvent, ctx: AiUsageContext | undefined, prices: PriceTable): AiLogRow {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let estimated = false;
  if (event.ok) {
    if (event.usage && (int(event.usage.total_tokens) || int(event.usage.prompt_tokens))) {
      prompt = int(event.usage.prompt_tokens);
      completion = int(event.usage.completion_tokens);
      total = Math.max(int(event.usage.total_tokens), prompt + completion);
    } else {
      prompt = estimateTokens(event.messages);
      completion = estimateTokens(event.reply);
      total = prompt + completion;
      estimated = true;
    }
  }
  const price = priceFor(prices, event.model);
  return {
    userId: ctx?.userId ?? null,
    workspaceId: ctx?.workspaceId ?? null,
    feature: ctx?.feature ?? "OTHER",
    operationId: ctx?.operationId ?? null,
    model: event.model.slice(0, 120),
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    tokensEstimated: estimated,
    costMicroUsd: price ? costMicroUsd({ prompt, completion, total }, price) : 0,
    status: callStatus(event),
    httpStatus: event.httpStatus ?? null,
    latencyMs: Math.max(0, Math.round(event.latencyMs)),
    createdAt: new Date(),
  };
}

export interface UsageRecorderDeps {
  context: () => AiUsageContext | undefined;
  prices: () => Promise<PriceTable>;
  insert: (row: AiLogRow) => Promise<unknown>;
}

const defaultDeps: UsageRecorderDeps = {
  context: currentAiUsage,
  prices: loadPrices,
  insert: (row) => requireDb().insert(aiRequestLogs).values(row),
};

/**
 * The invokeLLM listener: reads the context synchronously (still inside the caller's async scope),
 * then writes the row in the background. Returns at once; every failure is logged and swallowed,
 * so a broken log never fails or slows the AI call. Returns the write for tests.
 */
export function recordLlmCall(event: LlmCallEvent, deps: UsageRecorderDeps = defaultDeps): Promise<void> {
  let ctx: AiUsageContext | undefined;
  try {
    ctx = deps.context();
  } catch {
    ctx = undefined;
  }
  return (async () => {
    const prices = await deps.prices().catch((error: unknown) => {
      console.warn("[aiUsage] prices unavailable; logging without cost", error instanceof Error ? error.message : error);
      return new Map() as PriceTable;
    });
    await deps.insert(buildLogRow(event, ctx, prices));
  })().catch((error: unknown) => {
    console.warn("[aiUsage] could not log an AI call", error instanceof Error ? error.message : error);
  });
}

export function installAiUsageLogging() {
  setLlmCallListener((event) => void recordLlmCall(event));
}
