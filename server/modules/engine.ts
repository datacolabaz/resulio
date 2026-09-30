/**
 * Pure assessment engine: no database access, fully unit-testable.
 * Everything that decides what a student may see, whether an attempt may start
 * and how an answer is graded lives here.
 */
import type {
  AnswerKey,
  AssessmentSettings,
  AssessmentStatus,
  AttemptStatus,
  ItemStatus,
  LiveStatus,
  ParticipantState,
  QuestionContent,
  QuestionType,
  StudentAnswer,
} from "../../shared/assessment";

export type FrozenQuestion = {
  id: string;
  position: number;
  type: string;
  text: string;
  points: number;
  topic: string;
  skill: string;
  difficulty: string;
  explanation: string | null;
  imageUrl: string | null;
  content: QuestionContent;
  answerKey: AnswerKey;
};

export type StudentQuestion = {
  id: string;
  position: number;
  type: QuestionType;
  text: string;
  points: number;
  imageUrl: string | null;
  options?: { key: string; text: string }[];
  left?: { key: string; text: string }[];
  right?: { key: string; text: string }[];
  items?: { key: string; text: string }[];
  blankCount?: number;
  unit?: string;
};

// ---------------------------------------------------------------------------
// Deterministic shuffling (stable across refreshes for the same attempt)
// ---------------------------------------------------------------------------

function hashSeed(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const rand = hashSeed(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Shuffle that never returns the canonical order when more than one item exists. */
function shuffleAwayFrom<T>(items: readonly T[], seed: string, same: (a: T[], b: readonly T[]) => boolean): T[] {
  if (items.length < 2) return [...items];
  let out = seededShuffle(items, seed);
  if (same(out, items)) out = [...out.slice(1), out[0]];
  return out;
}

// ---------------------------------------------------------------------------
// Student-facing projection (whitelist only)
// ---------------------------------------------------------------------------

export function toStudentQuestion(q: FrozenQuestion, seed: string): StudentQuestion {
  const base: StudentQuestion = {
    id: q.id,
    position: q.position,
    type: q.type as QuestionType,
    text: q.text,
    points: q.points,
    imageUrl: q.imageUrl ?? null,
  };
  const content = q.content as Record<string, unknown>;
  const choices = (value: unknown) =>
    Array.isArray(value)
      ? value.map((c: { key: string; text: string }) => ({ key: String(c.key), text: String(c.text) }))
      : [];
  const sameKeys = (a: { key: string }[], b: readonly { key: string }[]) => a.every((x, i) => x.key === b[i]?.key);

  switch (q.type) {
    case "MULTIPLE_CHOICE":
    case "MULTIPLE_SELECT":
      return { ...base, options: choices(content.options) };
    case "TRUE_FALSE":
      return { ...base, options: [{ key: "TRUE", text: "TRUE" }, { key: "FALSE", text: "FALSE" }] };
    case "MATCHING": {
      const right = choices(content.right);
      return { ...base, left: choices(content.left), right: shuffleAwayFrom(right, `${seed}:right`, sameKeys) };
    }
    case "ORDERING": {
      const items = choices(content.items);
      return { ...base, items: shuffleAwayFrom(items, `${seed}:items`, sameKeys) };
    }
    case "FILL_BLANK":
      return { ...base, blankCount: Number(content.blankCount) || 1 };
    case "NUMERIC":
      return typeof content.unit === "string" && content.unit ? { ...base, unit: content.unit } : base;
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

const normalize = (value: string, caseSensitive: boolean) => {
  const collapsed = value.normalize("NFC").trim().replace(/\s+/g, " ");
  return caseSensitive ? collapsed : collapsed.toLocaleLowerCase("az");
};

export function isAnswered(answer: StudentAnswer | undefined): boolean {
  if (answer === undefined || answer === null) return false;
  if (typeof answer === "string") return answer.trim().length > 0;
  if (typeof answer === "boolean") return true;
  if (Array.isArray(answer)) return answer.some((a) => String(a).trim().length > 0);
  return Object.values(answer).some((v) => String(v).trim().length > 0);
}

export type GradedItem = { questionId: string; status: ItemStatus; earned: number; topic: string; skill: string };

export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, "").replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function gradeQuestion(q: FrozenQuestion, answer: StudentAnswer | undefined): GradedItem {
  const out = (status: ItemStatus): GradedItem => ({
    questionId: q.id,
    status,
    earned: status === "CORRECT" ? q.points : 0,
    topic: q.topic,
    skill: q.skill ?? "",
  });
  if (q.type === "LONG_ANSWER") return out(isAnswered(answer) ? "PENDING_REVIEW" : "UNANSWERED");
  if (!isAnswered(answer)) return out("UNANSWERED");

  const key = q.answerKey as Record<string, unknown>;
  switch (q.type) {
    case "MULTIPLE_CHOICE":
      return out(typeof answer === "string" && answer === key.correct ? "CORRECT" : "WRONG");
    case "MULTIPLE_SELECT": {
      const expected = [...((key.correct as string[]) ?? [])].sort();
      const given = Array.isArray(answer) ? [...new Set(answer.map(String))].sort() : [];
      return out(JSON.stringify(expected) === JSON.stringify(given) ? "CORRECT" : "WRONG");
    }
    case "TRUE_FALSE": {
      const given = typeof answer === "boolean" ? answer : answer === "TRUE" ? true : answer === "FALSE" ? false : null;
      return out(given !== null && given === key.correct ? "CORRECT" : "WRONG");
    }
    case "SHORT_ANSWER": {
      if (typeof answer !== "string") return out("WRONG");
      const cs = Boolean(key.caseSensitive);
      const accepted = ((key.accepted as string[]) ?? []).map((a) => normalize(a, cs));
      return out(accepted.includes(normalize(answer, cs)) ? "CORRECT" : "WRONG");
    }
    case "FILL_BLANK": {
      const blanks = (key.blanks as string[][]) ?? [];
      const cs = Boolean(key.caseSensitive);
      const given = Array.isArray(answer) ? answer.map(String) : typeof answer === "string" ? [answer] : [];
      const ok =
        blanks.length > 0 &&
        blanks.every((accepted, i) => accepted.map((a) => normalize(a, cs)).includes(normalize(given[i] ?? "", cs)));
      return out(ok ? "CORRECT" : "WRONG");
    }
    case "MATCHING": {
      const pairs = (key.pairs as Record<string, string>) ?? {};
      const given = answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, string>) : {};
      const leftKeys = Object.keys(pairs);
      const ok = leftKeys.length > 0 && leftKeys.every((l) => given[l] === pairs[l]);
      return out(ok ? "CORRECT" : "WRONG");
    }
    case "ORDERING": {
      const order = (key.order as string[]) ?? [];
      const given = Array.isArray(answer) ? answer.map(String) : [];
      return out(JSON.stringify(order) === JSON.stringify(given) ? "CORRECT" : "WRONG");
    }
    case "NUMERIC": {
      const given = parseNumber(answer);
      const expected = Number(key.value);
      const tolerance = Math.abs(Number(key.tolerance) || 0);
      const ok = given !== null && Number.isFinite(expected) && Math.abs(given - expected) <= tolerance + 1e-9;
      return out(ok ? "CORRECT" : "WRONG");
    }
    default:
      return out("WRONG");
  }
}

export type AttemptScore = {
  totalPoints: number;
  earnedPoints: number;
  percentage: number;
  correctCount: number;
  wrongCount: number;
  unansweredCount: number;
  pendingReviewCount: number;
  items: GradedItem[];
};

export const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoreItems(questions: FrozenQuestion[], items: GradedItem[]): Omit<AttemptScore, "items"> {
  const totalPoints = questions.reduce((s, q) => s + q.points, 0);
  const earnedPoints = items.reduce((s, i) => s + i.earned, 0);
  return {
    totalPoints,
    earnedPoints,
    percentage: totalPoints ? round1((earnedPoints / totalPoints) * 100) : 0,
    correctCount: items.filter((i) => i.status === "CORRECT").length,
    wrongCount: items.filter((i) => i.status === "WRONG").length,
    unansweredCount: items.filter((i) => i.status === "UNANSWERED").length,
    pendingReviewCount: items.filter((i) => i.status === "PENDING_REVIEW").length,
  };
}

export function gradeAttempt(questions: FrozenQuestion[], answers: Record<string, StudentAnswer | undefined>): AttemptScore {
  const items = questions.map((q) => gradeQuestion(q, answers[q.id]));
  return { ...scoreItems(questions, items), items };
}

/** The correct answer in the same shape a student would submit it. Only used after submission. */
export function correctAnswerOf(q: FrozenQuestion): StudentAnswer | undefined {
  const key = q.answerKey as Record<string, unknown>;
  switch (q.type) {
    case "MULTIPLE_CHOICE":
      return key.correct as string;
    case "MULTIPLE_SELECT":
      return key.correct as string[];
    case "TRUE_FALSE":
      return key.correct as boolean;
    case "SHORT_ANSWER":
      return (key.accepted as string[])?.[0];
    case "FILL_BLANK":
      return ((key.blanks as string[][]) ?? []).map((b) => b[0] ?? "");
    case "MATCHING":
      return key.pairs as Record<string, string>;
    case "ORDERING":
      return key.order as string[];
    case "NUMERIC":
      return String(key.value);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Scheduling and access
// ---------------------------------------------------------------------------

export function liveStatus(
  a: { status: AssessmentStatus; startAt: Date | null; endAt: Date | null },
  now = new Date(),
): LiveStatus {
  if (a.status === "DRAFT") return "DRAFT";
  if (a.status === "CLOSED") return "COMPLETED";
  if (a.startAt && now < a.startAt) return "SCHEDULED";
  if (a.endAt && now >= a.endAt) return "COMPLETED";
  return "ACTIVE";
}

export function computeDeadline(startedAt: Date, durationSeconds: number, endAt: Date | null): Date {
  const byDuration = new Date(startedAt.getTime() + durationSeconds * 1000);
  return endAt && endAt < byDuration ? endAt : byDuration;
}

export type StartDenial =
  | "NOT_PUBLISHED"
  | "NO_ACCESS"
  | "NOT_STARTED"
  | "CLOSED"
  | "NO_ATTEMPTS_LEFT";

export type AssignmentLike = {
  assessmentVersionId: string | null;
  availableFrom: Date | null;
  availableUntil: Date | null;
  durationOverrideSeconds: number | null;
  attemptLimitOverride: number | null;
};

/** Effective rules for one student: assignment overrides win over assessment defaults. */
export function effectiveRules(
  assessment: { startAt: Date | null; endAt: Date | null; currentVersionId: string | null },
  assignment: AssignmentLike,
  settings: Pick<AssessmentSettings, "durationSeconds" | "attemptsAllowed">,
) {
  return {
    versionId: assignment.assessmentVersionId ?? assessment.currentVersionId,
    startAt: assignment.availableFrom ?? assessment.startAt,
    endAt: assignment.availableUntil ?? assessment.endAt,
    durationSeconds: assignment.durationOverrideSeconds ?? settings.durationSeconds,
    attemptsAllowed: assignment.attemptLimitOverride ?? settings.attemptsAllowed,
  };
}

export function checkCanStart(input: {
  assessment: { status: AssessmentStatus; currentVersionId: string | null };
  window: { startAt: Date | null; endAt: Date | null };
  versionId: string | null;
  attemptsAllowed: number;
  hasAccess: boolean;
  finishedAttempts: number;
  now?: Date;
}): StartDenial | null {
  const now = input.now ?? new Date();
  const { assessment } = input;
  if (assessment.status === "DRAFT" || !assessment.currentVersionId || !input.versionId) return "NOT_PUBLISHED";
  if (!input.hasAccess) return "NO_ACCESS";
  const status = liveStatus({ status: assessment.status, ...input.window }, now);
  if (status === "SCHEDULED") return "NOT_STARTED";
  if (status === "COMPLETED") return "CLOSED";
  if (input.finishedAttempts >= input.attemptsAllowed) return "NO_ATTEMPTS_LEFT";
  return null;
}

export function isExpired(attempt: { status: AttemptStatus; deadlineAt: Date }, now = new Date()) {
  return attempt.status === "IN_PROGRESS" && now >= attempt.deadlineAt;
}

/** Attempts that use up the attempt limit (a teacher-voided attempt does not). */
export const countsTowardLimit = (status: AttemptStatus) => status !== "VOIDED";

// ---------------------------------------------------------------------------
// Participant activity (teacher view)
// ---------------------------------------------------------------------------

type ActivityAttempt = {
  status: AttemptStatus;
  startedAt: Date;
  deadlineAt: Date;
  lastActivityAt: Date | null;
};

/**
 * Derived only: an open session that has not expired and has had no answer or navigation
 * activity for `thresholdMinutes`. Heartbeats do not count. Never changes the stored status.
 */
export function isInactive(attempt: ActivityAttempt, thresholdMinutes: number | null, now = new Date()) {
  if (thresholdMinutes === null || attempt.status !== "IN_PROGRESS" || now >= attempt.deadlineAt) return false;
  const last = attempt.lastActivityAt ?? attempt.startedAt;
  return now.getTime() - last.getTime() >= thresholdMinutes * 60_000;
}

export function participantState(
  input: {
    viewedAt: Date | null;
    attempt: ActivityAttempt | null;
    pendingReviewCount: number | null;
    thresholdMinutes: number | null;
  },
  now = new Date(),
): ParticipantState {
  const { attempt } = input;
  if (!attempt || attempt.status === "VOIDED") return input.viewedAt ? "VIEWED" : "NOT_STARTED";
  if (attempt.status === "IN_PROGRESS") {
    // An unswept expired session is shown as expired; the sweeper finalizes it shortly.
    if (now >= attempt.deadlineAt) return "AUTO_SUBMITTED";
    return isInactive(attempt, input.thresholdMinutes, now) ? "INACTIVE" : "IN_PROGRESS";
  }
  if (attempt.status === "EXPIRED_NO_ANSWERS") return "EXPIRED_NO_ANSWERS";
  if ((input.pendingReviewCount ?? 0) > 0) return "PENDING_REVIEW";
  return attempt.status === "AUTO_SUBMITTED" ? "AUTO_SUBMITTED" : "COMPLETED";
}

/** True when a throttled write (event, heartbeat) should happen again. */
export function throttleElapsed(last: Date | null | undefined, windowMs: number, now = new Date()) {
  return !last || now.getTime() - last.getTime() >= windowMs;
}

export function questionOrderFor(questionIds: string[], randomize: boolean, seed: string) {
  return randomize ? seededShuffle(questionIds, `${seed}:order`) : [...questionIds];
}

// ---------------------------------------------------------------------------
// Result visibility
// ---------------------------------------------------------------------------

export type ResultVisibility = {
  released: boolean;
  /** Why the result is withheld, when it is. */
  heldReason: "WAITING_FOR_CLOSE" | "WAITING_FOR_GRADING" | null;
  showQuestions: "NONE" | "WRONG_ONLY" | "ALL";
  showCorrectAnswers: boolean;
  showExplanations: boolean;
};

export function resultVisibility(
  settings: Pick<AssessmentSettings, "releaseMode" | "reviewMode" | "showCorrectAnswers" | "showExplanations">,
  state: { windowClosed: boolean; pendingReview: number },
): ResultVisibility {
  let heldReason: ResultVisibility["heldReason"] = null;
  if (settings.releaseMode === "AFTER_CLOSE" && !state.windowClosed) heldReason = "WAITING_FOR_CLOSE";
  if (settings.releaseMode === "AFTER_GRADING" && state.pendingReview > 0) heldReason = "WAITING_FOR_GRADING";
  const released = heldReason === null;
  const showQuestions = !released
    ? "NONE"
    : settings.reviewMode === "FULL"
      ? "ALL"
      : settings.reviewMode === "WRONG_ONLY"
        ? "WRONG_ONLY"
        : "NONE";
  return {
    released,
    heldReason,
    showQuestions,
    showCorrectAnswers: showQuestions !== "NONE" && settings.showCorrectAnswers,
    showExplanations: showQuestions !== "NONE" && settings.showExplanations,
  };
}

// ---------------------------------------------------------------------------
// Analytics helpers
// ---------------------------------------------------------------------------

export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round1((sorted[mid - 1] + sorted[mid]) / 2);
}

export function summarizeScores(values: number[]) {
  if (!values.length) return { average: 0, median: 0, highest: 0, lowest: 0, count: 0 };
  return {
    average: round1(values.reduce((s, v) => s + v, 0) / values.length),
    median: median(values),
    highest: Math.max(...values),
    lowest: Math.min(...values),
    count: values.length,
  };
}

export function scoreDistribution(values: number[], bucket = 10) {
  const buckets = Array.from({ length: Math.ceil(100 / bucket) }, (_, i) => ({
    from: i * bucket,
    to: Math.min(100, (i + 1) * bucket),
    count: 0,
  }));
  for (const v of values) {
    const idx = Math.min(buckets.length - 1, Math.floor(v / bucket));
    buckets[idx].count += 1;
  }
  return buckets;
}

export type ItemRow = { questionId: string; status: ItemStatus; earned: number; topic: string; skill?: string };

export function questionStats(rows: ItemRow[], points: number) {
  const attempts = rows.length;
  const count = (s: ItemStatus) => rows.filter((r) => r.status === s).length;
  const correct = count("CORRECT");
  const wrong = count("WRONG");
  const unanswered = count("UNANSWERED");
  const pending = count("PENDING_REVIEW");
  const pct = (n: number) => (attempts ? round1((n / attempts) * 100) : 0);
  const accuracy = pct(correct);
  return {
    attempts,
    correctCount: correct,
    wrongCount: wrong,
    unansweredCount: unanswered,
    pendingReviewCount: pending,
    accuracyPercentage: accuracy,
    wrongPercentage: pct(wrong),
    unansweredPercentage: pct(unanswered),
    averagePoints: attempts ? round1(rows.reduce((s, r) => s + r.earned, 0) / attempts) : 0,
    maxPoints: points,
    difficulty: !attempts ? "NO_DATA" : accuracy < 50 ? "DIFFICULT" : accuracy >= 80 ? "EASY" : "MEDIUM",
  } as const;
}

export function topicStats(rows: ItemRow[], by: "topic" | "skill" = "topic") {
  const map = new Map<string, { total: number; correct: number }>();
  for (const r of rows) {
    if (r.status === "PENDING_REVIEW") continue;
    const topic = (by === "skill" ? r.skill : r.topic) || "—";
    const entry = map.get(topic) ?? { total: 0, correct: 0 };
    entry.total += 1;
    if (r.status === "CORRECT") entry.correct += 1;
    map.set(topic, entry);
  }
  return [...map.entries()]
    .map(([topic, v]) => {
      const accuracy = v.total ? round1((v.correct / v.total) * 100) : 0;
      return {
        topic,
        questionCount: v.total,
        correctCount: v.correct,
        accuracyPercentage: accuracy,
        classification: accuracy >= 80 ? "STRONG" : accuracy < 60 ? "WEAK" : "OK",
      } as const;
    })
    .sort((a, b) => a.accuracyPercentage - b.accuracyPercentage);
}

export type RankInput = { studentId: number; percentage: number; durationSeconds: number };

export function rank<T extends RankInput>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.percentage - a.percentage || a.durationSeconds - b.durationSeconds);
  let lastPct: number | null = null;
  let lastDur: number | null = null;
  let lastRank = 0;
  return sorted.map((r, i) => {
    const tie = r.percentage === lastPct && r.durationSeconds === lastDur;
    const current = tie ? lastRank : i + 1;
    lastPct = r.percentage;
    lastDur = r.durationSeconds;
    lastRank = current;
    return { ...r, rank: current };
  });
}

/** Best result per student (highest percentage, then fastest). */
export function bestPerStudent<T extends RankInput>(rows: T[]): T[] {
  const best = new Map<number, T>();
  for (const r of rows) {
    const cur = best.get(r.studentId);
    if (!cur || r.percentage > cur.percentage || (r.percentage === cur.percentage && r.durationSeconds < cur.durationSeconds)) {
      best.set(r.studentId, r);
    }
  }
  return [...best.values()];
}
