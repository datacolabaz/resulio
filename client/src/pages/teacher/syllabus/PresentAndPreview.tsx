import { EmptyState, ErrorNote, Loading, Pill } from "@/components/AppShell";
import { ModuleDetailsBlocks } from "@/components/syllabus/ModuleDetailsBlocks";
import { CourseTimingPills, durationText } from "@/components/syllabus/Timing";
import { Hints, StudentItemView } from "@/components/syllabus/StudentItemView";
import { Markdown } from "@/components/syllabus/TheoryView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { difficultyLabel } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { fileDownloadUrl } from "@/lib/uploadFile";
import { teacherPracticeContentSchema } from "@shared/syllabus";
import { ArrowLeft, CheckCircle2, Circle, ClipboardCheck, Download, EyeOff, Maximize2, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "wouter";
import { KIND_ICON, kindLabel, problemText, SyllabusShell, useMaterials } from "./shared";

// ---------------------------------------------------------------------------
// Present mode: a teacher practice shown in class, solution hidden until revealed
// ---------------------------------------------------------------------------

function PresentBody({ id, itemId }: { id: string; itemId: string }) {
  const tree = trpc.teacher.syllabus.get.useQuery({ id });
  const [revealed, setRevealed] = useState(false);
  const [notes, setNotes] = useState(false);
  const [scale, setScale] = useState(1);
  if (tree.isLoading) return <Loading />;
  if (tree.error || !tree.data) return <ErrorNote error={tree.error} />;
  const lessons = tree.data.modules.flatMap((m) => m.lessons.map((l) => ({ module: m, lesson: l })));
  const found = lessons.flatMap(({ lesson }) => lesson.items.map((it) => ({ lesson, it }))).find((x) => x.it.id === itemId);
  if (!found || found.it.kind !== "TEACHER_PRACTICE") return <ErrorNote error={new Error("NOT_FOUND")} />;
  const parsed = teacherPracticeContentSchema.safeParse(found.it.content);
  const c = parsed.success ? parsed.data : teacherPracticeContentSchema.parse({});
  const fullscreen = () => void document.documentElement.requestFullscreen?.().catch(() => undefined);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/teacher/syllabus/${id}/lessons/${found.lesson.id}`} className="inline-flex items-center gap-1 text-sm text-link hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {found.lesson.title}
        </Link>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" onClick={() => setScale((s) => Math.max(0.8, s - 0.1))} aria-label={t("syllabus.present.smaller")}><Minus className="h-4 w-4" aria-hidden /></Button>
          <Button size="icon" variant="outline" onClick={() => setScale((s) => Math.min(1.8, s + 0.1))} aria-label={t("syllabus.present.larger")}><Plus className="h-4 w-4" aria-hidden /></Button>
          <Button variant="outline" onClick={fullscreen}><Maximize2 className="mr-1 h-4 w-4" aria-hidden />{t("syllabus.present.fullscreen")}</Button>
        </div>
      </div>
      <article className="mx-auto max-w-4xl space-y-5 rounded-2xl border border-border bg-card p-6 md:p-10" style={{ fontSize: `${scale}rem` }}>
        <header className="space-y-2">
          <Pill>{difficultyLabel(c.difficulty)}</Pill>
          <h2 className="text-[1.75em] font-semibold leading-tight">{found.it.title}</h2>
        </header>
        {c.problem && <div className="[&_*]:text-[1em]"><Markdown md={c.problem} /></div>}
        {(c.exampleInput || c.exampleOutput) && (
          <div className="grid gap-3 md:grid-cols-2">
            {c.exampleInput && (
              <div>
                <p className="mb-1 text-[0.8em] font-medium text-foreground-secondary">{t("syllabus.tp.exampleInput")}</p>
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-[0.9em]">{c.exampleInput}</pre>
              </div>
            )}
            {c.exampleOutput && (
              <div>
                <p className="mb-1 text-[0.8em] font-medium text-foreground-secondary">{t("syllabus.tp.exampleOutput")}</p>
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-[0.9em]">{c.exampleOutput}</pre>
              </div>
            )}
          </div>
        )}
        {c.expectedOutcome && <p><span className="font-medium">{t("syllabus.tp.expectedOutcome")}: </span>{c.expectedOutcome}</p>}
        <Hints hints={c.hints} />
        {c.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {c.attachments.map((a) => (
              <a key={a.fileId} href={fileDownloadUrl(a.fileId)} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-[0.9em] hover:bg-muted">
                <Download className="h-4 w-4" aria-hidden />
                {a.name}
              </a>
            ))}
          </div>
        )}
        <section className="space-y-2 border-t border-border pt-4">
          {c.teacherOnly.solution ? (
            revealed ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold">{t("syllabus.tp.solution")}</h3>
                  <Button size="sm" variant="ghost" onClick={() => setRevealed(false)}><EyeOff className="mr-1 h-4 w-4" aria-hidden />{t("syllabus.present.hide")}</Button>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-[0.9em]">{c.teacherOnly.solution}</pre>
              </>
            ) : (
              <Button onClick={() => setRevealed(true)}>{t("syllabus.present.reveal")}</Button>
            )
          ) : (
            <p className="text-[0.85em] text-muted-foreground">{t("syllabus.present.noSolution")}</p>
          )}
        </section>
      </article>
      {c.teacherOnly.notes && (
        <div className="mx-auto max-w-4xl">
          <button type="button" className="text-sm text-link underline" onClick={() => setNotes((v) => !v)} aria-expanded={notes}>
            {notes ? t("syllabus.present.hideNotes") : t("syllabus.present.showNotes")}
          </button>
          {notes && <p className="mt-2 whitespace-pre-wrap rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm">{c.teacherOnly.notes}</p>}
        </div>
      )}
    </div>
  );
}

export function PresentModePage() {
  const { id, itemId } = useParams<{ id: string; itemId: string }>();
  return (
    <SyllabusShell title={t("syllabus.present.title")}>
      <PresentBody id={id} itemId={itemId} />
    </SyllabusShell>
  );
}

// ---------------------------------------------------------------------------
// Preview as student: the draft through the student serializers, locks bypassed
// ---------------------------------------------------------------------------

function PreviewBody({ id }: { id: string }) {
  const preview = trpc.teacher.syllabus.preview.useQuery({ id });
  const materials = useMaterials();
  const wanted = new URLSearchParams(window.location.search).get("lesson");
  const [lessonId, setLessonId] = useState<string | null>(wanted);
  if (preview.isLoading) return <Loading />;
  if (preview.error || !preview.data) return <ErrorNote error={preview.error} />;
  const { syllabus, path, lessons, problems, excluded } = preview.data;
  const current = lessons.find((l) => l.lesson.id === lessonId) ?? lessons[0] ?? null;
  const endingModule = current ? path.modules.find((m) => m.lessons[m.lessons.length - 1]?.id === current.lesson.id && m.details) : undefined;
  return (
    <div className="space-y-4">
      <Link href={`/teacher/syllabus/${id}`} className="inline-flex items-center gap-1 text-sm text-link hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t("syllabus.preview.backToBuilder")}
      </Link>
      <div className="rounded-xl border border-info/40 bg-info-surface p-3 text-sm text-info">{t("syllabus.preview.banner")}</div>
      {(problems.length > 0 || excluded.modules > 0 || excluded.lessons > 0) && (
        <div className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning">
          {problems.map((p, i) => <p key={i}>{problemText(p)}</p>)}
          {(excluded.modules > 0 || excluded.lessons > 0) && <p>{t("syllabus.publish.excluded", { modules: excluded.modules, lessons: excluded.lessons })}</p>}
        </div>
      )}
      <header className="flex flex-wrap items-center gap-4">
        {syllabus.coverFileId && <img src={fileDownloadUrl(syllabus.coverFileId)} alt="" className="h-16 w-24 rounded-lg border border-border object-cover" />}
        <div className="min-w-0">
          <h2 className="break-words text-2xl font-semibold">{syllabus.title}</h2>
          {(syllabus.subject || syllabus.level) && <p className="text-sm text-muted-foreground">{[syllabus.subject, syllabus.level].filter(Boolean).join(" · ")}</p>}
          {path.courseTiming && <div className="mt-1 flex flex-wrap gap-1.5"><CourseTimingPills timing={path.courseTiming} /></div>}
        </div>
      </header>
      {syllabus.description && <p className="max-w-3xl whitespace-pre-wrap text-sm text-foreground-secondary">{syllabus.description}</p>}
      {path.modules.length === 0 ? (
        <EmptyState title={t("syllabus.preview.emptyTitle")} body={t("syllabus.preview.emptyBody")} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav aria-label={t("syllabus.preview.path")} className="space-y-3 lg:sticky lg:top-20 lg:self-start">
            {path.modules.map((m, mi) => (
              <div key={m.id} className="rounded-2xl border border-border bg-card p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("syllabus.preview.moduleN", { n: mi + 1 })}</p>
                <p className="font-semibold">{m.title}</p>
                {m.duration && <p className="text-xs text-muted-foreground">{durationText(m.duration)}</p>}
                <ul className="mt-2 space-y-1">
                  {m.lessons.map((l) => {
                    const active = current?.lesson.id === l.id;
                    return (
                      <li key={l.id}>
                        <button
                          type="button"
                          onClick={() => setLessonId(l.id)}
                          aria-current={active ? "page" : undefined}
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${active ? "bg-muted font-medium" : "hover:bg-muted/60"}`}
                        >
                          {active ? <CheckCircle2 className="h-4 w-4 shrink-0 text-link" aria-hidden /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                          <span className="min-w-0 break-words">{l.title}</span>
                          {l.optional && <Pill className="ml-auto">{t("syllabus.optional")}</Pill>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {m.assessments.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-border pt-2">
                    {m.assessments.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 px-2 text-sm text-foreground-secondary">
                        <ClipboardCheck className="h-4 w-4 shrink-0" aria-hidden />
                        {a.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {path.finalAssessments.length > 0 && (
              <div className="rounded-2xl border border-border bg-card p-3">
                <p className="font-semibold">{t("syllabus.final.title")}</p>
                <ul className="mt-2 space-y-1">
                  {path.finalAssessments.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-sm text-foreground-secondary">
                      <ClipboardCheck className="h-4 w-4 shrink-0" aria-hidden />
                      {a.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </nav>
          {current ? (
            <article className="min-w-0 space-y-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{current.lesson.moduleTitle}</p>
                <h3 className="break-words text-xl font-semibold">{current.lesson.title}</h3>
                {current.lesson.description && <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-secondary">{current.lesson.description}</p>}
                {current.lesson.objectives.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">{current.lesson.objectives.map((o, i) => <li key={i}>{o}</li>)}</ul>
                )}
              </div>
              {current.items.length === 0 && <p className="text-sm text-muted-foreground">{t("syllabus.lesson.noItems")}</p>}
              {current.items.map((it) => {
                const Icon = KIND_ICON[it.kind];
                return (
                  <section key={it.id} className="rounded-2xl border border-border bg-card p-4">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">{kindLabel(it.kind)}</span>
                      {!it.required && <Pill>{t("syllabus.optional")}</Pill>}
                    </div>
                    <h4 className="mb-2 font-semibold">{it.title}</h4>
                    <StudentItemView kind={it.kind} content={it.content} materials={materials.byId} />
                  </section>
                );
              })}
              {endingModule && (
                <section className="space-y-3 rounded-2xl border border-border bg-card p-4" aria-label={t("moduleDetails.region", { title: endingModule.title })}>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("moduleDetails.moduleEnd", { title: endingModule.title })}</p>
                  <ModuleDetailsBlocks details={endingModule.details} as="h4" />
                </section>
              )}
            </article>
          ) : (
            <EmptyState title={t("syllabus.preview.noLessonsTitle")} body={t("syllabus.preview.noLessonsBody")} />
          )}
        </div>
      )}
    </div>
  );
}

export function SyllabusPreviewPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <SyllabusShell title={t("syllabus.preview.title")}>
      <PreviewBody id={id} />
    </SyllabusShell>
  );
}
