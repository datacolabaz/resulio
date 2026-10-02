export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

const PRODUCTION_API_ORIGIN = "https://api.resulio.co";

/**
 * Origin of the API service; empty when the API is served from the same origin as the page.
 * Production public site must call api.resulio.co even if VITE_API_URL was not baked in at build time
 * (the Google button otherwise hits resulio.co, which is a different Railway service).
 */
export function getApiBase(hostname?: string): string {
  const fromEnv = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  const host = hostname ?? (typeof window !== "undefined" ? window.location.hostname : "");
  if (host === "resulio.co" || host === "www.resulio.co") return PRODUCTION_API_ORIGIN;
  return "";
}

export const API_BASE = getApiBase();

/** Relative in-app path only; anything else falls back to the role home. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.startsWith("/api/")) {
    return "/app";
  }
  return value;
}

/**
 * Start Google sign-in; the server handles state, PKCE and the callback. Whatever `ref` (a
 * partner's referral code), `src`/`source`, or `campaign` is sitting in the CURRENT page's query string
 * rides along to /api/auth/google/start regardless of what `returnTo` is, so a fresh signup can
 * still be attributed to it even when the caller passes an explicit returnTo that doesn't carry
 * its own query (see server/_core/googleAuth.ts, which signs these into the OAuth state).
 */
export const startLogin = (returnTo?: string) => {
  const target = safeReturnTo(returnTo ?? `${window.location.pathname}${window.location.search}`);
  const here = new URLSearchParams(window.location.search);
  const url = new URL(`${getApiBase()}/api/auth/google/start`, window.location.origin);
  url.searchParams.set("returnTo", target === "/" ? "/app" : target);
  for (const key of ["ref", "src", "source", "campaign"]) {
    const value = here.get(key);
    if (value) url.searchParams.set(key, value);
  }
  window.location.href = url.toString();
};
