import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { questionPreview } from "@shared/questionPreview";
import { Check, CheckCircle2, Sparkles } from "lucide-react";
import { toast } from "sonner";

export type PreviewQuestion = {
  id?: string;
  type: string;
  text: string;
  imageUrl?: string | null;
  explanation?: string | null;
  content?: unknown;
  answerKey?: unknown;
  /** An imported answer the teacher has not confirmed yet. */
  answerCheck?: boolean;
};

/** Teacher-only: shows the answer key. Students get `QuestionRenderer` with server-stripped payloads. */
export function QuestionPreview({
  q,
  clamp,
  explanation,
  onChangeAnswer,
  className,
}: {
  q: PreviewQuestion;
  clamp?: boolean;
  explanation?: boolean;
  /** Opens the editor; offered next to "Confirm" for an unconfirmed answer. */
  onChangeAnswer?: () => void;
  className?: string;
}) {
  const { options, answer } = questionPreview(q);
  const answerText =
    answer?.kind === "choice" ? answer.letters.join(", ") : answer?.kind === "boolean" ? t(answer.value ? "common.true" : "common.false") : answer?.value;
  return (
    <div className={cn("min-w-0 flex-1 space-y-2 text-sm", className)}>
      <div className={cn("whitespace-pre-wrap break-words", clamp && "line-clamp-3")}>{q.text}</div>
      {q.imageUrl && <img src={q.imageUrl} alt={t("qbank.questionImage")} loading="lazy" className="max-h-48 rounded-lg border border-border" />}
      {options.length > 0 && (
        <ol className="space-y-1">
          {options.map((o) => (
            <li key={o.key} className={cn("flex gap-2 rounded-md px-2 py-1", o.correct ? "bg-success-surface text-success" : "text-foreground-secondary")}>
              <span className="w-5 shrink-0 font-semibold">{o.letter}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{o.text}</span>
              {o.correct && (
                <>
                  <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="sr-only">{t("qbank.correctOption")}</span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {answerText && <p className="whitespace-pre-wrap break-words text-xs font-medium text-success">{t("qbank.correctAnswer", { answer: answerText })}</p>}
      {q.answerCheck && q.id && <AnswerCheck questionId={q.id} onChange={onChangeAnswer} />}
      {explanation && q.explanation && <p className="text-xs text-muted-foreground">{t("builder.explanationValue", { value: q.explanation })}</p>}
    </div>
  );
}

function AnswerCheck({ questionId, onChange }: { questionId: string; onChange?: () => void }) {
  const utils = trpc.useUtils();
  const confirm = trpc.teacher.questions.confirmAnswers.useMutation({
    onSuccess: () => {
      toast.success(t("qbank.answerConfirmed"));
      void utils.teacher.questions.bank.invalidate();
      void utils.teacher.assessments.detail.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  // Inside a picker <label>, a click must not also toggle the row's checkbox.
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    fn();
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge tone="warning" icon={Sparkles}>{t("qbank.answerCheck")}</StatusBadge>
      <span className="sr-only">{t("qbank.answerCheckHelp")}</span>
      <Button type="button" size="sm" variant="outline" className="h-7" title={t("qbank.answerCheckHelp")} disabled={confirm.isPending} onClick={act(() => confirm.mutate({ ids: [questionId] }))}>
        <Check className="h-3.5 w-3.5" aria-hidden />
        {t("qbank.confirmAnswer")}
      </Button>
      {onChange && (
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={act(onChange)}>
          {t("qbank.changeAnswer")}
        </Button>
      )}
    </div>
  );
}
