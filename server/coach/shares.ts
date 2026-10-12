import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { coachArtifacts, coachMaterials, coachShares, coachTopics, groups, providerWorkspaces, users } from "../../drizzle/schema";
import { SUMMARY_KIND, type ArtifactContent, type CoachLocale } from "../../shared/coach";
import { requireDb } from "../db";
import { activeGroupIdsOfStudent } from "../modules/groups";
import { AppError } from "../modules/errors";
import { onMaterialDelete, ownedMaterial } from "./materials";
import { logEvent } from "./store";

/**
 * "Müəllimlə paylaş": the student shares one material read-only with a teacher of a group they
 * are active in. Off by default; the teacher sees the file and the summaries already prepared
 * (never quizzes, chat, mistakes or mastery) and cannot generate anything. Revoking deletes the
 * share at once.
 */

export interface ShareTarget {
  teacherId: number;
  workspaceId: string;
  name: string;
}

/** One entry per teacher (a teacher with several workspaces appears once per workspace name). */
export function dedupeTargets(rows: { teacherId: number; workspaceId: string; displayName: string; title: string; ownerName: string | null }[]): ShareTarget[] {
  const seen = new Map<string, ShareTarget>();
  for (const r of rows) {
    const key = `${r.teacherId}:${r.workspaceId}`;
    if (seen.has(key)) continue;
    const label = r.displayName.trim() || r.title.trim();
    const owner = (r.ownerName ?? "").trim();
    seen.set(key, { teacherId: r.teacherId, workspaceId: r.workspaceId, name: owner && label && owner !== label ? `${owner} · ${label}` : owner || label });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, "az"));
}

export async function shareTargets(studentId: number): Promise<ShareTarget[]> {
  const groupIds = await activeGroupIdsOfStudent(studentId);
  if (!groupIds.length) return [];
  const rows = await requireDb()
    .select({ teacherId: providerWorkspaces.ownerUserId, workspaceId: providerWorkspaces.id, displayName: providerWorkspaces.publicDisplayName, title: providerWorkspaces.title, ownerName: users.name })
    .from(groups)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, groups.providerWorkspaceId))
    .leftJoin(users, eq(users.id, providerWorkspaces.ownerUserId))
    .where(inArray(groups.id, groupIds));
  return dedupeTargets(rows.filter((r) => r.teacherId !== studentId));
}

export async function materialShares(studentId: number, materialId: string) {
  await ownedMaterial(studentId, materialId);
  const rows = await requireDb()
    .select({ id: coachShares.id, teacherId: coachShares.teacherId, workspaceId: coachShares.workspaceId, createdAt: coachShares.createdAt })
    .from(coachShares)
    .where(and(eq(coachShares.studentId, studentId), eq(coachShares.materialId, materialId)))
    .orderBy(asc(coachShares.createdAt));
  const targets = await shareTargets(studentId);
  const nameOf = (r: { teacherId: number; workspaceId: string }) => targets.find((t) => t.teacherId === r.teacherId && t.workspaceId === r.workspaceId)?.name ?? null;
  return rows.map((r) => ({ ...r, name: nameOf(r) }));
}

export async function shareMaterial(studentId: number, materialId: string, target: { teacherId: number; workspaceId: string }) {
  const material = await ownedMaterial(studentId, materialId);
  if (material.status !== "READY") throw new AppError("COACH_NOT_READY");
  const allowed = await shareTargets(studentId);
  if (!allowed.some((t) => t.teacherId === target.teacherId && t.workspaceId === target.workspaceId)) throw new AppError("FORBIDDEN");
  await requireDb()
    .insert(coachShares)
    .values({ id: nanoid(), studentId, materialId: material.id, teacherId: target.teacherId, workspaceId: target.workspaceId })
    .onDuplicateKeyUpdate({ set: { workspaceId: target.workspaceId } });
  await logEvent(studentId, "SHARED", material.id, { teacherId: target.teacherId });
  return materialShares(studentId, material.id);
}

export async function revokeShare(studentId: number, shareId: string) {
  const [row] = await requireDb().select().from(coachShares).where(and(eq(coachShares.id, shareId), eq(coachShares.studentId, studentId))).limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  await requireDb().delete(coachShares).where(eq(coachShares.id, row.id));
  return materialShares(studentId, row.materialId);
}

/** File download check: a coach file is reachable by a teacher it was shared with. */
export async function coachFileSharedWith(fileId: string, userId: number): Promise<boolean> {
  const [row] = await requireDb()
    .select({ id: coachShares.id })
    .from(coachShares)
    .innerJoin(coachMaterials, eq(coachMaterials.id, coachShares.materialId))
    .where(and(eq(coachMaterials.fileId, fileId), eq(coachShares.teacherId, userId)))
    .limit(1);
  return !!row;
}

// ---------------------------------------------------------------------------
// Teacher side (read-only)
// ---------------------------------------------------------------------------

export async function sharedWithTeacher(teacherId: number, workspaceId: string) {
  return requireDb()
    .select({
      id: coachShares.id,
      createdAt: coachShares.createdAt,
      studentName: users.name,
      materialTitle: coachMaterials.title,
      pageCount: coachMaterials.pageCount,
      fileName: coachMaterials.fileName,
    })
    .from(coachShares)
    .innerJoin(coachMaterials, eq(coachMaterials.id, coachShares.materialId))
    .leftJoin(users, eq(users.id, coachShares.studentId))
    .where(and(eq(coachShares.teacherId, teacherId), eq(coachShares.workspaceId, workspaceId)))
    .orderBy(desc(coachShares.createdAt))
    .limit(200);
}

/** The teacher's language if the student prepared it, else the shortest summary in any language. */
export function pickSummary<T extends { kind: string; locale: string }>(rows: T[], locale: CoachLocale): T | null {
  const order = [SUMMARY_KIND.SHORT, SUMMARY_KIND.DETAILED, SUMMARY_KIND.EXAM] as string[];
  const ranked = [...rows].filter((r) => order.includes(r.kind)).sort((a, b) => Number(b.locale === locale) - Number(a.locale === locale) || order.indexOf(a.kind) - order.indexOf(b.kind));
  return ranked[0] ?? null;
}

export async function sharedView(teacherId: number, workspaceId: string, shareId: string, locale: CoachLocale) {
  const db = requireDb();
  const [share] = await db
    .select()
    .from(coachShares)
    .where(and(eq(coachShares.id, shareId), eq(coachShares.teacherId, teacherId), eq(coachShares.workspaceId, workspaceId)))
    .limit(1);
  if (!share) throw new AppError("NOT_FOUND");
  const [material] = await db.select().from(coachMaterials).where(eq(coachMaterials.id, share.materialId)).limit(1);
  if (!material) throw new AppError("NOT_FOUND");
  const [student] = await db.select({ name: users.name }).from(users).where(eq(users.id, share.studentId)).limit(1);
  const topics = await db.select({ id: coachTopics.id, ord: coachTopics.ord, title: coachTopics.title, pageFrom: coachTopics.pageFrom, pageTo: coachTopics.pageTo }).from(coachTopics).where(eq(coachTopics.materialId, material.id)).orderBy(asc(coachTopics.ord));
  const artifacts = await db
    .select({ topicId: coachArtifacts.topicId, kind: coachArtifacts.kind, locale: coachArtifacts.locale, content: coachArtifacts.content, updatedAt: coachArtifacts.updatedAt })
    .from(coachArtifacts)
    .where(eq(coachArtifacts.materialId, material.id));
  return {
    id: share.id,
    sharedAt: share.createdAt,
    studentName: student?.name ?? null,
    material: { title: material.title, fileId: material.fileId, fileName: material.fileName, mimeType: material.mimeType, sizeBytes: material.sizeBytes, pageCount: material.pageCount },
    topics: topics.map((topic) => {
      const s = pickSummary(
        artifacts.filter((a) => a.topicId === topic.id),
        locale,
      );
      return { ...topic, summary: s ? { kind: s.kind, locale: s.locale, content: s.content as ArtifactContent, updatedAt: s.updatedAt } : null };
    }),
  };
}

onMaterialDelete(async (ids) => {
  await requireDb().delete(coachShares).where(inArray(coachShares.materialId, ids));
});

/** "Delete all my data" and account clean-up. */
export async function deleteSharesOf(studentId: number) {
  await requireDb().delete(coachShares).where(eq(coachShares.studentId, studentId));
}
