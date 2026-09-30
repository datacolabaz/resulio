export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/** Origin of the API service; empty when the API is served from the same origin as the page. */
export const API_BASE = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/+$/, "");

/** Relative in-app path only; anything else falls back to the role home. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.startsWith("/api/")) {
    return "/app";
  }
  return value;
}

/** Start Google sign-in; the server handles state, PKCE and the callback. */
export const startLogin = (returnTo?: string) => {
  const target = safeReturnTo(returnTo ?? `${window.location.pathname}${window.location.search}`);
  window.location.href = `${API_BASE}/api/auth/google/start?returnTo=${encodeURIComponent(target === "/" ? "/app" : target)}`;
};
