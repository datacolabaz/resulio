import { Panel, StatCard } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/useMobile";
import { t, type MessageKey } from "@/i18n/messages";
import { fmtDuration, fmtRelative, typeLabel } from "@/lib/format";
import { PARTICIPANT_STATUS } from "@/lib/status";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { LucideIcon } from "lucide-react";
import { ChevronRight, ClipboardList, Eye } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "wouter";

type Activity = RouterOutputs["teacher"]["activity"];
type Card = Activity["cards"][number];
type PreviewRow = Card["preview"]["finished"][number];

const REFRESH_MS = 60_000;
const HOVER_DELAY_MS = 150;

/** Mutually exclusive buckets that add up to the participant total. */
function buckets(c: Card): { key: string; label: MessageKey; count: number; tone: keyof typeof TONE_TEXT; icon: LucideIcon }[] {
  const n = c.summary.counts;
  return [
    { key: "finished", ...PARTICIPANT_STATUS.COMPLETED, label: "activity.bucket.finished", count: n.COMPLETED + n.PENDING_REVIEW },
    { key: "progress", ...PARTICIPANT_STATUS.IN_PROGRESS, label: "activity.bucket.progress", count: n.IN_PROGRESS },
    { key: "inactive", ...PARTICIPANT_STATUS.INACTIVE, label: "activity.bucket.inactive", count: n.INACTIVE },
    { key: "expired", ...PARTICIPANT_STATUS.AUTO_SUBMITTED, label: "activity.bucket.expired", count: n.AUTO_SUBMITTED + n.EXPIRED_NO_ANSWERS },
    { key: "notStarted", ...PARTICIPANT_STATUS.NOT_STARTED, label: "activity.bucket.notStarted", count: n.NOT_STARTED + n.VIEWED },
  ];
}

const TONE_TEXT = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  info: "text-info",
  neutral: "text-neutral",
} as const;

function PreviewList({
  title,
  icon: Icon,
  tone,
  rows,
  total,
  line,
}: {
  title: string;
  icon: LucideIcon;
  tone: keyof typeof TONE_TEXT;
  rows: PreviewRow[];
  total: number;
  line: (r: PreviewRow) => string | null;
}) {
  if (!total) return null;
  return (
    <section className="space-y-1">
      <h4 className={`flex items-center gap-1.5 text-sm font-semibold ${TONE_TEXT[tone]}`}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="text-foreground">{t("activity.listTotal", { title, count: total })}</span>
      </h4>
      <ul className="space-y-0.5 pl-6 text-xs text-foreground-secondary">
        {rows.map((r) => {
          const extra = line(r);
          return (
            <li key={r.studentId} className="break-words">
              <span className="text-foreground">{r.name}</span>
              {extra && <> · {extra}</>}
            </li>
          );
        })}
        {total > rows.length && <li className="text-muted-foreground">{t("activity.more", { count: total - rows.length })}</li>}
      </ul>
    </section>
  );
}

function ActivityPanel({ c, now }: { c: Card; now: number }) {
  const n = c.summary.counts;
  const lastActive = (r: PreviewRow) => `${r.answeredCount}/${r.totalQuestionCount} · ${t("activity.lastActivityInline", { when: fmtRelative(r.lastActivityAt, now) })}`;
  return (
    <div className="space-y-3">
      <PreviewList
        title={t("activity.list.finished")}
        {...PARTICIPANT_STATUS.COMPLETED}
        rows={c.preview.finished}
        total={n.COMPLETED + n.PENDING_REVIEW + n.AUTO_SUBMITTED}
        line={(r) => [fmtRelative(r.submittedAt, now), r.percentage !== null ? `${r.percentage}%` : null].filter(Boolean).join(" · ")}
      />
      <PreviewList title={t("activity.list.inProgress")} {...PARTICIPANT_STATUS.IN_PROGRESS} rows={c.preview.inProgress} total={n.IN_PROGRESS} line={lastActive} />
      <PreviewList title={t("activity.list.inactive")} {...PARTICIPANT_STATUS.INACTIVE} rows={c.preview.inactive} total={n.INACTIVE} line={lastActive} />
      <PreviewList title={t("activity.list.notStarted")} {...PARTICIPANT_STATUS.NOT_STARTED} rows={c.preview.notStarted} total={n.NOT_STARTED + n.VIEWED} line={() => null} />
      <PreviewList title={t("activity.list.expired")} {...PARTICIPANT_STATUS.EXPIRED_NO_ANSWERS} rows={c.preview.expired} total={n.EXPIRED_NO_ANSWERS} line={() => null} />
      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button asChild size="sm" variant="outline">
          <Link href={`/teacher/assessments/${c.id}?tab=results`}>{t("activity.viewResults")}</Link>
        </Button>
        <Button asChild size="sm">
          <Link href={`/teacher/assessments/${c.id}/participants`}>{t("activity.showParticipants")}</Link>
        </Button>
      </div>
    </div>
  );
}

/** Counts are plain content (always readable); details open from an explicit button, or on hover with a mouse. */
function StatusArea({ c, now }: { c: Card; now: number }) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const byHover = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = useId();
  const total = c.summary.total;
  const finished = c.summary.finished;
  const pct = total ? Math.round((finished / total) * 100) : 0;

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const hover = (next: boolean) => {
    if (mobile) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next && !open) byHover.current = true;
      if (next || byHover.current) setOpen(next);
    }, HOVER_DELAY_MS);
  };

  const summary = (
    <div className="rounded-xl p-2" onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-foreground-secondary">
        <span>{t("activity.ofParticipants", { count: total })}</span>
        <span className="font-medium text-foreground">{t("activity.finishedOf", { done: finished, total })}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t("activity.finishedBar")}>
        <div className="h-full rounded-full bg-link" style={{ width: `${pct}%` }} />
      </div>
      <ul id={listId} aria-label={t("activity.bucketsLabel")} className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-3 gap-y-1.5 text-sm">
        {buckets(c).map((b) => (
          <li key={b.key} className={`flex items-start gap-1.5 ${b.count ? "" : "text-muted-foreground"}`}>
            <b.icon className={`mt-0.5 h-4 w-4 shrink-0 ${b.count ? TONE_TEXT[b.tone] : ""}`} aria-hidden />
            <span className="w-6 shrink-0 text-right font-semibold tabular-nums">{b.count}</span>
            <span className="min-w-0 break-words leading-snug">{t(b.label)}</span>
          </li>
        ))}
        <li className="flex items-start gap-1.5 text-foreground-secondary">
          <Eye className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="w-6 shrink-0 text-right font-semibold tabular-nums">{c.summary.viewed}</span>
          <span className="min-w-0 break-words leading-snug">{t("activity.bucket.viewed")}</span>
        </li>
      </ul>
    </div>
  );

  const detailsButton = (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto px-2 py-1 text-xs text-link"
      aria-label={t("activity.detailsFor", { title: c.title })}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => {
        byHover.current = false;
        setOpen((v) => !v);
      }}
    >
      {t("activity.details")} <ChevronRight className="h-3 w-3" aria-hidden />
    </Button>
  );

  if (mobile) {
    return (
      <>
        {summary}
        {detailsButton}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[80dvh] rounded-t-2xl">
            <SheetHeader>
              <SheetTitle>{c.title}</SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-6">
              <ActivityPanel c={c} now={now} />
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        if (!v) byHover.current = false;
        setOpen(v);
      }}
    >
      <PopoverAnchor asChild>{summary}</PopoverAnchor>
      <PopoverTrigger asChild>{detailsButton}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)] rounded-2xl shadow-overlay"
        aria-label={t("activity.detailsFor", { title: c.title })}
        onOpenAutoFocus={(e) => byHover.current && e.preventDefault()}
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
      >
        <div className="mb-2 font-semibold">{c.title}</div>
        <ActivityPanel c={c} now={now} />
      </PopoverContent>
    </Popover>
  );
}

function AssessmentActivityCard({ c, now }: { c: Card; now: number }) {
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-2">
        <ClipboardList className="mt-0.5 h-5 w-5 shrink-0 text-link" aria-hidden />
        <div className="min-w-0">
          <h3 className="font-semibold">
            <Link href={`/teacher/assessments/${c.id}`} className="line-clamp-2 break-words hover:underline" title={c.title}>{c.title}</Link>
          </h3>
          <div className="text-xs text-muted-foreground">
            {typeLabel(c.type)} · {fmtDuration(c.durationSeconds)}{c.status === "CLOSED" ? ` · ${t("activity.closed")}` : ""}
          </div>
        </div>
      </div>
      <div className="mt-3 flex-1">
        <StatusArea c={c} now={now} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-foreground-secondary">
        <span>{t("activity.average", { value: c.summary.averagePercentage !== null ? `${c.summary.averagePercentage}%` : "—" })}</span>
        <span>{t("activity.lastActivity", { when: fmtRelative(c.summary.latestActivityAt, now) })}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href={`/teacher/assessments/${c.id}?tab=results`}>{t("common.results")}</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`/teacher/assessments/${c.id}?tab=analytics`}>{t("common.analytics")}</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`/teacher/assessments/${c.id}/participants`}>{t("common.participants")}</Link>
        </Button>
      </div>
    </article>
  );
}

/** Today's totals and per-assessment activity cards for the teacher dashboard. */
export function AssessmentActivity() {
  const q = trpc.teacher.activity.useQuery(undefined, { refetchInterval: REFRESH_MS });
  const d = q.data;
  if (!d) return null;
  const now = new Date(d.serverNow).getTime() + (Date.now() - q.dataUpdatedAt);
  return (
    <div className="space-y-4">
      <section aria-labelledby="today-status">
        <h2 id="today-status" className="mb-3 font-semibold">{t("activity.today")}</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t("activity.activeExams")} value={d.totals.activeAssessments} />
          <StatCard label={t("activity.inProgressNow")} value={d.totals.inProgressNow} />
          <StatCard label={t("activity.inactiveSessions")} value={d.totals.inactiveNow} hint={t("activity.inactiveHint")} />
          <StatCard label={t("activity.pendingReview")} value={d.totals.pendingReview} />
        </div>
      </section>
      {d.cards.length > 0 && (
        <Panel
          title={t("activity.panel")}
          action={<Link href="/teacher/assessments" className="text-sm text-link underline-offset-4 hover:underline">{t("common.all")}</Link>}
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {d.cards.map((c) => (
              <AssessmentActivityCard key={c.id} c={c} now={now} />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
