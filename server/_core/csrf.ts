import type { NextFunction, Request, Response } from "express";
import { recordSecurityEvent } from "../modules/securityEvents";
import { ENV } from "./env";
import { hashIp } from "./requestMeta";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Defense in depth on top of SameSite=Lax session cookies: state-changing API requests must
 * come from our own origin or an allowlisted frontend origin and (for tRPC) carry a JSON body, which browsers cannot send
 * cross-origin without a CORS preflight.
 */
export function isCrossSiteWrite(
  req: Pick<Request, "method" | "headers" | "path">,
  host: string | undefined,
  allowedOrigins: readonly string[] = [],
): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  const origin = req.headers.origin ?? req.headers.referer;
  if (origin) {
    try {
      const url = new URL(String(origin));
      if (url.host !== host && !allowedOrigins.includes(url.origin)) return true;
    } catch {
      return true;
    }
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (req.path.startsWith("/api/trpc") && !contentType.includes("application/json")) return true;
  return false;
}

export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host");
  if (req.path.startsWith("/api/") && isCrossSiteWrite(req, host, ENV.corsAllowedOrigins)) {
    recordSecurityEvent({ type: "CSRF_REJECTED", severity: "MEDIUM", ipHash: hashIp(req.ip), details: { path: req.path.slice(0, 120) } });
    res.status(403).json({ error: "CSRF_REJECTED" });
    return;
  }
  next();
}
