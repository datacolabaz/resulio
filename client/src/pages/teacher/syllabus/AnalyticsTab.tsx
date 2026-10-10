import { AXIS, TOOLTIP } from "@/components/AnalyticsBlocks";
import { ChoiceChip, EmptyState, ErrorNote, Loading, Panel } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { ActivityTimeline } from "@/components/syllabus/ActivityTimeline";
import { NextStepButton } from "@/components/syllabus/Workflow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SettingToggle } from "@/components/ui/setting-toggle";
import { t } from "@/i18n/messages";
import { fmtDateTime, fmtDuration, fmtRelative } from "@/lib/format";
import type { TeacherStep } from "@/lib/syllabusWorkflow";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ProgressBar } from "@/pages/student/syllabus/common";
import {
  DEFAULT_RISK_THRESHOLDS,
  RISK_THRESHOLD_LIMITS,
  type AnalyticsSettings,
  type RiskThresholdKey,
} from "@shared/syllabusAnalytics";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Info, Lightbulb, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { useSearch } from "wouter";
import type { Tree } from "./SyllabusDetail";
import { fieldLabel, GrantStateBadge, selectCls, toastError } from "./shared";

type Data = RouterOutputs["teacher"]["syllabus"]["analytics"];
type StudentRow = Data["students"][number];

const STUDENTS_ID = "sa-students";

const pctText = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v)}%`);
const numText = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));
const timeText = (v: number | null | undefined) => (v === null || v === undefined ? "—" : fmtDuration(v));

/** §31–§44: what happens inside the syllabus, kept apart as access / progress / completion / mastery. */
export function AnalyticsTab({ tree, next, onStep }: { tree: Tree; next?: TeacherStep | null; onStep?: (step: TeacherStep) => void }) {
  const id = tree.syllabus.id;
  const [groupId, setGroupId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [timelineFor, setTimelineFor] = useState<StudentRow | null>(null);
  const q = trpc.teacher.syllabus.analytics.useQuery({ id, groupId }, { staleTime: 60_000, enabled: !!tree.syllabus.currentVersionId });
  const focus = new URLSearchParams(useSearch()).get("focus");
  const loaded = !!q.data;
  useEffect(() => {
    if (!loaded || focus !== "students") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(STUDENTS_ID)?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [loaded, focus]);
  const empty = <EmptyState title={t("track.emptyTitle")} body={t("track.emptyBody")} action={next && onStep ? <NextStepButton step={next} onSelect={onStep} /> : undefined} />;
  if (!tree.syllabus.currentVersionId) return empty;
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  if (!groupId && !d.students.length) return empty;
  const groupName = new Map(d.groupOptions.map((g) => [g.id, g.name]));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {d.groupOptions.length > 0 && (
            <label className="space-y-1 text-sm">
              <span className={fieldLabel}>{t("sa.group")}</span>
              <select className={`${selectCls} min-w-48`} value={groupId ?? ""} onChange={(e) => setGroupId(e.target.value || null)}>
                <option value="">{t("sa.allGroups")}</option>
                {d.groupOptions.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </label>
          )}
          <span className="pb-2 text-xs text-muted-foreground">{t("sa.updated", { when: fmtRelative(d.generatedAt) })}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`mr-1 h-4 w-4 ${q.isFetching ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden />
            {t("sa.refresh")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="mr-1 h-4 w-4" aria-hidden />
            {t("sa.settings")}
          </Button>
        </div>
      </div>

      <Overview d={d} />
      <Insights d={d} />
      <Funnel d={d} />
      <StudentTable rows={d.students} groupName={groupName} onTimeline={setTimelineFor} />
      {!groupId && <Groups d={d} />}
      <Modules d={d} />
      <Lessons d={d} />
      <Practice d={d} />

      {timelineFor && <TimelineDialog id={id} row={timelineFor} onClose={() => setTimelineFor(null)} />}
      {settingsOpen && <SettingsDialog id={id} initial={d.settings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview (§32, §43)
// ---------------------------------------------------------------------------

function Metric({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "danger" | "success" }) {
  const color = tone === "danger" ? "text-destructive" : tone === "success" ? "text-success" : "";
  return (
    <div className="min-w-0 rounded-xl border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground-secondary">{title}</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{children}</div>
    </div>
  );
}

function Overview({ d }: { d: Data }) {
  const o = d.overview;
  const days = d.settings.thresholds.inactiveDays;
  return (
    <Panel>
      <div className="space-y-4">
        <p className="flex gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("sa.distinct")}
        </p>
        <Section title={t("sa.section.access")}>
          <Metric label={t("sa.m.students")} value={o.access.total} />
          <Metric label={t("sa.m.accessActive")} value={o.access.active} />
          <Metric label={t("sa.m.accessPending")} value={o.access.pending} />
          <Metric label={t("sa.m.accessEnded")} value={o.access.ended} />
        </Section>
        <Section title={t("sa.section.progress")}>
          <Metric label={t("sa.m.enrolled")} value={o.progress.enrolled} />
          <Metric label={t("sa.m.avgProgress")} value={pctText(o.progress.avgProgressPct)} />
          <Metric label={t("sa.m.lessonCompletion")} value={pctText(o.progress.lessonCompletionPct)} />
          <Metric label={t("sa.m.active", { days })} value={o.progress.active} />
          <Metric label={t("sa.m.inactive")} value={o.progress.inactive} tone={o.progress.inactive ? "danger" : undefined} />
          <Metric label={t("sa.m.progressing")} value={o.progress.progressing} tone="success" />
          <Metric label={t("sa.m.stuck")} value={o.progress.stuck} />
          <Metric label={t("sa.m.atRisk")} value={o.atRisk} tone={o.atRisk ? "danger" : undefined} />
        </Section>
        <Section title={t("sa.section.completion")}>
          <Metric label={t("sa.m.completed")} value={o.completion.completed} />
          <Metric label={t("sa.m.completionRate")} value={pctText(o.completion.completionRatePct)} sub={o.completion.completionRatePct === null ? undefined : t("sa.m.ofEnrolled", { pct: Math.round(o.completion.completionRatePct) })} />
        </Section>
        <Section title={t("sa.section.mastery")}>
          <Metric label={t("sa.m.avgScore")} value={pctText(o.mastery.avgAssessmentPct)} />
          <Metric label={t("sa.m.passRate")} value={pctText(o.mastery.passRatePct)} />
          <Metric label={t("sa.m.assessed")} value={o.mastery.assessedStudents} />
        </Section>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Insights (§40) and funnel (§38)
// ---------------------------------------------------------------------------

const SEVERITY_TONE: Record<number, string> = { 1: "border-destructive/40 bg-danger-surface", 2: "border-warning/40 bg-warning-surface", 3: "border-border bg-muted" };

function Insights({ d }: { d: Data }) {
  return (
    <Panel title={t("sa.insights")}>
      {!d.insights.length ? (
        <p className="text-sm text-muted-foreground">{t("sa.insights.none")}</p>
      ) : (
        <ul className="space-y-2">
          {d.insights.map((i, n) => (
            <li key={`${i.code}-${n}`} className={`flex gap-2 rounded-xl border p-3 text-sm ${SEVERITY_TONE[i.severity]}`}>
              {i.severity === 1 ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden /> : <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-foreground-secondary" aria-hidden />}
              <span className="min-w-0 break-words">{t(`sa.insight.${i.code}`, i.params)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Funnel({ d }: { d: Data }) {
  const data = d.funnel.map((f) => ({ label: t(`sa.funnel.${f.stage}`), count: f.count, pct: f.pct }));
  const summary = data.map((f) => `${f.label}: ${f.count}`).join(", ");
  return (
    <Panel title={t("sa.funnel")}>
      <p className="mb-3 text-xs text-muted-foreground">{t("sa.funnel.help")}</p>
      <figure style={{ height: data.length * 34 + 20 }} role="img" aria-label={`${t("sa.funnel")}. ${summary}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 40 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--chart-grid)" />
            <XAxis type="number" allowDecimals={false} {...AXIS} />
            <YAxis type="category" dataKey="label" width={150} {...AXIS} />
            <Tooltip {...TOOLTIP} formatter={(v: number, _n, p) => [`${v} (${pctText((p.payload as { pct: number | null }).pct)})`, t("sa.chart.students")]} />
            <Bar dataKey="count" name={t("sa.chart.students")} fill="var(--chart-1)" radius={[0, 6, 6, 0]} label={{ position: "right", fontSize: 11, fill: "var(--muted-foreground)" }} />
          </BarChart>
        </ResponsiveContainer>
      </figure>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Students (§33): sortable, filterable, at-risk reasons, activity timeline
// ---------------------------------------------------------------------------

const FILTERS = ["all", "atRisk", "inactive", "notStarted", "progressing", "completed"] as const;
type Filter = (typeof FILTERS)[number];
const matches: Record<Filter, (r: StudentRow) => boolean> = {
  all: () => true,
  atRisk: (r) => r.atRisk,
  inactive: (r) => r.enrolled && !r.active && !r.completed,
  notStarted: (r) => !r.enrolled,
  progressing: (r) => r.progressing,
  completed: (r) => r.completed,
};

type SortKey = "name" | "progress" | "practice" | "assessment" | "lastActivity" | "risk";
const sortValue: Record<SortKey, (r: StudentRow) => number | string> = {
  name: (r) => r.name.toLocaleLowerCase(),
  progress: (r) => (r.enrolled ? r.progressPct : -1),
  practice: (r) => r.practice.pct ?? -1,
  assessment: (r) => r.assessment.avgPct ?? -1,
  lastActivity: (r) => r.lastActivityAt?.getTime() ?? 0,
  risk: (r) => (r.atRisk ? 1000 + r.reasons.length : 0),
};

function SortHeader({ k, label, sort, onSort, className = "" }: { k: SortKey; label: string; sort: { key: SortKey; dir: 1 | -1 }; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
  return (
    <th scope="col" className={`py-2 pr-3 ${className}`} aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-foreground" onClick={() => onSort(k)} aria-label={t("sa.sortBy", { column: label })}>
        {label}
        <Icon className="h-3 w-3" aria-hidden />
      </button>
    </th>
  );
}

function StudentTable({ rows, groupName, onTimeline }: { rows: StudentRow[]; groupName: Map<string, string>; onTimeline: (r: StudentRow) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "risk", dir: -1 });
  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 }));
  const sourceOf = (r: StudentRow) => {
    const groups = (r.via.groupIds.length ? r.via.groupIds : r.groupIds).map((g) => groupName.get(g) ?? "").filter(Boolean);
    return [...groups, ...(r.via.individual ? [t("syllabus.roster.individual")] : [])].join(", ");
  };
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const get = sortValue[sort.key];
    const hit = (r: StudentRow) => !needle || r.name.toLocaleLowerCase().includes(needle) || sourceOf(r).toLocaleLowerCase().includes(needle);
    return rows
      .filter((r) => matches[filter](r) && hit(r))
      .sort((a, b) => {
        const x = get(a);
        const y = get(b);
        const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
        return c * sort.dir || a.name.localeCompare(b.name);
      });
  }, [rows, filter, search, sort, groupName]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f, rows.filter(matches[f]).length])) as Record<Filter, number>, [rows]);

  return (
    <Panel title={t("sa.students")} id={STUDENTS_ID} className="scroll-mt-4">
      {!rows.length ? (
        <p className="text-sm text-muted-foreground">{t("sa.noStudents")}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              className="h-9 w-full sm:w-64"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("sa.search")}
              aria-label={t("sa.search")}
            />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("sa.filter")}>
              {FILTERS.map((f) => (
                <ChoiceChip key={f} selected={filter === f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {t(`sa.filter.${f}`)} ({counts[f]})
                </ChoiceChip>
              ))}
            </div>
          </div>
          {!visible.length ? (
            <p className="text-sm text-muted-foreground">{t("sa.noMatch")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <SortHeader k="name" label={t("sa.col.student")} sort={sort} onSort={onSort} />
                    <SortHeader k="progress" label={t("sa.col.progress")} sort={sort} onSort={onSort} />
                    <th scope="col" className="py-2 pr-3 uppercase">{t("sa.col.current")}</th>
                    <SortHeader k="practice" label={t("sa.col.practice")} sort={sort} onSort={onSort} />
                    <SortHeader k="assessment" label={t("sa.col.assessment")} sort={sort} onSort={onSort} />
                    <SortHeader k="lastActivity" label={t("sa.col.lastActivity")} sort={sort} onSort={onSort} />
                    <SortHeader k="risk" label={t("sa.col.risk")} sort={sort} onSort={onSort} />
                    <th scope="col"><span className="sr-only">{t("sa.activity")}</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visible.map((r) => (
                    <tr key={r.studentId} className="align-top">
                      <td className="py-2 pr-3">
                        <div className="break-words font-medium">{r.name}</div>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {r.access === "NONE" && <StatusBadge tone="neutral">{t("syllabus.roster.noAccess")}</StatusBadge>}
                          {r.access !== "NONE" && r.access !== "ACTIVE" && <GrantStateBadge state={r.access} />}
                          {r.completed && <StatusBadge tone="success">{t("sa.completedBadge")}</StatusBadge>}
                        </div>
                        {sourceOf(r) && <div className="text-xs text-muted-foreground">{sourceOf(r)}</div>}
                      </td>
                      <td className="py-2 pr-3">
                        {r.enrolled ? (
                          <div className="w-32 space-y-1">
                            <div className="flex items-center gap-2">
                              <ProgressBar value={r.progressPct} label={t("sa.col.progress")} />
                              <span className="shrink-0 text-xs tabular-nums">{Math.round(r.progressPct)}%</span>
                            </div>
                            <div className="text-xs text-muted-foreground">{t("learn.lessonsDone", { done: r.completedLessons, total: r.totalLessons })}</div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("sa.notStarted")}</span>
                        )}
                      </td>
                      <td className="max-w-48 py-2 pr-3">
                        <div className="line-clamp-2 break-words">{r.completed ? "—" : (r.currentLessonTitle ?? "—")}</div>
                        {r.currentModuleTitle && !r.completed && <div className="line-clamp-1 text-xs text-muted-foreground">{r.currentModuleTitle}</div>}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {r.practice.total ? (
                          <>
                            <div>{pctText(r.practice.pct)}</div>
                            <div className="text-xs text-muted-foreground">{r.practice.done}/{r.practice.total}</div>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        <div>{pctText(r.assessment.avgPct)}</div>
                        {r.assessment.attempted > 0 && <div className="text-xs text-muted-foreground">{r.assessment.passed}/{r.assessment.attempted}</div>}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {r.lastActivityAt ? <span title={fmtDateTime(r.lastActivityAt)}>{fmtRelative(r.lastActivityAt)}</span> : "—"}
                      </td>
                      <td className="max-w-56 py-2 pr-3">
                        {r.atRisk ? (
                          <div className="space-y-1">
                            <StatusBadge tone="danger">{t("sa.riskBadge")}</StatusBadge>
                            <ul className="text-xs text-destructive">
                              {r.reasons.map((x) => (
                                <li key={x.code}>{t(`sa.reason.${x.code}`, { value: x.value })}</li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {r.enrolled && (
                          <Button size="sm" variant="ghost" onClick={() => onTimeline(r)}>
                            {t("sa.activity")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Groups (§34), modules (§35), lessons (§36), practice (§37)
// ---------------------------------------------------------------------------

function Table({ head, children, minWidth = 640 }: { head: string[]; children: React.ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead className="text-left text-xs uppercase text-muted-foreground">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className="py-2 pr-3">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

function ChartBars({ data, bars, label }: { data: Array<Record<string, string | number | null>>; bars: Array<{ key: string; name: string; color: string }>; label: string }) {
  const summary = data.map((d) => `${d.label}: ${bars.map((b) => `${b.name} ${pctText(d[b.key] as number | null)}`).join(", ")}`).join("; ");
  return (
    <figure className="mb-4 h-56" role="img" aria-label={`${label}. ${summary}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" {...AXIS} interval={0} tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)} />
          <YAxis domain={[0, 100]} width={32} {...AXIS} />
          <Tooltip {...TOOLTIP} formatter={(v: number) => pctText(v)} />
          {bars.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {bars.map((b) => (
            <Bar key={b.key} dataKey={b.key} name={b.name} fill={b.color} radius={[6, 6, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

function Groups({ d }: { d: Data }) {
  if (!d.groups.length) return <Panel title={t("sa.groups")}><p className="text-sm text-muted-foreground">{t("sa.groups.empty")}</p></Panel>;
  return (
    <Panel title={t("sa.groups")}>
      {d.groups.length > 1 && (
        <ChartBars
          label={t("sa.groups")}
          data={d.groups.map((g) => ({ label: g.name, progress: g.avgProgressPct, score: g.avgScorePct }))}
          bars={[
            { key: "progress", name: t("sa.chart.progress"), color: "var(--chart-1)" },
            { key: "score", name: t("sa.chart.score"), color: "var(--chart-2)" },
          ]}
        />
      )}
      <Table head={[t("sa.col.group"), t("sa.col.students"), t("sa.col.avgProgress"), t("sa.col.avgScore"), t("sa.col.completed"), t("sa.col.atRisk"), t("sa.col.modules")]} minWidth={760}>
        {d.groups.map((g) => (
          <tr key={g.groupId} className="align-top">
            <td className="py-2 pr-3 font-medium">{g.name}</td>
            <td className="py-2 pr-3 tabular-nums">{g.students}</td>
            <td className="py-2 pr-3 tabular-nums">{pctText(g.avgProgressPct)}</td>
            <td className="py-2 pr-3 tabular-nums">{pctText(g.avgScorePct)}</td>
            <td className="py-2 pr-3 tabular-nums">{g.completed}/{g.students}</td>
            <td className={`py-2 pr-3 tabular-nums ${g.atRisk ? "font-semibold text-destructive" : ""}`}>{g.atRisk}</td>
            <td className="py-2 pr-3 text-xs text-muted-foreground">
              <ul className="space-y-0.5">
                {g.modules.map((m) => (
                  <li key={m.moduleId}>{t("sa.groups.moduleDone", { module: m.title, done: m.completed, of: m.of })}</li>
                ))}
              </ul>
            </td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}

function Modules({ d }: { d: Data }) {
  return (
    <Panel title={t("sa.modules")}>
      {!d.modules.length ? (
        <p className="text-sm text-muted-foreground">{t("sa.empty")}</p>
      ) : (
        <>
          {d.modules.length > 1 && (
            <ChartBars
              label={t("sa.modules")}
              data={d.modules.map((m) => ({ label: m.title, rate: m.completionRatePct, score: m.avgScorePct }))}
              bars={[
                { key: "rate", name: t("sa.chart.completion"), color: "var(--chart-1)" },
                { key: "score", name: t("sa.chart.score"), color: "var(--chart-2)" },
              ]}
            />
          )}
          <Table
            head={[t("sa.col.module"), t("sa.col.started"), t("sa.col.completed"), t("sa.col.rate"), t("sa.col.avgScore"), t("sa.col.avgTime"), t("sa.col.practicePct"), t("sa.col.passRate"), t("sa.col.retryRate")]}
            minWidth={820}
          >
            {d.modules.map((m) => (
              <tr key={m.moduleId}>
                <td className="max-w-56 py-2 pr-3 font-medium"><span className="line-clamp-2 break-words">{m.title}</span></td>
                <td className="py-2 pr-3 tabular-nums">{m.started}</td>
                <td className="py-2 pr-3 tabular-nums">{m.completed}</td>
                <td className="py-2 pr-3 tabular-nums">{pctText(m.completionRatePct)}</td>
                <td className="py-2 pr-3 tabular-nums">{pctText(m.avgScorePct)}</td>
                <td className="py-2 pr-3 tabular-nums">{timeText(m.avgTimeToCompleteSeconds)}</td>
                <td className="py-2 pr-3 tabular-nums">{pctText(m.practiceCompletionPct)}</td>
                <td className="py-2 pr-3 tabular-nums">{pctText(m.passRatePct)}</td>
                <td className="py-2 pr-3 tabular-nums">{pctText(m.retryRatePct)}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-xs text-muted-foreground">{t("sa.timeHelp")}</p>
        </>
      )}
    </Panel>
  );
}

function Lessons({ d }: { d: Data }) {
  const moduleTitle = new Map(d.modules.map((m) => [m.moduleId, m.title]));
  return (
    <Panel title={t("sa.lessons")}>
      {!d.lessons.length ? (
        <p className="text-sm text-muted-foreground">{t("sa.empty")}</p>
      ) : (
        <Table
          head={[t("sa.col.lesson"), t("sa.col.opened"), t("sa.col.completed"), t("sa.col.rate"), t("sa.col.practicePct"), t("sa.col.avgScore"), t("sa.col.avgAttempts"), t("sa.col.avgTime")]}
          minWidth={780}
        >
          {d.lessons.map((l) => (
            <tr key={l.lessonId}>
              <td className="max-w-64 py-2 pr-3">
                <div className="line-clamp-2 break-words font-medium">{l.title}</div>
                <div className="line-clamp-1 text-xs text-muted-foreground">{moduleTitle.get(l.moduleId) ?? ""}</div>
              </td>
              <td className="py-2 pr-3 tabular-nums">{l.opened}</td>
              <td className="py-2 pr-3 tabular-nums">{l.completed}</td>
              <td className={`py-2 pr-3 tabular-nums ${l.completionRatePct !== null && l.opened >= 3 && l.completionRatePct < 50 ? "font-semibold text-destructive" : ""}`}>{pctText(l.completionRatePct)}</td>
              <td className="py-2 pr-3 tabular-nums">{pctText(l.practiceCompletionPct)}</td>
              <td className="py-2 pr-3 tabular-nums">{pctText(l.avgScorePct)}</td>
              <td className="py-2 pr-3 tabular-nums">{numText(l.avgAttempts)}</td>
              <td className="py-2 pr-3 tabular-nums">{timeText(l.avgActiveSeconds)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function rateCell(n: number, pct: number | null) {
  return (
    <>
      {n} <span className="text-xs text-muted-foreground">({pctText(pct)})</span>
    </>
  );
}

function Practice({ d }: { d: Data }) {
  return (
    <Panel title={t("sa.practice")}>
      {!d.practice.length ? (
        <p className="text-sm text-muted-foreground">{t("sa.empty")}</p>
      ) : (
        <Table
          head={[t("sa.col.task"), t("sa.col.reached"), t("sa.col.opened"), t("sa.col.started"), t("sa.col.submitted"), t("sa.col.completed"), t("sa.col.avgScore"), t("sa.col.avgAttempts"), t("sa.col.avgTime"), t("sa.col.needsHelp")]}
          minWidth={980}
        >
          {d.practice.map((p) => (
            <tr key={p.itemId}>
              <td className="max-w-64 py-2 pr-3">
                <div className="line-clamp-2 break-words font-medium">{p.title}</div>
                <div className="line-clamp-1 text-xs text-muted-foreground">{p.lessonTitle}</div>
              </td>
              <td className="py-2 pr-3 tabular-nums">{p.reached}</td>
              <td className="py-2 pr-3 tabular-nums">{rateCell(p.opened, p.openRatePct)}</td>
              <td className="py-2 pr-3 tabular-nums">{rateCell(p.started, p.startRatePct)}</td>
              <td className="py-2 pr-3 tabular-nums">{rateCell(p.submitted, p.submitRatePct)}</td>
              <td className="py-2 pr-3 tabular-nums">{rateCell(p.completed, p.completionRatePct)}</td>
              <td className="py-2 pr-3 tabular-nums">{pctText(p.avgScorePct)}</td>
              <td className="py-2 pr-3 tabular-nums">{numText(p.avgAttempts)}</td>
              <td className="py-2 pr-3 tabular-nums">{timeText(p.avgTimeToSubmitSeconds)}</td>
              <td className={`py-2 pr-3 tabular-nums ${p.needsHelp ? "font-semibold text-warning" : ""}`}>{p.needsHelp}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Activity timeline (§30, §31)
// ---------------------------------------------------------------------------

function TimelineDialog({ id, row, onClose }: { id: string; row: StudentRow; onClose: () => void }) {
  const q = trpc.teacher.syllabus.analyticsTimeline.useQuery({ id, studentId: row.studentId });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-words">{t("sa.timeline.title", { name: row.name })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {q.error ? <ErrorNote error={q.error} /> : !q.data ? <Loading /> : <ActivityTimeline events={q.data} />}
        </DialogBody>
        <p className="text-xs text-muted-foreground">{t("sa.timeline.note")}</p>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Risk rules + digest (§39)
// ---------------------------------------------------------------------------

const THRESHOLD_KEYS = Object.keys(RISK_THRESHOLD_LIMITS) as RiskThresholdKey[];

function SettingsDialog({ id, initial, onClose }: { id: string; initial: AnalyticsSettings; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<Record<RiskThresholdKey, string>>(() => Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, String(initial.thresholds[k])])) as Record<RiskThresholdKey, string>);
  const [digest, setDigest] = useState(initial.digestEnabled);
  const save = trpc.teacher.syllabus.saveAnalyticsSettings.useMutation({
    onSuccess: () => {
      toast.success(t("sa.settings.saved"));
      void utils.teacher.syllabus.analytics.invalidate();
      void utils.teacher.syllabus.analyticsSettings.invalidate({ id });
      onClose();
    },
    onError: toastError,
  });
  const parsed = Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, Number(draft[k])])) as Record<RiskThresholdKey, number>;
  const invalid = THRESHOLD_KEYS.filter((k) => !Number.isInteger(parsed[k]) || parsed[k] < RISK_THRESHOLD_LIMITS[k].min || parsed[k] > RISK_THRESHOLD_LIMITS[k].max);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("sa.settings.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-sm text-foreground-secondary">{t("sa.settings.help")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {THRESHOLD_KEYS.map((k) => {
              const bad = invalid.includes(k);
              return (
                <label key={k} className="space-y-1 text-sm">
                  <span className={fieldLabel}>{t(`sa.th.${k}`)}</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={RISK_THRESHOLD_LIMITS[k].min}
                    max={RISK_THRESHOLD_LIMITS[k].max}
                    value={draft[k]}
                    aria-invalid={bad}
                    onChange={(e) => setDraft((s) => ({ ...s, [k]: e.target.value }))}
                  />
                  <span className={`text-xs ${bad ? "text-destructive" : "text-muted-foreground"}`}>{t("sa.th.range", RISK_THRESHOLD_LIMITS[k])}</span>
                </label>
              );
            })}
          </div>
          <SettingToggle
            id="sa-digest"
            label={t("sa.settings.digest")}
            hint={t("sa.settings.digestHelp")}
            checked={digest}
            onCheckedChange={setDigest}
          />
        </DialogBody>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => setDraft(Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, String(DEFAULT_RISK_THRESHOLDS[k])])) as Record<RiskThresholdKey, string>)}>
            {t("sa.settings.reset")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
            <Button disabled={invalid.length > 0 || save.isPending} onClick={() => save.mutate({ id, settings: { thresholds: parsed, digestEnabled: digest } })}>
              {t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
