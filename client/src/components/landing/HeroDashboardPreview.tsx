import { StatCard } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { StatusBadge } from "@/components/StatusBadge";
import { buttonVariants } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { ClipboardList, LayoutDashboard, ListChecks, Plus, Settings, Users } from "lucide-react";
import { DEMO } from "./demoData";

/** Same five destinations as the real teacher sidebar (AppShell's TEACHER_NAV), trimmed to fit a compact preview. */
const NAV_ITEMS = [
  { key: "nav.home" as const, icon: LayoutDashboard, active: true },
  { key: "nav.groups" as const, icon: Users },
  { key: "nav.exams" as const, icon: ClipboardList },
  { key: "nav.results" as const, icon: ListChecks },
  { key: "nav.settings" as const, icon: Settings },
];

const MAX_BUCKET = Math.max(...DEMO.scoreDistribution.map((b) => b.count));

/**
 * The hero's right-hand preview: a cut-down version of the real teacher dashboard (AppShell +
 * TeacherHome), filled with fictional demo data and nothing wired to a backend. Everything here
 * is plain div/span — never a real <button> or <a> — so nothing in this non-operable mockup is
 * reachable by keyboard; the whole block instead exposes one accessible summary. See DemoNote
 * for the disclosure rendered under the preview, and shared/assessment's 24/26-style numbers in
 * demoData.ts for what the figures mean.
 */
export function HeroDashboardPreview() {
  return (
    <div role="img" aria-label={t("landing.hero.previewSummary")} className="flex text-left">
      <div aria-hidden className="hidden w-14 shrink-0 flex-col items-center gap-4 border-r border-sidebar-border bg-sidebar py-4 sm:flex">
        <BrandMark size={28} className="rounded-lg" />
        {NAV_ITEMS.map(({ key, icon: Icon, active }) => (
          <span
            key={key}
            className={`flex h-9 w-9 items-center justify-center rounded-xl ${active ? "bg-sidebar-accent text-sidebar-primary" : "text-sidebar-foreground"}`}
          >
            <Icon className="h-4 w-4" />
          </span>
        ))}
      </div>
      <div aria-hidden className="min-w-0 flex-1 space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-semibold">{t("landing.preview.greeting", { name: t("landing.preview.teacherName") })}</p>
          <span className={buttonVariants({ size: "sm", className: "pointer-events-none" })}>
            <Plus className="h-3.5 w-3.5" /> {t("nav.newExam")}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <StatCard label={t("home.activeGroups")} value={DEMO.activeGroups} />
          <StatCard label={t("landing.preview.activeExams")} value={DEMO.activeExams} />
          <StatCard label={t("landing.preview.completedThisWeek")} value={DEMO.completedThisWeek} />
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-semibold">{t("landing.preview.examTitle")}</p>
              <p className="truncate text-xs text-muted-foreground">{t("landing.preview.groupName")}</p>
            </div>
            <StatusBadge tone="success">{t("landing.preview.resultsReady")}</StatusBadge>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {t("landing.preview.studentsCompleted", { completed: DEMO.completedCount, total: DEMO.studentCount })}
          </p>
          <span className={buttonVariants({ variant: "outline", size: "sm", className: "pointer-events-none mt-3" })}>
            {t("landing.preview.viewResults")}
          </span>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("common.median")}</p>
              <p className="font-[family-name:var(--font-display)] text-2xl">{DEMO.medianScore}%</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("landing.preview.mostMissedQuestion")}</p>
              <p className="font-[family-name:var(--font-display)] text-2xl">{t("landing.preview.questionN", { n: DEMO.mostMissedQuestionNumber })}</p>
            </div>
          </div>
          <div className="mt-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("landing.preview.topicResult")}</p>
            <p className="font-[family-name:var(--font-display)] text-base leading-snug sm:text-lg">
              {t("landing.preview.topicName")} · {DEMO.weakTopicAccuracy}%
            </p>
          </div>
          {/* A compact read of the same score distribution the full analytics section charts at full size (DistributionChart there) — real analytic shape, not decoration: the bulk of the class sits at 70-80%. */}
          <div className="mt-3 flex h-12 items-end gap-1.5">
            {DEMO.scoreDistribution.map((bucket) => (
              <span
                key={bucket.from}
                className="flex-1 rounded-t bg-chart-1"
                style={{ height: `${Math.max(12, (bucket.count / MAX_BUCKET) * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-3 rounded-xl bg-info-surface p-3 text-xs text-info">
            <span className="font-semibold">{t("landing.preview.insightLabel")}:</span> {t("landing.preview.insight")}
          </div>
        </div>
      </div>
    </div>
  );
}
