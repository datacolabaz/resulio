import { describe, expect, it } from "vitest";
import { inviteDisplayStatus } from "./modules/groupEmailInvites";

const NOW = new Date("2026-09-29T10:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60_000);
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 60 * 60_000);

describe("inviteDisplayStatus (derived, never stored)", () => {
  it("reports a still-pending invite before its expiry as PENDING", () => {
    expect(inviteDisplayStatus({ status: "PENDING", expiresAt: hoursFromNow(1) }, NOW)).toBe("PENDING");
  });

  it("reports a pending invite past its expiry as EXPIRED without a DB write", () => {
    expect(inviteDisplayStatus({ status: "PENDING", expiresAt: hoursAgo(1) }, NOW)).toBe("EXPIRED");
  });

  it("treats the exact expiry instant as still pending, one millisecond later as expired", () => {
    expect(inviteDisplayStatus({ status: "PENDING", expiresAt: NOW }, NOW)).toBe("PENDING");
    expect(inviteDisplayStatus({ status: "PENDING", expiresAt: NOW }, new Date(NOW.getTime() + 1))).toBe("EXPIRED");
  });

  it("passes through ACCEPTED regardless of expiry", () => {
    expect(inviteDisplayStatus({ status: "ACCEPTED", expiresAt: hoursAgo(100) }, NOW)).toBe("ACCEPTED");
    expect(inviteDisplayStatus({ status: "ACCEPTED", expiresAt: hoursFromNow(100) }, NOW)).toBe("ACCEPTED");
  });

  it("passes through REVOKED regardless of expiry", () => {
    expect(inviteDisplayStatus({ status: "REVOKED", expiresAt: hoursAgo(100) }, NOW)).toBe("REVOKED");
    expect(inviteDisplayStatus({ status: "REVOKED", expiresAt: hoursFromNow(100) }, NOW)).toBe("REVOKED");
  });

  it("defaults `now` to the current time when omitted", () => {
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    const farPast = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365);
    expect(inviteDisplayStatus({ status: "PENDING", expiresAt: farFuture })).toBe("PENDING");
    expect(inviteDisplayStatus({ status: "PENDING", expiresAt: farPast })).toBe("EXPIRED");
  });
});
