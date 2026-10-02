import { DistributionChart, QuestionStatsTable } from "@/components/AnalyticsBlocks";
import { StatCard } from "@/components/AppShell";
import { t } from "@/i18n/messages";
import { DEMO } from "./demoData";

/**
 * Section 4 preview: the real analytics components (DistributionChart and QuestionStatsTable,
 * both from AnalyticsBlocks.tsx — the same ones the teacher Analytics page renders) fed demo
 * rows instead of a live query. Full width, so this is the one preview big enough to show the
 * chart at its real size rather than the hero's compact bars.
 */
export function AnalyticsPreview() {
  const topic = t("landing.preview.topicName");
  const rows = [
    {
      questionId: "demo-7",
      position: DEMO.mostMissedQuestionNumber,
      text: t("landing.preview.sampleQuestion"),
      type: "NUMERIC",
      topic,
      attempts: DEMO.completedCount,
      accuracyPercentage: DEMO.weakTopicAccuracy,
      wrongPercentage: 54,
      unansweredPercentage: 4,
    },
    {
      questionId: "demo-3",
      position: 3,
      text: t("landing.preview.examTitle"),
      type: "MULTIPLE_CHOICE",
      topic,
      attempts: DEMO.completedCount,
      accuracyPercentage: 88,
      wrongPercentage: 12,
      unansweredPercentage: 0,
    },
  ];

  return (
    <div role="img" aria-label={t("landing.preview.analyticsSummary")} className="p-4 text-left sm:p-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label={t("common.median")} value={`${DEMO.medianScore}%`} />
        <StatCard
          label={t("landing.preview.mostMissedQuestion")}
          value={t("landing.preview.questionN", { n: DEMO.mostMissedQuestionNumber })}
        />
        <StatCard label={t("landing.preview.topicResult")} value={`${topic} · ${DEMO.weakTopicAccuracy}%`} />
      </div>
      <div className="mt-4 rounded-2xl border border-border bg-card p-4">
        <DistributionChart data={[...DEMO.scoreDistribution]} />
      </div>
      <div className="mt-4 rounded-2xl border border-border bg-card p-4">
        <QuestionStatsTable rows={rows} />
      </div>
    </div>
  );
}
