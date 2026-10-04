import { AppShell, EmptyState, ErrorNote, Loading, Pill } from "@/components/AppShell";
import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { StudentWorkflow } from "@/components/syllabus/Workflow";
import { Button } from "@/components/ui/button";
import { t, type MessageKey } from "@/i18n/messages";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fileDownloadUrl } from "@/lib/uploadFile";
import { BookOpen, Trophy } from "lucide-react";
import { Link } from "wouter";
import { lessonPath, ProgressBar, syllabusPath } from "./common";

type Card = RouterOutputs["student"]["syllabus"]["list"][number];

const ACCESS_TONE: Record<string, Tone> = { ACTIVE: "info", PENDING: "warning", EXPIRED: "neutral", REVOKED: "danger" };

function AccessBadge({ card }: { card: Card }) {
  if (card.progress?.completed) return <StatusBadge tone="success" icon={Trophy}>{t("learn.completed")}</StatusBadge>;
  if (card.access === "ACTIVE") return null;
  return <StatusBadge tone={ACCESS_TONE[card.access] ?? "neutral"}>{t(`learn.access.${card.access}` as MessageKey)}</StatusBadge>;
}

function SyllabusCard({ card }: { card: Card }) {
  const p = card.progress;
  const target = card.access === "ACTIVE" && p?.currentLessonId && !p.completed ? lessonPath(card.id, p.currentLessonId) : syllabusPath(card.id);
  const action = card.access === "PENDING" ? null : card.access !== "ACTIVE" ? t("learn.viewProgress") : !p ? t("learn.start") : p.completed ? t("learn.review") : t("learn.continue");
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      {card.coverFileId ? (
        <img src={fileDownloadUrl(card.coverFileId)} alt="" className="aspect-[16/7] w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex aspect-[16/7] w-full items-center justify-center bg-muted">
          <BookOpen className="h-8 w-8 text-muted-foreground" aria-hidden />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="min-w-0 break-words font-semibold">{card.title}</h2>
          <AccessBadge card={card} />
        </div>
        {(card.subject || card.level) && (
          <div className="flex flex-wrap gap-1.5">
            {card.subject && <Pill>{card.subject}</Pill>}
            {card.level && <Pill>{card.level}</Pill>}
          </div>
        )}
        {card.access === "PENDING" && card.startsAt && <p className="text-sm text-foreground-secondary">{t("learn.startsAt", { at: fmtDateTime(card.startsAt) })}</p>}
        {p && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground-secondary">{t("learn.lessonsDone", { done: p.completedLessons, total: p.totalLessons })}</span>
              <span className="font-semibold">{p.progressPct}%</span>
            </div>
            <ProgressBar value={p.progressPct} label={t("learn.overallProgress")} />
            {p.lastActivityAt && <p className="text-xs text-muted-foreground">{t("learn.lastActivity", { when: fmtRelative(p.lastActivityAt) })}</p>}
          </div>
        )}
        {card.access === "EXPIRED" || card.access === "REVOKED" ? <p className="text-xs text-muted-foreground">{t("learn.endedHint")}</p> : null}
        {action && (
          <div className="mt-auto pt-1">
            <Button asChild size="sm" variant={card.access === "ACTIVE" ? "default" : "outline"} className="w-full sm:w-auto">
              <Link href={target}>{action}</Link>
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}

export function MySyllabi() {
  const list = trpc.student.syllabus.list.useQuery();
  return (
    <AppShell area="learning">
      <div className="space-y-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl">{t("nav.mySyllabi")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("learn.listIntro")}</p>
        </div>
        {list.error ? (
          <ErrorNote error={list.error} />
        ) : !list.data ? (
          <Loading />
        ) : !list.data.length ? (
          <>
            <EmptyState title={t("learn.emptyTitle")} body={t("learn.emptyBody")} />
            <StudentWorkflow dismissible={false} />
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.data.map((card) => (
              <SyllabusCard key={card.id} card={card} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
