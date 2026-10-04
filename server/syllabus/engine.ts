import type { CompletionRules, LessonProgressState, ModuleProgressState, UnlockSource } from "../../shared/syllabus";
import type {
  EngineInput,
  EngineOutput,
  ItemEval,
  ItemFact,
  ItemState,
  ItemStub,
  LessonResult,
  LockReason,
  ModuleResult,
  PrevNode,
  Transition,
  VersionStructure,
} from "./types";

/**
 * The progression engine: facts + frozen rules → module/lesson states. Pure and deterministic, so
 * running it twice gives the same answer (recompute is idempotent). See docs/SYLLABUS-ARCHITECTURE.md §8.
 *
 * Stability rules:
 * - completion is sticky: a COMPLETED node stays completed (a later lower regrade never re-locks);
 * - an unlock is sticky unless it came from a manual exception that has since been revoked;
 * - a manual unlock opens one node for one student but never completes it, so the next node
 *   still waits for the manually unlocked one.
 */

const DONE_STATES: ReadonlySet<ItemState> = new Set(["MET", "NOT_REQUIRED"]);

export function evaluateItem(item: ItemStub, rules: CompletionRules, fact: ItemFact | undefined): ItemState {
  if (!item.required) return "NOT_REQUIRED";
  switch (item.kind) {
    case "THEORY":
      if (rules.theory === "OPTIONAL") return "NOT_REQUIRED";
      return fact?.completedAt ? "MET" : "UNMET";
    case "TEACHER_PRACTICE":
      if (rules.teacherPractice === "NONE") return "NOT_REQUIRED";
      if (rules.teacherPractice === "VIEWED") return fact?.openedAt || fact?.teacherMarkedAt ? "MET" : "UNMET";
      return fact?.teacherMarkedAt ? "MET" : "UNMET";
    case "STUDENT_PRACTICE": {
      if (rules.studentPractice === "NONE") return "NOT_REQUIRED";
      const p = fact?.practice;
      if (!p?.submittedAt) return "UNMET";
      if (rules.studentPractice === "SUBMITTED") return "MET";
      if (!p.released) return "PENDING";
      if (rules.studentPractice === "GRADED") return "MET";
      return (p.score ?? 0) >= (item.passPct ?? rules.practicePassPct) ? "MET" : "UNMET";
    }
    case "ASSESSMENT":
      return evaluateAssessment(item, rules, fact);
    case "RESOURCE":
      return "NOT_REQUIRED";
  }
}

function evaluateAssessment(item: ItemStub, rules: CompletionRules, fact: ItemFact | undefined): ItemState {
  if (rules.assessment === "NONE") return "NOT_REQUIRED";
  const a = fact?.assessment;
  if (!a || a.finished === 0) return "UNMET";
  if (rules.assessment === "ATTEMPTED") return "MET";
  const retry = item.retry ?? rules.retry;
  const pass = item.passPct ?? rules.assessmentPassPct;
  const graded = a.outcomes.filter((o) => !o.pending);
  const anyPending = a.outcomes.some((o) => o.pending);
  if (retry.scorePolicy === "LATEST") {
    const latest = a.outcomes[a.outcomes.length - 1];
    if (latest?.pending) return "PENDING";
    if (latest && latest.pct >= pass) return "MET";
  } else {
    if (graded.some((o) => o.pct >= pass)) return "MET";
    if (anyPending) return "PENDING";
  }
  if (retry.maxAttempts !== null && a.finished >= retry.maxAttempts && !a.inProgress) return "FAILED";
  return "UNMET";
}

const allDone = (evals: ItemEval[]) => evals.every((e) => DONE_STATES.has(e.state));

function touched(itemIds: string[], facts: ReadonlyMap<string, ItemFact>) {
  return itemIds.some((id) => {
    const f = facts.get(id);
    return !!(f && (f.openedAt || f.completedAt || f.practice?.submittedAt || (f.assessment && (f.assessment.finished > 0 || f.assessment.inProgress))));
  });
}

/** Sticky unlock: anything the student already had open stays open, except a revoked manual exception. */
function wasUnlocked(prev: PrevNode | undefined) {
  return !!prev && prev.status !== "LOCKED" && prev.unlockSource !== "MANUAL";
}

function unlockSourceFor(prev: PrevNode | undefined, first: boolean, manual: boolean, computed: boolean): UnlockSource {
  if (prev && prev.status !== "LOCKED" && prev.unlockSource && (prev.unlockSource !== "MANUAL" || manual)) return prev.unlockSource;
  if (computed) return first ? "FIRST" : "SEQUENTIAL";
  return manual ? "MANUAL" : "SEQUENTIAL";
}

export function computeProgress(input: EngineInput): EngineOutput {
  const { structure, facts, prevModules, prevLessons, openedLessons, manualModules, manualLessons, approvals } = input;
  const modules: ModuleResult[] = [];
  const lessons: LessonResult[] = [];
  const transitions: Transition[] = [];
  let prevModuleDone = true;
  let prevModule: { id: string; title: string } | null = null;

  structure.modules.forEach((m, mi) => {
    const mPrev = prevModules.get(m.id);
    const mManual = manualModules.has(m.id);
    const mComputed = mi === 0 || !m.rules.sequentialModules || prevModuleDone;
    const mUnlocked = mComputed || mManual || wasUnlocked(mPrev) || mPrev?.status === "COMPLETED";

    let prevLessonDone = true;
    let prevLesson: { id: string; title: string } | null = null;
    const moduleLessons: LessonResult[] = [];

    m.lessons.forEach((l, li) => {
      const lPrev = prevLessons.get(l.id);
      const optional = lPrev?.unlockSource === "GRANDFATHERED";
      const lManual = manualLessons.has(l.id);
      const lComputed = mUnlocked && (li === 0 || !l.rules.sequentialLessons || prevLessonDone);
      const lUnlocked = lComputed || lManual || wasUnlocked(lPrev) || lPrev?.status === "COMPLETED";

      const items: ItemEval[] = l.items.map((it) => ({ itemId: it.id, kind: it.kind, state: evaluateItem(it, l.rules, facts.get(it.id)), available: lUnlocked }));
      const met = allDone(items);
      const pendingOnly = !met && items.every((e) => DONE_STATES.has(e.state) || e.state === "PENDING");

      let status: LessonProgressState;
      if (lPrev?.status === "COMPLETED") status = "COMPLETED";
      else if (!lUnlocked) status = "LOCKED";
      else if (met && l.rules.teacherApproval && !approvals.has(`LESSON:${l.id}`)) status = "AWAITING_APPROVAL";
      else if (met) status = "COMPLETED";
      else if (pendingOnly) status = "AWAITING_REVIEW";
      else if (openedLessons.has(l.id) || touched(l.items.map((i) => i.id), facts)) status = "IN_PROGRESS";
      else status = "AVAILABLE";

      let lockReason: LockReason | null = null;
      if (status === "LOCKED") {
        lockReason = !mUnlocked && prevModule
          ? { code: "PREVIOUS_MODULE", moduleId: prevModule.id, title: prevModule.title }
          : prevLesson
            ? { code: "PREVIOUS_LESSON", lessonId: prevLesson.id, title: prevLesson.title }
            : prevModule
              ? { code: "PREVIOUS_MODULE", moduleId: prevModule.id, title: prevModule.title }
              : null;
      }

      const result: LessonResult = {
        id: l.id,
        moduleId: m.id,
        status,
        unlockSource: status === "LOCKED" ? null : unlockSourceFor(lPrev, li === 0 && mi === 0, lManual, lComputed),
        lockReason,
        optional,
        items,
      };
      moduleLessons.push(result);
      prevLessonDone = status === "COMPLETED" || optional;
      prevLesson = { id: l.id, title: l.title };
    });

    const blocking = moduleLessons.filter((l) => !l.optional);
    const lessonsDone = blocking.every((l) => l.status === "COMPLETED");
    const requiredModuleItems = m.items.filter((it) => evaluateItem(it, m.rules, undefined) !== "NOT_REQUIRED");
    const requiresLessons = m.rules.moduleRequiresAllLessons || requiredModuleItems.length === 0;
    const accessible = mUnlocked || moduleLessons.some((l) => l.status !== "LOCKED");
    const itemsAvailable = accessible && (requiresLessons ? lessonsDone : true);
    const moduleItems: ItemEval[] = m.items.map((it) => ({ itemId: it.id, kind: it.kind, state: evaluateItem(it, m.rules, facts.get(it.id)), available: itemsAvailable }));
    const complete = itemsAvailable && (requiresLessons ? lessonsDone : true) && allDone(moduleItems);

    let mStatus: ModuleProgressState;
    if (mPrev?.status === "COMPLETED") mStatus = "COMPLETED";
    else if (!accessible) mStatus = "LOCKED";
    else if (complete && m.rules.teacherApproval && !approvals.has(`MODULE:${m.id}`)) mStatus = "AWAITING_APPROVAL";
    else if (complete) mStatus = "COMPLETED";
    else if (moduleLessons.some((l) => l.status !== "LOCKED" && l.status !== "AVAILABLE") || touched(m.items.map((i) => i.id), facts)) mStatus = "IN_PROGRESS";
    else mStatus = "AVAILABLE";

    const mUnlockSource: UnlockSource | null =
      mStatus === "LOCKED" ? null : mUnlocked ? unlockSourceFor(mPrev, mi === 0, mManual, mComputed) : "MANUAL";
    modules.push({
      id: m.id,
      status: mStatus,
      unlockSource: mUnlockSource,
      lockReason: mStatus === "LOCKED" && prevModule ? { code: "PREVIOUS_MODULE", moduleId: prevModule.id, title: prevModule.title } : null,
      completedLessons: moduleLessons.filter((l) => l.status === "COMPLETED").length,
      totalLessons: moduleLessons.length,
      items: moduleItems,
    });
    lessons.push(...moduleLessons);
    prevModuleDone = mStatus === "COMPLETED";
    prevModule = { id: m.id, title: m.title };
  });

  const allModulesDone = modules.length > 0 && modules.every((m) => m.status === "COMPLETED");
  const finalItems: ItemEval[] = structure.finalItems.map((it) => ({
    itemId: it.id,
    kind: it.kind,
    state: evaluateItem(it, structure.rules, facts.get(it.id)),
    available: allModulesDone,
  }));
  const requirementsMet = allModulesDone && allDone(finalItems);
  const syllabusCompleted = requirementsMet && (!structure.rules.teacherApproval || approvals.has("SYLLABUS:syllabus"));
  const syllabusAwaitingApproval = requirementsMet && !syllabusCompleted;

  const counted = lessons.filter((l) => !l.optional || l.status === "COMPLETED");
  const completedLessons = counted.filter((l) => l.status === "COMPLETED").length;
  const totalLessons = counted.length;
  const progressPct = totalLessons ? Math.round((completedLessons / totalLessons) * 1000) / 10 : 0;
  const current = lessons.find((l) => l.status !== "COMPLETED" && l.status !== "LOCKED") ?? null;

  for (const m of modules) {
    const from = prevModules.get(m.id)?.status ?? "LOCKED";
    if (from !== m.status) transitions.push({ nodeType: "MODULE", id: m.id, from, to: m.status });
  }
  for (const l of lessons) {
    const from = prevLessons.get(l.id)?.status ?? "LOCKED";
    if (from !== l.status) transitions.push({ nodeType: "LESSON", id: l.id, from, to: l.status });
  }

  return {
    modules,
    lessons,
    finalItems,
    syllabusCompleted,
    syllabusAwaitingApproval,
    completedLessons,
    totalLessons,
    progressPct,
    currentModuleId: current?.moduleId ?? null,
    currentLessonId: current?.id ?? null,
    transitions,
  };
}

/** Every assessment item the student may start now (drives just-in-time assessment assignments). */
export function availableAssessmentItems(structure: VersionStructure, out: EngineOutput): ItemStub[] {
  const evals = new Map<string, ItemEval>();
  for (const l of out.lessons) for (const e of l.items) evals.set(e.itemId, e);
  for (const m of out.modules) for (const e of m.items) evals.set(e.itemId, e);
  for (const e of out.finalItems) evals.set(e.itemId, e);
  return allItems(structure).filter((it) => it.kind === "ASSESSMENT" && it.assessmentId && evals.get(it.id)?.available);
}

export function allItems(structure: VersionStructure): ItemStub[] {
  return [
    ...structure.modules.flatMap((m) => [...m.lessons.flatMap((l) => l.items), ...m.items]),
    ...structure.finalItems,
  ];
}

/** Where an item sits in the tree; null if it is not part of this version. */
export function locateItem(structure: VersionStructure, itemId: string) {
  for (const m of structure.modules) {
    for (const l of m.lessons) {
      const item = l.items.find((i) => i.id === itemId);
      if (item) return { item, module: m, lesson: l, rules: l.rules };
    }
    const item = m.items.find((i) => i.id === itemId);
    if (item) return { item, module: m, lesson: null, rules: m.rules };
  }
  const item = structure.finalItems.find((i) => i.id === itemId);
  return item ? { item, module: null, lesson: null, rules: structure.rules } : null;
}

export function locateLesson(structure: VersionStructure, lessonId: string) {
  for (const m of structure.modules) {
    const lesson = m.lessons.find((l) => l.id === lessonId);
    if (lesson) return { module: m, lesson };
  }
  return null;
}

/**
 * Moving a student to a newer version: lessons that are new in it and sit before the student's
 * frontier (their last completed lesson) become optional (GRANDFATHERED) so they never block.
 */
export function grandfatheredLessons(next: VersionStructure, previous: ReadonlyMap<string, PrevNode>): Set<string> {
  const ordered = next.modules.flatMap((m) => m.lessons.map((l) => l.id));
  let frontier = -1;
  ordered.forEach((id, i) => {
    if (previous.get(id)?.status === "COMPLETED") frontier = i;
  });
  const out = new Set<string>();
  ordered.forEach((id, i) => {
    if (i < frontier && !previous.has(id)) out.add(id);
  });
  return out;
}
