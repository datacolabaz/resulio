import type { NextFunction, Request, Response } from "express";

export const CANONICAL_ORIGIN = "https://resulio.co";

/** Hosts that only exist to forward visitors to the canonical site, keeping path and query intact. */
const REDIRECT_HOSTS = new Set(["www.resulio.co", "mentorix.io", "www.mentorix.io"]);

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export function canonicalRedirect(
  host: string | undefined,
  method: string,
  originalUrl: string,
): { status: 301 | 308; location: string } | null {
  const hostname = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!REDIRECT_HOSTS.has(hostname)) return null;
  const path = originalUrl.startsWith("/") ? originalUrl : "/";
  // 308 keeps the method and body for non-GET requests; browsers turn a 301 POST into a GET.
  return { status: BODYLESS_METHODS.has(method.toUpperCase()) ? 301 : 308, location: `${CANONICAL_ORIGIN}${path}` };
}

/** On the API host, page URLs belong to the separately deployed frontend. */
export function frontendRedirect(frontendUrl: string) {
  return (req: Request, res: Response) => {
    if (req.path.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    const path = req.originalUrl.startsWith("/") ? req.originalUrl : "/";
    res.redirect(301, `${frontendUrl}${path}`);
  };
}

export function hostRedirect(req: Request, res: Response, next: NextFunction) {
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host");
  const target = canonicalRedirect(host, req.method, req.originalUrl);
  if (!target) return next();
  res.set("Cache-Control", "public, max-age=3600");
  res.redirect(target.status, target.location);
}
