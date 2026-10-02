/**
 * Lightweight, honest analytics for share links: which actions happened for a group invite, a
 * task/exam/material share code, or a partner's referral code. Deliberately NOT a full marketing
 * funnel (no "read"/"started"/"completed" stages) -- those would require instrumentation this app
 * doesn't have, and a fabricated stage is worse than an honestly smaller one.
 *
 * Two of these event types are about different *actors* and must never be blended in the UI as if
 * they were one funnel stage:
 *  - CLICKED is fired by the SENDER (the teacher/partner), the moment they press one of their own
 *    share buttons (WhatsApp/Telegram/copy-link/QR) in ShareBox. It counts how many times the link
 *    was distributed through each channel -- it is not and cannot be a recipient's click, since a
 *    click on a link inside WhatsApp/Telegram happens outside this app and is never observable here.
 *  - OPENED, DOWNLOADED and JOINED are all fired by the RECIPIENT: the public page actually loaded,
 *    an attached file was actually opened/downloaded from it, and the recipient went through with
 *    joining/claiming. These three are the real "did anyone on the other end do anything" signal.
 */
export const SHARE_TARGET_TYPES = ["GROUP", "TASK", "EXAM", "MATERIAL", "REFERRAL"] as const;
export type ShareTargetType = (typeof SHARE_TARGET_TYPES)[number];

export const SHARE_CHANNELS = ["TELEGRAM", "WHATSAPP", "COPY_LINK", "QR", "DIRECT"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export const SHARE_EVENT_TYPES = ["CLICKED", "OPENED", "DOWNLOADED", "JOINED"] as const;
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
  byChannel: Record<ShareChannel, { clicked: number; opened: number; downloaded: number; joined: number }>;
  totals: { clicked: number; opened: number; downloaded: number; joined: number };
}
