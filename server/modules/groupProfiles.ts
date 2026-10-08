import { desc, eq, inArray, isNull } from "drizzle-orm";
import { groupProfiles, groups, providerWorkspaces } from "../../drizzle/schema";
import { classifyLegacyGroup, type ClassificationReason, type GroupType, type WorkspaceKind } from "../../shared/groupType";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";

const TAG = "[Groups] group types";
const CHUNK = 500;

export interface StoredProfile {
  groupType: GroupType;
  level: string;
}

/** What every group read returns: the type, the Sinif (`grade`, school only) and the Səviyyə (`level`, course only). */
export interface GroupProfileView {
  groupType: GroupType;
  grade: string;
  level: string;
}

const chunks = <T>(list: readonly T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

/** Stored rows by group id; empty before migration 0040 so reads still work. */
export async function loadProfiles(groupIds: readonly string[], db: DbOrTx = requireDb()): Promise<Map<string, StoredProfile>> {
  const out = new Map<string, StoredProfile>();
  try {
    for (const ids of chunks([...new Set(groupIds)])) {
      const rows = await db.select({ groupId: groupProfiles.groupId, groupType: groupProfiles.groupType, level: groupProfiles.level }).from(groupProfiles).where(inArray(groupProfiles.groupId, ids));
      for (const r of rows) out.set(r.groupId, { groupType: r.groupType, level: r.level });
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return out;
}

/** A stored profile wins; a group without one is classified from its old combined value (same rule as the backfill). */
export function profileView(group: { subject: string; grade: string }, stored: StoredProfile | undefined, ws: WorkspaceKind = {}): GroupProfileView {
  if (stored) {
    return stored.groupType === "SCHOOL" ? { groupType: "SCHOOL", grade: group.grade, level: "" } : { groupType: "COURSE", grade: "", level: stored.level };
  }
  const c = classifyLegacyGroup({ subject: group.subject, grade: group.grade, ...ws });
  return { groupType: c.groupType, grade: c.grade, level: c.level };
}

/** One group's view, for the public previews (which already join the workspace). */
export async function groupProfileOf(group: { id: string; subject: string; grade: string } & WorkspaceKind, db: DbOrTx = requireDb()): Promise<GroupProfileView> {
  return profileView(group, (await loadProfiles([group.id], db)).get(group.id), group);
}

/** Adds groupType/level to group rows and replaces `grade` with the Sinif the type actually shows. */
export async function withProfiles<T extends { id: string; subject: string; grade: string; providerWorkspaceId: string }>(
  rows: readonly T[],
  db: DbOrTx = requireDb(),
): Promise<Array<T & GroupProfileView>> {
  if (!rows.length) return [];
  const stored = await loadProfiles(rows.map((r) => r.id), db);
  const missingWs = [...new Set(rows.filter((r) => !stored.has(r.id)).map((r) => r.providerWorkspaceId))];
  const kinds = new Map<string, WorkspaceKind>();
  if (missingWs.length) {
    const ws = await db
      .select({ id: providerWorkspaces.id, teachingCategory: providerWorkspaces.teachingCategory, providerType: providerWorkspaces.providerType })
      .from(providerWorkspaces)
      .where(inArray(providerWorkspaces.id, missingWs));
    for (const w of ws) kinds.set(w.id, w);
  }
  return rows.map((r) => ({ ...r, ...profileView(r, stored.get(r.id), kinds.get(r.providerWorkspaceId)) }));
}

/** Upserts the teacher's choice. Returns false before migration 0040 (the caller keeps the level elsewhere). */
export async function saveProfile(groupId: string, profile: StoredProfile, db: DbOrTx = requireDb()): Promise<boolean> {
  try {
    await db
      .insert(groupProfiles)
      .values({ groupId, ...profile, source: "TEACHER" })
      .onDuplicateKeyUpdate({ set: { groupType: profile.groupType, level: profile.level, source: "TEACHER" } });
    return true;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    return false;
  }
}

/** The type of the workspace's most recently created group, for the new-group form's default. */
export async function latestGroupType(workspaceId: string, db: DbOrTx = requireDb()): Promise<GroupType | null> {
  const recent = await db
    .select({ id: groups.id, subject: groups.subject, grade: groups.grade, providerWorkspaceId: groups.providerWorkspaceId })
    .from(groups)
    .where(eq(groups.providerWorkspaceId, workspaceId))
    .orderBy(desc(groups.createdAt))
    .limit(1);
  if (!recent.length) return null;
  const [latest] = await withProfiles(recent, db);
  return latest.groupType;
}

export interface BackfillRow {
  groupId: string;
  groupType: GroupType;
  level: string;
  source: `auto:${ClassificationReason}`;
}

/** Rows for groups that have no profile yet. `study_groups` itself is never written: the old value stays in `grade`. */
export function planProfileBackfill(candidates: ReadonlyArray<{ id: string; subject: string; grade: string } & WorkspaceKind>): BackfillRow[] {
  return candidates.map((g) => {
    const c = classifyLegacyGroup(g);
    return { groupId: g.id, groupType: c.groupType, level: c.level, source: `auto:${c.reason}` };
  });
}

/**
 * Every start: writes a profile for each group that has none — groups from before group types, or
 * made by an older instance during a rolling deploy. INSERT IGNORE, so a teacher's own choice
 * (saved meanwhile, or by a concurrent instance) is never overwritten and reruns are harmless.
 */
export async function runGroupProfileBackfill(db: DbOrTx = requireDb()) {
  try {
    const candidates = await db
      .select({
        id: groups.id,
        subject: groups.subject,
        grade: groups.grade,
        teachingCategory: providerWorkspaces.teachingCategory,
        providerType: providerWorkspaces.providerType,
      })
      .from(groups)
      .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, groups.providerWorkspaceId))
      .leftJoin(groupProfiles, eq(groupProfiles.groupId, groups.id))
      .where(isNull(groupProfiles.groupId));
    const plan = planProfileBackfill(candidates);
    for (const part of chunks(plan)) await db.insert(groupProfiles).ignore().values(part);
    if (plan.length) {
      const bySource = new Map<string, number>();
      for (const r of plan) bySource.set(`${r.groupType} ${r.source}`, (bySource.get(`${r.groupType} ${r.source}`) ?? 0) + 1);
      console.log(`${TAG}: classified ${plan.length} group(s): ${[...bySource].map(([k, n]) => `${k}=${n}`).join(", ")}`);
    }
    return plan;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    console.warn(`${TAG}: backfill waits for migration 0040`);
    return [];
  }
}
