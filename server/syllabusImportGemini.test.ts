import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeLLM, LlmHttpError, rateLimitHints } from "./_core/llm";
import { normalizeStructure } from "./syllabus/importExtraction";
import { importDetail, makeAsk } from "./syllabus/importJobs";
import { extractFromText } from "./syllabus/importPipeline";
import { findModuleSections, parseHeaderLocally, parseSectionLocally } from "./syllabus/importText";

/**
 * The syllabus import against a faithful fake of Gemini's OpenAI-compatible endpoint: the real
 * request path (makeAsk → invokeLLM → fetch), Gemini's 429 bodies (no Retry-After header; the wait in
 * RetryInfo, the window in the QuotaFailure id), a thinking model that spends its token budget, and
 * 5xx blips. A 6-month Java syllabus pasted as plain text ("1-ci AY — …" lines and bullet lists).
 */

const JAVA = readFileSync(join(__dirname, "syllabus", "__fixtures__", "java-6-month-paste.md"), "utf8");
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const KEY = "AIzaSyFakeKeyForTests";
const TITLES = [
  "1-ci AY — Java Fundamentals & Programming Basics",
  "2-ci AY — Object-Oriented Programming (OOP) & Java Core",
  "3-cü AY — Advanced Java, File Handling, Streams & Database Fundamentals",
  "4-cü AY — Software Design, Clean Code & Spring Framework",
  "5-ci AY — REST APIs, Spring Security & Testing",
  "6-cı AY — Deployment, Docker & Final Project",
];

interface Call {
  at: number;
  label: string;
  body: Record<string, unknown>;
  url: string;
  auth: string;
}
type Reply = Response | "ok";

const ok = (content: string, finishReason = "stop") =>
  new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "gemini-2.5-flash", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }] }), { status: 200 });

function tooMany(window: "Minute" | "Day") {
  const body = [
    {
      error: {
        code: 429,
        message: "You exceeded your current quota, please check your plan and billing details.\nPlease retry in 41.2s.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: `GenerateRequestsPer${window}PerProjectPerModel-FreeTier`, quotaValue: "10" }] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" },
        ],
      },
    },
  ];
  return new Response(JSON.stringify(body), { status: 429, statusText: "Too Many Requests" });
}

/** A virtual clock shared by the pipeline (now/sleep) and the fake provider. */
function gemini(decide: (call: Call, calls: Call[]) => Reply = () => "ok") {
  const clock = { t: 0 };
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const messages = body.messages as Array<{ content: string }>;
      const user = String(messages[1].content);
      const isHeader = String(messages[0].content).includes("beginning of a teacher");
      const label = isHeader ? "header" : `module ${/Module (\d+) of/.exec(user)?.[1]}`;
      const call: Call = { at: clock.t, label, body, url, auth: (init.headers as Record<string, string>).authorization };
      calls.push(call);
      const decided = decide(call, calls);
      if (decided !== "ok") return decided;
      const doc = /<<<DOC-\w+>>>\n([\s\S]*?)\n<<<END-DOC/.exec(user)?.[1] ?? "";
      return ok(JSON.stringify(isHeader ? parseHeaderLocally(doc) : { isModule: true, ...parseSectionLocally(doc) }));
    } finally {
      inFlight--;
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  const run = () =>
    extractFromText(JAVA, { ask: makeAsk(), now: () => clock.t, sleep: async (ms) => void (clock.t += ms), deadline: 12 * 60_000 }).then((r) => ({ ...r, s: normalizeStructure(r.raw, "")! }));
  return { calls, run, clock, maxInFlight: () => maxInFlight };
}

beforeEach(() => {
  vi.stubEnv("AI_API_URL", GEMINI);
  vi.stubEnv("AI_API_KEY", KEY);
  vi.stubEnv("AI_MODEL", "gemini-2.5-flash");
  vi.stubEnv("SYLLABUS_IMPORT_MODEL", "");
  vi.stubEnv("QUESTION_IMPORT_MODEL", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the pasted 6-month Java syllabus", () => {
  it("is split into the header and its 6 month sections", () => {
    const plan = findModuleSections(JAVA)!;
    expect(plan.sections.map((s) => s.title)).toEqual(TITLES);
    expect(plan.sections.every((s) => s.numbered)).toBe(true);
    expect(plan.preamble).toContain("6 AYLIQ PROQRAM");
  });

  it("is read by the AI with no module from the fallback, in requests Gemini accepts", async () => {
    const g = gemini();
    const { s, localModules, failures } = await g.run();
    expect(localModules).toEqual([]);
    expect(failures).toEqual([]);
    expect(s.modules.map((m) => m.title)).toEqual(TITLES);
    expect(s.modules[2].lessons.map((l) => l.title)).toContain("Stream API (filter, map, reduce, collect)");
    expect(g.calls.map((c) => c.label)).toEqual(["header", ...TITLES.map((_, i) => `module ${i + 1}`)]);
    for (const c of g.calls) {
      expect(c.url).toBe(`${GEMINI}/chat/completions`);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.body).toMatchObject({ model: "gemini-2.5-flash", response_format: { type: "json_object" }, reasoning_effort: "low" });
      expect(Object.keys(c.body).sort()).toEqual(["max_tokens", "messages", "model", "reasoning_effort", "response_format"]);
      expect(c.body.max_tokens).toBe(c.label === "header" ? 16_384 : 32_768);
    }
    expect(g.maxInFlight()).toBeLessThanOrEqual(2);
  });

  it("uses SYLLABUS_IMPORT_MODEL, then QUESTION_IMPORT_MODEL, then AI_MODEL", async () => {
    vi.stubEnv("QUESTION_IMPORT_MODEL", "gemini-q");
    let g = gemini();
    await g.run();
    expect(g.calls.every((c) => c.body.model === "gemini-q")).toBe(true);
    vi.stubEnv("SYLLABUS_IMPORT_MODEL", "gemini-s");
    g = gemini();
    await g.run();
    expect(g.calls.every((c) => c.body.model === "gemini-s")).toBe(true);
  });
});

describe("Gemini failure modes", () => {
  it("waits out a used-up per-minute rate window instead of reading every module from the text", async () => {
    // The user's case: the window was already used when the import started, so the first requests got 429.
    const g = gemini((call) => (call.at < 41_000 ? tooMany("Minute") : "ok"));
    const { localModules, failures, problem, s } = await g.run();
    expect(localModules).toEqual([]);
    expect(failures).toEqual([]);
    expect(s.modules).toHaveLength(6);
    const limited = g.calls.filter((c) => c.at < 41_000);
    expect(limited.length).toBeLessThanOrEqual(2);
    expect(problem?.detail).toContain("GenerateRequestsPerMinutePerProjectPerModel-FreeTier");
    expect(importDetail({ localModules, failures, problem })).toEqual({ message: expect.stringContaining("429") });
  });

  it("paces a burst against a 5 requests/minute limit so every module is still read by the AI", async () => {
    const g = gemini((call, calls) => {
      const recent = calls.filter((c) => c !== call && call.at - c.at < 60_000 && c.label !== "limited");
      if (recent.length >= 5) {
        call.label = "limited";
        return tooMany("Minute");
      }
      return "ok";
    });
    const { localModules } = await g.run();
    expect(localModules).toEqual([]);
    expect(g.maxInFlight()).toBeLessThanOrEqual(2);
  });

  it("stops asking on a daily quota and records a reason for every module", async () => {
    const g = gemini(() => tooMany("Day"));
    const { localModules, failures, problem, s } = await g.run();
    expect(g.calls.length).toBeLessThanOrEqual(2);
    expect(localModules).toEqual(TITLES);
    expect(s.modules.map((m) => m.title)).toEqual(TITLES);
    expect(s.modules[0].lessons.length).toBeGreaterThan(3);
    expect(problem?.code).toBe("AI_QUOTA");
    expect(failures).toHaveLength(7);
    expect(failures[0]).toMatch(/^course header: .*429.*GenerateRequestsPerDay/);
    const detail = importDetail({ localModules, failures, problem })!;
    expect(detail.localModules).toEqual(TITLES);
    expect(detail.message!.split("\n")).toHaveLength(7);
    expect(detail.message).toContain('module 6 "6-cı AY — Deployment, Docker & Final Project": not sent, AI requests stopped after AI_QUOTA');
    expect(detail.message).not.toContain(KEY);
    expect(detail.message!.length).toBeLessThanOrEqual(2_000);
  });

  it("asks again with a bigger budget when a thinking model spends it all and returns nothing", async () => {
    const g = gemini((call) => (call.label === "module 3" && call.body.max_tokens === 32_768 ? ok("", "length") : "ok"));
    const { localModules } = await g.run();
    expect(localModules).toEqual([]);
    expect(g.calls.filter((c) => c.label === "module 3").map((c) => c.body.max_tokens)).toEqual([32_768, 65_536]);
  });

  it("asks again after a 503 or a network error", async () => {
    const seen = new Set<string>();
    const g = gemini((call) => {
      if (seen.has(call.label)) return "ok";
      seen.add(call.label);
      if (call.label === "module 2") return new Response('{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}', { status: 503 });
      if (call.label === "module 4") throw new TypeError("fetch failed");
      return "ok";
    });
    const { localModules } = await g.run();
    expect(localModules).toEqual([]);
    expect(g.calls.filter((c) => c.label === "module 2" || c.label === "module 4")).toHaveLength(4);
  });

  it("accepts loosely shaped answers (fences, strings for objects, extra keys, a stated duration)", async () => {
    const g = gemini((call) => {
      if (call.label !== "module 1") return "ok";
      return ok('```json\n{"module":{"lessons":["Java nədir, JDK, JRE, JVM","Dəyişənlər"],"projects":"Konsol kalkulyatoru","objectives":"Java sintaksisi\\nAlqoritmlər","duration":"1 ay","confidence":0.9}}\n```');
    });
    const { localModules, s } = await g.run();
    expect(localModules).toEqual([]);
    expect(s.modules[0]).toMatchObject({ title: TITLES[0], duration: { value: 1, unit: "MONTHS" }, projects: [{ title: "Konsol kalkulyatoru", description: "" }] });
    expect(s.modules[0].lessons.map((l) => l.title)).toEqual(["Java nədir, JDK, JRE, JVM", "Dəyişənlər"]);
    expect(s.modules[0].details.objectives).toEqual(["Java sintaksisi", "Alqoritmlər"]);
  });

  it("stores no detail when the AI read everything at the first try", () => {
    expect(importDetail({ localModules: [], failures: [], problem: null })).toBeNull();
  });
});

describe("Gemini 429 handling in the shared AI client", () => {
  it("reads the wait and the quota window from Gemini's 429 body", () => {
    expect(rateLimitHints('{"retryDelay": "41s", "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}')).toEqual({ retryAfterMs: 41_000, quotaWindow: "minute" });
    expect(rateLimitHints("Quota exceeded ... limit: 0, model: gemini-2.5-pro. Please retry in 12.5s.")).toEqual({ retryAfterMs: 12_500, quotaWindow: "day" });
    expect(rateLimitHints('{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}')).toEqual({ quotaWindow: "day" });
    expect(rateLimitHints('{"error":{"code":"insufficient_quota"}}')).toEqual({ quotaWindow: "day" });
    expect(rateLimitHints("Too many requests")).toEqual({});
  });

  it("does not retry a daily quota, and names the quota without leaking the key", async () => {
    const request = vi.fn(async () => tooMany("Day"));
    vi.stubGlobal("fetch", request);
    const error = await invokeLLM({ messages: [{ role: "user", content: "hi" }] }).catch((e: unknown) => e);
    expect(request).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(LlmHttpError);
    expect(error).toMatchObject({ status: 429, quotaWindow: "day", retryAfterMs: 41_000 });
    const message = (error as Error).message;
    expect(message).toContain("RESOURCE_EXHAUSTED [quota GenerateRequestsPerDayPerProjectPerModel-FreeTier]");
    expect(message).not.toContain(KEY);
  });

  it("leaves retries to the caller when maxRetries is 0", async () => {
    const request = vi.fn(async () => tooMany("Minute"));
    vi.stubGlobal("fetch", request);
    const error = await invokeLLM({ messages: [{ role: "user", content: "hi" }], maxRetries: 0 }).catch((e: unknown) => e);
    expect(request).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: 429, quotaWindow: "minute", retryAfterMs: 41_000 });
  });
});
