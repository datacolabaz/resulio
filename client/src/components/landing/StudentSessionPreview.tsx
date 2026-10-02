import { StatusBadge } from "@/components/StatusBadge";
import { buttonVariants } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { Check, Clock } from "lucide-react";
import { DEMO } from "./demoData";

/** Plain math options for the demo question — no language-specific text to translate. */
const OPTIONS = ["x = 2, x = 3", "x = -2, x = -3", "x = 1, x = 6", "x = 0, x = 5"];
const SELECTED_OPTION = 0;

/**
 * Section 2 preview: a cut-down version of the real student exam session (StudentSession.tsx) —
 * same server-timer / autosave / answered-count language as the live product, static demo
 * numbers, nothing wired up. See HeroDashboardPreview for why this is plain div/span, not real
 * form controls.
 */
export function StudentSessionPreview() {
  return (
    <div role="img" aria-label={t("landing.preview.sessionSummary")} className="p-4 text-left sm:p-5">
      <div aria-hidden className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <p className="truncate text-sm font-semibold">{t("landing.preview.examTitle")}</p>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-neutral-surface px-2.5 py-0.5 text-xs font-medium text-neutral">
            <Clock className="h-3.5 w-3.5" /> {t("session.timeLeft", { time: DEMO.sessionTimeLeft })}
          </span>
          <StatusBadge tone="success">{t("session.saved")}</StatusBadge>
        </div>
      </div>

      <div aria-hidden className="mt-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="font-medium">{t("session.questionOf", { n: DEMO.sessionCurrentQuestion, total: DEMO.sessionTotalQuestions })}</span>
          <span className="text-muted-foreground">{t("session.answeredCount", { done: DEMO.sessionAnsweredCount, total: DEMO.sessionTotalQuestions })}</span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: DEMO.sessionTotalQuestions }, (_, i) => i + 1).map((n) => (
            <span
              key={n}
              className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-medium ${
                n === DEMO.sessionCurrentQuestion
                  ? "border-primary bg-primary text-primary-foreground"
                  : n <= DEMO.sessionAnsweredCount
                    ? "border-success/40 bg-success-surface text-success"
                    : "border-border text-muted-foreground"
              }`}
            >
              {n}
            </span>
          ))}
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-sm font-medium">{t("landing.preview.sampleQuestion")}</p>
          <ul className="mt-3 space-y-2">
            {OPTIONS.map((opt, i) => (
              <li
                key={opt}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${i === SELECTED_OPTION ? "border-primary bg-primary/10" : "border-border"}`}
              >
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${i === SELECTED_OPTION ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>
                  {i === SELECTED_OPTION && <Check className="h-3 w-3" />}
                </span>
                {opt}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-between">
          <span className={buttonVariants({ variant: "outline", size: "sm", className: "pointer-events-none" })}>{t("session.previous")}</span>
          <span className={buttonVariants({ size: "sm", className: "pointer-events-none" })}>{t("session.next")}</span>
        </div>
      </div>
    </div>
  );
}
