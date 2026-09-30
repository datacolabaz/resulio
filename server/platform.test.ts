import { afterEach, describe, expect, it, vi } from "vitest";
import { publicPlatformConfig, publicPlatformScript } from "./_core/publicConfig";
import { listLLMModels } from "./_core/llm";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("platform integration", () => {
  it("exposes only named public runtime configuration", () => {
    const env = { MANUS_PROJECT_ID: "project-test", MANUS_API_KEY: "server-only-test", SESSION_SECRET: "signing-only-test", DATABASE_URL: "db-only-test", GOOGLE_CLIENT_SECRET: "google-secret-test", MANUS_API_BROWSER_KEY: "public-browser-test", MANUS_ANALYTICS_ENDPOINT: "https://analytics.example", MANUS_ANALYTICS_WEBSITE_ID: "site-test" };
    const script = publicPlatformScript(env);
    for (const value of [env.MANUS_API_KEY, env.SESSION_SECRET, env.DATABASE_URL, env.GOOGLE_CLIENT_SECRET]) {
      expect(script).not.toContain(value);
      expect(JSON.stringify(publicPlatformConfig(env))).not.toContain(value);
    }
    const appended: unknown[] = [];
    const fakeDocument = { createElement: () => ({ setAttribute() {} }), head: { appendChild: (node: unknown) => appended.push(node) } };
    new Function("window", "document", script)({}, fakeDocument);
    new Function("window", "document", publicPlatformScript({}))({}, fakeDocument);
    expect(appended).toHaveLength(0);
  });
  it("does not guess a production LLM API when none is configured", async () => {
    vi.stubEnv("MANUS_API_URL", ""); vi.stubEnv("MANUS_API_KEY", "test-only");
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    await expect(listLLMModels()).rejects.toThrow("MANUS_API_URL");
    expect(request).not.toHaveBeenCalled();
  });
});
