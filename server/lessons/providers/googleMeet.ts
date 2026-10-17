import { ENV } from "../../_core/env";

/**
 * Google Meet via the Calendar API: a Meet link is requested on a Calendar event
 * (`conferenceData.createRequest` with `conferenceSolutionKey.type = "hangoutsMeet"`), which is
 * the documented, generally-available way to create a Meet meeting at a specific time without
 * Workspace admin allowlisting the newer standalone Meet API. `access_type=offline` +
 * `prompt=consent` so Resulio gets a refresh token even if the teacher connected before.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_MEET_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "openid", "email"].join(" ");

export type TokenExchangeResult = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
};

export function googleMeetAuthUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", ENV.googleMeetClientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_MEET_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function parseTokenResponse(res: Response): Promise<TokenExchangeResult> {
  if (!res.ok) throw new Error(`Google token endpoint returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!json.access_token) throw new Error("Google token response missing access_token");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
    scope: json.scope ?? GOOGLE_MEET_SCOPES,
  };
}

export async function exchangeGoogleMeetCode(code: string, verifier: string, redirectUri: string): Promise<TokenExchangeResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ENV.googleMeetClientId,
      client_secret: ENV.googleMeetClientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  return parseTokenResponse(res);
}

export async function refreshGoogleMeetToken(refreshToken: string): Promise<TokenExchangeResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: ENV.googleMeetClientId, client_secret: ENV.googleMeetClientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const result = await parseTokenResponse(res);
  return { ...result, refreshToken: result.refreshToken ?? refreshToken };
}

export async function googleMeetAccountEmail(accessToken: string): Promise<{ email: string | null; sub: string | null }> {
  const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return { email: null, sub: null };
  const json = (await res.json()) as { email?: string; sub?: string };
  return { email: json.email ?? null, sub: json.sub ?? null };
}

export type CreatedMeeting = { externalMeetingId: string; joinUrl: string; providerCalendarEventId: string };

/** Books a Calendar event spanning the lesson's time with a Meet conference attached. */
export async function createGoogleMeetMeeting(accessToken: string, args: { title: string; startsAt: Date; endsAt: Date; timezone: string }): Promise<CreatedMeeting> {
  const requestId = `resulio-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      summary: args.title,
      start: { dateTime: args.startsAt.toISOString(), timeZone: args.timezone },
      end: { dateTime: args.endsAt.toISOString(), timeZone: args.timezone },
      conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
    }),
  });
  if (!res.ok) throw new Error(`Google Calendar event creation returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = (await res.json()) as { id?: string; hangoutLink?: string; conferenceData?: { conferenceId?: string } };
  if (!json.hangoutLink || !json.id) throw new Error("Google Calendar response missing hangoutLink/id");
  return { externalMeetingId: json.conferenceData?.conferenceId ?? json.id, joinUrl: json.hangoutLink, providerCalendarEventId: json.id };
}
