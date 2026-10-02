import { describe, expect, it } from "vitest";
import { parseShareSource } from "../shared/shareTracking";
import { buildFunnel, type ShareEventRow } from "./modules/shareTracking";

let nextId = 1;
const row = (r: Partial<ShareEventRow> & Pick<ShareEventRow, "channel" | "eventType">): ShareEventRow => ({
  id: nextId++,
  actorUserId: null,
  visitorId: null,
  createdAt: new Date(2026, 0, 1, 0, 0, nextId),
  ...r,
});

describe("parseShareSource", () => {
  it("reads the short ?src= values and the legacy ?source= values", () => {
    expect(parseShareSource("telegram")).toBe("TELEGRAM");
    expect(parseShareSource("link")).toBe("COPY_LINK");
    expect(parseShareSource("copy_link")).toBe("COPY_LINK");
    expect(parseShareSource("QR")).toBe("QR");
    expect(parseShareSource("nonsense")).toBeUndefined();
    expect(parseShareSource(undefined)).toBeUndefined();
  });
});

describe("buildFunnel", () => {
  it("keeps raw counts but de-duplicates people, linking a browser's anonymous visits to the account it signs in with", () => {
    const funnel = buildFunnel([
      row({ channel: "TELEGRAM", eventType: "CLICKED", actorUserId: 1 }),
      row({ channel: "TELEGRAM", eventType: "OPENED", visitorId: "browser-a" }),
      row({ channel: "TELEGRAM", eventType: "OPENED", visitorId: "browser-a", actorUserId: 7 }),
      row({ channel: "TELEGRAM", eventType: "DOWNLOADED", visitorId: "browser-a" }),
      row({ channel: "TELEGRAM", eventType: "DOWNLOADED", actorUserId: 7 }),
      row({ channel: "TELEGRAM", eventType: "OPENED", visitorId: "browser-b" }),
      row({ channel: "TELEGRAM", eventType: "JOINED", actorUserId: 7, visitorId: "browser-a" }),
    ], { submittedUserIds: [7] });
    expect(funnel.byChannel.TELEGRAM).toEqual({ clicked: 1, opened: 3, openedUnique: 2, downloaded: 2, downloadedUnique: 1, joined: 1, submitted: 1 });
  });

  it("never counts the owner's own visits as recipient activity, but keeps the owner's share-button presses", () => {
    const funnel = buildFunnel(
      [
        row({ channel: "COPY_LINK", eventType: "CLICKED", actorUserId: 1 }),
        row({ channel: "COPY_LINK", eventType: "OPENED", actorUserId: 1, visitorId: "teacher-browser" }),
        row({ channel: "COPY_LINK", eventType: "OPENED", visitorId: "teacher-browser" }),
      ],
      { excludeUserIds: [1] },
    );
    expect(funnel.byChannel.COPY_LINK).toMatchObject({ clicked: 1, opened: 0, openedUnique: 0 });
  });

  it("credits a submission to the channel the student first arrived through, and ignores submitters who never used the link", () => {
    const funnel = buildFunnel(
      [
        row({ channel: "QR", eventType: "OPENED", actorUserId: 5 }),
        row({ channel: "WHATSAPP", eventType: "OPENED", actorUserId: 5 }),
      ],
      { submittedUserIds: [5, 6] },
    );
    expect(funnel.byChannel.QR.submitted).toBe(1);
    expect(funnel.byChannel.WHATSAPP.submitted).toBe(0);
    expect(funnel.totals.submitted).toBe(1);
  });
});
