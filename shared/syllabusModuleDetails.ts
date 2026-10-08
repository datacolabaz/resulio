import { z } from "zod";

/**
 * Blocks shown at the end of a module: objectives, prerequisites and how the module is assessed.
 * Pure data edited in the builder (labels are UI chrome in the i18n catalog). Stored beside the
 * module (`syllabus_module_details`) and frozen per version (`syllabus_version_module_details`).
 */

export const MODULE_DETAILS_MAX_LINES = 30;
export const MODULE_DETAILS_MAX_LINE = 500;

const line = z.string().trim().min(1).max(MODULE_DETAILS_MAX_LINE);
const lines = z.array(line).max(MODULE_DETAILS_MAX_LINES);
const text = z.string().trim().max(MODULE_DETAILS_MAX_LINE);

/**
 * `items` is the usual bullet list. A final project adds a `heading`, an `intro` sentence, a
 * `pipeline` line (e.g. "Problem → Data → … → Deployment") and a `listIntro` before the criteria.
 */
export const moduleAssessmentDetailsSchema = z.object({
  heading: text.default(""),
  intro: text.default(""),
  pipeline: text.default(""),
  listIntro: text.default(""),
  items: lines.default([]),
});

export const moduleDetailsSchema = z.object({
  objectives: lines.default([]),
  prerequisites: lines.default([]),
  assessment: moduleAssessmentDetailsSchema.default({ heading: "", intro: "", pipeline: "", listIntro: "", items: [] }),
});

export type ModuleAssessmentDetails = z.output<typeof moduleAssessmentDetailsSchema>;
export type ModuleDetails = z.output<typeof moduleDetailsSchema>;

export function emptyModuleDetails(): ModuleDetails {
  return { objectives: [], prerequisites: [], assessment: { heading: "", intro: "", pipeline: "", listIntro: "", items: [] } };
}

/** Stored JSON → details; anything malformed reads as empty rather than breaking the page. */
export function parseModuleDetails(raw: unknown): ModuleDetails {
  const parsed = moduleDetailsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyModuleDetails();
}

export function hasAssessmentDetails(a: ModuleAssessmentDetails): boolean {
  return !!(a.heading || a.intro || a.pipeline || a.listIntro || a.items.length);
}

export function hasModuleDetails(d: ModuleDetails | null | undefined): d is ModuleDetails {
  return !!d && (d.objectives.length > 0 || d.prerequisites.length > 0 || hasAssessmentDetails(d.assessment));
}
