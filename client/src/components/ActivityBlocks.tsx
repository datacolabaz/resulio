import { AXIS, TOOLTIP } from "@/components/AnalyticsBlocks";
import { t } from "@/i18n/messages";
import { fmtDayKeyShort } from "@/lib/format";
import { Medal, Trophy } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/** Opens and submissions per calendar day. */
export function ActivityChart({ data }: { data: { day: string; opens: number; submissions: number }[] }) {
  const rows = data.map((d) => ({ ...d, label: fmtDayKeyShort(d.day) }));
  const opens = data.reduce((s, d) => s + d.opens, 0);
  const submissions = data.reduce((s, d) => s + d.submissions, 0);
  return (
    <figure className="h-60" role="img" aria-label={t("motivation.chartSummary", { opens, submissions, days: data.length })}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={12} />
          <YAxis allowDecimals={false} width={28} {...AXIS} />
          <Tooltip {...TOOLTIP} />
          <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted-foreground)" }} />
          <Bar dataKey="opens" name={t("motivation.opens")} fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="submissions" name={t("motivation.submissions")} fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function PlaceBadge({ place }: { place: number }) {
  const Icon = place === 1 ? Trophy : Medal;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${place === 1 ? "border-warning/40 bg-warning-surface text-warning" : "border-border bg-muted text-foreground-secondary"}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {t("motivation.place", { place })}
    </span>
  );
}

/** "Who turned it in first" for one task: up to three names with their place. */
export function FirstSubmittersList({ items }: { items: { place: number; name: string | null; isYou?: boolean }[] }) {
  if (!items.length) return <p className="text-xs text-muted-foreground">{t("motivation.noSubmissionsYet")}</p>;
  return (
    <ol className="flex flex-wrap gap-x-3 gap-y-1.5">
      {items.map((f) => (
        <li key={f.place} className="flex min-w-0 items-center gap-1.5 text-sm">
          <PlaceBadge place={f.place} />
          <span className={`min-w-0 break-words ${f.isYou ? "font-semibold" : ""}`}>
            {f.name ?? t("common.student")}
            {f.isYou && <span className="ml-1 text-xs text-muted-foreground">{t("motivation.you")}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
