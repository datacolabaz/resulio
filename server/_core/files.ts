import { eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import multer from "multer";
import { WORKSPACE_HEADER } from "@shared/const";
import type { User } from "../../drizzle/schema";
import { tasks } from "../../drizzle/schema";
import { requireDb } from "../db";
import { resolveWorkspace } from "../modules/access";
import { AppError, type AppErrorCode } from "../modules/errors";
import * as filesModule from "../modules/files";
import { activeGroupIdsOfStudent } from "../modules/groups";
import { hitRateLimit } from "./rateLimit";
import { sdk } from "./sdk";

/**
 * Plain REST endpoints for file bytes — tRPC's JSON transport isn't a good fit for multipart
 * upload or binary download. Session auth is the same cookie tRPC uses (sdk.authenticateRequest),
 * just read directly instead of through the tRPC context.
 */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: filesModule.MAX_FILE_BYTES, files: 1 } });

const UPLOAD_CONTEXTS = ["task-attachment", "material", "submission"] as const;
type UploadContext = (typeof UPLOAD_CONTEXTS)[number];
function isUploadContext(v: unknown): v is UploadContext {
  return typeof v === "string" && (UPLOAD_CONTEXTS as readonly string[]).includes(v);
}

async function currentUser(req: Request): Promise<User | null> {
  try {
    return (await sdk.authenticateRequest(req)).user;
  } catch {
    return null;
  }
}

const STATUS: Partial<Record<AppErrorCode, number>> = {
  FILE_TOO_LARGE: 413,
  FILE_TYPE_NOT_ALLOWED: 400,
  FILE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  NO_WORKSPACE: 403,
  RATE_LIMITED: 429,
};

function sendError(res: Response, error: unknown) {
  if (error instanceof AppError) {
    res.status(STATUS[error.code] ?? 400).json({ error: error.code });
    return;
  }
  console.error("[files]", error);
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

export function registerFileRoutes(app: Express) {
  app.post("/api/files/upload", (req, res) => {
    upload.single("file")(req, res, async (multerError) => {
      if (multerError) {
        const tooLarge = multerError instanceof multer.MulterError && multerError.code === "LIMIT_FILE_SIZE";
        res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "FILE_TOO_LARGE" : "UPLOAD_FAILED" });
        return;
      }
      try {
        const user = await currentUser(req);
        if (!user) {
          res.status(401).json({ error: "UNAUTHORIZED" });
          return;
        }
        if (hitRateLimit(`file-upload:${user.id}`, 30, 60_000)) {
          res.status(429).json({ error: "RATE_LIMITED" });
          return;
        }
        const uploaded = req.file;
        if (!uploaded) {
          res.status(400).json({ error: "NO_FILE" });
          return;
        }
        const context = req.body?.context;
        if (!isUploadContext(context)) {
          res.status(400).json({ error: "INVALID_CONTEXT" });
          return;
        }

        let workspaceId: string;
        let isPublic = false;
        if (context === "submission") {
          const taskId = String(req.body?.taskId ?? "");
          const [task] = await requireDb().select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
          if (!task) throw new AppError("NOT_FOUND");
          const groupIds = await activeGroupIdsOfStudent(user.id);
          const reaches = task.studentIds.includes(user.id) || task.groupIds.some((g) => groupIds.includes(g));
          if (!reaches) throw new AppError("FORBIDDEN");
          workspaceId = task.providerWorkspaceId;
        } else {
          const header = req.headers[WORKSPACE_HEADER];
          const requested = typeof header === "string" && header.trim() ? header.trim() : null;
          const workspace = await resolveWorkspace(user.id, requested);
          if (!workspace) throw new AppError("NO_WORKSPACE");
          workspaceId = workspace.id;
          isPublic = context === "material";
        }

        const saved = await filesModule.saveFile({
          workspaceId,
          uploadedBy: user.id,
          fileName: uploaded.originalname,
          buffer: uploaded.buffer,
          isPublic,
        });
        res.json(saved);
      } catch (error) {
        sendError(res, error);
      }
    });
  });

  app.get("/api/files/:id", async (req, res) => {
    try {
      const file = await filesModule.fileRow(req.params.id);
      if (!file) throw new AppError("FILE_NOT_FOUND");
      if (!file.isPublic) {
        const user = await currentUser(req);
        if (!user) {
          res.status(401).json({ error: "UNAUTHORIZED" });
          return;
        }
        await filesModule.assertCanDownload(file, user.id);
      } else if (hitRateLimit(`file-download-public:${req.ip}`, 120, 60_000)) {
        res.status(429).json({ error: "RATE_LIMITED" });
        return;
      }
      const buffer = Buffer.from(file.dataBase64, "base64");
      const asciiName = file.fileName.replace(/[^\x20-\x7E]/g, "_");
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
      res.setHeader("Cache-Control", "private, max-age=0, no-cache");
      res.send(buffer);
    } catch (error) {
      sendError(res, error);
    }
  });
}
