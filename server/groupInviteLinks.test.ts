import { describe, expect, it } from "vitest";
import type { GroupInviteLink } from "../drizzle/schema";
import { AppError } from "./modules/errors";
import {
  hashInviteLinkToken,
  inviteLinkStatus,
  isWellFormedInviteLinkToken,
  newInviteLinkToken,
  plannedLabels,
  previewState,
  redeemWithStore,
  type RedeemStore,
} from "./modules/groupInviteLinks";

const NOW = new Date("2026-10-03T10:00:00Z");
const hours = (h: number) => new Date(NOW.getTime() + h * 60 * 60_000);
const OWNER = 1;

function link(over: Partial<GroupInviteLink> = {}): GroupInviteLink {
  return {
    id: "link1",
    groupId: "g1",
    tokenHash: "",
    label: "",
    createdByUserId: OWNER,
    createdAt: hours(-1),
    expiresAt: hours(24 * 7),
    usedByUserId: null,
    usedAt: null,
    revokedAt: null,
    ...over,
  };
}

/** Mirrors the MySQL store: the claim is a compare-and-set, after a yield so concurrent calls really interleave. */
function fakeStore(initial: GroupInviteLink, members: Record<number, "ACTIVE" | "PENDING"> = {}) {
  const row = { ...initial };
  const membership = new Map<number, "ACTIVE" | "PENDING">(Object.entries(members).map(([k, v]) => [Number(k), v]));
  let claims = 0;
  const store: RedeemStore = {
    async findByHash(hash) {
      await Promise.resolve();
      return hash === row.tokenHash ? { ...row } : null;
    },
    async groupInfo() {
      return { name: "Riyaziyyat 9A", ownerUserId: OWNER };
    },
    async membershipStatus(_groupId, userId) {
      return membership.get(userId) ?? null;
    },
    async claimAndActivate(_linkId, _groupId, userId, now) {
      await Promise.resolve();
      claims++;
      if (row.usedByUserId !== null || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return false;
      row.usedByUserId = userId;
      row.usedAt = now;
      membership.set(userId, "ACTIVE");
      return true;
    },
  };
  return { store, row, membership, claims: () => claims };
}

function withToken(over: Partial<GroupInviteLink> = {}) {
  const token = newInviteLinkToken();
  return { token, link: link({ tokenHash: hashInviteLinkToken(token), ...over }) };
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `THROWN:${(e as Error).message}`;
  }
}

describe("invite link tokens", () => {
  it("are 256-bit, URL-safe and unique", () => {
    const tokens = new Set(Array.from({ length: 2000 }, newInviteLinkToken));
    expect(tokens.size).toBe(2000);
    for (const t of [...tokens].slice(0, 50)) {
      expect(t).toHaveLength(43);
      expect(isWellFormedInviteLinkToken(t)).toBe(true);
      expect(Buffer.from(t, "base64url")).toHaveLength(32);
    }
  });

  it("are stored only as a SHA-256 hash that never equals or contains the token", () => {
    const token = newInviteLinkToken();
    const hash = hashInviteLinkToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashInviteLinkToken(token));
    expect(hash).not.toContain(token);
    expect(hashInviteLinkToken(newInviteLinkToken())).not.toBe(hash);
  });

  it("rejects malformed tokens before any lookup", () => {
    expect(isWellFormedInviteLinkToken("short")).toBe(false);
    expect(isWellFormedInviteLinkToken(`${"a".repeat(42)}=`)).toBe(false);
    expect(isWellFormedInviteLinkToken("a".repeat(44))).toBe(false);
  });
});

describe("inviteLinkStatus (derived, never stored)", () => {
  it("is ACTIVE until the expiry instant, EXPIRED from it on", () => {
    expect(inviteLinkStatus(link({ expiresAt: hours(1) }), NOW)).toBe("ACTIVE");
    expect(inviteLinkStatus(link({ expiresAt: NOW }), NOW)).toBe("EXPIRED");
    expect(inviteLinkStatus(link({ expiresAt: hours(-1) }), NOW)).toBe("EXPIRED");
  });

  it("reports REVOKED for a revoked unused link, even before expiry", () => {
    expect(inviteLinkStatus(link({ revokedAt: hours(-1) }), NOW)).toBe("REVOKED");
  });

  it("keeps a used link USED regardless of later expiry", () => {
    expect(inviteLinkStatus(link({ usedByUserId: 5, expiresAt: hours(-100) }), NOW)).toBe("USED");
  });
});

describe("plannedLabels (bulk generation)", () => {
  it("creates `count` unlabeled links, or one link per label", () => {
    expect(plannedLabels({ count: 3 })).toEqual(["", "", ""]);
    expect(plannedLabels({ labels: [" Aysel ", "Murad"] })).toEqual(["Aysel", "Murad"]);
    expect(plannedLabels({})).toEqual([""]);
  });

  it("refuses an empty or oversized batch", () => {
    expect(() => plannedLabels({ count: 51 })).toThrow("INVITE_LINK_BATCH_TOO_LARGE");
    expect(() => plannedLabels({ count: 0 })).toThrow("INVITE_LINK_BATCH_TOO_LARGE");
  });
});

describe("previewState (what a link holder may see)", () => {
  it("shows group details only to a live link or to its own redeemer", () => {
    expect(previewState(link(), null, NOW)).toBe("ACTIVE");
    expect(previewState(link({ usedByUserId: 5 }), 5, NOW)).toBe("REDEEMED_BY_YOU");
    expect(previewState(link({ usedByUserId: 5 }), 6, NOW)).toBe("USED");
    expect(previewState(link({ usedByUserId: 5 }), null, NOW)).toBe("USED");
    expect(previewState(null, 5, NOW)).toBe("NOT_FOUND");
  });
});

describe("redeemWithStore (single use, atomic)", () => {
  it("joins the first redeemer as ACTIVE immediately and binds the link to them", async () => {
    const { token, link: l } = withToken();
    const f = fakeStore(l);
    const res = await redeemWithStore(f.store, 10, token, NOW);
    expect(res.outcome).toBe("JOINED");
    expect(f.row.usedByUserId).toBe(10);
    expect(f.row.usedAt).toEqual(NOW);
    expect(f.membership.get(10)).toBe("ACTIVE");
  });

  it("refuses everyone else once used", async () => {
    const { token, link: l } = withToken();
    const f = fakeStore(l);
    await redeemWithStore(f.store, 10, token, NOW);
    expect(await codeOf(redeemWithStore(f.store, 11, token, NOW))).toBe("INVITE_LINK_USED");
    expect(f.membership.has(11)).toBe(false);
  });

  it("is idempotent for the person who redeemed it", async () => {
    const { token, link: l } = withToken();
    const f = fakeStore(l);
    await redeemWithStore(f.store, 10, token, NOW);
    expect((await redeemWithStore(f.store, 10, token, hours(24 * 30))).outcome).toBe("ALREADY_REDEEMED");
  });

  it("does not let a removed student back in with their old link", async () => {
    const { token, link: l } = withToken();
    const f = fakeStore(l);
    await redeemWithStore(f.store, 10, token, NOW);
    f.membership.delete(10);
    expect(await codeOf(redeemWithStore(f.store, 10, token, NOW))).toBe("INVITE_LINK_USED");
  });

  it("lets exactly one of many simultaneous redeemers win", async () => {
    const { token, link: l } = withToken();
    const f = fakeStore(l);
    const results = await Promise.all([10, 11, 12, 13, 14].map((u) => codeOf(redeemWithStore(f.store, u, token, NOW))));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "INVITE_LINK_USED")).toHaveLength(4);
    expect(f.claims()).toBe(5);
    expect([...f.membership.values()]).toEqual(["ACTIVE"]);
  });

  it("treats a double-click by the same student as one redemption", async () => {
    const { token, link: l } = withToken();
    const f = fakeStore(l);
    const results = await Promise.all([redeemWithStore(f.store, 10, token, NOW), redeemWithStore(f.store, 10, token, NOW)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["ALREADY_REDEEMED", "JOINED"]);
  });

  it("refuses expired and revoked links without consuming them", async () => {
    const expired = withToken({ expiresAt: hours(-1) });
    const fe = fakeStore(expired.link);
    expect(await codeOf(redeemWithStore(fe.store, 10, expired.token, NOW))).toBe("INVITE_LINK_EXPIRED");
    const revoked = withToken({ revokedAt: hours(-1) });
    const fr = fakeStore(revoked.link);
    expect(await codeOf(redeemWithStore(fr.store, 10, revoked.token, NOW))).toBe("INVITE_LINK_REVOKED");
    expect(fe.row.usedByUserId).toBeNull();
    expect(fr.row.usedByUserId).toBeNull();
  });

  it("re-checks expiry at claim time (the conditional UPDATE), not just at lookup", async () => {
    const { token, link: l } = withToken({ expiresAt: hours(1) });
    const f = fakeStore(l);
    const realClaim = f.store.claimAndActivate;
    f.store.claimAndActivate = (id, g, u) => realClaim(id, g, u, hours(2));
    expect(await codeOf(redeemWithStore(f.store, 10, token, NOW))).not.toBe("OK");
    expect(f.row.usedByUserId).toBeNull();
    expect(f.membership.has(10)).toBe(false);
  });

  it("refuses the group's own teacher", async () => {
    const { token, link: l } = withToken();
    const f = fakeStore(l);
    expect(await codeOf(redeemWithStore(f.store, OWNER, token, NOW))).toBe("CANNOT_JOIN_OWN_GROUP");
    expect(f.row.usedByUserId).toBeNull();
  });

  it("leaves the link unused for a student who is already an active member", async () => {
    const { token, link: l } = withToken();
    const f = fakeStore(l, { 10: "ACTIVE" });
    expect(await codeOf(redeemWithStore(f.store, 10, token, NOW))).toBe("ALREADY_MEMBER");
    expect(f.row.usedByUserId).toBeNull();
  });

  it("activates a pending join request instead of waiting for approval", async () => {
    const { token, link: l } = withToken();
    const f = fakeStore(l, { 10: "PENDING" });
    expect((await redeemWithStore(f.store, 10, token, NOW)).outcome).toBe("JOINED");
    expect(f.membership.get(10)).toBe("ACTIVE");
  });

  it("rejects unknown and malformed tokens the same way", async () => {
    const { link: l } = withToken();
    const f = fakeStore(l);
    expect(await codeOf(redeemWithStore(f.store, 10, newInviteLinkToken(), NOW))).toBe("INVITE_LINK_NOT_FOUND");
    expect(await codeOf(redeemWithStore(f.store, 10, "not-a-token", NOW))).toBe("INVITE_LINK_NOT_FOUND");
  });
});
