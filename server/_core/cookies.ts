import type { CookieOptions, Request, Response } from "express";
import { ENV } from "./env";

export function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;
  const forwarded = req.headers?.["x-forwarded-proto"];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return typeof proto === "string" && proto.split(",")[0].trim() === "https";
}

/**
 * SameSite=Lax keeps the session on top-level navigations (OAuth redirects, shared exam links)
 * while refusing it on cross-site POSTs, which is the CSRF protection for tRPC mutations.
 * Domain=.resulio.co (when FRONTEND_URL is a sibling of the API host) so the cookie is
 * available on both resulio.co and api.resulio.co.
 */
export function getSessionCookieOptions(req: Request): CookieOptions {
  const secure = process.env.NODE_ENV === "production" || isSecureRequest(req);
  const domain = ENV.cookieDomain;
  return { httpOnly: true, path: "/", sameSite: "lax", secure, ...(domain ? { domain } : {}) };
}

/** Clear host-only and Domain= cookies so a previous split-deploy cookie cannot linger. */
export function clearNamedCookie(res: Pick<Response, "clearCookie">, name: string, req: Request) {
  const opts = { ...getSessionCookieOptions(req), maxAge: -1 };
  res.clearCookie(name, opts);
  if (opts.domain) {
    const { domain: _domain, ...hostOnly } = opts;
    res.clearCookie(name, hostOnly);
  }
}
