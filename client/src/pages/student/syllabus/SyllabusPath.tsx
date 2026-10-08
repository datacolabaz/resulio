import { AppShell, ErrorNote, Loading, Panel, Pill } from "@/components/AppShell";
import { StatusBadge, toneSurface } from "@/components/StatusBadge";
import { ActivityTimeline } from "@/components/syllabus/ActivityTimeline";
import { ModuleDetailsBlocks } from "@/components/syllabus/ModuleDetailsBlocks";
import { StudentWorkflow } from "@/components/syllabus/Workflow";
import { Button } from "@/components/ui/button";
import { t, type MessageKey } from "@/i18n/messages";
import { errorText, fmtDateTime, fmtDay } from "@/lib/format";
import { nodeVisual, pct, type LockReason } from "@/lib/syllabusLearn";
import { lessonChange } from "@/lib/syllabusWorkflow";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ActivityEvent } from "@/lib/syllabusTracker";
import { Award, ChevronDown, ChevronLeft, ClipboardCheck, Clock, Hourglass, Lock, Sparkles, Trophy, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams } from "wouter";
import { lessonPath, lockText, NodeIcon, ProgressBar, sessionPath, statusText, syllabusPath } from "./common";
import { useActivity } from "./useActivity";

type Overview = RouterOutputs["student"]["syllabus"]["overview"];
type Path = NonNullable<Overview["path"]>;
type Ended = NonNullable<Overview["ended"]>;
type Module = Path["modules"][number];
type ScopedAssessment = Module["assessments"][number];
type Recorder = (e: ActivityEvent) => void;

function BackLink() {
  return (
    <Link href="/student/syllabus" className="inline-flex items-center gap-1 text-sm text-link hover:underline">
      <ChevronLeft className="h-4 w-4" aria-hidden />
      {t("nav.mySyllabi")}
    </Link>
  );
}

export function SyllabusPathPage() {
  const { id } = useParams<{ id: string }>();
  const q = trpc.student.syllabus.overview.useQuery({ id }, { retry: false });
  const active = q.data?.mode === "ACTIVE";
  const record = useActivity(active ? id : undefined);
  useEffect(() => {
    if (active) record({ type: "SYLLABUS_OPENED" });
  }, [active, record]);
  return (
    <AppShell area="learning">
      <div className="space-y-4">
        <BackLink />
        {q.error ? <ErrorNote error={q.error} /> : !q.data ? <Loading /> : q.data.path ? <ActivePath id={id} path={q.data.path} record={record} /> : q.data.ended ? <EndedPath ended={q.data.ended} /> : null}
      </div>
    </AppShell>
  );
}

function Header({ title, subject, level, description, extra }: { title: string; subject: string | null; level: string | null; description: string; extra?: React.ReactNode }) {
  return (
    <header className="space-y-2">
      <h1 className="break-words font-[family-name:var(--font-display)] text-2xl">{title}</h1>
      <div className="flex flex-wrap items-center gap-1.5">
        {subject && <Pill>{subject}</Pill>}
        {level && <Pill>{level}</Pill>}
        {extra}
      </div>
      {description && <p className="max-w-3xl whitespace-pre-wrap break-words text-sm text-foreground-secondary">{description}</p>}
    </header>
  );
}

function CompletionCard({ completion }: { completion: NonNullable<Path["completion"]> }) {
  return (
    <section className={`rounded-2xl border p-5 ${toneSurface("success")}`} aria-labelledby="syllabus-complete">
      <div className="flex items-start gap-3">
        <Trophy className="mt-0.5 h-6 w-6 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-2">
          <h2 id="syllabus-complete" className="text-lg font-semibold">{t("learn.completedTitle")}</h2>
          <p className="text-sm text-foreground">{t("learn.completedBody")}</p>
          <dl className="grid gap-x-6 gap-y-1 text-sm text-foreground sm:grid-cols-2">
            <div className="flex gap-1"><dt className="text-foreground-secondary">{t("learn.cert.date")}:</dt><dd>{fmtDay(completion.completedAt)}</dd></div>
            <div className="flex gap-1"><dt className="text-foreground-secondary">{t("learn.cert.overall")}:</dt><dd>{completion.overallPct}%</dd></div>
            {completion.finalAssessmentPct !== null && (
              <div className="flex gap-1"><dt className="text-foreground-secondary">{t("learn.cert.final")}:</dt><dd>{completion.finalAssessmentPct}%</dd></div>
            )}
            {completion.versionLabel && <div className="flex gap-1"><dt className="text-foreground-secondary">{t("learn.cert.version")}:</dt><dd>{completion.versionLabel}</dd></div>}
            {completion.verificationCode && (
              <div className="flex gap-1 sm:col-span-2"><dt className="text-foreground-secondary">{t("learn.cert.code")}:</dt><dd className="break-all font-mono">{completion.verificationCode}</dd></div>
            )}
          </dl>
          <p className="text-xs text-foreground-secondary">{t("learn.cert.note")}</p>
        </div>
      </div>
    </section>
  );
}

function ActivePath({ id, path, record }: { id: string; path: Path; record: Recorder }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(path.currentModuleId ? [path.currentModuleId] : path.modules[0] ? [path.modules[0].id] : []));
  const scores = new Map(path.summary.assessments.map((a) => [a.itemId, a]));
  useEffect(() => {
    for (const m of path.modules) if (open.has(m.id) && m.status !== "LOCKED") record({ type: "MODULE_OPENED", moduleId: m.id });
  }, [open, path.modules, record]);
  const toggle = (moduleId: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  const currentLesson = path.currentLessonId;
  return (
    <div className="space-y-4">
      <Header
        title={path.syllabus.title}
        subject={path.syllabus.subject}
        level={path.syllabus.level}
        description={path.syllabus.description}
        extra={
          <>
            {path.version.label && <Pill>{t("learn.version", { label: path.version.label })}</Pill>}
            {path.access.endsAt && <Pill>{t("learn.accessUntil", { at: fmtDateTime(path.access.endsAt) })}</Pill>}
          </>
        }
      />
      {path.completion ? (
        <CompletionCard completion={path.completion} />
      ) : path.awaitingApproval ? (
        <div className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${toneSurface("warning")}`}>
          <Hourglass className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t("learn.awaitingSyllabusApproval")}
        </div>
      ) : currentLesson ? (
        <Button asChild className="w-full sm:w-auto">
          <Link href={lessonPath(id, currentLesson)}>{path.completedLessons ? t("learn.continue") : t("learn.start")}</Link>
        </Button>
      ) : null}
      {Object.keys(path.lessonChanges).length > 0 && (
        <div className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${toneSurface("info")}`} role="note">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t("ux.change.note")}
        </div>
      )}
      {!path.completion && <StudentWorkflow />}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          {path.modules.map((m, i) => (
            <ModuleCard key={m.id} id={id} module={m} index={i} path={path} expanded={open.has(m.id)} onToggle={() => toggle(m.id)} scores={scores} record={record} />
          ))}
          {path.finalAssessments.length > 0 && (
            <Panel title={t("learn.finalAssessments")}>
              <ul className="space-y-2">
                {path.finalAssessments.map((a) => (
                  <AssessmentRow key={a.id} id={id} item={a} score={scores.get(a.id)} lockedText={t("learn.lock.all")} record={record} />
                ))}
              </ul>
            </Panel>
          )}
        </div>
        <aside className="min-w-0 space-y-4">
          <ProgressPanel path={path} />
          <GroupPanel id={id} groups={path.groups} />
          <MyActivityPanel id={id} />
        </aside>
      </div>
    </div>
  );
}

/** The student's own learning history (§41: only self); loaded on demand. */
function MyActivityPanel({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const q = trpc.student.syllabus.activity.useQuery({ id }, { enabled: open, retry: false });
  return (
    <Panel
      title={t("sa.timeline.mine")}
      action={
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t("sa.timeline.hide") : t("sa.timeline.show")}
        </Button>
      }
    >
      {open && (q.error ? <ErrorNote error={q.error} /> : !q.data ? <Loading /> : <ActivityTimeline events={q.data.slice(0, 50)} />)}
    </Panel>
  );
}

function ModuleCard({
  id,
  module: m,
  index,
  path,
  expanded,
  onToggle,
  scores,
  record,
}: {
  id: string;
  module: Module;
  index: number;
  path: Path;
  expanded: boolean;
  onToggle: () => void;
  scores: Map<string, Path["summary"]["assessments"][number]>;
  record: Recorder;
}) {
  const visual = nodeVisual(m.status, m.id === path.currentModuleId);
  const locked = m.status === "LOCKED";
  const reason = lockText(m.lockReason as LockReason | null, path);
  const panelId = `module-${m.id}`;
  return (
    <section className={`min-w-0 rounded-2xl border bg-card ${visual === "current" ? "border-primary/50" : "border-border"}`}>
      <button type="button" className="flex w-full items-start gap-3 p-4 text-left" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}>
        <NodeIcon visual={visual} className="mt-0.5 h-6 w-6" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("learn.moduleN", { n: index + 1 })}</div>
          <h2 className="break-words font-semibold">{m.title}</h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{statusText(m.status)}</span>
            <span>{t("learn.lessonsDone", { done: m.completedLessons, total: m.totalLessons })}</span>
            {m.lessons.some((l) => lessonChange(path.lessonChanges, l.id)) && <StatusBadge tone="info" icon={Sparkles}>{t("ux.change.UPDATED")}</StatusBadge>}
            {m.estimatedMinutes ? <span>{t("learn.minutes", { count: m.estimatedMinutes })}</span> : null}
          </div>
          {!locked && <ProgressBar value={pct(m.completedLessons, m.totalLessons)} label={t("learn.moduleProgress", { title: m.title })} />}
          {reason && <p className="text-sm text-foreground-secondary">{reason}</p>}
        </div>
        <ChevronDown className={`mt-1 h-5 w-5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {expanded && (
        <div id={panelId} className="space-y-3 border-t border-border p-4">
          {m.description && <p className="whitespace-pre-wrap break-words text-sm text-foreground-secondary">{m.description}</p>}
          <ol className="space-y-1.5">
            {m.lessons.map((l, li) => (
              <LessonRow key={l.id} id={id} lesson={l} n={li + 1} isCurrent={l.id === path.currentLessonId} path={path} />
            ))}
          </ol>
          {m.assessments.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t("learn.moduleAssessments")}</h3>
              <ul className="space-y-2">
                {m.assessments.map((a) => (
                  <AssessmentRow key={a.id} id={id} item={a} score={scores.get(a.id)} lockedText={t("learn.lock.moduleLessons")} record={record} />
                ))}
              </ul>
            </div>
          )}
          <ModuleDetailsBlocks details={m.details} className="border-t border-border pt-3" />
        </div>
      )}
    </section>
  );
}

function LessonRow({ id, lesson: l, n, isCurrent, path }: { id: string; lesson: Module["lessons"][number]; n: number; isCurrent: boolean; path: Path }) {
  const visual = nodeVisual(l.status, isCurrent);
  const reason = lockText(l.lockReason as LockReason | null, path);
  const change = lessonChange(path.lessonChanges, l.id);
  const body = (
    <>
      <NodeIcon visual={visual} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs text-muted-foreground">{t("learn.lessonN", { n })}</span>
          <span className={`break-words ${visual === "locked" ? "text-foreground-secondary" : "font-medium"}`}>{l.title}</span>
          {l.optional && <Pill>{t("learn.optional")}</Pill>}
          {change && <StatusBadge tone="info" icon={Sparkles}>{t(`ux.change.${change}`)}</StatusBadge>}
        </div>
        <div className="text-xs text-muted-foreground">
          {reason ?? statusText(l.status)}
          {l.estimatedMinutes ? ` · ${t("learn.minutes", { count: l.estimatedMinutes })}` : ""}
        </div>
      </div>
    </>
  );
  const base = "flex items-start gap-3 rounded-xl border px-3 py-2.5";
  return (
    <li>
      {l.status === "LOCKED" ? (
        <div className={`${base} border-dashed border-border`} aria-disabled="true">{body}</div>
      ) : (
        <Link href={lessonPath(id, l.id)} className={`${base} ${isCurrent ? "border-primary/50 bg-primary/5" : "border-border"} hover:bg-muted`} aria-current={isCurrent ? "step" : undefined}>
          {body}
        </Link>
      )}
    </li>
  );
}

function AssessmentRow({
  id,
  item,
  score,
  lockedText,
  record,
}: {
  id: string;
  item: ScopedAssessment;
  score: Path["summary"]["assessments"][number] | undefined;
  lockedText: string;
  record: Recorder;
}) {
  const [, navigate] = useLocation();
  const start = trpc.student.syllabus.startAssessment.useMutation({
    onSuccess: (r) => navigate(sessionPath(r.attemptId, syllabusPath(id))),
    onError: (e) => toast.error(errorText(e)),
  });
  const done = item.state === "MET";
  const visual = done ? "done" : item.available ? "current" : "locked";
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-3 py-2.5">
      <ClipboardCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <NodeIcon visual={visual} />
      <div className="min-w-0 flex-1">
        <div className="break-words font-medium">{item.title}</div>
        <div className="text-xs text-muted-foreground">
          {!item.available && !done ? lockedText : <ScoreLine score={score} />}
          {!item.required && ` · ${t("learn.optional")}`}
        </div>
      </div>
      {item.available && !done && (
        <Button
          size="sm"
          disabled={start.isPending}
          onClick={() => {
            record({ type: "ASSESSMENT_OPENED", itemId: item.id });
            start.mutate({ id, itemId: item.id });
          }}
        >
          {score?.attempts ? t("learn.assessment.retry") : t("learn.assessment.start")}
        </Button>
      )}
    </li>
  );
}

function ScoreLine({ score }: { score: Path["summary"]["assessments"][number] | undefined }) {
  if (!score || !score.attempts) return <>{t("learn.assessment.noAttempts")}</>;
  if (score.bestPct !== null) return <>{t("learn.assessment.best", { pct: score.bestPct, count: score.attempts })}</>;
  return <>{score.held ? t("learn.assessment.held") : t("learn.assessment.pending")}</>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-foreground-secondary">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function ProgressPanel({ path }: { path: Path }) {
  const lessons = path.modules.flatMap((m) => m.lessons);
  const locked = lessons.filter((l) => l.status === "LOCKED").length;
  const open = lessons.length - locked - path.completedLessons;
  const s = path.summary;
  return (
    <Panel title={t("learn.progressTitle")}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-foreground-secondary">{t("learn.overallProgress")}</span>
            <span className="font-[family-name:var(--font-display)] text-3xl">{path.progressPct}%</span>
          </div>
          <ProgressBar value={path.progressPct} label={t("learn.overallProgress")} />
        </div>
        <div className="space-y-1.5">
          <Stat label={t("learn.stat.completedLessons")} value={`${path.completedLessons} / ${path.totalLessons}`} />
          <Stat label={t("learn.stat.openLessons")} value={String(Math.max(0, open))} />
          <Stat label={t("learn.stat.lockedLessons")} value={String(locked)} />
          {s.theory.total > 0 && <Stat label={t("learn.stat.theory")} value={`${s.theory.completed} / ${s.theory.total}`} />}
          {s.practice.total > 0 && <Stat label={t("learn.stat.practice")} value={`${s.practice.completed} / ${s.practice.total}`} />}
          {s.practice.pending > 0 && <Stat label={t("learn.stat.practicePending")} value={String(s.practice.pending)} />}
        </div>
        {s.assessments.length > 0 && (
          <div className="space-y-1.5">
            <h3 className="text-sm font-medium">{t("learn.stat.assessments")}</h3>
            <ul className="space-y-1">
              {s.assessments.map((a) => (
                <li key={a.itemId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {a.state === "MET" ? <Award className="h-4 w-4 shrink-0 text-success" aria-hidden /> : <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                    <span className="truncate">{a.title}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-foreground-secondary">{a.bestPct !== null ? `${a.bestPct}%` : a.held ? t("learn.assessment.heldShort") : "—"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("learn.stat.modules")}</h3>
          {path.modules.map((m, i) => (
            <div key={m.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-foreground-secondary">{t("learn.moduleN", { n: i + 1 })} · {m.title}</span>
                <span className="shrink-0 tabular-nums">{m.status === "LOCKED" ? <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label={statusText("LOCKED")} /> : `${pct(m.completedLessons, m.totalLessons)}%`}</span>
              </div>
              {m.status !== "LOCKED" && <ProgressBar value={pct(m.completedLessons, m.totalLessons)} label={t("learn.moduleProgress", { title: m.title })} className="h-1.5" />}
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function GroupPanel({ id, groups }: { id: string; groups: Path["groups"] }) {
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const q = trpc.student.syllabus.groupProgress.useQuery({ id, groupId }, { enabled: !!groupId, retry: false });
  if (!groups.length) return null;
  const hidden = q.error?.message === "SYLLABUS_PROGRESS_HIDDEN";
  return (
    <Panel title={t("learn.group.title")}>
      <div className="space-y-3">
        {groups.length > 1 && (
          <select className="w-full rounded-lg border border-input bg-card px-3 py-2 text-sm" aria-label={t("learn.group.pick")} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        )}
        {hidden ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground"><Users className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t("learn.group.hidden")}</p>
        ) : q.error ? (
          <ErrorNote error={q.error} />
        ) : !q.data ? (
          <Loading />
        ) : (
          <ul className="space-y-2">
            {q.data.members.map((m) => (
              <li key={m.studentId} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className={`truncate ${m.isMe ? "font-semibold" : ""}`}>{m.isMe ? t("learn.group.me", { name: m.name }) : m.name}</span>
                  <span className="shrink-0 tabular-nums text-foreground-secondary">
                    {m.completed ? <Trophy className="h-4 w-4 text-success" aria-label={t("learn.completed")} /> : m.started ? `${m.progressPct}%` : t("learn.group.notStarted")}
                  </span>
                </div>
                {m.started && <ProgressBar value={m.progressPct} label={m.name} className="h-1.5" />}
                {m.currentModuleTitle && !m.completed && <p className="truncate text-xs text-muted-foreground">{m.currentModuleTitle}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function EndedPath({ ended }: { ended: Ended }) {
  const access = ended.access;
  return (
    <div className="space-y-4">
      <Header title={ended.syllabus.title} subject={ended.syllabus.subject} level={ended.syllabus.level} description={ended.syllabus.description} />
      <div className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${toneSurface(access === "PENDING" ? "info" : "warning")}`} role="status">
        <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          {access === "PENDING"
            ? ended.startsAt
              ? t("learn.ended.pendingAt", { at: fmtDateTime(ended.startsAt) })
              : t("learn.ended.pending")
            : t(`learn.ended.${access ?? "NONE"}` as MessageKey)}
        </span>
      </div>
      {ended.completion && <CompletionCard completion={ended.completion} />}
      {ended.progress && (
        <Panel title={t("learn.progressTitle")}>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-foreground-secondary">{t("learn.lessonsDone", { done: ended.progress.completedLessons, total: ended.progress.totalLessons })}</span>
              <span className="font-[family-name:var(--font-display)] text-2xl">{ended.progress.progressPct}%</span>
            </div>
            <ProgressBar value={ended.progress.progressPct} label={t("learn.overallProgress")} />
          </div>
        </Panel>
      )}
      {ended.modules.length > 0 && (
        <div className="space-y-3">
          {ended.modules.map((m, i) => (
            <section key={m.id} className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <NodeIcon visual={nodeVisual(m.status, false)} className="mt-0.5 h-6 w-6" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("learn.moduleN", { n: i + 1 })}</div>
                  <h2 className="break-words font-semibold">{m.title}</h2>
                  <p className="text-xs text-muted-foreground">{t("learn.lessonsDone", { done: m.completedLessons, total: m.totalLessons })}</p>
                  <ol className="mt-2 space-y-1">
                    {m.lessons.map((l, li) => (
                      <li key={l.id} className="flex items-center gap-2 text-sm">
                        <NodeIcon visual={nodeVisual(l.status, false)} className="h-4 w-4" />
                        <span className="text-xs text-muted-foreground">{t("learn.lessonN", { n: li + 1 })}</span>
                        <span className="min-w-0 truncate">{l.title}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
      {!ended.progress && access !== "PENDING" && <StatusBadge tone="neutral">{t("learn.ended.noProgress")}</StatusBadge>}
    </div>
  );
}
