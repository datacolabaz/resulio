import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as db from "../db";
import { recordSecurityEvent } from "../modules/securityEvents";
import { clearNamedCookie, getSessionCookieOptions, isSecureRequest } from "./cookies";
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

function hmacKey() {
  const secret = ENV.sessionSecret;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be set (min 32 chars)");
  return secret;
}

/** PKCE + return path travel with Google's `state` so Safari bounce-tracking cannot drop them. */
export function encodeOAuthState(state: OAuthState, now = Date.now()): string {
  const body = b64url(Buffer.from(JSON.stringify({ n: state.nonce, v: state.verifier, r: state.returnTo, e: now + STATE_MAX_AGE_MS })));
  const sig = createHmac("sha256", hmacKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function decodeOAuthState(raw: string, now = Date.now()): OAuthState | null {
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  let expected: string;
  try {
    expected = createHmac("sha256", hmacKey()).update(body).digest("base64url");
  } catch {
    return null;
  }
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { n?: unknown; v?: unknown; r?: unknown; e?: unknown };
    if (typeof parsed.n !== "string" || typeof parsed.v !== "string" || typeof parsed.e !== "number") return null;
    if (parsed.e < now) return null;
    return { nonce: parsed.n, verifier: parsed.v, returnTo: safeReturnTo(parsed.r) };
  } catch {
    return null;
  }
}

function readCookieState(req: Request): OAuthState | null {
  const raw = parseCookieHeader(req.headers.cookie ?? "")[STATE_COOKIE];
  if (!raw) return null;
  return decodeOAuthState(raw) ?? legacyCookieState(raw);
}

function legacyCookieState(raw: string): OAuthState | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.nonce === "string" && typeof parsed?.verifier === "string") {
      return { nonce: parsed.nonce, verifier: parsed.verifier, returnTo: safeReturnTo(parsed.returnTo) };
    }
  } catch {
    // ignore
  }
  return null;
}

function publicReason(value: string) {
  return /^[a-z0-9_]{1,64}$/i.test(value) ? value : "unknown";
}

function loginPage(params: Record<string, string>) {
  const origin = ENV.frontendUrl;
  const dest = new URL(origin || "http://127.0.0.1");
  dest.pathname = "/";
  dest.search = "";
  dest.hash = "";
  for (const [key, value] of Object.entries(params)) dest.searchParams.set(key, value);
  return origin ? dest.toString() : `/?${dest.searchParams.toString()}`;
}

function failLogin(res: Response, reason: string) {
  res.redirect(302, loginPage({ login: "failed", reason: publicReason(reason) }));
}

/** Flatten mysql2 / drizzle / jose error chains without leaking secrets into the redirect URL. */
export function loginCatchReason(error: unknown): string {
  const codes: string[] = [];
  const errnos: number[] = [];
  const messages: string[] = [];
  let cur: unknown = error;
  for (let i = 0; i < 8 && cur; i++) {
    if (cur instanceof Error) messages.push(cur.message);
    if (typeof cur !== "object" || !cur) break;
    const o = cur as { code?: unknown; errno?: unknown; cause?: unknown; name?: unknown };
    if (typeof o.code === "string") codes.push(o.code);
    if (typeof o.errno === "number") errnos.push(o.errno);
    if (typeof o.name === "string") messages.push(o.name);
    cur = o.cause;
  }
  const blob = `${codes.join(" ")} ${messages.join(" ")}`.toLowerCase();
  if (blob.includes("session_secret")) return "session";
  if (
    blob.includes("database_unavailable") ||
    blob.includes("account_user_missing") ||
    codes.includes("ER_NO_SUCH_TABLE") ||
    codes.includes("ER_BAD_FIELD_ERROR") ||
    codes.includes("ER_DUP_ENTRY") ||
    errnos.includes(1146) ||
    errnos.includes(1054) ||
    errnos.includes(1062) ||
    blob.includes("doesn't exist") ||
    blob.includes("does not exist") ||
    blob.includes("unknown column")
  ) {
    return "db";
  }
  if (
    blob.includes("jwks") ||
    blob.includes("jose") ||
    blob.includes("jwtexpired") ||
    blob.includes("jwtclaim") ||
    blob.includes("jws") ||
    blob.includes("jsonwebtokenerror") ||
    /\bjwt\b/.test(blob)
  ) {
    return "jwt";
  }
  if (blob.includes("fetch") || blob.includes("network") || blob.includes("econn") || blob.includes("enotfound") || blob.includes("invalid json")) {
    return "token";
  }
  if (blob.includes("sub missing")) return "sub";
  return "server";
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
    if (!ENV.sessionSecret || ENV.sessionSecret.length < 32) {
      console.warn("[GoogleAuth] SESSION_SECRET is missing or shorter than 32 characters.");
      res.status(503).type("text/plain").send("Google login is not configured\n\nSESSION_SECRET must be at least 32 characters.\n");
      return;
    }
    const state: OAuthState = {
      nonce: b64url(randomBytes(24)),
      verifier: b64url(randomBytes(48)),
      returnTo: safeReturnTo(req.query.returnTo),
    };
    const packed = encodeOAuthState(state);
    res.cookie(STATE_COOKIE, packed, {
      ...getSessionCookieOptions(req),
      maxAge: STATE_MAX_AGE_MS,
    });
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", ENV.googleClientId);
    url.searchParams.set("redirect_uri", redirectUri(req));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", packed);
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(state.verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "select_account");
    res.redirect(302, url.toString());
  });

  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    const packed = typeof req.query.state === "string" ? req.query.state : "";
    const state = decodeOAuthState(packed) ?? readCookieState(req);
    clearNamedCookie(res, STATE_COOKIE, req);
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (req.query.error) {
      const googleError = typeof req.query.error === "string" ? req.query.error : "cancelled";
      res.redirect(302, loginPage({ login: googleError === "access_denied" ? "cancelled" : "failed", reason: publicReason(googleError) }));
      return;
    }
    if (!state || !code) {
      recordSecurityEvent({ type: "OAUTH_STATE_INVALID", severity: "MEDIUM", ipHash: hashIp(req.ip), details: { hasState: !!state, hasCode: !!code } });
      failLogin(res, state ? "missing_code" : "state");
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
      let tokens: { id_token?: string; error?: string } = {};
      try {
        tokens = JSON.parse(await tokenRes.text()) as { id_token?: string; error?: string };
      } catch {
        console.error("[GoogleAuth] token exchange returned non-JSON:", tokenRes.status);
        failLogin(res, "token");
        return;
      }
      if (!tokenRes.ok) {
        const reason = publicReason(tokens.error || "token");
        console.error("[GoogleAuth] token exchange failed:", tokenRes.status, reason);
        failLogin(res, reason);
        return;
      }
      if (!tokens.id_token) {
        failLogin(res, "id_token");
        return;
      }

      const { payload } = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: ENV.googleClientId,
        clockTolerance: 120,
      });
      if (typeof payload.sub !== "string" || !payload.sub) {
        failLogin(res, "sub");
        return;
      }
      const emailVerified = payload.email_verified === true || payload.email_verified === "true";
      if (!emailVerified) {
        failLogin(res, "unverified");
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

      const origin = ENV.frontendUrl;
      res.redirect(302, origin ? `${origin}${state.returnTo}` : state.returnTo);
    } catch (error) {
      const reason = loginCatchReason(error);
      const message = error instanceof Error ? error.message : "unknown";
      console.error("[GoogleAuth] Callback failed:", reason, message);
      failLogin(res, reason);
    }
  });
}
