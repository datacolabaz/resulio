import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { decodeLessonOAuthState, encodeLessonOAuthState, type LessonOAuthState } from "./oauthState";

const SECRET = "a".repeat(32);
const state: LessonOAuthState = { nonce: "n1", verifier: "v1", provider: "GOOGLE_MEET", userId: 7, workspaceId: "ws_abc", returnTo: "/app/teacher/settings" };

describe("encodeLessonOAuthState / decodeLessonOAuthState", () => {
  it("round-trips", () => {
    const encoded = encodeLessonOAuthState(state, SECRET);
    expect(decodeLessonOAuthState(encoded, SECRET)).toEqual(state);
  });

  it("rejects a tampered body", () => {
    const encoded = encodeLessonOAuthState(state, SECRET);
    const [body, sig] = encoded.split(".");
    const tamperedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), u: 999 })).toString("base64url");
    expect(decodeLessonOAuthState(`${tamperedBody}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a signature made with a different secret", () => {
    const encoded = encodeLessonOAuthState(state, SECRET);
    expect(decodeLessonOAuthState(encoded, "b".repeat(32))).toBeNull();
  });

  it("rejects an expired envelope", () => {
    const encoded = encodeLessonOAuthState(state, SECRET, Date.now() - 20 * 60 * 1000);
    expect(decodeLessonOAuthState(encoded, SECRET)).toBeNull();
  });

  it("rejects garbage input", () => {
    expect(decodeLessonOAuthState("not-a-valid-state", SECRET)).toBeNull();
    expect(decodeLessonOAuthState("", SECRET)).toBeNull();
  });

  it("rejects an unknown provider", () => {
    const body = Buffer.from(JSON.stringify({ n: "n", v: "v", p: "SOMETHING_ELSE", u: 1, w: "w", r: "/", e: Date.now() + 60_000 })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
    expect(decodeLessonOAuthState(`${body}.${sig}`, SECRET)).toBeNull();
  });
});
