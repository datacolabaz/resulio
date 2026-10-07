import { describe, expect, it } from "vitest";
import { assessmentSettingsSchema } from "../shared/assessment";
import { gradeAttempt, penaltyRule, scoreItems, type FrozenQuestion, type GradedItem } from "./modules/engine";
import { examResultNotice, resultEmailAction } from "./modules/resultEmail";
import { renderNotification } from "./notifications/render";

const mc = (id: string, points = 1): FrozenQuestion =>
  ({
    id,
    position: 1,
    type: "MULTIPLE_CHOICE",
    text: "Q",
    points,
    topic: "",
    skill: "",
    difficulty: "MEDIUM",
    explanation: null,
    imageUrl: null,
    content: { options: [{ key: "A", text: "1" }, { key: "B", text: "2" }, { key: "C", text: "3" }, { key: "D", text: "4" }] },
    answerKey: { correct: "A" },
  }) as FrozenQuestion;
const open = (id: string, points: number): FrozenQuestion =>
  ({ ...mc(id, points), type: "LONG_ANSWER", content: {}, answerKey: {} }) as FrozenQuestion;

/** `right` correct, `wrong` wrong and `blank` unanswered one-point closed questions. */
function closedExam(right: number, wrong: number, blank: number) {
  const questions = Array.from({ length: right + wrong + blank }, (_, i) => mc(`q${i}`));
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    if (i < right) answers[q.id] = "A";
    else if (i < right + wrong) answers[q.id] = "B";
  });
  return { questions, answers };
}

describe("wrong-answer penalty", () => {
  it("is off by default and on old versions without the setting", () => {
    expect(assessmentSettingsSchema.shape.wrongPenalty.parse(undefined)).toEqual({ enabled: false, ratio: 4 });
    expect(assessmentSettingsSchema.shape.wrongPenalty.safeParse({ enabled: true, ratio: 1 }).success).toBe(false);
    expect(penaltyRule(undefined)).toBeNull();
    expect(penaltyRule({})).toBeNull();
    expect(penaltyRule({ wrongPenalty: { enabled: false, ratio: 4 } })).toBeNull();
    expect(penaltyRule({ wrongPenalty: { enabled: true, ratio: 4 } })).toBe(4);
    const { questions, answers } = closedExam(6, 4, 0);
    expect(gradeAttempt(questions, answers)).toMatchObject({ earnedPoints: 6, penalty: null });
  });

  it("takes one correct answer off for every four wrong ones, exactly and per question points", () => {
    const { questions, answers } = closedExam(10, 4, 2);
    expect(gradeAttempt(questions, answers, 4)).toMatchObject({
      earnedPoints: 9,
      percentage: 56.3,
      wrongCount: 4,
      unansweredCount: 2,
      penalty: { ratio: 4, wrongCount: 4, closedEarned: 10, penaltyPoints: 1 },
    });
    const three = closedExam(10, 3, 0);
    expect(gradeAttempt(three.questions, three.answers, 4)).toMatchObject({ earnedPoints: 9.25, penalty: { penaltyPoints: 0.75 } });

    const weighted = [mc("a", 2), mc("b", 3), mc("c", 1)];
    const score = gradeAttempt(weighted, { a: "A", b: "B", c: "B" }, 4);
    expect(score.penalty).toMatchObject({ wrongCount: 2, penaltyPoints: 1 });
    expect(score.earnedPoints).toBe(1);
  });

  it("does not count unanswered questions as wrong", () => {
    const { questions, answers } = closedExam(5, 0, 10);
    expect(gradeAttempt(questions, answers, 4)).toMatchObject({ earnedPoints: 5, penalty: { wrongCount: 0, penaltyPoints: 0 } });
  });

  it("never takes the closed part below zero", () => {
    const { questions, answers } = closedExam(1, 12, 0);
    expect(gradeAttempt(questions, answers, 4)).toMatchObject({ earnedPoints: 0, penalty: { closedEarned: 1, penaltyPoints: 1 } });
    const none = closedExam(0, 8, 0);
    expect(gradeAttempt(none.questions, none.answers, 4)).toMatchObject({ earnedPoints: 0, percentage: 0, penalty: { penaltyPoints: 0 } });
  });

  it("leaves open questions alone, also after manual grading", () => {
    const questions = [...closedExam(1, 0, 0).questions, mc("w"), open("essay", 5)];
    const items: GradedItem[] = [
      { questionId: "q0", status: "CORRECT", earned: 1, topic: "", skill: "" },
      { questionId: "w", status: "WRONG", earned: 0, topic: "", skill: "" },
      { questionId: "essay", status: "PARTIAL", earned: 4, topic: "", skill: "" },
    ];
    // The deduction is capped by the closed part (1 point), not by the essay's points.
    const score = scoreItems(questions, items, 1);
    expect(score.penalty).toMatchObject({ closedEarned: 1, penaltyPoints: 1 });
    expect(score.earnedPoints).toBe(4);
    expect(score.totalPoints).toBe(7);
  });
});

describe("result e-mails", () => {
  it("wait until the result is final and released, and skip students without an address", () => {
    expect(resultEmailAction({ released: false, pendingReviewCount: 0, email: "s@x.az" })).toBe("WAIT");
    expect(resultEmailAction({ released: true, pendingReviewCount: 1, email: "s@x.az" })).toBe("WAIT");
    expect(resultEmailAction({ released: true, pendingReviewCount: 0, email: " " })).toBe("NO_EMAIL");
    expect(resultEmailAction({ released: true, pendingReviewCount: 0, email: null })).toBe("NO_EMAIL");
    expect(resultEmailAction({ released: true, pendingReviewCount: 0, email: "s@x.az" })).toBe("SEND");
  });

  it("are off unless the teacher ticks the box", () => {
    expect(assessmentSettingsSchema.shape.emailResults.parse(undefined)).toBe(false);
  });

  it("show the score and the deduction in the student's language, with a link to the result", () => {
    const result = {
      id: "r1",
      earnedPoints: 9.25,
      totalPoints: 16,
      percentage: 57.8,
      correctCount: 10,
      wrongCount: 3,
    } as Parameters<typeof examResultNotice>[0];
    const data = examResultNotice(result, "<b>Riyaziyyat</b> sınaq", { ratio: 4, wrongCount: 3, closedEarned: 10, penaltyPoints: 0.75 });
    const az = renderNotification("EXAM_RESULT_READY", data, { locale: "az", email: "s@x.az" }, "https://resulio.co").email!;
    expect(az.subject).toContain("İmtahan nəticəniz");
    expect(az.text).toContain("Bal: 9,25 / 16 (57,8%)");
    expect(az.text).toContain("4 səhv cavab 1 düzgün cavabı aparır");
    expect(az.text).toContain("−0,75");
    expect(az.text).toContain("https://resulio.co/student/results/r1");
    expect(az.html).not.toContain("<b>Riyaziyyat");

    const en = renderNotification("EXAM_RESULT_READY", { ...data, penalty: null }, { locale: "en", email: "s@x.az" }, "https://resulio.co").email!;
    expect(en.text).toContain("Score: 9.25 / 16 (57.8%)");
    expect(en.text).not.toContain("Deducted");

    const ru = renderNotification("EXAM_RESULT_READY", data, { locale: "ru", email: "s@x.az" }, "https://resulio.co").email!;
    expect(ru.text).toContain("каждые 4 неверных ответа");
  });
});
