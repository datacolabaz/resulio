import { and, eq, inArray, isNull } from "drizzle-orm";
import { syllabi, syllabusModuleDetails, syllabusModules, syllabusVersionModuleDetails, syllabusVersions } from "../../drizzle/schema";
import { parseModuleDetails, type ModuleDetails } from "../../shared/syllabusModuleDetails";
import { requireDb, type DbOrTx } from "../db";
import { AI_ENGINEERING_MODULE_DETAILS, foldTitle, isAiEngineeringTitle, type AiEngineeringModuleContent } from "./content/aiEngineeringModuleDetails";
import { isLegacyCopy, legacyModuleDetails, type LegacyModuleFields } from "./legacyModuleDetails";
import type { VersionStructure } from "./types";

/**
 * Startup data backfill: puts the end-of-module blocks of content/aiEngineeringModuleDetails.ts on
 * the AI Engineering syllabus that already lives in the database. Idempotent and conservative:
 *   - exactly one syllabus titled like "AI Engineer…" (isAiEngineeringTitle: case and diacritics
 *     ignored, also "AI Mühəndis…", "Süni intellekt mühəndisi") whose modules map 1:1 onto the
 *     9 months, else nothing;
 *   - a module whose details row was set by a teacher (even to empty) is never touched; a row that is
 *     only a copy of the old objectives/prerequisites fields is replaced by the user's content;
 *   - published versions get the same rows, so pinned students see them without a republish.
 * Runs before the legacy merge (moduleDetailsBackfill.ts), which then leaves the mapped modules alone.
 */

export interface CandidateModule {
  id: string;
  title: string;
  position: number;
}
export interface CandidateSyllabus {
  id: string;
  title: string;
  archived: boolean;
  modules: CandidateModule[];
}

export type ModuleMapping = { ok: true; modules: Array<{ moduleId: string; month: number; title: string }> } | { ok: false; reason: string };

/**
 * Exactly as many modules as months → by position, each title must match its month. Otherwise
 * (e.g. an extra intro module) every month must match exactly one module, in the same order.
 */
export function mapModules(modules: readonly CandidateModule[], content: readonly AiEngineeringModuleContent[] = AI_ENGINEERING_MODULE_DETAILS): ModuleMapping {
  const sorted = [...modules].sort((a, b) => a.position - b.position);
  const hit = (c: AiEngineeringModuleContent, m: CandidateModule) => c.match.test(m.title) || c.match.test(foldTitle(m.title));
  if (sorted.length === content.length) {
    const misses = content.filter((c, i) => !hit(c, sorted[i]));
    if (misses.length) return { ok: false, reason: `module titles do not match months ${misses.map((c) => c.month).join(", ")}: ${sorted.map((m) => JSON.stringify(m.title)).join(", ")}` };
    return { ok: true, modules: content.map((c, i) => ({ moduleId: sorted[i].id, month: c.month, title: sorted[i].title })) };
  }
  const picked: CandidateModule[] = [];
  for (const c of content) {
    const hits = sorted.filter((m) => hit(c, m));
    if (hits.length !== 1) return { ok: false, reason: `${hits.length} modules match month ${c.month} (${c.title}) among ${sorted.length} modules` };
    picked.push(hits[0]);
  }
  const ordered = picked.every((m, i) => i === 0 || sorted.indexOf(picked[i - 1]) < sorted.indexOf(m));
  if (!ordered || new Set(picked.map((m) => m.id)).size !== picked.length) return { ok: false, reason: "matched modules are not in month order" };
  return { ok: true, modules: content.map((c, i) => ({ moduleId: picked[i].id, month: c.month, title: picked[i].title })) };
}

export type BackfillPlan =
  | { action: "none"; found: number; reason: string }
  | { action: "fill"; syllabusId: string; title: string; modules: Array<{ moduleId: string; month: number; title: string }> };

export function planBackfill(candidates: readonly CandidateSyllabus[]): BackfillPlan {
  const titled = candidates.filter((s) => isAiEngineeringTitle(s.title));
  if (!titled.length) return { action: "none", found: 0, reason: `no syllabus title like "AI Engineer", "AI Mühəndis" or "Süni intellekt mühəndisi" among ${candidates.length} syllabi` };
  const found = titled.length;
  const mapped = titled.map((s) => ({ s, mapping: mapModules(s.modules) }));
  let ok = mapped.filter((x) => x.mapping.ok);
  if (!ok.length) return { action: "none", found, reason: mapped.map((x) => `"${x.s.title}" (${x.s.id}): ${(x.mapping as { reason: string }).reason}`).join("; ") };
  if (ok.length > 1) ok = ok.filter((x) => !x.s.archived);
  if (ok.length !== 1) return { action: "none", found, reason: `ambiguous: ${mapped.filter((x) => x.mapping.ok).map((x) => `"${x.s.title}" (${x.s.id})`).join(", ")} all match` };
  const { s, mapping } = ok[0];
  return { action: "fill", syllabusId: s.id, title: s.title, modules: (mapping as Extract<ModuleMapping, { ok: true }>).modules };
}

export interface BackfillRows {
  draft: Array<{ moduleId: string; syllabusId: string; details: ModuleDetails }>;
  version: Array<{ versionId: string; moduleId: string; details: ModuleDetails }>;
  skippedModules: string[];
}

/** Old module fields of a draft module or of a module inside a version structure. */
export interface BackfillSources {
  /** moduleId → stored draft details row. */
  draftRows: ReadonlyMap<string, ModuleDetails>;
  /** Draft modules' legacy objectives / prerequisitesText. */
  draftModules: readonly LegacyModuleFields[];
  /** Each version with the legacy fields of its modules (from its structure). */
  versions: ReadonlyArray<{ id: string; modules: readonly LegacyModuleFields[] }>;
  /** `${versionId}:${moduleId}` → stored version details row. */
  versionRows: ReadonlyMap<string, ModuleDetails>;
}

/**
 * The user's content wins over values merely copied from the old module fields: a row is written
 * when it is missing or is an untouched legacy copy (legacyModuleDetails.isLegacyCopy). A row a
 * teacher edited, or cleared to empty, is kept. Versions are only written for modules whose draft
 * is written, and only versions that contain the module.
 */
export function backfillRows(
  plan: Extract<BackfillPlan, { action: "fill" }>,
  sources: BackfillSources,
  content: readonly AiEngineeringModuleContent[] = AI_ENGINEERING_MODULE_DETAILS,
): BackfillRows {
  const byMonth = new Map(content.map((c) => [c.month, c.details]));
  const draftLegacy = new Map(sources.draftModules.map((m) => [m.id, legacyModuleDetails(m)]));
  const replaceable = (row: ModuleDetails | undefined, legacy: ModuleDetails | undefined) => !row || (!!legacy && isLegacyCopy(row, legacy));
  const out: BackfillRows = { draft: [], version: [], skippedModules: [] };
  for (const m of plan.modules) {
    const details = byMonth.get(m.month)!;
    if (!replaceable(sources.draftRows.get(m.moduleId), draftLegacy.get(m.moduleId))) {
      out.skippedModules.push(m.moduleId);
      continue;
    }
    out.draft.push({ moduleId: m.moduleId, syllabusId: plan.syllabusId, details });
    for (const v of sources.versions) {
      const vm = v.modules.find((x) => x.id === m.moduleId);
      if (!vm) continue;
      if (replaceable(sources.versionRows.get(`${v.id}:${m.moduleId}`), legacyModuleDetails(vm))) out.version.push({ versionId: v.id, moduleId: m.moduleId, details });
    }
  }
  return out;
}

const json = (d: ModuleDetails) => d as unknown as Record<string, unknown>;

export async function runAiEngineeringBackfill(db: DbOrTx = requireDb()) {
  const tag = "[Syllabus] AI Engineering module details";
  // Titles are matched in JS (diacritics folding); only id/title of every syllabus is read here.
  const all = await db.select({ id: syllabi.id, title: syllabi.title, archivedAt: syllabi.archivedAt }).from(syllabi);
  const rows = all.filter((r) => isAiEngineeringTitle(r.title));
  const ids = rows.map((r) => r.id);
  const modules = ids.length
    ? await db
        .select({
          id: syllabusModules.id,
          syllabusId: syllabusModules.syllabusId,
          title: syllabusModules.title,
          position: syllabusModules.position,
          objectives: syllabusModules.objectives,
          prerequisitesText: syllabusModules.prerequisitesText,
        })
        .from(syllabusModules)
        .where(and(inArray(syllabusModules.syllabusId, ids), isNull(syllabusModules.deletedAt)))
    : [];
  const plan = planBackfill(rows.map((r) => ({ id: r.id, title: r.title, archived: !!r.archivedAt, modules: modules.filter((m) => m.syllabusId === r.id) })));
  if (plan.action === "none") {
    const reason = plan.found ? plan.reason : `no syllabus title like "AI Engineer", "AI Mühəndis" or "Süni intellekt mühəndisi" among ${all.length} syllabi`;
    console.log(`${tag}: ${plan.found ? `FOUND ${plan.found} syllabus(es) by title, but` : "NOT FOUND —"} nothing written (${reason})`);
    return { written: 0, plan };
  }
  console.log(`${tag}: FOUND "${plan.title}" (${plan.syllabusId}), ${plan.modules.length} modules mapped`);

  const [draftRows, versionRows] = await Promise.all([
    db.select({ moduleId: syllabusModuleDetails.moduleId, details: syllabusModuleDetails.details }).from(syllabusModuleDetails).where(eq(syllabusModuleDetails.syllabusId, plan.syllabusId)),
    db.select({ id: syllabusVersions.id, structure: syllabusVersions.structure }).from(syllabusVersions).where(eq(syllabusVersions.syllabusId, plan.syllabusId)),
  ]);
  const versions = versionRows.map((v) => ({ id: v.id, modules: (v.structure as unknown as VersionStructure).modules ?? [] }));
  const existingVersion = versions.length
    ? await db
        .select({ versionId: syllabusVersionModuleDetails.versionId, moduleId: syllabusVersionModuleDetails.moduleId, details: syllabusVersionModuleDetails.details })
        .from(syllabusVersionModuleDetails)
        .where(inArray(syllabusVersionModuleDetails.versionId, versions.map((v) => v.id)))
    : [];
  const todo = backfillRows(plan, {
    draftRows: new Map(draftRows.map((r) => [r.moduleId, parseModuleDetails(r.details)])),
    draftModules: modules.filter((m) => m.syllabusId === plan.syllabusId),
    versions,
    versionRows: new Map(existingVersion.map((r) => [`${r.versionId}:${r.moduleId}`, parseModuleDetails(r.details)])),
  });
  if (!todo.draft.length) {
    console.log(`${tag}: "${plan.title}" (${plan.syllabusId}) already has details on all ${plan.modules.length} modules; nothing written`);
    return { written: 0, plan };
  }

  // Rows written here are missing or untouched legacy copies (backfillRows), so they are replaced.
  await db.transaction(async (tx) => {
    for (const r of todo.draft) {
      await tx.insert(syllabusModuleDetails).values({ ...r, details: json(r.details) }).onDuplicateKeyUpdate({ set: { details: json(r.details) } });
    }
    for (const r of todo.version) {
      await tx.insert(syllabusVersionModuleDetails).values({ ...r, details: json(r.details) }).onDuplicateKeyUpdate({ set: { details: json(r.details) } });
    }
  });
  const months = plan.modules.filter((m) => todo.draft.some((d) => d.moduleId === m.moduleId)).map((m) => `${m.month}="${m.title}"`);
  console.log(
    `${tag}: "${plan.title}" (${plan.syllabusId}) filled ${todo.draft.length} module(s) [${months.join(", ")}], ` +
      `${todo.version.length} published-version row(s) across ${versions.length} version(s); ${todo.skippedModules.length} module(s) already had details`,
  );
  return { written: todo.draft.length, plan };
}
