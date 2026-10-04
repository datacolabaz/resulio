import type {
  CompletionRules,
  LessonProgressState,
  ModuleProgressState,
  RetryPolicy,
  SyllabusItemKind,
  SyllabusItemScope,
  UnlockSource,
} from "../../shared/syllabus";

/** One item as frozen into a version's structure (content lives in syllabus_version_items). */
export interface ItemStub {
  id: string;
  kind: SyllabusItemKind;
  scope: SyllabusItemScope;
  title: string;
  position: number;
  required: boolean;
  assessmentId: string | null;
  assessmentVersionId: string | null;
  taskId: string | null;
  /** Effective pass mark (practice or assessment), resolved at publish. */
  passPct: number | null;
  /** Effective retry policy for an assessment item, resolved at publish. */
  retry: RetryPolicy | null;
}

export interface LessonStub {
  id: string;
  moduleId: string;
  title: string;
  description: string;
  position: number;
  estimatedMinutes: number | null;
  objectives: string[];
  rules: CompletionRules;
  items: ItemStub[];
}

export interface ModuleStub {
  id: string;
  title: string;
  description: string;
  position: number;
  estimatedMinutes: number | null;
  objectives: string[];
  prerequisitesText: string;
  rules: CompletionRules;
  lessons: LessonStub[];
  /** Module assessments (scope MODULE). */
  items: ItemStub[];
}

/** Stored in syllabus_versions.structure. Immutable once published. */
export interface VersionStructure {
  formatVersion: 1;
  rules: CompletionRules;
  modules: ModuleStub[];
  /** Final assessments (scope SYLLABUS). */
  finalItems: ItemStub[];
}

export interface AssessmentOutcome {
  /** Percentage, or 0 for an attempt that expired without answers. */
  pct: number;
  /** Open answers still waiting for the teacher. */
  pending: boolean;
}

/** What the student has done with one item. Practice and assessment parts come from task_submissions / results. */
export interface ItemFact {
  openedAt?: Date | null;
  completedAt?: Date | null;
  teacherMarkedAt?: Date | null;
  practice?: { submittedAt: Date | null; released: boolean; score: number | null };
  assessment?: { finished: number; inProgress: boolean; outcomes: AssessmentOutcome[]; lastFinishedAt: Date | null };
}

export interface PrevNode {
  status: ModuleProgressState | LessonProgressState;
  unlockSource: UnlockSource | null;
}

export interface EngineInput {
  structure: VersionStructure;
  facts: ReadonlyMap<string, ItemFact>;
  prevModules: ReadonlyMap<string, PrevNode>;
  prevLessons: ReadonlyMap<string, PrevNode>;
  /** Lessons the student has opened at least once. */
  openedLessons: ReadonlySet<string>;
  manualModules: ReadonlySet<string>;
  manualLessons: ReadonlySet<string>;
  /** `${targetType}:${targetId}` with a latest decision of APPROVED. */
  approvals: ReadonlySet<string>;
}

/** NOT_REQUIRED: does not count. FAILED: attempts exhausted without passing. */
export type ItemState = "NOT_REQUIRED" | "MET" | "PENDING" | "UNMET" | "FAILED";

export interface ItemEval {
  itemId: string;
  kind: SyllabusItemKind;
  state: ItemState;
  /** Whether the student may open/start it now. */
  available: boolean;
}

export type LockReason =
  | { code: "PREVIOUS_LESSON"; lessonId: string; title: string }
  | { code: "PREVIOUS_MODULE"; moduleId: string; title: string }
  | { code: "MODULE_LESSONS"; moduleId: string; title: string }
  | { code: "ALL_MODULES" };

export interface LessonResult {
  id: string;
  moduleId: string;
  status: LessonProgressState;
  unlockSource: UnlockSource | null;
  lockReason: LockReason | null;
  /** Non-blocking (grandfathered after a version move). */
  optional: boolean;
  items: ItemEval[];
}

export interface ModuleResult {
  id: string;
  status: ModuleProgressState;
  unlockSource: UnlockSource | null;
  lockReason: LockReason | null;
  completedLessons: number;
  totalLessons: number;
  items: ItemEval[];
}

export interface Transition {
  nodeType: "MODULE" | "LESSON";
  id: string;
  from: ModuleProgressState | LessonProgressState;
  to: ModuleProgressState | LessonProgressState;
}

export interface EngineOutput {
  modules: ModuleResult[];
  lessons: LessonResult[];
  finalItems: ItemEval[];
  syllabusCompleted: boolean;
  completedLessons: number;
  totalLessons: number;
  progressPct: number;
  currentModuleId: string | null;
  currentLessonId: string | null;
  transitions: Transition[];
}
