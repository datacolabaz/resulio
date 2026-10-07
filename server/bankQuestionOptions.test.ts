import { describe, expect, it, vi } from "vitest";
import { questionInputSchema, type QuestionInput } from "../shared/assessment";
import { needsAnswerCheck } from "../shared/questionImport";
import { questionPreview } from "../shared/questionPreview";
import * as assessmentsMod from "./modules/assessments";
import { gradeAttempt, gradeQuestion, toStudentQuestion, type FrozenQuestion } from "./modules/engine";
import { bankRows } from "./questionBank/bank";
import { normalizeItem, type RawItem, type SectionContext } from "./questionBank/extraction";
import * as topicsMod from "./questionBank/topics";

vi.mock("./modules/assessments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/assessments")>()),
  questionBank: vi.fn(),
}));
vi.mock("./questionBank/topics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./questionBank/topics")>()),
  placementsOf: vi.fn(),
}));

const ctx = { sections: { subject: "Riyaziyyat", chosen: { id: "s1", name: "Say sistemləri" }, others: [] } as SectionContext, pageOffset: 0 };
const octal = (over: Partial<RawItem> = {}): RawItem => ({
  type: "MULTIPLE_CHOICE",
  text: "665₈ + 777₈ = X₈",
  options: ["A) 1221", "B) 1664", "C) 11475", "D) 7556", "E) 13667"].map((text, i) => ({ label: "ABCDE"[i], text })),
  markedAnswer: null,
  aiAnswer: "B",
  confidence: "high",
  ...over,
});

/** What accepting an import item stores in the bank (the same validation as the manual editor). */
function imported(over: Partial<RawItem> = {}) {
  const item = normalizeItem(octal(over), ctx);
  const parsed = questionInputSchema.safeParse(item.question);
  if (!parsed.success) throw new Error("invalid import");
  return { item, question: parsed.data };
}

/** Publishing freezes the linked bank row as-is. */
const freeze = (q: QuestionInput, id: string, position = 1): FrozenQuestion => ({
  id,
  position,
  type: q.type,
  text: q.text,
  points: q.points,
  topic: q.topic,
  skill: q.skill,
  difficulty: q.difficulty,
  explanation: q.explanation ?? null,
  imageUrl: q.imageUrl ?? null,
  content: q.content,
  answerKey: q.answerKey,
});

describe("an imported closed question, from bank to exam", () => {
  it("is stored with lettered options and the correct key", () => {
    const { item, question } = imported();
    expect(item).toMatchObject({ answerSource: "AI", issues: ["AI_ANSWER"] });
    expect(question).toMatchObject({
      type: "MULTIPLE_CHOICE",
      content: { options: [{ key: "A", text: "1221" }, { key: "B", text: "1664" }, { key: "C", text: "11475" }, { key: "D", text: "7556" }, { key: "E", text: "13667" }] },
      answerKey: { correct: "B" },
    });
  });

  it("reaches the student with every option and without the answer", () => {
    const { question } = imported({ explanation: "8-lik say sistemi" } as Partial<RawItem>);
    const student = toStudentQuestion(freeze(question, "q1"), "attempt:q1");
    expect(student.options).toEqual([
      { key: "A", text: "1221" },
      { key: "B", text: "1664" },
      { key: "C", text: "11475" },
      { key: "D", text: "7556" },
      { key: "E", text: "13667" },
    ]);
    expect(Object.keys(student).sort()).toEqual(["id", "imageUrl", "options", "points", "position", "text", "type"]);
    expect(JSON.stringify(student)).not.toMatch(/answerKey|correct|explanation/);
  });

  it("grades the imported key, with the wrong-answer penalty for closed questions", () => {
    const q1 = freeze(imported().question, "q1", 1);
    const q2 = freeze(imported().question, "q2", 2);
    expect(gradeQuestion(q1, "B").status).toBe("CORRECT");
    expect(gradeQuestion(q1, "C").status).toBe("WRONG");
    const score = gradeAttempt([q1, q2], { q1: "B", q2: "A" }, 4);
    expect(score).toMatchObject({ correctCount: 1, wrongCount: 1, earnedPoints: 0.75 });
  });
});

describe("teacher preview", () => {
  it("letters the options and names the correct one", () => {
    const p = questionPreview(imported().question);
    expect(p.options.map((o) => `${o.letter}${o.correct ? "*" : ""}`)).toEqual(["A", "B*", "C", "D", "E"]);
    expect(p.answer).toEqual({ kind: "choice", letters: ["B"] });
  });

  it("letters by position even when stored keys are not letters, and tolerates loose JSON", () => {
    const p = questionPreview({ type: "MULTIPLE_SELECT", content: { options: [{ key: "a", text: "x" }, { key: "b", text: "y" }, "z"] }, answerKey: { correct: ["b", "C"] } });
    expect(p.options.map((o) => [o.letter, o.text, o.correct])).toEqual([
      ["A", "x", false],
      ["B", "y", true],
      ["C", "z", true],
    ]);
    expect(questionPreview({ type: "MULTIPLE_CHOICE", content: null, answerKey: null })).toEqual({ options: [], answer: null });
  });

  it("summarises the other answer types", () => {
    expect(questionPreview({ type: "TRUE_FALSE", content: {}, answerKey: { correct: false } }).answer).toEqual({ kind: "boolean", value: false });
    expect(questionPreview({ type: "NUMERIC", content: { unit: "kg" }, answerKey: { value: 5, tolerance: 0.5 } }).answer).toEqual({ kind: "text", value: "5 ± 0.5 kg" });
    expect(questionPreview({ type: "SHORT_ANSWER", content: {}, answerKey: { accepted: ["Bakı", "Baku"] } }).answer).toEqual({ kind: "text", value: "Bakı / Baku" });
    expect(questionPreview({ type: "LONG_ANSWER", content: {}, answerKey: {} }).answer).toBeNull();
  });
});

describe("answers waiting for the teacher", () => {
  it("are the AI-chosen ones and those the AI disputed", () => {
    expect(needsAnswerCheck({ answerSource: "AI", aiConfidence: "HIGH" })).toBe(true);
    expect(needsAnswerCheck({ answerSource: "SOURCE", aiConfidence: "LOW" })).toBe(true);
    expect(needsAnswerCheck({ answerSource: "SOURCE", aiConfidence: "HIGH" })).toBe(false);
    expect(needsAnswerCheck({ answerSource: "TEACHER", aiConfidence: "LOW" })).toBe(false);
    expect(needsAnswerCheck({ answerSource: null, aiConfidence: null })).toBe(false);
  });
});

describe("bank list payload", () => {
  it("carries the options, the answer key and the confirmation flag to the teacher", async () => {
    const { question } = imported();
    const row = { id: "q1", ...question };
    vi.mocked(assessmentsMod.questionBank).mockResolvedValue([row] as never);
    vi.mocked(topicsMod.placementsOf).mockResolvedValue(new Map([["q1", { sectionId: "s1", bankNumber: 7, answerCheck: true }]]));
    const [listed] = await bankRows({ workspaceId: "ws1", userId: 7 } as never, {});
    expect(listed).toMatchObject({
      id: "q1",
      sectionId: "s1",
      bankNumber: 7,
      answerCheck: true,
      content: { options: question.content.options },
      answerKey: { correct: "B" },
    });
  });
});
