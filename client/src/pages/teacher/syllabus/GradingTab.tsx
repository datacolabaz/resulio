import { EmptyState, ErrorNote, Loading, Panel, Pill } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { SubmissionReview } from "@/components/SubmissionReview";
import { NextStepButton } from "@/components/syllabus/Workflow";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { fmtDateTime } from "@/lib/format";
import { gradable, type TeacherStep } from "@/lib/syllabusWorkflow";
import { trpc } from "@/lib/trpc";
import { fileDownloadUrl } from "@/lib/uploadFile";
import { ExternalLink, Inbox } from "lucide-react";
import { Link } from "wouter";
import { ApprovalQueue } from "./StudentsTab";
import type { Tree } from "./SyllabusDetail";

/** Where each item sits, for "Lesson 3 · Module 1" style subtitles. */
function itemPlaces(tree: Tree) {
  const places = new Map<string, string>();
  for (const m of tree.modules) {
    for (const it of m.items) places.set(it.id, m.title);
    for (const l of m.lessons) for (const it of l.items) places.set(it.id, `${l.title} · ${m.title}`);
  }
  for (const it of tree.finalItems) places.set(it.id, t("grading.finalPlace"));
  return places;
}

/**
 * The "Grade" step: approvals waiting for the teacher, submitted student practice (graded here with
 * the same review box as assignments) and links to each test's results.
 */
export function GradingTab({ tree, next, onStep }: { tree: Tree; next: TeacherStep | null; onStep: (step: TeacherStep) => void }) {
  const id = tree.syllabus.id;
  const published = !!tree.syllabus.currentVersionId;
  const g = gradable(tree);
  const utils = trpc.useUtils();
  const practice = trpc.teacher.syllabus.practiceSubmissions.useQuery({ id }, { enabled: published && g.any });
  const approvals = trpc.teacher.syllabus.approvals.useQuery({ id }, { enabled: published && g.any });
  const places = itemPlaces(tree);
  const draftTitle = new Map([...tree.modules.flatMap((m) => [...m.items, ...m.lessons.flatMap((l) => l.items)]), ...tree.finalItems].map((it) => [it.id, it.title]));
  const nextButton = next && <NextStepButton step={next} onSelect={onStep} />;

  if (!g.any) {
    return (
      <EmptyState
        title={t("grading.noneTitle")}
        body={t("grading.noneBody")}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={() => onStep("organize")}>{t("grading.addTest")}</Button>
            {nextButton}
          </div>
        }
      />
    );
  }
  if (practice.error) return <ErrorNote error={practice.error} />;
  if (published && (practice.isLoading || approvals.isLoading)) return <Loading />;

  const items = practice.data?.items ?? [];
  const nothingYet = !items.length && !approvals.data?.length;
  const refresh = () => {
    void utils.teacher.syllabus.practiceSubmissions.invalidate({ id });
    void utils.teacher.syllabus.students.invalidate({ id });
    void utils.teacher.syllabus.analytics.invalidate();
  };

  return (
    <div className="space-y-4">
      {nothingYet && (
        <section className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-card p-8 text-center">
          <Inbox className="h-8 w-8 text-muted-foreground" aria-hidden />
          <h2 className="text-lg font-semibold">{t("grading.emptyTitle")}</h2>
          <p className="max-w-lg text-sm text-muted-foreground">{published ? t("grading.emptyBody") : t("grading.emptyUnpublished")}</p>
          {nextButton}
        </section>
      )}
      {published && <ApprovalQueue id={id} />}
      {items.length > 0 && (
        <Panel title={t("grading.practiceTitle")} action={practice.data?.waiting ? <StatusBadge tone="warning">{t("grading.waiting", { count: practice.data.waiting })}</StatusBadge> : undefined}>
          <ul className="space-y-3">
            {items.map((it) => (
              <li key={it.itemId}>
                <details open={it.waiting > 0} className="rounded-xl border border-border">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3">
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-medium">{draftTitle.get(it.itemId) ?? it.title}</span>
                      {places.get(it.itemId) && <span className="block break-words text-xs text-muted-foreground">{places.get(it.itemId)}</span>}
                    </span>
                    {it.waiting > 0 ? <StatusBadge tone="warning">{t("grading.waiting", { count: it.waiting })}</StatusBadge> : <StatusBadge tone="success">{t("grading.allChecked")}</StatusBadge>}
                    <Pill>{t("grading.submitted", { count: it.submissions.length })}</Pill>
                  </summary>
                  <ul className="divide-y divide-border border-t border-border">
                    {it.submissions.map((s) => (
                      <li key={s.id} className="p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0 break-words font-medium">{s.studentName}</span>
                          {s.submittedAt && <span className="text-xs text-muted-foreground">{t("modules.submittedAt", { date: fmtDateTime(s.submittedAt) })}</span>}
                        </div>
                        {s.files.length > 0 && (
                          <ul className="mt-1.5 flex flex-wrap gap-1.5">
                            {s.files.map((file) => (
                              <li key={file.fileId}>
                                <a href={fileDownloadUrl(file.fileId)} className="rounded-lg border border-border bg-muted px-2 py-1 text-xs text-link underline-offset-2 hover:underline">
                                  {file.name}
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}
                        <SubmissionReview key={`${s.id}:${s.gradedAt ?? ""}`} submission={s} review={s.review ?? undefined} autoGrade={s.autoGrade} onChanged={refresh} />
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
          {practice.data?.ai && !practice.data.ai.enabled && <p className="mt-2 text-xs text-muted-foreground">{t("aiReview.disabledNote")}</p>}
        </Panel>
      )}
      {g.tests.length > 0 && (
        <Panel title={t("grading.testsTitle")}>
          <p className="mb-3 text-sm text-muted-foreground">{t("grading.testsHelp")}</p>
          <ul className="divide-y divide-border">
            {g.tests.map((it) => (
              <li key={it.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-medium">{it.title}</span>
                  {places.get(it.id) && <span className="block break-words text-xs text-muted-foreground">{places.get(it.id)}</span>}
                </span>
                {it.assessmentId ? (
                  <Link href={`/teacher/assessments/${it.assessmentId}?tab=results`} className="inline-flex min-h-9 items-center gap-1 rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-muted">
                    {t("grading.openResults")}
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">{t("grading.noTestLinked")}</span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
