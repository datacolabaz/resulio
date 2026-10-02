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
 *    The owner's own visits to their link are never counted as recipient activity.
 *
 * For tasks, "submitted" is derived (not logged here): a submission is credited to the channel the
 * student first arrived through, using the user id / anonymous visitor id on these rows.
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

/** The campaign implied by a target type, so tagged links don't have to repeat it in the URL. */
export const DEFAULT_SHARE_CAMPAIGN: Partial<Record<ShareTargetType, ShareCampaign>> = {
  GROUP: "group_join",
  TASK: "task_share",
  EXAM: "exam_share",
  MATERIAL: "material_share",
};

/** Short, readable `?src=` values carried by tagged share links (e.g. /task/ABC?src=telegram). */
export const SHARE_SOURCE_PARAM: Record<ShareChannel, string> = {
  TELEGRAM: "telegram",
  WHATSAPP: "whatsapp",
  COPY_LINK: "link",
  QR: "qr",
  DIRECT: "direct",
};

/** Accepts the short `src` values above as well as the legacy `source=copy_link`/`TELEGRAM` form already out in the wild. */
export function parseShareSource(value: unknown): ShareChannel | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const lower = value.trim().toLowerCase();
  const short = (Object.entries(SHARE_SOURCE_PARAM) as [ShareChannel, string][]).find(([, v]) => v === lower);
  if (short) return short[0];
  const upper = lower.toUpperCase();
  return (SHARE_CHANNELS as readonly string[]).includes(upper) ? (upper as ShareChannel) : undefined;
}

export function parseShareCampaign(value: unknown): ShareCampaign | undefined {
  return typeof value === "string" && (SHARE_CAMPAIGNS as readonly string[]).includes(value) ? (value as ShareCampaign) : undefined;
}

/** Anonymous per-browser id sent with recipient events, so repeat visits can be de-duplicated without an account. */
export const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{8,40}$/;

export interface ShareChannelStats {
  clicked: number;
  opened: number;
  /** Distinct people behind `opened` (signed-in user, else anonymous browser). */
  openedUnique: number;
  downloaded: number;
  downloadedUnique: number;
  joined: number;
  /** TASK only: recipients who first arrived through this channel and then submitted. */
  submitted: number;
}

export interface ShareFunnel {
  byChannel: Record<ShareChannel, ShareChannelStats>;
  totals: ShareChannelStats;
}
