import { ProgressChart, TopicBars } from "@/components/AnalyticsBlocks";
import { AppShell, Loading, Panel, StatCard } from "@/components/AppShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { t } from "@/i18n/messages";
import { fmtDateTime } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Link } from "wouter";
import { AssessmentAnalytics } from "./Assessments";

export function AnalyticsPage() {
  return (
    <AppShell area="teaching">
      <Tabs defaultValue="overview" className="min-h-screen">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="overview">{t("analytics.tab.overview")}</TabsTrigger>
          <TabsTrigger value="groups">{t("common.groups")}</TabsTrigger>
          <TabsTrigger value="students">{t("common.students")}</TabsTrigger>
          <TabsTrigger value="questions">{t("common.questions")}</TabsTrigger>
          <TabsTrigger value="topics">{t("common.topics")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-3"><OverviewTab /></TabsContent>
        <TabsContent value="groups" className="pt-3"><GroupsTab /></TabsContent>
        <TabsContent value="students" className="pt-3"><StudentsTab /></TabsContent>
        <TabsContent value="questions" className="pt-3"><QuestionsTab /></TabsContent>
        <TabsContent value="topics" className="pt-3"><TopicsTab /></TabsContent>
      </Tabs>
    </AppShell>
  );
}

function OverviewTab() {
  const o = trpc.teacher.analytics.overview.useQuery();
  if (!o.data) return <Loading />;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t("analytics.resultCount")} value={o.data.resultCount} />
        <StatCard label={t("common.average")} value={`${o.data.averageScore}%`} />
        <StatCard label={t("common.median")} value={`${o.data.medianScore}%`} />
        <StatCard label={t("assessment.stat.highLow")} value={`${o.data.highestScore}% / ${o.data.lowestScore}%`} />
      </div>
      <Panel title={t("home.weakTopics")}><TopicBars rows={o.data.weakTopics} empty={t("analytics.noWeakTopics")} /></Panel>
    </div>
  );
}

function GroupsTab() {
  const g = trpc.teacher.groups.overview.useQuery();
  if (!g.data) return <Loading />;
  return (
    <Panel>
      {!g.data.length ? <p className="text-sm text-muted-foreground">{t("analytics.noGroups")}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th scope="col" className="py-2">{t("analytics.col.group")}</th>
                <th scope="col">{t("common.students")}</th>
                <th scope="col">{t("common.exams")}</th>
                <th scope="col">{t("common.participation")}</th>
                <th scope="col">{t("common.average")}</th>
                <th scope="col">{t("analytics.col.weakTopics")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {g.data.map((r) => (
                <tr key={r.groupId}>
                  <td className="break-words py-2 pr-3"><Link href={`/teacher/groups/${r.groupId}`} className="text-link underline-offset-4 hover:underline">{r.name}</Link></td>
                  <td>{r.studentCount}</td>
                  <td>{r.examCount}</td>
                  <td>{r.participation}%</td>
                  <td className="font-semibold">{r.averageScore}%</td>
                  <td className="break-words text-muted-foreground">{r.weakTopics.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function StudentsTab() {
  const list = trpc.teacher.analytics.students.useQuery();
  const [studentId, setStudentId] = useState<number | null>(null);
  const progress = trpc.teacher.analytics.student.useQuery({ studentId: studentId ?? 0 }, { enabled: studentId !== null });
  if (!list.data) return <Loading />;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel title={t("analytics.rankingAll")}>
        {!list.data.length ? <p className="text-sm text-muted-foreground">{t("common.noResults")}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2">#</th>
                  <th scope="col">{t("common.student")}</th>
                  <th scope="col">{t("common.average")}</th>
                  <th scope="col">{t("analytics.col.results")}</th>
                  <th scope="col">{t("analytics.col.last")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.data.map((s) => {
                  const selected = studentId === s.studentId;
                  return (
                    <tr key={s.studentId} className={`cursor-pointer hover:bg-muted ${selected ? "bg-info-surface" : ""}`} onClick={() => setStudentId(s.studentId)}>
                      <td className="py-2 font-semibold">{s.rank}</td>
                      <td className="pr-3">
                        <button
                          type="button"
                          aria-pressed={selected}
                          aria-label={t("analytics.selectStudent", { name: s.studentName ?? "—" })}
                          onClick={(e) => { e.stopPropagation(); setStudentId(s.studentId); }}
                          className={`break-words text-left underline-offset-4 hover:underline ${selected ? "font-semibold text-foreground" : "text-link"}`}
                        >
                          {s.studentName ?? "—"}
                        </button>
                      </td>
                      <td className="font-semibold">{s.percentage}%</td>
                      <td>{s.resultCount}</td>
                      <td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(s.lastCompletedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title={t("analytics.studentProgress")}>
        <div aria-live="polite">
          {studentId === null ? <p className="text-sm text-muted-foreground">{t("analytics.pickStudent")}</p> : !progress.data ? <Loading /> : (
            <div className="space-y-4">
              <ProgressChart data={progress.data.series.map((s) => ({ label: s.label.slice(0, 14), value: s.percentage }))} />
              <TopicBars rows={progress.data.topics} />
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function QuestionsTab() {
  const list = trpc.teacher.assessments.list.useQuery({});
  const published = (list.data ?? []).filter((a) => a.currentVersionId);
  const [id, setId] = useState("");
  const selected = id || published[0]?.id || "";
  if (!list.data) return <Loading />;
  if (!published.length) return <Panel><p className="text-sm text-muted-foreground">{t("analytics.noPublished")}</p></Panel>;
  return (
    <div className="space-y-4">
      <select
        className="max-w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground"
        aria-label={t("analytics.chooseExam")}
        value={selected}
        onChange={(e) => setId(e.target.value)}
      >
        {published.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
      </select>
      {selected && <AssessmentAnalytics id={selected} />}
    </div>
  );
}

function TopicsTab() {
  const topics = trpc.teacher.analytics.topics.useQuery();
  if (!topics.data) return <Loading />;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel title={t("common.topics")}><TopicBars rows={topics.data.topics} /></Panel>
      <Panel title={t("common.skills")}><TopicBars rows={topics.data.skills} empty={t("analytics.addSkills")} /></Panel>
    </div>
  );
}
