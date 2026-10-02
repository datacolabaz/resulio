/**
 * Lightweight, honest analytics for share links: which public, pre-auth actions happened
 * (a channel button was clicked, the destination page was opened, the student actually
 * joined/claimed it) for a group invite, a task/exam/material share code, or a partner's
 * referral code. Deliberately NOT a full marketing funnel (no "read"/"started"/"completed"
 * stages) -- those would require instrumentation this app doesn't have, and a fabricated
 * stage is worse than an honestly smaller one.
 */
export const SHARE_TARGET_TYPES = ["GROUP", "TASK", "EXAM", "MATERIAL", "REFERRAL"] as const;
export type ShareTargetType = (typeof SHARE_TARGET_TYPES)[number];

export const SHARE_CHANNELS = ["TELEGRAM", "WHATSAPP", "COPY_LINK", "QR", "DIRECT"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export const SHARE_EVENT_TYPES = ["CLICKED", "OPENED", "JOINED"] as const;
export type ShareEventType = (typeof SHARE_EVENT_TYPES)[number];

/** Which surface generated the link; free-form but kept short so it fits the UI directly. */
export const SHARE_CAMPAIGNS = [
  "group_join",
  "task_share",
  "exam_share",
  "material_share",
  "onboarding",
  "dashboard_card",
  "profile_referral",
] as const;
export type ShareCampaign = (typeof SHARE_CAMPAIGNS)[number];

export interface ShareFunnel {
  byChannel: Record<ShareChannel, { clicked: number; opened: number; joined: number }>;
  totals: { clicked: number; opened: number; joined: number };
}
