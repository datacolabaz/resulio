import { DistributionChart, QuestionStatsTable, RankingTable, TopicBars } from "@/components/AnalyticsBlocks";
import { AppShell, ChoiceChip, EmptyState, ErrorNote, Loading, Panel, Pill, StatCard } from "@/components/AppShell";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ResponsiveTable";
import { ShareBox, ShareFunnelSummary } from "@/components/ShareBox";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { t, type MessageKey } from "@/i18n/messages";
import {
  answerText,
  errorText,
  fmtDateTime,
  fmtDuration,
  fmtWindow,
  liveLabel,
  questionTypeLabel,
  releaseLabel,
  reviewLabel,
  typeLabel,
} from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { liveStatus, VERSION_STATUS } from "@/lib/status";
import { ParticipantsReport } from "@/pages/teacher/Participants";
import { attemptLabel, earlierVariantRows, variantLabel } from "@/lib/attemptLabel";
import { Info, PencilLine, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams, useSearch } from "wouter";

const STATUS_FILTERS: { value: "" | "DRAFT" | "SCHEDULED" | "ACTIVE" | "COMPLETED"; label: MessageKey }[] = [
  { value: "", label: "common.all" },
  { value: "DRAFT", label: "live.DRAFT" },
  { value: "SCHEDULED", label: "live.SCHEDULED" },
  { value: "ACTIVE", label: "live.ACTIVE" },
  { value: "COMPLETED", label: "live.COMPLETED" },
];

const linkClass = "text-link underline-offset-4 hover:underline";

export function AssessmentsPage() {
  const search = new URLSearchParams(useSearch());
  const [, nav] = useLocation();
  const type = (search.get("type") ?? "") as "" | "EXAM" | "KSQ" | "BSQ";
  const status = (search.get("status") ?? "") as "" | "DRAFT" | "SCHEDULED" | "ACTIVE" | "COMPLETED";
  const list = trpc.teacher.assessments.list.useQuery({ type: type || undefined, liveStatus: status || undefined });

  const setFilter = (key: "type" | "status", value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    nav(`/teacher/assessments${qs ? `?${qs}` : ""}`);
  };

  return (
    <AppShell area="teaching">
      <div className="space-y-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("assessment.filter.status")}>
            {STATUS_FILTERS.map((f) => (
              <ChoiceChip key={f.value} selected={status === f.value} onClick={() => setFilter("status", f.value)}>{t(f.label)}</ChoiceChip>
            ))}
            {type && (
              <ChoiceChip selected onClick={() => setFilter("type", "")} aria-label={t("assessment.filter.removeType", { type: typeLabel(type) })}>
                {t("assessment.filter.type", { type: typeLabel(type) })} <X className="h-3.5 w-3.5" aria-hidden />
              </ChoiceChip>
            )}
          </div>
          <Button asChild>
            <Link href={`/teacher/assessments/new${type ? `?type=${type}` : ""}`}>{t("common.new")}</Link>
          </Button>
        </div>

        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <EmptyState title={t("assessment.empty")} body={t("assessment.emptyBody")} />
        ) : (
          <ResponsiveTable
            rows={list.data}
            rowKey={(a) => a.id}
            className="relative overflow-x-auto rounded-2xl border bg-card"
            headClassName="border-b bg-muted text-left text-xs uppercase text-muted-foreground"
            rowClassName={() => "hover:bg-muted"}
            cardsClassName="divide-y rounded-2xl border bg-card px-4"
            columns={[
              {
                key: "title",
                header: t("common.name"),
                thClassName: "px-4 py-3",
                tdClassName: "px-4 py-3",
                card: "title",
                cell: (a) => (
                  <>
                    <Link href={`/teacher/assessments/${a.id}`} className="font-medium hover:underline">{a.title}</Link>
                    {a.hasDraftChanges && a.currentVersionId && <div className="text-xs font-normal text-warning">{t("assessment.unpublishedChanges")}</div>}
                  </>
                ),
              },
              { key: "type", header: t("common.type"), cell: (a) => typeLabel(a.type) },
              { key: "status", header: t("common.status"), card: "aside", cell: (a) => <StatusBadge {...liveStatus(a.liveStatus)}>{liveLabel(a.liveStatus)}</StatusBadge> },
              { key: "window", header: t("assessment.col.window"), tdClassName: "text-muted-foreground", cell: (a) => fmtWindow(a.startAt, a.endAt) },
              { key: "duration", header: t("common.duration"), tdClassName: "text-muted-foreground", cell: (a) => fmtDuration(a.durationSeconds) },
              {
                key: "edit",
                header: t("common.edit"),
                srOnlyHeader: true,
                tdClassName: "pr-4 text-right",
                card: "action",
                cell: (a) => <Link href={`/teacher/assessments/${a.id}/edit`} className={linkClass}>{t("common.edit")}</Link>,
              },
            ]}
          />
        )}
      </div>
    </AppShell>
  );
}

export function AssessmentDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const utils = trpc.useUtils();
  const detail = trpc.teacher.assessments.detail.useQuery({ id });
  const initialTab = new URLSearchParams(useSearch()).get("tab");
  const [tab, setTab] = useState(initialTab ?? "overview");
  const [publishOpen, setPublishOpen] = useState(false);
  const publish = trpc.teacher.assessments.publish.useMutation({
    onSuccess: (v) => {
      toast.success(!v.created ? t("assessment.noChangesKept") : v.versionNo === 1 ? t("assessment.publishedFirstToast") : t("assessment.changesSentToast"));
      setPublishOpen(false);
      void utils.teacher.assessments.detail.invalidate({ id });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const close = trpc.teacher.assessments.close.useMutation({
    onSuccess: () => utils.teacher.assessments.detail.invalidate({ id }),
    onError: (e) => toast.error(errorText(e)),
  });
  const a = detail.data;
  const shareFunnelQ = trpc.teacher.assessments.shareFunnel.useQuery({ id }, { enabled: Boolean(a?.currentVersionId) });
  const yesNo = (v: boolean) => (v ? t("common.yes") : t("common.no"));

  return (
    <AppShell area="teaching" title={a?.title}>
      {detail.error ? (
        <ErrorNote error={detail.error} />
      ) : !a ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Pill>{typeLabel(a.type)}</Pill>
              <StatusBadge {...liveStatus(a.liveStatus)}>{liveLabel(a.liveStatus)}</StatusBadge>
              {a.hasDraftChanges && a.currentVersionId && <StatusBadge tone="info" icon={PencilLine}>{t("assessment.unpublishedPill")}</StatusBadge>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href={`/teacher/assessments/${a.id}/edit`}>{t("common.editFull")}</Link>
              </Button>
              {a.status !== "CLOSED" && (a.hasDraftChanges || !a.currentVersionId) && (
                <Button onClick={() => setPublishOpen(true)}>{a.currentVersionId ? t("assessment.publishNew") : t("assessment.publish")}</Button>
              )}
              {a.status === "PUBLISHED" && (
                <Button variant="outline" onClick={() => confirm(t("assessment.closeConfirm")) && close.mutate({ id })}>{t("common.close")}</Button>
              )}
            </div>
          </div>

          <Tabs value={tab} onValueChange={setTab} className="min-h-screen">
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="overview">{t("assessment.tab.overview")}</TabsTrigger>
              <TabsTrigger value="questions">{t("assessment.tab.questions", { count: a.questions.length })}</TabsTrigger>
              <TabsTrigger value="participants">{t("common.participants")}</TabsTrigger>
              <TabsTrigger value="results">{t("common.results")}</TabsTrigger>
              <TabsTrigger value="analytics">{t("common.analytics")}</TabsTrigger>
              <TabsTrigger value="versions">{t("assessment.tab.versions")}</TabsTrigger>
              <TabsTrigger value="settings">{t("common.settings")}</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-5 pt-3">
              <OverviewStats id={a.id} enabled={Boolean(a.currentVersionId)} />
              <div className="grid gap-5 lg:grid-cols-2">
                <Panel title={t("assessment.rules")}>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">{t("assessment.col.window")}</dt><dd>{fmtWindow(a.startAt, a.endAt)}</dd>
                    <dt className="text-muted-foreground">{t("common.duration")}</dt><dd>{fmtDuration(a.settings.durationSeconds)}</dd>
                    <dt className="text-muted-foreground">{t("assessment.attemptsAllowed")}</dt><dd>{a.settings.attemptsAllowed}</dd>
                    <dt className="text-muted-foreground">{t("common.result")}</dt><dd>{releaseLabel(a.settings.releaseMode)}</dd>
                    <dt className="text-muted-foreground">{t("assessment.reviewMode")}</dt><dd>{reviewLabel(a.settings.reviewMode)}</dd>
                  </dl>
                </Panel>
                <Panel title={t("assessment.sharing")}>
                  {a.currentVersionId ? (
                    <>
                      <ShareBox
                        path={`/exam/${a.shareCode}`}
                        fileName={`resulio-${a.shareCode}`}
                        tracking={{ targetType: "EXAM", targetId: a.shareCode, campaign: "exam_share" }}
                        onTracked={() => void shareFunnelQ.refetch()}
                      />
                      <ShareFunnelSummary data={shareFunnelQ.data} />
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("assessment.linkAfterPublish")}</p>
                  )}
                  <p className="mt-3 text-xs text-muted-foreground">{t("assessment.linkAssignedOnly")}</p>
                </Panel>
              </div>
            </TabsContent>

            <TabsContent value="questions" className="pt-3">
              <Panel
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/teacher/assessments/${a.id}/edit?step=questions`}>{t("assessment.editQuestions")}</Link>
                  </Button>
                }
              >
                {a.questions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("assessment.noQuestions")}</p>
                ) : (
                  <ol className="space-y-3">
                    {a.questions.map((q, i) => (
                      <li key={q.id} className="rounded-xl border p-3">
                        <div className="flex flex-wrap justify-between gap-3 text-xs text-muted-foreground">
                          <span>{i + 1}. {questionTypeLabel(q.type)} · {q.topic || t("common.noTopic")}{q.skill ? ` · ${q.skill}` : ""}</span>
                          <span>{t("common.points", { count: q.points })}</span>
                        </div>
                        <div className="mt-1 whitespace-pre-wrap break-words text-sm">{q.text}</div>
                        <div className="mt-1 text-xs text-success">{t("assessment.answerKey", { value: answerKeyText(q) })}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>
            </TabsContent>

            <TabsContent value="participants" className="space-y-5 pt-3">
              {a.currentVersionId && <ParticipantsReport id={a.id} />}
              <Panel
                title={t("assessment.assignments")}
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/teacher/assessments/${a.id}/edit?step=participants`}>{t("common.change")}</Link>
                  </Button>
                }
              >
                {a.assignments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("assessment.noAssignments")}</p>
                ) : (
                  <ResponsiveTable
                    rows={a.assignments}
                    rowKey={(r) => r.id}
                    columns={[
                      {
                        key: "to",
                        header: t("assessment.col.to"),
                        thClassName: "py-2",
                        tdClassName: "py-2",
                        card: "title",
                        cell: (r) => (r.groupId ? t("assessment.toGroup", { name: r.label }) : t("assessment.toStudent", { name: r.label })),
                      },
                      {
                        key: "version",
                        header: t("assessment.col.version"),
                        cell: (r) => (!r.versionNo ? t("assessment.afterPublish") : r.versionNo === a.versions[0]?.versionNo ? t("assessment.variantLatest") : t("attempt.earlierVariantShort")),
                      },
                      {
                        key: "window",
                        header: t("assessment.col.customWindow"),
                        tdClassName: "text-muted-foreground",
                        cell: (r) => (r.availableFrom || r.availableUntil ? fmtWindow(r.availableFrom, r.availableUntil) : t("assessment.default")),
                      },
                      {
                        key: "duration",
                        header: t("common.duration"),
                        tdClassName: "text-muted-foreground",
                        cell: (r) => (r.durationOverrideSeconds ? fmtDuration(r.durationOverrideSeconds) : t("assessment.default")),
                      },
                      { key: "attempts", header: t("common.attempt"), tdClassName: "text-muted-foreground", cell: (r) => r.attemptLimitOverride ?? t("assessment.default") },
                    ]}
                  />
                )}
              </Panel>
            </TabsContent>

            <TabsContent value="results" className="pt-3">
              <AssessmentResults id={a.id} />
            </TabsContent>

            <TabsContent value="analytics" className="pt-3">
              <AssessmentAnalytics id={a.id} />
            </TabsContent>

            <TabsContent value="versions" className="pt-3">
              <Panel>
                {a.versions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("assessment.notPublishedYet")}</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {a.versions.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                        <span className="font-medium">{variantLabel(v.versionNo)}</span>
                        <span className="text-muted-foreground">{fmtDateTime(v.publishedAt)}</span>
                        <StatusBadge {...(VERSION_STATUS[v.status] ?? VERSION_STATUS.ARCHIVED)}>
                          {v.status === "PUBLISHED" ? t("assessment.versionCurrent") : t("assessment.versionArchived")}
                        </StatusBadge>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-xs text-muted-foreground">{t("assessment.versionsImmutable")}</p>
              </Panel>
            </TabsContent>

            <TabsContent value="settings" className="pt-3">
              <Panel
                title={t("common.settings")}
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/teacher/assessments/${a.id}/edit?step=rules`}>{t("common.change")}</Link>
                  </Button>
                }
              >
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">{t("common.subject")}</dt><dd>{a.settings.subject || "—"}</dd>
                  <dt className="text-muted-foreground">{t("assessment.shuffle")}</dt><dd>{yesNo(a.settings.randomize)}</dd>
                  <dt className="text-muted-foreground">{t("assessment.showCorrect")}</dt><dd>{yesNo(a.settings.showCorrectAnswers)}</dd>
                  <dt className="text-muted-foreground">{t("assessment.showExplanations")}</dt><dd>{yesNo(a.settings.showExplanations)}</dd>
                  <dt className="text-muted-foreground">{t("assessment.timezone")}</dt><dd>{a.timezone}</dd>
                </dl>
              </Panel>
            </TabsContent>
          </Tabs>

          <PublishDialog
            open={publishOpen}
            onOpenChange={setPublishOpen}
            republish={Boolean(a.currentVersionId)}
            busy={publish.isPending}
            onConfirm={(moveAssignments) => publish.mutate({ id, moveAssignments })}
          />
        </div>
      )}
    </AppShell>
  );
}

export function PublishDialog({
  open,
  onOpenChange,
  republish,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  republish: boolean;
  busy: boolean;
  onConfirm: (moveAssignments: boolean) => void;
}) {
  const [move, setMove] = useState(true);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{republish ? t("assessment.publishNew") : t("assessment.publish")}</DialogTitle>
          <DialogDescription>{republish ? t("assessment.publishChangesBody") : t("assessment.publishFirstBody")}</DialogDescription>
        </DialogHeader>
        {republish && (
          <label className="flex items-start gap-2 rounded-xl border p-3 text-sm text-foreground-secondary">
            <input type="checkbox" className="mt-1 accent-link" checked={move} onChange={(e) => setMove(e.target.checked)} />
            <span>
              <span className="font-medium text-foreground">{t("assessment.moveAssignments")}</span>
              <span className="block text-xs">{t("assessment.moveAssignmentsNote")}</span>
            </span>
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={busy} onClick={() => onConfirm(republish ? move : false)}>{t("assessment.publish")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function answerKeyText(q: { type: string; content: unknown; answerKey: unknown }): string {
  const c = (q.content ?? {}) as Record<string, any>;
  const k = (q.answerKey ?? {}) as Record<string, any>;
  switch (q.type) {
    case "MULTIPLE_CHOICE":
    case "MULTIPLE_SELECT":
      return answerText(k.correct, { options: c.options });
    case "TRUE_FALSE":
      return k.correct ? t("common.true") : t("common.false");
    case "SHORT_ANSWER":
      return (k.accepted ?? []).join(" / ");
    case "LONG_ANSWER":
      return k.rubric ? t("assessment.rubric", { value: k.rubric }) : t("assessment.manualGrading");
    case "MATCHING":
      return answerText(k.pairs, { left: c.left, right: c.right });
    case "ORDERING":
      return answerText(k.order, { items: c.items });
    case "FILL_BLANK":
      return (k.blanks ?? []).map((b: string[]) => b.join("/")).join(" | ");
    case "NUMERIC":
      return `${k.value}${k.tolerance ? ` ± ${k.tolerance}` : ""}${c.unit ? ` ${c.unit}` : ""}`;
    default:
      return "—";
  }
}

function OverviewStats({ id, enabled }: { id: string; enabled: boolean }) {
  const stats = trpc.teacher.analytics.assessment.useQuery({ id }, { enabled });
  const s = stats.data;
  if (!enabled || !s) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label={t("common.participation")} value={`${s.participationRate}%`} hint={t("assessment.stat.completedOf", { done: s.completedCount, total: s.assignedCount })} />
      <StatCard label={t("home.averageScore")} value={`${s.averageScore}%`} hint={t("assessment.stat.medianHint", { value: `${s.medianScore}%` })} />
      <StatCard label={t("assessment.stat.highLow")} value={`${s.highestScore}% / ${s.lowestScore}%`} />
      <StatCard
        label={t("assessment.stat.avgDuration")}
        value={fmtDuration(s.averageDurationSeconds)}
        hint={s.pendingReviewCount ? t("common.pendingReviewCount", { count: s.pendingReviewCount }) : undefined}
      />
    </div>
  );
}

function AssessmentResults({ id }: { id: string }) {
  const list = trpc.teacher.results.list.useQuery({ assessmentId: id });
  const csv = trpc.useUtils().teacher.assessments.csv;
  const download = async () => {
    const text = await csv.fetch({ id });
    const blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `resulio-${id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Panel action={<Button size="sm" variant="outline" onClick={() => void download()}>{t("assessment.downloadCsv")}</Button>}>
      {!list.data?.length ? <p className="text-sm text-muted-foreground">{t("common.noResults")}</p> : <ResultsTable rows={list.data} />}
    </Panel>
  );
}

export function ResultsTable({
  rows,
  showAssessment = false,
}: {
  rows: {
    id: string;
    assessmentId: string;
    assessmentTitle: string;
    studentId: number;
    studentName: string | null;
    attemptNo: number;
    versionId: string;
    latestVariant: boolean;
    autoSubmitted: boolean;
    percentage: number;
    pendingReviewCount: number;
    durationSeconds: number;
    completedAt: Date;
  }[];
  showAssessment?: boolean;
}) {
  const earlier = earlierVariantRows(rows);
  type Row = (typeof rows)[number];
  const columns: ResponsiveColumn<Row>[] = [
    { key: "student", header: t("common.student"), thClassName: "py-2", tdClassName: "py-2", card: "title", cell: (r) => r.studentName ?? "—" },
    ...(showAssessment ? [{ key: "exam", header: t("common.exam"), tdClassName: "max-w-xs break-words", cell: (r: Row) => r.assessmentTitle }] : []),
    {
      key: "attempt",
      header: t("common.attempt"),
      cell: (r) => (
        <>
          {attemptLabel(r.attemptNo)}
          {r.autoSubmitted && <span className="ml-1 text-xs text-muted-foreground">{t("assessment.auto")}</span>}
          {earlier.has(r.id) && (
            <span className="ml-1 inline-flex items-center gap-1 text-xs text-muted-foreground" title={t("attempt.earlierVariant")}>
              <Info className="h-3.5 w-3.5" aria-hidden />
              {t("attempt.earlierVariantShort")}
              <span className="sr-only">{t("attempt.earlierVariant")}</span>
            </span>
          )}
        </>
      ),
    },
    {
      key: "result",
      header: t("common.result"),
      tdClassName: "font-semibold",
      card: "aside",
      cell: (r) => (
        <>
          {r.percentage}%
          {r.pendingReviewCount > 0 && <span className="ml-2 text-xs font-normal text-warning">{t("common.pendingReviewCount", { count: r.pendingReviewCount })}</span>}
        </>
      ),
      cardCell: (r) => (
        <>
          <div className="font-semibold">{r.percentage}%</div>
          {r.pendingReviewCount > 0 && <div className="text-xs text-warning">{t("common.pendingReviewCount", { count: r.pendingReviewCount })}</div>}
        </>
      ),
    },
    { key: "duration", header: t("common.duration"), tdClassName: "text-muted-foreground", cell: (r) => fmtDuration(r.durationSeconds) },
    { key: "date", header: t("common.date"), tdClassName: "whitespace-nowrap text-muted-foreground", cell: (r) => fmtDateTime(r.completedAt) },
    {
      key: "view",
      header: t("common.view"),
      srOnlyHeader: true,
      tdClassName: "text-right",
      card: "action",
      cell: (r) => <Link href={`/teacher/results/${r.id}`} className={linkClass}>{t("common.view")}</Link>,
    },
  ];
  return <ResponsiveTable rows={rows} rowKey={(r) => r.id} columns={columns} className="relative overflow-x-auto" />;
}

export function AssessmentAnalytics({ id }: { id: string }) {
  const stats = trpc.teacher.analytics.assessment.useQuery({ id });
  const ranking = trpc.teacher.analytics.ranking.useQuery({ id });
  const questions = trpc.teacher.analytics.questions.useQuery({ id });
  if (!stats.data) return <Loading />;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t("common.participation")} value={`${stats.data.participationRate}%`} hint={`${stats.data.completedCount}/${stats.data.assignedCount}`} />
        <StatCard label={t("assessment.stat.completion")} value={`${stats.data.completionRate}%`} hint={t("assessment.stat.startedCount", { count: stats.data.startedCount })} />
        <StatCard label={t("assessment.stat.avgMedian")} value={`${stats.data.averageScore}% / ${stats.data.medianScore}%`} />
        <StatCard label={t("assessment.stat.avgDuration")} value={fmtDuration(stats.data.averageDurationSeconds)} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={t("assessment.distribution")}><DistributionChart data={stats.data.distribution} /></Panel>
        <Panel title={t("common.ranking")}><RankingTable rows={ranking.data ?? []} /></Panel>
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title={t("assessment.mostMissed")}><QuestionStatsTable rows={questions.data?.mostMissed ?? []} /></Panel>
        <Panel title={t("common.topics")}><TopicBars rows={questions.data?.topics ?? []} /></Panel>
      </div>
      <Panel title={t("assessment.allQuestions")}><QuestionStatsTable rows={questions.data?.questions ?? []} /></Panel>
      {(questions.data?.skills.length ?? 0) > 0 && <Panel title={t("common.skills")}><TopicBars rows={questions.data?.skills ?? []} /></Panel>}
    </div>
  );
}
