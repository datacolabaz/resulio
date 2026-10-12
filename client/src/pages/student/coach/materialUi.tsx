import { isMessageKey, t } from "@/i18n/messages";
import type { MaterialStage } from "@shared/coach";
import { Check } from "lucide-react";

export const inProgress = (stage: MaterialStage) => stage === "CHECKING" || stage === "PROCESSING";

const STAGE_CLASS: Record<MaterialStage, string> = {
  CHECKING: "bg-muted text-muted-foreground",
  PROCESSING: "bg-info-surface text-info",
  READY: "bg-success-surface text-success",
  FAILED: "bg-danger-surface text-destructive",
};

export function StageBadge({ stage }: { stage: MaterialStage }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_CLASS[stage]}`}>{t(`coach.stage.${stage}`)}</span>;
}

const MASTERY_CLASS: Record<string, string> = {
  STRONG: "bg-success-surface text-success",
  REVIEW: "bg-warning-surface text-warning",
  CRITICAL: "bg-danger-surface text-destructive",
  INSUFFICIENT: "bg-muted text-muted-foreground",
};

/** A topic's mastery from the coach's quizzes, e.g. "72%" with its status as the accessible name. */
export function MasteryBadge({ mastery, status }: { mastery: number; status: string }) {
  const key = `coach.mastery.${status}`;
  const label = isMessageKey(key) ? t(key) : status;
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${MASTERY_CLASS[status] ?? MASTERY_CLASS.INSUFFICIENT}`} title={label} aria-label={`${t("coach.mastery.title")}: ${Math.round(mastery)}% — ${label}`}>
      {Math.round(mastery)}%
    </span>
  );
}

const STEPS = ["CHECKING", "PROCESSING", "READY"] as const;

/** "Fayl yoxlanılır" → "Material emal olunur" → "Material hazırdır". */
export function StageSteps({ stage }: { stage: MaterialStage }) {
  const at = STEPS.indexOf(stage as (typeof STEPS)[number]);
  return (
    <ol className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4" aria-live="polite">
      {STEPS.map((s, i) => {
        const done = at > i || stage === "READY";
        const current = at === i && stage !== "READY";
        return (
          <li key={s} className={`flex items-center gap-2 text-sm ${current ? "font-medium text-foreground" : done ? "text-success" : "text-muted-foreground"}`}>
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${done ? "border-success bg-success-surface" : current ? "border-link" : "border-border"}`}>
              {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : current ? <span className="h-2 w-2 animate-pulse rounded-full bg-link motion-reduce:animate-none" aria-hidden /> : null}
            </span>
            {t(`coach.stage.${s}`)}
          </li>
        );
      })}
    </ol>
  );
}
