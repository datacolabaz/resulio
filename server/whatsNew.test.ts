import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { catalog } from "../client/src/i18n/catalog";
import { HOME } from "../client/src/seo/pages";
import {
  addMarks,
  badgeFor,
  DEFAULT_WHATS_NEW_DAYS,
  entriesVisitedAt,
  freshEntries,
  isHandled,
  landingEntries,
  matchesRoute,
  mergeMarks,
  WHATS_NEW,
  WHATS_NEW_ICONS,
  WHATS_NEW_IDS,
  whatsNewKeys,
  withinWindow,
  type WhatsNewEntry,
} from "../shared/whatsNew";

const db = vi.hoisted(() => ({ fail: null as unknown, rows: [] as unknown[], inserted: [] as unknown[], updateSet: null as unknown }));
vi.mock("./db", () => ({
  requireDb: () => ({
    select: () => ({
      from: () => ({ where: async () => (db.fail ? Promise.reject(db.fail) : db.rows) }),
    }),
    insert: () => ({
      values: (v: unknown[]) => {
        db.inserted = v;
        return {
          onDuplicateKeyUpdate: async ({ set }: { set: unknown }) => {
            db.updateSet = set;
            if (db.fail) throw db.fail;
          },
        };
      },
    }),
  }),
}));

const { markWhatsNew, whatsNewState } = await import("./whatsNew");

const ALL = { studyCoach: true, studentGrowth: true, teacherGrowth: true, coachShares: true, mcpConnector: true };
const at = (iso: string) => new Date(iso);
const entry = (over: Partial<WhatsNewEntry>): WhatsNewEntry => ({ id: "x", audiences: ["student"], releasedAt: "2026-10-12", route: "/student/x", icon: "sparkles", cta: "try", ...over });
const missingTable = () => Object.assign(new Error("Failed query"), { cause: { errno: 1146, code: "ER_NO_SUCH_TABLE" } });

describe("whats-new registry", () => {
  it("has unique, storable ids, known icons and valid dates", () => {
    expect(new Set(WHATS_NEW_IDS).size).toBe(WHATS_NEW.length);
    for (const e of WHATS_NEW) {
      expect(e.id).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(WHATS_NEW_ICONS).toContain(e.icon);
      expect(e.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(e.releasedAt))).toBe(false);
      if (e.audiences.some((a) => a !== "public")) expect(e.route, e.id).toMatch(/^\//);
    }
  });

  it("has az/en/ru texts for every entry, and landing texts for public ones", () => {
    for (const e of WHATS_NEW) {
      const keys = whatsNewKeys(e);
      const needed = [keys.title, keys.body, ...(e.audiences.includes("public") ? [keys.landing, ...keys.points] : [])];
      for (const k of needed) expect(catalog, k).toHaveProperty([k]);
      if (e.audiences.includes("public")) expect(e.points ?? 0, e.id).toBeGreaterThan(0);
    }
  });

  it("points every in-app route at a real page", () => {
    const app = readFileSync(join(__dirname, "..", "client", "src", "App.tsx"), "utf8");
    for (const e of WHATS_NEW) if (e.route) expect(app, e.route).toContain(`path="${e.route}"`);
  });

  it("puts the public entries into the prerendered home page", () => {
    const section = HOME.sections.find((s) => s.heading === "whatsNew.landing.title");
    expect(section?.items).toEqual(landingEntries().map((e) => whatsNewKeys(e).landing));
  });
});

describe("whats-new filtering", () => {
  const now = at("2026-10-14T09:00:00Z");

  it("filters by audience and shows the newest first", () => {
    const student = freshEntries(["student"], { now, available: ALL, state: {} }).map((e) => e.id);
    const teacher = freshEntries(["teacher"], { now, available: ALL, state: {} }).map((e) => e.id);
    expect(student).toEqual(["study-coach", "growth-plan"]);
    expect(teacher).toEqual(["claude-connector", "coach-shares", "risk-radar", "group-approval"]);
  });

  it("hides features the user cannot open (flags, entitlement, nothing shared)", () => {
    const student = freshEntries(["student"], { now, available: { studyCoach: true }, state: {} }).map((e) => e.id);
    expect(student).toEqual(["study-coach"]);
    const teacher = freshEntries(["teacher"], { now, available: {}, state: {} }).map((e) => e.id);
    expect(teacher).toEqual(["group-approval"]);
  });

  it("starts at midnight Baku on the release day and ends after the window", () => {
    const e = entry({ releasedAt: "2026-10-12" });
    expect(withinWindow(e, at("2026-10-11T19:59:59Z"))).toBe(false);
    expect(withinWindow(e, at("2026-10-11T20:00:00Z"))).toBe(true);
    const lastMoment = new Date(Date.parse("2026-10-11T20:00:00Z") + DEFAULT_WHATS_NEW_DAYS * 86_400_000 - 1);
    expect(withinWindow(e, lastMoment)).toBe(true);
    expect(withinWindow(e, new Date(lastMoment.getTime() + 1))).toBe(false);
    expect(withinWindow(entry({ days: 7 }), at("2026-10-19T20:00:00Z"))).toBe(false);
    expect(freshEntries(["student", "teacher"], { now: at("2027-01-01T00:00:00Z"), available: ALL, state: {} })).toEqual([]);
  });

  it("drops an entry once it is seen or dismissed", () => {
    const state = { "study-coach": { seenAt: new Date() }, "growth-plan": { dismissedAt: 1 } };
    expect(freshEntries(["student"], { now, available: ALL, state })).toEqual([]);
    expect(isHandled(undefined)).toBe(false);
    expect(isHandled({ seenAt: null, dismissedAt: null })).toBe(false);
  });

  it("badges the sidebar item of the entry's page, for its own audience only", () => {
    const fresh = freshEntries(["student", "teacher"], { now, available: ALL, state: {} });
    expect(badgeFor("/student/coach", fresh, "student")?.id).toBe("study-coach");
    expect(badgeFor("/settings", fresh, "teacher")?.id).toBe("claude-connector");
    expect(badgeFor("/settings", fresh, "student")).toBeUndefined();
    expect(badgeFor("/student/progress", fresh, "student")).toBeUndefined();
  });

  it("marks an entry visited on its page and the pages below it", () => {
    expect(matchesRoute("/student/coach", "/student/coach")).toBe(true);
    expect(matchesRoute("/student/coach", "/student/coach/m/12")).toBe(true);
    expect(matchesRoute("/student/coach", "/student/coach/")).toBe(true);
    expect(matchesRoute("/settings", "/settings#claude-connector")).toBe(true);
    expect(matchesRoute("/student/coach", "/student/coaching")).toBe(false);
    expect(matchesRoute("/student/coach", "/student")).toBe(false);
    const fresh = freshEntries(["student", "teacher"], { now, available: ALL, state: {} });
    expect(entriesVisitedAt("/student/coach/t/5", fresh).map((e) => e.id)).toEqual(["study-coach"]);
    expect(entriesVisitedAt("/student", fresh)).toEqual([]);
  });

  it("lists public entries on the landing page whatever the window", () => {
    expect(landingEntries().map((e) => e.id)).toEqual(["claude-connector", "study-coach", "growth-plan", "risk-radar", "group-approval"]);
  });
});

describe("whats-new marks", () => {
  it("keeps the first time of each mark", () => {
    const once = addMarks({}, ["a"], "seen", 100);
    const twice = addMarks(once, ["a", "b"], "seen", 200);
    expect(twice).toEqual({ a: { seenAt: 100 }, b: { seenAt: 200 } });
    expect(addMarks(twice, ["a"], "dismissed", 300)).toEqual({ a: { seenAt: 100, dismissedAt: 300 }, b: { seenAt: 200 } });
  });

  it("merges server and local marks; either side hides the entry", () => {
    const state = mergeMarks({ a: { dismissedAt: 5 }, c: { seenAt: 9 } }, [
      { featureId: "a", seenAt: null, dismissedAt: null },
      { featureId: "b", seenAt: "2026-10-13", dismissedAt: null },
    ]);
    expect(isHandled(state.a)).toBe(true);
    expect(isHandled(state.b)).toBe(true);
    expect(isHandled(state.c)).toBe(true);
    expect(isHandled(state.d)).toBe(false);
  });
});

describe("whats-new store", () => {
  it("reads the user's marks", async () => {
    db.fail = null;
    db.rows = [{ featureId: "study-coach", seenAt: new Date(), dismissedAt: null }];
    expect(await whatsNewState(7)).toEqual({ ready: true, items: db.rows });
  });

  it("answers ready: false before migration 0060 instead of failing", async () => {
    db.fail = missingTable();
    expect(await whatsNewState(7)).toEqual({ ready: false, items: [] });
    expect(await markWhatsNew(7, ["study-coach"], "seen")).toEqual({ ready: false });
  });

  it("upserts one row per feature and keeps an earlier time", async () => {
    db.fail = null;
    const now = new Date("2026-10-13T10:00:00Z");
    expect(await markWhatsNew(7, ["study-coach", "study-coach", "growth-plan"], "dismissed", now)).toEqual({ ready: true });
    expect(db.inserted).toEqual([
      { userId: 7, featureId: "study-coach", dismissedAt: now },
      { userId: 7, featureId: "growth-plan", dismissedAt: now },
    ]);
    expect(Object.keys(db.updateSet as object)).toEqual(["dismissedAt"]);
  });

  it("rethrows other database errors", async () => {
    db.fail = new Error("connection lost");
    await expect(whatsNewState(7)).rejects.toThrow("connection lost");
  });
});
