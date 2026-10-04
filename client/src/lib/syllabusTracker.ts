import { MAX_ACTIVITY_BATCH, VIDEO_PROGRESS_MARKS, type ClientActivityType } from "@shared/syllabus";

/**
 * Client side of learning-activity tracking (spec §29). Events are queued, de-duplicated and sent in
 * batches so the server's rate limit (60 requests/min per student) is never approached: one batch
 * every FLUSH_MS at most, sooner only when a batch is full or the page is being hidden.
 */

export interface ActivityEvent {
  type: ClientActivityType;
  moduleId?: string;
  lessonId?: string;
  itemId?: string;
  durationSeconds?: number;
  metadata?: Record<string, string | number | boolean>;
}

export const FLUSH_MS = 10_000;
export const HEARTBEAT_MS = 30_000;
/** No input for this long = the student is away; heartbeats pause. */
export const IDLE_MS = 90_000;
const QUEUE_MAX = 200;

/** "Opened" events repeat on every render/visit; one per node per page session is enough. */
const ONCE_TYPES: ReadonlySet<ClientActivityType> = new Set([
  "SYLLABUS_OPENED",
  "MODULE_OPENED",
  "LESSON_OPENED",
  "THEORY_OPENED",
  "VIDEO_OPENED",
  "VIDEO_STARTED",
  "VIDEO_COMPLETED",
  "TEACHER_PRACTICE_OPENED",
  "PRACTICE_OPENED",
  "PRACTICE_STARTED",
  "ASSESSMENT_OPENED",
]);

const eventKey = (e: ActivityEvent) =>
  `${e.type}:${e.moduleId ?? ""}:${e.lessonId ?? ""}:${e.itemId ?? ""}:${e.metadata?.blockIndex ?? ""}:${e.type === "VIDEO_PROGRESS" ? (e.metadata?.pct ?? "") : ""}`;

export class ActivityQueue {
  private queue: ActivityEvent[] = [];
  private seen = new Set<string>();

  /** Returns false when the event was dropped as a repeat. */
  push(e: ActivityEvent): boolean {
    const key = eventKey(e);
    if ((ONCE_TYPES.has(e.type) || e.type === "VIDEO_PROGRESS") && this.seen.has(key)) return false;
    if (e.type !== "HEARTBEAT") this.seen.add(key);
    if (e.type === "HEARTBEAT") {
      const prev = this.queue.find((q) => q.type === "HEARTBEAT" && q.lessonId === e.lessonId);
      if (prev) {
        prev.durationSeconds = (prev.durationSeconds ?? 0) + (e.durationSeconds ?? 0);
        return true;
      }
    }
    this.queue.push({ ...e });
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX);
    return true;
  }

  get size() {
    return this.queue.length;
  }

  get full() {
    return this.queue.length >= MAX_ACTIVITY_BATCH;
  }

  /** Takes up to one server batch off the queue. */
  take(): ActivityEvent[] {
    return this.queue.splice(0, MAX_ACTIVITY_BATCH);
  }

  /** A failed send goes back to the front (it was already de-duplicated). */
  restore(batch: ActivityEvent[]) {
    this.queue.unshift(...batch);
    if (this.queue.length > QUEUE_MAX) this.queue.length = QUEUE_MAX;
  }
}

/** Progress marks newly passed when playback moves from `prevPct` to `pct` (25/50/75 only, each once). */
export function crossedMarks(prevPct: number, pct: number): number[] {
  return VIDEO_PROGRESS_MARKS.filter((m) => prevPct < m && pct >= m);
}

/** 95% counts as finished: players often stop a second short of the end. */
export const VIDEO_DONE_PCT = 95;
