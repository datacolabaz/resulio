import { ErrorNote, Loading, Panel, StatCard } from "@/components/AppShell";
import { t } from "@/i18n/messages";
import { fmtCompact, fmtNumber, fmtUsd } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { formatFileSize } from "@/lib/uploadFile";
import { Link } from "wouter";
import { NoAccess, UsageBar, useAdmin } from "./adminShared";

export default function AdminDashboardPage() {
  const { can } = useAdmin();
  const data = trpc.admin.dashboard.useQuery(undefined, { enabled: can("overview.view") });
  if (!can("overview.view")) return <NoAccess />;
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <Loading />;
  const d = data.data;
  const budget = d.ai?.budget;
  const storageRatio = d.storage?.softQuotaBytes ? d.storage.totalBytes / d.storage.softQuotaBytes : null;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">{t("admin.nav.dashboard")}</h1>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t("admin.dash.users")} value={fmtNumber(d.users.total)} hint={t("admin.dash.newThisMonth", { count: fmtNumber(d.users.newThisMonth) })} />
        <StatCard label={t("admin.dash.activeWeek")} value={fmtNumber(d.users.activeWeek)} />
        <StatCard label={t("admin.dash.teachers")} value={fmtNumber(d.teachers)} hint={t("admin.dash.teachersHint")} />
        <StatCard label={t("admin.dash.students")} value={fmtNumber(d.students)} hint={t("admin.dash.studentsHint")} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {d.ai && budget && (
          <Panel title={t("admin.dash.aiTitle")} action={<Link href="/admin/ai" className="text-sm text-link underline-offset-4 hover:underline">{t("admin.common.viewDetails")}</Link>}>
            <div className="text-3xl font-semibold tabular-nums">{fmtUsd(d.ai.costUsd)}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t("admin.dash.aiTotals", { tokens: fmtCompact(d.ai.tokens), requests: fmtNumber(d.ai.requests) })}</p>
            {budget.budgetUsd ? (
              <div className="mt-4 space-y-1.5">
                <UsageBar ratio={budget.ratio} label={t("admin.ai.budgetUsed", { percent: fmtNumber((budget.ratio ?? 0) * 100) })} />
                <p className="text-xs text-muted-foreground">
                  {t("admin.dash.ofLimit", { used: fmtUsd(budget.spentUsd), limit: fmtUsd(budget.budgetUsd) })} · {t("admin.ai.budgetUsed", { percent: fmtNumber((budget.ratio ?? 0) * 100) })}
                </p>
              </div>
            ) : (
              <p className="mt-4 text-xs text-muted-foreground">{t("admin.dash.noBudget")}</p>
            )}
          </Panel>
        )}
        {d.storage && (
          <Panel title={t("admin.dash.storageTitle")} action={<Link href="/admin/storage" className="text-sm text-link underline-offset-4 hover:underline">{t("admin.common.viewDetails")}</Link>}>
            <div className="text-3xl font-semibold tabular-nums">{formatFileSize(d.storage.totalBytes)}</div>
            {d.storage.softQuotaBytes ? (
              <div className="mt-4 space-y-1.5">
                <UsageBar ratio={storageRatio} label={t("admin.dash.ofLimit", { used: formatFileSize(d.storage.totalBytes), limit: formatFileSize(d.storage.softQuotaBytes) })} />
                <p className="text-xs text-muted-foreground">{t("admin.dash.ofLimit", { used: formatFileSize(d.storage.totalBytes), limit: formatFileSize(d.storage.softQuotaBytes) })}</p>
              </div>
            ) : (
              <p className="mt-4 text-xs text-muted-foreground">{t("admin.dash.noQuota")}</p>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}
