import { and, eq, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { providerWorkspaces, syllabi, syllabusShareLinks, syllabusVersions, syllabusVersionTiming } from "../../drizzle/schema";
import { normalizeShareCode } from "../../shared/syllabusJoin";
import { parseTiming } from "../../shared/syllabusTiming";
import type { SyllabusPreview } from "../_core/linkPreview";
import { hitRateLimit } from "../_core/rateLimit";
import { requireDb } from "../db";
import { isSchemaBehind, syllabusEnabledFor } from "./availability";
import { isShareable } from "./joinRules";

const text = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * The link-preview facts of a share code: one query over unique/primary keys (code → syllabus →
 * published version → workspace, plus the version's timing), then the cached feature-flag check.
 * Same gates as the public page (joinRequests.ts `sharedSyllabus`) and only fields it shows, read
 * from the published version, never the draft.
 */
export async function syllabusLinkPreview(rawCode: string): Promise<SyllabusPreview | null> {
  const code = normalizeShareCode(rawCode);
  if (!code) return null;
  try {
    const [row] = await requireDb()
      .select({
        active: syllabusShareLinks.active,
        workspaceId: syllabi.providerWorkspaceId,
        currentVersionId: syllabi.currentVersionId,
        status: syllabi.status,
        archivedAt: syllabi.archivedAt,
        versionStatus: syllabusVersions.status,
        meta: syllabusVersions.meta,
        moduleCount: sql<number | null>`JSON_LENGTH(${syllabusVersions.structure}, '$.modules')`,
        timing: syllabusVersionTiming.timing,
        publicDisplayName: providerWorkspaces.publicDisplayName,
        workspaceTitle: providerWorkspaces.title,
      })
      .from(syllabusShareLinks)
      .innerJoin(syllabi, eq(syllabi.id, syllabusShareLinks.syllabusId))
      .innerJoin(syllabusVersions, and(eq(syllabusVersions.id, syllabi.currentVersionId), eq(syllabusVersions.syllabusId, syllabi.id)))
      .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, syllabi.providerWorkspaceId))
      .leftJoin(syllabusVersionTiming, eq(syllabusVersionTiming.versionId, syllabusVersions.id))
      .where(eq(syllabusShareLinks.code, code))
      .limit(1);
    if (!row?.active || !isShareable(row) || row.versionStatus !== "PUBLISHED") return null;
    if (!(await syllabusEnabledFor(row.workspaceId))) return null;
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    return {
      title: text(meta.title),
      subject: text(meta.subject),
      moduleCount: Number(row.moduleCount ?? 0) || 0,
      duration: parseTiming(row.timing).course.duration,
      durationLabel: text(meta.estimatedDurationLabel),
      teacherName: row.publicDisplayName || row.workspaceTitle,
    };
  } catch (error) {
    // Like the public page: a database that is behind the code has no such page.
    if (isSchemaBehind(error)) return null;
    throw error;
  }
}

/**
 * `GET /api/public/syllabus-preview/:code` for the static frontend service, which renders link
 * previews but has no database. Answers only what the public page shows. Its calls arrive from the
 * frontend's few addresses, so the per-address budget is generous; codes (~60 bits) stay unguessable.
 */
export async function syllabusPreviewRoute(req: Request, res: Response) {
  res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow");
  if (hitRateLimit(`syllabus-preview:${req.ip ?? "unknown"}`, 600, 60_000)) {
    res.status(429).json({ error: "RATE_LIMITED" });
    return;
  }
  try {
    res.json({ preview: await syllabusLinkPreview(String(req.params.code ?? "")) });
  } catch (error) {
    console.error("[LinkPreview] lookup failed:", error instanceof Error ? error.message : error);
    res.status(503).json({ error: "UNAVAILABLE" });
  }
}
