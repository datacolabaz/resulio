import { describe, expect, it } from "vitest";
import { catalog } from "../client/src/i18n/catalog";
import { translate, type MessageKey } from "../client/src/i18n/messages";
import { attemptLabel, azOrdinal, earlierVariantRows, resultTitle, variantLabel } from "../client/src/lib/attemptLabel";
import { afterPublish, changeSummary, liveGrants, publishState, type PublishShape } from "../client/src/lib/syllabusPublishState";
import { joinNoticeKey, planJoinNotices } from "./syllabus/notify";

const draft: PublishShape = { currentVersionId: null, hasDraftChanges: true, archivedAt: null };
const LOCALES = ["az", "en", "ru"] as const;

describe("syllabus status in plain words", () => {
  it("never published: hidden from students, the action is Publish", () => {
    expect(publishState(draft, 0)).toEqual({ visibility: "HIDDEN", unsentChanges: false, action: "PUBLISH", firstPublish: true });
    expect(publishState(draft, 3).visibility).toBe("HIDDEN");
  });

  it("published but opened to nobody: says so and offers opening it to a group", () => {
    expect(publishState({ currentVersionId: "v1", hasDraftChanges: false, archivedAt: null }, 0)).toMatchObject({ visibility: "READY", action: "GRANT" });
  });

  it("published and granted: visible, nothing to do", () => {
    expect(publishState({ currentVersionId: "v1", hasDraftChanges: false, archivedAt: null }, 2)).toMatchObject({ visibility: "LIVE", unsentChanges: false, action: null });
  });

  it("edits after publishing are 'changes not sent', and the action becomes Send changes", () => {
    expect(publishState({ currentVersionId: "v1", hasDraftChanges: true, archivedAt: null }, 2)).toMatchObject({ visibility: "LIVE", unsentChanges: true, action: "SEND_CHANGES" });
    expect(publishState({ currentVersionId: "v1", hasDraftChanges: true, archivedAt: null }, 0)).toMatchObject({ visibility: "READY", action: "SEND_CHANGES" });
  });

  it("archived: no action and no 'unsent' badge", () => {
    expect(publishState({ currentVersionId: "v1", hasDraftChanges: true, archivedAt: new Date() }, 2)).toEqual({ visibility: "ARCHIVED", unsentChanges: false, action: null, firstPublish: false });
  });

  it("walks the publish → edit → send changes cycle without dead ends", () => {
    let s: PublishShape = { ...draft };
    expect(publishState(s, 1).action).toBe("PUBLISH");
    s = { ...s, currentVersionId: "v1", hasDraftChanges: false };
    expect(publishState(s, 1)).toMatchObject({ visibility: "LIVE", action: null });
    s = { ...s, hasDraftChanges: true };
    expect(publishState(s, 1)).toMatchObject({ visibility: "LIVE", unsentChanges: true, action: "SEND_CHANGES" });
    s = { ...s, currentVersionId: "v2", hasDraftChanges: false };
    expect(publishState(s, 1)).toMatchObject({ visibility: "LIVE", unsentChanges: false, action: null });
  });

  it("counts only grants that give access now or later", () => {
    expect(liveGrants(undefined)).toBeNull();
    expect(liveGrants([{ state: "ACTIVE" }, { state: "PENDING" }, { state: "EXPIRED" }, { state: "REVOKED" }])).toHaveLength(2);
  });

  it("has every status text in all languages, without draft or version jargon", () => {
    const keys = ["HIDDEN", "READY", "LIVE", "ARCHIVED"].map((v) => `syllabus.visibility.${v}`).concat("syllabus.draftChanges", "syllabus.action.sendChanges", "syllabus.status.DRAFT", "live.DRAFT");
    for (const k of keys) {
      expect(catalog).toHaveProperty(k);
      for (const l of LOCALES) expect(translate(l, k as MessageKey)).not.toMatch(/Qaralama|Draft|Черновик|\bv\d/);
    }
  });
});

describe("after the publish request", () => {
  const base = { selectedGroupIds: ["g1", "g2", "g2"], grantedGroupIds: ["g1"], selectedStudentIds: [7, 8], grantedStudentIds: [8], moveEnrolled: true, enrolled: 4 };

  it("first publish opens it to the newly chosen groups and students only", () => {
    expect(afterPublish({ ...base, firstPublish: true })).toEqual({ grantGroupIds: ["g2"], grantStudentIds: [7], grant: true, moveAll: false });
    expect(afterPublish({ ...base, firstPublish: true, selectedGroupIds: [], selectedStudentIds: [] }).grant).toBe(false);
  });

  it("sending changes updates students already learning when asked, and grants nothing", () => {
    expect(afterPublish({ ...base, firstPublish: false })).toEqual({ grantGroupIds: [], grantStudentIds: [], grant: false, moveAll: true });
    expect(afterPublish({ ...base, firstPublish: false, moveEnrolled: false }).moveAll).toBe(false);
    expect(afterPublish({ ...base, firstPublish: false, enrolled: 0 }).moveAll).toBe(false);
  });
});

describe("no version jargon in the app texts", () => {
  it("no Azerbaijani text says 'versiya' or a bare 'v2', except the landing page's marketing copy", () => {
    const allowed = new Set(["landing.section.builder.body"]);
    const offenders = Object.entries(catalog as Record<string, readonly string[]>)
      .filter(([k, v]) => !allowed.has(k) && /versiya|\bv\d/i.test(v[0]))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });
});

describe("publish dialog wording", () => {
  const none = { added: 0, removed: 0, changed: 0 };
  const diff = { modules: { ...none, added: 1 }, lessons: { ...none, changed: 2 }, items: none, reordered: false, rulesChanged: true };

  it("summarises changes in plain phrases, skipping what didn't change", () => {
    const parts = changeSummary(diff);
    expect(parts).toEqual([{ key: "modules.added", count: 1 }, { key: "lessons.changed", count: 2 }, { key: "rulesChanged" }]);
    const text = parts.map((p) => translate("az", `pub.sum.${p.key}` as MessageKey, p.count === undefined ? undefined : { count: p.count })).join(", ");
    expect(text).toBe("1 modul əlavə olunub, 2 dərs dəyişdirilib, tamamlama qaydaları dəyişib");
    expect(changeSummary({ modules: none, lessons: none, items: none, reordered: false, rulesChanged: false })).toEqual([]);
  });

  it("has a phrase for every kind of change in all languages", () => {
    const all = changeSummary({ modules: { added: 1, removed: 1, changed: 1 }, lessons: { added: 1, removed: 1, changed: 1 }, items: { added: 1, removed: 1, changed: 1 }, reordered: true, rulesChanged: true });
    expect(all).toHaveLength(11);
    for (const p of all) expect(catalog).toHaveProperty(`pub.sum.${p.key}`);
  });

  it("first publish says what opens in one sentence, with no version fields", () => {
    expect(translate("az", "pub.counts", { modules: 9, lessons: 136 })).toBe("9 modul və 136 dərs tələbələrə açılacaq.");
    expect(translate("en", "pub.counts", { modules: 1, lessons: 2 })).toBe("1 module and 2 lessons will open to students.");
    expect(translate("az", "pub.firstTitle")).toBe("Tələbələrə göstər");
    expect(translate("az", "pub.editLater")).toBe("Sonra da redaktə edə bilərsiniz.");
    expect(translate("az", "pub.noteToggle")).toBe("Əlavə qeyd (istəyə bağlı)");
    expect(translate("az", "pub.moveEnrolled")).toBe("Kursa artıq başlamış tələbələr də yenilənmiş məzmunu görsün");
    for (const k of ["pub.firstTitle", "pub.sendTitle", "pub.counts", "pub.notReady", "pub.changed", "pub.moveEnrolled", "pub.moveEnrolledHelp", "pub.editLater"] as const)
      for (const l of LOCALES) expect(translate(l, k, { modules: 1, lessons: 1, what: "x", count: 1 })).not.toMatch(/versiya|version|верси|Qaralama|Draft|Черновик/i);
  });
});

describe("students joining a group later", () => {
  const now = new Date("2026-10-08T10:00:00Z");
  const grant = (over: Partial<{ syllabusId: string; groupId: string | null; status: "ACTIVE" | "REVOKED"; startsAt: Date | null; endsAt: Date | null }> = {}) => ({
    syllabusId: "s1",
    groupId: "g1",
    status: "ACTIVE" as const,
    startsAt: null,
    endsAt: null,
    ...over,
  });
  const published = { id: "s1", currentVersionId: "v1", archivedAt: null };

  it("hear about published syllabi open to that group", () => {
    expect(planJoinNotices("g1", [grant()], [published], new Set(), now)).toEqual(["s1"]);
    expect(planJoinNotices("g1", [grant({ startsAt: new Date("2026-11-01") })], [published], new Set(), now)).toEqual(["s1"]);
  });

  it("not about revoked, expired, other-group, unpublished, archived or already-started syllabi", () => {
    expect(planJoinNotices("g1", [grant({ status: "REVOKED" })], [published], new Set(), now)).toEqual([]);
    expect(planJoinNotices("g1", [grant({ endsAt: new Date("2026-01-01") })], [published], new Set(), now)).toEqual([]);
    expect(planJoinNotices("g1", [grant({ groupId: "g2" })], [published], new Set(), now)).toEqual([]);
    expect(planJoinNotices("g1", [grant()], [{ ...published, currentVersionId: null }], new Set(), now)).toEqual([]);
    expect(planJoinNotices("g1", [grant()], [{ ...published, archivedAt: now }], new Set(), now)).toEqual([]);
    expect(planJoinNotices("g1", [grant()], [published], new Set(["s1"]), now)).toEqual([]);
  });

  it("uses one notice key per student and syllabus, so re-joining never repeats it", () => {
    expect(joinNoticeKey("s1", 5)).toBe(joinNoticeKey("s1", 5));
    expect(joinNoticeKey("s1", 5)).not.toBe(joinNoticeKey("s1", 6));
    expect(joinNoticeKey("s1", 5)).not.toBe(joinNoticeKey("s2", 5));
  });
});

describe("attempt and exam variant labels", () => {
  it("writes Azerbaijani ordinals with vowel harmony", () => {
    const cases: Array<[number, string]> = [
      [1, "1-ci"], [2, "2-ci"], [3, "3-cü"], [4, "4-cü"], [5, "5-ci"], [6, "6-cı"], [7, "7-ci"], [8, "8-ci"], [9, "9-cu"],
      [10, "10-cu"], [11, "11-ci"], [20, "20-ci"], [30, "30-cu"], [40, "40-cı"], [50, "50-ci"], [60, "60-cı"], [90, "90-cı"], [100, "100-cü"], [1000, "1000-ci"],
    ];
    for (const [n, text] of cases) expect(azOrdinal(n)).toBe(text);
  });

  it("names the attempt naturally and never mentions the version", () => {
    expect(attemptLabel(1, "az")).toBe("1-ci cəhd");
    expect(attemptLabel(3, "az")).toBe("3-cü cəhd");
    expect(attemptLabel(1, "en")).toBe("Attempt 1");
    expect(attemptLabel(2, "ru")).toBe("Попытка 2");
    expect(resultTitle("Sınaq1", 1, "az")).toBe("Sınaq1 · 1-ci cəhd");
    for (const l of LOCALES) expect(resultTitle("Sınaq1", 2, l)).not.toMatch(/\bv\d|#/);
  });

  it("names variants only in plain words", () => {
    expect(variantLabel(2, "az")).toBe("2-ci variant");
    expect(variantLabel(2, "en")).toBe("Variant 2");
    expect(variantLabel(2, "ru")).toBe("Вариант 2");
  });

  it("marks an earlier variant only when the same student and exam has results from several variants", () => {
    const row = (id: string, studentId: number, versionId: string, latestVariant: boolean, assessmentId = "a1") => ({ id, studentId, assessmentId, versionId, latestVariant });
    expect([...earlierVariantRows([row("r1", 1, "v1", false), row("r2", 1, "v2", true)])]).toEqual(["r1"]);
    expect([...earlierVariantRows([row("r1", 1, "v1", false), row("r2", 2, "v2", true)])]).toEqual([]);
    expect([...earlierVariantRows([row("r1", 1, "v1", false), row("r2", 1, "v1", false)])]).toEqual([]);
    expect([...earlierVariantRows([row("r1", 1, "v1", false, "a1"), row("r2", 1, "v2", true, "a2")])]).toEqual([]);
  });

  it("explains the earlier variant in every language", () => {
    for (const l of LOCALES) expect(translate(l, "attempt.earlierVariant").length).toBeGreaterThan(20);
  });
});
