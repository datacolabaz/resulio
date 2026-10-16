import express from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskPageTitle } from "../shared/taskMaterialShare";
import {
  httpTaskPreviewLookup,
  injectPreviewHead,
  isLinkPreviewPath,
  parseTaskPreview,
  taskPathCode,
  taskPreviewHead,
  taskPreviewText,
  type TaskPreview,
} from "./_core/linkPreview";
import { mountSpa } from "./_core/spa";

const CODE = "AB12CD34EF";
const PREVIEW: TaskPreview = { title: "Excel: XLOOKUP/VLOOKUP", description: "Faylı endirin, tapşırığı yerinə yetirin və cavabınızı yükləyin.", teacherName: "Telman Abdulla" };
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

describe("task link preview text", () => {
  it("uses the task's own title and description, not the site-wide card", () => {
    expect(taskPreviewText(PREVIEW)).toEqual({
      title: "Excel: XLOOKUP/VLOOKUP — Tapşırıq | Resulio",
      description: "Faylı endirin, tapşırığı yerinə yetirin və cavabınızı yükləyin. Müəllim: Telman Abdulla. Tapşırığa baxın.",
    });
    expect(taskPreviewText(PREVIEW).title).toBe(taskPageTitle(PREVIEW.title));
  });

  it("falls back to the teacher + CTA alone when there is no description", () => {
    expect(taskPreviewText({ ...PREVIEW, description: "" }).description).toBe("Müəllim: Telman Abdulla. Tapşırığa baxın.");
    expect(taskPreviewText({ ...PREVIEW, description: "  ", teacherName: "" }).description).toBe("Tapşırığa baxın.");
    expect(taskPreviewText({ ...PREVIEW, title: " " }).title).toBe("Tapşırıq | Resulio");
  });

  it("keeps a long description to one short line", () => {
    const text = taskPreviewText({ ...PREVIEW, description: `Sətir 1\n\nSətir 2 ${"x".repeat(300)}` });
    expect(text.description.startsWith("Sətir 1 Sətir 2 x")).toBe(true);
    expect(text.description.length).toBeLessThan(260);
  });

  it("escapes teacher-controlled text everywhere", () => {
    const evil = { ...PREVIEW, title: `"><script>alert(1)</script> & Tom`, description: `<img src=x onerror=alert(1)>` };
    const html = injectPreviewHead(SHELL, taskPreviewHead({ status: "FOUND", code: CODE, preview: evil }, ORIGIN))!;
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; Tom — Tapşırıq | Resulio");
    expect(html.match(/<title>/g)).toHaveLength(1);
  });

  it("falls back to task-neutral text, never the exam-platform card", () => {
    const notFound = taskPreviewHead({ status: "NOT_FOUND", code: CODE }, ORIGIN);
    expect(notFound.title).toBe("Tapşırıq linki — Resulio");
    expect(metaContent(notFound.tags.join("\n"), "name", "description")).toEqual(["Bu link aktiv deyil və ya tapılmadı."]);
    const unavailable = taskPreviewHead({ status: "UNAVAILABLE", code: CODE }, ORIGIN);
    expect(unavailable.title).toBe("Tapşırıq — Resulio");
    for (const h of [notFound, unavailable]) {
      const html = injectPreviewHead(SHELL, h)!;
      expect(headOf(html)).not.toContain(EXAM_PLATFORM_TEXT);
      expect(metaContent(html, "name", "robots")).toEqual(["noindex, nofollow"]);
    }
  });

  it("carries the task's own share URL in og:url", () => {
    const html = taskPreviewHead({ status: "FOUND", code: CODE, preview: PREVIEW }, ORIGIN).tags.join("\n");
    expect(metaContent(html, "property", "og:url")).toEqual([`${ORIGIN}/task/${CODE}`]);
  });
});

describe("task link preview data", () => {
  it("only accepts /task/<code> paths and normalises the code", () => {
    expect(taskPathCode(`/task/${CODE}`)).toEqual({ code: CODE });
    expect(taskPathCode(`/task/${CODE.toLowerCase()}/`)).toEqual({ code: CODE });
    expect(taskPathCode("/task/a")).toEqual({ code: null });
    expect(taskPathCode("/task/not-a-code!")).toEqual({ code: null });
    for (const p of ["/task", "/task/", `/task/${CODE}/x`, `/material/${CODE}`, `/syllabus/${CODE}`, "/about"]) expect(taskPathCode(p)).toBeNull();
    expect(isLinkPreviewPath(`/task/${CODE}`)).toBe(true);
  });

  it("keeps only the preview fields of an API answer", () => {
    const parsed = parseTaskPreview({ ...PREVIEW, attachments: [{ fileId: "secret-file" }], id: "t1" });
    expect(parsed).toEqual(PREVIEW);
    expect(Object.keys(parsed!).sort()).toEqual(["description", "teacherName", "title"]);
    expect(parseTaskPreview({ title: 5 })).toEqual({ title: "", description: "", teacherName: "" });
    expect(parseTaskPreview(null)).toBeNull();
    const html = taskPreviewHead({ status: "FOUND", code: CODE, preview: parsed! }, ORIGIN).tags.join("");
    expect(html).not.toContain("secret-file");
  });
});

describe("GET /task/:code HTML", () => {
  let base = "";
  let apiBase = "";
  const servers: { close: () => void }[] = [];
  const listen = (app: express.Express) =>
    new Promise<string>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      servers.push(server);
    });

  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), "tasklinkpreview-"));
    writeFileSync(join(dist, "index.html"), SHELL);

    // The API's preview endpoint as the frontend service sees it (the real DB-backed taskLinkPreview
    // in ./modules/taskLinkPreview is a thin, directly-indexed single-row lookup with no gating logic
    // of its own to unit test here — see syllabusLinkPreview.test.ts for the same precedent).
    const api = express();
    api.get("/api/public/task-preview/:code", (req, res) => {
      res.json({ preview: req.params.code === CODE ? { ...PREVIEW, attachments: ["secret-file"] } : null });
    });
    apiBase = await listen(api);

    const app = express();
    mountSpa(app, dist, { taskPreview: httpTaskPreviewLookup(apiBase, 500) });
    base = await listen(app);
  });
  afterAll(() => servers.forEach((s) => s.close()));

  const get = (path: string, ua = "WhatsApp/2.23.20.0 A") => fetch(`${base}${path}`, { headers: { "user-agent": ua } });

  it("serves the task's own card to a crawler for a live code", async () => {
    for (const ua of ["facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A", "TelegramBot (like TwitterBot)"]) {
      const res = await get(`/task/${CODE.toLowerCase()}`, ua);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const html = await res.text();
      expect(html).toContain("<title>Excel: XLOOKUP/VLOOKUP — Tapşırıq | Resulio</title>");
      expect(metaContent(html, "property", "og:description")).toEqual([
        "Faylı endirin, tapşırığı yerinə yetirin və cavabınızı yükləyin. Müəllim: Telman Abdulla. Tapşırığa baxın.",
      ]);
      expect(headOf(html)).not.toContain(EXAM_PLATFORM_TEXT);
      expect(html).toContain(`<div id="root"></div>`);
      expect(html).not.toContain("secret-file");
    }
  });

  it("falls back to the neutral task card for an unknown code", async () => {
    const html = await (await get("/task/ZZZZZZZZZZ")).text();
    expect(html).toContain("<title>Tapşırıq linki — Resulio</title>");
    expect(html).not.toContain("XLOOKUP");
  });

  it("leaves other pages alone", async () => {
    for (const path of [`/some-other-page/${CODE}`, `/teacher/assignments`]) {
      const res = await get(path);
      expect(res.headers.get("x-robots-tag")).toBeNull();
      expect(await res.text()).toContain("<title>Resulio — müəllimlər üçün onlayn imtahan və qiymətləndirmə platforması</title>");
    }
  });
});
