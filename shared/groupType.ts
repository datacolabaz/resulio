/**
 * A group is either a school class (Fənn + Sinif, e.g. "Riyaziyyat" · "9A") or a course
 * (İstiqamət + Səviyyə, e.g. "AI Engineering" · Beginner). Both keep the subject/direction in
 * `study_groups.subject` and the school class in `study_groups.grade`; the type and the course
 * level live in the `group_profiles` side table. See docs/GROUP-TYPES.md.
 */
export const GROUP_TYPES = ["SCHOOL", "COURSE"] as const;
export type GroupType = (typeof GROUP_TYPES)[number];

/** Suggested course levels. A level outside this list is kept as the teacher's own text. */
export const GROUP_LEVELS = ["BEGINNER", "INTERMEDIATE", "ADVANCED", "PROFESSIONAL"] as const;
export type GroupLevel = (typeof GROUP_LEVELS)[number];

/** Column limits: `study_groups.grade` varchar(32), `group_profiles.level` varchar(64). */
export const GROUP_CLASS_MAX = 32;
export const GROUP_LEVEL_MAX = 64;

/** Lower-case, Azerbaijani/Russian-aware and ASCII-folded, so "İrəli", "irəli" and "ireli" compare equal. */
export function foldText(value: string): string {
  return value
    .trim()
    .replace(/İ/g, "i")
    .toLowerCase()
    .replace(/ə/g, "e")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ");
}

const tokens = (folded: string) => folded.split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);

/** Folded spellings of each level in AZ / EN / RU, as teachers type them. */
const LEVEL_SYNONYMS: Record<GroupLevel, readonly string[]> = {
  BEGINNER: ["beginner", "beginners", "baslangic", "ilkin", "начальный", "начинающий", "начинающие", "новичок", "новички"],
  INTERMEDIATE: ["intermediate", "orta", "средний"],
  ADVANCED: ["advanced", "ireli", "qabaqcil", "продвинутый"],
  PROFESSIONAL: ["professional", "pro", "pesekar", "профессиональный"],
};
/** Words that only describe what a level is ("Orta səviyyə", "Beginner level"). */
const LEVEL_FILLER = new Set(["seviyye", "seviyyesi", "level", "уровень"]);

/** The known level a free-text value names, or null. "Orta", "orta səviyyə", "INTERMEDIATE" → INTERMEDIATE. */
export function levelKeyOf(value: string): GroupLevel | null {
  if ((GROUP_LEVELS as readonly string[]).includes(value.trim())) return value.trim() as GroupLevel;
  const words = tokens(foldText(value)).filter((w) => !LEVEL_FILLER.has(w));
  if (words.length !== 1) return null;
  for (const level of GROUP_LEVELS) if (LEVEL_SYNONYMS[level].includes(words[0])) return level;
  return null;
}

/** Stores a known level as its key (displayed in the reader's language) and anything else as typed. */
export function normalizeLevel(value: string): string {
  const trimmed = value.trim().slice(0, GROUP_LEVEL_MAX);
  return levelKeyOf(trimmed) ?? trimmed;
}

const ROMAN_CLASSES = new Set(["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"]);
const SCHOOL_WORDS = ["sinif", "sinf", "класс", "mekteb", "school", "школ", "ibtidai", "grade", "klass"];
const COURSE_WORDS = new Set([
  "elementary", "pre", "upper", "junior", "middle", "senior", "expert", "basic", "foundation", "starter", "seviyye", "seviyyesi", "level",
  "уровень", "базовый", "beginner", "intermediate", "advanced", "professional",
]);
const CEFR = /^[abc][12]\+?(\s*[-–/]\s*[abc][12]\+?)?$/;

const inClassRange = (n: string) => Number(n) >= 1 && Number(n) <= 12;

/** "9A", "11 B", "10", "9-11", "5-ci sinif", "IX", "8 класс", "Grade 7" → a school class. */
export function looksLikeSchoolClass(value: string): boolean {
  const f = foldText(value);
  if (!f) return false;
  let m = f.match(/^(\d{1,2})\s*[-–.]?\s*\p{L}?$/u);
  if (m) return inClassRange(m[1]);
  m = f.match(/^(\d{1,2})\s*[-–]?\s*(ci|cu|inci|uncu|nci|ncu|st|nd|rd|th|й|ый|ой|ий)$/u);
  if (m) return inClassRange(m[1]);
  m = f.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
  if (m) return inClassRange(m[1]) && inClassRange(m[2]);
  if (/^([ivx]+)\s*[-–]?\s*\p{L}?$/u.test(f) && ROMAN_CLASSES.has(f.replace(/[^ivx].*$/, ""))) return true;
  return SCHOOL_WORDS.some((w) => f.includes(w)) && !/\b(level|seviyye)\b/.test(f);
}

/** "Beginner", "orta", "B2", "Upper-Intermediate", "Junior", "Level 2" → a course level. */
export function looksLikeCourseLevel(value: string): boolean {
  const f = foldText(value);
  if (!f) return false;
  if (levelKeyOf(value) || CEFR.test(f)) return true;
  return tokens(f).some((w) => COURSE_WORDS.has(w));
}

const SCHOOL_SUBJECTS = [
  "riyaziyyat", "fizika", "kimya", "biologiya", "tarix", "cografiya", "edebiyyat", "hendese", "cebr", "informatika", "azerbaycan dili", "ana dili",
  "математика", "физика", "химия", "биология", "история", "география", "литература", "информатика", "геометрия", "алгебра",
];
const COURSE_SUBJECTS = [
  "engineering", "java", "python", "javascript", "typescript", "react", "sql", "excel", "data", "ai", "ml", "devops", "frontend", "backend",
  "web", "design", "ux", "ui", "marketing", "smm", "ielts", "toefl", "sat", "gre", "gmat", "flutter", "kotlin", "swift", "c#", "c++", "qa",
  "analytics", "cyber", "cybersecurity", "programming", "proqramlasdirma", "dizayn",
];

/** A strong hint from the subject alone ("Riyaziyyat" → SCHOOL, "AI Engineering" → COURSE), or null. */
export function subjectHint(subject: string): GroupType | null {
  const f = foldText(subject);
  if (!f) return null;
  const words = new Set(tokens(f));
  const has = (term: string) => (term.includes(" ") ? f.includes(term) : words.has(term));
  const school = SCHOOL_SUBJECTS.some(has);
  const course = COURSE_SUBJECTS.some(has);
  return school === course ? null : school ? "SCHOOL" : "COURSE";
}

export interface WorkspaceKind {
  teachingCategory?: string | null;
  providerType?: string | null;
}

/** What the workspace's own category says about its groups, or null when it says nothing ("OTHER"). */
export function workspaceGroupType(ws: WorkspaceKind): GroupType | null {
  if (ws.providerType === "SCHOOL") return "SCHOOL";
  switch (ws.teachingCategory) {
    case "SCHOOL":
    case "GRADUATION_EXAM":
    case "UNIVERSITY_PREP":
      return "SCHOOL";
    case "LANGUAGE":
    case "IT":
    case "BUSINESS":
    case "INTERNATIONAL_EXAM":
    case "EARLY_CHILDHOOD":
      return "COURSE";
    default:
      return null;
  }
}

/**
 * The type a new group's form starts on: the teacher's most recent group's type (they usually make
 * more of the same), else the workspace category, else COURSE (the platform's non-school default:
 * "İstiqamət"/"Səviyyə" reads naturally for anything that isn't a school class).
 */
export function defaultGroupType(input: { latestGroupType?: GroupType | null } & WorkspaceKind): GroupType {
  return input.latestGroupType ?? workspaceGroupType(input) ?? "COURSE";
}

export type ClassificationReason = "CLASS_PATTERN" | "LEVEL_PATTERN" | "SUBJECT_HINT" | "WORKSPACE" | "DEFAULT";

export interface LegacyClassification {
  groupType: GroupType;
  /** The school class ("Sinif"); empty for courses. */
  grade: string;
  /** The course level ("Səviyyə"); a GROUP_LEVELS key when recognised, else the text as it was. Empty for school classes. */
  level: string;
  reason: ClassificationReason;
}

/**
 * Sorts a group created before group types existed, from its old combined "Sinif / səviyyə" value:
 * a class-like value → SCHOOL with that Sinif; a level-like value → COURSE with that Səviyyə;
 * anything else (or nothing) → the subject's hint, else the workspace's type, else COURSE — and
 * the value, never dropped, is shown in that type's second field. Pure, so the startup backfill
 * and the read-time fallback always agree.
 */
export function classifyLegacyGroup(input: { subject: string; grade: string } & WorkspaceKind): LegacyClassification {
  const value = input.grade.trim();
  if (value && looksLikeSchoolClass(value)) return { groupType: "SCHOOL", grade: value, level: "", reason: "CLASS_PATTERN" };
  if (value && looksLikeCourseLevel(value)) return { groupType: "COURSE", grade: "", level: normalizeLevel(value), reason: "LEVEL_PATTERN" };
  const hinted = subjectHint(input.subject);
  const fromWorkspace = hinted ? null : workspaceGroupType(input);
  const groupType = hinted ?? fromWorkspace ?? "COURSE";
  const reason: ClassificationReason = hinted ? "SUBJECT_HINT" : fromWorkspace ? "WORKSPACE" : "DEFAULT";
  return groupType === "SCHOOL" ? { groupType, grade: value, level: "", reason } : { groupType, grade: "", level: normalizeLevel(value), reason };
}

export interface GroupTypeFields {
  groupType: GroupType;
  subject: string;
  grade: string;
  level: string;
}

/**
 * What is stored for each type: a school class keeps Sinif in `grade` and no level; a course keeps
 * Səviyyə in `level` and no Sinif. The field the other type uses is cleared, so it can never
 * resurface under the wrong label.
 */
export function groupFieldsForType(input: GroupTypeFields): GroupTypeFields {
  const subject = input.subject.trim();
  return input.groupType === "SCHOOL"
    ? { groupType: "SCHOOL", subject, grade: input.grade.trim().slice(0, GROUP_CLASS_MAX), level: "" }
    : { groupType: "COURSE", subject, grade: "", level: normalizeLevel(input.level) };
}
