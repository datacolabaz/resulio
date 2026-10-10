import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { contentMeta, materials, type MaterialRow } from "../../drizzle/schema";
import { requireDb } from "../db";
import { dispatchManyNow, type DispatchInput } from "../notifications/dispatcher";
import { isMissingTable } from "../notifications/preferences";
import { taskExcerpt } from "../notifications/templates";
import { memberRows, senderName, type MemberRow } from "../modules/taskNotify";
import type { MaterialRecipients } from "./access";
import { claimPublish } from "./meta";

/**
 * MATERIAL_SHARED: students hear about a material once it becomes visible to them — on save
 * when published now, or from the sweeper when its scheduled time comes; an edit of a visible
 * material tells only students it newly reaches. One dedupe key per (material, student).
 */

export const materialSharedKey = (materialId: string, userId: number) => `material-shared:${materialId}:${userId}`;

/** Pure: active student members of its groups plus the individually listed students; never the teacher. */
export function materialRecipients(m: MaterialRecipients, members: readonly MemberRow[], teacherId: number): number[] {
  const inMaterial = new Set(m.groupIds);
  const fromGroups = members.filter((r) => inMaterial.has(r.groupId) && r.status === "ACTIVE" && r.membershipRole === "STUDENT").map((r) => r.userId);
  return [...new Set([...fromGroups, ...m.studentIds])].filter((id) => id !== teacherId);
}

/** Pure: who hears about one save. `wasVisible` false on create and for a draft or scheduled material going live. */
export function planMaterialNotices(input: { wasVisible: boolean; isVisible: boolean; before: readonly number[]; after: readonly number[]; notify: boolean }): number[] {
  if (!input.notify || !input.isVisible) return [];
  const after = [...new Set(input.after)];
  if (!input.wasVisible) return after;
  const had = new Set(input.before);
  return after.filter((id) => !had.has(id));
}

export function materialSharedDispatches(m: Pick<MaterialRow, "id" | "title" | "description">, userIds: readonly number[], from: string): DispatchInput[] {
  const data = { materialId: m.id, title: m.title, excerpt: taskExcerpt(m.description), from };
  return userIds.map((userId) => ({ event: "MATERIAL_SHARED", userId, dedupeKey: materialSharedKey(m.id, userId), data }));
}

async function announce(m: MaterialRow, userIds: readonly number[]) {
  if (!userIds.length) return;
  const from = await senderName(m.providerWorkspaceId, m.createdBy);
  await dispatchManyNow(materialSharedDispatches(m, userIds, from));
}

/**
 * After a material is saved. Runs in the background. Going live (create, or draft/scheduled →
 * visible) first claims `notifiedAt`, so the save and the sweeper never both announce it.
 */
export function notifyMaterialSaved(input: {
  material: MaterialRow;
  before: MaterialRecipients | null;
  wasVisible: boolean;
  isVisible: boolean;
  notify: boolean;
  teacherId: number;
}) {
  if (!input.isVisible) return;
  setImmediate(() => {
    void (async () => {
      const { material: m } = input;
      const goingLive = !input.wasVisible;
      if (goingLive && !(await claimPublish("MATERIAL", m.id))) return;
      if (!input.notify) return;
      const members = await memberRows([...new Set([...m.groupIds, ...(input.before?.groupIds ?? [])])]);
      const userIds = planMaterialNotices({
        wasVisible: input.wasVisible,
        isVisible: true,
        before: input.before ? materialRecipients(input.before, members, input.teacherId) : [],
        after: materialRecipients(m, members, input.teacherId),
        notify: true,
      });
      await announce(m, userIds);
    })().catch((error) => console.error("[materials] notices failed", error instanceof Error ? error.message : error));
  });
}

/**
 * Scheduled publishing: materials whose publish time has come and that were not announced yet.
 * Each row is claimed by a conditional UPDATE, so several instances never announce one twice.
 */
export async function runScheduledMaterialSweep(now: Date = new Date()): Promise<number> {
  const db = requireDb();
  let due: { id: string; notify: boolean }[];
  try {
    due = await db
      .select({ id: contentMeta.entityId, notify: contentMeta.notify })
      .from(contentMeta)
      .where(
        and(
          eq(contentMeta.entityType, "MATERIAL"),
          eq(contentMeta.status, "PUBLISHED"),
          isNotNull(contentMeta.publishAt),
          lte(contentMeta.publishAt, now),
          isNull(contentMeta.notifiedAt),
        ),
      )
      .limit(50);
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  let sent = 0;
  for (const row of due) {
    if (!(await claimPublish("MATERIAL", row.id, db))) continue;
    if (!row.notify) continue;
    const [m] = await db.select().from(materials).where(eq(materials.id, row.id)).limit(1);
    if (!m) continue;
    const members = await memberRows(m.groupIds);
    try {
      await announce(m, materialRecipients(m, members, m.createdBy));
      sent++;
    } catch (error) {
      console.error("[materials] scheduled notice failed", m.id, error instanceof Error ? error.message : error);
    }
  }
  return sent;
}
