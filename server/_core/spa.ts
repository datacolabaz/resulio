import express, { type Express, type NextFunction, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { previewResolver, syllabusPathCode, syllabusPreviewHtml, type PreviewLookup, type PreviewResult } from "./linkPreview";

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
}

/** A public page prerendered at build time (see client/src/seo/vitePlugin.ts), or null. */
export function prerenderedPage(distPath: string, urlPath: string): string | null {
  const slug = urlPath === "/" ? "index" : urlPath.replace(/^\/|\/$/g, "");
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const file = path.join(distPath, "_pages", `${slug}.html`);
  return fs.existsSync(file) ? file : null;
}

/**
 * Serves the built client: hashed assets are immutable and 404 when missing (a stale chunk must not
 * receive index.html), unknown /api paths are 404, public marketing pages get their prerendered HTML,
 * a shared syllabus (`/syllabus/<code>`) gets index.html with its link-preview head, and every other
 * GET falls back to index.html so client-side routes survive a refresh.
 */
export function mountSpa(app: Express, distPath: string, opts: { syllabusPreview?: PreviewLookup } = {}) {
  if (!fs.existsSync(distPath)) {
    console.error(`Could not find the build directory: ${distPath}, make sure to build the client first`);
  }
  const indexHtml = path.resolve(distPath, "index.html");
  const resolvePreview = opts.syllabusPreview
    ? previewResolver(opts.syllabusPreview)
    : async (code: string | null): Promise<PreviewResult> => (code ? { status: "UNAVAILABLE", code } : { status: "NOT_FOUND", code: null });
  let shell: string | null = null;

  app.use("/assets", express.static(path.join(distPath, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
  app.use(
    express.static(distPath, {
      index: false,
      setHeaders: (res, file) => {
        if (path.basename(file) === "sw.js") res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });
  app.use(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.sendStatus(404);
      return;
    }
    res.set("Cache-Control", "no-cache");
    if (syllabusPathCode(req.path)) {
      res.set("X-Robots-Tag", "noindex, nofollow");
      try {
        shell ??= await fs.promises.readFile(indexHtml, "utf8");
        const html = await syllabusPreviewHtml(shell, req.path, resolvePreview);
        if (html) {
          res.type("html").send(html);
          return;
        }
      } catch (error) {
        console.error("[LinkPreview] could not render the syllabus page head:", error instanceof Error ? error.message : error);
      }
    }
    res.sendFile(prerenderedPage(distPath, req.path) ?? indexHtml);
  });
}
