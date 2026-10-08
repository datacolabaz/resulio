import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syllabusImportStructureSchema } from "../shared/syllabusImport";
import { LlmHttpError } from "./_core/llm";
import { AI_ENGINEERING_MODULE_DETAILS } from "./syllabus/content/aiEngineeringModuleDetails";
import { coerceModule, normalizeStructure, parseImportOutput, parseJsonLoose, repairTruncatedJson } from "./syllabus/importExtraction";
import { extractFromText, ImportFailure, type Ask, type AskReply, type AskRequest } from "./syllabus/importPipeline";
import { cleanLine, cleanTitle, findModuleSections, parseHeaderLocally } from "./syllabus/importText";

/**
 * The pasted AI Engineering syllabus as a teacher copies it from a chat (emojis, single-asterisk
 * bold, "---" rules and a trailing note to the platform), read with a fake model.
 */

const FIXTURES = join(__dirname, "syllabus", "__fixtures__");
const RAW_PASTE = readFileSync(join(FIXTURES, "ai-engineering-raw-paste.md"), "utf8");
const SOURCE_MD = readFileSync(join(FIXTURES, "ai-engineering-syllabus.md"), "utf8").replace(/\r\n/g, "\n");
const AI = JSON.parse(readFileSync(join(FIXTURES, "ai-engineering-import.ai.json"), "utf8")) as {
  syllabus: Record<string, unknown>;
  modules: Array<Record<string, unknown> & { lessons: string[] }>;
};

/** Ground truth from the clean markdown: module titles and the topics under "### Mövzular". */
const SOURCE = SOURCE_MD.split(/\n## /)
  .slice(1)
  .map((block) => {
    const [title, ...rest] = block.split("\n");
    const topics: string[] = [];
    let inTopics = false;
    for (const line of rest) {
      if (line.startsWith("### ")) inTopics = line.trim() === "### Mövzular";
      else if (inTopics && line.startsWith("- ")) topics.push(line.slice(2).trim());
    }
    return { title: title.trim(), topics };
  });

const reply = (content: string, finishReason: string | null = "stop"): AskReply => ({ content, finishReason });
const userText = (req: AskRequest) => JSON.stringify(req.messages[1].content);
const moduleIndex = (req: AskRequest) => Number(/Module (\d+) of/.exec(userText(req))?.[1] ?? 0) - 1;

/** A model that answers each request like a real one would (module replies in the fixture's quirky shape). */
function fakeAsk(override?: (req: AskRequest, calls: number) => AskReply | Error | undefined) {
  const calls: AskRequest[] = [];
  const ask: Ask = async (req) => {
    calls.push(req);
    const custom = override?.(req, calls.filter((c) => c.label === req.label).length);
    if (custom instanceof Error) throw custom;
    if (custom) return custom;
    if (req.kind === "header") return reply(JSON.stringify(AI.syllabus));
    const i = moduleIndex(req);
    if (i >= AI.modules.length) return reply(JSON.stringify({ isModule: false }));
    return reply(JSON.stringify({ isModule: true, ...AI.modules[i] }));
  };
  return { ask, calls };
}

async function read(ask: Ask) {
  const result = await extractFromText(RAW_PASTE, { ask, nonce: () => "n" });
  return { ...result, s: normalizeStructure(result.raw, "")! };
}

describe("the raw pasted AI Engineering syllabus", () => {
  it("is split into its 9 month sections plus the trailing note, titles without emojis", () => {
    const plan = findModuleSections(RAW_PASTE)!;
    expect(plan.sections.map((s) => s.title)).toEqual([...SOURCE.map((m) => m.title), "Vacib UI tələbi"]);
    expect(plan.sections.map((s) => s.numbered)).toEqual([...Array(9).fill(true), false]);
    expect(parseHeaderLocally(plan.preamble)).toMatchObject({ title: "AI ENGINEER – 9 AYLIQ PRAKTİK PROQRAM", durationLabel: "9 ay", language: "az" });
  });

  it("is read module by module into 9 modules with their lessons, projects, blocks and timing", async () => {
    const { ask, calls } = fakeAsk();
    const { s, localModules } = await read(ask);
    expect(calls.map((c) => c.kind)).toEqual(["header", ...Array(10).fill("module")]);
    expect(localModules).toEqual([]);
    expect(s.title).toBe("AI ENGINEER – 9 AYLIQ PRAKTİK PROQRAM");
    expect(s.modules.map((m) => m.title)).toEqual(SOURCE.map((m) => m.title));
    s.modules.forEach((m, i) => {
      expect(m.lessons.map((l) => l.title)).toEqual(SOURCE[i].topics);
      expect(m.details).toEqual(AI_ENGINEERING_MODULE_DETAILS[i].details);
    });
    expect(s.modules[2].projects.map((p) => p.title)).toEqual(["House Price Prediction", "Customer Churn Prediction", "Customer Segmentation"]);
    expect(s.modules[8].projectsHeading).toBe("Final Project");
    expect(s.timing).toEqual({ duration: { value: 9, unit: "MONTHS" }, lessonsPerWeek: 2, lessonMinutes: null });
    expect(s.modules.map((m) => m.duration)).toEqual(Array(9).fill({ value: 1, unit: "MONTHS" }));
    expect(syllabusImportStructureSchema.safeParse(s).success).toBe(true);
  });

  it("sends each module alone, small enough for any output limit", async () => {
    const { ask, calls } = fakeAsk();
    await read(ask);
    for (const c of calls.filter((x) => x.kind === "module")) {
      const text = userText(c);
      expect(text.length).toBeLessThan(4_000);
      expect((text.match(/AY —/g) ?? []).length).toBeLessThanOrEqual(2);
    }
    expect(userText(calls.find((c) => moduleIndex(c) === 2)!)).toContain("House Price Prediction");
    expect(userText(calls.find((c) => moduleIndex(c) === 2)!)).not.toContain("Customer Support");
  });

  it("is still read completely when every model reply is unreadable (from the text's own structure)", async () => {
    const { ask } = fakeAsk(() => reply("Sorry, I cannot help with that."));
    const { s, localModules, problem } = await read(ask);
    expect(localModules).toEqual(SOURCE.map((m) => m.title));
    expect(problem?.code).toBe("AI_OUTPUT");
    expect(problem?.detail).toContain("finish_reason=stop");
    expect(problem?.detail).toContain("starts: Sorry, I cannot help");
    expect(s.modules.map((m) => m.title)).toEqual(SOURCE.map((m) => m.title));
    s.modules.forEach((m, i) => {
      expect(m.lessons.map((l) => l.title)).toEqual(SOURCE[i].topics);
      expect(m.details).toEqual(AI_ENGINEERING_MODULE_DETAILS[i].details);
    });
    expect(s.modules[0].projects).toEqual([{ title: "Python əsaslı mini tətbiq", description: "" }]);
    expect(s.modules[8].projects[0].description).toContain("- AI Research Assistant");
    expect(s.description).toContain("Müddət: 9 ay");
    expect(s.timing).toEqual({ duration: { value: 9, unit: "MONTHS" }, lessonsPerWeek: 2, lessonMinutes: null });
    expect(s.modules.map((m) => m.duration)).toEqual(Array(9).fill({ value: 1, unit: "MONTHS" }));
  });

  it("retries a reply cut off by the output limit, and fills a twice-cut reply from the text", async () => {
    const full = JSON.stringify({ isModule: true, ...AI.modules[3] });
    const once = fakeAsk((req, n) => (moduleIndex(req) === 3 && n === 1 ? reply(full.slice(0, 400), "length") : undefined));
    const a = await read(once.ask);
    expect(once.calls.filter((c) => c.kind === "module" && moduleIndex(c) === 3)).toHaveLength(2);
    expect(a.s.modules[3].lessons.map((l) => l.title)).toEqual(SOURCE[3].topics);

    const twice = fakeAsk((req) => (moduleIndex(req) === 3 && req.kind === "module" ? reply(full.slice(0, 300), "length") : undefined));
    const b = await read(twice.ask);
    expect(b.localModules).toEqual([]);
    expect(b.s.modules[3].lessons.length).toBeGreaterThan(0);
    expect(b.s.modules[3].details).toEqual(AI_ENGINEERING_MODULE_DETAILS[3].details);
  });

  it("accepts fenced, wrapped, commented and oddly typed replies", async () => {
    const m = AI.modules;
    const quirks: Record<number, string> = {
      0: "```json\n" + JSON.stringify(m[0]) + "\n```",
      1: "Here is the module {as requested}:\n" + JSON.stringify({ module: m[1] }),
      2: JSON.stringify({ modules: [{ ...m[2], extra: { foo: 1 }, minutes: null }] }),
      3: JSON.stringify({ ...m[3], objectives: (m[3].objectives as string[]).join("\n"), assessment: null, prerequisites: null }),
      4: JSON.stringify(m[4]).replace(/","/, '",\n"').replace(/]}$/, "],}"),
    };
    const { ask } = fakeAsk((req) => (req.kind === "module" && quirks[moduleIndex(req)] !== undefined ? reply(quirks[moduleIndex(req)]) : undefined));
    const { s, localModules } = await read(ask);
    expect(localModules).toEqual([]);
    expect(s.modules.slice(0, 5).map((x, i) => x.lessons.map((l) => l.title))).toEqual(SOURCE.slice(0, 5).map((x) => x.topics));
    expect(s.modules[3].details.objectives).toEqual(AI_ENGINEERING_MODULE_DETAILS[3].details.objectives);
    expect(s.modules[3].details.prerequisites).toEqual([]);
  });

  it("fails with the provider's reason for a bad key, and stops asking after a quota error", async () => {
    const bad = fakeAsk(() => new LlmHttpError(401, "LLM invoke failed: 401 Unauthorized"));
    await expect(read(bad.ask)).rejects.toMatchObject({ code: "AI_KEY_INVALID" });
    await expect(read(bad.ask)).rejects.toBeInstanceOf(ImportFailure);

    const quota = fakeAsk((req) => (req.kind === "module" ? new LlmHttpError(429, "quota") : undefined));
    const { s, localModules, problem } = await extractFromText(RAW_PASTE, { ask: quota.ask, concurrency: 1 }).then((r) => ({ ...r, s: normalizeStructure(r.raw, "")! }));
    expect(quota.calls.filter((c) => c.kind === "module")).toHaveLength(1);
    expect(localModules).toHaveLength(9);
    expect(problem?.code).toBe("AI_QUOTA");
    expect(s.modules).toHaveLength(9);
  });

  it("reads a time-out module from the text and records why", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const { ask } = fakeAsk((req) => (moduleIndex(req) === 5 ? timeout : undefined));
    const { s, localModules, problem } = await read(ask);
    expect(localModules).toEqual([SOURCE[5].title]);
    expect(problem).toMatchObject({ code: "AI_TIMEOUT" });
    expect(problem?.detail).toContain("module 6");
    expect(s.modules[5].lessons.map((l) => l.title)).toEqual(SOURCE[5].topics);
  });
});

describe("text without module headings", () => {
  const plain = Array.from({ length: 40 }, (_, i) => `Bu kursun ${i + 1}-ci paraqrafıdır və burada mövzular ardıcıl izah olunur.`).join("\n\n");

  it("is read in parts, and a part cut off by the output limit is read again in halves", async () => {
    const calls: string[] = [];
    const ask: Ask = async (req) => {
      calls.push(req.label);
      if (calls.length === 1) return reply('{"syllabus":{"title":"Kurs"},"modules":[{"title":"Giriş","lessons":["A","B"', "length");
      return reply(JSON.stringify({ syllabus: { title: "Kurs" }, modules: [{ title: `Hissə ${calls.length}`, lessons: ["X"] }] }));
    };
    const { raw } = await extractFromText(plain, { ask });
    expect(calls[0]).toBe("part 1/1");
    expect(calls.slice(1).every((l) => l.includes("split 1"))).toBe(true);
    expect(raw.modules.map((m) => m.title)).toEqual(calls.slice(1).map((_, i) => `Hissə ${i + 2}`));
  });

  it("fails with a technical reason when a small part stays unreadable", async () => {
    const ask: Ask = async () => reply("not json", "stop");
    await expect(extractFromText("Bir neçə sətir mətn.\nDaha bir sətir.", { ask })).rejects.toMatchObject({ code: "AI_OUTPUT", detail: expect.stringContaining("no JSON object") });
  });
});

describe("reading model replies leniently", () => {
  it("repairs JSON cut off mid-way up to its last complete value", () => {
    expect(JSON.parse(repairTruncatedJson('{"a":[1,2,{"b":"x"},{"c":"ha')!)).toEqual({ a: [1, 2, { b: "x" }, {}] });
    expect(JSON.parse(repairTruncatedJson('{"modules":[{"title":"M1","lessons":["A","B"]},{"title":"M2","less')!)).toEqual({ modules: [{ title: "M1", lessons: ["A", "B"] }, { title: "M2" }] });
    expect(parseJsonLoose('{"t":"a\\"b')).toEqual({ value: {}, repaired: true });
  });

  it("skips thinking text, fences and raw line breaks", () => {
    expect(parseJsonLoose('Thinking {about it}...\n{"a": 1}')?.value).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a": "line1\nline2",}\n```')?.value).toEqual({ a: "line1\nline2" });
    expect(parseJsonLoose("no json here")).toBeNull();
  });

  it("finds the module list wherever the model put it", () => {
    const m = { title: "Modul 1", lessons: ["A"] };
    expect(parseImportOutput(JSON.stringify({ syllabus: { title: "K", modules: [m] } }))?.modules[0].title).toBe("Modul 1");
    expect(parseImportOutput(JSON.stringify({ result: { modules: [m] } }))?.modules).toHaveLength(1);
    expect(parseImportOutput(JSON.stringify([m]))?.modules).toHaveLength(1);
  });

  it("never drops a module for a wrong type", () => {
    const m = coerceModule({ name: "Modul 2", lessons: [{ topic: "A", minutes: "45" }, null, 7], projects: "Layihə", objectives: "a\nb", assessment: ["x"], isModule: "false" });
    expect(m).toMatchObject({ title: "Modul 2", isModule: false, objectives: ["a", "b"], projects: [{ title: "Layihə", description: "" }] });
    expect(m.lessons.map((l) => l.title)).toEqual(["A", "", "7"]);
    expect(m.assessment.items).toEqual(["x"]);
  });
});

describe("cleaning pasted titles and lines", () => {
  it("drops emojis, heading marks and single- or double-asterisk emphasis, keeping the words", () => {
    expect(cleanTitle("## 🔹 1-ci AY — Python & Programming Fundamentals")).toBe("1-ci AY — Python & Programming Fundamentals");
    expect(cleanTitle("### 🎯 *Məqsədlər*")).toBe("Məqsədlər");
    expect(cleanTitle("# 🤖 AI ENGINEER – 9 AYLIQ PRAKTİK PROQRAM")).toBe("AI ENGINEER – 9 AYLIQ PRAKTİK PROQRAM");
    expect(cleanLine("*Müddət:* 9 ay")).toBe("Müddət: 9 ay");
    expect(cleanLine("- **Python** fundamentals")).toBe("Python fundamentals");
    expect(cleanLine("snake_case_name stays")).toBe("snake_case_name stays");
    expect(cleanLine("2 * 3 * 4")).toBe("2 * 3 * 4");
  });
});
