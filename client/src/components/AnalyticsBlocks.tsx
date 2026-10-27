import { ResponsiveTable, type ResponsiveColumn } from "@/components/ResponsiveTable";
import { t } from "@/i18n/messages";
import { fmtDuration, questionTypeLabel } from "@/lib/format";
import { MIN_QUESTION_SAMPLE } from "@shared/assessment";
import { Flag, TrendingDown, TrendingUp } from "lucide-react";
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
    <ResponsiveTable
      rows={rows}
      rowKey={(r) => `${r.studentId}-${r.resultId ?? ""}`}
      columns={[
        { key: "rank", header: "#", thClassName: "py-2", tdClassName: "py-2 font-semibold", card: "title", cell: (r) => r.rank, cardCell: (r) => <span className="text-muted-foreground">{r.rank}.</span> },
        { key: "student", header: t("common.student"), card: "title", cell: (r) => r.studentName ?? "—" },
        { key: "result", header: t("common.result"), tdClassName: "font-semibold", card: "aside", cell: (r) => `${r.percentage}%`, cardCell: (r) => <span className="font-semibold">{r.percentage}%</span> },
        { key: "duration", header: t("common.duration"), tdClassName: "text-muted-foreground", cell: (r) => fmtDuration(r.durationSeconds) },
        {
          key: "view",
          header: t("common.view"),
          srOnlyHeader: true,
          tdClassName: "text-right",
          card: "action",
          cell: (r) => (
            <>
              {r.pendingReviewCount ? <span className="mr-2 text-xs text-warning">{t("common.inReview")}</span> : null}
              {resultLink && r.resultId && <Link href={`/teacher/results/${r.resultId}`} className="text-link underline-offset-4 hover:underline">{t("common.view")}</Link>}
            </>
          ),
        },
      ]}
    />
  );
}

export function QuestionStatsTable({
  rows,
  onToggleFlag,
  flagPending,
}: {
  rows: {
    questionId: string;
    sourceQuestionId?: string | null;
    position?: number;
    text: string;
    type?: string;
    topic: string;
    attempts: number;
    accuracyPercentage: number;
    wrongPercentage: number;
    unansweredPercentage: number;
    flagged?: boolean;
  }[];
  /** When given, a flag/unflag action is shown per row that has a `sourceQuestionId` (a live bank question). */
  onToggleFlag?: (q: { sourceQuestionId: string; flagged: boolean }) => void;
  flagPending?: boolean;
}) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{t("common.noData")}</p>;
  const accuracy = (q: (typeof rows)[number]) => (
    <span className={q.accuracyPercentage < 50 ? "font-semibold text-destructive" : "font-semibold"}>
      {q.accuracyPercentage < 50 && <TrendingDown className="mr-1 inline h-3.5 w-3.5" aria-label={t("analytics.weak")} />}
      {q.accuracyPercentage}%
    </span>
  );
  const columns: ResponsiveColumn<(typeof rows)[number]>[] = [
    {
      key: "question",
      header: t("common.question"),
      thClassName: "py-2",
      tdClassName: "max-w-md py-2",
      card: "title",
      cell: (q) => (
        <>
          <div className="line-clamp-2 font-normal" title={q.text}>{q.position ? `${q.position}. ` : ""}{q.text}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs font-normal text-muted-foreground">
            {q.type && <span>{questionTypeLabel(q.type)}</span>}
            {q.flagged && (
              <span className="inline-flex items-center gap-1 font-medium text-warning" title={t("assessment.flaggedHint")}>
                <Flag className="h-3 w-3" aria-hidden />
                {t("assessment.flagged")}
              </span>
            )}
            {!q.flagged && q.attempts < MIN_QUESTION_SAMPLE && (
              <span>{t("assessment.insufficientSample", { count: MIN_QUESTION_SAMPLE })}</span>
            )}
          </div>
        </>
      ),
    },
    { key: "topic", header: t("common.topic"), tdClassName: "text-muted-foreground", cell: (q) => q.topic || "—" },
    { key: "answers", header: t("analytics.col.answers"), cell: (q) => q.attempts },
    { key: "correct", header: t("common.correct"), cell: accuracy },
    { key: "wrong", header: t("common.wrong"), cell: (q) => `${q.wrongPercentage}%` },
    { key: "unanswered", header: t("common.unanswered"), cell: (q) => `${q.unansweredPercentage}%` },
  ];
  if (onToggleFlag) {
    columns.push({
      key: "flag",
      header: t("common.view"),
      srOnlyHeader: true,
      tdClassName: "text-right",
      card: "action",
      cell: (q) =>
        q.sourceQuestionId ? (
          <button
            type="button"
            disabled={flagPending}
            onClick={() => onToggleFlag({ sourceQuestionId: q.sourceQuestionId!, flagged: !q.flagged })}
            className="text-xs text-link underline-offset-4 hover:underline disabled:opacity-50"
          >
            {q.flagged ? t("assessment.unflagQuestion") : t("assessment.flagQuestion")}
          </button>
        ) : null,
    });
  }
  return <ResponsiveTable rows={rows} rowKey={(q) => q.questionId} columns={columns} />;
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
