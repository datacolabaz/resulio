import { AssessmentActivity } from "@/components/ActivityCards";
import { AppShell, EmptyState, Loading, Panel, StatCard } from "@/components/AppShell";
import { ReferralCard } from "@/components/ReferralCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { fmtWindow, liveLabel, typeLabel } from "@/lib/format";
import { liveStatus } from "@/lib/status";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

const linkClass = "text-sm text-link underline-offset-4 hover:underline";

export default function TeacherHome() {
  const dash = trpc.teacher.dashboard.useQuery();
  const groups = trpc.teacher.groups.list.useQuery();
  const pending = trpc.teacher.results.pendingReviews.useQuery({});
  const d = dash.data;

  return (
    <AppShell area="teaching">
      {!d ? (
        <Loading />
      ) : (
        <div className="space-y-6">
          <ReferralCard variant="onboarding" />
          <AssessmentActivity />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label={t("home.activeGroups")}
              value={groups.data?.length ?? 0}
              hint={t("common.studentsCount", { count: groups.data?.reduce((s, g) => s + g.studentCount, 0) ?? 0 })}
            />
            <StatCard label={t("home.upcomingExams")} value={d.upcoming.length} hint={t("home.draftsCount", { count: d.drafts })} />
            <StatCard label={t("home.averageScore")} value={`${d.averageScore}%`} />
            <StatCard label={t("home.toReview")} value={pending.data?.length ?? 0} />
          </div>
          {((groups.data?.length ?? 0) > 0 || d.upcoming.length > 0 || d.drafts > 0) && <ReferralCard variant="dashboard" />}

          <div className="grid gap-6 xl:grid-cols-3">
            <Panel className="xl:col-span-2" title={t("home.activeAndUpcoming")} action={<Link href="/teacher/assessments" className={linkClass}>{t("common.all")}</Link>}>
              {d.upcoming.length === 0 ? (
                <EmptyState
                  title={t("home.noExams")}
                  body={t("home.noExamsBody")}
                  action={
                    <Button asChild>
                      <Link href="/teacher/assessments/new">{t("nav.newExam")}</Link>
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y">
                  {d.upcoming.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <Link href={`/teacher/assessments/${a.id}`} className="min-w-0 flex-1 hover:underline">
                        <div className="break-words font-medium">{a.title}</div>
                        <div className="text-xs text-muted-foreground">{typeLabel(a.type)} · {fmtWindow(a.startAt, a.endAt)}</div>
                      </Link>
                      <StatusBadge {...liveStatus(a.liveStatus)}>{liveLabel(a.liveStatus)}</StatusBadge>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title={t("home.needsSupport")}>
              {d.weakStudents.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("home.noWeakStudents")}</p>
              ) : (
                <ul className="space-y-2">
                  {d.weakStudents.map((s) => (
                    <li key={s.id} className="flex justify-between gap-3 text-sm">
                      <span className="min-w-0 break-words">{s.name}</span>
                      <span className="font-semibold text-destructive">{s.averageScore}%</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <Panel className="xl:col-span-2" title={t("home.recentResults")} action={<Link href="/teacher/results" className={linkClass}>{t("common.all")}</Link>}>
              {d.recentResults.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("home.noRecentResults")}</p>
              ) : (
                <ul className="divide-y">
                  {d.recentResults.map((r) => (
                    <li key={r.id}>
                      <Link href={`/teacher/results/${r.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:underline">
                        <span className="min-w-0 break-words">{r.studentName} · <span className="text-muted-foreground">{r.assessmentTitle}</span></span>
                        <span className="font-semibold">{r.percentage}%</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title={t("home.weakTopics")}>
              {d.weakTopics.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("home.notEnoughData")}</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {d.weakTopics.map((tp) => (
                    <li key={tp.topic} className="flex justify-between gap-3"><span className="min-w-0 break-words">{tp.topic}</span><span className="font-semibold">{tp.accuracyPercentage}%</span></li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </AppShell>
  );
}
