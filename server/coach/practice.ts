import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { coachMistakes, coachQuizItems, coachQuizzes, coachTopicMastery, type CoachQuizItemRow, type CoachQuizRow } from "../../drizzle/schema";
import type { StudentAnswer } from "../../shared/assessment";
import { coachLocaleOf, coachTopicKey, type CoachItemStatus, type CoachLocale, type QuizFormat } from "../../shared/coach";
import { requireDb } from "../db";
import { awardXp } from "../growth/xpStore";
import { XP } from "../growth/xp";
import { correctAnswerOf, toStudentQuestion, type FrozenQuestion } from "../modules/engine";
import { AppError } from "../modules/errors";
import { generateStructured, withCoachAi } from "./ai";
import { aiGrade, answerString, shortFoldedMatch, shortNearMiss, type OpenGrade, type OpenItem } from "./aigrade";
import { addEvidence, canRegrade, coachMastery, gradeItem, mistakeCause, scoreQuiz, type ItemOutcome } from "./grading";
import { assertNotInExam } from "./examLock";
import { onMaterialDelete, ownedMaterial } from "./materials";
import { coachModels } from "./models";
import { ownedTopic, promptChunks, topicChunks } from "./packs";
import { assertCoachAiAllowed, assertDailyCap, coachLimits, dailyRemaining } from "./quota";
import { draftItems, enoughItems, quizJsonSchema, quizMessages, quizSchema } from "./quizgen";
import { selectChunks } from "./retrieval";
import { nextReview } from "./review";
import { logEvent } from "./store";

/**
 * "Məşq et": practice quizzes on one topic. Keys, explanations and sources stay on the server until
 * the quiz is submitted; grading is deterministic for closed questions, mastery uses the Growth
 * formula over coach evidence only, and wrong answers become reviewable mistakes.
 */

const QUIZ_MAX_CHARS = 20_000;

const GRADE_MAX_CHARS = 8_000;

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
      calcVerified: item.calc ? item.calc.verified === true : null,
      canRegrade: canRegrade(item),
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
  await assertNotInExam(studentId);
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
  if (quiz.status === "GRADED") throw new AppError("COACH_QUIZ_CLOSED");
  await requireDb().update(coachQuizItems).set({ answer }).where(and(eq(coachQuizItems.id, itemId), eq(coachQuizItems.quizId, quiz.id)));
  if (quiz.status === "READY") await requireDb().update(coachQuizzes).set({ status: "IN_PROGRESS" }).where(eq(coachQuizzes.id, quiz.id));
  return { ok: true as const };
}

/** The stored hint (no AI call); marks it used so the review can tell. */
export async function useHint(studentId: number, quizId: string, itemId: string) {
  const quiz = await ownedQuiz(studentId, quizId);
  if (quiz.status === "GRADED") throw new AppError("COACH_QUIZ_CLOSED");
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

type ItemUpdate = Partial<CoachQuizItemRow> & { status: CoachItemStatus; score: number };
type Answers = Record<string, StudentAnswer | undefined>;

/** The material passages an open answer is judged against. */
async function gradingChunks(topicId: string | null, questions: string[]) {
  if (!topicId) return promptChunks([]).prompt;
  const chunks = await topicChunks(topicId);
  return promptChunks(selectChunks(chunks, questions.join(" "), GRADE_MAX_CHARS)).prompt;
}

const openItemOf = (item: CoachQuizItemRow, answer: StudentAnswer | undefined): OpenItem => ({
  id: item.id,
  kind: item.type === "LONG_ANSWER" ? "WRITTEN" : "SHORT",
  question: item.text,
  expected:
    item.type === "LONG_ANSWER"
      ? String((item.answerKey as { rubric?: string }).rubric ?? "").split("\n").map((s) => s.replace(/^[-•*\d.)\s]+/, "").trim()).filter(Boolean)
      : (((item.answerKey as { accepted?: string[] }).accepted ?? []) as string[]),
  answer: answerString(answer),
});

const fromGrade = (g: OpenGrade): ItemUpdate => ({ status: g.status, score: g.score, gradedBy: g.gradedBy, confidence: g.confidence, feedback: g.feedback });

/**
 * AI grades for open items; provisional ones get a second opinion from the pro model while the
 * day's `proGradesPerDay` allows. Failures leave the rule grade in place.
 */
async function gradeOpen(studentId: number, quiz: CoachQuizRow, items: CoachQuizItemRow[], answers: Answers): Promise<Map<string, ItemUpdate>> {
  const out = new Map<string, ItemUpdate>();
  if (!items.length) return out;
  const locale = coachLocaleOf(quiz.locale);
  try {
    await assertCoachAiAllowed(studentId);
    const models = await coachModels();
    const chunks = await gradingChunks(quiz.topicId, items.map((i) => i.text));
    const first = await aiGrade({ studentId, model: models.main, items: items.map((i) => openItemOf(i, answers[i.id])), chunks, locale, gradedBy: "AI" });
    for (const [id, g] of first) out.set(id, fromGrade(g));
    const unsure = items.filter((i) => out.get(i.id)?.status === "PROVISIONAL");
    const room = unsure.length ? await dailyRemaining(studentId, "PRO_GRADE", (await coachLimits()).proGradesPerDay) : 0;
    const escalate = unsure.slice(0, Number.isFinite(room) ? room : unsure.length);
    if (escalate.length && models.pro !== models.main) {
      const second = await aiGrade({ studentId, model: models.pro, items: escalate.map((i) => openItemOf(i, answers[i.id])), chunks, locale, gradedBy: "AI_PRO" });
      for (const [id, g] of second) out.set(id, fromGrade(g));
      if (second.size) await logEvent(studentId, "PRO_GRADE", quiz.id, { count: second.size, auto: true });
    }
  } catch (error) {
    console.warn("[coach] open-answer grading skipped", error instanceof Error ? error.message : error);
  }
  return out;
}

/** Rule grades for every item, then AI for written answers and near-miss short answers. */
async function gradeAll(studentId: number, quiz: CoachQuizRow, items: CoachQuizItemRow[], answers: Answers) {
  const updates = new Map<string, ItemUpdate>();
  const forAi: CoachQuizItemRow[] = [];
  for (const item of items) {
    const answer = answers[item.id];
    const outcome = gradeItem({ ...frozenOf(item), hintUsed: item.hintUsed }, answer);
    updates.set(item.id, { status: outcome.status, score: outcome.score, gradedBy: "RULE", confidence: null, feedback: null });
    if (item.type === "LONG_ANSWER" && outcome.status === "PENDING_REVIEW") forAi.push(item);
    if (item.type === "SHORT_ANSWER" && outcome.status === "WRONG") {
      const accepted = ((item.answerKey as { accepted?: string[] }).accepted ?? []) as string[];
      const given = answerString(answer);
      if (shortFoldedMatch(given, accepted)) updates.set(item.id, { status: "CORRECT", score: 100, gradedBy: "RULE", confidence: null, feedback: null });
      else if (shortNearMiss(given, accepted)) forAi.push(item);
    }
  }
  for (const [id, u] of await gradeOpen(studentId, quiz, forAi, answers)) updates.set(id, u);
  return updates;
}

/** Writes grades, the quiz score, mistakes and mastery. `firstGrading` counts a practice attempt. */
async function saveGrades(studentId: number, quiz: CoachQuizRow, changed: CoachQuizItemRow[], updates: Map<string, ItemUpdate>, answers: Answers, firstGrading: boolean) {
  const db = requireDb();
  const now = new Date();
  for (const item of changed) {
    const u = updates.get(item.id);
    if (u) await db.update(coachQuizItems).set({ ...u, answer: answers[item.id] ?? null }).where(eq(coachQuizItems.id, item.id));
  }
  const all = await itemsOf(quiz.id);
  const outcomes = all.map((i) => ({ id: i.id, status: (i.status ?? "UNANSWERED") as CoachItemStatus, score: i.score ?? 0 }));
  const score = scoreQuiz(outcomes);
  await db
    .update(coachQuizzes)
    .set({ status: "GRADED", total: score.total, correct: score.correct, pending: score.pending, percentage: score.percentage, ...(firstGrading ? { submittedAt: now } : {}) })
    .where(eq(coachQuizzes.id, quiz.id));

  const changedIds = changed.map((i) => i.id);
  if (changedIds.length) await db.delete(coachMistakes).where(and(inArray(coachMistakes.itemId, changedIds), isNull(coachMistakes.fixedAt)));
  const wrong = all.filter((i) => changedIds.includes(i.id) && i.status === "WRONG");
  if (wrong.length) {
    await db.insert(coachMistakes).values(
      wrong.map((i) => ({ id: nanoid(), studentId, materialId: quiz.materialId, topicId: i.topicId, quizId: quiz.id, itemId: i.id, cause: mistakeCause(i, answers[i.id] ?? i.answer ?? undefined), question: i.text.slice(0, 600) })),
    );
  }
  // A topic answered well again closes its older open mistakes.
  if (firstGrading && quiz.topicId && score.percentage !== null && score.percentage >= 80) {
    const older = await olderQuizIds(studentId, quiz);
    if (older.length) {
      await db
        .update(coachMistakes)
        .set({ fixedAt: now })
        .where(and(eq(coachMistakes.studentId, studentId), eq(coachMistakes.topicId, quiz.topicId), isNull(coachMistakes.fixedAt), inArray(coachMistakes.quizId, older)));
    }
  }
  if (quiz.topicId && quiz.materialId) await updateMastery(studentId, quiz.topicId, quiz.materialId, quiz.id, outcomes, now, firstGrading);
  return score;
}

export async function submitQuiz(studentId: number, quizId: string, input: Answers) {
  const quiz = await ownedQuiz(studentId, quizId);
  if (quiz.status === "GRADED") return getQuiz(studentId, quizId);
  if (busy.has(quiz.id)) throw new AppError("COACH_BUSY");
  busy.add(quiz.id);
  try {
    const items = await itemsOf(quiz.id);
    const answers: Answers = Object.fromEntries(items.map((i) => [i.id, Object.prototype.hasOwnProperty.call(input, i.id) ? input[i.id] : (i.answer ?? undefined)]));
    const updates = await gradeAll(studentId, quiz, items, answers);
    const score = await saveGrades(studentId, quiz, items, updates, answers, true);
    await logEvent(studentId, "QUIZ_SUBMITTED", quiz.id, { percentage: score.percentage, total: score.total, pending: score.pending });
    try {
      await awardXp({ studentId, workspaceId: "coach", type: "PRACTICE_DONE", points: XP.PRACTICE_DONE, refKey: `coach:quiz:${quiz.id}`, activity: true });
    } catch (error) {
      console.warn("[coach] xp award skipped", error instanceof Error ? error.message : error);
    }
    return getQuiz(studentId, quizId);
  } finally {
    busy.delete(quiz.id);
  }
}

/**
 * "Yenidən yoxla" on an AI-graded or still-pending open answer. A pending one is graded normally;
 * a graded one ("Etiraz et") gets the pro model's independent grade, which is final, and counts
 * against `proGradesPerDay`. One dispute per answer.
 */
export async function regradeItem(studentId: number, quizId: string, itemId: string) {
  const quiz = await ownedQuiz(studentId, quizId);
  if (quiz.status !== "GRADED") throw new AppError("COACH_NOT_READY");
  const [item] = await requireDb().select().from(coachQuizItems).where(and(eq(coachQuizItems.id, itemId), eq(coachQuizItems.quizId, quiz.id))).limit(1);
  if (!item) throw new AppError("NOT_FOUND");
  if (!canRegrade(item)) throw new AppError("COACH_CANNOT_REGRADE");
  if (busy.has(quiz.id)) throw new AppError("COACH_BUSY");
  busy.add(quiz.id);
  try {
    const answers: Answers = { [item.id]: item.answer ?? undefined };
    const dispute = item.status !== "PENDING_REVIEW";
    await assertCoachAiAllowed(studentId);
    const models = await coachModels();
    const chunks = await gradingChunks(quiz.topicId, [item.text]);
    let grades: Map<string, OpenGrade>;
    if (dispute) {
      await assertDailyCap(studentId, "PRO_GRADE", (await coachLimits()).proGradesPerDay);
      grades = await aiGrade({ studentId, model: models.pro, items: [openItemOf(item, answers[item.id])], chunks, locale: coachLocaleOf(quiz.locale), gradedBy: "AI_PRO" });
      await logEvent(studentId, "PRO_GRADE", quiz.id, { count: 1, dispute: true });
    } else {
      grades = await aiGrade({ studentId, model: models.main, items: [openItemOf(item, answers[item.id])], chunks, locale: coachLocaleOf(quiz.locale), gradedBy: "AI" });
    }
    const g = grades.get(item.id);
    if (!g) throw new AppError("AI_INVALID_OUTPUT");
    await saveGrades(studentId, quiz, [item], new Map([[item.id, { ...fromGrade(g), ...(dispute ? { disputed: true } : {}) }]]), answers, false);
    return getQuiz(studentId, quizId);
  } finally {
    busy.delete(quiz.id);
  }
}

async function olderQuizIds(studentId: number, quiz: CoachQuizRow): Promise<string[]> {
  if (!quiz.topicId) return [];
  const rows = await requireDb()
    .select({ id: coachQuizzes.id })
    .from(coachQuizzes)
    .where(and(eq(coachQuizzes.studentId, studentId), eq(coachQuizzes.topicId, quiz.topicId)));
  return rows.map((r) => r.id).filter((id) => id !== quiz.id);
}

async function updateMastery(studentId: number, topicId: string, materialId: string, quizId: string, outcomes: ItemOutcome[], now: Date, newAttempt: boolean) {
  const db = requireDb();
  const [prev] = await db.select().from(coachTopicMastery).where(and(eq(coachTopicMastery.studentId, studentId), eq(coachTopicMastery.topicId, topicId))).limit(1);
  const previous = prev?.evidence ?? [];
  const at = newAttempt ? now : new Date(previous.find((e) => e.resultId === quizId)?.completedAt ?? now);
  const evidence = addEvidence(previous, quizId, outcomes, at);
  const { mastery, status } = coachMastery(evidence);
  const percentage = scoreQuiz(outcomes).percentage;
  const review = newAttempt
    ? nextReview({ percentage, mastery, status, previousInterval: prev?.intervalDays ?? 0, now })
    : { nextReviewAt: prev?.nextReviewAt ?? null, intervalDays: prev?.intervalDays ?? 0 };
  const values = {
    materialId,
    mastery,
    status,
    attempts: (prev?.attempts ?? 0) + (newAttempt ? 1 : 0),
    evidence,
    lastPracticedAt: newAttempt ? now : (prev?.lastPracticedAt ?? now),
    nextReviewAt: review.nextReviewAt,
    intervalDays: review.intervalDays,
  };
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
