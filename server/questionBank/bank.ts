import { randomInt } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { questionMeta, questions } from "../../drizzle/schema";
import type { QuestionInput } from "../../shared/assessment";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "../modules/access";
import * as assessments from "../modules/assessments";
import { AppError } from "../modules/errors";
import { fileInSection, guardBankTables, ownedSection, placementsOf, questionIdsUnder, topicPaths, topicsOf, type ImportProvenance } from "./topics";

/** Creates a question filed in a section, numbered there; `questions.topic` mirrors the section name. */
export async function createBankQuestion(
  scope: TeacherScope,
  input: QuestionInput,
  opts: { sectionId: string; source?: "MANUAL" | "AI"; provenance?: ImportProvenance },
  db: DbOrTx = requireDb(),
) {
  const section = await guardBankTables(() => ownedSection(scope, opts.sectionId, db));
  return db.transaction(async (tx) => {
    const row = await assessments.createQuestion(scope, { ...input, topic: section.name }, opts.source ?? "MANUAL", tx);
    const numbers = await fileInSection(tx, scope.workspaceId, section.id, [row.id], opts.provenance);
    return { ...row, topic: section.name, sectionId: section.id, bankNumber: numbers.get(row.id) ?? null };
  });
}

/** Edits keep the question's section: its topic text stays the section name. */
export async function updateBankQuestion(scope: TeacherScope, id: string, input: QuestionInput) {
  const placement = (await placementsOf(scope.workspaceId, [id])).get(id);
  if (!placement?.sectionId) return assessments.updateQuestion(scope, id, input);
  const section = await ownedSection(scope, placement.sectionId).catch(() => null);
  return assessments.updateQuestion(scope, id, section ? { ...input, topic: section.name } : input);
}

export async function createInAssessment(scope: TeacherScope, assessmentId: string, input: QuestionInput, sectionId: string) {
  await assessments.ownedAssessment(scope, assessmentId);
  const q = await createBankQuestion(scope, input, { sectionId });
  await assessments.addQuestionToAssessment(scope, assessmentId, q.id);
  return q;
}

/** Bank rows with their section and number; `topicId` (a subject or a section) needs migration 0030, the rest does not. */
export async function bankRows(
  scope: TeacherScope,
  filter: { topicId?: string; topic?: string; difficulty?: string; type?: string; source?: string; search?: string },
) {
  const { topicId, ...rest } = filter;
  const onlyIds = topicId ? await guardBankTables(() => questionIdsUnder(scope, topicId)) : undefined;
  if (onlyIds && !onlyIds.length) return [];
  const rows = await assessments.questionBank(scope, { ...rest, ids: onlyIds });
  const placed = await withPlacements(scope, rows);
  if (!topicId) return placed;
  // Browsing a subject or section lists questions by section, then by bank number.
  const paths = topicPaths(await topicsOf(scope.workspaceId));
  const pathOf = (id: string | null) => (id ? (paths.get(id) ?? "") : "");
  return placed.sort((a, b) => pathOf(a.sectionId).localeCompare(pathOf(b.sectionId)) || (a.bankNumber ?? 0) - (b.bankNumber ?? 0));
}

export interface SectionPick {
  sectionId: string;
  /** Hand-picked questions of this section. */
  questionIds?: string[];
  /** How many more to draw at random from the rest of the section. */
  count?: number;
}

/**
 * Adds questions from one or more sections of the bank to a draft exam: a topic exam is one
 * section, a general exam several. Random draws skip questions already in the exam and the
 * hand-picked ones. Questions are appended section by section, in bank-number order.
 */
export async function addFromBank(scope: TeacherScope, assessmentId: string, picks: SectionPick[], random: (n: number) => number = (n) => randomInt(n)) {
  await assessments.ownedAssessment(scope, assessmentId);
  const inExam = new Set((await assessments.draftQuestions(assessmentId)).map((q) => q.id));
  const sections = new Map<string, BankEntry[]>();
  for (const pick of picks) {
    if (sections.has(pick.sectionId)) continue;
    await guardBankTables(() => ownedSection(scope, pick.sectionId));
    sections.set(pick.sectionId, await bankSection(scope.workspaceId, pick.sectionId));
  }
  const { ordered, short } = pickFromSections(picks, sections, inExam, random);
  const added = await assessments.addQuestionsToAssessment(scope, assessmentId, ordered);
  return { added, short };
}

type BankEntry = { questionId: string; bankNumber: number | null };

/**
 * Which questions the picks add, in exam order. Hand-picked ids must belong to their section
 * (ids already in the exam are skipped); the random part draws uniformly from what is left.
 */
export function pickFromSections(picks: SectionPick[], sections: Map<string, BankEntry[]>, inExam: Set<string>, random: (n: number) => number) {
  const ordered: string[] = [];
  const short: { sectionId: string; requested: number; drawn: number }[] = [];
  for (const pick of picks) {
    const section = sections.get(pick.sectionId) ?? [];
    const pool = section.filter((q) => !inExam.has(q.questionId) && !ordered.includes(q.questionId));
    const handPicked = new Set(pick.questionIds ?? []);
    if ([...handPicked].some((id) => !section.some((q) => q.questionId === id))) throw new AppError("NOT_FOUND");
    const rest = pool.filter((q) => !handPicked.has(q.questionId));
    const want = Math.max(0, pick.count ?? 0);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = random(i + 1);
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const drawn = new Set(rest.slice(0, want));
    if (drawn.size < want) short.push({ sectionId: pick.sectionId, requested: want, drawn: drawn.size });
    const chosen = pool.filter((q) => handPicked.has(q.questionId) || drawn.has(q));
    ordered.push(...chosen.sort((a, b) => (a.bankNumber ?? 0) - (b.bankNumber ?? 0)).map((q) => q.questionId));
  }
  return { ordered, short };
}

async function bankSection(workspaceId: string, sectionId: string) {
  return requireDb()
    .select({ questionId: questionMeta.questionId, bankNumber: questionMeta.bankNumber })
    .from(questionMeta)
    .innerJoin(questions, eq(questions.id, questionMeta.questionId))
    .where(and(eq(questionMeta.providerWorkspaceId, workspaceId), eq(questionMeta.sectionId, sectionId)))
    .orderBy(asc(questionMeta.bankNumber));
}

export async function withPlacements<T extends { id: string }>(scope: TeacherScope, rows: T[]) {
  const placed = await placementsOf(scope.workspaceId, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, sectionId: placed.get(r.id)?.sectionId ?? null, bankNumber: placed.get(r.id)?.bankNumber ?? null }));
}
