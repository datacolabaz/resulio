import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { QuestionRenderer } from "@/components/QuestionRenderer";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/locale";
import { isMessageKey, t } from "@/i18n/messages";
import { answerText, errorText, fmtDateTime, ITEM_STATUS_COLORS } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { StudentAnswer } from "@shared/assessment";
import { PRACTICE_FORMATS, QUIZ_COUNTS, type QuizFormat } from "@shared/coach";
import { Lightbulb } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Sources } from "./LearnTab";

type Quiz = RouterOutputs["student"]["coach"]["practice"]["get"];
type Item = Quiz["items"][number];

/** "Məşq et": questions on this topic in the app language, graded right away. */
export function PracticeTab({ topicId, onLearn }: { topicId: string; onLearn: () => void }) {
  const [quizId, setQuizId] = useState<string | null>(null);
  if (quizId) return <QuizRunner quizId={quizId} onClose={() => setQuizId(null)} onLearn={onLearn} />;
  return <PracticeHome topicId={topicId} onOpen={setQuizId} />;
}

function PracticeHome({ topicId, onOpen }: { topicId: string; onOpen: (id: string) => void }) {
  const { locale } = useI18n();
  const utils = trpc.useUtils();
  const [format, setFormat] = useState<(typeof PRACTICE_FORMATS)[number]>("MIXED");
  const [count, setCount] = useState<(typeof QUIZ_COUNTS)[number]>(5);
  const progress = trpc.student.coach.practice.progress.useQuery({ topicId });
  const list = trpc.student.coach.practice.list.useQuery({ topicId });
  const start = trpc.student.coach.practice.start.useMutation({
    onSuccess: (quiz) => {
      utils.student.coach.practice.get.setData({ quizId: quiz.id }, quiz);
      void utils.student.coach.practice.list.invalidate();
      void utils.student.coach.status.invalidate();
      onOpen(quiz.id);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <>
      {progress.data && <MasteryCard progress={progress.data} />}
      <Panel>
        <h3 className="font-semibold">{t("coach.practice.new")}</h3>
        <fieldset className="mt-3">
          <legend className="text-sm text-muted-foreground">{t("coach.practice.format")}</legend>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup">
            {PRACTICE_FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                onClick={() => setFormat(f)}
                className={`rounded-lg border px-3 py-2 text-left text-sm ${format === f ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                {formatLabel(f)}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-4">
          <legend className="text-sm text-muted-foreground">{t("coach.practice.count")}</legend>
          <div className="mt-2 inline-flex rounded-lg border border-border p-0.5" role="radiogroup">
            {QUIZ_COUNTS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={count === c}
                onClick={() => setCount(c)}
                className={`rounded-md px-4 py-1.5 text-sm ${count === c ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {c}
              </button>
            ))}
          </div>
        </fieldset>
        <Button className="mt-4 w-full sm:w-auto" disabled={start.isPending} onClick={() => start.mutate({ topicId, format, count, locale })}>
          {start.isPending ? t("coach.practice.preparing") : t("coach.practice.start")}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">{t("coach.learn.aiNote")}</p>
      </Panel>
      {!!list.data?.length && (
        <Panel>
          <h3 className="font-semibold">{t("coach.practice.history")}</h3>
          <ul className="mt-2 divide-y divide-border">
            {list.data.map((q) => (
              <li key={q.id}>
                <button type="button" onClick={() => onOpen(q.id)} className="flex w-full flex-wrap items-center justify-between gap-2 py-2 text-left text-sm hover:bg-muted/40">
                  <span className="min-w-0">
                    <span className="font-medium">{formatLabel(q.format)}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{fmtDateTime(q.createdAt)}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {q.status === "GRADED" && q.percentage !== null ? `${q.percentage}%` : t(`coach.quiz.status.${q.status}`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

const formatLabel = (f: QuizFormat) => t(`coach.format.${f}`);

function MasteryCard({ progress }: { progress: NonNullable<RouterOutputs["student"]["coach"]["practice"]["progress"]> }) {
  const statusKey = `coach.mastery.${progress.status}`;
  return (
    <Panel>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{t("coach.mastery.title")}</h3>
        <span className="text-2xl font-semibold tabular-nums">{Math.round(progress.mastery)}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.mastery)} aria-label={t("coach.mastery.title")}>
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, progress.mastery))}%` }} />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {isMessageKey(statusKey) ? t(statusKey) : progress.status} · {t("coach.mastery.attempts", { count: progress.attempts })}
      </p>
    </Panel>
  );
}

export function QuizRunner({ quizId, onClose, onLearn, backLabel }: { quizId: string; onClose: () => void; onLearn: () => void; backLabel?: string }) {
  const utils = trpc.useUtils();
  const q = trpc.student.coach.practice.get.useQuery({ quizId });
  const [answers, setAnswers] = useState<Record<string, StudentAnswer | undefined>>({});
  const save = trpc.student.coach.practice.saveAnswer.useMutation();
  const submit = trpc.student.coach.practice.submit.useMutation({
    onSuccess: (quiz) => {
      utils.student.coach.practice.get.setData({ quizId }, quiz);
      void utils.student.coach.practice.list.invalidate();
      void utils.student.coach.practice.progress.invalidate();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const quiz = q.data;
  const valueOf = (i: Item) => (Object.prototype.hasOwnProperty.call(answers, i.id) ? answers[i.id] : (i.answer ?? undefined));
  const graded = quiz.status === "GRADED";
  const unanswered = quiz.items.filter((i) => {
    const v = valueOf(i);
    return v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
  }).length;

  return (
    <>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>← {backLabel ?? t("coach.practice.back")}</Button>
          <span className="text-sm text-muted-foreground">{formatLabel(quiz.format)}</span>
        </div>
        {graded && <ScoreSummary quiz={quiz} />}
        {graded && (
          <div className="mt-3 flex flex-wrap gap-2">
            {quiz.percentage !== null && quiz.percentage < 80 && (
              <Button size="sm" variant="outline" onClick={onLearn}>{t("coach.mistakes.reread")}</Button>
            )}
            <Button size="sm" variant="outline" onClick={onClose}>{t("coach.practice.again")}</Button>
            {quiz.items.some((i) => i.result?.status === "WRONG") && (
              <Link href="/student/coach/mistakes" className="inline-flex items-center px-2 text-sm text-link hover:underline">{t("coach.practice.toMistakes")}</Link>
            )}
          </div>
        )}
      </Panel>
      {quiz.items.map((item, idx) => (
        <Panel key={item.id}>
          <p className="mb-2 text-xs text-muted-foreground">{t("coach.practice.question", { n: idx + 1, total: quiz.items.length })}</p>
          <QuestionRenderer
            q={item.question}
            value={valueOf(item)}
            disabled={graded || submit.isPending}
            onChange={(v) => {
              setAnswers((a) => ({ ...a, [item.id]: v }));
              save.mutate({ quizId, itemId: item.id, answer: v });
            }}
          />
          {!graded && <HintButton quizId={quizId} item={item} />}
          {graded && item.result && <ItemResult quizId={quizId} item={item} value={valueOf(item)} />}
        </Panel>
      ))}
      {!graded && (
        <Panel>
          {unanswered > 0 && <p className="mb-2 text-sm text-muted-foreground">{t("coach.practice.unanswered", { count: unanswered })}</p>}
          <Button
            className="w-full sm:w-auto"
            disabled={submit.isPending}
            onClick={() => (unanswered === 0 || window.confirm(t("coach.practice.submitConfirm"))) && submit.mutate({ quizId, answers })}
          >
            {submit.isPending ? t("coach.practice.checking") : t("coach.practice.submit")}
          </Button>
        </Panel>
      )}
    </>
  );
}

function ScoreSummary({ quiz }: { quiz: Quiz }) {
  return (
    <div className="mt-3 space-y-1">
      <p className="text-3xl font-semibold tabular-nums">{quiz.percentage === null ? "—" : `${quiz.percentage}%`}</p>
      <p className="text-sm text-muted-foreground">{t("coach.practice.score", { correct: quiz.correct, total: quiz.total })}</p>
      {quiz.pending > 0 && <p className="text-sm text-warning">{t("coach.practice.pending", { count: quiz.pending })}</p>}
      {quiz.hintsUsed > 0 && <p className="text-xs text-muted-foreground">{t("coach.practice.hintsUsed", { count: quiz.hintsUsed })}</p>}
    </div>
  );
}

function HintButton({ quizId, item }: { quizId: string; item: Item }) {
  const utils = trpc.useUtils();
  const [hint, setHint] = useState<string | null>(item.hint);
  const use = trpc.student.coach.practice.hint.useMutation({
    onSuccess: (r) => {
      setHint(r.hint);
      void utils.student.coach.practice.get.invalidate({ quizId });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!item.hasHint) return null;
  if (hint) return <p className="mt-3 rounded-lg border border-info/40 bg-info-surface p-3 text-sm">{hint}</p>;
  return (
    <Button size="sm" variant="ghost" className="mt-3" disabled={use.isPending} onClick={() => use.mutate({ quizId, itemId: item.id })}>
      <Lightbulb className="mr-1 h-4 w-4" aria-hidden />
      {t("coach.practice.hint")}
    </Button>
  );
}

const RESULT_COLORS: Record<string, string> = {
  ...ITEM_STATUS_COLORS,
  PARTIAL: "border-warning/40 bg-warning-surface",
  PROVISIONAL: "border-info/40 bg-info-surface",
};

function ItemResult({ quizId, item, value }: { quizId: string; item: Item; value: StudentAnswer | undefined }) {
  const utils = trpc.useUtils();
  const r = item.result!;
  const status = r.status ?? "PENDING_REVIEW";
  const statusKey = `coach.item.${status}`;
  const regrade = trpc.student.coach.practice.regrade.useMutation({
    onSuccess: (quiz) => {
      utils.student.coach.practice.get.setData({ quizId }, quiz);
      void utils.student.coach.practice.progress.invalidate();
      void utils.student.coach.practice.list.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const fb = r.feedback;
  return (
    <div className={`mt-4 space-y-2 rounded-xl border p-3 text-sm ${RESULT_COLORS[status] ?? "border-border bg-muted"}`}>
      <p className="font-medium">
        {isMessageKey(statusKey) ? t(statusKey) : status}
        {(status === "PARTIAL" || (r.gradedBy !== "RULE" && item.question.type === "LONG_ANSWER" && r.score !== null)) && <span className="ml-2 tabular-nums text-muted-foreground">{r.score}%</span>}
      </p>
      {r.gradedBy && r.gradedBy !== "RULE" && <p className="text-xs text-muted-foreground">{t(r.gradedBy === "AI_PRO" ? "coach.grade.byPro" : "coach.grade.byAi")}</p>}
      {status === "PROVISIONAL" && <p className="text-xs">{t("coach.grade.provisional")}</p>}
      {r.disputed && <p className="text-xs text-muted-foreground">{t("coach.grade.disputed")}</p>}
      <dl className="space-y-1">
        <div>
          <dt className="inline text-muted-foreground">{t("coach.practice.yourAnswer")}: </dt>
          <dd className="inline break-words">{answerText(value, item.question)}</dd>
        </div>
        {r.correctAnswer !== null && item.question.type !== "LONG_ANSWER" && (
          <div>
            <dt className="inline text-muted-foreground">{t("student.correctAnswer")}: </dt>
            <dd className="inline break-words">{answerText(r.correctAnswer, item.question)}</dd>
          </div>
        )}
      </dl>
      {fb && (
        <div className="space-y-1 rounded-lg bg-background/60 p-2">
          <p className="leading-relaxed">{fb.summary}</p>
          {!!fb.good?.length && <FeedbackList title={t("coach.grade.good")} items={fb.good} />}
          {!!fb.missing?.length && <FeedbackList title={t("coach.grade.missing")} items={fb.missing} />}
          {!!fb.rubric?.length && (
            <ul className="space-y-0.5" aria-label={t("coach.grade.rubric")}>
              {fb.rubric.map((p, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden className={p.met ? "text-success" : "text-destructive"}>{p.met ? "✓" : "✗"}</span>
                  <span className="sr-only">{p.met ? t("coach.grade.met") : t("coach.grade.notMet")}</span>
                  <span className="min-w-0 break-words">{p.point}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!fb && r.rubric && (
        <div>
          <p className="text-muted-foreground">{t("coach.grade.rubric")}:</p>
          <p className="whitespace-pre-wrap break-words">{r.rubric}</p>
        </div>
      )}
      {r.calcVerified === false && <p className="text-xs text-muted-foreground">{t("coach.grade.calcUnchecked")}</p>}
      {r.explanation && <p className="leading-relaxed">{r.explanation}</p>}
      {r.cites.length > 0 && <Sources cites={r.cites} general={false} />}
      {r.canRegrade && (
        <Button size="sm" variant="outline" disabled={regrade.isPending} onClick={() => regrade.mutate({ quizId, itemId: item.id })}>
          {regrade.isPending ? t("coach.practice.checking") : status === "PENDING_REVIEW" ? t("coach.grade.retry") : t("coach.grade.dispute")}
        </Button>
      )}
    </div>
  );
}

function FeedbackList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-muted-foreground">{title}</p>
      <ul className="list-disc pl-5">{items.map((s, i) => <li key={i} className="break-words">{s}</li>)}</ul>
    </div>
  );
}
