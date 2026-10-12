import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Link, useParams } from "wouter";
import { CoachShell } from "./CoachShell";
import { LearnTab } from "./LearnTab";
import { pagesLabel } from "./CoachMaterial";
import { PracticeTab } from "./PracticeTab";
import { AskTab } from "./AskTab";

export const TOPIC_TABS = ["learn", "practice", "ask"] as const;
export type TopicTab = (typeof TOPIC_TABS)[number];

const initialTab = (): TopicTab => {
  const q = new URLSearchParams(window.location.search).get("tab");
  return (TOPIC_TABS as readonly string[]).includes(q ?? "") ? (q as TopicTab) : "learn";
};

/** "/student/coach/t/:topicId": one topic — learn, practise, ask. */
export function CoachTopicPage() {
  const { topicId } = useParams<{ topicId: string }>();
  return (
    <CoachShell title={t("nav.coach")} back="/student/coach">
      {() => <TopicBody topicId={topicId} />}
    </CoachShell>
  );
}

function TopicBody({ topicId }: { topicId: string }) {
  const q = trpc.student.coach.learn.topic.useQuery({ topicId });
  const [tab, setTab] = useState<TopicTab>(initialTab);
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const { topic, material, prev, next } = q.data;
  return (
    <>
      <Panel>
        <Link href={`/student/coach/m/${material.id}`} className="text-sm text-link hover:underline">
          {material.title}
        </Link>
        <h2 className="mt-1 break-words text-xl font-semibold">{topic.title}</h2>
        <p className="text-xs text-muted-foreground">{pagesLabel(topic.pageFrom, topic.pageTo)}</p>
        <div role="tablist" aria-label={topic.title} className="mt-4 flex gap-1 overflow-x-auto">
          {TOPIC_TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${tab === k ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:text-foreground"}`}
            >
              {t(`coach.tab.${k}`)}
            </button>
          ))}
        </div>
      </Panel>
      {tab === "learn" && <LearnTab topicId={topic.id} />}
      {tab === "practice" && <PracticeTab key={topic.id} topicId={topic.id} onLearn={() => setTab("learn")} />}
      {tab === "ask" && <AskTab key={topic.id} topicId={topic.id} />}
      <nav className="flex flex-wrap justify-between gap-2 text-sm" aria-label={t("coach.topic.nav")}>
        {prev ? (
          <Link href={`/student/coach/t/${prev.id}`} className="text-link hover:underline">
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link href={`/student/coach/t/${next.id}`} className="text-link hover:underline">
            {next.title} →
          </Link>
        )}
      </nav>
    </>
  );
}
