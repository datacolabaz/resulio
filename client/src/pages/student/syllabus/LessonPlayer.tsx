import { AppShell, ChoiceChip, ErrorNote, Loading, Pill } from "@/components/AppShell";
import { MultiFileUpload } from "@/components/FileUpload";
import { StatusBadge, toneSurface } from "@/components/StatusBadge";
import { StudentItemView } from "@/components/syllabus/StudentItemView";
import type { MaterialRef, VideoSignal } from "@/components/syllabus/TheoryView";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t, type MessageKey } from "@/i18n/messages";
import { attemptLabel } from "@/lib/attemptLabel";
import { errorText, fmtDateTime } from "@/lib/format";
import { minutesUntil, nodeVisual, resultPath, type LockReason } from "@/lib/syllabusLearn";
import type { ActivityEvent } from "@/lib/syllabusTracker";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { UploadedFile } from "@/lib/uploadFile";
import type { SyllabusItemKind } from "@shared/syllabus";
import { BookOpen, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, FolderOpen, Hourglass, Lock, PenLine, Presentation, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams } from "wouter";
import { lessonPath, lockText, NodeIcon, sessionPath, statusText, syllabusPath } from "./common";
import { useActivity, useHeartbeat } from "./useActivity";

type LessonData = NonNullable<RouterOutputs["student"]["syllabus"]["lesson"]>;
type Unlocked = Extract<LessonData, { locked: false }>;
type Item = Unlocked["items"][number];
type PathData = RouterOutputs["student"]["syllabus"]["path"];
type Recorder = (e: ActivityEvent) => void;

const KIND_ORDER: SyllabusItemKind[] = ["THEORY", "TEACHER_PRACTICE", "STUDENT_PRACTICE", "ASSESSMENT", "RESOURCE"];
const KIND_ICON: Record<SyllabusItemKind, typeof BookOpen> = {
  THEORY: BookOpen,
  TEACHER_PRACTICE: Presentation,
  STUDENT_PRACTICE: PenLine,
  ASSESSMENT: ClipboardCheck,
  RESOURCE: FolderOpen,
};

const practiceOf = (i: Item) => ("practice" in i ? i.practice : null);
const assessmentOf = (i: Item) => ("assessment" in i ? i.assessment : null);
const aiChecking = (d: LessonData | null | undefined) => !!d && !d.locked && d.items.some((i) => practiceOf(i)?.submission?.pending === "AI_CHECKING");

export function LessonPlayer() {
  const { id, lessonId } = useParams<{ id: string; lessonId: string }>();
  const lesson = trpc.student.syllabus.lesson.useQuery({ id, lessonId }, { retry: false, refetchInterval: (q) => (aiChecking(q.state.data) ? 5000 : false) });
  const path = trpc.student.syllabus.path.useQuery({ id }, { retry: false });
  const unlocked = !!lesson.data && !lesson.data.locked;
  const record = useActivity(unlocked ? id : undefined);
  useHeartbeat(record, unlocked ? lessonId : undefined);
  useEffect(() => {
    if (unlocked) record({ type: "LESSON_OPENED", lessonId });
  }, [unlocked, lessonId, record]);

  return (
    <AppShell area="learning">
      <div className="mx-auto max-w-4xl space-y-4">
        <Link href={syllabusPath(id)} className="inline-flex items-center gap-1 text-sm text-link hover:underline">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {path.data?.syllabus.title ?? t("learn.backToPath")}
        </Link>
        {lesson.error ? (
          <ErrorNote error={lesson.error} />
        ) : !lesson.data ? (
          <Loading />
        ) : lesson.data.locked ? (
          <LockedLesson id={id} data={lesson.data} path={path.data} />
        ) : (
          <LessonBody key={lessonId} id={id} data={lesson.data} path={path.data} record={record} />
        )}
      </div>
    </AppShell>
  );
}

function lessonNumbers(path: PathData | undefined, lessonId: string) {
  if (!path) return null;
  for (const [mi, m] of path.modules.entries()) {
    const li = m.lessons.findIndex((l) => l.id === lessonId);
    if (li >= 0) return { module: mi + 1, lesson: li + 1 };
  }
  return null;
}

function LockedLesson({ id, data, path }: { id: string; data: Extract<LessonData, { locked: true }>; path: PathData | undefined }) {
  const n = lessonNumbers(path, data.lesson.id);
  const reason = path ? lockText(data.lockReason as LockReason | null, path) : null;
  return (
    <section className="space-y-3 rounded-2xl border border-dashed border-border bg-card p-6 text-center">
      <Lock className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
      {n && <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("learn.moduleN", { n: n.module })} · {t("learn.lessonN", { n: n.lesson })}</p>}
      <h1 className="break-words text-xl font-semibold">{data.lesson.title}</h1>
      <p className="text-sm text-foreground-secondary">{reason ?? t("learn.lockedLesson")}</p>
      <Button asChild variant="outline">
        <Link href={syllabusPath(id)}>{t("learn.backToPath")}</Link>
      </Button>
    </section>
  );
}

function LessonBody({ id, data, path, record }: { id: string; data: Unlocked; path: PathData | undefined; record: Recorder }) {
  const kinds = KIND_ORDER.filter((k) => data.items.some((i) => i.kind === k));
  const firstOpen = kinds.find((k) => data.items.some((i) => i.kind === k && i.required && i.state !== "MET" && i.state !== "NOT_REQUIRED")) ?? kinds[0];
  const [kind, setKind] = useState<SyllabusItemKind | undefined>(firstOpen);
  const n = lessonNumbers(path, data.lesson.id);
  const materials = useMemo(() => {
    const refs: Array<[string, MaterialRef]> = data.materials.map((m) => [m.id, { title: m.title, fileId: m.fileId }]);
    return new Map(refs);
  }, [data.materials]);
  const items = data.items.filter((i) => i.kind === kind).sort((a, b) => a.position - b.position);
  const visual = nodeVisual(data.status, data.status !== "COMPLETED");
  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {n ? `${t("learn.moduleN", { n: n.module })} · ${data.lesson.moduleTitle} · ${t("learn.lessonN", { n: n.lesson })}` : data.lesson.moduleTitle}
        </p>
        <div className="flex flex-wrap items-start gap-3">
          <NodeIcon visual={visual} className="mt-1 h-6 w-6" />
          <h1 className="min-w-0 flex-1 break-words font-[family-name:var(--font-display)] text-2xl">{data.lesson.title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill>{statusText(data.status)}</Pill>
          {data.optional && <Pill>{t("learn.optional")}</Pill>}
          {data.lesson.estimatedMinutes ? <Pill>{t("learn.minutes", { count: data.lesson.estimatedMinutes })}</Pill> : null}
        </div>
        {data.lesson.description && <p className="whitespace-pre-wrap break-words text-sm text-foreground-secondary">{data.lesson.description}</p>}
        {data.lesson.objectives.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="mb-1 text-sm font-medium">{t("learn.objectives")}</p>
            <ul className="ml-5 list-disc text-sm text-foreground-secondary">
              {data.lesson.objectives.map((o, i) => (
                <li key={i} className="break-words">{o}</li>
              ))}
            </ul>
          </div>
        )}
      </header>
      <LessonStatusNote data={data} />
      {kinds.length > 1 && (
        <nav className="flex flex-wrap gap-2" aria-label={t("learn.sections")}>
          {kinds.map((k) => {
            const list = data.items.filter((i) => i.kind === k);
            const done = list.filter((i) => i.state === "MET").length;
            const Icon = KIND_ICON[k];
            return (
              <ChoiceChip key={k} selected={kind === k} onClick={() => setKind(k)}>
                <Icon className="h-4 w-4" aria-hidden />
                {t(`syllabus.kind.${k}` as MessageKey)}
                <span className="tabular-nums text-xs opacity-80">{done}/{list.length}</span>
              </ChoiceChip>
            );
          })}
        </nav>
      )}
      {!data.items.length && <p className="text-sm text-muted-foreground">{t("learn.noItems")}</p>}
      <div className="space-y-4">
        {items.map((item) => (
          <ItemCard key={item.id} id={id} lessonId={data.lesson.id} item={item} rules={data.rules} materials={materials} record={record} />
        ))}
      </div>
      <LessonFooter id={id} data={data} />
    </div>
  );
}

function LessonStatusNote({ data }: { data: Unlocked }) {
  if (data.status === "COMPLETED") {
    return (
      <div className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${toneSurface("success")}`} role="status">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {t("learn.lessonDone")}
      </div>
    );
  }
  if (data.status === "AWAITING_REVIEW" || data.status === "AWAITING_APPROVAL") {
    return (
      <div className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${toneSurface("warning")}`} role="status">
        <Hourglass className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {data.status === "AWAITING_REVIEW" ? t("learn.awaitingReview") : t("learn.awaitingApproval")}
      </div>
    );
  }
  return null;
}

function ItemStateBadge({ item }: { item: Item }) {
  if (item.state === "MET") return <StatusBadge tone="success">{t("learn.item.done")}</StatusBadge>;
  if (item.state === "PENDING") return <StatusBadge tone="warning">{t("learn.item.pending")}</StatusBadge>;
  if (item.state === "FAILED") return <StatusBadge tone="danger">{t("learn.item.failed")}</StatusBadge>;
  if (!item.required || item.state === "NOT_REQUIRED") return <StatusBadge tone="neutral">{t("learn.optional")}</StatusBadge>;
  return null;
}

function ItemCard({
  id,
  lessonId,
  item,
  rules,
  materials,
  record,
}: {
  id: string;
  lessonId: string;
  item: Item;
  rules: Unlocked["rules"];
  materials: Map<string, MaterialRef>;
  record: Recorder;
}) {
  const Icon = KIND_ICON[item.kind];
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const type = ({ THEORY: "THEORY_OPENED", TEACHER_PRACTICE: "TEACHER_PRACTICE_OPENED", STUDENT_PRACTICE: "PRACTICE_OPENED", ASSESSMENT: "ASSESSMENT_OPENED" } as const)[
      item.kind as Exclude<SyllabusItemKind, "RESOURCE">
    ];
    if (type) record({ type, itemId: item.id });
  }, [item.id, item.kind, record]);
  const onVideo = (blockIndex: number, s: VideoSignal) => {
    const type = s.kind === "opened" ? "VIDEO_OPENED" : s.kind === "started" ? "VIDEO_STARTED" : s.kind === "completed" ? "VIDEO_COMPLETED" : "VIDEO_PROGRESS";
    record({ type, itemId: item.id, metadata: s.kind === "progress" ? { blockIndex, pct: s.pct } : { blockIndex } });
  };
  return (
    <article className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 font-semibold">
          <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="break-words">{item.title}</span>
        </h2>
        <ItemStateBadge item={item} />
      </div>
      <StudentItemView kind={item.kind} content={item.content} materials={materials} onVideo={item.kind === "THEORY" ? onVideo : undefined} />
      {item.kind === "THEORY" && <TheoryActions id={id} item={item} rule={rules.theory} />}
      {item.kind === "TEACHER_PRACTICE" && <TeacherPracticeNote item={item} rule={rules.teacherPractice} />}
      {item.kind === "STUDENT_PRACTICE" && <PracticePanel id={id} item={item} rules={rules} record={record} />}
      {item.kind === "ASSESSMENT" && <AssessmentPanel id={id} lessonId={lessonId} item={item} />}
    </article>
  );
}

function useInvalidateLearning(id: string) {
  const utils = trpc.useUtils();
  return () => {
    void utils.student.syllabus.lesson.invalidate();
    void utils.student.syllabus.path.invalidate({ id });
    void utils.student.syllabus.overview.invalidate({ id });
    void utils.student.syllabus.list.invalidate();
  };
}

function TheoryActions({ id, item, rule }: { id: string; item: Item; rule: string }) {
  const invalidate = useInvalidateLearning(id);
  const complete = trpc.student.syllabus.completeTheory.useMutation({
    onSuccess: () => {
      toast.success(t("learn.theory.marked"));
      invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (item.state === "MET") return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
      <Button size="sm" disabled={complete.isPending || !item.available} onClick={() => complete.mutate({ id, itemId: item.id })}>
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        {t("learn.theory.markRead")}
      </Button>
      <span className="text-xs text-muted-foreground">{t(`syllabus.rules.theory.${rule}` as MessageKey)}</span>
    </div>
  );
}

function TeacherPracticeNote({ item, rule }: { item: Item; rule: string }) {
  const text = item.state === "MET" ? null : rule === "TEACHER_MARKED" ? t("learn.tp.teacherMarks") : rule === "VIEWED" ? t("learn.tp.viewed") : null;
  if (!text) return null;
  return <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">{text}</p>;
}

function PracticeGrade({ grade }: { grade: NonNullable<NonNullable<NonNullable<ReturnType<typeof practiceOf>>["submission"]>["grade"]> }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-border p-2.5 text-sm">
      {grade.source === "AI" && (
        <div>
          <StatusBadge tone="info" icon={Sparkles}>{t("student.gradedByAi")}</StatusBadge>
        </div>
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
          {grade.ai.strengths.length > 0 && (
            <ul className="ml-4 list-disc">{grade.ai.strengths.map((s, i) => <li key={i} className="break-words">{s}</li>)}</ul>
          )}
          {grade.ai.improvements.length > 0 && (
            <ul className="ml-4 list-disc">{grade.ai.improvements.map((s, i) => <li key={i} className="break-words">{s}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}

function PracticePanel({ id, item, rules, record }: { id: string; item: Item; rules: Unlocked["rules"]; record: Recorder }) {
  const p = practiceOf(item);
  const invalidate = useInvalidateLearning(id);
  const [answer, setAnswer] = useState("");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [editing, setEditing] = useState(false);
  const submit = trpc.student.syllabus.submitPractice.useMutation({
    onSuccess: () => {
      toast.success(t("student.taskSubmitted"));
      setEditing(false);
      setAnswer("");
      setFiles([]);
      invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!p) return null;
  const sub = p.submission;
  const passPct = item.passPct ?? rules.practicePassPct;
  const started = () => record({ type: "PRACTICE_STARTED", itemId: item.id });
  const showForm = p.canSubmit && (!sub || editing);
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{t(`syllabus.rules.studentPractice.${rules.studentPractice}` as MessageKey)}</span>
        {rules.studentPractice === "PASSED" && <span>{t("learn.practice.passPct", { pct: passPct })}</span>}
        {p.dueAt && <span className={p.overdue ? "font-medium text-destructive" : ""}>{t(p.overdue ? "learn.practice.overdue" : "learn.practice.due", { at: fmtDateTime(p.dueAt) })}</span>}
      </div>
      {sub && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {sub.status === "LATE" ? <StatusBadge tone="warning">{t("student.late")}</StatusBadge> : <StatusBadge tone="success">{t("student.onTime")}</StatusBadge>}
            {sub.submittedAt && <span className="text-xs text-muted-foreground">{t("learn.practice.submittedAt", { at: fmtDateTime(sub.submittedAt) })}</span>}
          </div>
          {sub.files.length > 0 && <p className="text-xs text-muted-foreground">{t("student.submittedFiles", { names: sub.files.map((f) => f.name).join(", ") })}</p>}
          {!!sub.answerText && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 text-sm">{sub.answerText}</p>}
          {sub.grade ? (
            <PracticeGrade grade={sub.grade} />
          ) : sub.pending === "AI_CHECKING" ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 animate-pulse motion-reduce:animate-none" aria-hidden />
              {t("student.aiChecking")}
            </p>
          ) : sub.pending === "TEACHER_REVIEW" ? (
            <StatusBadge tone="warning">{t("student.teacherReviewPending")}</StatusBadge>
          ) : (
            <p className="text-xs text-muted-foreground">{t("student.awaitingReview")}</p>
          )}
          {item.state === "FAILED" && <p className="text-sm text-destructive">{t("learn.practice.belowPass", { pct: passPct })}</p>}
          {p.canSubmit && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {t("learn.practice.resubmit")}
            </Button>
          )}
        </div>
      )}
      {showForm && p.taskId && (
        <div className="space-y-2">
          <label className="block text-xs">
            <span className="text-foreground-secondary">{t("student.answerLabel")}</span>
            <Textarea
              rows={5}
              className="mt-1"
              maxLength={20000}
              placeholder={t("student.answerPlaceholder")}
              value={answer}
              onFocus={started}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </label>
          <MultiFileUpload
            context="submission"
            taskId={p.taskId}
            max={10}
            value={files}
            onChange={(v) => {
              started();
              setFiles(v);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={(!files.length && !answer.trim()) || submit.isPending}
              onClick={() => submit.mutate({ id, itemId: item.id, files: files.map((f) => ({ fileId: f.fileId })), answerText: answer })}
            >
              {t("common.send")}
            </Button>
            {editing && (
              <Button variant="outline" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AssessmentPanel({ id, lessonId, item }: { id: string; lessonId: string; item: Item }) {
  const a = assessmentOf(item);
  const [, navigate] = useLocation();
  const start = trpc.student.syllabus.startAssessment.useMutation({
    onSuccess: (r) => navigate(sessionPath(r.attemptId, lessonPath(id, lessonId))),
    onError: (e) => toast.error(errorText(e)),
  });
  if (!a) return null;
  const wait = minutesUntil(a.cooldownUntil);
  const passed = item.state === "MET";
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-3">
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-lg bg-muted/50 p-2">
          <dt className="text-xs text-muted-foreground">{t("learn.assessment.passMark")}</dt>
          <dd className="font-semibold">{a.passPct}%</dd>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <dt className="text-xs text-muted-foreground">{t("learn.assessment.attempts")}</dt>
          <dd className="font-semibold">{a.maxAttempts ? t("learn.assessment.usedOf", { used: a.used, max: a.maxAttempts }) : t("learn.assessment.usedUnlimited", { used: a.used })}</dd>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <dt className="text-xs text-muted-foreground">{t(`syllabus.rules.scorePolicy.${a.scorePolicy}` as MessageKey)}</dt>
          <dd className="font-semibold">{(a.scorePolicy === "LATEST" ? a.latestPct : a.bestPct) ?? "—"}{(a.scorePolicy === "LATEST" ? a.latestPct : a.bestPct) !== null ? "%" : ""}</dd>
        </div>
      </dl>
      {a.attempts.length > 0 && (
        <ul className="space-y-1 text-sm">
          {a.attempts.map((r) => (
            <li key={r.attemptNo} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-1.5">
              <span>{attemptLabel(r.attemptNo)}{r.finishedAt ? ` · ${fmtDateTime(r.finishedAt)}` : ""}</span>
              <span className="flex items-center gap-2">
                {r.pct !== null ? (
                  <span className={`font-medium tabular-nums ${r.pct >= a.passPct ? "text-success" : "text-foreground"}`}>{r.pct}%</span>
                ) : (
                  <span className="text-xs text-muted-foreground">{r.held ? t("learn.assessment.held") : t("learn.assessment.pending")}</span>
                )}
                {r.resultId && !r.held && (
                  <Link href={resultPath(r.resultId, lessonPath(id, lessonId))} className="text-xs text-link hover:underline">
                    {t("learn.assessment.viewResult")}
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {passed ? (
        <p className="inline-flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="h-4 w-4" aria-hidden />{t("learn.assessment.passed")}</p>
      ) : item.state === "FAILED" && !a.canStart && !a.left ? (
        <p className="text-sm text-destructive">{t("learn.assessment.noAttemptsLeft")}</p>
      ) : null}
      {!passed && (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!a.canStart || start.isPending} onClick={() => start.mutate({ id, itemId: item.id })}>
            {a.inProgressAttemptId ? t("learn.assessment.resume") : a.used ? t("learn.assessment.retry") : t("learn.assessment.start")}
          </Button>
          {wait > 0 && !a.inProgressAttemptId && <span className="text-xs text-muted-foreground">{t("learn.assessment.cooldown", { count: wait })}</span>}
          {a.maxAttempts !== null && a.left > 0 && a.used > 0 && <span className="text-xs text-muted-foreground">{t("learn.assessment.left", { count: a.left })}</span>}
        </div>
      )}
    </div>
  );
}

function LessonFooter({ id, data }: { id: string; data: Unlocked }) {
  const missing = data.items.filter((i) => i.required && (i.state === "UNMET" || i.state === "FAILED"));
  const next = data.nextLesson;
  return (
    <footer className="space-y-3 rounded-2xl border border-border bg-card p-4">
      {data.status !== "COMPLETED" && missing.length > 0 && (
        <div>
          <p className="text-sm font-medium">{t("learn.remaining")}</p>
          <ul className="mt-1 ml-5 list-disc text-sm text-foreground-secondary">
            {missing.map((i) => (
              <li key={i.id} className="break-words">{t(`syllabus.kind.${i.kind}` as MessageKey)} · {i.title}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href={syllabusPath(id)}>{t("learn.backToPath")}</Link>
        </Button>
        {next ? (
          next.unlocked ? (
            <Button asChild size="sm">
              <Link href={lessonPath(id, next.id)}>
                {t("learn.nextLesson")}
                <ChevronRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <Lock className="h-4 w-4" aria-hidden />
              {t("learn.nextLocked")}
            </span>
          )
        ) : null}
      </div>
    </footer>
  );
}
