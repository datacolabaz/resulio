import express from "express";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { syllabusPageTitle } from "../shared/syllabusJoin";
import {
  httpPreviewLookup,
  injectPreviewHead,
  parsePreview,
  previewResolver,
  syllabusPathCode,
  syllabusPreviewHead,
  syllabusPreviewText,
  type PreviewLookup,
  type SyllabusPreview,
} from "./_core/linkPreview";
import { mountSpa } from "./_core/spa";

const CODE = "4U5NEY4M7VUT";
const PREVIEW: SyllabusPreview = {
  title: "AI Engineering",
  subject: "Süni intellekt",
  moduleCount: 9,
  duration: { value: 9, unit: "MONTHS" },
  durationLabel: "",
  teacherName: "Telman Abdulla",
};
const ORIGIN = "https://resulio.co";
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

const head = (html: string) => html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
const metaContent = (html: string, attr: "name" | "property", key: string) =>
  [...html.matchAll(new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, "\\$&")}" content="([^"]*)" />`, "g"))].map((m) => m[1]);

describe("syllabus link preview text", () => {
  it("builds the Azerbaijani title and description from the public facts", () => {
    expect(syllabusPreviewText(PREVIEW)).toEqual({
      title: "AI Engineering — Syllabus | Resulio",
      description: "Süni intellekt · 9 modul · 9 ay. Müəllim: Telman Abdulla. Proqrama baxın və qoşulma sorğusu göndərin.",
    });
    expect(syllabusPreviewText({ ...PREVIEW, duration: { value: 6, unit: "WEEKS" } }).description).toContain("9 modul · 6 həftə.");
    expect(syllabusPreviewText({ ...PREVIEW, duration: null, durationLabel: "Təxminən 3 ay" }).description).toContain("· Təxminən 3 ay.");
  });

  it("leaves out missing facts without stray separators", () => {
    const bare = { ...PREVIEW, subject: "", moduleCount: 0, duration: null, teacherName: "" };
    expect(syllabusPreviewText(bare).description).toBe("Proqrama baxın və qoşulma sorğusu göndərin.");
    expect(syllabusPreviewText({ ...bare, teacherName: "X." }).description).toBe("Müəllim: X. Proqrama baxın və qoşulma sorğusu göndərin.");
    expect(syllabusPreviewText({ ...PREVIEW, title: "  " }).title).toBe("Syllabus | Resulio");
  });

  it("keeps long or multi-line teacher text to one short line", () => {
    const text = syllabusPreviewText({ ...PREVIEW, title: `A\n\nB ${"x".repeat(300)}`, teacherName: "Ad\nSoyad" });
    expect(text.title.startsWith("A B x")).toBe(true);
    expect(text.title.length).toBeLessThanOrEqual(100 + " — Syllabus | Resulio".length);
    expect(text.description).toContain("Müəllim: Ad Soyad.");
  });

  it("matches the title the page sets in the browser", () => {
    expect(syllabusPreviewText(PREVIEW).title).toBe(syllabusPageTitle(PREVIEW.title));
  });
});

describe("syllabus link preview head", () => {
  it("has every preview tag with absolute URLs", () => {
    const { title, tags } = syllabusPreviewHead({ status: "FOUND", code: CODE, preview: PREVIEW }, ORIGIN);
    const html = tags.join("\n");
    expect(title).toBe("AI Engineering — Syllabus | Resulio");
    expect(metaContent(html, "property", "og:title")).toEqual([title]);
    expect(metaContent(html, "name", "twitter:title")).toEqual([title]);
    expect(metaContent(html, "property", "og:url")).toEqual([`${ORIGIN}/syllabus/${CODE}`]);
    expect(metaContent(html, "property", "og:type")).toEqual(["website"]);
    expect(metaContent(html, "property", "og:image")).toEqual([`${ORIGIN}/brand/resulio-icon.png`]);
    expect(metaContent(html, "name", "twitter:image")).toEqual([`${ORIGIN}/brand/resulio-icon.png`]);
    expect(metaContent(html, "property", "og:image:width")).toEqual(["512"]);
    expect(metaContent(html, "property", "og:image:height")).toEqual(["512"]);
    expect(metaContent(html, "property", "og:image:alt")).toEqual(["Resulio"]);
    expect(metaContent(html, "name", "twitter:card")).toEqual(["summary"]);
    expect(metaContent(html, "name", "robots")).toEqual(["noindex, nofollow"]);
    const description = metaContent(html, "name", "description")[0];
    expect(description).toContain("9 modul");
    expect(metaContent(html, "property", "og:description")).toEqual([description]);
    expect(metaContent(html, "name", "twitter:description")).toEqual([description]);
  });

  it("escapes teacher-controlled text everywhere", () => {
    const evil = { ...PREVIEW, title: `"><script>alert(1)</script> $& $' Tom & Jerry`, subject: `<img src=x onerror=alert(1)>`, teacherName: `O'Brien "Q"` };
    const shell = injectPreviewHead(SHELL, syllabusPreviewHead({ status: "FOUND", code: CODE, preview: evil }, ORIGIN))!;
    expect(shell).not.toContain("<script>alert");
    expect(shell).not.toContain("<img");
    expect(shell).not.toMatch(/content="[^"]*"[^ />]/);
    expect(shell).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp; $&#39; Tom &amp; Jerry — Syllabus | Resulio");
    expect(shell).toContain("O&#39;Brien &quot;Q&quot;");
    // `$&` / `$'` stay literal instead of being expanded by String.replace.
    expect(shell.match(/<title>/g)).toHaveLength(1);
    expect(shell).not.toContain("Resulio — müəllimlər üçün");
  });

  it("falls back to syllabus-neutral text, never the exam-platform card", () => {
    const notFound = syllabusPreviewHead({ status: "NOT_FOUND", code: CODE }, ORIGIN);
    expect(notFound.title).toBe("Syllabus link — Resulio");
    expect(metaContent(notFound.tags.join("\n"), "name", "description")).toEqual(["Bu link aktiv deyil və ya tapılmadı."]);
    const unavailable = syllabusPreviewHead({ status: "UNAVAILABLE", code: CODE }, ORIGIN);
    expect(unavailable.title).toBe("Syllabus — Resulio");
    for (const h of [notFound, unavailable]) {
      const html = injectPreviewHead(SHELL, h)!;
      expect(head(html)).not.toContain(EXAM_PLATFORM_TEXT);
      expect(metaContent(html, "name", "robots")).toEqual(["noindex, nofollow"]);
    }
    expect(syllabusPreviewHead({ status: "NOT_FOUND", code: null }, ORIGIN).tags.join("")).not.toContain("og:url");
  });

  it("replaces the shell's title and description instead of duplicating them", () => {
    const html = injectPreviewHead(SHELL, syllabusPreviewHead({ status: "FOUND", code: CODE, preview: PREVIEW }, ORIGIN))!;
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/<meta name="description"/g)).toHaveLength(1);
    expect(html.match(/og:site_name/g)).toHaveLength(1);
    expect(html).toContain("<title>AI Engineering — Syllabus | Resulio</title>");
    const noSiteName = injectPreviewHead(SHELL.replace(/\s*<meta property="og:site_name"[^>]*>/, ""), syllabusPreviewHead({ status: "NOT_FOUND", code: null }, ORIGIN))!;
    expect(metaContent(noSiteName, "property", "og:site_name")).toEqual(["Resulio"]);
    expect(injectPreviewHead("<html><head></head></html>", syllabusPreviewHead({ status: "NOT_FOUND", code: null }, ORIGIN))).toBeNull();
  });
});

describe("syllabus link preview data", () => {
  it("only accepts /syllabus/<code> paths and normalises the code", () => {
    expect(syllabusPathCode(`/syllabus/${CODE}`)).toEqual({ code: CODE });
    expect(syllabusPathCode(`/syllabus/${CODE.toLowerCase()}/`)).toEqual({ code: CODE });
    expect(syllabusPathCode("/syllabus/not-a-code")).toEqual({ code: null });
    expect(syllabusPathCode("/syllabus/%E0%A4%A")).toEqual({ code: null });
    for (const p of ["/syllabus", "/syllabus/", `/syllabus/${CODE}/x`, `/teacher/syllabus/${CODE}`, `/join/${CODE}`, "/about"]) expect(syllabusPathCode(p)).toBeNull();
  });

  it("keeps only the preview fields of an API answer", () => {
    const parsed = parsePreview({ ...PREVIEW, lessons: ["secret lesson"], email: "t@example.com", ownerUserId: 7, duration: { value: -1, unit: "YEARS" } });
    expect(parsed).toEqual({ ...PREVIEW, duration: null });
    expect(Object.keys(parsed!).sort()).toEqual(["duration", "durationLabel", "moduleCount", "subject", "teacherName", "title"]);
    expect(parsePreview({ title: 5, moduleCount: "9" })).toEqual({ title: "", subject: "", moduleCount: 0, duration: null, durationLabel: "", teacherName: "" });
    expect(parsePreview(null)).toBeNull();
    const html = syllabusPreviewHead({ status: "FOUND", code: CODE, preview: parsed! }, ORIGIN).tags.join("");
    for (const secret of ["secret lesson", "t@example.com"]) expect(html).not.toContain(secret);
  });

  it("times out, never caches errors, and caches answers briefly", async () => {
    const hang: PreviewLookup = () => new Promise(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    expect(await previewResolver(hang, { timeoutMs: 50 })(CODE)).toEqual({ status: "UNAVAILABLE", code: CODE });
    expect(Date.now() - started).toBeLessThan(1000);

    let calls = 0;
    const flaky = previewResolver(async () => {
      calls++;
      if (calls === 1) throw new Error("db down");
      return PREVIEW;
    });
    expect((await flaky(CODE)).status).toBe("UNAVAILABLE");
    expect(await flaky(CODE)).toEqual({ status: "FOUND", code: CODE, preview: PREVIEW });
    expect(await flaky(CODE)).toEqual({ status: "FOUND", code: CODE, preview: PREVIEW });
    expect(calls).toBe(2);

    const lookup = vi.fn<PreviewLookup>(async () => null);
    const resolve = previewResolver(lookup);
    expect(await resolve(null)).toEqual({ status: "NOT_FOUND", code: null });
    expect(await resolve(CODE)).toEqual({ status: "NOT_FOUND", code: CODE });
    await resolve(CODE);
    expect(lookup).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("GET /syllabus/:code HTML", () => {
  let base = "";
  let apiBase = "";
  const servers: { close: () => void }[] = [];
  const listen = (app: express.Express) =>
    new Promise<string>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      servers.push(server);
    });

  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), "linkpreview-"));
    writeFileSync(join(dist, "index.html"), SHELL);
    mkdirSync(join(dist, "_pages"));
    writeFileSync(join(dist, "_pages", "about.html"), "<html><head><title>About</title></head></html>");

    // The API's preview endpoint as the frontend service sees it.
    const api = express();
    api.get("/api/public/syllabus-preview/:code", (req, res) => {
      if (req.params.code === "BRKN23456789") return void res.status(503).json({ error: "UNAVAILABLE" });
      if (req.params.code === "SLWW23456789") return void setTimeout(() => res.json({ preview: PREVIEW }), 3000);
      res.json({ preview: req.params.code === CODE ? { ...PREVIEW, lessons: ["secret lesson"] } : null });
    });
    apiBase = await listen(api);

    const app = express();
    mountSpa(app, dist, { syllabusPreview: httpPreviewLookup(apiBase, 500) });
    base = await listen(app);
  });
  afterAll(() => servers.forEach((s) => s.close()));

  const get = (path: string, ua = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)") =>
    fetch(`${base}${path}`, { headers: { "user-agent": ua } });

  it("serves the syllabus card to a crawler for a live code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const ua of ["facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A", "TelegramBot (like TwitterBot)"]) {
      const res = await get(`/syllabus/${CODE.toLowerCase()}`, ua);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const html = await res.text();
      expect(html).toContain("<title>AI Engineering — Syllabus | Resulio</title>");
      expect(metaContent(html, "property", "og:description")).toEqual(["Süni intellekt · 9 modul · 9 ay. Müəllim: Telman Abdulla. Proqrama baxın və qoşulma sorğusu göndərin."]);
      expect(metaContent(html, "property", "og:url")).toEqual([`https://resulio.co/syllabus/${CODE}`]);
      expect(html).not.toContain("secret lesson");
      expect(head(html)).not.toContain(EXAM_PLATFORM_TEXT);
      expect(html).toContain(`<div id="root"></div>`);
    }
  });

  it("serves the neutral card for unknown, malformed and unreachable codes", async () => {
    const unknown = await (await get("/syllabus/ZZZZZZZZZZZZ")).text();
    expect(unknown).toContain("<title>Syllabus link — Resulio</title>");
    const malformed = await (await get("/syllabus/%3Cscript%3E")).text();
    expect(malformed).toContain("<title>Syllabus link — Resulio</title>");
    expect(malformed).not.toContain("<script>");
    for (const code of ["BRKN23456789", "SLWW23456789"]) {
      const started = Date.now();
      const res = await get(`/syllabus/${code}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Syllabus — Resulio</title>");
      expect(Date.now() - started).toBeLessThan(2500);
    }
  });

  it("leaves other pages alone", async () => {
    expect(await (await get("/about")).text()).toContain("<title>About</title>");
    for (const path of [`/exam/${CODE}`, `/teacher/syllabus/${CODE}`, "/syllabus/"]) {
      const res = await get(path);
      expect(res.headers.get("x-robots-tag")).toBeNull();
      expect(await res.text()).toContain("<title>Resulio — müəllimlər üçün onlayn imtahan və qiymətləndirmə platforması</title>");
    }
    const headRes = await fetch(`${base}/syllabus/${CODE}`, { method: "HEAD" });
    expect(headRes.status).toBe(200);
    expect((await fetch(`${base}/syllabus/${CODE}`, { method: "POST" })).status).toBe(404);
  });

  it("serves a neutral card when no preview source is configured", async () => {
    const dist = mkdtempSync(join(tmpdir(), "linkpreview-"));
    writeFileSync(join(dist, "index.html"), SHELL);
    const app = express();
    mountSpa(app, dist);
    const url = await listen(app);
    expect(await (await fetch(`${url}/syllabus/${CODE}`)).text()).toContain("<title>Syllabus — Resulio</title>");
  });
});
