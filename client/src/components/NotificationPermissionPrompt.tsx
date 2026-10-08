import { Button } from "@/components/ui/button";
import { useNotificationPrompt } from "@/hooks/useNotificationPrompt";
import { t } from "@/i18n/messages";
import { escapeDismisses } from "@/lib/notificationPrompt";
import { cn } from "@/lib/utils";
import { Bell, BellOff, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

const OTHER_OVERLAY = '[role="dialog"]:not([data-notify-prompt]), [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * Non-modal card asking for browser-notification permission. Mounted once at the app root; the
 * hook decides when it appears. It never takes focus on its own: it is announced politely and is
 * the last stop in the tab order, and focus goes back to where it was when it closes.
 */
export function NotificationPermissionPrompt() {
  const prompt = useNotificationPrompt();
  // The live region exists before the card is inserted, so screen readers announce it.
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-6 sm:bottom-6 sm:px-0 sm:pb-0">
      {prompt.mounted && <PromptCard {...prompt} />}
    </div>
  );
}

function PromptCard({ closing, view, busy, allow, notNow, close }: ReturnType<typeof useNotificationPrompt>) {
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const cardRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const blocked = view === "blocked";
  const dismiss = blocked ? close : notNow;

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (cardRef.current?.contains(e.target as Node) && e.relatedTarget instanceof HTMLElement && !cardRef.current.contains(e.relatedTarget)) {
        returnFocus.current = e.relatedTarget;
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    if (!closing) return;
    const card = cardRef.current;
    if (!card?.contains(document.activeElement)) return;
    const target = returnFocus.current;
    if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
    else (document.activeElement as HTMLElement | null)?.blur();
  }, [closing]);

  useEffect(() => {
    if (closing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const focusInPrompt = !!cardRef.current?.contains(document.activeElement);
      const otherOverlayOpen = !!document.querySelector(OTHER_OVERLAY);
      if (escapeDismisses({ key: e.key, defaultPrevented: e.defaultPrevented, focusInPrompt, otherOverlayOpen })) dismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closing, dismiss]);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-notify-prompt=""
      className={cn(
        "pointer-events-auto relative w-full max-w-md rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-overlay sm:w-[380px] sm:p-5",
        "duration-200 motion-reduce:animate-none",
        closing ? "animate-out fill-mode-forwards fade-out-0 slide-out-to-bottom-4" : "animate-in fade-in-0 slide-in-from-bottom-4",
      )}
    >
      <Button type="button" variant="ghost" size="icon-sm" onClick={dismiss} aria-label={t("common.close")} className="absolute top-2 right-2 text-muted-foreground hover:text-foreground">
        <X aria-hidden />
      </Button>
      <div className="flex gap-3 pr-6">
        <span aria-hidden className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", blocked ? "bg-warning-surface text-warning" : "bg-info-surface text-link")}>
          {blocked ? <BellOff className="size-5" /> : <Bell className="size-5" />}
        </span>
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="font-[family-name:var(--font-display)] text-base leading-snug font-semibold text-foreground">
            {blocked ? t("notifyPrompt.blockedTitle") : t("notifyPrompt.title")}
          </h2>
          <p id={bodyId} className="text-sm leading-relaxed text-muted-foreground">
            {blocked ? t("notifyPrompt.blockedBody") : t("notifyPrompt.body")}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap sm:justify-start">
        {blocked ? (
          <Button type="button" variant="secondary" onClick={close} className="w-full sm:w-auto">
            {t("notifyPrompt.gotIt")}
          </Button>
        ) : (
          <>
            <Button type="button" onClick={() => void allow()} disabled={busy} aria-busy={busy} className="w-full sm:w-auto">
              <Bell aria-hidden />
              {t("notifyPrompt.allow")}
            </Button>
            <Button type="button" variant="ghost" onClick={notNow} disabled={busy} className="w-full text-foreground-secondary sm:w-auto">
              {t("notifyPrompt.notNow")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
