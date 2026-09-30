import { createHmac, randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { ENV } from "./env";

type RequestWithId = Request & { requestId?: string };

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const id = randomUUID();
  (req as RequestWithId).requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

/** Keyed hash so raw IP addresses never reach audit or security tables. */
export function hashIp(ip: string | undefined | null): string | null {
  const secret = ENV.auditHashSecret;
  if (!ip || !secret) return null;
  return createHmac("sha256", secret).update(ip).digest("hex");
}

/** Browser and OS family only; full user-agent strings are not stored. */
export function summarizeUserAgent(ua: string | undefined | null): string | null {
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Other";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Other";
  return `${browser} / ${os}`;
}

export type RequestMeta = { requestId: string | null; ipHash: string | null; userAgentSummary: string | null };

export function requestMeta(req: Pick<Request, "ip" | "headers"> | undefined): RequestMeta {
  const ua = req?.headers?.["user-agent"];
  return {
    requestId: (req as RequestWithId | undefined)?.requestId ?? null,
    ipHash: hashIp(req?.ip),
    userAgentSummary: summarizeUserAgent(typeof ua === "string" ? ua : null),
  };
}
