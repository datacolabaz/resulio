/**
 * Notification domain events and the channels each may use. Adding an event: declare it here,
 * give it a renderer in render.ts, then call `dispatch` where it happens. See docs/NOTIFICATIONS.md.
 */

export const CHANNELS = ["IN_APP", "EMAIL", "PUSH"] as const;
export type Channel = (typeof CHANNELS)[number];

export const EVENT_TYPES = [
  "AI_GRADE_READY",
  "GRADE_RELEASED",
  "GRADE_UPDATED",
  "AI_LIMIT_80",
  "AI_LIMIT_REACHED",
  "AI_PROVIDER_ERROR",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventData {
  AI_GRADE_READY: { submissionId: string; taskTitle: string; score: number; feedback: string; strengths: string[]; improvements: string[] };
  GRADE_RELEASED: { taskTitle: string; score: number | null };
  GRADE_UPDATED: { taskTitle: string; score: number | null };
  AI_LIMIT_80: { workspace: string; used: number; limit: number };
  AI_LIMIT_REACHED: { workspace: string; used: number; limit: number };
  AI_PROVIDER_ERROR: { workspace: string; problem: "AUTH" | "QUOTA" };
}

export interface EventDefinition {
  /** Channels this event can go to; all are on by default unless the user opts out. */
  channels: readonly Channel[];
}

export const EVENTS: Record<EventType, EventDefinition> = {
  // The one "result ready" notice of an automatic AI grade; replaces GRADE_RELEASED for it.
  AI_GRADE_READY: { channels: ["IN_APP", "EMAIL", "PUSH"] },
  GRADE_RELEASED: { channels: ["IN_APP", "EMAIL", "PUSH"] },
  GRADE_UPDATED: { channels: ["IN_APP", "EMAIL", "PUSH"] },
  AI_LIMIT_80: { channels: ["IN_APP", "PUSH"] },
  AI_LIMIT_REACHED: { channels: ["IN_APP", "PUSH"] },
  AI_PROVIDER_ERROR: { channels: ["IN_APP", "PUSH"] },
};

export const isEventType = (v: string): v is EventType => (EVENT_TYPES as readonly string[]).includes(v);
export const isChannel = (v: string): v is Channel => (CHANNELS as readonly string[]).includes(v);
