import { FirstSubmittersList, ScoreBoardTable } from "@/components/ActivityBlocks";
import { ProgressChart, TopicBars } from "@/components/AnalyticsBlocks";
import { AppShell, ChoiceChip, EmptyState, ErrorNote, Loading, Panel, Pill, StatCard } from "@/components/AppShell";
import { SingleFileUpload } from "@/components/FileUpload";
import { ResultPenalty } from "@/components/ResultPenalty";
import { StatusBadge, toneSurface } from "@/components/StatusBadge";
import { ContinueLearning } from "@/components/syllabus/CrossLinks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import {
  answerText,
  errorText,
  fmtDateTime,
  fmtDuration,
  heldLabel,
  ITEM_STATUS_COLORS,
  itemStatusLabel,
  liveLabel,
  releaseLabel,
  typeLabel,
} from "@/lib/format";
import { normalizeJoinInput, resolveJoinInput } from "@/lib/joinInput";
import { itemStatus, liveStatus } from "@/lib/status";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fileDownloadUrl, type UploadedFile } from "@/lib/uploadFile";
import { safeReturnPath } from "@/lib/syllabusLearn";
import { ArrowLeft, CheckCircle2, Clock, History, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams, useSearch } from "wouter";

type AssessmentType = "EXAM" | "KSQ" | "BSQ";

function ScoreOrHeld({ released, percentage, heldReason }: { released: boolean; percentage: number | null | undefined; heldReason?: string | null }) {
  if (released && percentage !== null && percentage !== undefined) return <span className="font-semibold">{percentage}%</span>;
  return (
    <StatusBadge tone="warning" icon={Clock}>
      {heldReason === "WAITING_FOR_GRADING" ? t("student.grading") : t("student.held")}
    </StatusBadge>
  );
}

export function StudentHome() {
  const d = trpc.student.dashboard.useQuery();
  return (
    <AppShell area="learning">
      {!d.data ? <Loading /> : (
        <div className="space-y-5">
          <ContinueLearning />
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t("student.activeExams")} value={d.data.active.length} />
            <StatCard label={t("student.upcoming")} value={d.data.upcoming.length} />
            <StatCard label={t("student.average")} value={`${d.data.averageScore}%`} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title={t("student.availableNow")}>
              {!d.data.active.length ? <p className="text-sm text-muted-foreground">{t("student.noActive")}</p> : (
                <ul className="divide-y">
                  {d.data.active.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 break-words">{a.title} <span className="text-xs text-muted-foreground">{typeLabel(a.type)}</span></span>
                      <Link href={`/student/assessments/${a.id}`} className="shrink-0 text-link underline-offset-4 hover:underline">
                        {a.attemptStatus === "IN_PROGRESS" ? t("student.resume") : t("common.view")}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title={t("student.upcomingExams")}>
              {!d.data.upcoming.length ? <p className="text-sm text-muted-foreground">{t("student.noUpcoming")}</p> : (
                <ul className="divide-y">
                  {d.data.upcoming.map((a) => (
                    <li key={a.id} className="flex flex-wrap justify-between gap-x-3 py-2 text-sm">
                      <span className="min-w-0 break-words">{a.title}</span>
                      <span className="text-muted-foreground">{fmtDateTime(a.startAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title={t("student.recentResults")}>
              {!d.data.recentResults.length ? <p className="text-sm text-muted-foreground">{t("common.noResults")}</p> : (
                <ul className="divide-y">
                  {d.data.recentResults.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <Link href={`/student/results/${r.id}`} className="min-w-0 break-words text-link underline-offset-4 hover:underline">{r.title}</Link>
                      <ScoreOrHeld released={r.released} percentage={r.percentage} heldReason={r.heldReason} />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title={t("student.focusTopics")}><TopicBars rows={d.data.weakTopics} empty={t("student.noWeakTopics")} /></Panel>
          </div>
        </div>
      )}
    </AppShell>
  );
}

export function StudentAssessments() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const type = (new URLSearchParams(search).get("type") || undefined) as AssessmentType | undefined;
  const list = trpc.student.assessments.useQuery({ type });
  const setType = (next?: AssessmentType) => navigate(next ? `/student/assessments?type=${next}` : "/student/assessments");
  return (
    <AppShell area="learning">
      <div className="space-y-4">
        {type && (
          <div className="flex flex-wrap gap-2">
            <ChoiceChip selected onClick={() => setType(undefined)} aria-label={t("assessment.filter.removeType", { type: typeLabel(type) })}>
              {t("assessment.filter.type", { type: typeLabel(type) })} <X className="h-3.5 w-3.5" aria-hidden />
            </ChoiceChip>
          </div>
        )}
        {list.isLoading ? <Loading /> : list.error ? <ErrorNote error={list.error} /> : !list.data?.length ? (
          <EmptyState title={t("student.noExams")} body={t("student.noExamsBody")} />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {list.data.map((a) => (
              <li key={a.id}>
                <Link href={`/student/assessments/${a.id}`} className="block h-full rounded-2xl border border-border bg-card p-5 hover:border-link">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Pill>{typeLabel(a.type)}</Pill>
                    <StatusBadge {...liveStatus(a.liveStatus)}>{liveLabel(a.liveStatus)}</StatusBadge>
                  </div>
                  <div className="mt-3 break-words font-semibold">{a.title}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{a.subject}</div>
                  <div className="mt-3 space-y-0.5 text-xs text-muted-foreground">
                    <div>{t("student.startsAt", { date: fmtDateTime(a.startAt) })}</div>
                    <div>{t("student.endsAt", { date: fmtDateTime(a.endAt) })}</div>
                    <div>{t("student.durationAttempts", { duration: fmtDuration(a.durationSeconds), used: a.attemptsUsed, allowed: a.attemptsAllowed })}</div>
                  </div>
                  {a.myPercentage !== null && <div className="mt-3 text-lg font-semibold">{t("student.myScore", { value: `${a.myPercentage}%` })}</div>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

export function StudentAssessmentDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const d = trpc.student.assessment.useQuery({ id: id! }, { enabled: Boolean(id) });
  const start = trpc.student.start.useMutation({
    onSuccess: (r) => navigate(`/student/sessions/${r.attemptId}`),
    onError: (e) => toast.error(errorText(e)),
  });
  const trackView = trpc.student.trackView.useMutation();
  const trackViewMutate = trackView.mutate;
  const loadedId = d.data?.id;
  useEffect(() => {
    if (loadedId) trackViewMutate({ assessmentId: loadedId });
  }, [loadedId, trackViewMutate]);
  const a = d.data;
  const resume = a?.resume ?? null;
  const canStart = a && a.liveStatus === "ACTIVE" && (resume !== null || a.attemptsUsed < a.attemptsAllowed);
  const expiredNoAnswers = a?.attemptStatus === "EXPIRED_NO_ANSWERS";
  return (
    <AppShell area="learning" title={a?.title}>
      {d.error ? <ErrorNote error={d.error} /> : !a ? <Loading /> : (
        <div className="grid max-w-3xl gap-5">
          <Panel>
            <div className="flex flex-wrap items-center gap-2">
              <Pill>{typeLabel(a.type)}</Pill>
              <StatusBadge {...liveStatus(a.liveStatus)}>{liveLabel(a.liveStatus)}</StatusBadge>
            </div>
            {a.description && <p className="mt-3 break-words text-sm text-foreground-secondary">{a.description}</p>}
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-muted-foreground">{t("builder.start")}</dt><dd>{fmtDateTime(a.startAt)}</dd></div>
              <div><dt className="text-muted-foreground">{t("builder.end")}</dt><dd>{fmtDateTime(a.endAt)}</dd></div>
              <div><dt className="text-muted-foreground">{t("common.duration")}</dt><dd>{fmtDuration(a.durationSeconds)}</dd></div>
              <div><dt className="text-muted-foreground">{t("common.attempt")}</dt><dd>{a.attemptsUsed} / {a.attemptsAllowed}</dd></div>
              <div><dt className="text-muted-foreground">{t("student.questionCount")}</dt><dd>{a.questionCount}</dd></div>
              <div><dt className="text-muted-foreground">{t("student.totalPoints")}</dt><dd>{a.totalPoints}</dd></div>
              <div className="col-span-2"><dt className="text-muted-foreground">{t("common.result")}</dt><dd>{releaseLabel(a.releaseMode)}</dd></div>
            </dl>
          </Panel>
          {a.instructions && <Panel title={t("student.instructions")}><p className="whitespace-pre-wrap break-words text-sm">{a.instructions}</p></Panel>}
          {resume && (
            <section className={`rounded-2xl border p-5 ${toneSurface("info")}`} aria-live="polite">
              <div className="flex items-start gap-3">
                <History className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1 text-foreground">
                  <p className="font-semibold">{t("student.resumeTitle")}</p>
                  <p className="mt-1 text-sm">{t("student.resumeAnswered", { done: resume.answeredCount, total: resume.totalQuestionCount })}</p>
                  <p className="text-sm">{t("student.resumeRemaining", { time: fmtDuration(resume.remainingSeconds) })}</p>
                  <p className="mt-2 text-xs text-foreground-secondary">{t("student.resumeNote")}</p>
                </div>
              </div>
            </section>
          )}
          {expiredNoAnswers && !resume && (
            <div className={`rounded-2xl border p-4 text-sm ${toneSurface("warning")}`}>
              <span className="font-medium text-foreground">{t("student.expiredNoAnswers")}</span>
            </div>
          )}
          <Panel>
            <p className="mb-3 text-xs text-muted-foreground">{t("student.autosaveNote")}</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!canStart || start.isPending} onClick={() => start.mutate({ assessmentId: a.id })}>
                {resume ? t("student.resumeExam") : t("student.start")}
              </Button>
              {a.resultId && (
                <Button asChild variant="outline">
                  <Link href={`/student/results/${a.resultId}`}>{t("student.latestResult")}</Link>
                </Button>
              )}
            </div>
            {!canStart && (
              <p className="mt-2 text-xs text-muted-foreground">
                {a.liveStatus === "SCHEDULED" ? t("student.notStartedYet") : a.liveStatus === "COMPLETED" ? t("student.closed") : t("student.noAttempts")}
              </p>
            )}
          </Panel>
        </div>
      )}
    </AppShell>
  );
}

export function StudentResults() {
  const list = trpc.student.results.useQuery();
  return (
    <AppShell area="learning">
      {list.isLoading ? <Loading /> : !list.data?.length ? (
        <EmptyState title={t("student.noResults")} body={t("student.noResultsBody")} />
      ) : (
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2">{t("common.exam")}</th>
                  <th scope="col">{t("common.type")}</th>
                  <th scope="col">{t("common.date")}</th>
                  <th scope="col">{t("common.result")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.data.map((r) => (
                  <tr key={r.id}>
                    <td className="break-words py-2 pr-3"><Link href={`/student/results/${r.id}`} className="text-link underline-offset-4 hover:underline">{r.title}</Link></td>
                    <td className="pr-3">{typeLabel(r.type)}</td>
                    <td className="whitespace-nowrap pr-3 text-muted-foreground">{fmtDateTime(r.completedAt)}</td>
                    <td><ScoreOrHeld released={r.released} percentage={r.percentage} heldReason={r.heldReason} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </AppShell>
  );
}

export function StudentResultDetail() {
  const { id } = useParams<{ id: string }>();
  const r = trpc.student.result.useQuery({ id: id! }, { enabled: Boolean(id) });
  const returnTo = safeReturnPath(new URLSearchParams(useSearch()).get("returnTo"));
  const d = r.data;
  const back = returnTo && (
    <Button asChild size="sm" variant="outline">
      <Link href={returnTo}>
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
        {t("learn.backToLesson")}
      </Link>
    </Button>
  );
  return (
    <AppShell area="learning" title={d?.title}>
      {r.error ? <div className="space-y-3"><ErrorNote error={r.error} />{back}</div> : !d ? <Loading /> : (
        <div className="space-y-5">
          {back}
          {!d.released ? (
            <Panel>
              <div className="flex items-center gap-2 text-lg font-semibold">
                <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />
                {t("student.submitted")}
              </div>
              <p className="mt-2 text-sm text-foreground-secondary">{heldLabel(d.visibility.heldReason)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("student.submittedMeta", { date: fmtDateTime(d.completedAt), duration: fmtDuration(d.durationSeconds) })}</p>
            </Panel>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t("common.result")} value={`${d.percentage}%`} hint={t("common.pointsOf", { earned: d.earnedPoints ?? 0, total: d.totalPoints ?? 0 })} />
              <StatCard label={t("common.correct")} value={d.correctCount ?? 0} />
              <StatCard label={t("student.wrongUnanswered")} value={`${d.wrongCount ?? 0} / ${d.unansweredCount ?? 0}`} />
              <StatCard label={t("common.duration")} value={fmtDuration(d.durationSeconds)} hint={d.pendingReviewCount ? t("common.pendingReviewCount", { count: d.pendingReviewCount }) : undefined} />
            </div>
          )}
          {d.released && <ResultPenalty penalty={d.penalty} />}
          {d.questions.length > 0 && (
            <Panel title={d.visibility.showQuestions === "WRONG_ONLY" ? t("student.wrongOnlyTitle") : t("common.questions")}>
              <ol className="space-y-3">
                {d.questions.map((q) => {
                  const status = itemStatus(q.status);
                  return (
                    <li key={q.id} className={`rounded-xl border p-4 ${ITEM_STATUS_COLORS[q.status] ?? ""}`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-medium">{q.position}. {q.text}</div>
                        <div className="flex shrink-0 items-center gap-2 text-xs">
                          <StatusBadge tone={status.tone} icon={status.icon}>{itemStatusLabel(q.status)}</StatusBadge>
                          <span className="font-semibold">{q.earned}/{q.maxPoints}</span>
                        </div>
                      </div>
                      <dl className="mt-2 space-y-1 text-sm">
                        <div>
                          <dt className="inline text-muted-foreground">{t("student.yourAnswer")}: </dt>
                          <dd className="inline break-words">{answerText(q.studentAnswer, q)}</dd>
                        </div>
                        {q.correctAnswer !== undefined && q.type !== "LONG_ANSWER" && (
                          <div>
                            <dt className="inline text-muted-foreground">{t("student.correctAnswer")}: </dt>
                            <dd className="inline break-words">{answerText(q.correctAnswer, q)}</dd>
                          </div>
                        )}
                        {q.explanation && (
                          <div className="pt-1">
                            <dt className="sr-only">{t("student.explanation")}</dt>
                            <dd className="break-words text-foreground-secondary">{q.explanation}</dd>
                          </div>
                        )}
                      </dl>
                    </li>
                  );
                })}
              </ol>
            </Panel>
          )}
        </div>
      )}
    </AppShell>
  );
}

export function StudentProgress() {
  const p = trpc.student.progress.useQuery();
  return (
    <AppShell area="learning">
      {!p.data ? <Loading /> : !p.data.series.length ? (
        <EmptyState title={t("student.noProgress")} body={t("student.noProgressBody")} />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t("common.average")} value={`${p.data.summary.average}%`} />
            <StatCard label={t("student.highest")} value={`${p.data.summary.highest}%`} />
            <StatCard label={t("student.resultCount")} value={p.data.summary.count} />
          </div>
          <Panel title={t("student.trend")}>
            <ProgressChart data={p.data.series.map((s) => ({ label: s.label.slice(0, 14), value: s.percentage }))} />
          </Panel>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title={t("common.topics")}><TopicBars rows={p.data.topics} /></Panel>
            <Panel title={t("common.skills")}><TopicBars rows={p.data.skills} /></Panel>
          </div>
        </div>
      )}
    </AppShell>
  );
}

export function StudentGroups() {
  const list = trpc.student.groups.useQuery();
  const [code, setCode] = useState("");
  const [, nav] = useLocation();
  const [progressId, setProgressId] = useState<string | null>(null);
  // Only matters once the student already has at least one group -- see below.
  const [joinOpen, setJoinOpen] = useState(false);
  const hasGroups = !!list.data?.length;
  return (
    <AppShell area="learning">
      {list.isLoading ? (
        <Loading />
      ) : (
        <div className="grid max-w-3xl gap-5">
          {/* A student who already has groups sees those first -- the join-another-group box is a
              secondary action, not the first thing competing for attention on a page whose main
              job, for most visits, is checking groups already joined. */}
          {hasGroups && (
            <Panel title={t("student.myGroups")}>
              <ul className="divide-y">
                {list.data!.map((g) => (
                  <li key={g.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 break-words">{g.name} <span className="text-xs text-muted-foreground">{g.subject}</span></span>
                      <span className="flex items-center gap-2">
                        {g.status === "ACTIVE" ? (
                          <>
                            <button
                              type="button"
                              className="text-xs text-link underline-offset-2 hover:underline"
                              onClick={() => setProgressId(progressId === g.id ? null : g.id)}
                            >
                              {t("student.groupProgress")}
                            </button>
                            <StatusBadge tone="success">{t("student.member")}</StatusBadge>
                          </>
                        ) : (
                          <StatusBadge tone="warning">{t("student.awaitingApproval")}</StatusBadge>
                        )}
                      </span>
                    </div>
                    {progressId === g.id && (
                      <>
                        <GroupProgressPanel groupId={g.id} />
                        <GroupBoardPanel groupId={g.id} />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {/* Once the student already belongs to (or is awaiting approval for) a group, the join
              box stops being something they see every visit -- it collapses to a single link, since
              by far the common case from here on is checking an existing group, not joining a new
              one. A brand-new student with no groups yet still sees the full box immediately. */}
          {hasGroups && !joinOpen ? (
            <button
              type="button"
              onClick={() => setJoinOpen(true)}
              className="justify-self-start text-sm text-link underline-offset-2 hover:underline"
            >
              {t("student.joinAnotherGroup")}
            </button>
          ) : (
            <Panel title={t("student.joinGroup")}>
              <p className="mb-2 text-xs text-muted-foreground">{t("student.joinGroupHint")}</p>
              <div className="flex gap-2">
                <Input
                  placeholder={t("welcome.inviteCodeOrLinkPlaceholder")}
                  aria-label={t("welcome.inviteCodeOrLink")}
                  value={code}
                  onChange={(e) => setCode(normalizeJoinInput(e.target.value))}
                  autoFocus={hasGroups}
                />
                {/* Navigating to the preview page (not joining directly) so the student always sees the
                    group's details and confirms before membership is created or requested. */}
                <Button disabled={!resolveJoinInput(code)} onClick={() => { const route = resolveJoinInput(code); if (route) nav(route); }}>{t("student.join")}</Button>
              </div>
            </Panel>
          )}
          {!hasGroups && (
            <Panel title={t("student.myGroups")}>
              <p className="text-sm text-muted-foreground">{t("student.noGroups")}</p>
            </Panel>
          )}
        </div>
      )}
    </AppShell>
  );
}

/** Group leaderboard and first submitters; classmates appear only by name, rank and first places. */
function GroupBoardPanel({ groupId }: { groupId: string }) {
  const b = trpc.student.groupBoard.useQuery({ groupId });
  if (!b.data) return b.error ? <ErrorNote error={b.error} /> : <Loading />;
  const { me, leaderboard, tasks, scores } = b.data;
  return (
    <div className="mt-2 space-y-3 rounded-lg bg-muted/40 p-3">
      <div>
        <h4 className="mb-1.5 text-xs font-medium text-foreground-secondary">{scores.visible ? t("motivation.groupScores") : t("motivation.myScores")}</h4>
        <ScoreBoardTable data={scores} />
      </div>
      {me && (
        <div className="grid grid-cols-3 gap-2">
          <StatCard label={t("motivation.yourPlace")} value={t("motivation.rankOf", { rank: me.rank, of: me.of })} />
          <StatCard label={t("motivation.col.onTime")} value={me.submitted ? `${me.onTimeRate}%` : "—"} />
          <StatCard label={t("motivation.col.firstPlaces")} value={me.firstPlaces} />
        </div>
      )}
      <div>
        <h4 className="mb-1.5 text-xs font-medium text-foreground-secondary">{t("motivation.leaderboard")}</h4>
        <ol className="divide-y divide-border rounded-lg border border-border bg-card">
          {leaderboard.slice(0, 10).map((r, i) => (
            <li key={i} className={`flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm ${r.isYou ? "font-semibold" : ""}`}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="w-6 shrink-0 text-muted-foreground">{r.rank}</span>
                <span className="min-w-0 break-words">
                  {r.name ?? t("common.student")}
                  {r.isYou && <span className="ml-1 text-xs font-normal text-muted-foreground">{t("motivation.you")}</span>}
                </span>
              </span>
              {r.firstPlaces > 0 && <span className="shrink-0 text-xs text-muted-foreground">{t("motivation.firstPlacesCount", { count: r.firstPlaces })}</span>}
            </li>
          ))}
        </ol>
      </div>
      {tasks.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-medium text-foreground-secondary">{t("motivation.firstSubmittersTitle")}</h4>
          <ul className="space-y-2">
            {tasks.map((task) => (
              <li key={task.id} className="space-y-1">
                <p className="break-words text-sm">{task.title}</p>
                <FirstSubmittersList items={task.firstSubmitters} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A student's own exam progress narrowed to one group, so being in several teachers' groups
 *  doesn't blend unrelated subjects together — see analytics.studentGroupProgress server-side. */
function GroupProgressPanel({ groupId }: { groupId: string }) {
  const p = trpc.student.groupProgress.useQuery({ groupId });
  if (!p.data) return <Loading />;
  if (!p.data.series.length) {
    return <p className="mt-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">{t("student.noProgressBody")}</p>;
  }
  return (
    <div className="mt-2 space-y-3 rounded-lg bg-muted/40 p-3">
      <div className="grid grid-cols-3 gap-2">
        <StatCard label={t("common.average")} value={`${p.data.summary.average}%`} />
        <StatCard label={t("student.highest")} value={`${p.data.summary.highest}%`} />
        <StatCard label={t("student.resultCount")} value={p.data.summary.count} />
      </div>
      <TopicBars rows={p.data.topics} />
    </div>
  );
}

type ReleasedGradeData = NonNullable<NonNullable<RouterOutputs["student"]["tasks"][number]["submission"]>["grade"]>;

function ReleasedGrade({ grade }: { grade: ReleasedGradeData }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-border p-2.5 text-sm">
      {grade.source === "AI" && (
        <div><StatusBadge tone="info"><Sparkles className="mr-1 inline h-3 w-3" aria-hidden />{t("student.gradedByAi")}</StatusBadge></div>
      )}
      {grade.score !== null && <p className="font-semibold">{t("student.taskScore", { score: grade.score })}</p>}
      {!!grade.feedback && <p className="whitespace-pre-wrap break-words">{grade.feedback}</p>}
      {grade.ai && (
        <div className="space-y-1 rounded-lg bg-muted/40 p-2 text-xs">
          <p className="inline-flex items-center gap-1 font-medium text-foreground-secondary">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            {t("student.aiFeedbackTitle")}
          </p>
          <p className="whitespace-pre-wrap break-words">{grade.ai.feedback}</p>
          {grade.ai.improvements.length > 0 && (
            <ul className="ml-4 list-disc">{grade.ai.improvements.map((s, i) => <li key={i} className="break-words">{s}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}

export function StudentTasks() {
  const utils = trpc.useUtils();
  const list = trpc.student.tasks.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.some((a) => a.submission?.pending === "AI_CHECKING") ? 4000 : false),
  });
  const [files, setFiles] = useState<Record<string, UploadedFile | null>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const submit = trpc.student.submitTask.useMutation({
    onSuccess: () => { toast.success(t("student.taskSubmitted")); void utils.student.tasks.invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });
  // ?task=<id> from a "new task" notice: bring that task into view.
  const focusId = new URLSearchParams(useSearch()).get("task");
  const loaded = !!list.data;
  useEffect(() => {
    if (loaded && focusId) document.getElementById(`task-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loaded, focusId]);
  return (
    <AppShell area="learning">
      {!list.data ? <Loading /> : !list.data.length ? (
        <EmptyState title={t("student.noTasks")} body={t("student.noTasksBody")} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.data.map((a) => (
            <Panel
              key={a.id}
              id={`task-${a.id}`}
              className={a.id === focusId ? "scroll-mt-20 ring-2 ring-link" : "scroll-mt-20"}
              title={a.title}
              action={a.submission ? (
                a.submission.status === "LATE"
                  ? <StatusBadge tone="warning">{t("student.late")}</StatusBadge>
                  : <StatusBadge tone="success">{t("student.onTime")}</StatusBadge>
              ) : undefined}
            >
              <p className="break-words text-sm text-foreground-secondary">{a.description}</p>
              <p className="mt-2 text-xs text-muted-foreground">{t("modules.deadlineValue", { date: fmtDateTime(a.deadline) })}</p>
              {a.attachments.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {a.attachments.map((file) => (
                    <li key={file.fileId}>
                      <a href={fileDownloadUrl(file.fileId)} className="rounded-lg border border-border bg-muted px-2 py-1 text-xs text-link underline-offset-2 hover:underline">
                        {file.name}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {a.submission ? (
                <div className="mt-3 space-y-2">
                  {a.submission.files.length > 0 && (
                    <p className="text-xs text-muted-foreground">{t("student.submittedFiles", { names: a.submission.files.map((f) => f.name).join(", ") })}</p>
                  )}
                  {!!a.submission.answerText && (
                    <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 text-sm">{a.submission.answerText}</p>
                  )}
                  {a.submission.grade ? (
                    <ReleasedGrade grade={a.submission.grade} />
                  ) : a.submission.pending === "AI_CHECKING" ? (
                    <p className="text-xs text-muted-foreground">{t("student.aiChecking")}</p>
                  ) : a.submission.pending === "TEACHER_REVIEW" ? (
                    <StatusBadge tone="warning">{t("student.teacherReviewPending")}</StatusBadge>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("student.awaitingReview")}</p>
                  )}
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  <label className="block text-xs">
                    <span className="text-foreground-secondary">{t("student.answerLabel")}</span>
                    <Textarea rows={4} className="mt-1" maxLength={20000} placeholder={t("student.answerPlaceholder")} value={answers[a.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [a.id]: e.target.value })} />
                  </label>
                  <SingleFileUpload context="submission" taskId={a.id} value={files[a.id] ?? null} onChange={(file) => setFiles({ ...files, [a.id]: file })} />
                  <Button
                    disabled={(!files[a.id] && !(answers[a.id] ?? "").trim()) || submit.isPending}
                    onClick={() => {
                      const file = files[a.id];
                      submit.mutate({
                        assignmentId: a.id,
                        files: file ? [{ fileId: file.fileId, name: file.name, size: file.size }] : [],
                        answerText: answers[a.id] ?? "",
                      });
                    }}
                  >
                    {t("common.send")}
                  </Button>
                </div>
              )}
            </Panel>
          ))}
        </div>
      )}
    </AppShell>
  );
}

export function StudentMaterials() {
  const list = trpc.student.materials.useQuery();
  return (
    <AppShell area="learning">
      {!list.data ? <Loading /> : !list.data.length ? (
        <EmptyState title={t("student.noMaterials")} body={t("student.noMaterialsBody")} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((m) => (
            <Panel key={m.id} title={m.title}>
              <p className="break-words text-sm text-foreground-secondary">{m.description}</p>
              <p className="mt-2 break-words text-xs text-muted-foreground">{[m.subject, m.topic].filter(Boolean).join(" · ")}</p>
              {m.fileId && (
                <a href={fileDownloadUrl(m.fileId)} className="mt-2 inline-block rounded-lg border border-border bg-muted px-2 py-1 text-xs text-link underline-offset-2 hover:underline">
                  {m.fileName}
                </a>
              )}
            </Panel>
          ))}
        </div>
      )}
    </AppShell>
  );
}
