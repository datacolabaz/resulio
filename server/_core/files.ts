import { eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import multer from "multer";
import { WORKSPACE_HEADER } from "@shared/const";
import { parseShareCampaign, parseShareSource, VISITOR_ID_PATTERN } from "@shared/shareTracking";
import type { User } from "../../drizzle/schema";
import { tasks } from "../../drizzle/schema";
import { requireDb } from "../db";
import { MATERIAL_UPLOAD_TYPES } from "../../shared/materialTemplates";
import { contentDisposition, r2DownloadMode } from "../fileStorage/r2";
import { assertWorkspaceQuota } from "../materials/directUpload";
import { resolveWorkspace } from "../modules/access";
import { AppError, type AppErrorCode } from "../modules/errors";
import * as filesModule from "../modules/files";
import { activeGroupIdsOfStudent } from "../modules/groups";
import { taskReachesStudent } from "../modules/taskAccess";
import { practiceUploadAllowed } from "../syllabus/learning";
import { hitRateLimit } from "./rateLimit";
import { sdk } from "./sdk";

/**
 * Plain REST endpoints for file bytes — tRPC's JSON transport isn't a good fit for multipart
 * upload or binary download. Session auth is the same cookie tRPC uses (sdk.authenticateRequest),
 * just read directly instead of through the tRPC context.
 */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: filesModule.MAX_FILE_BYTES, files: 1 } });

/**
 * "syllabus": cover images, theory images/files and practice attachments; "question-import": a PDF
 * or image to extract bank questions from. Both private to the workspace.
 */
const UPLOAD_CONTEXTS = ["task-attachment", "material", "submission", "syllabus", "question-import"] as const;
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
  STORAGE_QUOTA_EXCEEDED: 413,
  FILE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  NO_WORKSPACE: 403,
  RATE_LIMITED: 429,
};

/** `?share=TASK&code=<shareCode>&src=<channel>&campaign=..&vid=..`, appended by the public task/material page's download links. */
function shareDownloadParams(req: Request) {
  const one = (v: unknown) => (typeof v === "string" ? v : undefined);
  const targetType = one(req.query.share);
  const shareCode = one(req.query.code)?.trim() ?? "";
  if ((targetType !== "TASK" && targetType !== "MATERIAL") || !/^[A-Za-z0-9]{4,32}$/.test(shareCode)) return null;
  const visitorId = one(req.query.vid);
  return {
    targetType,
    shareCode,
    channel: parseShareSource(one(req.query.src)) ?? "DIRECT",
    campaign: parseShareCampaign(one(req.query.campaign)),
    visitorId: visitorId && VISITOR_ID_PATTERN.test(visitorId) ? visitorId : undefined,
  } as const;
}

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
          if (!taskReachesStudent(task, user.id, groupIds) && !(await practiceUploadAllowed(user.id, task.id))) throw new AppError("FORBIDDEN");
          workspaceId = task.providerWorkspaceId;
        } else {
          const header = req.headers[WORKSPACE_HEADER];
          const requested = typeof header === "string" && header.trim() ? header.trim() : null;
          const workspace = await resolveWorkspace(user.id, requested);
          if (!workspace) throw new AppError("NO_WORKSPACE");
          workspaceId = workspace.id;
          // Both of these can end up linked from a task/material's own public share-code page
          // (PublicTaskPage / PublicMaterialPage), which anyone with that link can open while
          // signed out -- so the attached file has to be reachable the same way, same as the
          // page's text already is. Attachments of a group-restricted task are re-checked per
          // user on download anyway (filesModule.downloadAccess). A "submission" file (handled
          // above) is never on a public page, so it stays private.
          isPublic = context === "material" || context === "task-attachment";
          await assertWorkspaceQuota(workspaceId, uploaded.size);
        }

        const saved = await filesModule.saveFile({
          workspaceId,
          uploadedBy: user.id,
          fileName: uploaded.originalname,
          buffer: uploaded.buffer,
          isPublic,
          allowedTypes: context === "material" ? MATERIAL_UPLOAD_TYPES : undefined,
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
      // Resolved either way (even for a public file) so a successful download can be attributed
      // to a student for the "who viewed/downloaded this" report — see filesModule.recordDownload.
      const user = await currentUser(req);
      const access = await filesModule.downloadAccess(file, user?.id ?? null);
      if (access === "SIGN_IN_REQUIRED") {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
      if (access === "DENIED") throw new AppError("FORBIDDEN");
      if (access === "OPEN" && hitRateLimit(`file-download-public:${req.ip}`, 120, 60_000)) {
        res.status(429).json({ error: "RATE_LIMITED" });
        return;
      }
      if (user) await filesModule.recordDownload(file, user.id);
      const share = shareDownloadParams(req);
      if (share) await filesModule.recordShareDownload(file, share, user?.id ?? null);
      const stored = await filesModule.storedObjectOf(file);
      if (stored && r2DownloadMode() === "redirect") {
        // Access was checked above; the signed URL is short-lived and names this one object.
        const publicUrl = access === "OPEN" ? stored.store.publicUrl(stored.key) : null;
        res.setHeader("Cache-Control", "no-store");
        res.redirect(302, publicUrl ?? (await stored.store.signedGetUrl(stored.key, { fileName: file.fileName, contentType: file.mimeType })));
        return;
      }
      const buffer = stored ? await stored.store.get(stored.key) : Buffer.from(file.dataBase64, "base64");
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Content-Disposition", contentDisposition(file.fileName));
      res.setHeader("Cache-Control", "private, max-age=0, no-cache");
      res.send(buffer);
    } catch (error) {
      sendError(res, error);
    }
  });
}
