import { AppShell, EmptyState, Loading, Panel } from "@/components/AppShell";
import { MasteryBadge, MasteryBar, MasteryCell, TrendMark } from "@/components/growth/Mastery";
import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { Target } from "lucide-react";
import { useEffect, useState } from "react";
import { StudentPlan } from "./StudentPlan";

const selectClass = "mt-1 w-full max-w-sm rounded-lg border border-input bg-card px-3 py-2 text-foreground";

/** The student's own topic map; "Prioritet mövzu" instead of the teacher's "kritik zəiflik". */
export function StudentGrowthPage() {
  const enabled = trpc.student.growth.enabled.useQuery(undefined, { staleTime: 5 * 60_000 });
  const spaces = trpc.student.growth.spaces.useQuery(undefined, { enabled: !!enabled.data?.enabled });
  const [groupId, setGroupId] = useState("");
  useEffect(() => {
    if (!groupId && spaces.data?.length) setGroupId(spaces.data[0].groupId);
  }, [groupId, spaces.data]);
  return (
    <AppShell area="learning">
      <div className="space-y-5">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl">{t("nav.myGrowth")}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("studentGrowth.intro")}</p>
        </div>
        {!enabled.data ? (
          <Loading />
        ) : !enabled.data.enabled ? (
          <EmptyState title={t("nav.myGrowth")} body={t("studentGrowth.notEnabled")} />
        ) : !spaces.data ? (
          <Loading />
        ) : (
          <>
            {spaces.data.length > 1 && (
              <label className="block text-sm font-medium">
                {t("studentGrowth.space")}
                <select className={selectClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  {spaces.data.map((s) => <option key={s.groupId} value={s.groupId}>{s.groups.join(", ")}</option>)}
                </select>
              </label>
            )}
            {groupId && <StudentPlan groupId={groupId} />}
            {groupId && <StudentMap groupId={groupId} />}
          </>
        )}
      </div>
    </AppShell>
  );
}

function StudentMap({ groupId }: { groupId: string }) {
  const q = trpc.student.growth.weakness.useQuery({ groupId });
  if (!q.data) return <Loading />;
  const { topics, skills, gains } = q.data;
  if (!topics.length) return <Panel><p className="text-sm text-muted-foreground">{t("studentGrowth.empty")}</p></Panel>;
  return (
    <>
      <Panel title={t("studentGrowth.gains")}>
        {!gains.length ? (
          <p className="text-sm text-muted-foreground">{t("studentGrowth.noGains")}</p>
        ) : (
          <ol className="grid gap-3 md:grid-cols-3">
            {gains.map((g) => (
              <li key={g.topicKey} className="rounded-xl border border-border p-4">
                <div className="flex items-start gap-2">
                  <Target className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 break-words font-medium">{g.label}</span>
                </div>
                <div className="mt-3"><MasteryBar mastery={g.mastery} status={g.status} /></div>
                <div className="mt-2"><MasteryBadge status={g.status} audience="student" /></div>
                <p className="mt-2 text-sm text-muted-foreground">{t("studentGrowth.gainHint", { value: g.gain })}</p>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      <Panel title={t("studentGrowth.topics")}>
        <p className="mb-3 text-xs text-muted-foreground">{t("growth.mastery.explain")}</p>
        <ul className="divide-y">
          {topics.map((m) => (
            <li key={m.topicKey} className="space-y-1.5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words text-sm font-medium">{m.label}</span>
                <MasteryBadge status={m.status} audience="student" />
              </div>
              <MasteryBar mastery={m.mastery} status={m.status} />
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{t("growth.student.mastery")}: {Math.round(m.mastery)}%</span>
                <TrendMark trend={m.trend} delta={m.trendDelta} />
                <span>{t("studentGrowth.questions", { count: m.evidenceCount })}</span>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      {skills.length > 0 && (
        <Panel title={t("studentGrowth.skills")}>
          <ul className="flex flex-wrap gap-2">
            {skills.map((s) => (
              <li key={s.topicKey} className="flex items-center gap-2 rounded-lg border border-border px-2 py-1 text-sm">
                <span className="break-words">{s.label}</span>
                <MasteryCell mastery={s.mastery} status={s.status} audience="student" />
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
