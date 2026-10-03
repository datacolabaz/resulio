import { t } from "@/i18n/messages";
import { fmtDuration, questionTypeLabel } from "@/lib/format";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Link } from "wouter";

/** Chart chrome drawn from theme tokens so both themes stay readable. */
export const AXIS = { fontSize: 11, tick: { fill: "var(--muted-foreground)" }, stroke: "var(--border-strong)" } as const;
export const TOOLTIP = {
  contentStyle: { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--popover-foreground)" },
  labelStyle: { color: "var(--popover-foreground)" },
  itemStyle: { color: "var(--popover-foreground)" },
  cursor: { fill: "var(--muted)" },
} as const;

export function DistributionChart({ data }: { data: { from: number; to: number; count: number }[] }) {
  const summary = data.map((d) => `${d.from}–${d.to}: ${d.count}`).join(", ");
  return (
    <figure className="h-56" role="img" aria-label={`${t("assessment.distribution")}. ${summary}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data.map((d) => ({ label: `${d.from}–${d.to}`, count: d.count }))}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" {...AXIS} />
          <YAxis allowDecimals={false} width={28} {...AXIS} />
          <Tooltip {...TOOLTIP} />
          <Bar dataKey="count" name={t("analytics.chartStudents")} fill="var(--chart-1)" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function ProgressChart({ data }: { data: { label: string; value: number }[] }) {
  const summary = data.map((d) => `${d.label}: ${d.value}%`).join(", ");
  return (
    <figure className="h-56" role="img" aria-label={`${t("analytics.chartScore")}. ${summary}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" {...AXIS} />
          <YAxis domain={[0, 100]} width={32} {...AXIS} />
          <Tooltip {...TOOLTIP} cursor={{ stroke: "var(--border-strong)" }} />
          <Line type="monotone" dataKey="value" name="%" stroke="var(--chart-1)" strokeWidth={2} dot={{ fill: "var(--chart-1)" }} />
        </LineChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function RankingTable({
  rows,
  resultLink = true,
}: {
  rows: { rank: number; resultId?: string; studentId: number; studentName: string | null; percentage: number; durationSeconds: number; pendingReviewCount?: number }[];
  resultLink?: boolean;
}) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{t("common.noResults")}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th scope="col" className="py-2">#</th>
            <th scope="col">{t("common.student")}</th>
            <th scope="col">{t("common.result")}</th>
            <th scope="col">{t("common.duration")}</th>
            <th scope="col"><span className="sr-only">{t("common.view")}</span></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={`${r.studentId}-${r.resultId ?? ""}`}>
              <td className="py-2 font-semibold">{r.rank}</td>
              <td>{r.studentName ?? "—"}</td>
              <td className="font-semibold">{r.percentage}%</td>
              <td className="text-muted-foreground">{fmtDuration(r.durationSeconds)}</td>
              <td className="text-right">
                {r.pendingReviewCount ? <span className="mr-2 text-xs text-warning">{t("common.inReview")}</span> : null}
                {resultLink && r.resultId && <Link href={`/teacher/results/${r.resultId}`} className="text-link underline-offset-4 hover:underline">{t("common.view")}</Link>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function QuestionStatsTable({
  rows,
}: {
  rows: { questionId: string; position?: number; text: string; type?: string; topic: string; attempts: number; accuracyPercentage: number; wrongPercentage: number; unansweredPercentage: number }[];
}) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{t("common.noData")}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th scope="col" className="py-2">{t("common.question")}</th>
            <th scope="col">{t("common.topic")}</th>
            <th scope="col">{t("analytics.col.answers")}</th>
            <th scope="col">{t("common.correct")}</th>
            <th scope="col">{t("common.wrong")}</th>
            <th scope="col">{t("common.unanswered")}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((q) => (
            <tr key={q.questionId}>
              <td className="max-w-md py-2">
                <div className="line-clamp-2" title={q.text}>{q.position ? `${q.position}. ` : ""}{q.text}</div>
                {q.type && <div className="text-xs text-muted-foreground">{questionTypeLabel(q.type)}</div>}
              </td>
              <td className="text-muted-foreground">{q.topic || "—"}</td>
              <td>{q.attempts}</td>
              <td className={q.accuracyPercentage < 50 ? "font-semibold text-destructive" : "font-semibold"}>
                {q.accuracyPercentage < 50 && <TrendingDown className="mr-1 inline h-3.5 w-3.5" aria-label={t("analytics.weak")} />}
                {q.accuracyPercentage}%
              </td>
              <td>{q.wrongPercentage}%</td>
              <td>{q.unansweredPercentage}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TopicBars({ rows, empty }: { rows: { topic: string; questionCount: number; accuracyPercentage: number; classification: string }[]; empty?: string }) {
  const visible = rows.filter((r) => r.topic !== "—");
  if (!visible.length) return <p className="text-sm text-muted-foreground">{empty ?? t("common.noData")}</p>;
  return (
    <ul className="space-y-3">
      {visible.map((r) => {
        const weak = r.classification === "WEAK";
        const strong = r.classification === "STRONG";
        return (
          <li key={r.topic}>
            <div className="flex flex-wrap justify-between gap-x-3 text-sm">
              <span className="min-w-0 break-words">
                {r.topic} <span className="text-xs text-muted-foreground">({r.questionCount})</span>
              </span>
              <span className="flex items-center gap-1.5 font-semibold">
                {weak && <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive"><TrendingDown className="h-3.5 w-3.5" aria-hidden />{t("analytics.weak")}</span>}
                {strong && <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><TrendingUp className="h-3.5 w-3.5" aria-hidden />{t("analytics.strong")}</span>}
                {r.accuracyPercentage}%
              </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-muted" aria-hidden>
              <div className={`h-2 rounded-full ${weak ? "bg-destructive" : strong ? "bg-success" : "bg-brand"}`} style={{ width: `${Math.max(2, r.accuracyPercentage)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
