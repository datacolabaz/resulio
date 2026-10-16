import express from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { examPageTitle } from "../shared/taskMaterialShare";
import {
  examPathCode,
  examPreviewHead,
  examPreviewText,
  httpExamPreviewLookup,
  injectPreviewHead,
  isLinkPreviewPath,
  parseExamPreview,
  type ExamPreview,
} from "./_core/linkPreview";
import { mountSpa } from "./_core/spa";

const CODE = "AB12CD34EF";
const PREVIEW: ExamPreview = { title: "Say sistemləri — KSQ", description: "9-cu sinif üçün say sistemləri üzrə yekun sınaq imtahanı.", subject: "İnformatika", teacherName: "Telman Abdulla" };
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
const metaContent = (html: string, attr: "name" | "property", key: string) =>
  [...html.matchAll(new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, "\\$&")}" content="([^"]*)" />`, "g"))].map((m) => m[1]);
const headOf = (html: string) => html.slice(html.indexOf("<head>"), html.indexOf("</head>"));

describe("exam link preview text", () => {
  it("uses the exam's own title and description, not the site-wide card", () => {
    expect(examPreviewText(PREVIEW)).toEqual({
      title: "Say sistemləri — KSQ — İmtahan | Resulio",
      description: "9-cu sinif üçün say sistemləri üzrə yekun sınaq imtahanı. Müəllim: Telman Abdulla. İmtahana baxın.",
    });
    expect(examPreviewText(PREVIEW).title).toBe(examPageTitle(PREVIEW.title));
  });

  it("falls back to Fənn when there is no description", () => {
    expect(examPreviewText({ ...PREVIEW, description: "" }).description).toBe("Fənn: İnformatika. Müəllim: Telman Abdulla. İmtahana baxın.");
    expect(examPreviewText({ ...PREVIEW, description: "", subject: "", teacherName: "" }).description).toBe("İmtahana baxın.");
    expect(examPreviewText({ ...PREVIEW, title: " " }).title).toBe("İmtahan | Resulio");
  });

  it("falls back to exam-neutral text, never the generic exam-platform card", () => {
    const notFound = examPreviewHead({ status: "NOT_FOUND", code: CODE }, ORIGIN);
    expect(notFound.title).toBe("İmtahan linki — Resulio");
    const unavailable = examPreviewHead({ status: "UNAVAILABLE", code: CODE }, ORIGIN);
    expect(unavailable.title).toBe("İmtahan — Resulio");
    for (const h of [notFound, unavailable]) {
      const html = injectPreviewHead(SHELL, h)!;
      expect(headOf(html)).not.toContain(EXAM_PLATFORM_TEXT);
      expect(metaContent(html, "name", "robots")).toEqual(["noindex, nofollow"]);
    }
  });

  it("carries the exam's own share URL in og:url", () => {
    const html = examPreviewHead({ status: "FOUND", code: CODE, preview: PREVIEW }, ORIGIN).tags.join("\n");
    expect(metaContent(html, "property", "og:url")).toEqual([`${ORIGIN}/exam/${CODE}`]);
  });
});

describe("exam link preview data", () => {
  it("only accepts /exam/<code> paths and normalises the code", () => {
    expect(examPathCode(`/exam/${CODE}`)).toEqual({ code: CODE });
    expect(examPathCode(`/exam/${CODE.toLowerCase()}/`)).toEqual({ code: CODE });
    expect(examPathCode("/exam/a")).toEqual({ code: null });
    for (const p of ["/exam", "/exam/", `/exam/${CODE}/x`, `/task/${CODE}`, "/about"]) expect(examPathCode(p)).toBeNull();
    expect(isLinkPreviewPath(`/exam/${CODE}`)).toBe(true);
  });

  it("keeps only the preview fields of an API answer", () => {
    const parsed = parseExamPreview({ ...PREVIEW, questionCount: 20, durationSeconds: 3600 });
    expect(parsed).toEqual(PREVIEW);
    expect(Object.keys(parsed!).sort()).toEqual(["description", "subject", "teacherName", "title"]);
    expect(parseExamPreview({ title: 5 })).toEqual({ title: "", description: "", subject: "", teacherName: "" });
    expect(parseExamPreview(null)).toBeNull();
  });
});

describe("GET /exam/:code HTML", () => {
  let base = "";
  let apiBase = "";
  const servers: { close: () => void }[] = [];
  const listen = (app: express.Express) =>
    new Promise<string>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      servers.push(server);
    });

  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), "examlinkpreview-"));
    writeFileSync(join(dist, "index.html"), SHELL);

    // Like taskLinkPreview, the real DB-backed examLinkPreview in ./modules/examLinkPreview is a
    // thin single-row lookup over the current published version — not re-tested here (see
    // syllabusLinkPreview.test.ts for the same precedent).
    const api = express();
    api.get("/api/public/exam-preview/:code", (req, res) => {
      res.json({ preview: req.params.code === CODE ? { ...PREVIEW, questionCount: 20 } : null });
    });
    apiBase = await listen(api);

    const app = express();
    mountSpa(app, dist, { examPreview: httpExamPreviewLookup(apiBase, 500) });
    base = await listen(app);
  });
  afterAll(() => servers.forEach((s) => s.close()));

  const get = (path: string, ua = "WhatsApp/2.23.20.0 A") => fetch(`${base}${path}`, { headers: { "user-agent": ua } });

  it("serves the exam's own card to a crawler for a live code", async () => {
    for (const ua of ["facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A", "TelegramBot (like TwitterBot)"]) {
      const res = await get(`/exam/${CODE.toLowerCase()}`, ua);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const html = await res.text();
      expect(html).toContain("<title>Say sistemləri — KSQ — İmtahan | Resulio</title>");
      expect(metaContent(html, "property", "og:description")).toEqual([
        "9-cu sinif üçün say sistemləri üzrə yekun sınaq imtahanı. Müəllim: Telman Abdulla. İmtahana baxın.",
      ]);
      expect(headOf(html)).not.toContain(EXAM_PLATFORM_TEXT);
    }
  });

  it("falls back to the neutral exam card for an unknown code", async () => {
    const html = await (await get("/exam/ZZZZZZZZZZ")).text();
    expect(html).toContain("<title>İmtahan linki — Resulio</title>");
    expect(html).not.toContain("Say sistemləri");
  });

  it("leaves other pages alone (including the unrelated /report/ parent-token path)", async () => {
    for (const path of [`/report/${CODE}`, `/teacher/assessments`]) {
      const html = await (await get(path)).text();
      expect(html).toContain("<title>Resulio — müəllimlər üçün onlayn imtahan və qiymətləndirmə platforması</title>");
    }
  });
});
