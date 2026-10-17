import { ENV } from "../../_core/env";

/**
 * Zoom OAuth (authorization code grant, Server-to-Server is not used here because the meeting
 * must be created as the teacher's own Zoom user, not an app-level service account) + the Meetings
 * API. Zoom always rotates the refresh token on use, unlike Google, so callers must persist the
 * new one every refresh.
 */

const AUTH_URL = "https://zoom.us/oauth/authorize";
const TOKEN_URL = "https://zoom.us/oauth/token";

export type TokenExchangeResult = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
};

export function zoomAuthUrl(params: { state: string; redirectUri: string }): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", ENV.zoomClientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", params.state);
  return url.toString();
}

function basicAuthHeader(): string {
  return `Basic ${Buffer.from(`${ENV.zoomClientId}:${ENV.zoomClientSecret}`).toString("base64")}`;
}

async function parseTokenResponse(res: Response): Promise<TokenExchangeResult> {
  if (!res.ok) throw new Error(`Zoom token endpoint returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!json.access_token || !json.refresh_token) throw new Error("Zoom token response missing access_token/refresh_token");
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000), scope: json.scope ?? "" };
}

export async function exchangeZoomCode(code: string, redirectUri: string): Promise<TokenExchangeResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { authorization: basicAuthHeader(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  return parseTokenResponse(res);
}

export async function refreshZoomToken(refreshToken: string): Promise<TokenExchangeResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { authorization: basicAuthHeader(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  return parseTokenResponse(res);
}

export async function zoomAccountProfile(accessToken: string): Promise<{ email: string | null; id: string | null }> {
  const res = await fetch("https://api.zoom.us/v2/users/me", { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return { email: null, id: null };
  const json = (await res.json()) as { email?: string; id?: string };
  return { email: json.email ?? null, id: json.id ?? null };
}

export type CreatedMeeting = { externalMeetingId: string; joinUrl: string; hostUrl: string; passcode: string | null };

export async function createZoomMeeting(accessToken: string, args: { title: string; startsAt: Date; durationMinutes: number; timezone: string }): Promise<CreatedMeeting> {
  const res = await fetch("https://api.zoom.us/v2/users/me/meetings", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      topic: args.title,
      type: 2, // scheduled
      start_time: args.startsAt.toISOString(),
      duration: args.durationMinutes,
      timezone: args.timezone,
      settings: { join_before_host: false, waiting_room: true, approval_type: 2, auto_recording: "cloud" },
    }),
  });
  if (!res.ok) throw new Error(`Zoom meeting creation returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = (await res.json()) as { id?: number; join_url?: string; start_url?: string; password?: string };
  if (!json.id || !json.join_url || !json.start_url) throw new Error("Zoom meeting response missing id/join_url/start_url");
  return { externalMeetingId: String(json.id), joinUrl: json.join_url, hostUrl: json.start_url, passcode: json.password ?? null };
}

export async function deleteZoomMeeting(accessToken: string, externalMeetingId: string): Promise<void> {
  const res = await fetch(`https://api.zoom.us/v2/meetings/${externalMeetingId}`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Zoom meeting deletion returned ${res.status}`);
}
