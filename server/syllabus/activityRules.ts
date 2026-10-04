import { z } from "zod";
import {
  CLIENT_ACTIVITY_TYPES,
  MAX_ACTIVITY_BATCH,
  MAX_ACTIVITY_DURATION_SECONDS,
  MAX_HEARTBEAT_SECONDS,
  VIDEO_PROGRESS_MARKS,
  type ClientActivityType,
  type SyllabusItemKind,
} from "../../shared/syllabus";
import { locateItem, locateLesson } from "./engine";
import type { VersionStructure } from "./types";

const ref = z.string().trim().min(1).max(32);

/** Wire format of one client-reported event. Unknown types are rejected per event, not per batch. */
export const clientActivityEventSchema = z.object({
  type: z.string().trim().min(1).max(40),
  moduleId: ref.optional(),
  lessonId: ref.optional(),
  itemId: ref.optional(),
  durationSeconds: z.number().finite().optional(),
  metadata: z.record(z.string().max(40), z.union([z.string().max(200), z.number().finite(), z.boolean()])).optional(),
});
export const clientActivityBatchSchema = z.array(clientActivityEventSchema).min(1).max(MAX_ACTIVITY_BATCH);
export type ClientActivityEvent = z.infer<typeof clientActivityEventSchema>;

export type ActivityRejection = "TYPE_NOT_ALLOWED" | "UNKNOWN_NODE" | "LOCKED" | "KIND_MISMATCH" | "INVALID_METADATA";

export interface AcceptedActivity {
  type: ClientActivityType;
  moduleId: string | null;
  lessonId: string | null;
  itemId: string | null;
  durationSeconds: number | null;
  metadata: Record<string, string | number | boolean> | null;
}

export interface ActivityContext {
  structure: VersionStructure;
  /** Lessons the student may open now (status not LOCKED). */
  openLessons: ReadonlySet<string>;
  /** Module/final items the student may open now. */
  openScopedItems: ReadonlySet<string>;
}

const ITEM_KIND_FOR: Partial<Record<ClientActivityType, SyllabusItemKind>> = {
  THEORY_OPENED: "THEORY",
  VIDEO_OPENED: "THEORY",
  VIDEO_STARTED: "THEORY",
  VIDEO_PROGRESS: "THEORY",
  VIDEO_COMPLETED: "THEORY",
  TEACHER_PRACTICE_OPENED: "TEACHER_PRACTICE",
  PRACTICE_OPENED: "STUDENT_PRACTICE",
  PRACTICE_STARTED: "STUDENT_PRACTICE",
  ASSESSMENT_OPENED: "ASSESSMENT",
};

const VIDEO_META_KEYS = new Set(["pct", "blockIndex"]);

const isClientType = (t: string): t is ClientActivityType => (CLIENT_ACTIVITY_TYPES as readonly string[]).includes(t);

function clampDuration(raw: number | undefined, max: number): number | null {
  if (raw === undefined) return null;
  return Math.max(0, Math.min(max, Math.round(raw)));
}

/**
 * Validates client events against the student's pinned version and current locks. Ids are taken
 * from the structure (never trusted from the client), outcome types are server-only, and locked
 * content cannot be "opened".
 */
export function validateActivity(events: readonly ClientActivityEvent[], ctx: ActivityContext) {
  const accepted: AcceptedActivity[] = [];
  const rejected: Array<{ index: number; reason: ActivityRejection }> = [];
  events.forEach((e, index) => {
    const reject = (reason: ActivityRejection) => rejected.push({ index, reason });
    if (!isClientType(e.type)) return reject("TYPE_NOT_ALLOWED");
    const type = e.type;
    let moduleId: string | null = null;
    let lessonId: string | null = null;
    let itemId: string | null = null;

    if (type === "SYLLABUS_OPENED") {
      // no node
    } else if (type === "MODULE_OPENED") {
      if (!e.moduleId || !ctx.structure.modules.some((m) => m.id === e.moduleId)) return reject("UNKNOWN_NODE");
      moduleId = e.moduleId;
    } else if (type === "LESSON_OPENED" || type === "HEARTBEAT") {
      const found = e.lessonId ? locateLesson(ctx.structure, e.lessonId) : null;
      if (!found) return reject("UNKNOWN_NODE");
      if (!ctx.openLessons.has(found.lesson.id)) return reject("LOCKED");
      moduleId = found.module.id;
      lessonId = found.lesson.id;
    } else {
      const found = e.itemId ? locateItem(ctx.structure, e.itemId) : null;
      if (!found) return reject("UNKNOWN_NODE");
      if (found.item.kind !== ITEM_KIND_FOR[type]) return reject("KIND_MISMATCH");
      const open = found.lesson ? ctx.openLessons.has(found.lesson.id) : ctx.openScopedItems.has(found.item.id);
      if (!open) return reject("LOCKED");
      moduleId = found.module?.id ?? null;
      lessonId = found.lesson?.id ?? null;
      itemId = found.item.id;
    }

    let metadata: AcceptedActivity["metadata"] = null;
    if (type.startsWith("VIDEO_") && e.metadata) {
      if (Object.keys(e.metadata).some((k) => !VIDEO_META_KEYS.has(k))) return reject("INVALID_METADATA");
      metadata = e.metadata;
    }
    if (type === "VIDEO_PROGRESS" && !(VIDEO_PROGRESS_MARKS as readonly unknown[]).includes(e.metadata?.pct)) return reject("INVALID_METADATA");

    accepted.push({
      type,
      moduleId,
      lessonId,
      itemId,
      durationSeconds: clampDuration(e.durationSeconds, type === "HEARTBEAT" ? MAX_HEARTBEAT_SECONDS : MAX_ACTIVITY_DURATION_SECONDS),
      metadata,
    });
  });
  return { accepted, rejected };
}

/** Item "opened"/"started" facts maintained from validated events. */
export const OPENS_ITEM: ReadonlySet<ClientActivityType> = new Set(["THEORY_OPENED", "TEACHER_PRACTICE_OPENED", "PRACTICE_OPENED", "ASSESSMENT_OPENED", "VIDEO_OPENED"]);
export const STARTS_ITEM: ReadonlySet<ClientActivityType> = new Set(["PRACTICE_STARTED", "VIDEO_STARTED"]);
