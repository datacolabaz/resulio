import { and, eq, inArray, isNull } from "drizzle-orm";
import { syllabusModuleDetails, syllabusModules, syllabusVersionModuleDetails } from "../../drizzle/schema";
import { hasModuleDetails, parseModuleDetails, type ModuleDetails } from "../../shared/syllabusModuleDetails";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";
import { withLegacyFallback } from "./legacyModuleDetails";

/**
 * "End of module" blocks (shared/syllabusModuleDetails.ts). Draft rows are edited in the builder and
 * copied per version on publish; students read the copy of their pinned version. Before migration
 * 0033 runs the tables are missing: reads return nothing, so syllabi work exactly as before.
 */

async function tolerant<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingTable(error)) return fallback;
    throw error;
  }
}

const toMap = (rows: Array<{ moduleId: string; details: unknown }>) => new Map(rows.map((r) => [r.moduleId, parseModuleDetails(r.details)]));

/** moduleId → stored draft row. A module with a row has been set (possibly to empty). */
export async function draftModuleDetailRows(syllabusId: string, db: DbOrTx = requireDb()): Promise<Map<string, ModuleDetails>> {
  return tolerant(new Map(), async () =>
    toMap(await db.select({ moduleId: syllabusModuleDetails.moduleId, details: syllabusModuleDetails.details }).from(syllabusModuleDetails).where(eq(syllabusModuleDetails.syllabusId, syllabusId))),
  );
}

/** moduleId → draft details as the builder, preview and publish see them (legacy fallback for modules without a row). */
export async function draftModuleDetails(syllabusId: string, db: DbOrTx = requireDb()): Promise<Map<string, ModuleDetails>> {
  const [rows, modules] = await Promise.all([
    draftModuleDetailRows(syllabusId, db),
    db
      .select({ id: syllabusModules.id, objectives: syllabusModules.objectives, prerequisitesText: syllabusModules.prerequisitesText })
      .from(syllabusModules)
      .where(and(eq(syllabusModules.syllabusId, syllabusId), isNull(syllabusModules.deletedAt))),
  ]);
  return withLegacyFallback(rows, modules);
}

/** moduleId → details frozen into this version (raw rows; studentPathView adds the legacy fallback from the structure). */
export async function versionModuleDetails(versionId: string, db: DbOrTx = requireDb()): Promise<Map<string, ModuleDetails>> {
  return tolerant(new Map(), async () =>
    toMap(
      await db
        .select({ moduleId: syllabusVersionModuleDetails.moduleId, details: syllabusVersionModuleDetails.details })
        .from(syllabusVersionModuleDetails)
        .where(eq(syllabusVersionModuleDetails.versionId, versionId)),
    ),
  );
}

export async function saveDraftModuleDetails(syllabusId: string, moduleId: string, details: ModuleDetails, db: DbOrTx = requireDb()) {
  const json = details as unknown as Record<string, unknown>;
  await db.insert(syllabusModuleDetails).values({ moduleId, syllabusId, details: json }).onDuplicateKeyUpdate({ set: { details: json } });
}

/** Publish: copies the non-empty draft details of the modules that made it into the version. */
export async function freezeModuleDetails(tx: DbOrTx, versionId: string, draft: ReadonlyMap<string, ModuleDetails>, moduleIds: readonly string[]) {
  const rows = moduleIds.flatMap((moduleId) => {
    const d = draft.get(moduleId);
    return hasModuleDetails(d) ? [{ versionId, moduleId, details: d as unknown as Record<string, unknown> }] : [];
  });
  if (rows.length) await tx.insert(syllabusVersionModuleDetails).values(rows);
}

/** Both tables for a purged syllabus; a missing table (migration not applied) has nothing to delete. */
export async function purgeModuleDetails(tx: DbOrTx, syllabusId: string, versionIds: readonly string[]) {
  await tolerant(undefined, async () => {
    if (versionIds.length) await tx.delete(syllabusVersionModuleDetails).where(inArray(syllabusVersionModuleDetails.versionId, [...versionIds]));
    await tx.delete(syllabusModuleDetails).where(eq(syllabusModuleDetails.syllabusId, syllabusId));
  });
}

/** Module ids whose details differ between the draft and a version (for the publish dialog's diff). */
export function changedDetailModules(draft: ReadonlyMap<string, ModuleDetails>, published: ReadonlyMap<string, ModuleDetails>, moduleIds: readonly string[]) {
  const norm = (d: ModuleDetails | undefined) => (hasModuleDetails(d) ? JSON.stringify(d) : "");
  return new Set(moduleIds.filter((id) => norm(draft.get(id)) !== norm(published.get(id))));
}
