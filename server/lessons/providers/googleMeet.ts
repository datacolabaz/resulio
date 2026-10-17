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
const MEET_API_BASE = "https://meet.googleapis.com/v2";
/**
 * `meetings.space.readonly` is what lets the capture sweeper (server/lessons/captureSweeper.ts)
 * read back the conference record/transcript after the lesson ends -- the whole point of this
 * feature. A teacher who connected before this scope was added will have their next transcript
 * capture attempt fail with 403 until they reconnect; the sweeper treats that as a retryable
 * failure, not a crash, and surfaces it as UNAVAILABLE once the 30-day window closes.
 */
export const GOOGLE_MEET_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/meetings.space.readonly", "openid", "email"].join(" ");

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

// ---------------------------------------------------------------------------
// Meet REST API (read-only): looking a finished meeting back up by its Calendar-issued
// `conferenceId` (which is the same string the Meet API calls `space.meeting_code`) and pulling
// its transcript text before Google's own 30-day deletion. Used only by the capture sweeper
// (server/lessons/captureSweeper.ts), never at lesson-creation time.
// ---------------------------------------------------------------------------

export type MeetConferenceRecord = { name: string; startTime?: string; endTime?: string };

/** The conference record for a finished meeting, or null if Meet hasn't finished processing it yet (or there is none). */
export async function findGoogleMeetConferenceRecord(accessToken: string, meetingCode: string): Promise<MeetConferenceRecord | null> {
  const url = new URL(`${MEET_API_BASE}/conferenceRecords`);
  url.searchParams.set("filter", `space.meeting_code="${meetingCode}"`);
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google Meet conferenceRecords.list returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = (await res.json()) as { conferenceRecords?: MeetConferenceRecord[] };
  // The API returns records most-recent-first; a lesson occurrence maps to exactly one, but take
  // the first defensively rather than assume that ordering is contractual.
  return json.conferenceRecords?.[0] ?? null;
}

export type MeetTranscript = { name: string; state: string };

/** A finished conference record's transcripts. `state !== "FILE_GENERATED"` means Meet is still processing it. */
export async function listGoogleMeetTranscripts(accessToken: string, conferenceRecordName: string): Promise<MeetTranscript[]> {
  const res = await fetch(`${MEET_API_BASE}/${conferenceRecordName}/transcripts`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google Meet transcripts.list returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = (await res.json()) as { transcripts?: MeetTranscript[] };
  return json.transcripts ?? [];
}

const MAX_TRANSCRIPT_PAGES = 20;

/** Joins a transcript's spoken-text entries (paginated) into one plain-text document, in speaking order. */
export async function fetchGoogleMeetTranscriptText(accessToken: string, transcriptName: string): Promise<string> {
  const lines: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page++) {
    const url = new URL(`${MEET_API_BASE}/${transcriptName}/entries`);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Google Meet transcriptEntries.list returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const json = (await res.json()) as { transcriptEntries?: { text?: string }[]; nextPageToken?: string };
    for (const entry of json.transcriptEntries ?? []) if (entry.text) lines.push(entry.text);
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return lines.join("\n");
}
