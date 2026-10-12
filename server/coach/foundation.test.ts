import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { coachLocaleOf, coachTopicKey, materialStage } from "../../shared/coach";
import { isCoachFeature } from "../../shared/aiUsage";
import { LlmHttpError, type InvokeParams, type InvokeResult } from "../_core/llm";
import { AppError } from "../modules/errors";
import { generateStructured, languageRule, materialBlock } from "./ai";
import { decideFromRows, envEnablesCoach } from "./availability";
import { resolveCoachModels } from "./models";
import { coachLimitValue, mergeLimits } from "./quota";

const reply = (content: string): InvokeResult => ({ id: "x", created: 0, model: "m-test", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

describe("coach availability", () => {
  it("env lists turn the coach on by user, workspace or *", () => {
    expect(envEnablesCoach(7, [], ["7"], [])).toBe(true);
    expect(envEnablesCoach(7, [], ["*"], [])).toBe(true);
    expect(envEnablesCoach(7, ["ws1"], [], ["ws1"])).toBe(true);
    expect(envEnablesCoach(7, [], [], ["*"])).toBe(true);
    expect(envEnablesCoach(7, ["ws2"], ["8"], ["ws1"])).toBe(false);
  });
  it("a user override wins; otherwise any workspace override, then the global flag", () => {
    expect(decideFromRows({ userOverride: false, workspaceOverrides: [true], global: true })).toBe(false);
    expect(decideFromRows({ userOverride: true, workspaceOverrides: [], global: false })).toBe(true);
    expect(decideFromRows({ userOverride: null, workspaceOverrides: [false, true], global: false })).toBe(true);
    expect(decideFromRows({ userOverride: null, workspaceOverrides: [], global: false })).toBe(false);
    expect(decideFromRows({ userOverride: null, workspaceOverrides: [], global: true })).toBe(true);
  });
});

describe("coach models", () => {
  it("platform setting beats env beats the default model; roles fall back to main", () => {
    expect(resolveCoachModels({}, null, "base")).toEqual({ main: "base", lite: "base", pro: "base", ocr: "base" });
    expect(resolveCoachModels({ main: "env-main", lite: "env-lite" }, null, "base")).toEqual({ main: "env-main", lite: "env-lite", pro: "env-main", ocr: "env-main" });
    expect(resolveCoachModels({ main: "env-main", pro: "env-pro" }, { main: "set-main", pro: " " }, "base")).toEqual({ main: "set-main", lite: "set-main", pro: "env-pro", ocr: "set-main" });
  });
});

describe("coach quota values", () => {
  it("null setting = beta default, 0 = unlimited, override wins", () => {
    expect(coachLimitValue(null, 500_000, null)).toBe(500_000);
    expect(coachLimitValue(0, 500_000, null)).toBeNull();
    expect(coachLimitValue(1000, 500_000, null)).toBe(1000);
    expect(coachLimitValue(1000, 500_000, 0)).toBeNull();
    expect(coachLimitValue(1000, 500_000, 50)).toBe(50);
  });
  it("partial limits merge over the defaults", () => {
    const merged = mergeLimits({ uploadsPerDay: 2 });
    expect(merged.uploadsPerDay).toBe(2);
    expect(merged.tutorPerDay).toBe(40);
    expect(merged.ocrPagesPerMaterial).toBe(30);
    expect(merged.ocrPagesPerMonth).toBe(200);
    expect(mergeLimits(null).uploadsPerDay).toBe(5);
  });
  it("only COACH_* features count against the student quota", () => {
    expect(isCoachFeature("COACH_TUTOR")).toBe(true);
    expect(isCoachFeature("QUESTION_GENERATE")).toBe(false);
  });
});

describe("shared coach helpers", () => {
  it("maps the internal statuses onto the three student stages", () => {
    expect(materialStage("QUEUED")).toBe("CHECKING");
    expect(materialStage("EXTRACTING")).toBe("PROCESSING");
    expect(materialStage("SEGMENTING")).toBe("PROCESSING");
    expect(materialStage("READY")).toBe("READY");
    expect(materialStage("FAILED")).toBe("FAILED");
  });
  it("coach topic keys live in their own namespace", () => {
    expect(coachTopicKey("abc")).toBe("cx:abc");
  });
  it("unknown locales fall back to az", () => {
    expect(coachLocaleOf("ru")).toBe("ru");
    expect(coachLocaleOf("de")).toBe("az");
    expect(coachLocaleOf(null)).toBe("az");
  });
});

describe("prompt language", () => {
  it("names the student's app language and keeps quotes verbatim", () => {
    expect(languageRule("en")).toContain("English");
    expect(languageRule("ru")).toContain("Russian");
    expect(languageRule("az")).toContain("Azerbaijani");
    expect(languageRule("ru")).toMatch(/verbatim/);
  });
  it("labels chunks with id and pages inside nonce markers", () => {
    const block = materialBlock([{ id: "c1", pageFrom: 2, pageTo: 3, heading: "Giriş", text: "Mətn" }], "N0NCE");
    expect(block).toContain("<<<MATERIAL-N0NCE>>>");
    expect(block).toContain("[chunk c1 | pp.2-3 | Giriş]");
    expect(block).toContain("<<<END-MATERIAL-N0NCE>>>");
  });
});

describe("generateStructured", () => {
  const schema = z.object({ title: z.string() });
  const jsonSchema = { name: "t", schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } };

  it("asks for the JSON schema and validates the reply", async () => {
    const invoke = vi.fn(async (_p: InvokeParams) => reply('```json\n{"title":"Salam"}\n```'));
    const out = await generateStructured({ model: "m", messages: [{ role: "user", content: "x" }], schema, jsonSchema, invoke });
    expect(out.data.title).toBe("Salam");
    expect(invoke.mock.calls[0][0].outputSchema?.name).toBe("t");
  });

  it("retries once in plain JSON mode when the schema is refused", async () => {
    const invoke = vi
      .fn<(p: InvokeParams) => Promise<InvokeResult>>()
      .mockRejectedValueOnce(new LlmHttpError(400, "LLM invoke failed: 400 Bad Request – schema not supported"))
      .mockResolvedValueOnce(reply('{"title":"ok"}'));
    const out = await generateStructured({ model: "m", messages: [], schema, jsonSchema, invoke });
    expect(out.data.title).toBe("ok");
    expect(invoke.mock.calls[1][0].responseFormat).toEqual({ type: "json_object" });
  });

  it("rejects output that does not match the schema", async () => {
    const invoke = vi.fn(async () => reply('{"name":1}'));
    await expect(generateStructured({ model: "m", messages: [], schema, jsonSchema, invoke })).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  });

  it("maps provider rate limits to COACH_AI_BUSY", async () => {
    const invoke = vi.fn(async () => {
      throw new LlmHttpError(429, "LLM invoke failed: 429 Too Many Requests");
    });
    const err = await generateStructured({ model: "m", messages: [], schema, jsonSchema, invoke }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("COACH_AI_BUSY");
  });
});
