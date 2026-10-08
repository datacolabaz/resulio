import { ErrorNote, Loading, Panel, Pill } from "@/components/AppShell";
import { ModuleDetailsBlocks } from "@/components/syllabus/ModuleDetailsBlocks";
import { DurationFields, durationText, parseCount } from "@/components/syllabus/Timing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isMessageKey, t } from "@/i18n/messages";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { reviewEdit, reviewProblems, reviewStats, reviewTimingCheck, type Review } from "@/lib/syllabusImportReview";
import type { ImportModule } from "@shared/syllabusImport";
import { hasModuleDetails } from "@shared/syllabusModuleDetails";
import { MAX_LESSONS_PER_WEEK } from "@shared/syllabusTiming";
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams } from "wouter";
import { fieldLabel, SyllabusShell, toastError } from "./shared";

type Job = RouterOutputs["teacher"]["syllabus"]["aiImport"]["get"];

const running = (status: string) => status === "QUEUED" || status === "PROCESSING";
const failureText = (code: string | null) => {
  const key = `simport.failed.${code ?? ""}`;
  return isMessageKey(key) ? t(key) : t("simport.failed.INTERNAL");
};

function Progress({ job }: { job: Job }) {
  const total = Math.max(1, job.chunkCount);
  const pct = Math.round((Math.min(job.chunksDone, total) / total) * 100);
  const label = t("simport.progress", { done: job.chunksDone, total });
  return (
    <div className="space-y-1">
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
        <div className="h-full bg-link transition-all motion-reduce:transition-none" style={{ width: `${Math.max(pct, 4)}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function IconButton({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <Button type="button" size="icon" variant="ghost" className={`h-8 w-8 ${danger ? "text-destructive" : ""}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

function MoveButtons({ index, count, title, onMove, onRemove }: { index: number; count: number; title: string; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  return (
    <span className="flex shrink-0">
      <IconButton label={t("simport.moveUp", { title })} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp className="h-4 w-4" aria-hidden /></IconButton>
      <IconButton label={t("simport.moveDown", { title })} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown className="h-4 w-4" aria-hidden /></IconButton>
      <IconButton label={t("simport.remove", { title })} danger onClick={onRemove}><Trash2 className="h-4 w-4" aria-hidden /></IconButton>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function CourseFields({ s, set }: { s: Review; set: (s: Review) => void }) {
  const [perWeek, setPerWeek] = useState(s.timing.lessonsPerWeek ? String(s.timing.lessonsPerWeek) : "");
  const [minutes, setMinutes] = useState(s.timing.lessonMinutes ? String(s.timing.lessonMinutes) : "");
  const check = reviewTimingCheck(s);
  return (
    <Panel title={t("simport.course")}>
      <div className="space-y-3">
        <label className="block text-sm">
          <span className={fieldLabel}>{t("syllabus.field.title")}</span>
          <Input value={s.title} maxLength={255} onChange={(e) => set(reviewEdit.syllabus(s, { title: e.target.value }))} aria-invalid={!s.title.trim()} />
        </label>
        <label className="block text-sm">
          <span className={fieldLabel}>{t("simport.description")}</span>
          <Textarea rows={3} value={s.description} onChange={(e) => set(reviewEdit.syllabus(s, { description: e.target.value }))} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className={fieldLabel}>{t("syllabus.field.subject")}</span>
            <Input value={s.subject} maxLength={128} onChange={(e) => set(reviewEdit.syllabus(s, { subject: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className={fieldLabel}>{t("syllabus.field.level")}</span>
            <Input value={s.level} maxLength={64} onChange={(e) => set(reviewEdit.syllabus(s, { level: e.target.value }))} />
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="text-sm">
            <span className={`mb-1 block ${fieldLabel}`}>{t("timing.courseTotal")}</span>
            <DurationFields idPrefix="import-course" label={t("timing.courseTotal")} value={s.timing.duration} onChange={(duration) => set(reviewEdit.timing(s, { duration }))} />
          </div>
          <label className="text-sm">
            <span className={`mb-1 block ${fieldLabel}`}>{t("timing.lessonsPerWeek")}</span>
            <Input
              type="number"
              min={1}
              max={MAX_LESSONS_PER_WEEK}
              className="h-9 w-24"
              value={perWeek}
              onChange={(e) => {
                setPerWeek(e.target.value);
                const n = parseCount(e.target.value, MAX_LESSONS_PER_WEEK);
                if (n !== undefined) set(reviewEdit.timing(s, { lessonsPerWeek: n }));
              }}
            />
          </label>
          <label className="text-sm">
            <span className={`mb-1 block ${fieldLabel}`}>{t("simport.lessonMinutes")}</span>
            <Input
              type="number"
              min={1}
              max={10_000}
              className="h-9 w-24"
              value={minutes}
              onChange={(e) => {
                setMinutes(e.target.value);
                const n = parseCount(e.target.value, 10_000);
                if (n !== undefined) set(reviewEdit.timing(s, { lessonMinutes: n }));
              }}
            />
          </label>
        </div>
        <p className="text-sm text-foreground-secondary">
          {check.sum ? t("timing.modulesSum", { sum: durationText(check.sum) }) : t("timing.modulesSumNone")}
          {check.missing > 0 && check.sum ? ` · ${t("timing.modulesMissing", { count: check.missing })}` : ""}
        </p>
        {check.mismatch && check.sum && s.timing.duration && (
          <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning" role="note">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t("timing.mismatch", { sum: durationText(check.sum), total: durationText(s.timing.duration) })}
          </p>
        )}
      </div>
    </Panel>
  );
}

function LessonMinutesField({ value, title, onChange }: { value: number | null; title: string; onChange: (n: number | null) => void }) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => {
    if (parseCount(text, 10_000) !== value) setText(value ? String(value) : "");
    // Rows are keyed by position: follow the value when a reorder puts another lesson here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <Input
        type="number"
        min={1}
        max={10_000}
        className="h-8 w-16 px-2 text-xs"
        value={text}
        placeholder="—"
        aria-label={t("timing.lessonMinutesOf", { title })}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseCount(e.target.value, 10_000);
          if (n !== undefined) onChange(n);
        }}
      />
      {t("timing.min")}
    </label>
  );
}

function ModuleReview({ s, set, index, open, onToggle }: { s: Review; set: (s: Review) => void; index: number; open: boolean; onToggle: () => void }) {
  const m: ImportModule = s.modules[index];
  const label = m.title || t("simport.untitled");
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 p-3">
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" aria-expanded={open} aria-label={t(open ? "simport.collapse" : "simport.expand", { title: label })} onClick={onToggle}>
          <Chevron className="h-4 w-4" aria-hidden />
        </button>
        <span className="text-sm font-semibold text-muted-foreground">{index + 1}.</span>
        <Input
          className="min-w-[12rem] flex-1 font-semibold"
          value={m.title}
          maxLength={255}
          aria-label={t("simport.moduleTitle", { n: index + 1 })}
          aria-invalid={!m.title.trim()}
          onChange={(e) => set(reviewEdit.renameModule(s, index, e.target.value))}
        />
        <DurationFields idPrefix={`import-module-${index}`} label={t("timing.moduleDurationOf", { title: label })} value={m.duration} onChange={(d) => set(reviewEdit.moduleDuration(s, index, d))} />
        <MoveButtons index={index} count={s.modules.length} title={label} onMove={(d) => set(reviewEdit.moveModule(s, index, d))} onRemove={() => set(reviewEdit.removeModule(s, index))} />
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 pb-3 text-xs">
        <Pill>{t("syllabus.count.lessons", { count: m.lessons.length })}</Pill>
        {m.projects.length > 0 && <Pill>{t("simport.projectsCount", { count: m.projects.length })}</Pill>}
        <Pill>{hasModuleDetails(m.details) ? t("simport.blocksFound") : t("simport.blocksMissing")}</Pill>
      </div>
      {open && (
        <div className="space-y-4 border-t border-border p-3">
          {m.description && <p className="whitespace-pre-line text-sm text-foreground-secondary">{m.description}</p>}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t("simport.lessons")}</h3>
            {m.lessons.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("simport.noLessons")}</p>
            ) : (
              <ol className="space-y-1.5">
                {m.lessons.map((l, li) => (
                  <li key={li} className="flex flex-wrap items-center gap-2">
                    <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">{li + 1}.</span>
                    <Input
                      className="h-8 min-w-[10rem] flex-1 text-sm"
                      value={l.title}
                      maxLength={255}
                      aria-label={t("simport.lessonTitle", { n: li + 1, module: label })}
                      aria-invalid={!l.title.trim()}
                      onChange={(e) => set(reviewEdit.renameLesson(s, index, li, e.target.value))}
                    />
                    {l.points.length > 0 && <span className="text-xs text-muted-foreground">{t("simport.points", { count: l.points.length })}</span>}
                    <LessonMinutesField value={l.minutes} title={l.title} onChange={(n) => set(reviewEdit.lessonMinutes(s, index, li, n))} />
                    <MoveButtons index={li} count={m.lessons.length} title={l.title} onMove={(d) => set(reviewEdit.moveLesson(s, index, li, d))} onRemove={() => set(reviewEdit.removeLesson(s, index, li))} />
                  </li>
                ))}
              </ol>
            )}
          </section>
          {m.projects.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{m.projectsHeading}</h3>
              <ul className="space-y-2">
                {m.projects.map((p, pi) => (
                  <li key={pi} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Input
                        className="h-8 flex-1 text-sm"
                        value={p.title}
                        maxLength={255}
                        aria-label={t("simport.projectTitle", { n: pi + 1, module: label })}
                        aria-invalid={!p.title.trim()}
                        onChange={(e) => set(reviewEdit.renameProject(s, index, pi, e.target.value))}
                      />
                      <IconButton label={t("simport.remove", { title: p.title })} danger onClick={() => set(reviewEdit.removeProject(s, index, pi))}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </IconButton>
                    </div>
                    {p.description && <p className="whitespace-pre-line pl-1 text-xs text-muted-foreground">{p.description}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="space-y-2">
            {hasModuleDetails(m.details) ? (
              <ModuleDetailsBlocks details={m.details} as="h4" />
            ) : (
              <p className="rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">{t("simport.noBlocks")}</p>
            )}
          </section>
        </div>
      )}
    </li>
  );
}

function ReviewEditor({ job, initial }: { job: Job; initial: Review }) {
  const [, nav] = useLocation();
  const [s, set] = useState<Review>(initial);
  const [open, setOpen] = useState<Set<number>>(() => new Set([0]));
  const create = trpc.teacher.syllabus.aiImport.create.useMutation({
    onSuccess: ({ id }) => {
      toast.success(t("simport.created"));
      nav(`/teacher/syllabus/${id}`);
    },
    onError: toastError,
  });
  const stats = reviewStats(s);
  const problems = reviewProblems(s);
  const toggle = (i: number) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  });
  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded-xl border border-border bg-muted p-3 text-sm">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-link" aria-hidden />
        {t("simport.reviewIntro")}
      </p>
      {!!job.detail?.localModules?.length && (
        <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning" role="note">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t("simport.localModules", { count: job.detail.localModules.length, titles: job.detail.localModules.join("; ") })}
        </p>
      )}
      <CourseFields s={s} set={set} />
      <Panel title={t("simport.modules")}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-foreground-secondary">{t("simport.stats", { modules: stats.modules, lessons: stats.lessons, projects: stats.projects, blocks: stats.withBlocks })}</p>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpen(new Set(s.modules.map((_, i) => i)))}>{t("simport.expandAll")}</Button>
            <Button size="sm" variant="outline" onClick={() => setOpen(new Set())}>{t("simport.collapseAll")}</Button>
          </span>
        </div>
        <ol className="space-y-3">
          {s.modules.map((m, i) => (
            <ModuleReview key={i} s={s} set={set} index={i} open={open.has(i)} onToggle={() => toggle(i)} />
          ))}
        </ol>
      </Panel>
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm">
        {problems.length > 0 && (
          <p className="mr-auto text-sm text-destructive" role="alert">{problems.map((p) => t(`simport.problem.${p}`)).join(" ")}</p>
        )}
        <Button variant="ghost" onClick={() => nav("/teacher/syllabus")}>{t("common.cancel")}</Button>
        <Button disabled={problems.length > 0 || create.isPending} onClick={() => create.mutate({ id: job.id, structure: s })}>
          {create.isPending ? t("simport.creating") : t("simport.create")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function JobState({ job }: { job: Job }) {
  const [, nav] = useLocation();
  const utils = trpc.useUtils();
  const refresh = () => void utils.teacher.syllabus.aiImport.get.invalidate({ id: job.id });
  const retry = trpc.teacher.syllabus.aiImport.retry.useMutation({ onSuccess: refresh, onError: toastError });
  const remove = trpc.teacher.syllabus.aiImport.remove.useMutation({
    onSuccess: () => {
      void utils.teacher.syllabus.aiImport.open.invalidate();
      nav("/teacher/syllabus");
    },
    onError: toastError,
  });
  const source = job.fileName ?? t("simport.pastedText");

  if (job.status === "READY" && job.result) return <ReviewEditor job={job} initial={job.result} />;
  if (job.status === "COMPLETED" && job.syllabusId) {
    return (
      <Panel title={source}>
        <p className="mb-3 text-sm">{t("simport.alreadyCreated")}</p>
        <Link href={`/teacher/syllabus/${job.syllabusId}`} className="text-sm font-medium text-link hover:underline">{t("simport.openSyllabus")}</Link>
      </Panel>
    );
  }
  return (
    <Panel title={source}>
      {running(job.status) ? (
        <div className="space-y-3">
          <p className="text-sm">{t("simport.working")}</p>
          <Progress job={job} />
          <p className="text-xs text-muted-foreground">{t("simport.workingHint")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-destructive" role="alert">{failureText(job.errorCode)}</p>
          {job.detail?.message && (
            <details className="rounded-xl border border-border bg-muted p-3 text-xs">
              <summary className="cursor-pointer font-medium text-foreground-secondary">{t("simport.technicalDetails")}</summary>
              <p className="mt-2 text-muted-foreground">{t("simport.technicalHint")}</p>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-foreground-secondary">{job.detail.message}</pre>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={retry.isPending} onClick={() => retry.mutate({ id: job.id })}>
              <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
              {t("simport.retry")}
            </Button>
            <Button variant="ghost" className="text-destructive" disabled={remove.isPending} onClick={() => confirm(t("simport.removeConfirm")) && remove.mutate({ id: job.id })}>
              <Trash2 className="mr-1 h-4 w-4" aria-hidden />
              {t("common.delete")}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function SyllabusImportPage() {
  const params = useParams<{ jobId: string }>();
  const job = trpc.teacher.syllabus.aiImport.get.useQuery(
    { id: params.jobId },
    { retry: false, refetchInterval: (q) => (q.state.data && running(q.state.data.status) ? 2500 : false) },
  );
  return (
    <SyllabusShell title={t("simport.title")}>
      <div className="mx-auto max-w-4xl space-y-4">
        <Link href="/teacher/syllabus" className="inline-flex items-center gap-1 text-sm text-link hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t("nav.syllabus")}
        </Link>
        {job.isLoading ? <Loading /> : job.error ? <ErrorNote error={job.error} /> : job.data ? <JobState job={job.data} /> : null}
      </div>
    </SyllabusShell>
  );
}

export { ReviewEditor as SyllabusImportReview };
