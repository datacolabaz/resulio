import { t } from "@/i18n/messages";
import {
  avoidAreaClear,
  isEligible,
  isPromptRoute,
  permissionOutcome,
  PROMPT_DELAY_MS,
  readEnvironment,
  readState,
  recordDenied,
  recordDismissed,
  recordGranted,
  recordShown,
  requestPermission,
  shouldShow,
  showLocalNotification,
  writeState,
  type PromptState,
} from "@/lib/notificationPrompt";
import { registerServiceWorker } from "@/lib/webPush";
import { useWebPushSync } from "./useWebPushSync";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

export type PromptPhase = "hidden" | "open" | "closing";
export type PromptView = "ask" | "blocked";

const EXIT_MS = 200;
const TICK_MS = 1_000;

const reducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

function update(change: (s: PromptState, now: number) => PromptState) {
  writeState(change(readState(), Date.now()));
}

export function useNotificationPrompt() {
  const [pathname] = useLocation();
  const syncPush = useWebPushSync();
  const routeAllowed = isPromptRoute(pathname);
  // Decided once per page load: unsupported, insecure, already decided or cooling down → no timers at all.
  const [eligibleAtLoad] = useState(() => isEligible({ state: readState(), now: Date.now(), ...readEnvironment() }));
  const [pageViews, setPageViews] = useState(1);
  const [visibleMs, setVisibleMs] = useState(0);
  const [phase, setPhase] = useState<PromptPhase>("hidden");
  const [view, setView] = useState<PromptView>("ask");
  const [busy, setBusy] = useState(false);
  const [waitingForRoom, setWaitingForRoom] = useState(false);
  const [layoutTick, setLayoutTick] = useState(0);
  const finished = useRef(false);
  const previousPath = useRef(pathname);

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    setPageViews((n) => n + 1);
  }, [pathname]);

  // Time on site counts only while the tab is visible.
  const timerNeeded = eligibleAtLoad && phase === "hidden" && !finished.current && visibleMs < PROMPT_DELAY_MS;
  useEffect(() => {
    if (!timerNeeded) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setVisibleMs((ms) => ms + TICK_MS);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [timerNeeded]);

  useEffect(() => {
    if (!eligibleAtLoad || finished.current || phase !== "hidden" || !routeAllowed) return;
    const state = readState();
    if (!shouldShow({ state, now: Date.now(), ...readEnvironment(), timeOnSiteMs: visibleMs, pageViews })) return;
    if (!avoidAreaClear()) {
      setWaitingForRoom(true);
      return;
    }
    setWaitingForRoom(false);
    writeState(recordShown(state, Date.now()));
    setPhase("open");
  }, [eligibleAtLoad, phase, routeAllowed, visibleMs, pageViews, layoutTick]);

  // A primary CTA sits where the card would go: re-check as the user scrolls or resizes.
  useEffect(() => {
    if (!waitingForRoom) return;
    let frame = 0;
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setLayoutTick((n) => n + 1));
    };
    window.addEventListener("scroll", onChange, { passive: true });
    window.addEventListener("resize", onChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, [waitingForRoom]);

  const close = useCallback(() => {
    finished.current = true;
    setPhase("closing");
    window.setTimeout(() => setPhase("hidden"), reducedMotion() ? 0 : EXIT_MS);
  }, []);

  const notNow = useCallback(() => {
    update(recordDismissed);
    close();
  }, [close]);

  const allow = useCallback(async () => {
    const env = readEnvironment();
    if (!env.supported || !env.secure) return close();
    let permission = env.permission ?? "denied";
    if (permission === "default") {
      setBusy(true);
      permission = await requestPermission();
      setBusy(false);
    }
    const outcome = permissionOutcome(permission);
    if (outcome === "granted") {
      update(recordGranted);
      close();
      void syncPush(true);
      // With the worker registered, the test notification goes through it like real pushes do.
      await registerServiceWorker();
      const text = t("notifyPrompt.enabled");
      if (!(await showLocalNotification(text))) toast.success(text);
    } else if (outcome === "blocked") {
      update(recordDenied);
      setView("blocked");
    } else {
      notNow();
    }
  }, [close, notNow, syncPush]);

  return {
    /** Rendered (including the exit animation); hidden while the user is on an excluded route. */
    mounted: phase !== "hidden" && routeAllowed,
    closing: phase === "closing",
    view,
    busy,
    allow,
    notNow,
    close,
  };
}
