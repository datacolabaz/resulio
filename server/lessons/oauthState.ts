import { createHmac, timingSafeEqual } from "crypto";
import type { MeetingProvider } from "../../shared/lessonIntegration";

/**
 * PKCE + HMAC-signed `state` for the lesson-integration OAuth connect flow, mirroring
 * server/_core/googleAuth.ts's state envelope. Unlike sign-in, the caller is already an
 * authenticated teacher, so the state only needs to survive the round trip to the provider and
 * back (verifier, which workspace/provider this was for, and where to send the browser after),
 * not carry any identity claim the callback would otherwise trust blindly.
 */

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export type LessonOAuthState = {
  nonce: string;
  verifier: string;
  provider: MeetingProvider;
  userId: number;
  workspaceId: string;
  returnTo: string;
};

function hmacKey(sessionSecret: string): string {
  if (!sessionSecret || sessionSecret.length < 32) throw new Error("SESSION_SECRET must be set (min 32 chars)");
  return sessionSecret;
}

export function encodeLessonOAuthState(state: LessonOAuthState, sessionSecret: string, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ n: state.nonce, v: state.verifier, p: state.provider, u: state.userId, w: state.workspaceId, r: state.returnTo, e: now + STATE_MAX_AGE_MS }),
  ).toString("base64url");
  const sig = createHmac("sha256", hmacKey(sessionSecret)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function decodeLessonOAuthState(raw: string, sessionSecret: string, now = Date.now()): LessonOAuthState | null {
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  let expected: string;
  try {
    expected = createHmac("sha256", hmacKey(sessionSecret)).update(body).digest("base64url");
  } catch {
    return null;
  }
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      n?: unknown;
      v?: unknown;
      p?: unknown;
      u?: unknown;
      w?: unknown;
      r?: unknown;
      e?: unknown;
    };
    if (typeof parsed.n !== "string" || typeof parsed.v !== "string" || typeof parsed.e !== "number") return null;
    if (parsed.e < now) return null;
    if (parsed.p !== "GOOGLE_MEET" && parsed.p !== "ZOOM") return null;
    if (typeof parsed.u !== "number" || typeof parsed.w !== "string" || typeof parsed.r !== "string") return null;
    return { nonce: parsed.n, verifier: parsed.v, provider: parsed.p, userId: parsed.u, workspaceId: parsed.w, returnTo: parsed.r };
  } catch {
    return null;
  }
}
