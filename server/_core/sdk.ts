import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";

const ISSUER = "resulio";
const AUDIENCE = "resulio-app";

export type SessionPayload = { openId: string; name: string };
/** Millisecond timestamps of the token: when it was issued and when the user last signed in. */
export type SessionTimes = { issuedAtMs: number; authTimeMs: number };
export type VerifiedSession = SessionPayload & SessionTimes;

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

class SessionService {
  private secret() {
    const secret = ENV.sessionSecret;
    if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be set (min 32 chars)");
    return new TextEncoder().encode(secret);
  }

  async createSessionToken(openId: string, options: { expiresInMs?: number; name?: string; authTimeMs?: number } = {}) {
    return this.signSession({ openId, name: options.name ?? "" }, options);
  }

  async signSession(payload: SessionPayload, options: { expiresInMs?: number; authTimeMs?: number } = {}): Promise<string> {
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const now = Date.now();
    return new SignJWT({ openId: payload.openId, name: payload.name, iatMs: now, authMs: options.authTimeMs ?? now })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor((now + expiresInMs) / 1000))
      .sign(this.secret());
  }

  async verifySession(token: string | undefined | null): Promise<VerifiedSession | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.secret(), {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const { openId, name, iat, iatMs, authMs } = payload as Record<string, unknown>;
      if (!isNonEmptyString(openId) || typeof name !== "string") return null;
      // Tokens issued before the millisecond claims existed fall back to the second-precision `iat`.
      const issuedAtMs = isTime(iatMs) ? iatMs : isTime(iat) ? iat * 1000 : 0;
      return { openId, name, issuedAtMs, authTimeMs: isTime(authMs) ? authMs : issuedAtMs };
    } catch {
      return null;
    }
  }

  async authenticateRequest(req: Request): Promise<{ user: User; session: SessionTimes }> {
    const cookies = parseCookieHeader(req.headers.cookie ?? "");
    const session = await this.verifySession(cookies[COOKIE_NAME]);
    if (!session) throw ForbiddenError("Invalid session cookie");
    const user = await db.getUserByOpenId(session.openId);
    if (!user) throw ForbiddenError("User not found");
    if (isRevoked(user, session)) throw ForbiddenError("Session revoked");
    void db.markSeen(user).catch((error) => console.error("[Auth] lastSeenAt update failed", error));
    return { user, session: { issuedAtMs: session.issuedAtMs, authTimeMs: session.authTimeMs } };
  }
}

/** A token is revoked when it was issued before the user's sessionsValidAfter instant. */
export function isRevoked(user: Pick<User, "sessionsValidAfter">, session: Pick<SessionTimes, "issuedAtMs">): boolean {
  return !!user.sessionsValidAfter && session.issuedAtMs < user.sessionsValidAfter.getTime();
}

export const sdk = new SessionService();
