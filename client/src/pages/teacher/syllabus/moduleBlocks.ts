import { MODULE_DETAILS_MAX_LINE, MODULE_DETAILS_MAX_LINES, type ModuleAssessmentDetails, type ModuleDetails } from "@shared/syllabusModuleDetails";

/** The three end-of-module blocks a teacher edits on the module card. */
export type BlockKey = "objectives" | "prerequisites" | "assessment";

/** Editing state of one block: list items as typed (may contain blanks) plus the assessment's text fields. */
export interface BlockDraft {
  items: string[];
  heading: string;
  intro: string;
  pipeline: string;
  listIntro: string;
}

export function draftOf(details: ModuleDetails, block: BlockKey): BlockDraft {
  const a = details.assessment;
  const items = block === "assessment" ? a.items : details[block];
  return {
    items: items.length ? [...items] : [""],
    heading: block === "assessment" ? a.heading : "",
    intro: block === "assessment" ? a.intro : "",
    pipeline: block === "assessment" ? a.pipeline : "",
    listIntro: block === "assessment" ? a.listIntro : "",
  };
}

/** Enter in item `index`: a new empty item right after it (returns the list and the index to focus). */
export function insertAfter(items: readonly string[], index: number): { items: string[]; focus: number } {
  const next = [...items];
  next.splice(index + 1, 0, "");
  return { items: next, focus: index + 1 };
}

/** Removes item `index`; the editor always keeps one (empty) input. Focus goes to the item before. */
export function removeAt(items: readonly string[], index: number): { items: string[]; focus: number } {
  const next = items.filter((_, i) => i !== index);
  return { items: next.length ? next : [""], focus: Math.max(0, index - 1) };
}

export function moveItem(items: readonly string[], index: number, delta: -1 | 1): string[] {
  const to = index + delta;
  if (to < 0 || to >= items.length) return [...items];
  const next = [...items];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function setItem(items: readonly string[], index: number, value: string): string[] {
  return items.map((v, i) => (i === index ? value : v));
}

/** What gets saved: trimmed, blank items dropped. */
export const cleanItems = (items: readonly string[]) => items.map((v) => v.trim()).filter(Boolean);

export type BlockProblem = { code: "tooMany"; max: number } | { code: "tooLong"; n: number; max: number };

export function validateDraft(draft: BlockDraft): BlockProblem | null {
  const items = cleanItems(draft.items);
  if (items.length > MODULE_DETAILS_MAX_LINES) return { code: "tooMany", max: MODULE_DETAILS_MAX_LINES };
  const long = draft.items.findIndex((v) => v.trim().length > MODULE_DETAILS_MAX_LINE);
  if (long >= 0) return { code: "tooLong", n: long + 1, max: MODULE_DETAILS_MAX_LINE };
  return null;
}

/** The module's details with one block replaced by the edited draft. */
export function applyDraft(details: ModuleDetails, block: BlockKey, draft: BlockDraft): ModuleDetails {
  const items = cleanItems(draft.items);
  if (block !== "assessment") return { ...details, [block]: items };
  const assessment: ModuleAssessmentDetails = {
    heading: draft.heading.trim(),
    intro: draft.intro.trim(),
    pipeline: draft.pipeline.trim(),
    listIntro: draft.listIntro.trim(),
    items,
  };
  return { ...details, assessment };
}

export function isDirty(details: ModuleDetails, block: BlockKey, draft: BlockDraft): boolean {
  return JSON.stringify(applyDraft(details, block, draft)) !== JSON.stringify(details);
}
