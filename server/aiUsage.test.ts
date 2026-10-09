import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { costMicroUsd, MICRO_USD } from "../shared/aiUsage";
import { invokeLLM, setLlmCallListener, type LlmCallEvent } from "./_core/llm";
import { currentAiUsage, withAiUsage, type AiUsageContext } from "./aiUsage/context";
import { buildLogRow, callStatus, estimateTokens, recordLlmCall, type AiLogRow } from "./aiUsage/log";
import { priceFor, type PriceTable } from "./aiUsage/pricing";

const PRICES: PriceTable = new Map([
  ["gemini-3.8-flash", { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 }],
  ["*", { inputUsdPerMillion: 1, outputUsdPerMillion: 4 }],
]);
const CTX: AiUsageContext = { feature: "QUESTION_IMPORT", userId: 7, workspaceId: "ws1", operationId: "op1" };

const event = (over: Partial<LlmCallEvent> = {}): LlmCallEvent => ({
  model: "gemini-3.8-flash",
  ok: true,
  httpStatus: 200,
  latencyMs: 1234.4,
  messages: [{ role: "user", content: "x".repeat(400) }],
  usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1500 },
  reply: "ok",
  ...over,
});

describe("cost calculation", () => {
  it("prices input and output per million tokens, in micro-USD", () => {
    // 1000 × 0.3 + 200 × 2.5 = 800 micro-USD
    expect(costMicroUsd({ prompt: 1000, completion: 200, total: 1200 }, { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 })).toBe(800);
    expect(costMicroUsd({ prompt: 1_000_000, completion: 0, total: 1_000_000 }, { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 }) / MICRO_USD).toBeCloseTo(0.3);
  });

  it("bills Gemini thinking tokens (in total, not in completion) as output", () => {
    // output = 1500 − 1000 = 500 → 1000 × 0.3 + 500 × 2.5 = 1550
    expect(costMicroUsd({ prompt: 1000, completion: 200, total: 1500 }, { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 })).toBe(1550);
  });

  it("never goes negative", () => {
    expect(costMicroUsd({ prompt: -5, completion: -1, total: 0 }, { inputUsdPerMillion: 1, outputUsdPerMillion: 1 })).toBe(0);
  });

  it("uses the model's own price, then its base name, then the * row", () => {
    expect(priceFor(PRICES, "Gemini-3.8-Flash")?.inputUsdPerMillion).toBe(0.3);
    expect(priceFor(PRICES, "models/gemini-3.8-flash")?.inputUsdPerMillion).toBe(0.3);
    expect(priceFor(PRICES, "some-other-model")?.inputUsdPerMillion).toBe(1);
    expect(priceFor(new Map(), "gemini-3.8-flash")).toBeNull();
  });
});

describe("usage log rows", () => {
  it("takes tokens from the provider's usage and attributes the call to the context", () => {
    const row = buildLogRow(event(), CTX, PRICES);
    expect(row).toMatchObject({
      userId: 7,
      workspaceId: "ws1",
      feature: "QUESTION_IMPORT",
      operationId: "op1",
      model: "gemini-3.8-flash",
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1500,
      tokensEstimated: false,
      costMicroUsd: 1550,
      status: "OK",
      httpStatus: 200,
      latencyMs: 1234,
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("estimates and flags tokens when the reply has no usage", () => {
    const row = buildLogRow(event({ usage: undefined, reply: "y".repeat(80) }), CTX, PRICES);
    expect(row.tokensEstimated).toBe(true);
    expect(row.promptTokens).toBe(100);
    expect(row.completionTokens).toBe(20);
    expect(row.totalTokens).toBe(120);
    expect(row.costMicroUsd).toBe(Math.round(100 * 0.3 + 20 * 2.5));
  });

  it("counts images and files at a flat rate when estimating", () => {
    const content = [{ role: "user", content: [{ type: "text", text: "abcdefgh" }, { type: "image_url", image_url: { url: "data:..." } }, { type: "file", file: {} }] }];
    expect(estimateTokens(content)).toBe(2 + 2 * 258);
  });

  it("logs failed calls with zero tokens and the right status", () => {
    const failed = buildLogRow(event({ ok: false, httpStatus: 500, usage: undefined }), CTX, PRICES);
    expect(failed).toMatchObject({ status: "ERROR", totalTokens: 0, costMicroUsd: 0, tokensEstimated: false });
    expect(callStatus({ ok: false, httpStatus: 429 })).toBe("RATE_LIMITED");
    expect(callStatus({ ok: false })).toBe("ERROR");
  });

  it("logs calls outside any feature as OTHER with no user", () => {
    expect(buildLogRow(event(), undefined, PRICES)).toMatchObject({ feature: "OTHER", userId: null, workspaceId: null, operationId: null });
  });
});

describe("recording a call", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("writes one row with the caller's context", async () => {
    const rows: AiLogRow[] = [];
    await recordLlmCall(event(), { context: () => CTX, prices: async () => PRICES, insert: async (r) => void rows.push(r) });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(7);
  });

  it("swallows a failing insert", async () => {
    const write = recordLlmCall(event(), { context: () => CTX, prices: async () => PRICES, insert: () => Promise.reject(new Error("db down")) });
    await expect(write).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("still logs (without cost) when prices cannot be loaded", async () => {
    const rows: AiLogRow[] = [];
    await recordLlmCall(event(), { context: () => CTX, prices: () => Promise.reject(new Error("no table")), insert: async (r) => void rows.push(r) });
    expect(rows[0]).toMatchObject({ totalTokens: 1500, costMicroUsd: 0 });
  });

  it("returns before the write finishes and survives a throwing context reader", async () => {
    let release: (() => void) | undefined;
    const rows: AiLogRow[] = [];
    let settled = false;
    const write = recordLlmCall(event(), {
      context: () => {
        throw new Error("boom");
      },
      prices: async () => PRICES,
      insert: (row) => new Promise<void>((resolve) => {
        rows.push(row);
        release = resolve;
      }),
    }).then(() => (settled = true));
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(settled).toBe(false);
    expect(rows[0]).toMatchObject({ feature: "OTHER", userId: null });
    release?.();
    await write;
    expect(settled).toBe(true);
  });
});

describe("usage context", () => {
  it("follows the work across awaits and setImmediate, and generates an operation id", async () => {
    const seen = await withAiUsage({ feature: "SYLLABUS_IMPORT", userId: 3, workspaceId: "w" }, async () => {
      await Promise.resolve();
      return new Promise<AiUsageContext | undefined>((resolve) => setImmediate(() => resolve(currentAiUsage())));
    });
    expect(seen).toMatchObject({ feature: "SYLLABUS_IMPORT", userId: 3, workspaceId: "w" });
    expect(seen?.operationId).toMatch(/\S{10,}/);
    expect(currentAiUsage()).toBeUndefined();
  });
});

describe("invokeLLM usage hook", () => {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    vi.stubEnv("AI_API_URL", "https://generativelanguage.googleapis.com/v1beta/openai");
    vi.stubEnv("AI_API_KEY", "AIzaSyFakeKeyForTests");
    vi.stubEnv("AI_MODEL", "gemini-3.8-flash");
  });
  afterEach(() => {
    setLlmCallListener(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reports usage, model and latency of a successful call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { id: "1", model: "gemini-3.8-flash", choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 9 } })));
    const events: LlmCallEvent[] = [];
    setLlmCallListener((e) => events.push(e));
    await invokeLLM({ messages: [{ role: "user", content: "hi" }] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ok: true, model: "gemini-3.8-flash", usage: { total_tokens: 9 }, reply: "hi" });
    expect(events[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("is never allowed to break the call, even if the listener throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { id: "1", model: "m", choices: [{ message: { role: "assistant", content: "fine" } }] })));
    setLlmCallListener(() => {
      throw new Error("listener exploded");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await invokeLLM({ messages: [{ role: "user", content: "hi" }] });
    expect(result.choices[0].message.content).toBe("fine");
    warn.mockRestore();
  });

  it("reports a rate-limited call before rethrowing its error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(429, { error: { message: "quota" } })));
    const events: LlmCallEvent[] = [];
    setLlmCallListener((e) => events.push(e));
    await expect(invokeLLM({ messages: [{ role: "user", content: "hi" }], maxRetries: 0 })).rejects.toThrow();
    expect(events.map((e) => [e.ok, e.httpStatus])).toEqual([[false, 429]]);
    expect(callStatus(events[0])).toBe("RATE_LIMITED");
  });
});
