import "./loadEnv";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { apiCors } from "./cors";
import { csrfGuard } from "./csrf";
import { ENV } from "./env";
import { registerGoogleAuthRoutes } from "./googleAuth";
import { frontendRedirect, hostRedirect } from "./hostRedirect";
import { securityHeaders } from "./spa";
import { publicPlatformScript } from "./publicConfig";
import { requestIdMiddleware } from "./requestMeta";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { getDb, warnIfGoogleAuthSchemaMissing } from "../db";
import { sweepExpiredAttempts } from "../modules/attempts";

const SWEEP_INTERVAL_MS = 30_000;

function startAttemptSweeper() {
  if (!getDb()) {
    console.warn("[Sweeper] DATABASE_URL not set; auto-submit sweeper disabled");
    return;
  }
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepExpiredAttempts();
    } catch (error) {
      console.error("[Sweeper] Sweep failed", error);
    } finally {
      running = false;
    }
  }, SWEEP_INTERVAL_MS).unref();
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(hostRedirect);
  app.use(securityHeaders);
  app.use(requestIdMiddleware);
  app.use(apiCors);
  app.use(csrfGuard);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ limit: "2mb", extended: true }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/platform/config.js", (_req, res) => {
    res.set("Cache-Control", "no-store").type("application/javascript").send(publicPlatformScript());
  });
  registerGoogleAuthRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else if (ENV.frontendUrl) {
    app.use(frontendRedirect(ENV.frontendUrl));
  } else {
    serveStatic(app);
  }

  startAttemptSweeper();

  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  server.on("error", (error) => {
    console.error("Server failed:", error.message);
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server listening on port ${port}`);
    if (!ENV.googleConfigured) {
      console.warn("[GoogleAuth] Google login is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart.");
    }
    void warnIfGoogleAuthSchemaMissing();
  });
}

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
