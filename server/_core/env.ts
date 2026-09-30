function toOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
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
  get googleRedirectUri() { return envString("GOOGLE_REDIRECT_URI"); },
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
  /** Browser origins allowed to call the API with credentials: FRONTEND_URL plus optional CORS_ALLOWED_ORIGINS. */
  get corsAllowedOrigins(): string[] {
    const extra = (process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").map(toOrigin);
    return Array.from(new Set([this.frontendUrl, ...extra].filter(Boolean)));
  },
  get isProduction() { return process.env.NODE_ENV === "production"; },
  get enableDemoLogin() { return process.env.NODE_ENV !== "production" && process.env.DISABLE_DEMO_LOGIN !== "1"; },
  get forgeApiUrl() { return process.env.MANUS_API_URL ?? ""; },
  get forgeApiKey() { return process.env.MANUS_API_KEY ?? ""; },
};
