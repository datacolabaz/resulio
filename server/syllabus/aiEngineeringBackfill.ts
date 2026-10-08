import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { syllabi, syllabusModuleDetails, syllabusModules, syllabusVersionModuleDetails, syllabusVersions } from "../../drizzle/schema";
import type { ModuleDetails } from "../../shared/syllabusModuleDetails";
import { requireDb, type DbOrTx } from "../db";
import { AI_ENGINEERING_MODULE_DETAILS, AI_ENGINEERING_SYLLABUS_TITLE, type AiEngineeringModuleContent } from "./content/aiEngineeringModuleDetails";
import type { VersionStructure } from "./types";

/**
 * Startup data backfill: puts the end-of-module blocks of content/aiEngineeringModuleDetails.ts on
 * the AI Engineering syllabus that already lives in the database. Idempotent and conservative:
 *   - exactly one syllabus titled "AI Engineer…" whose modules map 1:1 onto the 9 months, else nothing;
 *   - a module that already has a details row (set by a teacher, even to empty) is never touched;
 *   - published versions get the same rows, so pinned students see them without a republish.
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
  if (sorted.length === content.length) {
    const misses = content.filter((c, i) => !c.match.test(sorted[i].title));
    if (misses.length) return { ok: false, reason: `module titles do not match months ${misses.map((c) => c.month).join(", ")}: ${sorted.map((m) => JSON.stringify(m.title)).join(", ")}` };
    return { ok: true, modules: content.map((c, i) => ({ moduleId: sorted[i].id, month: c.month, title: sorted[i].title })) };
  }
  const picked: CandidateModule[] = [];
  for (const c of content) {
    const hits = sorted.filter((m) => c.match.test(m.title));
    if (hits.length !== 1) return { ok: false, reason: `${hits.length} modules match month ${c.month} (${c.title}) among ${sorted.length} modules` };
    picked.push(hits[0]);
  }
  const ordered = picked.every((m, i) => i === 0 || sorted.indexOf(picked[i - 1]) < sorted.indexOf(m));
  if (!ordered || new Set(picked.map((m) => m.id)).size !== picked.length) return { ok: false, reason: "matched modules are not in month order" };
  return { ok: true, modules: content.map((c, i) => ({ moduleId: picked[i].id, month: c.month, title: picked[i].title })) };
}

export type BackfillPlan =
  | { action: "none"; reason: string }
  | { action: "fill"; syllabusId: string; title: string; modules: Array<{ moduleId: string; month: number; title: string }> };

export function planBackfill(candidates: readonly CandidateSyllabus[]): BackfillPlan {
  const titled = candidates.filter((s) => AI_ENGINEERING_SYLLABUS_TITLE.test(s.title));
  if (!titled.length) return { action: "none", reason: "no syllabus titled 'AI Engineer…' found" };
  const mapped = titled.map((s) => ({ s, mapping: mapModules(s.modules) }));
  let ok = mapped.filter((x) => x.mapping.ok);
  if (!ok.length) return { action: "none", reason: mapped.map((x) => `"${x.s.title}" (${x.s.id}): ${(x.mapping as { reason: string }).reason}`).join("; ") };
  if (ok.length > 1) ok = ok.filter((x) => !x.s.archived);
  if (ok.length !== 1) return { action: "none", reason: `ambiguous: ${mapped.filter((x) => x.mapping.ok).map((x) => `"${x.s.title}" (${x.s.id})`).join(", ")} all match` };
  const { s, mapping } = ok[0];
  return { action: "fill", syllabusId: s.id, title: s.title, modules: (mapping as Extract<ModuleMapping, { ok: true }>).modules };
}

export interface BackfillRows {
  draft: Array<{ moduleId: string; syllabusId: string; details: ModuleDetails }>;
  version: Array<{ versionId: string; moduleId: string; details: ModuleDetails }>;
  skippedModules: string[];
}

/** Rows to insert: only modules without a draft details row, and only versions that contain the module. */
export function backfillRows(
  plan: Extract<BackfillPlan, { action: "fill" }>,
  existingDraft: ReadonlySet<string>,
  versions: ReadonlyArray<{ id: string; moduleIds: readonly string[] }>,
  existingVersionRows: ReadonlySet<string>,
  content: readonly AiEngineeringModuleContent[] = AI_ENGINEERING_MODULE_DETAILS,
): BackfillRows {
  const byMonth = new Map(content.map((c) => [c.month, c.details]));
  const out: BackfillRows = { draft: [], version: [], skippedModules: [] };
  for (const m of plan.modules) {
    const details = byMonth.get(m.month)!;
    if (existingDraft.has(m.moduleId)) {
      out.skippedModules.push(m.moduleId);
      continue;
    }
    out.draft.push({ moduleId: m.moduleId, syllabusId: plan.syllabusId, details });
    for (const v of versions) {
      if (v.moduleIds.includes(m.moduleId) && !existingVersionRows.has(`${v.id}:${m.moduleId}`)) out.version.push({ versionId: v.id, moduleId: m.moduleId, details });
    }
  }
  return out;
}

const json = (d: ModuleDetails) => d as unknown as Record<string, unknown>;

export async function runAiEngineeringBackfill(db: DbOrTx = requireDb()) {
  const tag = "[Syllabus] AI Engineering module details";
  const rows = await db
    .select({ id: syllabi.id, title: syllabi.title, archivedAt: syllabi.archivedAt })
    .from(syllabi)
    .where(like(sql`lower(${syllabi.title})`, "%engineer%"));
  const ids = rows.map((r) => r.id);
  const modules = ids.length
    ? await db
        .select({ id: syllabusModules.id, syllabusId: syllabusModules.syllabusId, title: syllabusModules.title, position: syllabusModules.position })
        .from(syllabusModules)
        .where(and(inArray(syllabusModules.syllabusId, ids), isNull(syllabusModules.deletedAt)))
    : [];
  const plan = planBackfill(rows.map((r) => ({ id: r.id, title: r.title, archived: !!r.archivedAt, modules: modules.filter((m) => m.syllabusId === r.id) })));
  if (plan.action === "none") {
    console.log(`${tag}: nothing written (${plan.reason})`);
    return { written: 0, plan };
  }

  const existingDraft = await db.select({ moduleId: syllabusModuleDetails.moduleId }).from(syllabusModuleDetails).where(eq(syllabusModuleDetails.syllabusId, plan.syllabusId));
  const versionRows = await db.select({ id: syllabusVersions.id, structure: syllabusVersions.structure }).from(syllabusVersions).where(eq(syllabusVersions.syllabusId, plan.syllabusId));
  const versions = versionRows.map((v) => ({ id: v.id, moduleIds: ((v.structure as unknown as VersionStructure).modules ?? []).map((m) => m.id) }));
  const existingVersion = versions.length
    ? await db
        .select({ versionId: syllabusVersionModuleDetails.versionId, moduleId: syllabusVersionModuleDetails.moduleId })
        .from(syllabusVersionModuleDetails)
        .where(inArray(syllabusVersionModuleDetails.versionId, versions.map((v) => v.id)))
    : [];
  const todo = backfillRows(plan, new Set(existingDraft.map((r) => r.moduleId)), versions, new Set(existingVersion.map((r) => `${r.versionId}:${r.moduleId}`)));
  if (!todo.draft.length) {
    console.log(`${tag}: "${plan.title}" (${plan.syllabusId}) already has details on all ${plan.modules.length} modules; nothing written`);
    return { written: 0, plan };
  }

  await db.transaction(async (tx) => {
    // A concurrent instance may have written the same rows: duplicates are no-ops.
    await tx
      .insert(syllabusModuleDetails)
      .values(todo.draft.map((r) => ({ ...r, details: json(r.details) })))
      .onDuplicateKeyUpdate({ set: { moduleId: sql`${syllabusModuleDetails.moduleId}` } });
    if (todo.version.length) {
      await tx
        .insert(syllabusVersionModuleDetails)
        .values(todo.version.map((r) => ({ ...r, details: json(r.details) })))
        .onDuplicateKeyUpdate({ set: { moduleId: sql`${syllabusVersionModuleDetails.moduleId}` } });
    }
  });
  const months = plan.modules.filter((m) => todo.draft.some((d) => d.moduleId === m.moduleId)).map((m) => `${m.month}="${m.title}"`);
  console.log(
    `${tag}: "${plan.title}" (${plan.syllabusId}) filled ${todo.draft.length} module(s) [${months.join(", ")}], ` +
      `${todo.version.length} published-version row(s) across ${versions.length} version(s); ${todo.skippedModules.length} module(s) already had details`,
  );
  return { written: todo.draft.length, plan };
}
