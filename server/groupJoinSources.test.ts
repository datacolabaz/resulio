import { describe, expect, it } from "vitest";
import { deriveJoinSource, EVIDENCE_WINDOW_MS, membershipIdOfNoticeKey, type JoinEvidence } from "./modules/groupJoinSources";
import { inviteCodeRejection } from "./modules/groups";

const joinedAt = new Date("2026-10-09T17:06:00Z");
const m = { membershipId: 7, groupId: "g1", userId: 42, joinedAt };
const none: JoinEvidence = { links: [], emailInvites: [], requests: [], codeNoticeAt: null, codeJoins: [] };
const at = (offsetMs: number) => new Date(joinedAt.getTime() + offsetMs);

describe("deriveJoinSource", () => {
  it("nothing on record: UNKNOWN at the membership's creation, no actor", () => {
    expect(deriveJoinSource(m, none)).toEqual({ ...m, joinedVia: "UNKNOWN", sourceId: null, actorUserId: null, backfilled: true });
  });

  it("the most specific evidence wins: link, then e-mail invite, then syllabus request, then code", () => {
    const all: JoinEvidence = {
      links: [{ id: "link1", at: at(1000) }],
      emailInvites: [{ id: "inv1", at: at(2000) }],
      requests: [{ id: "req1", at: at(3000), decidedBy: 5 }],
      codeNoticeAt: at(4000),
      codeJoins: [{ code: "ABC", at: at(5000) }],
    };
    expect(deriveJoinSource(m, all)).toMatchObject({ joinedVia: "SINGLE_USE_LINK", sourceId: "link1", actorUserId: 42, joinedAt: at(1000) });
    expect(deriveJoinSource(m, { ...all, links: [] })).toMatchObject({ joinedVia: "EMAIL_INVITE", sourceId: "inv1" });
    expect(deriveJoinSource(m, { ...all, links: [], emailInvites: [] })).toMatchObject({ joinedVia: "SYLLABUS_REQUEST", sourceId: "req1", actorUserId: 5 });
    expect(deriveJoinSource(m, { ...none, codeNoticeAt: at(4000) })).toMatchObject({ joinedVia: "GROUP_CODE_LINK", sourceId: null });
    expect(deriveJoinSource(m, { ...none, codeJoins: [{ code: "ABC", at: at(5000) }] })).toMatchObject({ joinedVia: "GROUP_CODE_LINK", sourceId: "ABC" });
  });

  it("evidence far from the membership's creation belongs to an earlier membership (removed, then re-added)", () => {
    const old = at(-EVIDENCE_WINDOW_MS - 1);
    expect(deriveJoinSource(m, { ...none, links: [{ id: "l", at: old }], emailInvites: [{ id: "i", at: old }], codeJoins: [{ code: "C", at: old }] }).joinedVia).toBe("UNKNOWN");
    expect(deriveJoinSource(m, { ...none, links: [{ id: "l", at: at(EVIDENCE_WINDOW_MS) }] }).joinedVia).toBe("SINGLE_USE_LINK");
  });

  it("the teacher's join notice is keyed by membership id, so its time doesn't matter", () => {
    expect(deriveJoinSource(m, { ...none, codeNoticeAt: at(30 * EVIDENCE_WINDOW_MS) }).joinedVia).toBe("GROUP_CODE_LINK");
  });
});

describe("membershipIdOfNoticeKey", () => {
  it("reads code-link join notices only", () => {
    expect(membershipIdOfNoticeKey("group-join:123:IN_APP")).toBe(123);
    expect(membershipIdOfNoticeKey("group-join-link:abc:IN_APP")).toBeNull();
    expect(membershipIdOfNoticeKey("h:deadbeef")).toBeNull();
  });
});

describe("inviteCodeRejection with a use cap", () => {
  const open = { codeActive: true, codeExpiresAt: null, joinPolicy: "AUTO" as const };
  it("no cap, or below it: open; at the cap: full; other refusals come first", () => {
    expect(inviteCodeRejection(open)).toBeNull();
    expect(inviteCodeRejection(open, new Date(), { uses: 99, maxUses: null })).toBeNull();
    expect(inviteCodeRejection(open, new Date(), { uses: 2, maxUses: 3 })).toBeNull();
    expect(inviteCodeRejection(open, new Date(), { uses: 3, maxUses: 3 })).toBe("INVITE_CODE_LIMIT_REACHED");
    expect(inviteCodeRejection({ ...open, codeActive: false }, new Date(), { uses: 3, maxUses: 3 })).toBe("INVITE_CODE_INACTIVE");
  });
});
