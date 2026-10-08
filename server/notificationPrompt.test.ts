import { describe, expect, it } from "vitest";
import { translate } from "../client/src/i18n/messages";
import {
  EMPTY_STATE,
  escapeDismisses,
  IGNORED_COOLDOWN_MS,
  isPromptRoute,
  NOT_NOW_COOLDOWN_MS,
  parseState,
  permissionOutcome,
  promptZone,
  PROMPT_DELAY_MS,
  PROMPT_STORAGE_KEY,
  readEnvironment,
  readState,
  recordDenied,
  recordDismissed,
  recordGranted,
  recordShown,
  shouldShow,
  writeState,
  zoneClear,
  type PromptContext,
} from "../client/src/lib/notificationPrompt";

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 24 * 60 * 60 * 1000;

const ctx = (over: Partial<PromptContext> = {}): PromptContext => ({
  state: EMPTY_STATE,
  now: NOW,
  permission: "default",
  supported: true,
  secure: true,
  timeOnSiteMs: PROMPT_DELAY_MS,
  pageViews: 1,
  ...over,
});

function memoryStore() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("shouldShow", () => {
  it("shows a fresh visitor once the trigger is reached", () => {
    expect(shouldShow(ctx())).toBe(true);
  });

  it("waits for the timer: not before 8 s on a single page", () => {
    expect(shouldShow(ctx({ timeOnSiteMs: 0 }))).toBe(false);
    expect(shouldShow(ctx({ timeOnSiteMs: PROMPT_DELAY_MS - 1000 }))).toBe(false);
    expect(shouldShow(ctx({ timeOnSiteMs: PROMPT_DELAY_MS }))).toBe(true);
  });

  it("shows on the second page view without waiting for the timer", () => {
    expect(shouldShow(ctx({ timeOnSiteMs: 0, pageViews: 2 }))).toBe(true);
  });

  it("never shows once permission is granted (browser or stored)", () => {
    expect(shouldShow(ctx({ permission: "granted" }))).toBe(false);
    expect(shouldShow(ctx({ state: recordGranted(EMPTY_STATE, NOW - 400 * DAY) }))).toBe(false);
  });

  it("never shows proactively when the browser has denied", () => {
    expect(shouldShow(ctx({ permission: "denied", pageViews: 5 }))).toBe(false);
  });

  it("stays silent when the Notification API is missing", () => {
    expect(shouldShow(ctx({ supported: false, permission: null }))).toBe(false);
  });

  it("stays silent outside a secure context", () => {
    expect(shouldShow(ctx({ secure: false }))).toBe(false);
  });

  it("respects 'not now' for 7 days, then asks again", () => {
    const dismissed = recordDismissed(EMPTY_STATE, NOW);
    expect(shouldShow(ctx({ state: dismissed, now: NOW + DAY }))).toBe(false);
    expect(shouldShow(ctx({ state: dismissed, now: NOW + NOT_NOW_COOLDOWN_MS - 1 }))).toBe(false);
    expect(shouldShow(ctx({ state: dismissed, now: NOW + NOT_NOW_COOLDOWN_MS }))).toBe(true);
  });

  it("does not reappear on every visit when it was shown and ignored", () => {
    const shown = recordShown(EMPTY_STATE, NOW);
    expect(shouldShow(ctx({ state: shown, now: NOW + 60_000 }))).toBe(false);
    expect(shouldShow(ctx({ state: shown, now: NOW + IGNORED_COOLDOWN_MS }))).toBe(true);
  });
});

describe("persisted state", () => {
  it("survives a refresh: 'not now' written before reload still blocks after it", () => {
    const store = memoryStore();
    writeState(recordDismissed(recordShown(readState(store), NOW), NOW), store);
    const afterReload = readState(store);
    expect(afterReload).toMatchObject({ v: 1, shownCount: 1, lastShownAt: NOW, dismissedAt: NOW, grantedAt: null });
    expect(shouldShow(ctx({ state: afterReload, now: NOW + 1000, pageViews: 3 }))).toBe(false);
    expect([...store.data.keys()]).toEqual([PROMPT_STORAGE_KEY]);
  });

  it("keeps grant and denial timestamps and counts shows", () => {
    const s = recordDenied(recordGranted(recordShown(recordShown(EMPTY_STATE, 1), 2), 3), 4);
    expect(s).toEqual({ v: 1, shownCount: 2, lastShownAt: 2, dismissedAt: null, grantedAt: 3, deniedAt: 4 });
  });

  it("falls back to an empty state for missing, corrupt or foreign-version data", () => {
    expect(parseState(null)).toEqual(EMPTY_STATE);
    expect(parseState("{not json")).toEqual(EMPTY_STATE);
    expect(parseState(JSON.stringify({ v: 2, grantedAt: 1 }))).toEqual(EMPTY_STATE);
    expect(parseState(JSON.stringify({ v: 1, dismissedAt: "yesterday", shownCount: 2 }))).toMatchObject({ dismissedAt: null, shownCount: 2 });
  });

  it("never throws when storage is unavailable (privacy mode)", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readState(broken)).toEqual(EMPTY_STATE);
    expect(() => writeState(recordDismissed(EMPTY_STATE, NOW), broken)).not.toThrow();
    expect(readState(null)).toEqual(EMPTY_STATE);
  });
});

describe("environment without a window (prerender / tests)", () => {
  it("reports unsupported instead of throwing", () => {
    expect(readEnvironment()).toEqual({ supported: false, secure: false, permission: null });
  });
});

describe("permission outcome", () => {
  it("maps the browser answer to the next step", () => {
    expect(permissionOutcome("granted")).toBe("granted");
    expect(permissionOutcome("denied")).toBe("blocked");
    expect(permissionOutcome("default")).toBe("dismissed");
  });
});

describe("Escape", () => {
  const key = (over: Partial<Parameters<typeof escapeDismisses>[0]> = {}) =>
    escapeDismisses({ key: "Escape", defaultPrevented: false, focusInPrompt: false, otherOverlayOpen: false, ...over });

  it("closes the prompt as 'not now'", () => {
    expect(key()).toBe(true);
    expect(key({ focusInPrompt: true, otherOverlayOpen: true })).toBe(true);
  });

  it("leaves Escape to an open modal, menu or listbox", () => {
    expect(key({ otherOverlayOpen: true })).toBe(false);
    expect(key({ defaultPrevented: true, focusInPrompt: true })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(key({ key: "Enter" })).toBe(false);
  });
});

describe("routes", () => {
  it("covers public pages and dashboards", () => {
    for (const path of ["/", "/about", "/faq", "/teacher", "/teacher/assessments", "/teacher/syllabus", "/student", "/student/results/5", "/settings", "/material/abc"]) {
      expect(isPromptRoute(path), path).toBe(true);
    }
  });

  it("skips sign-in, onboarding, exam/task taking and focus-critical editors", () => {
    for (const path of [
      "/login",
      "/welcome",
      "/join/ABC123",
      "/invite/tok",
      "/g/tok",
      "/exam/share1",
      "/task/share1",
      "/student/sessions/42",
      "/student/syllabus/7/lessons/3",
      "/teacher/syllabus/7",
      "/teacher/syllabus/7/present/1",
      "/teacher/assessments/new",
      "/teacher/assessments/9/edit",
      "/teacher/library/import",
    ]) {
      expect(isPromptRoute(path), path).toBe(false);
    }
  });
});

describe("primary CTAs stay uncovered", () => {
  const rect = (top: number, bottom: number, left = 16, right = 344) => ({ top, bottom, left, right });

  it("uses a bottom strip on phones and the bottom-right corner on larger screens", () => {
    expect(promptZone(390, 844)).toEqual({ top: 544, bottom: 844, left: 0, right: 390 });
    expect(promptZone(1280, 800)).toEqual({ top: 540, bottom: 800, left: 876, right: 1280 });
  });

  it("waits while a marked CTA is inside the zone, then allows once it scrolls away", () => {
    const zone = promptZone(360, 640);
    expect(zoneClear(zone, [rect(359, 628)])).toBe(false);
    expect(zoneClear(zone, [rect(59, 328)])).toBe(true);
  });

  it("ignores CTAs outside the desktop corner and hidden (zero-size) elements", () => {
    const zone = promptZone(1280, 800);
    expect(zoneClear(zone, [rect(460, 560, 70, 380)])).toBe(true);
    expect(zoneClear(zone, [rect(700, 700, 900, 900)])).toBe(true);
    expect(zoneClear(zone, [rect(600, 650, 900, 1100)])).toBe(false);
  });
});

describe("copy", () => {
  it("uses the approved Azerbaijani text", () => {
    expect(translate("az", "notifyPrompt.title")).toBe("Yeniliklərdən vaxtında xəbərdar olun");
    expect(translate("az", "notifyPrompt.body")).toBe("Resulio.co-da yeni elanlar, imkanlar və vacib yeniliklər yayımlandıqda sizə bildiriş göndərək.");
    expect(translate("az", "notifyPrompt.allow")).toBe("Bildirişlərə icazə ver");
    expect(translate("az", "notifyPrompt.notNow")).toBe("İndi yox");
    expect(translate("az", "notifyPrompt.enabled")).toBe("Resulio.co bildirişləri aktivdir.");
  });
});
