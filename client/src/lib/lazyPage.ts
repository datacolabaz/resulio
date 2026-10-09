import { lazy, type ComponentType } from "react";

/**
 * After a deploy the previous build's code-split chunks are gone (the frontend answers 404), so a tab
 * opened before it cannot load the next lazy page. One full reload fetches the new index with the new
 * chunk names; a second failure soon after is a real error and reaches the error boundary.
 */

const RELOAD_KEY = "resulio-chunk-reload";
const RELOAD_WINDOW_MS = 30_000;

export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading (CSS )?chunk \S+ failed|Unable to preload CSS/i.test(text);
}

/** True when this tab may reload now (no reload for a missing chunk within the window); records it. */
export function claimChunkReload(storage: Pick<Storage, "getItem" | "setItem"> | null, now = Date.now()): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(RELOAD_KEY) ?? 0);
    if (last && now - last < RELOAD_WINDOW_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reloads the page once for a missing chunk; true when the reload is under way. */
export function reloadForStaleChunk(error: unknown): boolean {
  if (typeof window === "undefined" || !isChunkLoadError(error) || !claimChunkReload(sessionStore())) return false;
  window.location.reload();
  return true;
}

/** `React.lazy` that survives a deploy: a missing chunk reloads the page once instead of crashing it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((error: unknown) => {
      if (reloadForStaleChunk(error)) return new Promise<never>(() => undefined);
      throw error;
    }),
  );
}
