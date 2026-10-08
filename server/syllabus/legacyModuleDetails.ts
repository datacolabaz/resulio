import {
  emptyModuleDetails,
  hasModuleDetails,
  MODULE_DETAILS_MAX_LINE,
  MODULE_DETAILS_MAX_LINES,
  type ModuleDetails,
} from "../../shared/syllabusModuleDetails";

/**
 * Modules used to carry `objectives` (json string[]) and `prerequisitesText` (free text) on
 * syllabus_modules and in every version structure. Those now live only in the end-of-module
 * details. The old columns are kept (no data dropped) but are read only here: by the one-time
 * merge (moduleDetailsBackfill.ts), by the read-time fallback for a module that has no details
 * row yet, and when an old client still sends the fields (mapped into details).
 */

export interface LegacyModuleFields {
  id: string;
  objectives?: unknown;
  prerequisitesText?: string | null;
}

const BULLET = /^(?:[-*•·–—▪►]+|\d{1,2}[.)])\s+/;

/** Breaks a line longer than the details limit at sentence ends, then at spaces, so nothing is cut off. */
function wrap(line: string): string[] {
  if (line.length <= MODULE_DETAILS_MAX_LINE) return [line];
  const out: string[] = [];
  let current = "";
  const push = () => {
    if (current) out.push(current);
    current = "";
  };
  for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
    let rest = sentence;
    while (rest.length > MODULE_DETAILS_MAX_LINE) {
      push();
      const cut = rest.lastIndexOf(" ", MODULE_DETAILS_MAX_LINE);
      const at = cut > MODULE_DETAILS_MAX_LINE / 2 ? cut : MODULE_DETAILS_MAX_LINE;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (!rest) continue;
    if (current && current.length + 1 + rest.length > MODULE_DETAILS_MAX_LINE) push();
    current = current ? `${current} ${rest}` : rest;
  }
  push();
  return out;
}

/** Trimmed, de-bulleted, non-empty lines within the details limits (extra lines beyond the cap are dropped). */
export function normalizeLegacyLines(lines: readonly string[]): string[] {
  return lines
    .map((l) => l.trim().replace(BULLET, "").trim())
    .filter(Boolean)
    .flatMap(wrap)
    .slice(0, MODULE_DETAILS_MAX_LINES);
}

/** Free text (one item per line; "- ", "• ", "1." markers removed) → list items. */
export function splitLegacyText(text: string | null | undefined): string[] {
  return text ? normalizeLegacyLines(text.split(/\r\n|\r|\n/)) : [];
}

const legacyObjectives = (raw: unknown) => (Array.isArray(raw) ? normalizeLegacyLines(raw.filter((o): o is string => typeof o === "string")) : []);

/** What the old fields of one module amount to as details (empty when both were empty). */
export function legacyModuleDetails(m: Omit<LegacyModuleFields, "id">): ModuleDetails {
  return { ...emptyModuleDetails(), objectives: legacyObjectives(m.objectives), prerequisites: splitLegacyText(m.prerequisitesText) };
}

/**
 * Copies the legacy lists into the fields of `current` that are empty. Returns the new details, or
 * null when nothing would change (legacy empty, or both fields already filled).
 */
export function mergeLegacy(current: ModuleDetails | undefined, legacy: ModuleDetails): ModuleDetails | null {
  const base = current ?? emptyModuleDetails();
  const fillObjectives = !base.objectives.length && legacy.objectives.length > 0;
  const fillPrerequisites = !base.prerequisites.length && legacy.prerequisites.length > 0;
  if (!fillObjectives && !fillPrerequisites) return null;
  return { ...base, objectives: fillObjectives ? legacy.objectives : base.objectives, prerequisites: fillPrerequisites ? legacy.prerequisites : base.prerequisites };
}

const same = (a: ModuleDetails, b: ModuleDetails) => JSON.stringify(a) === JSON.stringify(b);

/**
 * True when `details` is exactly what the merge would produce from the legacy fields alone, i.e.
 * nobody has edited the blocks since. The AI Engineering backfill may replace such rows; an empty
 * row (blocks cleared by a teacher) or anything edited never matches.
 */
export function isLegacyCopy(details: ModuleDetails, legacy: ModuleDetails): boolean {
  return hasModuleDetails(details) && hasModuleDetails(legacy) && same(details, legacy);
}

/**
 * Read-time fallback: a module without a details row shows its legacy fields (until the one-time
 * merge has written the row). A module with a row, even an empty one, never falls back, so nothing
 * shows twice and cleared blocks stay cleared.
 */
export function withLegacyFallback(rows: ReadonlyMap<string, ModuleDetails>, modules: readonly LegacyModuleFields[]): Map<string, ModuleDetails> {
  const out = new Map(rows);
  for (const m of modules) {
    if (out.has(m.id)) continue;
    const legacy = legacyModuleDetails(m);
    if (hasModuleDetails(legacy)) out.set(m.id, legacy);
  }
  return out;
}

/**
 * API compatibility: an old client sending `objectives` / `prerequisitesText` on a module replaces
 * those two lists in the details. Returns null when the result equals `current` (nothing to write).
 */
export function applyLegacyPatch(current: ModuleDetails | undefined, patch: { objectives?: string[]; prerequisitesText?: string | null }): ModuleDetails | null {
  const base = current ?? emptyModuleDetails();
  const next: ModuleDetails = {
    ...base,
    objectives: patch.objectives !== undefined ? legacyObjectives(patch.objectives) : base.objectives,
    prerequisites: patch.prerequisitesText !== undefined ? splitLegacyText(patch.prerequisitesText) : base.prerequisites,
  };
  return same(next, base) ? null : next;
}
