import { createHash } from "node:crypto";
import {
  assessmentItemContentSchema,
  resolveRules,
  studentPracticeContentSchema,
  type CompletionRules,
  type CompletionRulesPatch,
  type RetryPolicy,
  type SyllabusItemKind,
  type SyllabusItemScope,
} from "../../shared/syllabus";
import type { ItemStub, LessonStub, ModuleStub, VersionStructure } from "./types";

/** Draft rows → the immutable `structure` of a version (pure; publishing.ts does the I/O). */

export interface DraftModule {
  id: string;
  position: number;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  objectives: string[];
  prerequisitesText: string | null;
  status: "DRAFT" | "READY";
  completionRules: CompletionRulesPatch | null;
}
export interface DraftLesson {
  id: string;
  moduleId: string;
  position: number;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  objectives: string[];
  status: "DRAFT" | "READY";
  completionRules: CompletionRulesPatch | null;
}
export interface DraftItem {
  id: string;
  scope: SyllabusItemScope;
  moduleId: string | null;
  lessonId: string | null;
  kind: SyllabusItemKind;
  position: number;
  title: string;
  required: boolean;
  content: Record<string, unknown>;
  assessmentId: string | null;
  taskId: string | null;
}

export type PublishProblem =
  | { code: "SYLLABUS_EMPTY" }
  | { code: "SYLLABUS_ASSESSMENT_NOT_PUBLISHED"; itemId: string; title: string }
  | { code: "SYLLABUS_INVALID_CONTENT"; itemId: string; title: string };

export interface SnapshotInput {
  syllabusRules: CompletionRulesPatch | null;
  modules: DraftModule[];
  lessons: DraftLesson[];
  items: DraftItem[];
  /** assessmentId → currentVersionId for PUBLISHED assessments of the workspace. */
  publishedAssessments: ReadonlyMap<string, string>;
  /** itemId → frozen container taskId for this version (STUDENT_PRACTICE). */
  frozenTaskIds: ReadonlyMap<string, string>;
}

const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

function retryFor(kind: SyllabusItemKind, content: Record<string, unknown>, rules: CompletionRules): RetryPolicy | null {
  if (kind !== "ASSESSMENT") return null;
  const parsed = assessmentItemContentSchema.safeParse(content);
  if (!parsed.success) return null;
  const c = parsed.data;
  if (c.maxAttempts === undefined && c.cooldownMinutes === undefined && c.scorePolicy === undefined) return null;
  return {
    maxAttempts: c.maxAttempts === undefined ? rules.retry.maxAttempts : c.maxAttempts,
    cooldownMinutes: c.cooldownMinutes ?? rules.retry.cooldownMinutes,
    scorePolicy: c.scorePolicy ?? rules.retry.scorePolicy,
  };
}

function passPctFor(kind: SyllabusItemKind, content: Record<string, unknown>): number | null {
  if (kind === "ASSESSMENT") return assessmentItemContentSchema.safeParse(content).data?.passPct ?? null;
  if (kind === "STUDENT_PRACTICE") return studentPracticeContentSchema.safeParse(content).data?.passPct ?? null;
  return null;
}

export function buildStructure(input: SnapshotInput): { structure: VersionStructure; problems: PublishProblem[] } {
  const problems: PublishProblem[] = [];
  const rootRules = resolveRules(input.syllabusRules);
  const stub = (it: DraftItem, rules: CompletionRules): ItemStub => {
    let assessmentVersionId: string | null = null;
    if (it.kind === "ASSESSMENT") {
      assessmentVersionId = it.assessmentId ? (input.publishedAssessments.get(it.assessmentId) ?? null) : null;
      if (!assessmentVersionId) problems.push({ code: "SYLLABUS_ASSESSMENT_NOT_PUBLISHED", itemId: it.id, title: it.title });
    }
    return {
      id: it.id,
      kind: it.kind,
      scope: it.scope,
      title: it.title,
      position: it.position,
      required: it.required,
      assessmentId: it.kind === "ASSESSMENT" ? it.assessmentId : null,
      assessmentVersionId,
      taskId: it.kind === "STUDENT_PRACTICE" ? (input.frozenTaskIds.get(it.id) ?? null) : null,
      passPct: passPctFor(it.kind, it.content),
      retry: retryFor(it.kind, it.content, rules),
    };
  };

  const modules: ModuleStub[] = input.modules
    .filter((m) => m.status === "READY")
    .sort(byPosition)
    .map((m) => {
      const moduleRules = resolveRules(input.syllabusRules, m.completionRules);
      const lessons: LessonStub[] = input.lessons
        .filter((l) => l.moduleId === m.id && l.status === "READY")
        .sort(byPosition)
        .map((l) => {
          const rules = resolveRules(input.syllabusRules, m.completionRules, l.completionRules);
          return {
            id: l.id,
            moduleId: m.id,
            title: l.title,
            description: l.description ?? "",
            position: l.position,
            estimatedMinutes: l.estimatedMinutes,
            objectives: l.objectives,
            rules,
            items: input.items.filter((it) => it.scope === "LESSON" && it.lessonId === l.id).sort(byPosition).map((it) => stub(it, rules)),
          };
        });
      return {
        id: m.id,
        title: m.title,
        description: m.description ?? "",
        position: m.position,
        estimatedMinutes: m.estimatedMinutes,
        objectives: m.objectives,
        prerequisitesText: m.prerequisitesText ?? "",
        rules: moduleRules,
        lessons,
        items: input.items.filter((it) => it.scope === "MODULE" && it.moduleId === m.id).sort(byPosition).map((it) => stub(it, moduleRules)),
      };
    })
    .filter((m) => m.lessons.length > 0);

  if (!modules.length) problems.unshift({ code: "SYLLABUS_EMPTY" });
  const finalItems = input.items.filter((it) => it.scope === "SYLLABUS").sort(byPosition).map((it) => stub(it, rootRules));
  return { structure: { formatVersion: 1, rules: rootRules, modules, finalItems }, problems };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** Identity of an item's published meaning; the answer key is included so a new key means a new practice container. */
export function contentHash(item: Pick<DraftItem, "kind" | "title" | "required" | "content" | "assessmentId">, answerKey: string | null = null) {
  const payload = JSON.stringify(stable({ k: item.kind, t: item.title, r: item.required, c: item.content, a: item.assessmentId, key: answerKey }));
  return createHash("sha256").update(payload).digest("hex");
}

export function nextVersionLabel(versionNo: number) {
  return `v${versionNo}.0`;
}
