import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { providerWorkspaces } from "../../drizzle/schema";
import { normalizeTaskMaterialCode } from "../../shared/taskMaterialShare";
import type { MaterialPreview } from "../_core/linkPreview";
import { hitRateLimit } from "../_core/rateLimit";
import { requireDb } from "../db";
import { metaOfMaterial, visibleToStudents } from "../materials/meta";
import { materialByShareCode } from "../materials/service";

/**
 * Link-preview facts of a material's share code: its own title/description/subject/topic (not the
 * file itself — the real public page still gates that). A draft or not-yet-scheduled material is
 * not shown yet, same `visibleToStudents` gate the public page and dashboard list already use, so
 * a preview never leaks something the teacher hasn't published.
 */
export async function materialLinkPreview(rawCode: string): Promise<MaterialPreview | null> {
  const code = normalizeTaskMaterialCode(rawCode);
  if (!code) return null;
  const row = await materialByShareCode(code);
  if (!row) return null;
  const meta = await metaOfMaterial(row);
  if (!visibleToStudents(meta)) return null;
  const [ws] = await requireDb()
    .select({ publicDisplayName: providerWorkspaces.publicDisplayName, title: providerWorkspaces.title })
    .from(providerWorkspaces)
    .where(eq(providerWorkspaces.id, row.providerWorkspaceId))
    .limit(1);
  return { title: row.title, description: row.description, subject: row.subject, topic: row.topic, teacherName: ws ? ws.publicDisplayName || ws.title : "" };
}

/**
 * `GET /api/public/material-preview/:code` for the static frontend service, which renders link
 * previews but has no database. Its calls arrive from the frontend's few addresses, so the
 * per-address budget is generous; share codes (~59 bits) stay unguessable.
 */
export async function materialPreviewRoute(req: Request, res: Response) {
  res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow");
  if (hitRateLimit(`material-preview:${req.ip ?? "unknown"}`, 600, 60_000)) {
    res.status(429).json({ error: "RATE_LIMITED" });
    return;
  }
  try {
    res.json({ preview: await materialLinkPreview(String(req.params.code ?? "")) });
  } catch (error) {
    console.error("[LinkPreview] material lookup failed:", error instanceof Error ? error.message : error);
    res.status(503).json({ error: "UNAVAILABLE" });
  }
}
