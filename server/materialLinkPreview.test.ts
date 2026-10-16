import express from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materialPageTitle } from "../shared/taskMaterialShare";
import {
  httpMaterialPreviewLookup,
  injectPreviewHead,
  isLinkPreviewPath,
  materialPathCode,
  materialPreviewHead,
  materialPreviewText,
  parseMaterialPreview,
  type MaterialPreview,
} from "./_core/linkPreview";
import { mountSpa } from "./_core/spa";

const CODE = "AB12CD34EF";
const PREVIEW: MaterialPreview = { title: "Say sistemləri konspekti", description: "9-cu sinif üçün ikilik və onaltılıq say sistemləri üzrə qısa konspekt.", subject: "İnformatika", topic: "Say sistemləri", teacherName: "Telman Abdulla" };
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

describe("material link preview text", () => {
  it("uses the material's own title and description, not the site-wide card", () => {
    expect(materialPreviewText(PREVIEW)).toEqual({
      title: "Say sistemləri konspekti — Material | Resulio",
      description: "9-cu sinif üçün ikilik və onaltılıq say sistemləri üzrə qısa konspekt. Müəllim: Telman Abdulla. Materiala baxın.",
    });
    expect(materialPreviewText(PREVIEW).title).toBe(materialPageTitle(PREVIEW.title));
  });

  it("falls back to Fənn/Mövzu facts when there is no description", () => {
    expect(materialPreviewText({ ...PREVIEW, description: "" }).description).toBe("Fənn: İnformatika · Mövzu: Say sistemləri. Müəllim: Telman Abdulla. Materiala baxın.");
    expect(materialPreviewText({ ...PREVIEW, description: "", subject: "", topic: "", teacherName: "" }).description).toBe("Materiala baxın.");
    expect(materialPreviewText({ ...PREVIEW, title: " " }).title).toBe("Material | Resulio");
  });

  it("escapes teacher-controlled text everywhere", () => {
    const evil = { ...PREVIEW, title: `"><script>alert(1)</script> & Tom`, description: `<img src=x onerror=alert(1)>` };
    const html = injectPreviewHead(SHELL, materialPreviewHead({ status: "FOUND", code: CODE, preview: evil }, ORIGIN))!;
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; Tom — Material | Resulio");
    expect(html.match(/<title>/g)).toHaveLength(1);
  });

  it("falls back to material-neutral text, never the exam-platform card", () => {
    const notFound = materialPreviewHead({ status: "NOT_FOUND", code: CODE }, ORIGIN);
    expect(notFound.title).toBe("Material linki — Resulio");
    expect(metaContent(notFound.tags.join("\n"), "name", "description")).toEqual(["Bu link aktiv deyil və ya tapılmadı."]);
    const unavailable = materialPreviewHead({ status: "UNAVAILABLE", code: CODE }, ORIGIN);
    expect(unavailable.title).toBe("Material — Resulio");
    for (const h of [notFound, unavailable]) {
      const html = injectPreviewHead(SHELL, h)!;
      expect(headOf(html)).not.toContain(EXAM_PLATFORM_TEXT);
      expect(metaContent(html, "name", "robots")).toEqual(["noindex, nofollow"]);
    }
  });
});

describe("material link preview data", () => {
  it("only accepts /material/<code> paths and normalises the code", () => {
    expect(materialPathCode(`/material/${CODE}`)).toEqual({ code: CODE });
    expect(materialPathCode(`/material/${CODE.toLowerCase()}/`)).toEqual({ code: CODE });
    expect(materialPathCode("/material/a")).toEqual({ code: null });
    for (const p of ["/material", "/material/", `/material/${CODE}/x`, `/task/${CODE}`, "/about"]) expect(materialPathCode(p)).toBeNull();
    expect(isLinkPreviewPath(`/material/${CODE}`)).toBe(true);
  });

  it("keeps only the preview fields of an API answer", () => {
    const parsed = parseMaterialPreview({ ...PREVIEW, fileId: "secret-file", url: "https://internal.example.com" });
    expect(parsed).toEqual(PREVIEW);
    expect(Object.keys(parsed!).sort()).toEqual(["description", "subject", "teacherName", "title", "topic"]);
    expect(parseMaterialPreview({ title: 5 })).toEqual({ title: "", description: "", subject: "", topic: "", teacherName: "" });
    expect(parseMaterialPreview(null)).toBeNull();
    const html = materialPreviewHead({ status: "FOUND", code: CODE, preview: parsed! }, ORIGIN).tags.join("");
    expect(html).not.toContain("secret-file");
  });
});

describe("GET /material/:code HTML", () => {
  let base = "";
  let apiBase = "";
  const servers: { close: () => void }[] = [];
  const listen = (app: express.Express) =>
    new Promise<string>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      servers.push(server);
    });

  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), "materiallinkpreview-"));
    writeFileSync(join(dist, "index.html"), SHELL);

    // Like taskLinkPreview, the real DB-backed materialLinkPreview in ./modules/materialLinkPreview
    // is a thin lookup plus the existing visibleToStudents gate the public page already uses — not
    // re-tested here (see syllabusLinkPreview.test.ts for the same precedent).
    const api = express();
    api.get("/api/public/material-preview/:code", (req, res) => {
      res.json({ preview: req.params.code === CODE ? { ...PREVIEW, fileId: "secret-file" } : null });
    });
    apiBase = await listen(api);

    const app = express();
    mountSpa(app, dist, { materialPreview: httpMaterialPreviewLookup(apiBase, 500) });
    base = await listen(app);
  });
  afterAll(() => servers.forEach((s) => s.close()));

  const get = (path: string, ua = "WhatsApp/2.23.20.0 A") => fetch(`${base}${path}`, { headers: { "user-agent": ua } });

  it("serves the material's own card to a crawler for a live code", async () => {
    for (const ua of ["facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A", "TelegramBot (like TwitterBot)"]) {
      const res = await get(`/material/${CODE.toLowerCase()}`, ua);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const html = await res.text();
      expect(html).toContain("<title>Say sistemləri konspekti — Material | Resulio</title>");
      expect(metaContent(html, "property", "og:description")).toEqual([
        "9-cu sinif üçün ikilik və onaltılıq say sistemləri üzrə qısa konspekt. Müəllim: Telman Abdulla. Materiala baxın.",
      ]);
      expect(headOf(html)).not.toContain(EXAM_PLATFORM_TEXT);
      expect(html).not.toContain("secret-file");
    }
  });

  it("falls back to the neutral material card for an unknown code", async () => {
    const html = await (await get("/material/ZZZZZZZZZZ")).text();
    expect(html).toContain("<title>Material linki — Resulio</title>");
    expect(html).not.toContain("Say sistemləri");
  });

  it("leaves other pages alone", async () => {
    for (const path of [`/some-other-page/${CODE}`, `/teacher/materials`]) {
      const res = await get(path);
      expect(res.headers.get("x-robots-tag")).toBeNull();
      expect(await res.text()).toContain("<title>Resulio — müəllimlər üçün onlayn imtahan və qiymətləndirmə platforması</title>");
    }
  });
});
