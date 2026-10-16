import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { providerWorkspaces, tasks } from "../../drizzle/schema";
import { normalizeTaskMaterialCode } from "../../shared/taskMaterialShare";
import type { TaskPreview } from "../_core/linkPreview";
import { hitRateLimit } from "../_core/rateLimit";
import { requireDb } from "../db";

/**
 * Link-preview facts of a task's share code: its own title and description (not the protected
 * content of a GROUPS-restricted task — that's still gated by `tasks.viewerAccess` on the real
 * public page — just its name, same precedent as the syllabus/group previews). One query over a
 * unique key (shareCode → task → workspace), no draft/archived state to check: a task is live the
 * moment it exists (see server/materials/meta.ts TASK_META_PUBLISHING).
 */
export async function taskLinkPreview(rawCode: string): Promise<TaskPreview | null> {
  const code = normalizeTaskMaterialCode(rawCode);
  if (!code) return null;
  const [row] = await requireDb()
    .select({
      title: tasks.title,
      description: tasks.description,
      publicDisplayName: providerWorkspaces.publicDisplayName,
      workspaceTitle: providerWorkspaces.title,
    })
    .from(tasks)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, tasks.providerWorkspaceId))
    .where(eq(tasks.shareCode, code))
    .limit(1);
  if (!row) return null;
  return { title: row.title, description: row.description, teacherName: row.publicDisplayName || row.workspaceTitle };
}

/**
 * `GET /api/public/task-preview/:code` for the static frontend service, which renders link
 * previews but has no database. Its calls arrive from the frontend's few addresses, so the
 * per-address budget is generous; share codes (~59 bits) stay unguessable.
 */
export async function taskPreviewRoute(req: Request, res: Response) {
  res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow");
  if (hitRateLimit(`task-preview:${req.ip ?? "unknown"}`, 600, 60_000)) {
    res.status(429).json({ error: "RATE_LIMITED" });
    return;
  }
  try {
    res.json({ preview: await taskLinkPreview(String(req.params.code ?? "")) });
  } catch (error) {
    console.error("[LinkPreview] task lookup failed:", error instanceof Error ? error.message : error);
    res.status(503).json({ error: "UNAVAILABLE" });
  }
}
