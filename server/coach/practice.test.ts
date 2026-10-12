import { describe, expect, it } from "vitest";
import { addEvidence, coachMastery, gradeItem, MAX_EVIDENCE, mistakeCause, scoreQuiz, type GradableItem } from "./grading";
import { promptChunks } from "./packs";
import { draftItems, enoughItems, quizMessages, quizSchema, toDraftItem, type RawQuestion } from "./quizgen";
import type { RetrievalChunk } from "./retrieval";

const chunk = (ord: number, text: string): RetrievalChunk => ({ id: `id${ord}`, ord, pageFrom: ord + 1, pageTo: ord + 1, heading: "", text });
const chunks = [
  chunk(0, "Fotosintez zamanı bitkilər işıq enerjisindən istifadə edərək karbon qazı və sudan qlükoza və oksigen əmələ gətirir."),
  chunk(1, "Xlorofil yaşıl piqmentdir və işığı udur. O, xloroplastlarda yerləşir və fotosintezin işıq mərhələsində iştirak edir."),
];
const { prompt, byLabel } = promptChunks(chunks);

const mcq = (over: Partial<RawQuestion> = {}): RawQuestion => ({
  type: "MULTIPLE_CHOICE",
  text: "Xlorofil harada yerləşir?",
  options: ["Xloroplastlarda", "Nüvədə", "Mitoxondridə", "Ribosomda"],
  correctIndex: 0,
  explanation: "Mətndə deyilir.",
  hint: "Yaşıl orqanoidi düşünün.",
  cites: [{ chunk: "C2", quote: "O, xloroplastlarda yerləşir və fotosintezin işıq mərhələsində iştirak edir" }],
  ...over,
});

const item = (draft: NonNullable<ReturnType<typeof toDraftItem>>, hintUsed = false): GradableItem => ({
  id: "i1",
  position: 0,
  type: draft.type,
  text: draft.text,
  points: 1,
  topic: "",
  skill: "",
  difficulty: "MEDIUM",
  explanation: draft.explanation,
  imageUrl: null,
  content: draft.content,
  answerKey: draft.answerKey,
  hintUsed,
});

describe("quiz prompt", () => {
  it("asks for the user's app language, whatever the material's language", () => {
    for (const [locale, name] of [["en", "English"], ["ru", "Russian"], ["az", "Azerbaijani"]] as const) {
      const system = quizMessages({ format: "MCQ", count: 5, topicTitle: "Fotosintez", chunks: prompt, locale, nonce: "n1" })[0].content as string;
      expect(system).toContain(name);
      expect(system).toMatch(/verbatim|exactly/i);
    }
  });

  it("lists only the format's question types and earlier questions to avoid", () => {
    const system = quizMessages({ format: "CALCULATION", count: 5, topicTitle: "T", chunks: prompt, locale: "en", nonce: "n", avoid: ["Old question?"] })[0].content as string;
    expect(system).toContain("NUMERIC");
    expect(system).not.toContain("MATCHING:");
    expect(system).toContain("Old question?");
  });
});

describe("question normalization", () => {
  it("shuffles multiple-choice options and keeps the key on the right option", () => {
    const d = toDraftItem(mcq(), ["MULTIPLE_CHOICE"], byLabel, "seed")!;
    const options = (d.content as { options: { key: string; text: string }[] }).options;
    const key = (d.answerKey as { correct: string }).correct;
    expect(options.find((o) => o.key === key)?.text).toBe("Xloroplastlarda");
    expect(d.cites).toHaveLength(1);
    expect(d.cites[0].page).toBe(2);
  });

  it("drops invented quotes but keeps the question", () => {
    const d = toDraftItem(mcq({ cites: [{ chunk: "C1", quote: "this sentence is not in the material at all, really" }] }), ["MULTIPLE_CHOICE"], byLabel, "s")!;
    expect(d.cites).toEqual([]);
  });

  it("rejects broken questions and types outside the format", () => {
    expect(toDraftItem(mcq({ correctIndex: 7 }), ["MULTIPLE_CHOICE"], byLabel, "s")).toBeNull();
    expect(toDraftItem(mcq({ options: ["A", "a", "B"] }), ["MULTIPLE_CHOICE"], byLabel, "s")).toBeNull();
    expect(toDraftItem(mcq(), ["TRUE_FALSE"], byLabel, "s")).toBeNull();
    expect(toDraftItem({ type: "TRUE_FALSE", text: "Xlorofil qırmızıdır." }, ["TRUE_FALSE"], byLabel, "s")).toBeNull();
    expect(toDraftItem({ type: "SHORT_ANSWER", text: "Yaşıl piqment?", accepted: [] }, ["SHORT_ANSWER"], byLabel, "s")).toBeNull();
    expect(toDraftItem({ type: "MATCHING", text: "Uyğunlaşdırın", pairs: [{ left: "a", right: "b" }] }, ["MATCHING"], byLabel, "s")).toBeNull();
  });

  it("builds matching keys, numeric tolerance and the calculation spec", () => {
    const m = toDraftItem(
      { type: "MATCHING", text: "Uyğunlaşdırın", pairs: [{ left: "Xlorofil", right: "piqment" }, { left: "Qlükoza", right: "şəkər" }, { left: "O2", right: "qaz" }] },
      ["MATCHING"],
      byLabel,
      "s",
    )!;
    expect(m.answerKey).toEqual({ pairs: { L1: "R1", L2: "R2", L3: "R3" } });
    const n = toDraftItem({ type: "NUMERIC", text: "2 kq kütləyə 3 m/s² təcil üçün qüvvə?", value: 6, unit: "N", formula: "m*a", variables: { m: 2, a: 3 } }, ["NUMERIC"], byLabel, "s")!;
    expect(n.answerKey).toEqual({ value: 6, tolerance: 0.03 });
    expect(n.content).toEqual({ unit: "N" });
    expect(n.calc).toEqual({ formula: "m*a", variables: { m: 2, a: 3 }, unit: "N" });
  });

  it("dedupes, caps at the count, and needs at least half", () => {
    const raws = quizSchema.parse({ questions: [mcq(), mcq(), mcq({ text: "Fotosintezin məhsulu nədir?", options: ["Qlükoza", "Azot", "Dəmir"], correctIndex: 0 }), mcq({ correctIndex: -1 })] }).questions;
    const items = draftItems(raws, "MCQ", 5, byLabel, "q");
    expect(items).toHaveLength(2);
    expect(draftItems(raws, "MCQ", 1, byLabel, "q")).toHaveLength(1);
    expect(enoughItems(2, 5)).toBe(false);
    expect(enoughItems(3, 5)).toBe(true);
    expect(enoughItems(5, 10)).toBe(true);
  });
});

describe("grading", () => {
  it("grades closed questions with the assessment engine", () => {
    const d = toDraftItem(mcq(), ["MULTIPLE_CHOICE"], byLabel, "seed")!;
    const key = (d.answerKey as { correct: string }).correct;
    expect(gradeItem(item(d), key)).toMatchObject({ status: "CORRECT", score: 100 });
    expect(gradeItem(item(d), key === "A" ? "B" : "A")).toMatchObject({ status: "WRONG", score: 0 });
    expect(gradeItem(item(d), undefined).status).toBe("UNANSWERED");
  });

  it("scores over graded items only", () => {
    expect(scoreQuiz([{ status: "CORRECT", score: 100 }, { status: "WRONG", score: 0 }, { status: "PENDING_REVIEW", score: 0 }])).toEqual({ total: 3, correct: 1, pending: 1, percentage: 50 });
    expect(scoreQuiz([{ status: "PENDING_REVIEW", score: 0 }]).percentage).toBeNull();
    expect(scoreQuiz([{ status: "PARTIAL", score: 50 }, { status: "CORRECT", score: 100 }]).percentage).toBe(75);
  });

  it("guesses a mistake's cause without AI", () => {
    const n = toDraftItem({ type: "NUMERIC", text: "Qüvvəni hesablayın.", value: 6 }, ["NUMERIC"], byLabel, "s")!;
    expect(mistakeCause(item(n), "6.4")).toBe("CALC_SLIP");
    expect(mistakeCause(item(n), "-6")).toBe("CALC_SLIP");
    expect(mistakeCause(item(n), "60")).toBe("UNKNOWN");
    expect(mistakeCause(item(n, true), "60")).toBe("NOT_LEARNED");
    const d = toDraftItem(mcq(), ["MULTIPLE_CHOICE"], byLabel, "seed")!;
    expect(mistakeCause(item(d), "Z")).toBe("CONCEPT_CONFUSION");
  });
});

describe("mastery", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 9, day));
  it("keeps the newest evidence first, replaces a re-graded quiz, and caps the list", () => {
    let ev = addEvidence([], "q1", [{ status: "CORRECT", score: 100 }, { status: "WRONG", score: 0 }], at(1));
    expect(ev[0]).toMatchObject({ resultId: "q1", questionCount: 2, possible: 2, earned: 1, wrongPoints: 1 });
    ev = addEvidence(ev, "q1", [{ status: "CORRECT", score: 100 }, { status: "CORRECT", score: 100 }], at(1));
    expect(ev).toHaveLength(1);
    for (let i = 0; i < 15; i++) ev = addEvidence(ev, `x${i}`, [{ status: "CORRECT", score: 100 }], at(2 + i));
    expect(ev).toHaveLength(MAX_EVIDENCE);
    expect(ev[0].resultId).toBe("x14");
  });

  it("uses the Growth formula: few answers are INSUFFICIENT, many right ones STRONG", () => {
    const one = addEvidence([], "q1", [{ status: "CORRECT", score: 100 }], at(1));
    expect(coachMastery(one).status).toBe("INSUFFICIENT");
    let ev = one;
    for (let i = 0; i < 4; i++) ev = addEvidence(ev, `q${i + 2}`, Array.from({ length: 5 }, () => ({ status: "CORRECT" as const, score: 100 })), at(2 + i));
    const m = coachMastery(ev);
    expect(m.status).toBe("STRONG");
    expect(m.mastery).toBeGreaterThan(75);
    let bad = one;
    for (let i = 0; i < 4; i++) bad = addEvidence(bad, `b${i}`, Array.from({ length: 5 }, () => ({ status: "WRONG" as const, score: 0 })), at(2 + i));
    expect(coachMastery(bad).status).toBe("CRITICAL");
    expect(coachMastery([]).mastery).toBe(0);
  });
});
