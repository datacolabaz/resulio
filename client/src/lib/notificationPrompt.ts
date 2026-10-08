/**
 * Browser-notification permission prompt: pure decision logic, persisted state and the few
 * browser calls it needs. Every browser access is guarded so prerender, private mode, insecure
 * origins and browsers without the Notification API never throw.
 */

export type NotifyPermission = "default" | "granted" | "denied";

export const PROMPT_STORAGE_KEY = "resulio.notifyPrompt.v1";
export const PROMPT_DELAY_MS = 8_000;
export const PROMPT_PAGE_VIEWS = 2;
export const NOT_NOW_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Shown but neither accepted nor dismissed (tab closed, reload): wait a day before asking again. */
export const IGNORED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface PromptState {
  v: 1;
  shownCount: number;
  lastShownAt: number | null;
  dismissedAt: number | null;
  grantedAt: number | null;
  deniedAt: number | null;
}

export const EMPTY_STATE: PromptState = { v: 1, shownCount: 0, lastShownAt: null, dismissedAt: null, grantedAt: null, deniedAt: null };

export interface PromptContext {
  state: PromptState;
  now: number;
  /** null when the Notification API is missing. */
  permission: NotifyPermission | null;
  supported: boolean;
  secure: boolean;
  timeOnSiteMs: number;
  pageViews: number;
}

/** Environment and history allow the prompt at all (independent of the timer/page-view trigger). */
export function isEligible({ state, now, permission, supported, secure }: Omit<PromptContext, "timeOnSiteMs" | "pageViews">): boolean {
  if (!supported || !secure || permission !== "default") return false;
  if (state.grantedAt !== null) return false;
  if (state.dismissedAt !== null && now - state.dismissedAt < NOT_NOW_COOLDOWN_MS) return false;
  if (state.lastShownAt !== null && now - state.lastShownAt < IGNORED_COOLDOWN_MS) return false;
  return true;
}

export const triggerReached = (timeOnSiteMs: number, pageViews: number) => timeOnSiteMs >= PROMPT_DELAY_MS || pageViews >= PROMPT_PAGE_VIEWS;

export function shouldShow(ctx: PromptContext): boolean {
  return isEligible(ctx) && triggerReached(ctx.timeOnSiteMs, ctx.pageViews);
}

/**
 * Focus-critical and onboarding flows never get the prompt: sign-in/onboarding, exam and task
 * taking, the lesson player, and editors with a sticky bottom action bar.
 */
const EXCLUDED_ROUTES: RegExp[] = [
  /^\/login\b/,
  /^\/welcome\b/,
  /^\/choose-role\b/,
  /^\/join\//,
  /^\/invite\//,
  /^\/g\//,
  /^\/exam\//,
  /^\/task\//,
  /^\/student\/sessions\//,
  /^\/student\/exam\//,
  /^\/student\/syllabus\/[^/]+\/lessons\//,
  /^\/teacher\/syllabus\/.+/,
  /^\/teacher\/assessments\/new\b/,
  /^\/teacher\/assessments\/[^/]+\/edit\b/,
  /^\/teacher\/library\/import\b/,
];

export const isPromptRoute = (pathname: string) => !EXCLUDED_ROUTES.some((r) => r.test(pathname));

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const SM_BREAKPOINT = 640;
/** Room the card takes, with margin: full-width bottom strip on phones, bottom-right corner from `sm` up. */
const MOBILE_ZONE_HEIGHT = 300;
const DESKTOP_ZONE = { width: 404, height: 260 };

export function promptZone(viewportWidth: number, viewportHeight: number): Rect {
  if (viewportWidth < SM_BREAKPOINT) return { top: viewportHeight - MOBILE_ZONE_HEIGHT, bottom: viewportHeight, left: 0, right: viewportWidth };
  return { top: viewportHeight - DESKTOP_ZONE.height, bottom: viewportHeight, left: viewportWidth - DESKTOP_ZONE.width, right: viewportWidth };
}

/** True when none of the visible rects reaches into the zone. */
export function zoneClear(zone: Rect, rects: Rect[]): boolean {
  return !rects.some((r) => r.bottom > r.top && r.right > r.left && r.bottom > zone.top && r.top < zone.bottom && r.right > zone.left && r.left < zone.right);
}

/** Elements marked `data-notify-avoid` (primary CTAs) must not end up under the card. */
export function avoidAreaClear(): boolean {
  try {
    const rects = [...document.querySelectorAll("[data-notify-avoid]")].map((el) => el.getBoundingClientRect());
    return zoneClear(promptZone(window.innerWidth, window.innerHeight), rects);
  } catch {
    return true;
  }
}

export const recordShown = (s: PromptState, now: number): PromptState => ({ ...s, shownCount: s.shownCount + 1, lastShownAt: now });
export const recordDismissed = (s: PromptState, now: number): PromptState => ({ ...s, dismissedAt: now });
export const recordGranted = (s: PromptState, now: number): PromptState => ({ ...s, grantedAt: now });
export const recordDenied = (s: PromptState, now: number): PromptState => ({ ...s, deniedAt: now });

export type PermissionOutcome = "granted" | "blocked" | "dismissed";

/** What the primary button leads to: a granted test notification, settings guidance, or "not now" when the native prompt was closed. */
export const permissionOutcome = (p: NotifyPermission): PermissionOutcome => (p === "granted" ? "granted" : p === "denied" ? "blocked" : "dismissed");

/** Escape closes the prompt ("not now") unless another overlay owns the key. */
export function escapeDismisses(e: { key: string; defaultPrevented: boolean; focusInPrompt: boolean; otherOverlayOpen: boolean }): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  return e.focusInPrompt || !e.otherOverlayOpen;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

export function parseState(raw: string | null): PromptState {
  if (!raw) return EMPTY_STATE;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || o.v !== 1) return EMPTY_STATE;
    return {
      v: 1,
      shownCount: num(o.shownCount) ?? 0,
      lastShownAt: num(o.lastShownAt),
      dismissedAt: num(o.dismissedAt),
      grantedAt: num(o.grantedAt),
      deniedAt: num(o.deniedAt),
    };
  } catch {
    return EMPTY_STATE;
  }
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readState(store: KeyValueStore | null = defaultStore()): PromptState {
  try {
    return parseState(store?.getItem(PROMPT_STORAGE_KEY) ?? null);
  } catch {
    return EMPTY_STATE;
  }
}

export function writeState(state: PromptState, store: KeyValueStore | null = defaultStore()) {
  try {
    store?.setItem(PROMPT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable (private mode, quota): the choice still holds for this page view
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

export interface NotifyEnvironment {
  supported: boolean;
  secure: boolean;
  permission: NotifyPermission | null;
}

export function readEnvironment(): NotifyEnvironment {
  if (typeof window === "undefined") return { supported: false, secure: false, permission: null };
  try {
    const secure = window.isSecureContext === true;
    const supported = "Notification" in window && typeof window.Notification?.requestPermission === "function";
    const permission = supported ? (window.Notification.permission as NotifyPermission) : null;
    return { supported, secure, permission };
  } catch {
    return { supported: false, secure: false, permission: null };
  }
}

/** Handles the promise form and the legacy callback form (older Safari). */
export function requestPermission(): Promise<NotifyPermission> {
  return new Promise((resolve) => {
    try {
      const result = window.Notification.requestPermission((p) => resolve(p as NotifyPermission));
      if (result && typeof result.then === "function") result.then((p) => resolve(p as NotifyPermission), () => resolve(window.Notification.permission as NotifyPermission));
    } catch {
      resolve(readEnvironment().permission ?? "denied");
    }
  });
}

/** Prefers a service worker registration (required on Android Chrome); false if nothing could be shown. */
export async function showLocalNotification(title: string, body?: string): Promise<boolean> {
  const options: NotificationOptions = { body, icon: "/brand/resulio-icon.png", badge: "/brand/resulio-icon.png", tag: "resulio-notify-enabled" };
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration) {
      await registration.showNotification(title, options);
      return true;
    }
  } catch {
    // fall through to the page-level constructor
  }
  try {
    new window.Notification(title, options);
    return true;
  } catch {
    return false;
  }
}
