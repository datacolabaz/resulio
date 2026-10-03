import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_API_URL, DEFAULT_AI_MODEL, DEFAULT_GEMINI_MODEL, openAiEndpoint, resolveLlmConfig } from "./aiConfig";
import { ENV } from "./env";
import { invokeLLM } from "./llm";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("resolveLlmConfig", () => {
  it("is disabled when nothing is set", () => {
    expect(resolveLlmConfig({}).source).toBeNull();
    expect(resolveLlmConfig({ MANUS_API_URL: "https://forge.example" }).source).toBeNull();
    expect(resolveLlmConfig({ AI_API_URL: "https://api.openai.com/v1" }).source).toBeNull();
  });

  it("defaults to OpenAI and a cheap model when only AI_API_KEY is set", () => {
    expect(resolveLlmConfig({ AI_API_KEY: "sk-test" })).toEqual({ source: "ai", baseUrl: DEFAULT_AI_API_URL, apiKey: "sk-test", model: DEFAULT_AI_MODEL });
  });

  it("uses AI_API_URL and AI_MODEL, trimming pasted quotes", () => {
    const config = resolveLlmConfig({ AI_API_KEY: ' "key" ', AI_API_URL: " https://api.groq.com/openai/v1 ", AI_MODEL: "llama-3.1-8b-instant" });
    expect(config).toEqual({ source: "ai", baseUrl: "https://api.groq.com/openai/v1", apiKey: "key", model: "llama-3.1-8b-instant" });
  });

  it("picks a Gemini default model for the Gemini endpoint", () => {
    const config = resolveLlmConfig({ AI_API_KEY: "g", AI_API_URL: "https://generativelanguage.googleapis.com/v1beta/openai/" });
    expect(config.model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("prefers AI_* over MANUS_* and falls back to MANUS_* otherwise", () => {
    const manus = { MANUS_API_URL: "https://forge.example", MANUS_API_KEY: "m" };
    expect(resolveLlmConfig({ ...manus, AI_API_KEY: "a" })).toMatchObject({ source: "ai", apiKey: "a" });
    expect(resolveLlmConfig(manus)).toEqual({ source: "manus", baseUrl: "https://forge.example", apiKey: "m", model: "" });
    expect(resolveLlmConfig({ ...manus, AI_MODEL: "x" }).model).toBe("x");
  });
});

describe("openAiEndpoint", () => {
  it.each([
    ["https://api.openai.com", "https://api.openai.com/v1/chat/completions"],
    ["https://api.openai.com/", "https://api.openai.com/v1/chat/completions"],
    ["https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"],
    ["https://api.openai.com/v1/", "https://api.openai.com/v1/chat/completions"],
    ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"],
    ["https://generativelanguage.googleapis.com/v1beta/openai", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
    ["https://generativelanguage.googleapis.com/v1beta/openai/", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
    ["https://api.groq.com/openai/v1", "https://api.groq.com/openai/v1/chat/completions"],
    ["https://api.deepseek.com", "https://api.deepseek.com/v1/chat/completions"],
    ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/chat/completions"],
    ["http://localhost:11434/v1", "http://localhost:11434/v1/chat/completions"],
    ["https://forge.example/proxy", "https://forge.example/proxy/v1/chat/completions"],
  ])("%s", (base, expected) => {
    expect(openAiEndpoint(base, "chat/completions")).toBe(expected);
  });

  it("joins other paths the same way", () => {
    expect(openAiEndpoint("https://api.openai.com", "models")).toBe("https://api.openai.com/v1/models");
    expect(openAiEndpoint("https://generativelanguage.googleapis.com/v1beta/openai", "/models")).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
  });
});

describe("ENV wiring", () => {
  it("enables AI review from AI_API_KEY alone, unless disabled", () => {
    vi.stubEnv("MANUS_API_URL", ""); vi.stubEnv("MANUS_API_KEY", ""); vi.stubEnv("AI_API_KEY", ""); vi.stubEnv("AI_REVIEW_DISABLED", "");
    expect(ENV.aiReviewEnabled).toBe(false);
    vi.stubEnv("AI_API_KEY", "sk-test");
    expect(ENV.aiReviewEnabled).toBe(true);
    vi.stubEnv("AI_REVIEW_DISABLED", "1");
    expect(ENV.aiReviewEnabled).toBe(false);
  });

  it("keeps storage on MANUS_* even when AI_* is set", () => {
    vi.stubEnv("AI_API_KEY", "sk-test"); vi.stubEnv("AI_API_URL", "https://api.openai.com/v1");
    vi.stubEnv("MANUS_API_URL", ""); vi.stubEnv("MANUS_API_KEY", "");
    expect(ENV.forgeApiUrl).toBe("");
    expect(ENV.forgeApiKey).toBe("");
  });

  it("sends chat completions to the AI provider with its key and default model", async () => {
    vi.stubEnv("AI_API_KEY", "sk-test"); vi.stubEnv("AI_API_URL", "https://generativelanguage.googleapis.com/v1beta/openai"); vi.stubEnv("AI_MODEL", "");
    vi.stubEnv("MANUS_API_URL", "https://forge.example"); vi.stubEnv("MANUS_API_KEY", "manus-key");
    const request = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: "1", created: 0, model: "m", choices: [] }), { status: 200 }));
    vi.stubGlobal("fetch", request);
    await invokeLLM({ messages: [{ role: "user", content: "hi" }] });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(String(init.body)).model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("lets an explicit model (AI_REVIEW_MODEL path) override AI_MODEL", async () => {
    vi.stubEnv("AI_API_KEY", "sk-test"); vi.stubEnv("AI_API_URL", ""); vi.stubEnv("AI_MODEL", "gpt-4o-mini");
    const request = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: "1", created: 0, model: "m", choices: [] }), { status: 200 }));
    vi.stubGlobal("fetch", request);
    await invokeLLM({ messages: [{ role: "user", content: "hi" }], model: "gpt-4.1" });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(JSON.parse(String(init.body)).model).toBe("gpt-4.1");
  });
});
