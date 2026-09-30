import express, { type Express, type NextFunction, type Request, type Response } from "express";
import fs from "fs";
import path from "path";

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
}

/**
 * Serves the built client: hashed assets are immutable and 404 when missing (a stale chunk must not
 * receive index.html), unknown /api paths are 404, and every other GET falls back to index.html so
 * client-side routes survive a refresh.
 */
export function mountSpa(app: Express, distPath: string) {
  if (!fs.existsSync(distPath)) {
    console.error(`Could not find the build directory: ${distPath}, make sure to build the client first`);
  }
  const indexHtml = path.resolve(distPath, "index.html");

  app.use("/assets", express.static(path.join(distPath, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
  app.use(express.static(distPath, { index: false }));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });
  app.use((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.sendStatus(404);
      return;
    }
    res.set("Cache-Control", "no-cache").sendFile(indexHtml);
  });
}
