import { eq, inArray, isNull } from "drizzle-orm";
import { syllabusDataBackfills, syllabusModuleDetails, syllabusModules, syllabusVersionModuleDetails, syllabusVersions } from "../../drizzle/schema";
import { parseModuleDetails, type ModuleDetails } from "../../shared/syllabusModuleDetails";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";
import { runAiEngineeringBackfill } from "./aiEngineeringBackfill";
import { legacyModuleDetails, mergeLegacy, type LegacyModuleFields } from "./legacyModuleDetails";
import type { VersionStructure } from "./types";

/**
 * Startup data steps for the end-of-module blocks, in this order:
 *   1. AI Engineering content (aiEngineeringBackfill.ts, every start, idempotent). Its content is
 *      authoritative: it replaces rows that are only copies of the old fields, never teacher edits.
 *   2. Legacy merge (once, recorded in syllabus_data_backfills): copies the old module
 *      `objectives` / `prerequisitesText` of every syllabus into the details fields that are still
 *      empty, for drafts and for every published version. Modules mapped by step 1 are skipped, so
 *      the AI Engineering modules end up with exactly the user's content.
 * If step 1 throws, step 2 waits for the next start so it can never pre-empt the AI content.
 */

export const LEGACY_MERGE = "module-details-legacy-merge-v1";

const TAG = "[Syllabus] module details";
const CHUNK = 500;

export interface LegacyMergeInput {
  draftModules: ReadonlyArray<LegacyModuleFields & { syllabusId: string }>;
  /** moduleId → stored draft row. */
  draftRows: ReadonlyMap<string, ModuleDetails>;
  versions: ReadonlyArray<{ id: string; modules: readonly LegacyModuleFields[] }>;
  /** `${versionId}:${moduleId}` → stored version row. */
  versionRows: ReadonlyMap<string, ModuleDetails>;
  /** Modules whose blocks come from authoritative content: never merged. */
  exclude: ReadonlySet<string>;
}

export interface LegacyMergePlan {
  draft: Array<{ moduleId: string; syllabusId: string; details: ModuleDetails }>;
  version: Array<{ versionId: string; moduleId: string; details: ModuleDetails }>;
}

/** Rows to upsert: only where a legacy list is non-empty and the matching details field is empty. */
export function planLegacyMerge(input: LegacyMergeInput): LegacyMergePlan {
  const out: LegacyMergePlan = { draft: [], version: [] };
  for (const m of input.draftModules) {
    if (input.exclude.has(m.id)) continue;
    const details = mergeLegacy(input.draftRows.get(m.id), legacyModuleDetails(m));
    if (details) out.draft.push({ moduleId: m.id, syllabusId: m.syllabusId, details });
  }
  for (const v of input.versions) {
    for (const m of v.modules) {
      if (input.exclude.has(m.id)) continue;
      const details = mergeLegacy(input.versionRows.get(`${v.id}:${m.id}`), legacyModuleDetails(m));
      if (details) out.version.push({ versionId: v.id, moduleId: m.id, details });
    }
  }
  return out;
}

const chunks = <T>(list: readonly T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));
const json = (d: ModuleDetails) => d as unknown as Record<string, unknown>;

function isDuplicate(error: unknown) {
  let e = error as { errno?: number; code?: string; cause?: unknown } | undefined;
  for (let i = 0; e && i < 5; i++) {
    if (e.errno === 1062 || e.code === "ER_DUP_ENTRY") return true;
    e = e.cause as typeof e;
  }
  return false;
}

export async function runLegacyMerge(db: DbOrTx = requireDb(), exclude: ReadonlySet<string> = new Set()) {
  const [done] = await db.select({ name: syllabusDataBackfills.name }).from(syllabusDataBackfills).where(eq(syllabusDataBackfills.name, LEGACY_MERGE)).limit(1);
  if (done) return { ran: false as const, reason: "already ran" };

  const draftModules = await db
    .select({ id: syllabusModules.id, syllabusId: syllabusModules.syllabusId, objectives: syllabusModules.objectives, prerequisitesText: syllabusModules.prerequisitesText })
    .from(syllabusModules)
    .where(isNull(syllabusModules.deletedAt));
  const draftRows = new Map<string, ModuleDetails>();
  for (const ids of chunks(draftModules.map((m) => m.id))) {
    const rows = await db.select({ moduleId: syllabusModuleDetails.moduleId, details: syllabusModuleDetails.details }).from(syllabusModuleDetails).where(inArray(syllabusModuleDetails.moduleId, ids));
    for (const r of rows) draftRows.set(r.moduleId, parseModuleDetails(r.details));
  }
  const versions = (await db.select({ id: syllabusVersions.id, structure: syllabusVersions.structure }).from(syllabusVersions)).map((v) => ({
    id: v.id,
    modules: ((v.structure as unknown as VersionStructure).modules ?? []).map((m) => ({ id: m.id, objectives: m.objectives, prerequisitesText: m.prerequisitesText })),
  }));
  const versionRows = new Map(
    (await db.select({ versionId: syllabusVersionModuleDetails.versionId, moduleId: syllabusVersionModuleDetails.moduleId, details: syllabusVersionModuleDetails.details }).from(syllabusVersionModuleDetails)).map(
      (r) => [`${r.versionId}:${r.moduleId}`, parseModuleDetails(r.details)] as const,
    ),
  );
  const plan = planLegacyMerge({ draftModules, draftRows, versions, versionRows, exclude });
  const summary = `${plan.draft.length} draft module(s), ${plan.version.length} published-version row(s) across ${versions.length} version(s); ${exclude.size} AI Engineering module(s) left to their content`;

  try {
    await db.transaction(async (tx) => {
      // The marker goes first: a second instance running concurrently fails here and writes nothing.
      await tx.insert(syllabusDataBackfills).values({ name: LEGACY_MERGE, summary });
      for (const r of plan.draft) {
        await tx.insert(syllabusModuleDetails).values({ ...r, details: json(r.details) }).onDuplicateKeyUpdate({ set: { details: json(r.details) } });
      }
      for (const r of plan.version) {
        await tx.insert(syllabusVersionModuleDetails).values({ ...r, details: json(r.details) }).onDuplicateKeyUpdate({ set: { details: json(r.details) } });
      }
    });
  } catch (error) {
    if (isDuplicate(error)) return { ran: false as const, reason: "another instance ran it" };
    throw error;
  }
  return { ran: true as const, summary, plan };
}

/** Called once per server start (see the order above). */
export async function runModuleDetailsBackfills(db: DbOrTx = requireDb()) {
  const ai = await runAiEngineeringBackfill(db);
  const exclude = new Set(ai.plan.action === "fill" ? ai.plan.modules.map((m) => m.moduleId) : []);
  try {
    const merged = await runLegacyMerge(db, exclude);
    console.log(merged.ran ? `${TAG}: copied old objectives/prerequisites into ${merged.summary}` : `${TAG}: legacy merge skipped (${merged.reason})`);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    console.warn(`${TAG}: legacy merge waits for migration 0034`);
  }
}
