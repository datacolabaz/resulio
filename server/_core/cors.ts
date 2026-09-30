import type { NextFunction, Request, Response } from "express";
import { WORKSPACE_HEADER } from "@shared/const";
import { ENV } from "./env";

const ALLOWED_HEADERS = ["content-type", WORKSPACE_HEADER, "trpc-accept"].join(", ");

/** Credentialed CORS for the separately hosted frontend. Unlisted origins get no CORS headers at all. */
export function apiCors(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api/")) return next();
  res.append("Vary", "Origin");
  const origin = req.get("origin");
  if (!origin || !ENV.corsAllowedOrigins.includes(origin)) return next();
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
    return;
  }
  next();
}
