import { Panel, Pill } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { fmtDay, fmtRelative } from "@/lib/format";
import { continueCandidates, usageMap } from "@/lib/syllabusWorkflow";
import { trpc } from "@/lib/trpc";
import { lessonPath, ProgressBar, syllabusPath } from "@/pages/student/syllabus/common";
import { GrantStateBadge, SyllabusVisibilityBadges } from "@/pages/teacher/syllabus/shared";
import { BookOpen, Library } from "lucide-react";
import { Link } from "wouter";

/**
 * Small read-only syllabus entries on existing screens (student home, teacher home, group page,
 * materials library). Each renders nothing when the feature is off for the workspace or a request
 * fails, so the host screen behaves exactly as before.
 */

const linkClass = "text-sm text-link underline-offset-4 hover:underline";
const FLAG_STALE = 5 * 60_000;

function useTeacherSyllabusOn() {
  const flag = trpc.teacher.syllabus.enabled.useQuery(undefined, { staleTime: FLAG_STALE });
  return !!flag.data?.enabled;
}

export function ContinueLearning() {
  const flag = trpc.student.syllabus.enabled.useQuery(undefined, { staleTime: FLAG_STALE });
  const list = trpc.student.syllabus.list.useQuery(undefined, { enabled: !!flag.data?.enabled, retry: false });
  const cards = continueCandidates(list.data ?? []);
  if (!cards.length) return null;
  const [first, ...rest] = cards;
  const p = first.progress;
  const target = p?.currentLessonId ? lessonPath(first.id, p.currentLessonId) : syllabusPath(first.id);
  return (
    <Panel title={t("ux.continue.title")} action={<Link href="/student/syllabus" className={linkClass}>{t("ux.continue.all")}</Link>}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 break-words font-semibold">{first.title}</span>
          </div>
          {p && (
            <>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-foreground-secondary">{t("learn.lessonsDone", { done: p.completedLessons, total: p.totalLessons })}</span>
                <span className="font-semibold">{p.progressPct}%</span>
              </div>
              <ProgressBar value={p.progressPct} label={t("learn.overallProgress")} />
              {p.lastActivityAt && <p className="text-xs text-muted-foreground">{t("learn.lastActivity", { when: fmtRelative(p.lastActivityAt) })}</p>}
            </>
          )}
        </div>
        <Button asChild className="w-full sm:w-auto">
          <Link href={target}>{p ? t("learn.continue") : t("learn.start")}</Link>
        </Button>
      </div>
      {rest.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-1 text-xs text-muted-foreground">{t("ux.continue.more")}</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {rest.slice(0, 3).map((c) => (
              <li key={c.id}>
                <Link href={syllabusPath(c.id)} className={linkClass}>
                  {c.title}
                  {c.progress ? ` · ${c.progress.progressPct}%` : ""}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

export function TeacherHomeSyllabi() {
  const on = useTeacherSyllabusOn();
  const list = trpc.teacher.syllabus.list.useQuery(undefined, { enabled: on, retry: false });
  if (!on || !list.data) return null;
  const rows = list.data.filter((s) => !s.archivedAt);
  const recent = [...rows].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 3);
  return (
    <Panel title={t("ux.home.title")} action={<Link href="/teacher/syllabus" className={linkClass}>{t("common.all")}</Link>}>
      {!recent.length ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">{t("ux.home.empty")}</p>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/teacher/syllabus">{t("ux.home.create")}</Link>
          </Button>
        </div>
      ) : (
        <ul className="divide-y">
          {recent.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <Link href={`/teacher/syllabus/${s.id}`} className="min-w-0 flex-1 hover:underline">
                <div className="break-words font-medium">{s.title}</div>
                <div className="text-xs text-muted-foreground">
                  {t("syllabus.count.lessons", { count: s.lessonCount })} · {t("syllabus.count.enrolled", { count: s.enrolledCount })}
                  {s.enrolledCount > 0 ? ` · ${t("syllabus.count.avgProgress", { pct: s.averageProgressPct })}` : ""}
                </div>
              </Link>
              <span className="flex flex-wrap gap-1.5">
                <SyllabusVisibilityBadges syllabus={s} activeGrants={s.activeGrantCount} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function GroupSyllabiPanel({ groupId }: { groupId: string }) {
  const on = useTeacherSyllabusOn();
  const q = trpc.teacher.syllabus.forGroup.useQuery({ groupId }, { enabled: on, retry: false });
  if (!on || !q.data) return null;
  return (
    <Panel title={t("ux.group.title")}>
      {!q.data.length ? (
        <p className="text-sm text-muted-foreground">{t("ux.group.empty")}</p>
      ) : (
        <ul className="divide-y">
          {q.data.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/teacher/syllabus/${s.id}`} className="min-w-0 break-words font-medium text-link underline-offset-4 hover:underline">{s.title}</Link>
                  <GrantStateBadge state={s.state} />
                  {s.archived && <Pill>{t("ux.group.archived")}</Pill>}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-secondary">
                  <span>{t("ux.group.started", { enrolled: s.enrolled, members: s.members })}</span>
                  <span>{t("ux.group.completed", { count: s.completed })}</span>
                  {s.enrolled > 0 && <span>{t("syllabus.count.avgProgress", { pct: s.averageProgressPct })}</span>}
                  {s.endsAt && <span>{t("ux.group.until", { at: fmtDay(s.endsAt) })}</span>}
                </div>
                {s.enrolled > 0 && <ProgressBar value={s.averageProgressPct} label={t("syllabus.count.avgProgress", { pct: s.averageProgressPct })} className="max-w-xs" />}
              </div>
              <Link href={`/teacher/syllabus/${s.id}?tab=students`} className={`${linkClass} shrink-0`}>{t("ux.group.open")}</Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** materialId → number of syllabi using it; empty when the feature is off. */
export function useMaterialSyllabusUsage() {
  const on = useTeacherSyllabusOn();
  const q = trpc.teacher.syllabus.materialUsage.useQuery(undefined, { enabled: on, retry: false, staleTime: 60_000 });
  return usageMap(on ? q.data : undefined);
}

export function MaterialUsageBadge({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <div className="mt-2">
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-neutral-surface px-2.5 py-0.5 text-xs font-medium text-neutral">
        <Library className="h-3.5 w-3.5" aria-hidden />
        {t("ux.usedIn", { count })}
      </span>
    </div>
  );
}