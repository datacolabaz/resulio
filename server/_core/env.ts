import { type LlmConfig, resolveLlmConfig } from "./aiConfig";

function toOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return "";
  }
}

/** Apex ↔ www so CORS and cookies still work if the user lands on the other hostname. */
export function withWwwAliases(origins: string[]): string[] {
  const out = new Set(origins.filter(Boolean));
  for (const origin of [...out]) {
    try {
      const url = new URL(origin);
      if (url.hostname.startsWith("www.")) {
        url.hostname = url.hostname.slice(4);
        out.add(url.origin);
      } else if (url.hostname.split(".").length === 2) {
        url.hostname = `www.${url.hostname}`;
        out.add(url.origin);
      }
    } catch {
      // skip
    }
  }
  return [...out];
}

/** Parent cookie domain for split frontend/API hosts (e.g. .resulio.co). Empty = host-only. */
export function cookieDomainFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envString("COOKIE_DOMAIN", env);
  if (explicit === "none" || explicit === "off") return "";
  if (explicit) return explicit.startsWith(".") ? explicit : `.${explicit}`;
  const front = toOrigin(env.FRONTEND_URL ?? "");
  if (!front) return "";
  try {
    const host = new URL(front).hostname.replace(/^www\./i, "").toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return "";
    return `.${host}`;
  } catch {
    return "";
  }
}

/** Trim and strip wrapping quotes so pasted Cloud Console values still work. */
export function envString(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[key] ?? "";
  return raw.trim().replace(/^['"]|['"]$/g, "").trim();
}

// Values are read at use time so tests can stub them.
export const ENV = {
  get sessionSecret() { return envString("SESSION_SECRET"); },
  get databaseUrl() { return envString("DATABASE_URL"); },
  get googleClientId() { return envString("GOOGLE_CLIENT_ID"); },
  get googleClientSecret() { return envString("GOOGLE_CLIENT_SECRET"); },
  get googleConfigured() { return Boolean(this.googleClientId && this.googleClientSecret); },
  /** Optional explicit callback URL; otherwise derived from the request origin. */
  get googleRedirectUri() { return envString("GOOGLE_REDIRECT_URI").replace(/\/+$/, ""); },
  /** Optional comma-separated allowlist of emails permitted to create a Provider Workspace. Empty = open. */
  get teacherEmailAllowlist() {
    return (process.env.TEACHER_EMAIL_ALLOWLIST ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  /** Comma-separated e-mails that may hold SUPER_ADMIN. A SUPER_ADMIN role row without a match grants nothing. */
  get superAdminEmails() {
    return (process.env.SUPER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  /** Deployment environment shown to operators; NODE_ENV alone cannot tell staging from production. */
  get appEnv(): "development" | "staging" | "production" {
    const v = process.env.APP_ENV;
    if (v === "development" || v === "staging" || v === "production") return v;
    return process.env.NODE_ENV === "production" ? "production" : "development";
  },
  /** Key for hashing IP addresses in audit and security records. */
  get auditHashSecret() { return process.env.AUDIT_HASH_SECRET || process.env.SESSION_SECRET || ""; },
  /** Origin of the separately deployed frontend (e.g. https://resulio.co). Empty = this server also serves the SPA. */
  get frontendUrl() { return toOrigin(process.env.FRONTEND_URL ?? ""); },
  /** Shared parent domain for session cookies when the SPA and API are on sibling hosts. */
  get cookieDomain() { return cookieDomainFromEnv(); },
  /** Browser origins allowed to call the API with credentials: FRONTEND_URL plus optional CORS_ALLOWED_ORIGINS. */
  get corsAllowedOrigins(): string[] {
    const extra = (process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").map(toOrigin);
    return withWwwAliases(Array.from(new Set([this.frontendUrl, ...extra].filter(Boolean))));
  },
  get isProduction() { return process.env.NODE_ENV === "production"; },
  get enableDemoLogin() { return process.env.NODE_ENV !== "production" && process.env.DISABLE_DEMO_LOGIN !== "1"; },
  /** Manus Forge pair: file-storage/notification helpers, and the LLM fallback when AI_API_KEY is unset. */
  get forgeApiUrl() { return process.env.MANUS_API_URL ?? ""; },
  get forgeApiKey() { return process.env.MANUS_API_KEY ?? ""; },
  /** Chat-completions provider: AI_API_URL / AI_API_KEY / AI_MODEL, else MANUS_API_*. */
  get llm(): LlmConfig { return resolveLlmConfig(); },
  get llmConfigured() { return this.llm.source !== null; },
  /** Submission pre-review runs only when the LLM is configured and AI_REVIEW_DISABLED is not "1". */
  get aiReviewEnabled() { return this.llmConfigured && envString("AI_REVIEW_DISABLED") !== "1"; },
  /** Optional model name for submission pre-review; empty = AI_MODEL / the provider default. */
  get aiReviewModel() { return envString("AI_REVIEW_MODEL"); },
  /** Workspaces with Syllabus turned on: comma-separated workspace ids, or "*" for all. Empty = off everywhere. */
  get syllabusEnabledWorkspaces(): string[] {
    return envString("SYLLABUS_ENABLED_WORKSPACES")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
  /** Max AI pre-reviews per workspace in a rolling 24 hours. */
  get aiReviewDailyLimit() {
    const n = Number.parseInt(envString("AI_REVIEW_DAILY_LIMIT"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 100;
  },
  /** Question import from PDF/images runs only when the LLM is configured and QUESTION_IMPORT_DISABLED is not "1". */
  get questionImportEnabled() { return this.llmConfigured && envString("QUESTION_IMPORT_DISABLED") !== "1"; },
  /** Optional model for question import (must read PDFs/images); empty = AI_MODEL / the provider default. */
  get questionImportModel() { return envString("QUESTION_IMPORT_MODEL"); },
  /** "native" sends the PDF itself, "text" only its extracted text; empty = native where the provider supports it. */
  get questionImportPdfMode(): "native" | "text" | "" {
    const v = envString("QUESTION_IMPORT_PDF_MODE").toLowerCase();
    return v === "native" || v === "text" ? v : "";
  },
  /** Max model requests (one per chunk of pages or image) per workspace in a rolling 24 hours. */
  get questionImportDailyLimit() {
    const n = Number.parseInt(envString("QUESTION_IMPORT_DAILY_LIMIT"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 60;
  },
  /** Syllabus import from a file or text runs only when the LLM is configured and SYLLABUS_IMPORT_DISABLED is not "1". */
  get syllabusImportEnabled() { return this.llmConfigured && envString("SYLLABUS_IMPORT_DISABLED") !== "1"; },
  /** Optional model for syllabus import; empty = QUESTION_IMPORT_MODEL, then AI_MODEL / the provider default. */
  get syllabusImportModel() { return envString("SYLLABUS_IMPORT_MODEL") || envString("QUESTION_IMPORT_MODEL"); },
  /** Max model requests (one per part of a document) per workspace in a rolling 24 hours. */
  get syllabusImportDailyLimit() {
    const n = Number.parseInt(envString("SYLLABUS_IMPORT_DAILY_LIMIT"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 30;
  },
};
