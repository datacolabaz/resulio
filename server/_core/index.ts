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
import { registerFileRoutes } from "./files";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { getMigrationStatus, runAutoMigrate } from "./autoMigrate";
import { serveStatic, setupVite } from "./vite";
import { getDb, warnIfGoogleAuthSchemaMissing } from "../db";
import { sweepExpiredAttempts } from "../modules/attempts";
import { runPendingLinkJoinBackfill } from "../modules/groupJoin";
import { sweepResultEmails } from "../modules/resultEmail";
import { resumeAnnouncements } from "../notifications/announcements";
import { startNotificationWorker } from "../notifications/dispatcher";
import { logWebPushStatus } from "../notifications/webPush";
import { syllabusLinkPreview, syllabusPreviewRoute } from "../syllabus/linkPreview";
import { runModuleDetailsBackfills } from "../syllabus/moduleDetailsBackfill";
import { runDailyDigest, runDailyRetention } from "../syllabus/analytics";
import { flushDueNotices } from "../syllabus/notify";
import { installSyllabusHooks, reconcileDirty } from "../syllabus/progression";

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
      await sweepResultEmails();
    } catch (error) {
      console.error("[Sweeper] Sweep failed", error);
    } finally {
      running = false;
    }
  }, SWEEP_INTERVAL_MS).unref();
}

const SYLLABUS_RECONCILE_MS = 2 * 60_000;
/** The at-risk digest (after 08:00 Baku) and activity retention each run once a day; this is only how often we check. */
const SYLLABUS_DAILY_CHECK_MS = 15 * 60_000;

/** Progress recompute hooks plus a safety net for enrollments a crashed hook left dirty. */
function startSyllabusProgression() {
  if (!getDb()) return;
  installSyllabusHooks();
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await reconcileDirty();
    } catch (error) {
      console.error("[Syllabus] Reconcile failed", error);
    } finally {
      running = false;
    }
  }, SYLLABUS_RECONCILE_MS).unref();
  let flushing = false;
  setInterval(async () => {
    if (flushing) return;
    flushing = true;
    try {
      await flushDueNotices();
    } catch (error) {
      console.error("[Syllabus] Notice flush failed", error);
    } finally {
      flushing = false;
    }
  }, SWEEP_INTERVAL_MS).unref();
  let daily = false;
  setInterval(async () => {
    if (daily) return;
    daily = true;
    try {
      await runDailyDigest();
      await runDailyRetention();
    } catch (error) {
      console.error("[Syllabus] Daily jobs failed", error);
    } finally {
      daily = false;
    }
  }, SYLLABUS_DAILY_CHECK_MS).unref();
}

async function startServer() {
  await runAutoMigrate();
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
  app.get("/api/health", (_req, res) => {
    const { state, latest } = getMigrationStatus();
    res.json({ status: "ok", migrations: { state, latest } });
  });
  app.get("/api/platform/config.js", (_req, res) => {
    res.set("Cache-Control", "no-store").type("application/javascript").send(publicPlatformScript());
  });
  app.get("/api/public/syllabus-preview/:code", syllabusPreviewRoute);
  registerGoogleAuthRoutes(app);
  registerFileRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server, { syllabusPreview: syllabusLinkPreview });
  } else if (ENV.frontendUrl) {
    app.use(frontendRedirect(ENV.frontendUrl));
  } else {
    serveStatic(app, { syllabusPreview: syllabusLinkPreview });
  }

  startAttemptSweeper();
  startNotificationWorker();
  logWebPushStatus();
  void resumeAnnouncements();
  startSyllabusProgression();
  if (getDb()) {
    runPendingLinkJoinBackfill().catch((error) => console.error("[Groups] Pending join backfill failed", error instanceof Error ? error.message : error));
    runModuleDetailsBackfills().catch((error) => console.error("[Syllabus] module details backfill failed", error instanceof Error ? error.message : error));
  }

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
