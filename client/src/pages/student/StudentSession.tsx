import { Loading } from "@/components/AppShell";
import { QuestionRenderer } from "@/components/QuestionRenderer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n/messages";
import { clockJumped, clockOffset, crossedWarning, displaySeconds, remainingMs } from "@/lib/examClock";
import { errorText, fmtClock } from "@/lib/format";
import { resultPath, safeReturnPath } from "@/lib/syllabusLearn";
import { trpc } from "@/lib/trpc";
import type { StudentAnswer } from "@shared/assessment";
import { AlarmClock, Check, Clock, CloudOff, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { toast } from "sonner";
import { Link, Redirect, useLocation, useParams, useSearch } from "wouter";

const SAVE_DELAY_MS = 1200;
const RETRY_MS = 8000;
const PING_MS = 60_000;
const TICK_MS = 250;
/** Extra server time checks when the tab is shown again, focused or back online are at most this frequent. */
const RESYNC_MIN_MS = 10_000;
/** A slower round trip says too little about the server clock to correct the offset. */
const MAX_SYNC_RTT_MS = 10_000;
/** Close to the deadline an answer is saved at once instead of after the typing pause. */
const FLUSH_NOW_BEFORE_DEADLINE_MS = 5000;
const FINISH_RETRY_MS = 5000;
/** Fail fast instead of pausing while offline: this page keeps answers on the device and retries itself. */
const NETWORK = { networkMode: "always" } as const;

type SaveState = "saved" | "pending" | "saving" | "offline";
type FlushOutcome = "saved" | "offline" | "closed";
type FinishState = "idle" | "submitting" | "retrying";
type ExamClock = { deadlineMs: number; offsetMs: number };

function isAnswered(v: StudentAnswer | undefined) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.some((x) => String(x).trim().length > 0);
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

const isClosedError = (e: unknown) => e instanceof Error && e.message === "ATTEMPT_CLOSED";

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

/**
 * The only part of the page that re-renders every second. Reads the clock on a steady interval and
 * again whenever the page comes back (tab shown, focus, resumed from freezing).
 */
function Countdown({
  clock,
  onExpiredChange,
  onWarning,
  onClockJump,
}: {
  clock: MutableRefObject<ExamClock>;
  onExpiredChange: (expired: boolean) => void;
  onWarning: (minutes: number) => void;
  onClockJump: () => void;
}) {
  const read = () => remainingMs(clock.current.deadlineMs, clock.current.offsetMs);
  const [seconds, setSeconds] = useState(() => displaySeconds(read()));
  const handlers = useRef({ onExpiredChange, onWarning, onClockJump });
  handlers.current = { onExpiredChange, onWarning, onClockJump };

  useEffect(() => {
    let lastWall = Date.now();
    let lastRemaining: number | null = null;
    let expired: boolean | null = null;
    const tick = () => {
      const wall = Date.now();
      if (clockJumped(lastWall, wall, TICK_MS)) handlers.current.onClockJump();
      lastWall = wall;
      const ms = remainingMs(clock.current.deadlineMs, clock.current.offsetMs, wall);
      const warning = crossedWarning(lastRemaining, ms);
      if (warning !== null) handlers.current.onWarning(warning / 60_000);
      lastRemaining = ms;
      setSeconds(displaySeconds(ms));
      if ((ms <= 0) !== expired) {
        expired = ms <= 0;
        handlers.current.onExpiredChange(expired);
      }
    };
    tick();
    const interval = setInterval(tick, TICK_MS);
    const onShow = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onShow);
    document.addEventListener("resume", tick);
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onShow);
      document.removeEventListener("resume", tick);
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
    };
  }, [clock]);

  const lowTime = seconds <= 60;
  const text = fmtClock(seconds * 1000);
  return (
    <div
      role="timer"
      aria-label={lowTime ? t("session.lowTime", { time: text }) : t("session.timeLeft", { time: text })}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-lg tabular-nums ${lowTime ? "border-destructive/40 bg-danger-surface text-destructive" : "border-transparent bg-muted text-foreground"}`}
    >
      {lowTime ? <AlarmClock className="h-4 w-4" aria-hidden /> : <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />}
      {text}
    </div>
  );
}

export default function StudentSession() {
  const { id } = useParams<{ id: string }>();
  const attemptId = id!;
  const [, navigate] = useLocation();
  const returnTo = safeReturnPath(new URLSearchParams(useSearch()).get("returnTo"));
  const utils = trpc.useUtils();
  const session = trpc.student.session.useQuery({ attemptId }, { enabled: Boolean(id), refetchOnWindowFocus: false, retry: false, ...NETWORK });
  const save = trpc.student.save.useMutation(NETWORK);
  const submit = trpc.student.submit.useMutation(NETWORK);
  const ping = trpc.student.ping.useMutation(NETWORK);

  const [answers, setAnswers] = useState<Record<string, StudentAnswer>>({});
  const [current, setCurrent] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expired, setExpired] = useState(false);
  const [finishState, setFinishState] = useState<FinishState>("idle");
  const pending = useRef<Record<string, StudentAnswer>>({});
  /** Per-question revision of the pending value; strictly increasing across the attempt. */
  const revisions = useRef<Record<string, number>>({});
  const revision = useRef(0);
  const interacted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<FlushOutcome> | null>(null);
  const clock = useRef<ExamClock>({ deadlineMs: 0, offsetMs: 0 });
  const clockReady = useRef(false);
  const lastSync = useRef(-RESYNC_MIN_MS);
  /** The device clock jumped (or the page slept) and the offset has not been re-measured since. */
  const jumped = useRef(false);
  const finishing = useRef(false);
  const initialised = useRef(false);

  const data = session.data && !session.data.done ? session.data : null;
  const refetch = session.refetch;
  const saveAsync = save.mutateAsync;
  const submitAsync = submit.mutateAsync;
  const pingAsync = ping.mutateAsync;

  if (data && !clockReady.current) {
    clockReady.current = true;
    clock.current = {
      deadlineMs: new Date(data.deadlineAt).getTime(),
      offsetMs: clockOffset(new Date(data.serverNow).getTime(), session.dataUpdatedAt || Date.now()),
    };
  }

  useEffect(() => {
    if (!data || initialised.current) return;
    initialised.current = true;
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

  const flush = useCallback(async (): Promise<FlushOutcome> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) await inFlight.current;
    const batch = { ...pending.current };
    const entries = Object.entries(batch).map(([questionId, answer]) => ({ questionId, answer, revision: revisions.current[questionId] }));
    if (!entries.length) return "saved";
    setSaveState("saving");
    const run = saveAsync({ attemptId, entries })
      .then((): FlushOutcome => {
        for (const [k, v] of Object.entries(batch)) {
          if (pending.current[k] !== v) continue;
          delete pending.current[k];
          delete revisions.current[k];
        }
        writeBuffer(attemptId, pending.current, revisions.current);
        setSaveState(Object.keys(pending.current).length ? "pending" : "saved");
        return "saved";
      })
      .catch((e: unknown): FlushOutcome => {
        if (isClosedError(e)) {
          void refetch();
          return "closed";
        }
        setSaveState("offline");
        return "offline";
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
    const soon = remainingMs(clock.current.deadlineMs, clock.current.offsetMs) < FLUSH_NOW_BEFORE_DEADLINE_MS;
    timer.current = setTimeout(() => void flush(), soon ? 0 : SAVE_DELAY_MS);
  };

  /** Re-reads the server deadline and clock. Also the session heartbeat. */
  const resync = useCallback(
    async (minGapMs: number): Promise<"open" | "closed" | "unreachable" | "skipped"> => {
      // Monotonic: the device clock itself may just have jumped.
      if (performance.now() - lastSync.current < minGapMs) return "skipped";
      lastSync.current = performance.now();
      const wasActive = interacted.current;
      interacted.current = false;
      const sentPerf = performance.now();
      try {
        const r = await pingAsync({ attemptId, interacted: wasActive });
        if (!r.open) {
          void refetch();
          return "closed";
        }
        // The round trip is timed monotonically and anchored at the receive time, so it stays valid
        // even if the device clock jumped while the request was in flight.
        const roundTrip = performance.now() - sentPerf;
        const receivedAt = Date.now();
        clock.current.deadlineMs = new Date(r.deadlineAt).getTime();
        if (roundTrip < MAX_SYNC_RTT_MS) {
          clock.current.offsetMs = clockOffset(new Date(r.serverNow).getTime(), receivedAt - roundTrip, receivedAt);
          jumped.current = false;
        }
        return "open";
      } catch {
        interacted.current ||= wasActive;
        return "unreachable";
      }
    },
    [attemptId, pingAsync, refetch],
  );

  const sessionOpen = Boolean(data);
  useEffect(() => {
    if (!sessionOpen) return;
    const beat = () => {
      if (document.visibilityState === "visible") void resync(0);
    };
    const wake = () => {
      if (document.visibilityState === "visible") void resync(jumped.current ? 0 : RESYNC_MIN_MS);
    };
    beat();
    const interval = setInterval(beat, PING_MS);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [sessionOpen, resync]);

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

  useEffect(() => {
    if (session.data?.done) writeBuffer(attemptId, {});
  }, [session.data, attemptId]);

  const answeredCount = useMemo(() => (data ? data.questions.filter((q) => isAnswered(answers[q.id])).length : 0), [data, answers]);

  const assessmentId = data?.assessmentId;
  const leave = useCallback(
    (resultId: string | null) => {
      if (returnTo) {
        void utils.student.syllabus.invalidate();
        toast.success(t("learn.assessment.submitted"));
        navigate(resultId ? resultPath(resultId, returnTo) : returnTo);
      } else if (resultId) navigate(resultPath(resultId, null));
      else {
        toast.info(t("session.timeUpNoAnswers"));
        navigate(`/student/assessments/${assessmentId ?? ""}`);
      }
    },
    [returnTo, utils, navigate, assessmentId],
  );

  const doSubmit = async () => {
    await flush();
    try {
      const r = await submitAsync({ attemptId });
      writeBuffer(attemptId, {});
      leave(r.resultId);
    } catch (e) {
      toast.error(errorText(e));
      void refetch();
    }
  };

  /**
   * At 00:00: confirm the deadline with the server (a wrong device clock must not end the exam early),
   * save what is still on the device, then submit. Repeats until it gets through.
   */
  const autoFinishRef = useRef(async () => {});
  const finishRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoFinish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    if (finishRetry.current) clearTimeout(finishRetry.current);
    setFinishState("submitting");
    const retryLater = () => {
      setFinishState("retrying");
      finishRetry.current = setTimeout(() => void autoFinishRef.current(), FINISH_RETRY_MS);
    };
    try {
      const sync = await resync(0);
      if (sync === "closed") return;
      if (sync === "unreachable") return retryLater();
      if (remainingMs(clock.current.deadlineMs, clock.current.offsetMs) > 0) {
        setFinishState("idle");
        return;
      }
      const saved = await flush();
      if (saved === "closed") return;
      if (saved === "offline") return retryLater();
      const r = await submitAsync({ attemptId });
      writeBuffer(attemptId, {});
      if (r.resultId) toast.info(t("session.timeUp"));
      leave(r.resultId);
    } catch (e) {
      if (isClosedError(e)) void refetch();
      else retryLater();
    } finally {
      finishing.current = false;
    }
  }, [resync, flush, submitAsync, attemptId, leave, refetch]);
  autoFinishRef.current = autoFinish;

  useEffect(() => {
    if (expired) void autoFinishRef.current();
    else setFinishState("idle");
  }, [expired]);

  useEffect(() => {
    if (finishState !== "retrying") return;
    const again = () => void autoFinishRef.current();
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [finishState]);

  useEffect(
    () => () => {
      if (finishRetry.current) clearTimeout(finishRetry.current);
    },
    [],
  );

  const onWarning = useCallback((minutes: number) => toast.warning(t("session.minutesLeft", { count: minutes })), []);
  const onClockJump = useCallback(() => {
    jumped.current = true;
    if (document.visibilityState === "visible") void resync(0);
  }, [resync]);

  if (session.error && !session.data) {
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
    return <Redirect to={session.data.resultId ? resultPath(session.data.resultId, returnTo) : (returnTo ?? "/student/results")} />;
  }
  if (!data) return <Loading />;

  const q = data.questions[current];
  const saveLabel: Record<SaveState, string> = {
    saved: t("session.saved"),
    pending: t("session.pending"),
    saving: t("session.saving"),
    offline: t("session.offline"),
  };

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
        <Countdown clock={clock} onExpiredChange={setExpired} onWarning={onWarning} onClockJump={onClockJump} />
        <Button className="shrink-0" onClick={() => setConfirmOpen(true)} disabled={expired || submit.isPending}>{t("session.submit")}</Button>
      </header>

      {expired && finishState !== "idle" && (
        <div
          role={finishState === "retrying" ? "alert" : "status"}
          className={`flex items-start gap-2 border-b px-4 py-2 text-sm ${finishState === "retrying" ? "bg-danger-surface text-destructive" : "bg-muted text-foreground"}`}
        >
          {finishState === "retrying" ? <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden />}
          <span className="min-w-0 break-words">{finishState === "retrying" ? t("session.timeUpRetrying") : t("session.timeUpSubmitting")}</span>
        </div>
      )}

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

      <Dialog open={confirmOpen && !expired} onOpenChange={setConfirmOpen}>
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
