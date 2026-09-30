import type { CookieOptions, Request } from "express";

export function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;
  const forwarded = req.headers?.["x-forwarded-proto"];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return typeof proto === "string" && proto.split(",")[0].trim() === "https";
}

/**
 * SameSite=Lax keeps the session on top-level navigations (OAuth redirects, shared exam links)
 * while refusing it on cross-site POSTs, which is the CSRF protection for tRPC mutations.
 */
export function getSessionCookieOptions(req: Request): CookieOptions {
  const secure = process.env.NODE_ENV === "production" || isSecureRequest(req);
  return { httpOnly: true, path: "/", sameSite: "lax", secure };
}
