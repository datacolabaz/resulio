/**
 * What a teaching workspace is for, shown as a two-step picker when a teacher creates their
 * space (replaces a free-text "space name"). TEACHING_CATEGORIES is the controlled top-level
 * list — extending it is a deliberate code change. Each category's subcategory list is plain
 * data (no DB enum), so it can grow without a migration; the client always appends "OTHER" to
 * let a teacher type the specific thing themselves when nothing fits. The category "OTHER" has
 * no subcategory list at all — picking it shows a single free-text field.
 *
 * Both the chosen category key and the resulting subcategory value (a known subkey, or the
 * teacher's own typed text when "OTHER" was picked) are stored as plain strings on the
 * workspace row; `teachingSubcategoryLabel` in client/src/lib/format.ts falls back to showing
 * raw text for anything that isn't a known key, so free text displays correctly either way.
 */
export const TEACHING_CATEGORIES = [
  "UNIVERSITY_PREP",
  "SCHOOL",
  "GRADUATION_EXAM",
  "INTERNATIONAL_EXAM",
  "LANGUAGE",
  "IT",
  "BUSINESS",
  "EARLY_CHILDHOOD",
  "OTHER",
] as const;

export type TeachingCategory = (typeof TEACHING_CATEGORIES)[number];

/** Categories with their own subcategory picklist. "OTHER" (the top-level category) is excluded on purpose. */
export const TEACHING_SUBCATEGORIES: Record<Exclude<TeachingCategory, "OTHER">, readonly string[]> = {
  UNIVERSITY_PREP: [
    "MATH",
    "PHYSICS",
    "CHEMISTRY",
    "BIOLOGY",
    "AZ_LANGUAGE_LITERATURE",
    "HISTORY",
    "GEOGRAPHY",
    "ENGLISH",
    "GEOMETRY",
    "RUSSIAN",
    "OTHER",
  ],
  SCHOOL: [
    "PRIMARY",
    "MATH",
    "PHYSICS",
    "CHEMISTRY",
    "BIOLOGY",
    "AZ_LANGUAGE_LITERATURE",
    "ENGLISH",
    "HISTORY",
    "GEOGRAPHY",
    "INFORMATICS",
    "OTHER",
  ],
  GRADUATION_EXAM: ["MATH", "AZ_LANGUAGE", "OTHER"],
  INTERNATIONAL_EXAM: ["IELTS", "TOEFL", "SAT", "GRE_GMAT", "CAMBRIDGE", "DELF_DALF", "TESTDAF_GOETHE", "OTHER"],
  LANGUAGE: ["ENGLISH", "RUSSIAN", "GERMAN", "FRENCH", "TURKISH", "ARABIC", "CHINESE", "SPANISH", "OTHER"],
  IT: ["WEB_DEV", "MOBILE_DEV", "DATA_ANALYTICS", "CYBERSECURITY", "DESIGN_UIUX", "GAME_DEV", "AI_ML", "OTHER"],
  BUSINESS: ["ACCOUNTING_FINANCE", "MARKETING", "PROJECT_MANAGEMENT", "SALES", "HR", "OTHER"],
  EARLY_CHILDHOOD: ["NUMERACY_LITERACY", "EARLY_DEVELOPMENT", "OTHER"],
};
