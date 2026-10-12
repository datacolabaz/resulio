import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { coachMistakes, coachQuizItems, coachQuizzes, coachTopicMastery, type CoachQuizItemRow, type CoachQuizRow } from "../../drizzle/schema";
import type { StudentAnswer } from "../../shared/assessment";
import { coachTopicKey, type CoachLocale, type QuizFormat } from "../../shared/coach";
import { requireDb } from "../db";
import { awardXp } from "../growth/xpStore";
import { XP } from "../growth/xp";
import { correctAnswerOf, toStudentQuestion, type FrozenQuestion } from "../modules/engine";
import { AppError } from "../modules/errors";
import { generateStructured, withCoachAi } from "./ai";
import { addEvidence, coachMastery, gradeItem, mistakeCause, scoreQuiz, type ItemOutcome } from "./grading";
import { onMaterialDelete, ownedMaterial } from "./materials";
import { coachModels } from "./models";
import { ownedTopic, promptChunks, topicChunks } from "./packs";
import { assertCoachAiAllowed, assertDailyCap, coachLimits } from "./quota";
import { draftItems, enoughItems, quizJsonSchema, quizMessages, quizSchema } from "./quizgen";
import { selectChunks } from "./retrieval";
import { logEvent } from "./store";

/**
 * "Məşq et": practice quizzes on one topic. Keys, explanations and sources stay on the server until
 * the quiz is submitted; grading is deterministic for closed questions, mastery uses the Growth
 * formula over coach evidence only, and wrong answers become reviewable mistakes.
 */

const QUIZ_MAX_CHARS = 20_000;

/** Late-registered graders for open answers (P6); without one they stay pending. */
export type OpenGrader = (input: { quiz: CoachQuizRow; items: CoachQuizItemRow[]; answers: Record<string, StudentAnswer | undefined> }) => Promise<Map<string, Partial<CoachQuizItemRow> & { status: ItemOutcome["status"]; score: number }>>;
let openGrader: OpenGrader | null = null;
export function setOpenGrader(fn: OpenGrader) {
  openGrader = fn;
}
/** Re-checks a calculation item's key on the server (P6); returns the item unchanged without one. */
export type CalcChecker = (item: CoachQuizItemRow) => CoachQuizItemRow;
let calcChecker: CalcChecker = (i) => i;
export function setCalcChecker(fn: CalcChecker) {
  calcChecker = fn;
}

export const frozenOf = (i: CoachQuizItemRow): FrozenQuestion => ({
  id: i.id,
  position: i.ord,
  type: i.type,
  text: i.text,
  points: 1,
  topic: i.topicId ? coachTopicKey(i.topicId) : "",
  skill: "",
  difficulty: "MEDIUM",
  explanation: i.explanation,
  imageUrl: null,
  content: i.content,
  answerKey: i.answerKey,
});

async function ownedQuiz(studentId: number, quizId: string) {
  const [quiz] = await requireDb()
    .select()
    .from(coachQuizzes)
    .where(and(eq(coachQuizzes.id, quizId), eq(coachQuizzes.studentId, studentId)))
    .limit(1);
  if (!quiz) throw new AppError("NOT_FOUND");
  return quiz;
}

async function itemsOf(quizId: string) {
  return requireDb().select().from(coachQuizItems).where(eq(coachQuizItems.quizId, quizId)).orderBy(asc(coachQuizItems.ord));
}

/** Before grading: the question only (no key, explanation or sources). After: everything. */
export function itemView(item: CoachQuizItemRow, graded: boolean, seed: string) {
  const question = toStudentQuestion(frozenOf(item), `${seed}:${item.id}`);
  const base = { id: item.id, ord: item.ord, question, answer: item.answer ?? null, hintUsed: item.hintUsed, hint: item.hintUsed ? item.hint : null, hasHint: !!item.hint };
  if (!graded) return { ...base, result: null };
  return {
    ...base,
    result: {
      status: item.status,
      score: item.score,
      gradedBy: item.gradedBy,
      confidence: item.confidence,
      correctAnswer: correctAnswerOf(frozenOf(item)) ?? null,
      rubric: item.type === "LONG_ANSWER" ? ((item.answerKey as { rubric?: string }).rubric ?? null) : null,
      explanation: item.explanation,
      cites: item.cites ?? [],
      feedback: item.feedback ?? null,
      disputed: item.disputed,
      calcVerified: item.calc ? item.calc.verified !== false : null,
    },
  };
}
export type QuizItemView = ReturnType<typeof itemView>;

export function quizView(quiz: CoachQuizRow, items: CoachQuizItemRow[]) {
  const graded = quiz.status === "GRADED";
  return {
    id: quiz.id,
    topicId: quiz.topicId,
    materialId: quiz.materialId,
    format: quiz.format,
    status: quiz.status,
    total: quiz.total,
    correct: quiz.correct,
    pending: quiz.pending,
    percentage: quiz.percentage,
    hintsUsed: quiz.hintsUsed,
    createdAt: quiz.createdAt,
    submittedAt: quiz.submittedAt,
    items: items.map((i) => itemView(i, graded, quiz.id)),
  };
}
export type QuizView = ReturnType<typeof quizView>;

export async function getQuiz(studentId: number, quizId: string) {
  const quiz = await ownedQuiz(studentId, quizId);
  return quizView(quiz, await itemsOf(quiz.id));
}

export async function listQuizzes(studentId: number, topicId?: string) {
  const rows = await requireDb()
    .select()
    .from(coachQuizzes)
    .where(topicId ? and(eq(coachQuizzes.studentId, studentId), eq(coachQuizzes.topicId, topicId)) : eq(coachQuizzes.studentId, studentId))
    .orderBy(desc(coachQuizzes.createdAt))
    .limit(20);
  return rows.map((q) => ({ id: q.id, topicId: q.topicId, format: q.format, status: q.status, total: q.total, correct: q.correct, percentage: q.percentage, createdAt: q.createdAt }));
}

export async function startQuiz(studentId: number, input: { topicId: string; format: QuizFormat; count: number; locale: CoachLocale }) {
  const topic = await ownedTopic(studentId, input.topicId);
  const material = await ownedMaterial(studentId, topic.materialId);
  if (material.status !== "READY") throw new AppError("COACH_NOT_READY");
  const chunks = await topicChunks(topic.id);
  if (chunks.reduce((n, c) => n + c.text.trim().length, 0) < 200) throw new AppError("COACH_NOT_ENOUGH_CONTENT");
  await assertDailyCap(studentId, "QUIZ_STARTED", (await coachLimits()).quizzesPerDay);
  await assertCoachAiAllowed(studentId);

  const earlier = await requireDb()
    .select({ text: coachQuizItems.text })
    .from(coachQuizItems)
    .innerJoin(coachQuizzes, eq(coachQuizzes.id, coachQuizItems.quizId))
    .where(and(eq(coachQuizzes.studentId, studentId), eq(coachQuizzes.topicId, topic.id)))
    .orderBy(desc(coachQuizItems.createdAt))
    .limit(15);
  const selected = selectChunks(chunks, `${topic.title} ${chunks.map((c) => c.heading).join(" ")}`, QUIZ_MAX_CHARS);
  const { prompt, byLabel } = promptChunks(selected);
  const { main } = await coachModels();
  const quizId = nanoid();
  const { data, model } = await withCoachAi(studentId, "COACH_QUIZ", () =>
    generateStructured({
      model: main,
      messages: quizMessages({ format: input.format, count: input.count, topicTitle: topic.title, chunks: prompt, locale: input.locale, nonce: randomBytes(4).toString("hex"), avoid: earlier.map((e) => e.text) }),
      schema: quizSchema,
      jsonSchema: quizJsonSchema,
      maxTokens: 12_000,
      timeoutMs: 150_000,
    }),
  );
  const drafts = draftItems(data.questions, input.format, input.count, byLabel, quizId);
  if (!enoughItems(drafts.length, input.count)) throw new AppError("AI_INVALID_OUTPUT");

  const db = requireDb();
  await db.insert(coachQuizzes).values({ id: quizId, studentId, materialId: material.id, topicId: topic.id, format: input.format, locale: input.locale, total: drafts.length, model });
  await db.insert(coachQuizItems).values(
    drafts.map((d, i) => ({
      id: nanoid(),
      quizId,
      studentId,
      topicId: topic.id,
      ord: i,
      type: d.type,
      text: d.text,
      content: d.content,
      answerKey: d.answerKey,
      explanation: d.explanation,
      hint: d.hint,
      cites: d.cites,
      calc: d.calc,
    })),
  );
  await logEvent(studentId, "QUIZ_STARTED", quizId, { format: input.format, count: drafts.length, locale: input.locale });
  return getQuiz(studentId, quizId);
}

export async function saveAnswer(studentId: number, quizId: string, itemId: string, answer: StudentAnswer) {
  const quiz = await ownedQuiz(studentId, quizId);
  if (quiz.status === "GRADED") throw new AppError("COACH_BUSY");
  await requireDb().update(coachQuizItems).set({ answer }).where(and(eq(coachQuizItems.id, itemId), eq(coachQuizItems.quizId, quiz.id)));
  if (quiz.status === "READY") await requireDb().update(coachQuizzes).set({ status: "IN_PROGRESS" }).where(eq(coachQuizzes.id, quiz.id));
  return { ok: true as const };
}

/** The stored hint (no AI call); marks it used so the review can tell. */
export async function useHint(studentId: number, quizId: string, itemId: string) {
  const quiz = await ownedQuiz(studentId, quizId);
  if (quiz.status === "GRADED") throw new AppError("COACH_BUSY");
  const [item] = await requireDb().select().from(coachQuizItems).where(and(eq(coachQuizItems.id, itemId), eq(coachQuizItems.quizId, quiz.id))).limit(1);
  if (!item?.hint) throw new AppError("NOT_FOUND");
  if (!item.hintUsed) {
    await requireDb().update(coachQuizItems).set({ hintUsed: true }).where(eq(coachQuizItems.id, item.id));
    await requireDb().update(coachQuizzes).set({ hintsUsed: quiz.hintsUsed + 1 }).where(eq(coachQuizzes.id, quiz.id));
    await logEvent(studentId, "HINT_USED", quiz.id);
  }
  return { hint: item.hint };
}

const busy = new Set<string>();

export async function submitQuiz(studentId: number, quizId: string, answers: Record<string, StudentAnswer | undefined>) {
  const quiz = await ownedQuiz(studentId, quizId);
  if (quiz.status === "GRADED") return getQuiz(studentId, quizId);
  if (busy.has(quiz.id)) throw new AppError("COACH_BUSY");
  busy.add(quiz.id);
  try {
    const db = requireDb();
    const items = (await itemsOf(quiz.id)).map(calcChecker);
    const final = (i: CoachQuizItemRow) => (Object.prototype.hasOwnProperty.call(answers, i.id) ? answers[i.id] : (i.answer ?? undefined));
    const updates = new Map<string, Partial<CoachQuizItemRow> & { status: ItemOutcome["status"]; score: number }>();
    for (const item of items) {
      const outcome = gradeItem({ ...frozenOf(item), hintUsed: item.hintUsed }, final(item));
      updates.set(item.id, { status: outcome.status, score: outcome.score, gradedBy: "RULE" });
    }
    const open = items.filter((i) => updates.get(i.id)!.status === "PENDING_REVIEW");
    if (open.length && openGrader) {
      try {
        const graded = await openGrader({ quiz, items: open, answers: Object.fromEntries(open.map((i) => [i.id, final(i)])) });
        for (const [id, u] of graded) updates.set(id, u);
      } catch (error) {
        console.warn("[coach] open-answer grading failed; left pending", error instanceof Error ? error.message : error);
      }
    }
    const outcomes = items.map((i) => ({ id: i.id, ...updates.get(i.id)! }));
    const score = scoreQuiz(outcomes);
    const now = new Date();
    for (const item of items) {
      const u = updates.get(item.id)!;
      await db
        .update(coachQuizItems)
        .set({ ...u, answer: final(item) ?? null, ...(item.calc ? { calc: item.calc } : {}) })
        .where(eq(coachQuizItems.id, item.id));
    }
    await db.update(coachQuizzes).set({ status: "GRADED", total: score.total, correct: score.correct, pending: score.pending, percentage: score.percentage, submittedAt: now }).where(eq(coachQuizzes.id, quiz.id));

    const wrong = items.filter((i) => updates.get(i.id)!.status === "WRONG");
    if (wrong.length) {
      await db.insert(coachMistakes).values(
        wrong.map((i) => ({ id: nanoid(), studentId, materialId: quiz.materialId, topicId: i.topicId, quizId: quiz.id, itemId: i.id, cause: mistakeCause(i, final(i)), question: i.text.slice(0, 600) })),
      );
    }
    // A topic answered right again closes its older open mistakes.
    if (quiz.topicId && score.percentage !== null && score.percentage >= 80) {
      await db
        .update(coachMistakes)
        .set({ fixedAt: now })
        .where(and(eq(coachMistakes.studentId, studentId), eq(coachMistakes.topicId, quiz.topicId), isNull(coachMistakes.fixedAt), inArray(coachMistakes.quizId, await olderQuizIds(studentId, quiz))));
    }
    if (quiz.topicId && quiz.materialId) await updateMastery(studentId, quiz.topicId, quiz.materialId, quiz.id, outcomes, now);
    await logEvent(studentId, "QUIZ_SUBMITTED", quiz.id, { percentage: score.percentage, total: score.total, pending: score.pending });
    try {
      await awardXp({ studentId, workspaceId: "coach", type: "PRACTICE_DONE", points: XP.PRACTICE_DONE, refKey: `coach:quiz:${quiz.id}`, activity: true }, now);
    } catch (error) {
      console.warn("[coach] xp award skipped", error instanceof Error ? error.message : error);
    }
    return getQuiz(studentId, quizId);
  } finally {
    busy.delete(quiz.id);
  }
}

async function olderQuizIds(studentId: number, quiz: CoachQuizRow): Promise<string[]> {
  const rows = await requireDb()
    .select({ id: coachQuizzes.id })
    .from(coachQuizzes)
    .where(and(eq(coachQuizzes.studentId, studentId), eq(coachQuizzes.topicId, quiz.topicId!)));
  const ids = rows.map((r) => r.id).filter((id) => id !== quiz.id);
  return ids.length ? ids : ["-"];
}

/** Hook for the review scheduler (P7): called with the topic's new mastery after every quiz. */
export type MasteryHook = (input: { studentId: number; topicId: string; mastery: number; percentage: number | null; previousInterval: number; now: Date }) => { nextReviewAt: Date | null; intervalDays: number };
let masteryHook: MasteryHook | null = null;
export function setMasteryHook(fn: MasteryHook) {
  masteryHook = fn;
}

async function updateMastery(studentId: number, topicId: string, materialId: string, quizId: string, outcomes: ItemOutcome[], now: Date) {
  const db = requireDb();
  const [prev] = await db.select().from(coachTopicMastery).where(and(eq(coachTopicMastery.studentId, studentId), eq(coachTopicMastery.topicId, topicId))).limit(1);
  const evidence = addEvidence(prev?.evidence ?? [], quizId, outcomes, now);
  const { mastery, status } = coachMastery(evidence);
  const percentage = scoreQuiz(outcomes).percentage;
  const review = masteryHook?.({ studentId, topicId, mastery, percentage, previousInterval: prev?.intervalDays ?? 0, now }) ?? { nextReviewAt: prev?.nextReviewAt ?? null, intervalDays: prev?.intervalDays ?? 0 };
  const values = { materialId, mastery, status, attempts: (prev?.attempts ?? 0) + 1, evidence, lastPracticedAt: now, nextReviewAt: review.nextReviewAt, intervalDays: review.intervalDays };
  await db.insert(coachTopicMastery).values({ studentId, topicId, ...values }).onDuplicateKeyUpdate({ set: values });
}

export async function topicProgress(studentId: number, topicId: string) {
  await ownedTopic(studentId, topicId);
  const [row] = await requireDb().select().from(coachTopicMastery).where(and(eq(coachTopicMastery.studentId, studentId), eq(coachTopicMastery.topicId, topicId))).limit(1);
  return row ? { mastery: row.mastery, status: row.status, attempts: row.attempts, lastPracticedAt: row.lastPracticedAt, nextReviewAt: row.nextReviewAt } : null;
}

onMaterialDelete(async (ids) => {
  const db = requireDb();
  const quizzes = await db.select({ id: coachQuizzes.id }).from(coachQuizzes).where(inArray(coachQuizzes.materialId, ids));
  if (quizzes.length) await db.delete(coachQuizItems).where(inArray(coachQuizItems.quizId, quizzes.map((q) => q.id)));
  await db.delete(coachQuizzes).where(inArray(coachQuizzes.materialId, ids));
  await db.delete(coachTopicMastery).where(inArray(coachTopicMastery.materialId, ids));
  await db.delete(coachMistakes).where(inArray(coachMistakes.materialId, ids));
});
