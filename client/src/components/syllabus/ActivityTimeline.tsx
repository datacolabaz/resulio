import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { t, type MessageKey } from "@/i18n/messages";
import { fmtDateTime, fmtDuration } from "@/lib/format";
import type { RouterOutputs } from "@/lib/trpc";
import { LEARNING_ACTIVITY_TYPES } from "@shared/syllabus";

export type TimelineEvent = RouterOutputs["teacher"]["syllabus"]["analyticsTimeline"][number];

const EVENT_TYPES: readonly string[] = LEARNING_ACTIVITY_TYPES.filter((x) => x !== "HEARTBEAT");
export const eventLabel = (type: string) => t(EVENT_TYPES.includes(type) ? (`sa.ev.${type}` as MessageKey) : "sa.ev.OTHER");

const EVENT_TONE: Record<string, Tone> = {
  ASSESSMENT_PASSED: "success",
  ASSESSMENT_FAILED: "danger",
  LESSON_COMPLETED: "success",
  MODULE_COMPLETED: "success",
  SYLLABUS_COMPLETED: "success",
  PRACTICE_SUBMITTED: "info",
  PRACTICE_RESUBMITTED: "info",
  MANUAL_UNLOCK: "warning",
  ACCESS_REVOKED: "warning",
};

/** Newest first; one learning event per row with where it happened (§30, §31). */
export function ActivityTimeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <p className="text-sm text-muted-foreground">{t("sa.timeline.empty")}</p>;
  return (
    <ol className="space-y-2">
      {events.map((e) => {
        const where = [e.module, e.lesson, e.item].filter(Boolean).join(" · ");
        const tone = EVENT_TONE[e.type];
        return (
          <li key={e.id} className="flex gap-3 rounded-lg border border-border p-2.5 text-sm">
            <time className="w-28 shrink-0 text-xs text-muted-foreground" dateTime={e.at.toISOString()}>{fmtDateTime(e.at)}</time>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {tone ? <StatusBadge tone={tone}>{eventLabel(e.type)}</StatusBadge> : <span className="font-medium">{eventLabel(e.type)}</span>}
                {e.pct !== null && <span className="text-xs tabular-nums">{t("sa.timeline.score", { pct: e.pct })}</span>}
                {e.durationSeconds ? <span className="text-xs text-muted-foreground">{t("sa.timeline.duration", { time: fmtDuration(e.durationSeconds) })}</span> : null}
              </div>
              {where && <div className="break-words text-xs text-muted-foreground">{where}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
