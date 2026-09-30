export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

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
  window.location.href = `/api/auth/google/start?returnTo=${encodeURIComponent(target === "/" ? "/app" : target)}`;
};
