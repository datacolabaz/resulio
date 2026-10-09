import { toneSurface } from "@/components/StatusBadge";
import { t } from "@/i18n/messages";
import { fmtCompact, fmtDay, fmtNumber } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { UsageBar } from "@/components/UsageBar";

/**
 * The teacher's AI limit (set by an admin) next to AI actions: usage bars, a warning from 80% and
 * the reset date once a limit is reached. Shows nothing while the teacher has no limit.
 */
export function AiQuotaNote({ className = "" }: { className?: string }) {
  const quota = trpc.teacher.ai.quota.useQuery(undefined, { staleTime: 30_000 });
  const q = quota.data;
  if (!q?.limited) return null;
  const blockedAt = q.blocked === "MONTHLY" ? q.monthly.resetsAt : q.blocked === "DAILY" ? q.daily.resetsAt : null;
  const nearest = q.monthly.ratio >= q.daily.ratio ? q.monthly.resetsAt : q.daily.resetsAt;

  return (
    <div className={`space-y-2 rounded-xl border border-border p-3 text-xs ${className}`}>
      <div className="font-medium text-foreground-secondary">{t("aiQuota.label")}</div>
      {q.monthly.limit !== null && (
        <div className="space-y-1">
          <div className="text-muted-foreground">{t("aiQuota.month", { used: fmtCompact(q.monthly.used), limit: fmtCompact(q.monthly.limit) })}</div>
          <UsageBar ratio={q.monthly.ratio} label={t("aiQuota.label")} />
        </div>
      )}
      {q.daily.limit !== null && (
        <div className="space-y-1">
          <div className="text-muted-foreground">{t("aiQuota.day", { used: fmtNumber(q.daily.used), limit: fmtNumber(q.daily.limit) })}</div>
          <UsageBar ratio={q.daily.ratio} label={t("aiQuota.label")} />
        </div>
      )}
      {blockedAt ? (
        <p role="alert" className={`rounded-lg border p-2 ${toneSurface("danger")}`}>
          {t(q.blocked === "MONTHLY" ? "error.AI_TEACHER_MONTHLY_LIMIT" : "error.AI_TEACHER_DAILY_LIMIT", { date: fmtDay(blockedAt) })}
        </p>
      ) : q.warn ? (
        <p className={`rounded-lg border p-2 ${toneSurface("warning")}`}>{t("aiQuota.warn", { date: fmtDay(nearest) })}</p>
      ) : null}
    </div>
  );
}
