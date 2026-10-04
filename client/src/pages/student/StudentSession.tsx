import { Loading } from "@/components/AppShell";
import { QuestionRenderer } from "@/components/QuestionRenderer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n/messages";
import { errorText, fmtClock } from "@/lib/format";
import { safeReturnPath } from "@/lib/syllabusLearn";
import { trpc } from "@/lib/trpc";
import type { StudentAnswer } from "@shared/assessment";
import { AlarmClock, Check, Clock, CloudOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, Redirect, useLocation, useParams, useSearch } from "wouter";

const SAVE_DELAY_MS = 1200;
const RETRY_MS = 8000;
const PING_MS = 60_000;

type SaveState = "saved" | "pending" | "saving" | "offline";

function isAnswered(v: StudentAnswer | undefined) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.some((x) => String(x).trim().length > 0);
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function bufferKey(attemptId: string) {
  return `resulio:attempt:${attemptId}`;
}

function readBuffer(attemptId: string): Record<string, StudentAnswer> {
  try {
    return JSON.parse(localStorage.getItem(bufferKey(attemptId)) ?? "{}");
  } catch {
    return {};
  }
}

function writeBuffer(attemptId: string, pending: Record<string, StudentAnswer>, revisions: Record<string, number> = {}) {
  try {
    if (Object.keys(pending).length) {
      localStorage.setItem(bufferKey(attemptId), JSON.stringify(pending));
      localStorage.setItem(`${bufferKey(attemptId)}:rev`, JSON.stringify(revisions));
    } else {
      localStorage.removeItem(bufferKey(attemptId));
      localStorage.removeItem(`${bufferKey(attemptId)}:rev`);
    }
  } catch {
    // storage full or disabled: the server copy is still authoritative
  }
}

function readRevisions(attemptId: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(`${bufferKey(attemptId)}:rev`) ?? "{}");
  } catch {
    return {};
  }
}

export default function StudentSession() {
  const { id } = useParams<{ id: string }>();
  const attemptId = id!;
  const [, navigate] = useLocation();
  const returnTo = safeReturnPath(new URLSearchParams(useSearch()).get("returnTo"));
  const utils = trpc.useUtils();
  const session = trpc.student.session.useQuery({ attemptId }, { enabled: Boolean(id), refetchOnWindowFocus: false, retry: false });
  const save = trpc.student.save.useMutation();
  const submit = trpc.student.submit.useMutation();
  const ping = trpc.student.ping.useMutation();

  const [answers, setAnswers] = useState<Record<string, StudentAnswer>>({});
  const [current, setCurrent] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pending = useRef<Record<string, StudentAnswer>>({});
  /** Per-question revision of the pending value; strictly increasing across the attempt. */
  const revisions = useRef<Record<string, number>>({});
  const revision = useRef(0);
  const interacted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const offset = useRef(0);
  const initialised = useRef(false);

  const data = session.data && !session.data.done ? session.data : null;
  const refetch = session.refetch;
  const saveAsync = save.mutateAsync;

  useEffect(() => {
    if (!data || initialised.current) return;
    initialised.current = true;
    offset.current = new Date(data.serverNow).getTime() - Date.now();
    const buffered = readBuffer(attemptId);
    const bufferedRevisions = readRevisions(attemptId);
    const known = new Set(data.questions.map((q) => q.id));
    pending.current = Object.fromEntries(Object.entries(buffered).filter(([k]) => known.has(k)));
    revision.current = Math.max(data.revision, ...Object.values(bufferedRevisions).filter(Number.isFinite));
    // A buffered answer keeps its original revision, so a newer answer saved from another device wins.
    for (const k of Object.keys(pending.current)) revisions.current[k] = bufferedRevisions[k] ?? ++revision.current;
    setAnswers({ ...data.answers, ...pending.current });
    if (Object.keys(pending.current).length) setSaveState("pending");
  }, [data, attemptId]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) await inFlight.current;
    const batch = { ...pending.current };
    const entries = Object.entries(batch).map(([questionId, answer]) => ({ questionId, answer, revision: revisions.current[questionId] }));
    if (!entries.length) return true;
    setSaveState("saving");
    const run = saveAsync({ attemptId, entries })
      .then(() => {
        for (const [k, v] of Object.entries(batch)) {
          if (pending.current[k] !== v) continue;
          delete pending.current[k];
          delete revisions.current[k];
        }
        writeBuffer(attemptId, pending.current, revisions.current);
        setSaveState(Object.keys(pending.current).length ? "pending" : "saved");
        return true;
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.message === "ATTEMPT_CLOSED") void refetch();
        else setSaveState("offline");
        return false;
      })
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = run;
    return run;
  }, [attemptId, saveAsync, refetch]);

  const onChange = (questionId: string, value: StudentAnswer) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    pending.current[questionId] = value;
    revisions.current[questionId] = ++revision.current;
    interacted.current = true;
    writeBuffer(attemptId, pending.current, revisions.current);
    setSaveState("pending");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(tick);
  }, []);

  const pingAsync = ping.mutateAsync;
  const sessionOpen = Boolean(data);
  useEffect(() => {
    if (!sessionOpen) return;
    const send = () => {
      if (document.visibilityState !== "visible") return;
      const wasActive = interacted.current;
      interacted.current = false;
      pingAsync({ attemptId, interacted: wasActive })
        .then((r) => {
          if (!r.open) void refetch();
        })
        .catch(() => {
          interacted.current ||= wasActive;
        });
    };
    send();
    const interval = setInterval(send, PING_MS);
    return () => clearInterval(interval);
  }, [sessionOpen, attemptId, pingAsync, refetch]);

  const questionRef = useRef<HTMLElement>(null);
  const navigated = useRef(false);
  const goTo = (index: number) => {
    interacted.current = true;
    navigated.current = true;
    setCurrent(index);
    void flush();
  };

  // Screen readers land on the new question; the page itself does not scroll.
  useEffect(() => {
    if (navigated.current) questionRef.current?.focus({ preventScroll: true });
  }, [current]);

  useEffect(() => {
    if (saveState !== "offline") return;
    const retry = setTimeout(() => void flush(), RETRY_MS);
    return () => clearTimeout(retry);
  }, [saveState, flush]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const remainingMs = data ? new Date(data.deadlineAt).getTime() - (now + offset.current) : 0;
  const expired = Boolean(data) && remainingMs <= 0;
  const expiryHandled = useRef(false);
  useEffect(() => {
    if (!expired || expiryHandled.current) return;
    expiryHandled.current = true;
    toast.info(t("session.timeUp"));
    const later = setTimeout(() => void refetch(), 1500);
    return () => clearTimeout(later);
  }, [expired, refetch]);

  useEffect(() => {
    if (session.data?.done) writeBuffer(attemptId, {});
  }, [session.data, attemptId]);

  const answeredCount = useMemo(() => (data ? data.questions.filter((q) => isAnswered(answers[q.id])).length : 0), [data, answers]);

  const doSubmit = async () => {
    await flush();
    try {
      const r = await submit.mutateAsync({ attemptId });
      writeBuffer(attemptId, {});
      if (returnTo) {
        void utils.student.syllabus.invalidate();
        toast.success(t("learn.assessment.submitted"));
        navigate(returnTo);
      } else if (r.resultId) navigate(`/student/results/${r.resultId}`);
      else {
        toast.info(t("session.timeUpNoAnswers"));
        navigate(`/student/assessments/${data?.assessmentId ?? ""}`);
      }
    } catch (e) {
      toast.error(errorText(e));
      void refetch();
    }
  };

  if (session.error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border bg-card p-6 text-center">
          <p role="alert" className="text-sm text-destructive">{errorText(session.error)}</p>
          <Button asChild className="mt-4" variant="outline">
            <Link href={returnTo ?? "/student/assessments"}>{returnTo ? t("learn.backToLesson") : t("session.backToExams")}</Link>
          </Button>
        </div>
      </div>
    );
  }
  if (session.data?.done) {
    return <Redirect to={returnTo ?? (session.data.resultId ? `/student/results/${session.data.resultId}` : "/student/results")} />;
  }
  if (!data) return <Loading />;

  const q = data.questions[current];
  const lowTime = remainingMs < 60_000;
  const saveLabel: Record<SaveState, string> = {
    saved: t("session.saved"),
    pending: t("session.pending"),
    saving: t("session.saving"),
    offline: t("session.offline"),
  };
  const clock = fmtClock(remainingMs);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold" title={data.title}>{data.title}</div>
          <div role="status" className={`flex items-center gap-1 text-xs ${saveState === "offline" ? "text-destructive" : "text-muted-foreground"}`}>
            {saveState === "offline" && <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            <span className="min-w-0 break-words">{saveLabel[saveState]}</span>
          </div>
        </div>
        <div
          role="timer"
          aria-label={lowTime ? t("session.lowTime", { time: clock }) : t("session.timeLeft", { time: clock })}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-lg tabular-nums ${lowTime ? "border-destructive/40 bg-danger-surface text-destructive" : "border-transparent bg-muted text-foreground"}`}
        >
          {lowTime ? <AlarmClock className="h-4 w-4" aria-hidden /> : <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />}
          {clock}
        </div>
        <Button className="shrink-0" onClick={() => setConfirmOpen(true)} disabled={expired || submit.isPending}>{t("session.submit")}</Button>
      </header>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-4 lg:flex-row">
        <nav aria-label={t("session.navigator")} className="order-2 lg:order-1 lg:w-56">
          <div className="rounded-2xl border bg-card p-3">
            <div className="mb-2 text-xs text-muted-foreground">{t("session.answeredCount", { done: answeredCount, total: data.questions.length })}</div>
            <div className="grid grid-cols-6 gap-1.5 min-[360px]:grid-cols-8 lg:grid-cols-5">
              {data.questions.map((x, i) => {
                const done = isAnswered(answers[x.id]);
                return (
                  <button
                    key={x.id}
                    type="button"
                    onClick={() => goTo(i)}
                    aria-current={i === current ? "step" : undefined}
                    aria-label={done ? t("session.navAnswered", { n: x.position }) : t("session.navUnanswered", { n: x.position })}
                    className={`relative h-9 rounded-lg border text-sm ${i === current ? "border-primary ring-2 ring-ring" : "border-input"} ${done ? "bg-info-surface font-semibold text-foreground" : "bg-card text-foreground-secondary"}`}
                  >
                    {x.position}
                    {done && <Check className="absolute right-0.5 top-0.5 h-3 w-3 text-link" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </div>
          {data.instructions && <div className="mt-3 rounded-2xl border bg-card p-3 text-xs whitespace-pre-wrap text-foreground-secondary">{data.instructions}</div>}
        </nav>

        <main className="order-1 flex-1 lg:order-2">
          {q && (
            <section
              ref={questionRef}
              tabIndex={-1}
              aria-label={t("session.questionOf", { n: q.position, total: data.questions.length })}
              className="rounded-2xl border bg-card p-5 focus:outline-none"
            >
              <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>{t("session.questionOf", { n: q.position, total: data.questions.length })}</span>
                <span>{t("common.points", { count: q.points })}</span>
              </div>
              <QuestionRenderer q={q} value={answers[q.id]} onChange={(v) => onChange(q.id, v)} disabled={expired} />
            </section>
          )}
          <div className="mt-4 flex justify-between gap-2">
            <Button variant="outline" disabled={current === 0} onClick={() => goTo(current - 1)}>{t("session.previous")}</Button>
            {current < data.questions.length - 1 ? (
              <Button variant="outline" onClick={() => goTo(current + 1)}>{t("session.next")}</Button>
            ) : (
              <Button onClick={() => setConfirmOpen(true)} disabled={expired}>{t("session.finish")}</Button>
            )}
          </div>
        </main>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("session.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {data.questions.length - answeredCount > 0
                ? t("session.confirmUnanswered", { count: data.questions.length - answeredCount })
                : t("session.confirmAll")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>{t("common.back")}</Button>
            <Button disabled={submit.isPending} onClick={() => void doSubmit()}>{t("session.submit")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
