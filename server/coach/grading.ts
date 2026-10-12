import type { StudentAnswer } from "../../shared/assessment";
import type { CoachEvidence, CoachItemStatus, MistakeCause } from "../../shared/coach";
import type { MasteryStatus } from "../../shared/growth";
import { computeMastery, DEFAULT_PRIOR, statusOf, type Evidence } from "../growth/mastery";
import { gradeQuestion, isAnswered, parseNumber, type FrozenQuestion } from "../modules/engine";

/**
 * Quiz grading and mastery for the coach (pure). Closed questions use the assessment engine's
 * deterministic grader; open answers are graded by AI (P6) and arrive here as a status + score.
 */

export interface GradableItem extends FrozenQuestion {
  hintUsed: boolean;
}

export interface ItemOutcome {
  id: string;
  status: CoachItemStatus;
  /** 0-100 credit. */
  score: number;
}

export function gradeItem(item: GradableItem, answer: StudentAnswer | undefined): ItemOutcome {
  const graded = gradeQuestion(item, answer);
  return { id: item.id, status: graded.status, score: graded.status === "CORRECT" ? 100 : 0 };
}

export interface QuizScore {
  total: number;
  correct: number;
  pending: number;
  /** 0-100 over graded items (credit-weighted); null while everything is pending. */
  percentage: number | null;
}

const isPending = (s: CoachItemStatus) => s === "PENDING_REVIEW";

export function scoreQuiz(outcomes: Pick<ItemOutcome, "status" | "score">[]): QuizScore {
  const graded = outcomes.filter((o) => !isPending(o.status));
  const credit = graded.reduce((n, o) => n + Math.max(0, Math.min(100, o.score)), 0);
  return {
    total: outcomes.length,
    correct: outcomes.filter((o) => o.status === "CORRECT").length,
    pending: outcomes.length - graded.length,
    percentage: graded.length ? Math.round(credit / graded.length) : null,
  };
}

/**
 * A first guess at why an answer was wrong, without AI: a numeric answer within 10 % of the key is
 * a slip; a wrong answer after a hint or a blank one is a gap; otherwise unknown (the student can
 * see the right answer and explanation either way).
 */
export function mistakeCause(item: Pick<GradableItem, "type" | "answerKey" | "hintUsed">, answer: StudentAnswer | undefined): MistakeCause {
  if (!isAnswered(answer)) return "NOT_LEARNED";
  if (item.type === "NUMERIC") {
    const given = parseNumber(answer);
    const expected = Number((item.answerKey as { value?: number }).value);
    if (given !== null && Number.isFinite(expected) && expected !== 0 && Math.abs(given - expected) / Math.abs(expected) <= 0.1) return "CALC_SLIP";
    if (given !== null && Number.isFinite(expected) && Math.abs(Math.abs(given) - Math.abs(expected)) < 1e-9) return "CALC_SLIP";
  }
  if (item.hintUsed) return "NOT_LEARNED";
  if (item.type === "MATCHING" || item.type === "MULTIPLE_CHOICE" || item.type === "TRUE_FALSE") return "CONCEPT_CONFUSION";
  return "UNKNOWN";
}

/**
 * Whether "Yenidən yoxla" / "Etiraz et" is offered: a written answer still pending or graded by
 * the first-pass AI, or a short answer marked wrong; once per answer, and never on a pro grade.
 */
export function canRegrade(item: { type: string; status: string | null; gradedBy: string | null; disputed: boolean; answer: unknown }): boolean {
  if (item.disputed || item.gradedBy === "AI_PRO" || !isAnswered(item.answer as StudentAnswer | undefined)) return false;
  if (item.type === "LONG_ANSWER") return item.status === "PENDING_REVIEW" || item.gradedBy === "AI";
  if (item.type === "SHORT_ANSWER") return item.status === "WRONG";
  return false;
}

export const MAX_EVIDENCE = 10;

/** This quiz as evidence for one topic, newest first, capped. */
export function addEvidence(previous: CoachEvidence[], quizId: string, outcomes: Pick<ItemOutcome, "status" | "score">[], at: Date): CoachEvidence[] {
  const graded = outcomes.filter((o) => !isPending(o.status));
  const earned = graded.reduce((n, o) => n + Math.max(0, Math.min(100, o.score)) / 100, 0);
  const entry: CoachEvidence = {
    resultId: quizId,
    completedAt: at.toISOString(),
    questionCount: outcomes.length,
    pendingCount: outcomes.length - graded.length,
    earned: Math.round(earned * 100) / 100,
    possible: graded.length,
    wrongPoints: graded.filter((o) => o.status === "WRONG").length,
  };
  return [entry, ...previous.filter((e) => e.resultId !== quizId)].slice(0, MAX_EVIDENCE);
}

/** The Growth mastery formula over coach evidence (origin PRACTICE). */
export function coachMastery(evidence: CoachEvidence[]): { mastery: number; status: MasteryStatus } {
  const rows: Evidence[] = evidence.map((e) => ({ ...e, completedAt: new Date(e.completedAt), origin: "PRACTICE" }));
  const m = computeMastery(rows, DEFAULT_PRIOR);
  if (!m) return { mastery: 0, status: statusOf(0, 0) };
  return { mastery: Math.round(m.mastery), status: m.status };
}
