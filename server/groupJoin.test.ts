import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import { afterLinkJoin, linkJoinKey, singleUseLinkJoinKey } from "./modules/groupJoin";
import * as groupsMod from "./modules/groups";
import { inviteCodeRejection, pendingJoinActivatable, type PendingJoinCandidate } from "./modules/groups";
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

describe("pendingJoinActivatable (requests left PENDING by the retired approval policy)", () => {
  const candidate = (over: Partial<PendingJoinCandidate> = {}): PendingJoinCandidate => ({
    userId: 7,
    ownerUserId: 1,
    inviteCode: "CODE123456",
    ...open,
    ...over,
  });
  const proof = new Set(["CODE123456:7"]);

  it("activates a request recorded as made through the group's current, still-valid link", () => {
    expect(pendingJoinActivatable(candidate(), proof, NOW)).toBe(true);
  });

  it("leaves it for the teacher when there is no record that it came through the link", () => {
    expect(pendingJoinActivatable(candidate(), new Set(), NOW)).toBe(false);
    expect(pendingJoinActivatable(candidate({ userId: 8 }), proof, NOW)).toBe(false);
  });

  it("leaves it for the teacher when the link it came through was since regenerated", () => {
    expect(pendingJoinActivatable(candidate({ inviteCode: "NEWCODE999" }), proof, NOW)).toBe(false);
  });

  it("leaves it for the teacher when the link is no longer valid or the group is closed", () => {
    expect(pendingJoinActivatable(candidate({ codeActive: false }), proof, NOW)).toBe(false);
    expect(pendingJoinActivatable(candidate({ codeExpiresAt: new Date(NOW.getTime() - 1) }), proof, NOW)).toBe(false);
    expect(pendingJoinActivatable(candidate({ joinPolicy: "MANUAL" }), proof, NOW)).toBe(false);
  });

  it("never activates the group owner", () => {
    expect(pendingJoinActivatable(candidate({ ownerUserId: 7 }), proof, NOW)).toBe(false);
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

  it("an invalid link is still rejected and triggers nothing", async () => {
    const { AppError } = await import("./modules/errors");
    vi.mocked(groupsMod.joinByInvite).mockRejectedValue(new AppError("INVITE_CODE_EXPIRED"));
    await expect(caller(8, "Murad").student.join({ inviteCode: "code123456" })).rejects.toThrow("INVITE_CODE_EXPIRED");
    expect(notifyOpenTasksOnJoin).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(shareTrackingMod.recordShareEvent).not.toHaveBeenCalled();
  });
});
