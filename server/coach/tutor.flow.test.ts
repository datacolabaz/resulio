import { getTableName, type Table } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvokeParams, InvokeResult } from "../_core/llm";

/** In-memory tables; `where`/`orderBy` are ignored, so each test keeps to one thread. */
const h = vi.hoisted(() => ({ tables: new Map<string, Record<string, unknown>[]>(), invoke: null as unknown as (p: InvokeParams) => Promise<InvokeResult> }));

vi.mock("../db", () => {
  const rowsOf = (t: Table) => {
    const name = getTableName(t);
    if (!h.tables.has(name)) h.tables.set(name, []);
    return h.tables.get(name)!;
  };
  const query = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    Object.assign(q, { where: () => q, orderBy: () => q, limit: () => q, then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows()).then(res, rej) });
    return q;
  };
  const db = {
    select: () => ({ from: (t: Table) => query(() => [...rowsOf(t)]) }),
    insert: (t: Table) => ({ values: async (v: Record<string, unknown> | Record<string, unknown>[]) => void rowsOf(t).push(...(Array.isArray(v) ? v : [v])) }),
    update: (t: Table) => ({ set: (v: Record<string, unknown>) => ({ where: async () => rowsOf(t).forEach((r) => Object.assign(r, v)) }) }),
    delete: (t: Table) => ({ where: async () => void rowsOf(t).splice(0) }),
  };
  return { requireDb: () => db };
});
vi.mock("../_core/llm", async (orig) => ({ ...(await orig<typeof import("../_core/llm")>()), invokeLLM: (p: InvokeParams) => h.invoke(p) }));
vi.mock("./examLock", () => ({ assertNotInExam: async () => undefined }));
vi.mock("./quota", async (orig) => ({
  ...(await orig<typeof import("./quota")>()),
  assertCoachAiAllowed: async () => undefined,
  assertDailyCap: async () => undefined,
  coachLimits: async () => ({ tutorPerDay: 0 }),
  countEvents: async () => 0,
}));
vi.mock("./models", () => ({ coachModels: async () => ({ main: "main-m", lite: "lite-m", pro: "pro-m", ocr: "ocr-m" }) }));
vi.mock("./store", async (orig) => ({ ...(await orig<typeof import("./store")>()), logEvent: async () => undefined, settingsOf: async () => ({ recallMode: "NORMAL" }) }));
vi.mock("./materials", async (orig) => ({ ...(await orig<typeof import("./materials")>()), ownedMaterial: async () => ({ id: "m1", status: "READY" }) }));
vi.mock("./packs", async (orig) => ({
  ...(await orig<typeof import("./packs")>()),
  ownedTopic: async () => ({ id: "t1", materialId: "m1", title: "Prosessor" }),
  topicChunks: async () => [{ id: "c1", ord: 0, pageFrom: 3, pageTo: 3, heading: "", text: "Prosessor əmrləri yaddaşdan oxuyur, deşifrə edir və icra edir. Bu dövr hər əmr üçün təkrarlanır." }],
}));

const QUOTE = "Prosessor əmrləri yaddaşdan oxuyur, deşifrə edir və icra edir";
const llm = (content: unknown, model = "main-m"): InvokeResult => ({
  id: "x",
  created: 1,
  model,
  choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
});
const answer = (content: unknown, model?: string) => {
  const fn = vi.fn(async (_p: InvokeParams) => llm(content, model));
  h.invoke = fn;
  return fn;
};
const systemOf = (fn: ReturnType<typeof answer>) => String(fn.mock.calls[0][0].messages[0].content);
const rows = (name: string) => h.tables.get(name) ?? [];

async function ask(action: "ASK" | "SIMPLE" | "EXAMPLE" | "QUIZ_ME", text = "", threadId?: string) {
  const { ask } = await import("./tutor");
  return ask(7, { topicId: "t1", threadId, action, text, locale: "az" });
}

beforeAll(async () => {
  await import("./tutor");
}, 60_000);

beforeEach(() => {
  h.tables.clear();
  vi.stubEnv("AI_API_KEY", "k");
  vi.stubEnv("AI_API_URL", "https://example.test/v1/");
});

describe("tutor modes, end to end", () => {
  it.each([
    ["CLARIFY", "ASK", "Prosessor nə edir?", "Answer the question clearly"],
    ["HINT", "ASK", "2 + 3 = ? hesablayın", "Do NOT give the final answer"],
    ["EXPLAIN", "SIMPLE", "", "Explain step by step"],
    ["EXAMPLE", "EXAMPLE", "", "worked example"],
    ["CHECK", "QUIZ_ME", "", "exactly ONE short open question"],
  ] as const)("%s: the rule reaches the model and the reply is stored as plain data", async (mode, action, text, rule) => {
    const fn = answer({ reply: "Cavab.", grounding: "MATERIAL", cites: [{ chunk: "C1", quote: QUOTE }] });
    const thread = await ask(action, text);
    expect(systemOf(fn)).toContain(rule);
    const bot = thread.messages[1];
    expect(bot).toMatchObject({ role: "ASSISTANT", mode, content: "Cavab.", grounding: "MATERIAL", recall: false });
    expect(bot.cites).toEqual([{ chunkId: "c1", page: 3, quote: QUOTE }]);
    expect(thread.messages[0]).toMatchObject({ role: "USER", action, content: text, cites: [] });
  });

  it("CHECK → the student's typed answer is evaluated against the question", async () => {
    answer({ reply: "Prosessor əmrlə nə edir?", grounding: "MATERIAL", cites: [] });
    const first = await ask("QUIZ_ME");
    expect(first.messages[1].mode).toBe("CHECK");
    const fn = answer({ reply: "Qismən düzgündür: oxuyur və icra edir, amma deşifrəni unutdunuz.", grounding: "MATERIAL", cites: [{ chunk: "C1", quote: QUOTE }] });
    const second = await ask("ASK", "oxuyur və icra edir", first.id);
    expect(systemOf(fn)).toContain("their answer");
    const sent = fn.mock.calls[0][0].messages.map((m) => String(m.content)).join("\n");
    expect(sent).toContain("Prosessor əmrlə nə edir?");
    expect(second.messages.map((m) => m.mode)).toEqual([null, "CHECK", null, "EVALUATE"]);
    expect(second.messages[3].content).toMatch(/^Qismən düzgündür/);
  });

  it("RECALL: an open mistake is asked again after a few replies", async () => {
    h.tables.set("coach_threads", [{ id: "th1", studentId: 7, topicId: "t1", materialId: "m1", title: "x", messageCount: 6, lastMessageAt: new Date() }]);
    h.tables.set(
      "coach_messages",
      Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, threadId: "th1", role: i % 2 ? "ASSISTANT" : "USER", action: "ASK", mode: i % 2 ? "CLARIFY" : null, content: `m${i}`, cites: [], grounding: "MATERIAL", recall: null, createdAt: new Date(i) })),
    );
    h.tables.set("coach_mistakes", [{ question: "Deşifrə nədir?" }]);
    const fn = answer({ reply: "Cavab. Deşifrəni xatırlayırsınız?", grounding: "MIXED", cites: [] });
    const thread = await ask("ASK", "Yaddaş nədir?", "th1");
    expect(systemOf(fn)).toContain("recall this earlier mistake");
    expect(thread.messages.at(-1)).toMatchObject({ recall: true, mode: "CLARIFY" });
  });
});

describe("tutor output that does not follow the schema", () => {
  it("NOT_FOUND stays NOT_FOUND, even with quotes", async () => {
    answer({ reply: "Bu mövzudan kənardır.", grounding: "NOT_FOUND", cites: [{ chunk: "C1", quote: QUOTE }] });
    expect((await ask("ASK", "Futbol?")).messages[1].grounding).toBe("NOT_FOUND");
  });

  it("empty or missing cites", async () => {
    answer({ reply: "Cavab.", grounding: "MATERIAL", cites: [] });
    expect((await ask("ASK", "Nə?")).messages[1]).toMatchObject({ cites: [], grounding: "MIXED" });
    h.tables.clear();
    answer({ reply: "Cavab." });
    expect((await ask("ASK", "Nə?")).messages[1]).toMatchObject({ cites: [], grounding: "GENERAL" });
  });

  it("a question object, cites as one object, a lower-case grounding, fenced JSON", async () => {
    answer("```json\n" + JSON.stringify({ reply: { question: "Prosessor nə edir?" }, grounding: "material", cites: { chunk: "C1", quote: QUOTE } }) + "\n```");
    const bot = (await ask("QUIZ_ME")).messages[1];
    expect(bot).toMatchObject({ mode: "CHECK", content: "Prosessor nə edir?", grounding: "MATERIAL" });
    expect(bot.cites).toHaveLength(1);
  });

  it("the text under another key and an unknown grounding", async () => {
    answer({ question: "Əmr dövrü nədir?", grounding: "BOOK", cites: "C1" });
    expect((await ask("QUIZ_ME")).messages[1]).toMatchObject({ content: "Əmr dövrü nədir?", grounding: "GENERAL", cites: [] });
  });

  it.each([["not json at all <html>"], [JSON.stringify({ grounding: "MATERIAL", cites: [] })], [JSON.stringify({ reply: "   " })], ['{"reply": ']])("unusable output %s fails cleanly and stores nothing", async (content) => {
    answer(content);
    await expect(ask("ASK", "Nə?")).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(rows("coach_messages")).toHaveLength(0);
    expect(rows("coach_threads")).toHaveLength(0);
  });

  it("a long model name fits the column", async () => {
    answer({ reply: "Cavab.", grounding: "GENERAL", cites: [] }, "m".repeat(150));
    await ask("ASK", "Nə?");
    expect(String(rows("coach_messages")[1].model)).toHaveLength(100);
  });
});
