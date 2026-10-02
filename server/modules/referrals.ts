import { and, desc, eq } from "drizzle-orm";
import { partnerProfiles, referralAttributions, users } from "../../drizzle/schema";
import type { ShareCampaign, ShareChannel, ShareFunnel } from "../../shared/shareTracking";
import { getDb } from "../db";
import { recordShareEvent, shareFunnel } from "./shareTracking";

/**
 * Attributes a brand-new signup to the partner whose referral code it arrived with -- first
 * valid referral wins, enforced by the unique index on referralAttributions.userId, which also
 * makes this call idempotent and safe to retry.
 *
 * Deliberately conservative: only ever called for `isNew` signups (never a returning login), and
 * only an APPROVED partner's code counts, so a pending/rejected/suspended partner's old links
 * quietly stop attributing instead of still working. Best-effort: never blocks a login.
 */
export async function attributeReferral(
  userId: number,
  isNew: boolean,
  referralCode: string | undefined,
  channel: ShareChannel,
  campaign: ShareCampaign | undefined,
) {
  if (!isNew || !referralCode) return;
  try {
    const db = getDb();
    if (!db) return;
    const [partner] = await db
      .select({ id: partnerProfiles.id, userId: partnerProfiles.userId })
      .from(partnerProfiles)
      .where(and(eq(partnerProfiles.referralCode, referralCode), eq(partnerProfiles.status, "APPROVED")))
      .limit(1);
    if (!partner || partner.userId === userId) return; // unknown/unapproved code, or (impossible for a fresh signup, kept as a guard) self-referral
    await db.insert(referralAttributions).values({ userId, partnerId: partner.id, referralCode, channel, campaign: campaign ?? null });
    await recordShareEvent({ targetType: "REFERRAL", targetId: referralCode, channel, eventType: "JOINED", campaign, actorUserId: userId });
  } catch (error) {
    // Unique-constraint races (concurrent duplicate attempt) and any other failure are swallowed --
    // a missed attribution must never turn into a failed, user-facing login.
    console.error("[referrals] attributeReferral failed", error);
  }
}

export interface ReferralStats {
  funnel: ShareFunnel;
  signupCount: number;
  referred: Array<{ maskedName: string; channel: ShareChannel; campaign: string | null; joinedAt: Date }>;
}

/** Everything a partner's own "Referral and earnings" page can show truthfully: no money figures, because no payment system exists yet. */
export async function referralStats(partnerId: number, referralCode: string): Promise<ReferralStats> {
  const db = getDb();
  if (!db) return { funnel: await shareFunnel("REFERRAL", referralCode), signupCount: 0, referred: [] };
  const rows = await db
    .select({ name: users.name, channel: referralAttributions.channel, campaign: referralAttributions.campaign, createdAt: referralAttributions.createdAt })
    .from(referralAttributions)
    .innerJoin(users, eq(users.id, referralAttributions.userId))
    .where(eq(referralAttributions.partnerId, partnerId))
    .orderBy(desc(referralAttributions.createdAt))
    .limit(200);
  return {
    funnel: await shareFunnel("REFERRAL", referralCode),
    signupCount: rows.length,
    referred: rows.map((r) => ({ maskedName: maskName(r.name), channel: r.channel, campaign: r.campaign, joinedAt: r.createdAt })),
  };
}

/** "Aysel Məmmədova" -> "A** M**" -- never the referred person's full name, email or anything else identifying. */
function maskName(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  return parts.map((p) => `${p[0].toUpperCase()}**`).join(" ");
}
