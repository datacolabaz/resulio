import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { AlertTriangle, CheckCircle2, Info, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type Review = RouterOutputs["teacher"]["tasks"]["reviews"]["reviews"][number];
type Submission = RouterOutputs["teacher"]["tasks"]["list"][number]["submissions"][number];

const REASONS = ["NO_TEXT", "AI_NOT_CONFIGURED", "DAILY_LIMIT", "TEACHER_AI_LIMIT", "AI_REQUEST_FAILED", "AI_KEY_INVALID", "AI_NOT_FOUND", "AI_QUOTA", "AI_INVALID_OUTPUT", "INTERNAL"] as const;
type Reason = (typeof REASONS)[number];
const isReason = (code: string | null): code is Reason => REASONS.includes(code as Reason);

const STATUS_TONE: Record<Review["status"], Tone> = { PENDING: "info", DONE: "success", FAILED: "danger", SKIPPED: "neutral" };
const CHECK_ICON = { ok: CheckCircle2, warn: Info, fail: AlertTriangle } as const;
const CHECK_CLASS = { ok: "text-success", warn: "text-warning", fail: "text-destructive" } as const;

function AiReviewBox({ review, autoGrade, onRerun, rerunning }: { review: Review | undefined; autoGrade: boolean; onRerun: () => void; rerunning: boolean }) {
  if (!review) {
    return (
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border p-2.5 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          {t("aiReview.notChecked")}
        </span>
        <Button size="sm" variant="outline" disabled={rerunning} onClick={onRerun}>{t("aiReview.checkNow")}</Button>
      </div>
    );
  }
  const canRerun = review.status !== "PENDING" || review.stale;
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted/40 p-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground-secondary">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          {t("aiReview.title")}
        </span>
        <StatusBadge tone={STATUS_TONE[review.status]}>{t(`aiReview.status.${review.status}`)}</StatusBadge>
      </div>
      {review.status === "DONE" && review.suggestedScore !== null && (
        <div className="space-y-1.5">
          <p className="text-sm">
            <span className="font-semibold">{t("aiReview.suggestedScore", { score: review.suggestedScore })}</span>
            {review.details && <span className="ml-2 text-muted-foreground">{t(`aiReview.confidence.${review.details.confidence}`)}</span>}
          </p>
          {review.details?.needsTeacherReview && (
            <p className="text-warning" role="note">{t("aiReview.needsTeacherReview")}</p>
          )}
          {review.feedback && <p className="whitespace-pre-wrap break-words text-foreground">{review.feedback}</p>}
          {!!review.details?.strengths.length && (
            <div>
              <p className="font-medium text-foreground-secondary">{t("aiReview.strengths")}</p>
              <ul className="ml-4 list-disc">{review.details.strengths.map((s, i) => <li key={i} className="break-words">{s}</li>)}</ul>
            </div>
          )}
          {!!review.details?.improvements.length && (
            <div>
              <p className="font-medium text-foreground-secondary">{t("aiReview.improvements")}</p>
              <ul className="ml-4 list-disc">{review.details.improvements.map((s, i) => <li key={i} className="break-words">{s}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {(review.status === "SKIPPED" || review.status === "FAILED") && (
        <p className="text-muted-foreground">{isReason(review.errorCode) ? t(`aiReview.reason.${review.errorCode}`) : t("aiReview.reason.INTERNAL")}</p>
      )}
      {review.checks.length > 0 && (
        <ul className="space-y-0.5">
          {review.checks.map((c, i) => {
            const Icon = CHECK_ICON[c.level];
            return (
              <li key={i} className="flex items-start gap-1.5">
                <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${CHECK_CLASS[c.level]}`} aria-hidden />
                <span className="min-w-0 break-words">{t(`aiReview.check.${c.code}`, { value: c.value ?? "" })}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">{t(autoGrade ? "aiReview.autoNote" : "aiReview.advisoryNote")}</p>
        {canRerun && (
          <Button size="sm" variant="ghost" disabled={rerunning} onClick={onRerun}>{t("aiReview.rerun")}</Button>
        )}
      </div>
    </div>
  );
}

/** The teacher's grade for one submission, with the AI pre-review as a starting point. */
export function SubmissionReview({ submission, review, autoGrade, onChanged }: { submission: Submission; review: Review | undefined; autoGrade: boolean; onChanged: () => void }) {
  const [score, setScore] = useState(submission.score === null ? "" : String(submission.score));
  const [feedback, setFeedback] = useState(submission.teacherFeedback ?? "");
  const [shareAi, setShareAi] = useState(submission.aiFeedbackReleased);
  const grade = trpc.teacher.tasks.grade.useMutation({
    onSuccess: (_, v) => { toast.success(v.release ? t("aiReview.released") : t("aiReview.saved")); onChanged(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const rerun = trpc.teacher.tasks.rerunReview.useMutation({ onSuccess: onChanged, onError: (e) => toast.error(errorText(e)) });
  const aiReady = review?.status === "DONE" && review.suggestedScore !== null;
  const gradedByAi = !!submission.gradedAt && submission.gradedByUserId === null;
  const parsed = score.trim() === "" ? null : Number(score);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 100);
  const save = (release: boolean) =>
    grade.mutate({ submissionId: submission.id, score: parsed, feedback, release, shareAiFeedback: release && shareAi && aiReady });

  return (
    <div className="mt-2 space-y-2">
      {!!submission.comment && (
        <details className="rounded-lg border border-border p-2 text-xs">
          <summary className="cursor-pointer font-medium text-foreground-secondary">{t("aiReview.answerText")}</summary>
          <p className="mt-1.5 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-sm">{submission.comment}</p>
        </details>
      )}
      <AiReviewBox review={review} autoGrade={autoGrade} rerunning={rerun.isPending} onRerun={() => rerun.mutate({ submissionId: submission.id })} />
      <div className="grid gap-2 rounded-lg border border-border p-2.5">
        {gradedByAi && (
          <div><StatusBadge tone="info"><Sparkles className="mr-1 inline h-3 w-3" aria-hidden />{t("aiReview.gradedByAi")}</StatusBadge></div>
        )}
        {!submission.gradedAt && review?.needsTeacher && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <StatusBadge tone="warning">{t("aiReview.needsTeacher")}</StatusBadge>
            <span className="text-muted-foreground">{t(`aiReview.block.${review.needsTeacher}`)}</span>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="text-foreground-secondary">{t("aiReview.scoreLabel")}</span>
            <Input type="number" inputMode="decimal" min={0} max={100} step={0.5} className="mt-1 w-28" value={score} onChange={(e) => setScore(e.target.value)} aria-invalid={invalid} />
          </label>
          {aiReady && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setScore(String(review.suggestedScore));
                if (!feedback.trim() && review.feedback) setFeedback(review.feedback);
              }}
            >
              {t("aiReview.useSuggestion")}
            </Button>
          )}
        </div>
        <label className="text-xs">
          <span className="text-foreground-secondary">{t("aiReview.feedbackLabel")}</span>
          <Textarea rows={3} className="mt-1" maxLength={4000} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        </label>
        {aiReady && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" className="accent-link" checked={shareAi} onChange={(e) => setShareAi(e.target.checked)} />
            {t("aiReview.shareAi")}
          </label>
        )}
        {invalid && <p role="alert" className="text-xs text-destructive">{t("aiReview.scoreInvalid")}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={invalid || grade.isPending} onClick={() => save(false)}>{t("aiReview.saveDraft")}</Button>
          <Button size="sm" disabled={invalid || grade.isPending} onClick={() => save(true)}>{t("aiReview.saveRelease")}</Button>
          <span className="text-xs text-muted-foreground">
            {submission.feedbackReleasedAt ? t("aiReview.visibleToStudent") : submission.gradedAt ? t("aiReview.hiddenFromStudent") : null}
          </span>
        </div>
      </div>
    </div>
  );
}
