/**
 * Notification domain events and the channels each may use. Adding an event: declare it here,
 * give it a renderer in render.ts, then call `dispatch` where it happens. See docs/NOTIFICATIONS.md.
 */

export const CHANNELS = ["IN_APP", "EMAIL", "PUSH"] as const;
export type Channel = (typeof CHANNELS)[number];

export const EVENT_TYPES = [
  "AI_FEEDBACK_READY",
  "GRADE_RELEASED",
  "GRADE_UPDATED",
  "AI_LIMIT_80",
  "AI_LIMIT_REACHED",
  "AI_PROVIDER_ERROR",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventData {
  AI_FEEDBACK_READY: { submissionId: string; taskTitle: string; feedback: string; strengths: string[]; improvements: string[] };
  GRADE_RELEASED: { taskTitle: string; score: number | null };
  GRADE_UPDATED: { taskTitle: string; score: number | null };
  AI_LIMIT_80: { workspace: string; used: number; limit: number };
  AI_LIMIT_REACHED: { workspace: string; used: number; limit: number };
  AI_PROVIDER_ERROR: { workspace: string; problem: "AUTH" | "QUOTA" };
}

export interface EventDefinition {
  /** Channels this event can go to; all are on by default unless the user opts out. */
  channels: readonly Channel[];
  /** Without the outbox table (migration not applied yet), deliver IN_APP/EMAIL directly instead of skipping. */
  fallbackWithoutOutbox: boolean;
  /** A repeated dispatch with the same dedupe key re-sends if the earlier delivery was skipped or failed. */
  resendUnlessSent: boolean;
}

export const EVENTS: Record<EventType, EventDefinition> = {
  // No IN_APP: the owner chose e-mail; the site does not show AI feedback to students.
  AI_FEEDBACK_READY: { channels: ["EMAIL", "PUSH"], fallbackWithoutOutbox: false, resendUnlessSent: true },
  GRADE_RELEASED: { channels: ["IN_APP", "EMAIL", "PUSH"], fallbackWithoutOutbox: true, resendUnlessSent: false },
  GRADE_UPDATED: { channels: ["EMAIL", "PUSH"], fallbackWithoutOutbox: true, resendUnlessSent: false },
  AI_LIMIT_80: { channels: ["IN_APP", "PUSH"], fallbackWithoutOutbox: true, resendUnlessSent: false },
  AI_LIMIT_REACHED: { channels: ["IN_APP", "PUSH"], fallbackWithoutOutbox: true, resendUnlessSent: false },
  AI_PROVIDER_ERROR: { channels: ["IN_APP", "PUSH"], fallbackWithoutOutbox: true, resendUnlessSent: false },
};

export const isEventType = (v: string): v is EventType => (EVENT_TYPES as readonly string[]).includes(v);
export const isChannel = (v: string): v is Channel => (CHANNELS as readonly string[]).includes(v);
