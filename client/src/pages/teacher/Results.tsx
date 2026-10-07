import { AppShell, EmptyState, ErrorNote, Loading, Panel, StatCard } from "@/components/AppShell";
import { ResultPenalty } from "@/components/ResultPenalty";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { answerText, errorText, fmtDateTime, fmtDuration, ITEM_STATUS_COLORS, itemStatusLabel, questionTypeLabel } from "@/lib/format";
import { itemStatus } from "@/lib/status";
import { trpc } from "@/lib/trpc";
import { History } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link, useParams } from "wouter";
import { ResultsTable } from "./Assessments";

export function ResultsPage() {
  const assessments = trpc.teacher.assessments.list.useQuery({});
  const [assessmentId, setAssessmentId] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const list = trpc.teacher.results.list.useQuery({ assessmentId: assessmentId || undefined, pendingOnly: pendingOnly || undefined });
  return (
    <AppShell area="teaching">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="max-w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground"
            aria-label={t("results.filterExam")}
            value={assessmentId}
            onChange={(e) => setAssessmentId(e.target.value)}
          >
            <option value="">{t("results.allExams")}</option>
            {(assessments.data ?? []).filter((a) => a.currentVersionId).map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-link" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} /> {t("results.pendingOnly")}
          </label>
        </div>
        {list.isLoading ? <Loading /> : !list.data?.length ? (
          <EmptyState title={t("results.empty")} body={t("results.emptyBody")} />
        ) : (
          <Panel><ResultsTable rows={list.data} showAssessment /></Panel>
        )}
      </div>
    </AppShell>
  );
}

export function ResultDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const utils = trpc.useUtils();
  const r = trpc.teacher.results.detail.useQuery({ id });
  const [points, setPoints] = useState<Record<string, string>>({});
  const grade = trpc.teacher.results.grade.useMutation({
    onSuccess: () => { toast.success(t("results.graded")); void utils.teacher.results.invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const d = r.data;

  return (
    <AppShell area="teaching" title={d ? `${d.student?.name ?? t("common.student")} · ${d.title}` : t("common.result")}>
      {r.error ? <ErrorNote error={r.error} /> : !d ? <Loading /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Link href={`/teacher/assessments/${d.assessmentId}`} className="break-words text-link underline-offset-4 hover:underline">{d.title}</Link>
            <span>· {t("results.meta", { version: d.versionNo, attempt: d.attemptNo })}</span>
            {d.attemptStatus === "AUTO_SUBMITTED" && <StatusBadge tone="neutral" icon={History}>{t("results.autoSubmitted")}</StatusBadge>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t("common.result")} value={`${d.percentage}%`} hint={t("common.pointsOf", { earned: d.earnedPoints, total: d.totalPoints })} />
            <StatCard label={t("results.correctWrong")} value={`${d.correctCount} / ${d.wrongCount}`} hint={t("results.unansweredHint", { count: d.unansweredCount })} />
            <StatCard label={t("common.duration")} value={fmtDuration(d.durationSeconds)} hint={fmtDateTime(d.completedAt)} />
            <StatCard label={t("results.toReview")} value={d.pendingReviewCount} />
          </div>
          <ResultPenalty penalty={d.penalty} />
          <ol className="space-y-3">
            {d.questions.map((q) => {
              const status = itemStatus(q.status);
              return (
                <li key={q.id} className={`rounded-2xl border p-4 ${ITEM_STATUS_COLORS[q.status] ?? ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-secondary">
                    <span>{q.position}. {questionTypeLabel(q.type)}</span>
                    <span className="flex items-center gap-2">
                      <StatusBadge tone={status.tone} icon={status.icon}>{itemStatusLabel(q.status)}</StatusBadge>
                      <span className="font-semibold text-foreground">{t("common.pointsOf", { earned: q.earned, total: q.maxPoints })}</span>
                    </span>
                  </div>
                  <div className="mt-2 whitespace-pre-wrap break-words text-sm">{q.text}</div>
                  <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">{t("results.studentAnswer")}</dt>
                      <dd className="whitespace-pre-wrap break-words">{answerText(q.studentAnswer, q)}</dd>
                    </div>
                    {q.correctAnswer !== undefined && q.type !== "LONG_ANSWER" && (
                      <div>
                        <dt className="text-xs text-muted-foreground">{t("results.correctAnswer")}</dt>
                        <dd className="break-words">{answerText(q.correctAnswer, q)}</dd>
                      </div>
                    )}
                  </dl>
                  {q.reviewable && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                      <label htmlFor={`grade-${q.id}`} className="text-sm">{t("results.pointsInput", { max: q.maxPoints })}</label>
                      <Input
                        id={`grade-${q.id}`}
                        className="w-24"
                        type="number"
                        min={0}
                        max={q.maxPoints}
                        step={0.5}
                        value={points[q.id] ?? (q.status === "PENDING_REVIEW" ? "" : String(q.earned))}
                        onChange={(e) => setPoints({ ...points, [q.id]: e.target.value })}
                      />
                      <Button
                        size="sm"
                        disabled={grade.isPending || points[q.id] === undefined || points[q.id] === ""}
                        onClick={() => grade.mutate({ resultId: d.id, questionId: q.id, points: Number(points[q.id]) })}
                      >
                        {t("common.save")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </AppShell>
  );
}
