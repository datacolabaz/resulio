import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { coachArtifacts, coachChunks, coachTopics, type CoachArtifactRow, type CoachChunkRow, type CoachTopicRow } from "../../drizzle/schema";
import { SUMMARY_KIND, type ArtifactContent, type ArtifactKind, type CoachLocale, type PackConcept, type PackPoint, type SummaryFormat } from "../../shared/coach";
import type { Message } from "../_core/llm";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { DATA_RULE, generateStructured, languageRule, materialBlock, withCoachAi, type PromptChunk } from "./ai";
import { assertNotInExam } from "./examLock";
import { onMaterialDelete, onMaterialTextChange, ownedMaterial } from "./materials";
import { coachModels } from "./models";
import { assertCoachAiAllowed } from "./quota";
import { selectChunks, verifyCites, type RetrievalChunk } from "./retrieval";
import { logEvent } from "./store";

/**
 * "Öyrən": per-topic summary packs (short + key concepts, detailed, exam) generated from the
 * topic's own chunks, in the student's app language, with citations checked against the source.
 * Cached per (topic, kind, language); a different language or corrected text regenerates.
 */

/** Bump when the prompts change so cached packs are rebuilt. */
export const PACK_PROMPT_REVISION = 1;
const PACK_MAX_CHARS = 24_000;

// ---------------------------------------------------------------------------
// Prompt (pure)
// ---------------------------------------------------------------------------

const citeSchema = z.array(z.object({ chunk: z.string(), quote: z.string() })).max(6).optional();
const pointSchema = z.object({ text: z.string(), cites: citeSchema });
export const packSchema = z.object({
  title: z.string(),
  sections: z.array(z.object({ heading: z.string(), points: z.array(pointSchema).max(20) })).max(12),
  concepts: z.array(z.object({ term: z.string(), definition: z.string(), cites: citeSchema })).max(20).optional(),
  questions: z.array(z.string()).max(12).optional(),
  pitfalls: z.array(z.string()).max(12).optional(),
});
export type RawPack = z.infer<typeof packSchema>;

const citeJson = { type: "array", items: { type: "object", properties: { chunk: { type: "string" }, quote: { type: "string" } }, required: ["chunk", "quote"] } };
const pointJson = { type: "object", properties: { text: { type: "string" }, cites: citeJson }, required: ["text", "cites"] };
export const packJsonSchema = {
  name: "coach_pack",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      sections: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, points: { type: "array", items: pointJson } }, required: ["heading", "points"] } },
      concepts: { type: "array", items: { type: "object", properties: { term: { type: "string" }, definition: { type: "string" }, cites: citeJson }, required: ["term", "definition", "cites"] } },
      questions: { type: "array", items: { type: "string" } },
      pitfalls: { type: "array", items: { type: "string" } },
    },
    required: ["title", "sections"],
  },
};

const FORMAT_RULES: Record<SummaryFormat, string> = {
  SHORT: "A short summary: 1-2 sections, 4-8 points in total, one sentence each. Also return `concepts`: the 4-10 key terms of the topic with a one-sentence definition each.",
  DETAILED: "A detailed study summary: one section per sub-topic in the material's order, 3-8 points each, each point 1-3 sentences that explain, not just list.",
  EXAM: "An exam-prep summary: sections with the facts, definitions, formulas and dates most likely to be asked; plus `questions` (5-8 likely exam questions) and `pitfalls` (3-6 common mistakes).",
};

export function packMessages(input: { format: SummaryFormat; topicTitle: string; chunks: PromptChunk[]; locale: CoachLocale; nonce: string }): Message[] {
  return [
    {
      role: "system",
      content: [
        "You are a study coach preparing study notes for one student from their own material.",
        FORMAT_RULES[input.format],
        "Use the material first. For every point give `cites`: the chunk label (e.g. C3) and a short quote (8-25 words) copied character for character from that chunk. A point the material does not support may use general knowledge, with empty `cites`; never invent quotes.",
        "Title: a short title for the topic.",
        languageRule(input.locale),
        DATA_RULE,
      ].join("\n"),
    },
    { role: "user", content: `Topic: ${input.topicTitle}\n\n${materialBlock(input.chunks, input.nonce)}` },
  ];
}

/** Everything the cached result depends on; a different value means regenerate. */
export function packInputHash(input: { kind: ArtifactKind; locale: CoachLocale; chunks: Pick<CoachChunkRow, "id" | "text">[] }): string {
  const h = createHash("sha256");
  h.update(`${PACK_PROMPT_REVISION}|${input.kind}|${input.locale}|`);
  for (const c of input.chunks) h.update(`${c.id}:${c.text.length}:${c.text}\u0000`);
  return h.digest("hex");
}

/** Short labels (C1, C2 …) are easier for the model to copy than ids. */
export function promptChunks(chunks: RetrievalChunk[]): { prompt: PromptChunk[]; byLabel: Map<string, RetrievalChunk> } {
  const byLabel = new Map<string, RetrievalChunk>();
  const prompt = chunks.map((c, i) => {
    const label = `C${i + 1}`;
    byLabel.set(label, c);
    return { id: label, pageFrom: c.pageFrom, pageTo: c.pageTo, heading: c.heading, text: c.text };
  });
  return { prompt, byLabel };
}

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** Verified citations only; a point without one is marked as general knowledge. */
export function finishPack(raw: RawPack, byLabel: Map<string, RetrievalChunk>, fallbackTitle: string): ArtifactContent {
  const point = (p: { text: string; cites?: { chunk: string; quote: string }[] }): PackPoint | null => {
    const text = clean(p.text, 800);
    if (!text) return null;
    const cites = verifyCites(p.cites, byLabel);
    return { text, cites, grounding: cites.length ? "MATERIAL" : "GENERAL" };
  };
  const sections = raw.sections
    .map((s) => ({ heading: clean(s.heading, 160), points: s.points.map(point).filter((p): p is PackPoint => !!p) }))
    .filter((s) => s.points.length);
  const concepts = raw.concepts
    ?.map((c): PackConcept | null => {
      const term = clean(c.term, 120);
      const definition = clean(c.definition, 500);
      if (!term || !definition) return null;
      const cites = verifyCites(c.cites, byLabel);
      return { term, definition, cites, grounding: cites.length ? "MATERIAL" : "GENERAL" };
    })
    .filter((c): c is PackConcept => !!c);
  const list = (xs: string[] | undefined) => xs?.map((x) => clean(x, 400)).filter(Boolean);
  return {
    title: clean(raw.title, 200) || fallbackTitle,
    sections,
    ...(concepts?.length ? { concepts } : {}),
    ...(list(raw.questions)?.length ? { questions: list(raw.questions) } : {}),
    ...(list(raw.pitfalls)?.length ? { pitfalls: list(raw.pitfalls) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Storage and generation
// ---------------------------------------------------------------------------

export async function ownedTopic(studentId: number, topicId: string): Promise<CoachTopicRow> {
  const [topic] = await requireDb()
    .select()
    .from(coachTopics)
    .where(and(eq(coachTopics.id, topicId), eq(coachTopics.studentId, studentId)))
    .limit(1);
  if (!topic) throw new AppError("NOT_FOUND");
  return topic;
}

export async function topicChunks(topicId: string): Promise<CoachChunkRow[]> {
  return requireDb().select().from(coachChunks).where(eq(coachChunks.topicId, topicId)).orderBy(asc(coachChunks.ord));
}

function artifactView(row: CoachArtifactRow, stale: boolean) {
  return { id: row.id, kind: row.kind, locale: row.locale, content: row.content, edited: row.edited, revision: row.revision, updatedAt: row.updatedAt, stale };
}
export type ArtifactView = ReturnType<typeof artifactView>;

async function findArtifact(topicId: string, kind: ArtifactKind, locale: CoachLocale) {
  const [row] = await requireDb()
    .select()
    .from(coachArtifacts)
    .where(and(eq(coachArtifacts.topicId, topicId), eq(coachArtifacts.kind, kind), eq(coachArtifacts.locale, locale)))
    .limit(1);
  return row ?? null;
}

/** The cached pack in this language; `stale` when the text changed since (an edited pack is kept but flagged). */
export async function getPack(studentId: number, topicId: string, format: SummaryFormat, locale: CoachLocale) {
  const topic = await ownedTopic(studentId, topicId);
  const kind = SUMMARY_KIND[format];
  const row = await findArtifact(topic.id, kind, locale);
  if (!row) return null;
  const hash = packInputHash({ kind, locale, chunks: await topicChunks(topic.id) });
  const stale = row.inputHash !== hash;
  if (stale && !row.edited) return null;
  await logEvent(studentId, "PACK_OPENED", row.id, { kind, locale });
  return artifactView(row, stale);
}

const running = new Set<string>();

export async function generatePack(studentId: number, topicId: string, format: SummaryFormat, locale: CoachLocale) {
  await assertNotInExam(studentId);
  const topic = await ownedTopic(studentId, topicId);
  const material = await ownedMaterial(studentId, topic.materialId);
  if (material.status !== "READY") throw new AppError("COACH_NOT_READY");
  const kind = SUMMARY_KIND[format];
  const key = `${topic.id}:${kind}:${locale}`;
  if (running.has(key)) throw new AppError("COACH_BUSY");
  const chunks = await topicChunks(topic.id);
  if (!chunks.length || chunks.reduce((n, c) => n + c.text.trim().length, 0) < 80) throw new AppError("COACH_NOT_ENOUGH_CONTENT");
  await assertCoachAiAllowed(studentId);
  running.add(key);
  try {
    const selected = selectChunks(chunks, `${topic.title} ${chunks.map((c) => c.heading).join(" ")}`, PACK_MAX_CHARS);
    const { prompt, byLabel } = promptChunks(selected);
    const { main } = await coachModels();
    const { data, model } = await withCoachAi(studentId, "COACH_SUMMARY", () =>
      generateStructured({
        model: main,
        messages: packMessages({ format, topicTitle: topic.title, chunks: prompt, locale, nonce: randomBytes(4).toString("hex") }),
        schema: packSchema,
        jsonSchema: packJsonSchema,
        maxTokens: format === "SHORT" ? 4096 : 8192,
        timeoutMs: 120_000,
      }),
    );
    const content = finishPack(data, byLabel, topic.title);
    if (!content.sections.length) throw new AppError("AI_INVALID_OUTPUT");
    const inputHash = packInputHash({ kind, locale, chunks });
    const existing = await findArtifact(topic.id, kind, locale);
    if (existing) {
      await requireDb()
        .update(coachArtifacts)
        .set({ content, inputHash, model, edited: false, revision: existing.revision + 1 })
        .where(eq(coachArtifacts.id, existing.id));
    } else {
      await requireDb().insert(coachArtifacts).values({ id: nanoid(), materialId: topic.materialId, topicId: topic.id, studentId, kind, locale, inputHash, content, model });
    }
    const row = (await findArtifact(topic.id, kind, locale))!;
    return artifactView(row, false);
  } finally {
    running.delete(key);
  }
}

/** The student rewrites one point or concept in their own words. */
export async function editPack(studentId: number, input: { artifactId: string; section?: number; point?: number; concept?: number; text: string }) {
  const [row] = await requireDb()
    .select()
    .from(coachArtifacts)
    .where(and(eq(coachArtifacts.id, input.artifactId), eq(coachArtifacts.studentId, studentId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  const text = clean(input.text, 800);
  if (!text) throw new AppError("COACH_NOT_ENOUGH_CONTENT");
  const content = applyEdit(row.content, input, text);
  if (!content) throw new AppError("NOT_FOUND");
  await requireDb().update(coachArtifacts).set({ content, edited: true, revision: row.revision + 1 }).where(eq(coachArtifacts.id, row.id));
  await logEvent(studentId, "PACK_EDITED", row.id);
  return { ok: true as const };
}

/** Pure: the content with one point text or concept definition replaced; null when the target does not exist. */
export function applyEdit(content: ArtifactContent, at: { section?: number; point?: number; concept?: number }, text: string): ArtifactContent | null {
  if (at.concept !== undefined) {
    const c = content.concepts?.[at.concept];
    if (!c) return null;
    return { ...content, concepts: content.concepts!.map((x, i) => (i === at.concept ? { ...x, definition: text } : x)) };
  }
  if (at.section === undefined || at.point === undefined) return null;
  const s = content.sections[at.section];
  if (!s?.points[at.point]) return null;
  return {
    ...content,
    sections: content.sections.map((sec, i) => (i === at.section ? { ...sec, points: sec.points.map((p, j) => (j === at.point ? { ...p, text } : p)) } : sec)),
  };
}

/** The topic page header: the topic, its material and its neighbours. */
export async function topicDetail(studentId: number, topicId: string) {
  const topic = await ownedTopic(studentId, topicId);
  const material = await ownedMaterial(studentId, topic.materialId);
  const siblings = await requireDb().select({ id: coachTopics.id, ord: coachTopics.ord, title: coachTopics.title }).from(coachTopics).where(eq(coachTopics.materialId, material.id)).orderBy(asc(coachTopics.ord));
  const at = siblings.findIndex((s) => s.id === topic.id);
  return {
    topic: { id: topic.id, ord: topic.ord, title: topic.title, pageFrom: topic.pageFrom, pageTo: topic.pageTo },
    material: { id: material.id, title: material.title, goal: material.goal, needsReview: material.needsReview },
    prev: siblings[at - 1] ?? null,
    next: siblings[at + 1] ?? null,
  };
}

/** Chunk text of the cited passages, for the "show in material" view. */
export async function citedChunks(studentId: number, chunkIds: string[]) {
  if (!chunkIds.length) return [];
  const rows = await requireDb()
    .select({ id: coachChunks.id, pageFrom: coachChunks.pageFrom, pageTo: coachChunks.pageTo, heading: coachChunks.heading, text: coachChunks.text })
    .from(coachChunks)
    .where(and(eq(coachChunks.studentId, studentId), inArray(coachChunks.id, chunkIds.slice(0, 10))));
  return rows;
}

onMaterialDelete(async (ids) => void (await requireDb().delete(coachArtifacts).where(inArray(coachArtifacts.materialId, ids))));
onMaterialTextChange(async (materialId, topicIds) => {
  if (!topicIds.length) return;
  await requireDb()
    .delete(coachArtifacts)
    .where(and(eq(coachArtifacts.materialId, materialId), inArray(coachArtifacts.topicId, topicIds), eq(coachArtifacts.edited, false)));
});
