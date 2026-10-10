import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import { effectiveJoinPolicy, JOIN_REQUEST_COOLDOWN_MS } from "../shared/groupJoinPolicy";
import { afterJoinDecisions, afterJoinRequest, afterLinkJoin, joinDecisionKey, joinRequestKey, linkJoinKey, singleUseLinkJoinKey } from "./modules/groupJoin";
import { onCooldown } from "./modules/groupJoinApproval";
import * as groupsMod from "./modules/groups";
import { inviteCodeRejection } from "./modules/groups";
import * as notificationsMod from "./modules/notifications";
import * as shareTrackingMod from "./modules/shareTracking";
import { dispatch } from "./notifications/dispatcher";
import { renderNotification } from "./notifications/render";
import { appRouter } from "./routers";
import { notifyOpenTasksOnJoin } from "./modules/taskNotify";

vi.mock("./notifications/dispatcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notifications/dispatcher")>()),
  dispatch: vi.fn(),
}));
vi.mock("./modules/taskNotify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/taskNotify")>()),
  notifyOpenTasksOnJoin: vi.fn(),
}));
vi.mock("./modules/groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/groups")>()),
  joinByInvite: vi.fn(),
}));
vi.mock("./modules/shareTracking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/shareTracking")>()),
  recordShareEvent: vi.fn(async () => undefined),
}));
vi.mock("./modules/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/notifications")>()),
  notify: vi.fn(async () => undefined),
}));

const NOW = new Date("2026-10-08T10:00:00Z");
const open = { codeActive: true, codeExpiresAt: null, joinPolicy: "AUTO" as const };

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
});

describe("inviteCodeRejection (the group's /join/<code> link)", () => {
  it("lets people in while the code is active, unexpired and the group is open", () => {
    expect(inviteCodeRejection(open, NOW)).toBeNull();
    expect(inviteCodeRejection({ ...open, codeExpiresAt: new Date(NOW.getTime() + 1000) }, NOW)).toBeNull();
  });

  it("keeps the existing validity rules: deactivated, expired, closed to self-join", () => {
    expect(inviteCodeRejection({ ...open, codeActive: false }, NOW)).toBe("INVITE_CODE_INACTIVE");
    expect(inviteCodeRejection({ ...open, codeExpiresAt: NOW }, NOW)).toBe("INVITE_CODE_EXPIRED");
    expect(inviteCodeRejection({ ...open, codeExpiresAt: new Date(NOW.getTime() - 1) }, NOW)).toBe("INVITE_CODE_EXPIRED");
    expect(inviteCodeRejection({ ...open, joinPolicy: "MANUAL" }, NOW)).toBe("GROUP_NOT_ACCEPTING");
  });
});

describe("join policy APPROVAL", () => {
  it("is stored as the AUTO column plus the approval flag; MANUAL wins over the flag", () => {
    expect(effectiveJoinPolicy("AUTO", false)).toBe("AUTO");
    expect(effectiveJoinPolicy("AUTO", true)).toBe("APPROVAL");
    expect(effectiveJoinPolicy("MANUAL", true)).toBe("MANUAL");
    expect(effectiveJoinPolicy("MANUAL", false)).toBe("MANUAL");
  });

  it("takes requests through the link while the code is valid, with the same validity rules as AUTO", () => {
    const approval = { ...open, joinPolicy: "APPROVAL" as const };
    expect(inviteCodeRejection(approval, NOW)).toBeNull();
    expect(inviteCodeRejection({ ...approval, codeActive: false }, NOW)).toBe("INVITE_CODE_INACTIVE");
    expect(inviteCodeRejection({ ...approval, codeExpiresAt: NOW }, NOW)).toBe("INVITE_CODE_EXPIRED");
    expect(inviteCodeRejection(approval, NOW, { uses: 3, maxUses: 3 })).toBe("INVITE_CODE_LIMIT_REACHED");
  });

  it("refuses a new request for a day after the teacher declined one", () => {
    expect(onCooldown(null, NOW)).toBe(false);
    expect(onCooldown(new Date(NOW.getTime() - 60_000), NOW)).toBe(true);
    expect(onCooldown(new Date(NOW.getTime() - JOIN_REQUEST_COOLDOWN_MS + 1), NOW)).toBe(true);
    expect(onCooldown(new Date(NOW.getTime() - JOIN_REQUEST_COOLDOWN_MS), NOW)).toBe(false);
  });
});

describe("afterJoinRequest / afterJoinDecisions", () => {
  it("a new request only tells the teacher, with its own dedupe key; nothing is opened to the student", () => {
    afterJoinRequest({ groupId: "g1", groupName: "Riyaziyyat 9A", ownerUserId: 1, membershipId: 42 }, "Aysel");
    expect(notifyOpenTasksOnJoin).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      event: "GROUP_MEMBER_JOINED",
      userId: 1,
      dedupeKey: joinRequestKey(42),
      data: { groupId: "g1", groupName: "Riyaziyyat 9A", studentName: "Aysel", pending: true },
    });
    expect(joinRequestKey(42)).not.toBe(linkJoinKey(42));
  });

  it("approval opens the group's tasks to each student and tells them; a decline only tells them", () => {
    const group = { id: "g1", name: "Riyaziyyat 9A" };
    afterJoinDecisions(group, [{ membershipId: 42, userId: 7 }, { membershipId: 43, userId: 8 }], "APPROVED");
    expect(notifyOpenTasksOnJoin).toHaveBeenCalledWith("g1", 7);
    expect(notifyOpenTasksOnJoin).toHaveBeenCalledWith("g1", 8);
    expect(dispatch).toHaveBeenCalledWith({ event: "GROUP_JOIN_DECIDED", userId: 7, dedupeKey: joinDecisionKey(42), data: { groupId: "g1", groupName: "Riyaziyyat 9A", decision: "APPROVED" } });
    vi.clearAllMocks();
    afterJoinDecisions(group, [{ membershipId: 44, userId: 9 }], "DECLINED");
    expect(notifyOpenTasksOnJoin).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ event: "GROUP_JOIN_DECIDED", userId: 9, dedupeKey: joinDecisionKey(44), data: { groupId: "g1", groupName: "Riyaziyyat 9A", decision: "DECLINED" } });
  });
});

describe("afterLinkJoin", () => {
  it("runs the activation side effects: the student's open-task notice and the teacher's informational notice", () => {
    afterLinkJoin({ groupId: "g1", groupName: "Riyaziyyat 9A", ownerUserId: 1, userId: 7 }, "Aysel", linkJoinKey(42));
    expect(notifyOpenTasksOnJoin).toHaveBeenCalledWith("g1", 7);
    expect(dispatch).toHaveBeenCalledWith({
      event: "GROUP_MEMBER_JOINED",
      userId: 1,
      dedupeKey: "group-join:42",
      data: { groupId: "g1", groupName: "Riyaziyyat 9A", studentName: "Aysel" },
    });
  });

  it("uses one dedupe key per membership row and per single-use link", () => {
    expect(linkJoinKey(42)).not.toBe(linkJoinKey(43));
    expect(singleUseLinkJoinKey("abc")).toBe("group-join-link:abc");
  });
});

describe("GROUP_MEMBER_JOINED notice", () => {
  const data = { groupId: "g 1", groupName: "Riyaziyyat 9A", studentName: "Aysel" };

  it("says who joined which group via the link, in each language, and opens the group", () => {
    const az = renderNotification("GROUP_MEMBER_JOINED", data, { locale: "az", email: null }, "https://resulio.co");
    expect(az.title).toBe("Yeni tələbə qoşuldu");
    expect(az.body).toBe("Aysel dəvət linki ilə «Riyaziyyat 9A» qrupuna qoşuldu.");
    expect(az.path).toBe("/teacher/groups/g%201");
    expect(az.email).toBeNull();
    expect(renderNotification("GROUP_MEMBER_JOINED", data, { locale: "en", email: null }, "").body).toBe("Aysel joined “Riyaziyyat 9A” via the invite link.");
    expect(renderNotification("GROUP_MEMBER_JOINED", data, { locale: "ru", email: null }, "").body).toContain("по ссылке-приглашению");
  });

  it("falls back to a generic name when the student has none", () => {
    const en = renderNotification("GROUP_MEMBER_JOINED", { ...data, studentName: "  " }, { locale: "en", email: null }, "");
    expect(en.body).toBe("A student joined “Riyaziyyat 9A” via the invite link.");
  });

  it("a request reads as one and opens the group's requests tab", () => {
    const az = renderNotification("GROUP_MEMBER_JOINED", { ...data, pending: true }, { locale: "az", email: null }, "");
    expect(az.title).toBe("Yeni qoşulma sorğusu");
    expect(az.body).toContain("Aysel qrup kodu linki ilə «Riyaziyyat 9A» qrupuna qoşulmaq istəyir.");
    expect(az.path).toBe("/teacher/groups/g%201?tab=requests");
    expect(renderNotification("GROUP_MEMBER_JOINED", { ...data, pending: true }, { locale: "en", email: null }, "").title).toBe("New join request");
    expect(renderNotification("GROUP_MEMBER_JOINED", { ...data, pending: true }, { locale: "ru", email: null }, "").title).toBe("Новая заявка на вступление");
  });
});

describe("GROUP_JOIN_DECIDED notice", () => {
  const base = { groupId: "g 1", groupName: "Riyaziyyat 9A" };

  it("an approval says the group is open and leads to it", () => {
    const az = renderNotification("GROUP_JOIN_DECIDED", { ...base, decision: "APPROVED" }, { locale: "az", email: null }, "");
    expect(az.title).toBe("Qrupa qəbul olundunuz");
    expect(az.body).toContain("«Riyaziyyat 9A»");
    expect(az.path).toBe("/student/groups?group=g%201");
    expect(az.email).toBeNull();
  });

  it("a decline is neutral and leads to the student's groups", () => {
    for (const locale of ["az", "en", "ru"] as const) {
      const r = renderNotification("GROUP_JOIN_DECIDED", { ...base, decision: "DECLINED" }, { locale, email: null }, "");
      expect(r.path).toBe("/student/groups");
      expect(r.body).not.toMatch(/rədd|reject|отклон/i);
    }
  });
});

describe("student.join", () => {
  function caller(id: number, name: string | null) {
    const user = { id, openId: `google:${id}`, name, email: `u${id}@example.com`, accountStatus: "ACTIVE", sessionsValidAfter: null } as unknown as User;
    const ctx: TrpcContext = {
      user,
      session: null,
      req: { ip: "10.0.0.9", protocol: "https", headers: {} } as TrpcContext["req"],
      res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    };
    return appRouter.createCaller(ctx);
  }

  it("joins at once through a valid link: ACTIVE, side effects run, and no approval request is sent", async () => {
    vi.mocked(groupsMod.joinByInvite).mockResolvedValue({
      membershipId: 42,
      groupId: "g1",
      groupName: "Riyaziyyat 9A",
      ownerUserId: 1,
      userId: 7,
      status: "ACTIVE",
      activatedPending: false,
    });
    const res = await caller(7, "Aysel").student.join({ inviteCode: "code123456", channel: "WHATSAPP" });

    expect(res).toEqual({ groupId: "g1", groupName: "Riyaziyyat 9A", status: "ACTIVE" });
    expect(groupsMod.joinByInvite).toHaveBeenCalledWith(7, "CODE123456");
    expect(notifyOpenTasksOnJoin).toHaveBeenCalledWith("g1", 7);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: "GROUP_MEMBER_JOINED", userId: 1, dedupeKey: "group-join:42" }));
    expect(notificationsMod.notify).not.toHaveBeenCalled();
    expect(shareTrackingMod.recordShareEvent).toHaveBeenCalledWith(expect.objectContaining({ targetId: "CODE123456", eventType: "JOINED", actorUserId: 7 }));
  });

  it("under APPROVAL a new request tells only the teacher and is tracked as the link's join", async () => {
    vi.mocked(groupsMod.joinByInvite).mockResolvedValue({
      membershipId: 50,
      groupId: "g1",
      groupName: "Riyaziyyat 9A",
      ownerUserId: 1,
      userId: 7,
      status: "PENDING",
      newRequest: true,
    });
    const res = await caller(7, "Aysel").student.join({ inviteCode: "code123456", channel: "QR" });

    expect(res).toEqual({ groupId: "g1", groupName: "Riyaziyyat 9A", status: "PENDING" });
    expect(notifyOpenTasksOnJoin).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: "GROUP_MEMBER_JOINED", userId: 1, dedupeKey: "group-join-request:50", data: expect.objectContaining({ pending: true }) }));
    expect(shareTrackingMod.recordShareEvent).toHaveBeenCalledWith(expect.objectContaining({ targetId: "CODE123456", channel: "QR", eventType: "JOINED", actorUserId: 7 }));
  });

  it("asking again while the request waits sends nothing new", async () => {
    vi.mocked(groupsMod.joinByInvite).mockResolvedValue({ membershipId: 50, groupId: "g1", groupName: "Riyaziyyat 9A", ownerUserId: 1, userId: 7, status: "PENDING", newRequest: false });
    expect((await caller(7, "Aysel").student.join({ inviteCode: "code123456" })).status).toBe("PENDING");
    expect(dispatch).not.toHaveBeenCalled();
    expect(notifyOpenTasksOnJoin).not.toHaveBeenCalled();
  });

  it("an invalid link is still rejected and triggers nothing", async () => {
    const { AppError } = await import("./modules/errors");
    vi.mocked(groupsMod.joinByInvite).mockRejectedValue(new AppError("INVITE_CODE_EXPIRED"));
    await expect(caller(8, "Murad").student.join({ inviteCode: "code123456" })).rejects.toThrow("INVITE_CODE_EXPIRED");
    expect(notifyOpenTasksOnJoin).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(shareTrackingMod.recordShareEvent).not.toHaveBeenCalled();
  });
});
