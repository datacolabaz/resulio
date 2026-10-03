// Kept free of imports so env.ts can depend on it; same trimming as envString in env.ts.
function envString(key: string, env: NodeJS.ProcessEnv): string {
  return (env[key] ?? "").trim().replace(/^['"]|['"]$/g, "").trim();
}

export const DEFAULT_AI_API_URL = "https://api.openai.com";
export const DEFAULT_AI_MODEL = "gpt-4o-mini";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export type LlmConfig = {
  /** "ai" = AI_API_* vars, "manus" = MANUS_API_* fallback, null = AI disabled. */
  source: "ai" | "manus" | null;
  baseUrl: string;
  apiKey: string;
  /** Empty = let the provider pick its default model. */
  model: string;
};

function defaultModelFor(baseUrl: string): string {
  try {
    if (new URL(baseUrl).hostname.endsWith("generativelanguage.googleapis.com")) return DEFAULT_GEMINI_MODEL;
  } catch {
    // fall through
  }
  return DEFAULT_AI_MODEL;
}

/**
 * Chat-completions provider. AI_API_KEY switches to the standalone AI_* settings (URL defaults to
 * OpenAI); otherwise the MANUS_API_* pair is used. File storage never goes through this.
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const aiKey = envString("AI_API_KEY", env);
  const aiModel = envString("AI_MODEL", env);
  if (aiKey) {
    const baseUrl = envString("AI_API_URL", env) || DEFAULT_AI_API_URL;
    return { source: "ai", baseUrl, apiKey: aiKey, model: aiModel || defaultModelFor(baseUrl) };
  }
  const manusUrl = envString("MANUS_API_URL", env);
  const manusKey = envString("MANUS_API_KEY", env);
  if (manusUrl && manusKey) return { source: "manus", baseUrl: manusUrl, apiKey: manusKey, model: aiModel };
  return { source: null, baseUrl: manusUrl, apiKey: manusKey, model: aiModel };
}

/**
 * Joins an OpenAI-style path ("chat/completions", "models", ...) onto a base URL. Bases that
 * already carry a version segment (…/v1, …/v1beta/openai, …/openai/v1) are used as-is; bare hosts
 * get "/v1". A pasted full endpoint such as ".../v1/chat/completions" is trimmed back first.
 */
export function openAiEndpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl.trim());
  let base = url.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|completions|models|audio\/transcriptions)$/i, "");
  if (!/\/v\d+[a-z0-9]*(\/|$)/i.test(base)) base += "/v1";
  url.pathname = `${base}/${path.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
