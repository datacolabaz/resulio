import { t, type MessageKey } from "@/i18n/messages";
import { lockTarget, type LockReason, type NodeVisual } from "@/lib/syllabusLearn";
import { CheckCircle2, Circle, CircleDot, Hourglass, Lock, type LucideIcon } from "lucide-react";

const ICON: Record<NodeVisual, LucideIcon> = { done: CheckCircle2, current: CircleDot, open: Circle, waiting: Hourglass, locked: Lock };
const ICON_CLASS: Record<NodeVisual, string> = {
  done: "text-success",
  current: "text-primary",
  open: "text-muted-foreground",
  waiting: "text-warning",
  locked: "text-muted-foreground",
};

/** Status shape + a screen-reader label: never colour alone. */
export function NodeIcon({ visual, className = "h-5 w-5" }: { visual: NodeVisual; className?: string }) {
  const Icon = ICON[visual];
  return (
    <span className="inline-flex shrink-0">
      <Icon className={`${className} ${ICON_CLASS[visual]}`} aria-hidden />
      <span className="sr-only">{t(`learn.visual.${visual}` as MessageKey)}</span>
    </span>
  );
}

export function ProgressBar({ value, label, className = "" }: { value: number; label: string; className?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label} className={`h-2 w-full overflow-hidden rounded-full bg-muted ${className}`}>
      <div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${v}%` }} />
    </div>
  );
}

export const statusText = (status: string) => t(`learn.status.${status}` as MessageKey);

interface PathShape {
  modules: ReadonlyArray<{ id: string; lessons: ReadonlyArray<{ id: string }> }>;
}

/** "Complete first: Lesson 4 · «Loops»" — names of locked nodes are visible, their content is not. */
export function lockText(reason: LockReason | null | undefined, path: PathShape): string | null {
  const target = lockTarget(reason, path);
  if (!reason || !target) return null;
  if (target.kind === "all") return t("learn.lock.all");
  if (reason.code === "MODULE_LESSONS") return t("learn.lock.moduleLessons");
  if (target.kind === "lesson") return t("learn.lock.lesson", { n: target.n, title: target.title });
  return t("learn.lock.module", { n: target.n, title: target.title });
}

export const lessonPath = (syllabusId: string, lessonId: string) => `/student/syllabus/${syllabusId}/lessons/${lessonId}`;
export const syllabusPath = (syllabusId: string) => `/student/syllabus/${syllabusId}`;
export const sessionPath = (attemptId: string, returnTo: string) => `/student/sessions/${attemptId}?returnTo=${encodeURIComponent(returnTo)}`;
