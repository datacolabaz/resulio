import { useAuth } from "@/_core/hooks/useAuth";
import { ActivityChart, ScoreBoardTable } from "@/components/ActivityBlocks";
import { AppShell, ErrorNote, Loading, Panel, StatCard } from "@/components/AppShell";
import { t } from "@/i18n/messages";
import { fmtDateTime } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { Medal, Trophy } from "lucide-react";
import { Link } from "wouter";

/** The student's own activity and progress: submissions, on-time rate, first places, released scores, group positions. */
export default function StudentProfile() {
  const { user } = useAuth();
  const q = trpc.student.profile.useQuery();
  return (
    <AppShell area="learning" title={user?.name ?? t("nav.myProfile")}>
      {q.error ? (
        <ErrorNote error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label={t("motivation.col.submitted")} value={q.data.totals.submitted} hint={q.data.totals.late ? t("motivation.lateCount", { count: q.data.totals.late }) : undefined} />
            <StatCard label={t("motivation.col.onTime")} value={q.data.totals.submitted ? `${q.data.totals.onTimeRate}%` : "—"} />
            <StatCard label={t("motivation.col.firstPlaces")} value={q.data.totals.firstPlaces} hint={t("motivation.podiumsHint", { count: q.data.totals.podiums })} />
            <StatCard label={t("motivation.averageScore")} value={q.data.totals.averageScore === null ? "—" : `${q.data.totals.averageScore}/100`} />
          </div>

          {(q.data.totals.firstPlaces > 0 || q.data.totals.podiums > 0) && (
            <div className="flex flex-wrap gap-2" aria-label={t("motivation.badges")}>
              {q.data.totals.firstPlaces > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning-surface px-3 py-1 text-sm text-warning">
                  <Trophy className="h-4 w-4" aria-hidden />
                  {t("motivation.firstPlacesCount", { count: q.data.totals.firstPlaces })}
                </span>
              )}
              {q.data.totals.podiums > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-sm text-foreground-secondary">
                  <Medal className="h-4 w-4" aria-hidden />
                  {t("motivation.podiumsCount", { count: q.data.totals.podiums })}
                </span>
              )}
            </div>
          )}

          <Panel title={t("motivation.myActivity")}>
            <ActivityChart data={q.data.activity} />
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title={t("motivation.myGroups")}>
              {!q.data.groups.length ? (
                <p className="text-sm text-muted-foreground">{t("student.noGroups")}</p>
              ) : (
                <ul className="divide-y">
                  {q.data.groups.map((g) => {
                    const mine = g.scores.rows.find((r) => r.isYou);
                    const ranked = g.scores.rows.filter((r) => r.rank !== null).length;
                    return (
                      <li key={g.groupId} className="space-y-2 py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 break-words">{g.name}</span>
                          <span className="shrink-0 text-right">
                            <span className="block font-semibold">{t("motivation.rankOf", { rank: g.rank, of: g.of })}</span>
                            {g.scores.visible && mine?.rank && (
                              <span className="block text-xs text-muted-foreground">{t("motivation.scoreRank", { rank: mine.rank, of: ranked })}</span>
                            )}
                          </span>
                        </div>
                        {g.scores.tasks.length > 0 && (
                          <details>
                            <summary className="cursor-pointer text-xs text-link">{g.scores.visible ? t("motivation.groupScores") : t("motivation.myScores")}</summary>
                            <div className="mt-2"><ScoreBoardTable data={g.scores} /></div>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <Link href="/student/groups" className="mt-2 inline-block text-xs text-link underline-offset-2 hover:underline">{t("nav.myGroups")}</Link>
            </Panel>
            <Panel title={t("motivation.releasedScores")}>
              {!q.data.releasedScores.length ? (
                <p className="text-sm text-muted-foreground">{t("motivation.noReleasedScores")}</p>
              ) : (
                <ul className="divide-y">
                  {q.data.releasedScores.map((r) => (
                    <li key={r.taskId} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="block break-words">{r.title}</span>
                        <span className="text-xs text-muted-foreground">{fmtDateTime(r.releasedAt)}</span>
                      </span>
                      <span className="shrink-0 font-semibold">{r.score}/100</span>
                    </li>
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
