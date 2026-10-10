import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { t } from "@/i18n/messages";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Sparkles } from "lucide-react";
import type { MasteryStatus, MasteryTrend } from "@shared/growth";

export const STATUS_TONE: Record<MasteryStatus, Tone> = {
  STRONG: "success",
  REVIEW: "warning",
  CRITICAL: "danger",
  INSUFFICIENT: "neutral",
};

/** Teachers read "kritik zəiflik"; students read "Prioritet mövzu" for the same status. */
export function statusLabel(status: MasteryStatus, audience: "teacher" | "student" = "teacher") {
  return audience === "student" && status === "CRITICAL" ? t("growth.studentStatus.CRITICAL") : t(`growth.status.${status}`);
}

export function MasteryBadge({ status, audience = "teacher" }: { status: MasteryStatus; audience?: "teacher" | "student" }) {
  return <StatusBadge tone={STATUS_TONE[status]}>{statusLabel(status, audience)}</StatusBadge>;
}

const TREND_ICON = { UP: ArrowUpRight, DOWN: ArrowDownRight, FLAT: ArrowRight, NEW: Sparkles } as const;
const TREND_CLASS: Record<MasteryTrend, string> = { UP: "text-success", DOWN: "text-destructive", FLAT: "text-muted-foreground", NEW: "text-info" };

export function TrendMark({ trend, delta }: { trend: MasteryTrend; delta?: number | null }) {
  const Icon = TREND_ICON[trend];
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${TREND_CLASS[trend]}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {t(`growth.trend.${trend}`)}
      {delta != null && trend !== "NEW" && <span>({delta > 0 ? "+" : ""}{delta})</span>}
    </span>
  );
}

const CELL_CLASS: Record<MasteryStatus, string> = {
  STRONG: "bg-success-surface text-success",
  REVIEW: "bg-warning-surface text-warning",
  CRITICAL: "bg-danger-surface text-destructive",
  INSUFFICIENT: "bg-neutral-surface text-muted-foreground",
};

/** A heat-grid cell: the number is always printed, so colour is never the only signal. */
export function MasteryCell({ mastery, status, audience = "teacher" }: { mastery: number; status: MasteryStatus; audience?: "teacher" | "student" }) {
  return (
    <span className={`inline-flex min-w-12 justify-center rounded-md px-2 py-1 text-xs font-medium tabular-nums ${CELL_CLASS[status]}`} title={statusLabel(status, audience)}>
      {Math.round(mastery)}%
    </span>
  );
}

export function MasteryBar({ mastery, status }: { mastery: number; status: MasteryStatus }) {
  const fill = { STRONG: "bg-success", REVIEW: "bg-warning", CRITICAL: "bg-destructive", INSUFFICIENT: "bg-muted-foreground" }[status];
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.max(2, Math.min(100, mastery))}%` }} />
    </div>
  );
}
