import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { settingsRedirect } from "./oauthRoutes";

function fakeReq(): Request {
  return { protocol: "https", headers: {}, get: () => "resulio.co" } as unknown as Request;
}

describe("settingsRedirect", () => {
  beforeEach(() => {
    vi.stubEnv("FRONTEND_URL", "https://resulio.co");
  });

  it("keeps a client-side anchor in the hash, not percent-encoded into the path", () => {
    const url = settingsRedirect(fakeReq(), "/settings#lesson-integration", { lessonOauth: "failed", provider: "google-meet" });
    expect(url).toBe("https://resulio.co/settings?lessonOauth=failed&provider=google-meet#lesson-integration");
  });

  it("still works for a returnTo with no hash", () => {
    const url = settingsRedirect(fakeReq(), "/app/teacher/lessons/settings", { lessonOauth: "connected", provider: "zoom" });
    expect(url).toBe("https://resulio.co/app/teacher/lessons/settings?lessonOauth=connected&provider=zoom");
  });

  it("drops any pre-existing query string on returnTo", () => {
    const url = settingsRedirect(fakeReq(), "/settings?foo=bar#lesson-integration", { lessonOauth: "cancelled", provider: "google-meet" });
    expect(url).toBe("https://resulio.co/settings?lessonOauth=cancelled&provider=google-meet#lesson-integration");
  });
});
