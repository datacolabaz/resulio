import { ProgressChart, TopicBars } from "@/components/AnalyticsBlocks";
import { AppShell, Loading, Panel, StatCard } from "@/components/AppShell";
import { ResponsiveTable } from "@/components/ResponsiveTable";
import { StatusBadge } from "@/components/StatusBadge";
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
          <TabsTrigger value="tasks">{t("analytics.tab.tasks")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-3"><OverviewTab /></TabsContent>
        <TabsContent value="groups" className="pt-3"><GroupsTab /></TabsContent>
        <TabsContent value="students" className="pt-3"><StudentsTab /></TabsContent>
        <TabsContent value="questions" className="pt-3"><QuestionsTab /></TabsContent>
        <TabsContent value="topics" className="pt-3"><TopicsTab /></TabsContent>
        <TabsContent value="tasks" className="pt-3"><TasksTab /></TabsContent>
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
        <ResponsiveTable
          rows={g.data}
          rowKey={(r) => r.groupId}
          columns={[
            {
              key: "group",
              header: t("analytics.col.group"),
              thClassName: "py-2",
              tdClassName: "break-words py-2 pr-3",
              card: "title",
              cell: (r) => <Link href={`/teacher/groups/${r.groupId}`} className="text-link underline-offset-4 hover:underline">{r.name}</Link>,
            },
            { key: "students", header: t("common.students"), cell: (r) => r.studentCount },
            { key: "exams", header: t("common.exams"), cell: (r) => r.examCount },
            { key: "participation", header: t("common.participation"), cell: (r) => `${r.participation}%` },
            { key: "average", header: t("common.average"), tdClassName: "font-semibold", cell: (r) => `${r.averageScore}%`, cardCell: (r) => <span className="font-semibold">{r.averageScore}%</span> },
            { key: "weak", header: t("analytics.col.weakTopics"), tdClassName: "break-words text-muted-foreground", cell: (r) => r.weakTopics.join(", ") || "—" },
          ]}
        />
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
          <ResponsiveTable
            rows={list.data}
            rowKey={(s) => s.studentId}
            rowClassName={(s) => `cursor-pointer hover:bg-muted ${studentId === s.studentId ? "bg-info-surface" : ""}`}
            cardClassName={(s) => `cursor-pointer ${studentId === s.studentId ? "bg-info-surface" : ""}`}
            onRowClick={(s) => setStudentId(s.studentId)}
            cardsClassName="-mx-2 divide-y [&>li]:px-2"
            columns={[
              { key: "rank", header: "#", thClassName: "py-2", tdClassName: "py-2 font-semibold", card: "title", cell: (s) => s.rank, cardCell: (s) => <span className="text-muted-foreground">{s.rank}.</span> },
              {
                key: "student",
                header: t("common.student"),
                tdClassName: "pr-3",
                card: "title",
                cell: (s) => {
                  const selected = studentId === s.studentId;
                  return (
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-label={t("analytics.selectStudent", { name: s.studentName ?? "—" })}
                      onClick={(e) => { e.stopPropagation(); setStudentId(s.studentId); }}
                      className={`break-words text-left underline-offset-4 hover:underline ${selected ? "font-semibold text-foreground" : "text-link"}`}
                    >
                      {s.studentName ?? "—"}
                    </button>
                  );
                },
              },
              { key: "average", header: t("common.average"), tdClassName: "font-semibold", card: "aside", cell: (s) => `${s.percentage}%`, cardCell: (s) => <span className="font-semibold">{s.percentage}%</span> },
              { key: "results", header: t("analytics.col.results"), cell: (s) => s.resultCount },
              { key: "last", header: t("analytics.col.last"), tdClassName: "whitespace-nowrap text-muted-foreground", cell: (s) => fmtDateTime(s.lastCompletedAt) },
            ]}
          />
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
        className="w-full max-w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground sm:w-auto"
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

function TasksTab() {
  const q = trpc.teacher.analytics.tasks.useQuery();
  if (!q.data) return <Loading />;
  const { summary, tasks } = q.data;
  if (!tasks.length) return <Panel><p className="text-sm text-muted-foreground">{t("analytics.noTasks")}</p></Panel>;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t("analytics.taskCount")} value={summary.taskCount} />
        <StatCard label={t("analytics.submissionRate")} value={`${summary.submissionRate}%`} />
        <StatCard label={t("analytics.onTimeRate")} value={`${summary.onTimeRate}%`} />
        <StatCard label={t("analytics.avgGradingTime")} value={summary.avgGradingHours != null ? t("analytics.hours", { count: summary.avgGradingHours }) : "—"} />
      </div>
      <Panel>
        <ResponsiveTable
          rows={tasks}
          rowKey={(tp) => tp.id}
          columns={[
            {
              key: "task",
              header: t("modules.task"),
              thClassName: "py-2",
              tdClassName: "break-words py-2 pr-3",
              card: "title",
              cell: (tp) => <Link href="/teacher/assignments" className="text-link underline-offset-4 hover:underline">{tp.title}</Link>,
            },
            { key: "deadline", header: t("modules.deadline"), tdClassName: "whitespace-nowrap pr-3 text-muted-foreground", cell: (tp) => fmtDateTime(tp.deadline) },
            {
              key: "completion",
              header: t("groups.completion"),
              tdClassName: "flex items-center gap-2 pr-3",
              cell: (tp) => (
                <>
                  <span className="font-semibold">{tp.submittedCount}/{tp.targetCount}</span>
                  {!!tp.lateCount && <StatusBadge tone="warning">{t("groups.lateCount", { count: tp.lateCount })}</StatusBadge>}
                </>
              ),
              cardCell: (tp) => (
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  <span className="font-semibold">{tp.submittedCount}/{tp.targetCount}</span>
                  {!!tp.lateCount && <StatusBadge tone="warning">{t("groups.lateCount", { count: tp.lateCount })}</StatusBadge>}
                </span>
              ),
            },
            { key: "graded", header: t("analytics.col.graded"), tdClassName: "text-muted-foreground", cell: (tp) => tp.gradedCount },
          ]}
        />
      </Panel>
    </div>
  );
}
