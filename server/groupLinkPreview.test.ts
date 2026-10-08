import express from "express";
import { writeFileSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../client/src/i18n/messages";
import { GROUP_LEVELS } from "../shared/groupType";
import { groupPageTitle } from "../shared/groupLinks";
import {
  GROUP_LEVEL_AZ,
  groupPathKey,
  groupPreviewHead,
  groupPreviewText,
  httpGroupPreviewLookup,
  injectPreviewHead,
  parseGroupPreview,
  type GroupLinkPreview,
} from "./_core/linkPreview";
import { mountSpa } from "./_core/spa";

const m = vi.hoisted(() => ({
  publicInvite: vi.fn(),
  publicInviteLinkPreview: vi.fn(),
  publicEmailInvitePreview: vi.fn(),
}));
vi.mock("./modules/groups", () => ({ publicInvite: m.publicInvite }));
vi.mock("./modules/groupInviteLinks", () => ({ publicInviteLinkPreview: m.publicInviteLinkPreview }));
vi.mock("./modules/groupEmailInvites", () => ({ publicEmailInvitePreview: m.publicEmailInvitePreview }));

const { groupLinkPreview, groupPreviewRoute } = await import("./modules/groupLinkPreview");

const CODE = "AB12CD34EF";
const LINK = "a".repeat(20) + "B_-" + "c".repeat(20);
const EMAIL = "0123456789abcdef".repeat(4);
const ORIGIN = "https://resulio.co";
const COURSE: GroupLinkPreview = { name: "AI Engineering — Yaz axını", groupType: "COURSE", subject: "AI Engineering", grade: "", level: "BEGINNER", teacherName: "Telman Abdulla" };
const SCHOOL: GroupLinkPreview = { name: "9A riyaziyyat", groupType: "SCHOOL", subject: "Riyaziyyat", grade: "9A", level: "", teacherName: "Aynur Məmmədova" };
/** What the public join previews return besides the card's fields: none of it may reach the card. */
const PRIVATE = {
  description: "SECRET GROUP DESCRIPTION",
  language: "az",
  format: "ONLINE",
  joinPolicy: "AUTO",
  startDate: new Date("2026-11-01"),
  classSchedule: [{ day: "MON", time: "SECRET-17:00" }],
  teachingCategory: "SECRET_CATEGORY",
  teachingSubcategory: "SECRET_SUB",
};
const EXAM_PLATFORM_TEXT = "onlayn imtahan və qiymətləndirmə";
const SHELL = `<!doctype html>
<html lang="az">
  <head>
    <title>Resulio — müəllimlər üçün onlayn imtahan və qiymətləndirmə platforması</title>
    <meta name="description" content="Resulio onlayn imtahan və qiymətləndirmə platformasıdır." />
    <meta property="og:site_name" content="Resulio" />
  </head>
  <body><div id="root"></div></body>
</html>`;
const metaContent = (html: string, attr: "name" | "property", key: string) =>
  [...html.matchAll(new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, "\\$&")}" content="([^"]*)" />`, "g"))].map((x) => x[1]);
const headOf = (html: string) => html.slice(html.indexOf("<head>"), html.indexOf("</head>"));

describe("group link preview text", () => {
  it("uses the join page's facts in Azerbaijani", () => {
    expect(groupPreviewText(COURSE)).toEqual({
      title: "AI Engineering — Yaz axını — Qrup | Resulio",
      description: "İstiqamət: AI Engineering · Səviyyə: Başlanğıc. Müəllim: Telman Abdulla. Qrupa qoşulmaq üçün linkə daxil olun.",
    });
    expect(groupPreviewText(SCHOOL).description).toBe("Fənn: Riyaziyyat · Sinif: 9A. Müəllim: Aynur Məmmədova. Qrupa qoşulmaq üçün linkə daxil olun.");
    expect(groupPreviewText({ ...COURSE, level: "A2 / Junior" }).description).toContain("Səviyyə: A2 / Junior.");
    expect(groupPreviewText({ ...COURSE, subject: "", level: "", teacherName: "" }).description).toBe("Qrupa qoşulmaq üçün linkə daxil olun.");
    expect(groupPreviewText({ ...COURSE, name: " " }).title).toBe("Qrup | Resulio");
    expect(groupPreviewText(COURSE).title).toBe(groupPageTitle(COURSE.name));
  });

  it("labels known levels like the catalog does", () => {
    for (const level of GROUP_LEVELS) expect(GROUP_LEVEL_AZ[level]).toBe(translate("az", `groups.level.${level}`));
  });

  it("escapes teacher-controlled names everywhere", () => {
    const evil = { ...COURSE, name: `"><script>alert(1)</script> $& Tom & Jerry`, subject: "<img src=x onerror=alert(1)>", teacherName: `O'Brien "Q"` };
    const html = injectPreviewHead(SHELL, groupPreviewHead("code", { status: "FOUND", code: CODE, preview: evil }, ORIGIN))!;
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).toContain("<title>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp; Tom &amp; Jerry — Qrup | Resulio</title>");
    expect(html).toContain("O&#39;Brien &quot;Q&quot;");
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/<meta name="description"/g)).toHaveLength(1);
  });

  it("has the full tag set; og:url only for the group's own code, never a secret token", () => {
    const code = groupPreviewHead("code", { status: "FOUND", code: CODE, preview: COURSE }, ORIGIN).tags.join("\n");
    expect(metaContent(code, "property", "og:url")).toEqual([`${ORIGIN}/join/${CODE}`]);
    expect(metaContent(code, "property", "og:image")).toEqual([`${ORIGIN}/brand/resulio-icon.png`]);
    expect(metaContent(code, "name", "twitter:card")).toEqual(["summary"]);
    expect(metaContent(code, "name", "robots")).toEqual(["noindex, nofollow"]);
    expect(metaContent(code, "property", "og:title")).toEqual(["AI Engineering — Yaz axını — Qrup | Resulio"]);
    for (const [kind, key] of [["link", LINK], ["email", EMAIL]] as const) {
      const html = groupPreviewHead(kind, { status: "FOUND", code: key, preview: COURSE }, ORIGIN).tags.join("\n");
      expect(html).not.toContain("og:url");
      expect(html).not.toContain(key);
    }
  });

  it("falls back to a neutral group card, never the exam-platform text", () => {
    const dead = groupPreviewHead("code", { status: "NOT_FOUND", code: CODE }, ORIGIN);
    expect(dead.title).toBe("Qrup linki — Resulio");
    expect(metaContent(dead.tags.join("\n"), "name", "description")).toEqual(["Bu link aktiv deyil və ya tapılmadı."]);
    const unavailable = groupPreviewHead("link", { status: "UNAVAILABLE", code: LINK }, ORIGIN);
    expect(unavailable.title).toBe("Qrup dəvəti — Resulio");
    for (const h of [dead, unavailable]) expect(headOf(injectPreviewHead(SHELL, h)!)).not.toContain(EXAM_PLATFORM_TEXT);
  });
});

describe("group link paths", () => {
  it("recognises every group link format and normalises keys like the server", () => {
    expect(groupPathKey(`/join/${CODE.toLowerCase()}`)).toEqual({ kind: "code", key: CODE });
    expect(groupPathKey(`/join/${CODE}/`)).toEqual({ kind: "code", key: CODE });
    expect(groupPathKey(`/g/${LINK}`)).toEqual({ kind: "link", key: LINK });
    expect(groupPathKey(`/g/${LINK.toUpperCase()}`)).toEqual({ kind: "link", key: LINK.toUpperCase() });
    expect(groupPathKey(`/invite/${EMAIL}`)).toEqual({ kind: "email", key: EMAIL });
    expect(groupPathKey("/join/ab")).toEqual({ kind: "code", key: null });
    expect(groupPathKey("/g/short")).toEqual({ kind: "link", key: null });
    expect(groupPathKey("/invite/%3Cscript%3E")).toEqual({ kind: "email", key: null });
    for (const p of ["/join", "/join/", `/join/${CODE}/x`, "/groups/x", `/teacher/groups/${CODE}`, `/syllabus/${CODE}`]) expect(groupPathKey(p)).toBeNull();
  });

  it("keeps only the card's fields of an API answer", () => {
    const parsed = parseGroupPreview({ ...COURSE, ...PRIVATE, memberCount: 12 });
    expect(parsed).toEqual(COURSE);
    expect(parseGroupPreview({ name: 1, groupType: "X" })).toEqual({ name: "", groupType: "COURSE", subject: "", grade: "", level: "", teacherName: "" });
    expect(parseGroupPreview("x")).toBeNull();
  });
});

describe("group link preview lookup (the join pages' own gates)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the group's code only while it lets people join", async () => {
    m.publicInvite.mockResolvedValue({ ...COURSE, ...PRIVATE, rejection: null });
    expect(await groupLinkPreview("code", CODE.toLowerCase())).toEqual(COURSE);
    expect(m.publicInvite).toHaveBeenCalledWith(CODE);
    for (const rejection of ["INVITE_CODE_INACTIVE", "INVITE_CODE_EXPIRED", "GROUP_NOT_ACCEPTING"]) {
      m.publicInvite.mockResolvedValue({ ...COURSE, ...PRIVATE, rejection });
      expect(await groupLinkPreview("code", CODE)).toBeNull();
    }
    m.publicInvite.mockResolvedValue(null);
    expect(await groupLinkPreview("code", CODE)).toBeNull();
  });

  it("shows a single-use link only while unused, unrevoked and unexpired, as an anonymous viewer", async () => {
    m.publicInviteLinkPreview.mockResolvedValue({ state: "ACTIVE", linkId: "l1", group: { ...COURSE, ...PRIVATE } });
    expect(await groupLinkPreview("link", LINK)).toEqual(COURSE);
    expect(m.publicInviteLinkPreview).toHaveBeenCalledWith(LINK, null);
    for (const state of ["USED", "EXPIRED", "REVOKED", "NOT_FOUND"]) {
      m.publicInviteLinkPreview.mockResolvedValue({ state });
      expect(await groupLinkPreview("link", LINK)).toBeNull();
    }
  });

  it("shows an e-mail invite only while pending, never the e-mail", async () => {
    m.publicEmailInvitePreview.mockResolvedValue({ ...SCHOOL, ...PRIVATE, email: "student@example.com" });
    const preview = await groupLinkPreview("email", EMAIL);
    expect(preview).toEqual(SCHOOL);
    expect(JSON.stringify(preview)).not.toContain("student@example.com");
    m.publicEmailInvitePreview.mockResolvedValue(null);
    expect(await groupLinkPreview("email", EMAIL)).toBeNull();
  });

  it("never looks up malformed keys", async () => {
    expect(await groupLinkPreview("code", "<x>")).toBeNull();
    expect(await groupLinkPreview("link", "short")).toBeNull();
    expect(await groupLinkPreview("email", "not hex!")).toBeNull();
    expect(m.publicInvite).not.toHaveBeenCalled();
    expect(m.publicInviteLinkPreview).not.toHaveBeenCalled();
    expect(m.publicEmailInvitePreview).not.toHaveBeenCalled();
  });
});

describe("GET group link HTML through the frontend service", () => {
  const servers: { close: () => void }[] = [];
  let base = "";
  let api = "";
  const listen = (app: express.Express) =>
    new Promise<string>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      servers.push(server);
    });

  beforeAll(async () => {
    const apiApp = express();
    apiApp.get("/api/public/group-preview/:kind/:key", groupPreviewRoute);
    api = await listen(apiApp);
    const dist = mkdtempSync(join(tmpdir(), "grouppreview-"));
    writeFileSync(join(dist, "index.html"), SHELL);
    const app = express();
    mountSpa(app, dist, { groupPreview: httpGroupPreviewLookup(api, 500) });
    base = await listen(app);
  });
  afterAll(() => servers.forEach((s) => s.close()));
  beforeEach(() => {
    m.publicInvite.mockImplementation(async (code: string) => (code === CODE ? { ...COURSE, ...PRIVATE, rejection: null } : code === "DEAD123456" ? { ...COURSE, rejection: "INVITE_CODE_INACTIVE" } : null));
    m.publicInviteLinkPreview.mockImplementation(async (token: string) => (token === LINK ? { state: "ACTIVE", linkId: "l1", group: { ...SCHOOL, ...PRIVATE } } : { state: "USED" }));
    m.publicEmailInvitePreview.mockImplementation(async (token: string) => (token === EMAIL ? { ...COURSE, ...PRIVATE } : null));
  });

  const get = (path: string, ua = "WhatsApp/2.23.20.0 A") => fetch(`${base}${path}`, { headers: { "user-agent": ua } });

  it("serves the group card to crawlers for live links of every format", async () => {
    for (const [path, title] of [
      [`/join/${CODE}`, "AI Engineering — Yaz axını — Qrup | Resulio"],
      [`/g/${LINK}`, "9A riyaziyyat — Qrup | Resulio"],
      [`/invite/${EMAIL}`, "AI Engineering — Yaz axını — Qrup | Resulio"],
    ]) {
      for (const ua of ["facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A", "TelegramBot (like TwitterBot)"]) {
        const res = await get(path, ua);
        expect(res.status).toBe(200);
        expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        const html = await res.text();
        expect(html).toContain(`<title>${title}</title>`);
        expect(metaContent(html, "property", "og:description")[0]).toMatch(/Qrupa qoşulmaq üçün linkə daxil olun\.$/);
        for (const secret of ["SECRET", "student@example.com"]) expect(html).not.toContain(secret);
        expect(headOf(html)).not.toContain(EXAM_PLATFORM_TEXT);
      }
    }
  });

  it("serves the same neutral card for dead, unknown and malformed links", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const path of ["/join/DEAD123456", "/join/UNKNOWN999", "/join/%3Cx%3E", `/g/${"z".repeat(43)}`, "/g/short", `/invite/${"f".repeat(64)}`]) {
      const html = await (await get(path)).text();
      expect(html).toContain("<title>Qrup linki — Resulio</title>");
      expect(metaContent(html, "name", "description")).toEqual(["Bu link aktiv deyil və ya tapılmadı."]);
      expect(html).not.toContain("AI Engineering");
    }
  });

  it("keeps working when the API is down", async () => {
    const dist = mkdtempSync(join(tmpdir(), "grouppreview-"));
    writeFileSync(join(dist, "index.html"), SHELL);
    const app = express();
    mountSpa(app, dist, { groupPreview: httpGroupPreviewLookup("http://127.0.0.1:9", 300) });
    const url = await listen(app);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetch(`${url}/join/${CODE}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Qrup dəvəti — Resulio</title>");
  });

  it("answers unknown kinds with 404 on the API", async () => {
    expect((await fetch(`${api}/api/public/group-preview/other/${CODE}`)).status).toBe(404);
    expect(await (await fetch(`${api}/api/public/group-preview/code/${CODE}`)).json()).toEqual({ preview: COURSE });
  });
});
