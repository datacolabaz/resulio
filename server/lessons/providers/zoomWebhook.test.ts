import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyZoomWebhookSignature, zoomWebhookChallengeResponse } from "./zoom";

const SECRET = "test-secret-token";

function signedHeader(timestamp: string, rawBody: string, secret = SECRET): string {
  const hash = createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  return `v0=${hash}`;
}

describe("verifyZoomWebhookSignature", () => {
  it("accepts a signature computed the way Zoom computes it", () => {
    const rawBody = JSON.stringify({ event: "recording.completed" });
    const timestamp = "1700000000000";
    expect(verifyZoomWebhookSignature(rawBody, timestamp, signedHeader(timestamp, rawBody), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = "1700000000000";
    const header = signedHeader(timestamp, JSON.stringify({ event: "recording.completed" }));
    expect(verifyZoomWebhookSignature(JSON.stringify({ event: "recording.deleted" }), timestamp, header, SECRET)).toBe(false);
  });

  it("rejects the right body signed with the wrong secret", () => {
    const rawBody = JSON.stringify({ event: "recording.completed" });
    const timestamp = "1700000000000";
    expect(verifyZoomWebhookSignature(rawBody, timestamp, signedHeader(timestamp, rawBody, "other-secret"), SECRET)).toBe(false);
  });

  it("rejects a malformed header without throwing", () => {
    expect(verifyZoomWebhookSignature("{}", "1700000000000", "not-a-real-signature", SECRET)).toBe(false);
  });
});

describe("zoomWebhookChallengeResponse", () => {
  it("echoes the plain token and HMACs it with the secret", () => {
    const result = zoomWebhookChallengeResponse("abc123", SECRET);
    expect(result.plainToken).toBe("abc123");
    expect(result.encryptedToken).toBe(createHmac("sha256", SECRET).update("abc123").digest("hex"));
  });
});
