import { createHash, randomBytes } from "crypto";
import type { Express, Request, Response } from "express";
import { parse as parseCookieHeader } from "cookie";
import type { MeetingProvider } from "../../shared/lessonIntegration";
import { ENV } from "../_core/env";
import { clearNamedCookie, getSessionCookieOptions, isSecureRequest } from "../_core/cookies";
import { sdk } from "../_core/sdk";
import { resolveWorkspace } from "../modules/access";
import { decodeLessonOAuthState, encodeLessonOAuthState, type LessonOAuthState } from "./oauthState";
import { exchangeGoogleMeetCode, googleMeetAccountEmail, googleMeetAuthUrl } from "./providers/googleMeet";
import { exchangeZoomCode, zoomAccountProfile, zoomAuthUrl } from "./providers/zoom";
import { upsertConnection } from "./tokenStore";

/**
 * Teacher-initiated OAuth connect flow for the lesson-integration meeting providers. Plain Express
 * routes (not tRPC) because the browser must be redirected to Google/Zoom and back, exactly like
 * server/_core/googleAuth.ts's sign-in flow -- the difference is the caller is already signed in,
 * so these routes attach a connection to that existing session rather than creating one.
 */

const STATE_COOKIE = "resulio_lesson_oauth";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const b64url = (buf: Buffer) => buf.toString("base64url");

function callbackUrl(req: Request, provider: MeetingProvider): string {
  const configured = provider === "GOOGLE_MEET" ? ENV.googleMeetRedirectUri : ENV.zoomRedirectUri;
  if (configured) return configured;
  const proto = isSecureRequest(req) ? "https" : "http";
  const host = req.get("host") || "localhost:3000";
  const slug = provider === "GOOGLE_MEET" ? "google-meet" : "zoom";
  return `${proto}://${host}/api/lessons/oauth/${slug}/callback`;
}

/** Only a same-origin relative path -- never an open redirect to an attacker-chosen host. */
function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/app/teacher/lessons/settings";
  return value.slice(0, 512);
}

function settingsRedirect(req: Request, returnTo: string, params: Record<string, string>): string {
  const origin = ENV.frontendUrl;
  const dest = new URL(origin || `${isSecureRequest(req) ? "https" : "http"}://${req.get("host") || "localhost:3000"}`);
  dest.pathname = returnTo.split("?")[0];
  dest.search = "";
  for (const [key, value] of Object.entries(params)) dest.searchParams.set(key, value);
  return dest.toString();
}

function providerSlug(provider: MeetingProvider): "google-meet" | "zoom" {
  return provider === "GOOGLE_MEET" ? "google-meet" : "zoom";
}

function parseProvider(raw: string): MeetingProvider | null {
  if (raw === "google-meet") return "GOOGLE_MEET";
  if (raw === "zoom") return "ZOOM";
  return null;
}

export function registerLessonOAuthRoutes(app: Express) {
  app.get("/api/lessons/oauth/:provider/start", async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    if (!provider) {
      res.status(404).end();
      return;
    }
    const configured = provider === "GOOGLE_MEET" ? ENV.googleMeetConfigured : ENV.zoomConfigured;
    if (!configured) {
      res.status(503).type("text/plain").send(`${provider} is not configured on this server yet. Set the matching OAuth client id/secret and restart.`);
      return;
    }
    let auth: { user: { id: number } };
    try {
      auth = await sdk.authenticateRequest(req);
    } catch {
      res.status(401).type("text/plain").send("Sign in first.");
      return;
    }
    const requestedWorkspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : null;
    const workspace = await resolveWorkspace(auth.user.id, requestedWorkspaceId);
    if (!workspace) {
      res.status(403).type("text/plain").send("No teaching workspace for this account.");
      return;
    }
    const state: LessonOAuthState = {
      nonce: b64url(randomBytes(24)),
      verifier: b64url(randomBytes(48)),
      provider,
      userId: auth.user.id,
      workspaceId: workspace.id,
      returnTo: safeReturnTo(req.query.returnTo),
    };
    const packed = encodeLessonOAuthState(state, ENV.sessionSecret);
    res.cookie(STATE_COOKIE, packed, { ...getSessionCookieOptions(req), maxAge: STATE_MAX_AGE_MS });
    const redirectUri = callbackUrl(req, provider);
    const url =
      provider === "GOOGLE_MEET"
        ? googleMeetAuthUrl({ state: packed, codeChallenge: b64url(createHash("sha256").update(state.verifier).digest()), redirectUri })
        : zoomAuthUrl({ state: packed, redirectUri });
    res.redirect(302, url);
  });

  app.get("/api/lessons/oauth/:provider/callback", async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    if (!provider) {
      res.status(404).end();
      return;
    }
    const packed = typeof req.query.state === "string" ? req.query.state : (parseCookieHeader(req.headers.cookie ?? "")[STATE_COOKIE] ?? "");
    clearNamedCookie(res, STATE_COOKIE, req);
    const state = decodeLessonOAuthState(packed, ENV.sessionSecret);
    const returnTo = state?.returnTo ?? "/app/teacher/lessons/settings";
    if (req.query.error) {
      res.redirect(302, settingsRedirect(req, returnTo, { lessonOauth: "cancelled", provider: providerSlug(provider) }));
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!state || !code || state.provider !== provider) {
      res.redirect(302, settingsRedirect(req, returnTo, { lessonOauth: "failed", provider: providerSlug(provider) }));
      return;
    }
    try {
      const redirectUri = callbackUrl(req, provider);
      if (provider === "GOOGLE_MEET") {
        const tokens = await exchangeGoogleMeetCode(code, state.verifier, redirectUri);
        const account = await googleMeetAccountEmail(tokens.accessToken);
        await upsertConnection({
          workspaceId: state.workspaceId,
          userId: state.userId,
          provider,
          externalAccountId: account.sub,
          accountEmail: account.email,
          scope: tokens.scope,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: tokens.expiresAt,
        });
      } else {
        const tokens = await exchangeZoomCode(code, redirectUri);
        const account = await zoomAccountProfile(tokens.accessToken);
        await upsertConnection({
          workspaceId: state.workspaceId,
          userId: state.userId,
          provider,
          externalAccountId: account.id,
          accountEmail: account.email,
          scope: tokens.scope,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: tokens.expiresAt,
        });
      }
      res.redirect(302, settingsRedirect(req, returnTo, { lessonOauth: "connected", provider: providerSlug(provider) }));
    } catch (error) {
      console.error(`[LessonOAuth] ${provider} connect failed:`, error instanceof Error ? error.message : error);
      res.redirect(302, settingsRedirect(req, returnTo, { lessonOauth: "failed", provider: providerSlug(provider) }));
    }
  });
}
