import { describe, expect, it } from "vitest";
import { catalog } from "../client/src/i18n/catalog";
import { translate, type MessageKey } from "../client/src/i18n/messages";
import { groupCodeNotice, type GroupCodeNotice } from "../client/src/lib/groupCodeNotice";
import { inviteCodeRejection } from "./modules/groups";

const NOW = new Date("2026-10-10T12:00:00Z");
const OPEN = { joinPolicy: "AUTO" as const, codeActive: true, codeExpiresAt: null, codeUsage: { uses: 3, maxUses: null } };
const NOTICES: GroupCodeNotice[] = ["OPEN", "APPROVAL", "LIMIT_REACHED", "SELF_JOIN_OFF", "CODE_OFF"];

describe("groupCodeNotice", () => {
  it("warns an open code admits anyone, with or without an unreached limit", () => {
    expect(groupCodeNotice(OPEN, NOW)).toBe("OPEN");
    expect(groupCodeNotice({ ...OPEN, codeUsage: { uses: 3, maxUses: 5 } }, NOW)).toBe("OPEN");
    expect(groupCodeNotice({ ...OPEN, codeExpiresAt: "2026-10-11T00:00:00Z" }, NOW)).toBe("OPEN");
  });

  it("says the link admits nobody when the limit is used up", () => {
    expect(groupCodeNotice({ ...OPEN, codeUsage: { uses: 5, maxUses: 5 } }, NOW)).toBe("LIMIT_REACHED");
  });

  it("says self-join is off under the teacher-added-only policy", () => {
    expect(groupCodeNotice({ ...OPEN, joinPolicy: "MANUAL" }, NOW)).toBe("SELF_JOIN_OFF");
  });

  it("says the code is off when deactivated or expired", () => {
    expect(groupCodeNotice({ ...OPEN, codeActive: false }, NOW)).toBe("CODE_OFF");
    expect(groupCodeNotice({ ...OPEN, codeExpiresAt: new Date("2026-10-10T11:59:59Z") }, NOW)).toBe("CODE_OFF");
  });

  it("says newcomers wait for approval under the approval policy, unless the link is closed anyway", () => {
    const approval = { ...OPEN, joinPolicy: "APPROVAL" as const };
    expect(groupCodeNotice(approval, NOW)).toBe("APPROVAL");
    expect(groupCodeNotice({ ...approval, codeUsage: { uses: 3, maxUses: 5 } }, NOW)).toBe("APPROVAL");
    expect(groupCodeNotice({ ...approval, codeUsage: { uses: 5, maxUses: 5 } }, NOW)).toBe("LIMIT_REACHED");
    expect(groupCodeNotice({ ...approval, codeActive: false }, NOW)).toBe("CODE_OFF");
  });

  it("promises a join (or a request) exactly when the server would accept one", () => {
    const cases = [
      OPEN,
      { ...OPEN, codeUsage: { uses: 5, maxUses: 5 } },
      { ...OPEN, joinPolicy: "MANUAL" as const },
      { ...OPEN, codeActive: false },
      { ...OPEN, joinPolicy: "MANUAL" as const, codeUsage: { uses: 9, maxUses: 1 } },
      { ...OPEN, codeExpiresAt: new Date("2026-10-01T00:00:00Z") },
      { ...OPEN, joinPolicy: "APPROVAL" as const },
      { ...OPEN, joinPolicy: "APPROVAL" as const, codeUsage: { uses: 2, maxUses: 2 } },
      { ...OPEN, joinPolicy: "APPROVAL" as const, codeExpiresAt: new Date("2026-10-01T00:00:00Z") },
    ];
    for (const c of cases) {
      const expires = c.codeExpiresAt ? new Date(c.codeExpiresAt) : null;
      const accepts = inviteCodeRejection({ ...c, codeExpiresAt: expires }, NOW, c.codeUsage) === null;
      const notice = groupCodeNotice(c, NOW);
      expect(notice === "OPEN" || notice === "APPROVAL").toBe(accepts);
      if (accepts) expect(notice).toBe(c.joinPolicy === "APPROVAL" ? "APPROVAL" : "OPEN");
    }
  });
});

describe("group code notice texts", () => {
  it("has AZ/EN/RU text for every notice", () => {
    for (const n of NOTICES) {
      const entry = catalog[`groups.codeNotice.${n}` as MessageKey] as readonly string[] | undefined;
      expect(entry, n).toBeDefined();
      expect(entry).toHaveLength(3);
      for (const text of entry ?? []) expect(text.trim().length, n).toBeGreaterThan(40);
    }
  });

  it("uses the approved Azerbaijani wording for an open code", () => {
    expect(translate("az", "groups.codeNotice.OPEN")).toBe(
      "Qrup kodu linki çoxnəfərlikdir və paylaşıla bilər. Bu linkdən qoşulan şəxs avtomatik qrupa və qrupa bağlı aktiv imtahanlara daxil ola bilər. Daha nəzarətli qəbul üçün link limiti və ya əl ilə təsdiq aktivləşdirin.",
    );
  });

  it("uses the approved neutral wording under the approval policy, and never says 'automatically'", () => {
    expect(translate("az", "groups.codeNotice.APPROVAL")).toMatch(/^Link ilə gələnlər siz təsdiq edənə qədər qrupa daxil olmur/);
    expect(translate("az", "groups.codeNotice.APPROVAL")).not.toMatch(/avtomatik/);
    expect(translate("en", "groups.codeNotice.APPROVAL")).not.toMatch(/automatic/i);
    expect(translate("ru", "groups.codeNotice.APPROVAL")).not.toMatch(/автоматическ/i);
  });

  it("names the approval policy as the way to control an open link", () => {
    expect(translate("en", "groups.codeNotice.OPEN")).toMatch(/manual approval/);
    expect(translate("az", "groups.joinPolicy.APPROVAL")).toBe("Link ilə gələnlər müəllimin təsdiqini gözləyir");
  });

  it("fills in the usage numbers when the limit is reached", () => {
    for (const locale of ["az", "en", "ru"] as const) {
      expect(translate(locale, "groups.codeNotice.LIMIT_REACHED", { uses: 5, max: 5 })).toContain("5 / 5");
    }
  });

  it("never claims a closed link lets anyone in", () => {
    expect(translate("en", "groups.codeNotice.SELF_JOIN_OFF")).toMatch(/admits nobody/);
    expect(translate("en", "groups.codeNotice.CODE_OFF")).toMatch(/nobody can join/);
    expect(translate("az", "groups.codeNotice.SELF_JOIN_OFF")).toMatch(/heç kimi qəbul etmir/);
    expect(translate("ru", "groups.codeNotice.SELF_JOIN_OFF")).toMatch(/никого не принимает/);
  });
});
