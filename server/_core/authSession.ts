import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { parseShareSource, SHARE_CAMPAIGNS, type ShareCampaign, type ShareChannel } from "@shared/shareTracking";
import type { Request, Response } from "express";
import type { User } from "../../drizzle/schema";
import { attributeReferral } from "../modules/referrals";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

/** Where a sign-in arrived from: partner referral code, share channel (?src=) and campaign. */
export type SignInAttribution = { ref?: string; source?: ShareChannel; campaign?: ShareCampaign };

/** A partner referralCode is the same shape as its public link's code: short, uppercase alnum. */
export function safeRef(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z0-9]{4,32}$/i.test(value) ? value.toUpperCase() : undefined;
}

export function safeChannel(value: unknown): ShareChannel | undefined {
  return parseShareSource(value);
}

export function safeCampaign(value: unknown): ShareCampaign | undefined {
  return (SHARE_CAMPAIGNS as readonly string[]).includes(String(value)) ? (value as ShareCampaign) : undefined;
}

export async function issueSessionCookie(req: Request, res: Response, user: Pick<User, "openId" | "name">) {
  const token = await sdk.createSessionToken(user.openId, { name: user.name ?? "", expiresInMs: ONE_YEAR_MS });
  res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });
}

/**
 * Everything every sign-in method does once it knows who the user is: attribute a brand-new signup
 * to the referral link it came from (a no-op for returning users), then start the session.
 */
export async function completeSignIn(
  req: Request,
  res: Response,
  result: { user: User; isNew: boolean },
  attribution: SignInAttribution,
) {
  await attributeReferral(result.user.id, result.isNew, attribution.ref, attribution.source ?? "DIRECT", attribution.campaign);
  await issueSessionCookie(req, res, result.user);
}
