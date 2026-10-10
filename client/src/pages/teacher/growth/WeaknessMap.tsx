import { Loading, Panel } from "@/components/AppShell";
import { MasteryBadge, MasteryBar, MasteryCell, TrendMark } from "@/components/growth/Mastery";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { t } from "@/i18n/messages";
import { fmtDay } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { useEffect, useMemo, useState } from "react";

const selectClass = "mt-1 w-full max-w-sm rounded-lg border border-input bg-card px-3 py-2 text-foreground";

/** Group heat grid of mastery per student and topic, with a per-student detail sheet. */
export function WeaknessMapTab() {
  const groups = trpc.teacher.groups.list.useQuery();
  const [groupId, setGroupId] = useState("");
  const [studentId, setStudentId] = useState<number | null>(null);
  useEffect(() => {
    if (!groupId && groups.data?.length) setGroupId(groups.data[0].id);
  }, [groupId, groups.data]);
  if (!groups.data) return <Loading />;
  if (!groups.data.length) return <Panel><p className="text-sm text-muted-foreground">{t("growth.weak.noGroups")}</p></Panel>;
  return (
    <div className="space-y-5">
      <label className="block text-sm font-medium">
        {t("growth.weak.pickGroup")}
        <select className={selectClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          {groups.data.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </label>
      {groupId && <GroupWeakness groupId={groupId} onStudent={setStudentId} />}
      <StudentWeaknessSheet studentId={studentId} onClose={() => setStudentId(null)} />
    </div>
  );
}

function GroupWeakness({ groupId, onStudent }: { groupId: string; onStudent: (id: number) => void }) {
  const q = trpc.teacher.growth.groupWeakness.useQuery({ groupId });
  const cellOf = useMemo(() => new Map((q.data?.cells ?? []).map((c) => [`${c.studentId}|${c.topicKey}`, c])), [q.data]);
  if (!q.data) return <Loading />;
  const { topics, students } = q.data;
  if (!topics.length) return <Panel><p className="text-sm text-muted-foreground">{t("growth.weak.empty")}</p></Panel>;
  return (
    <>
      <Panel title={t("growth.weak.topics")}>
        <p className="mb-4 text-xs text-muted-foreground">{t("growth.mastery.explain")}</p>
        <ul className="grid gap-3 md:grid-cols-2">
          {topics.slice(0, 8).map((tp) => (
            <li key={tp.topicKey} className="rounded-xl border border-border p-3">
              <div className="break-words text-sm font-medium">{tp.label}</div>
              <div className="mt-2"><MasteryBar mastery={tp.avgMastery} status={tp.avgMastery >= 75 ? "STRONG" : tp.avgMastery >= 50 ? "REVIEW" : "CRITICAL"} /></div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{t("growth.weak.avg", { value: Math.round(tp.avgMastery) })}</span>
                {tp.critical > 0 && <span className="text-destructive">{t("growth.weak.criticalCount", { count: tp.critical })}</span>}
                {tp.review > 0 && <span className="text-warning">{t("growth.weak.reviewCount", { count: tp.review })}</span>}
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title={t("growth.weak.grid")}>
        <p className="mb-3 text-xs text-muted-foreground">{t("growth.weak.legend")}</p>
        <div className="overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-1 text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-card px-2 py-1 text-left font-medium">{t("growth.weak.colStudent")}</th>
                {topics.map((tp) => (
                  <th key={tp.topicKey} className="max-w-32 px-1 py-1 text-left align-bottom text-xs font-medium text-muted-foreground">
                    <span className="line-clamp-3 break-words" title={tp.label}>{tp.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id}>
                  <th className="sticky left-0 z-10 bg-card px-2 py-1 text-left font-normal">
                    <button type="button" className="text-left text-primary underline-offset-2 hover:underline" onClick={() => onStudent(s.id)}>
                      {s.name}
                    </button>
                  </th>
                  {topics.map((tp) => {
                    const c = cellOf.get(`${s.id}|${tp.topicKey}`);
                    return <td key={tp.topicKey} className="px-1 py-1 text-center">{c ? <MasteryCell mastery={c.mastery} status={c.status} /> : <span className="text-muted-foreground">·</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

export function StudentWeaknessSheet({ studentId, onClose }: { studentId: number | null; onClose: () => void }) {
  return (
    <Sheet open={studentId != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl" aria-describedby={undefined}>
        {studentId != null && <StudentWeakness studentId={studentId} />}
      </SheetContent>
    </Sheet>
  );
}

function StudentWeakness({ studentId }: { studentId: number }) {
  const q = trpc.teacher.growth.studentWeakness.useQuery({ studentId });
  if (!q.data) return <Loading />;
  const { student, topics, skills, gains } = q.data;
  return (
    <div className="space-y-5 p-1">
      <SheetHeader className="pr-10">
        <SheetTitle>{t("growth.student.title", { name: student.name })}</SheetTitle>
      </SheetHeader>
      {!topics.length ? (
        <p className="text-sm text-muted-foreground">{t("growth.student.empty")}</p>
      ) : (
        <>
          <section>
            <h3 className="mb-2 text-sm font-semibold">{t("growth.student.gains")}</h3>
            {!gains.length ? (
              <p className="text-sm text-muted-foreground">{t("growth.student.noGains")}</p>
            ) : (
              <ol className="space-y-2">
                {gains.map((g) => (
                  <li key={g.topicKey} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
                    <span className="min-w-0 break-words text-sm font-medium">{g.label}</span>
                    <span className="flex items-center gap-2">
                      <MasteryBadge status={g.status} />
                      <span className="text-xs text-muted-foreground">{t("growth.student.gainValue", { value: g.gain })}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">{t("growth.student.topics")}</h3>
            <ul className="divide-y">
              {topics.map((m) => (
                <li key={m.topicKey} className="space-y-1.5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words text-sm font-medium">{m.label}</span>
                    <MasteryBadge status={m.status} />
                  </div>
                  <MasteryBar mastery={m.mastery} status={m.status} />
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{t("growth.student.mastery")}: {Math.round(m.mastery)}%</span>
                    <TrendMark trend={m.trend} delta={m.trendDelta} />
                    <span>{t("growth.student.evidence", { count: m.evidenceCount, exams: m.examCount })}</span>
                    <span>{fmtDay(m.lastEvidenceAt)}</span>
                  </div>
                  {m.history.length > 1 && (
                    <div className="text-xs text-muted-foreground">{t("growth.student.history", { list: m.history.map((h) => `${Math.round(h.pct)}%`).join(" · ") })}</div>
                  )}
                </li>
              ))}
            </ul>
          </section>
          {skills.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">{t("growth.student.skills")}</h3>
              <ul className="flex flex-wrap gap-2">
                {skills.map((s) => (
                  <li key={s.topicKey} className="flex items-center gap-2 rounded-lg border border-border px-2 py-1 text-sm">
                    <span className="break-words">{s.label}</span>
                    <MasteryCell mastery={s.mastery} status={s.status} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
