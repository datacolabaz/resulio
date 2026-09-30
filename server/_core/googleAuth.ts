import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as db from "../db";
import { recordSecurityEvent } from "../modules/securityEvents";
import { getSessionCookieOptions, isSecureRequest } from "./cookies";
import { ENV } from "./env";
import { hashIp } from "./requestMeta";
import { sdk } from "./sdk";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const STATE_COOKIE = "resulio_oauth";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

type OAuthState = { nonce: string; verifier: string; returnTo: string };

const b64url = (buf: Buffer) => buf.toString("base64url");

/** Only same-origin relative paths are allowed as post-login destinations. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string") return "/app";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/app";
  if (value.startsWith("/api/")) return "/app";
  return value.slice(0, 512);
}

export function redirectUri(req: Request) {
  if (ENV.googleRedirectUri) return ENV.googleRedirectUri;
  const proto = isSecureRequest(req) ? "https" : "http";
  const host = req.get("host") || "localhost:3000";
  return `${proto}://${host}/api/auth/google/callback`;
}

function sameString(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readState(req: Request): OAuthState | null {
  const raw = parseCookieHeader(req.headers.cookie ?? "")[STATE_COOKIE];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.nonce === "string" && typeof parsed?.verifier === "string") {
      return { nonce: parsed.nonce, verifier: parsed.verifier, returnTo: safeReturnTo(parsed.returnTo) };
    }
  } catch {
    // fall through
  }
  return null;
}

export function registerGoogleAuthRoutes(app: Express) {
  app.get("/api/auth/google/start", (req: Request, res: Response) => {
    if (!ENV.googleConfigured) {
      console.warn("[GoogleAuth] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET. Copy .env.example to .env and add a Web OAuth client from Google Cloud Console.");
      res
        .status(503)
        .type("text/plain")
        .send(
          "Google login is not configured\n\n" +
            "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the project-root .env (see .env.example), then restart the server.\n" +
            "Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client (Web application).\n" +
            "Authorised JavaScript origin: http://localhost:3000\n" +
            `Authorised redirect URI: ${redirectUri(req)}\n`,
        );
      return;
    }
    const state: OAuthState = {
      nonce: b64url(randomBytes(24)),
      verifier: b64url(randomBytes(48)),
      returnTo: safeReturnTo(req.query.returnTo),
    };
    res.cookie(STATE_COOKIE, Buffer.from(JSON.stringify(state)).toString("base64url"), {
      ...getSessionCookieOptions(req),
      maxAge: STATE_MAX_AGE_MS,
    });
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", ENV.googleClientId);
    url.searchParams.set("redirect_uri", redirectUri(req));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state.nonce);
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(state.verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "select_account");
    res.redirect(302, url.toString());
  });

  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    const state = readState(req);
    res.clearCookie(STATE_COOKIE, getSessionCookieOptions(req));
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const nonce = typeof req.query.state === "string" ? req.query.state : "";
    if (req.query.error) {
      res.redirect(302, `${ENV.frontendUrl}/?login=cancelled`);
      return;
    }
    if (!state || !code || !nonce || !sameString(nonce, state.nonce)) {
      recordSecurityEvent({ type: "OAUTH_STATE_INVALID", severity: "MEDIUM", ipHash: hashIp(req.ip), details: { hasState: !!state, hasCode: !!code } });
      res.status(403).send("Invalid OAuth state");
      return;
    }

    try {
      const tokenRes = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: ENV.googleClientId,
          client_secret: ENV.googleClientSecret,
          redirect_uri: redirectUri(req),
          grant_type: "authorization_code",
          code_verifier: state.verifier,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
      const tokens = (await tokenRes.json()) as { id_token?: string };
      if (!tokens.id_token) throw new Error("id_token missing");

      const { payload } = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: ENV.googleClientId,
      });
      if (typeof payload.sub !== "string" || !payload.sub) throw new Error("sub missing");
      if (payload.email_verified !== true) {
        res.status(403).send("Google email is not verified");
        return;
      }

      const user = await db.upsertProviderUser({
        provider: "google",
        providerAccountId: payload.sub,
        email: typeof payload.email === "string" ? payload.email.toLowerCase() : null,
        name: typeof payload.name === "string" ? payload.name : null,
        avatarUrl: typeof payload.picture === "string" ? payload.picture : null,
      });

      const token = await sdk.createSessionToken(user.openId, { name: user.name ?? "", expiresInMs: ONE_YEAR_MS });
      res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });

      res.redirect(302, `${ENV.frontendUrl}${state.returnTo}`);
    } catch (error) {
      console.error("[GoogleAuth] Callback failed:", error instanceof Error ? error.message : error);
      res.status(500).send("Google login failed");
    }
  });
}
