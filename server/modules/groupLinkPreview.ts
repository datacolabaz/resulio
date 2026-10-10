import type { Request, Response } from "express";
import { GROUP_LINK_KINDS, normalizeGroupKey, type GroupLinkKind, type GroupLinkPreview } from "../_core/linkPreview";
import { hitRateLimit } from "../_core/rateLimit";
import { publicEmailInvitePreview } from "./groupEmailInvites";
import { publicInviteLinkPreview } from "./groupInviteLinks";
import { publicInvite } from "./groups";

const pick = (g: { name: string; groupType: string; subject: string; grade: string; level: string; teacherName: string }): GroupLinkPreview => ({
  name: g.name,
  groupType: g.groupType === "SCHOOL" ? "SCHOOL" : "COURSE",
  subject: g.subject,
  grade: g.grade,
  level: g.level,
  teacherName: g.teacherName,
});

/**
 * Link-preview facts of a group invitation, through the same public previews the join pages use,
 * so their gates apply unchanged. Only a link that would let someone join right now gets a card:
 * the group's code while active, unexpired and accepting joins or join requests (the approval
 * policy shows the group's name too); a single-use link while unused,
 * unrevoked and unexpired; an e-mail invite while pending. Anything else is null, like unknown.
 */
export async function groupLinkPreview(kind: GroupLinkKind, rawKey: string): Promise<GroupLinkPreview | null> {
  const key = normalizeGroupKey(kind, rawKey);
  if (!key) return null;
  if (kind === "code") {
    const g = await publicInvite(key);
    return g && !g.rejection ? pick(g) : null;
  }
  if (kind === "link") {
    const p = await publicInviteLinkPreview(key, null);
    return p.state === "ACTIVE" ? pick(p.group) : null;
  }
  const g = await publicEmailInvitePreview(key);
  return g ? pick(g) : null;
}

/**
 * `GET /api/public/group-preview/:kind/:key` for the static frontend service, which renders link
 * previews but has no database. Its calls arrive from the frontend's few addresses, so the
 * per-address budget is generous; invite codes and tokens stay unguessable.
 */
export async function groupPreviewRoute(req: Request, res: Response) {
  res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow");
  const kind = String(req.params.kind ?? "") as GroupLinkKind;
  if (!GROUP_LINK_KINDS.includes(kind)) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }
  if (hitRateLimit(`group-preview:${req.ip ?? "unknown"}`, 600, 60_000)) {
    res.status(429).json({ error: "RATE_LIMITED" });
    return;
  }
  try {
    res.json({ preview: await groupLinkPreview(kind, String(req.params.key ?? "")) });
  } catch (error) {
    console.error("[LinkPreview] group lookup failed:", error instanceof Error ? error.message : error);
    res.status(503).json({ error: "UNAVAILABLE" });
  }
}
