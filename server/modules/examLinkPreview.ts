import { and, eq, isNotNull } from "drizzle-orm";
import type { Request, Response } from "express";
import { assessments, assessmentVersions, providerWorkspaces } from "../../drizzle/schema";
import { normalizeTaskMaterialCode } from "../../shared/taskMaterialShare";
import type { ExamPreview } from "../_core/linkPreview";
import { hitRateLimit } from "../_core/rateLimit";
import { requireDb } from "../db";

/**
 * Link-preview facts of an exam's share code: its title, description and subject, straight off
 * `assessmentVersions.settings` -- the same facts the public exam page already shows to anyone with
 * the link, no sign-in gate at all (see assessments.publicByShareCode). Only the current published
 * version is read, never a draft; a draft exam (no currentVersionId) has nothing to join here.
 */
export async function examLinkPreview(rawCode: string): Promise<ExamPreview | null> {
  const code = normalizeTaskMaterialCode(rawCode);
  if (!code) return null;
  const [row] = await requireDb()
    .select({
      settings: assessmentVersions.settings,
      publicDisplayName: providerWorkspaces.publicDisplayName,
      workspaceTitle: providerWorkspaces.title,
    })
    .from(assessments)
    .innerJoin(assessmentVersions, eq(assessmentVersions.id, assessments.currentVersionId))
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, assessments.providerWorkspaceId))
    .where(and(eq(assessments.shareCode, code), isNotNull(assessments.currentVersionId)))
    .limit(1);
  if (!row) return null;
  return {
    title: row.settings.title,
    description: row.settings.description,
    subject: row.settings.subject,
    teacherName: row.publicDisplayName || row.workspaceTitle,
  };
}

/**
 * `GET /api/public/exam-preview/:code` for the static frontend service, which renders link
 * previews but has no database. Its calls arrive from the frontend's few addresses, so the
 * per-address budget is generous; share codes (~59 bits) stay unguessable.
 */
export async function examPreviewRoute(req: Request, res: Response) {
  res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow");
  if (hitRateLimit(`exam-preview:${req.ip ?? "unknown"}`, 600, 60_000)) {
    res.status(429).json({ error: "RATE_LIMITED" });
    return;
  }
  try {
    res.json({ preview: await examLinkPreview(String(req.params.code ?? "")) });
  } catch (error) {
    console.error("[LinkPreview] exam lookup failed:", error instanceof Error ? error.message : error);
    res.status(503).json({ error: "UNAVAILABLE" });
  }
}
