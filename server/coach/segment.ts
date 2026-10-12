import { z } from "zod";
import type { CoachLocale } from "../../shared/coach";
import type { Message } from "../_core/llm";
import { clip, sanitizeForPrompt } from "../modules/aiContext";
import { DATA_RULE, languageRule } from "./ai";
import { titleFromText, type DraftChunk } from "./chunker";

/**
 * Topics of a material: consecutive chunk ranges with a title. The lite model proposes them from
 * an outline (headings + first lines); `normalizeTopics` keeps only a valid, ordered cover of all
 * chunks, and `fallbackTopics` builds one from headings when the model is unavailable.
 */

export const MAX_TOPICS = 30;
const FALLBACK_CHUNKS_PER_TOPIC = 6;

export interface DraftTopic {
  ord: number;
  title: string;
  /** First and last chunk ord, inclusive. */
  from: number;
  to: number;
  pageFrom: number;
  pageTo: number;
}

export const segmentSchema = z.object({
  topics: z.array(z.object({ title: z.string(), firstChunk: z.number() })).max(80),
});
export const segmentJsonSchema = {
  name: "coach_topics",
  schema: {
    type: "object",
    properties: {
      topics: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, firstChunk: { type: "integer" } }, required: ["title", "firstChunk"] },
      },
    },
    required: ["topics"],
  },
};

export function outlineOf(chunks: DraftChunk[]): string {
  return chunks
    .map((c) => `#${c.ord} (p.${c.pageFrom}${c.pageTo !== c.pageFrom ? `-${c.pageTo}` : ""})${c.heading ? ` [${sanitizeForPrompt(c.heading).slice(0, 100)}]` : ""}: ${clip(sanitizeForPrompt(c.text.replace(/\s+/g, " ")), 160).text}`)
    .join("\n");
}

export function segmentMessages(chunks: DraftChunk[], locale: CoachLocale): Message[] {
  return [
    {
      role: "system",
      content: [
        "You split a student's study material into its main topics.",
        `Return JSON {"topics":[{"title","firstChunk"}]}: consecutive topics in reading order; the first starts at chunk 0; each topic starts where the previous ends. Between 1 and ${MAX_TOPICS} topics; prefer the material's own sections; a topic usually spans several chunks.`,
        "Titles: short (2-8 words), specific, no numbering.",
        languageRule(locale),
        DATA_RULE,
      ].join("\n"),
    },
    { role: "user", content: `Chunks (#ord, pages, [heading]: first words):\n${outlineOf(chunks)}` },
  ];
}

function withPages(topics: Omit<DraftTopic, "pageFrom" | "pageTo">[], chunks: DraftChunk[]): DraftTopic[] {
  return topics.map((t) => ({ ...t, pageFrom: chunks[t.from].pageFrom, pageTo: chunks[t.to].pageTo }));
}

/** A valid ordered cover of chunks 0..n-1, or null when the model's answer cannot be used. */
export function normalizeTopics(raw: { title: string; firstChunk: number }[], chunks: DraftChunk[]): DraftTopic[] | null {
  const n = chunks.length;
  if (!n) return null;
  const starts = new Map<number, string>();
  for (const t of raw) {
    const at = Math.trunc(Number(t.firstChunk));
    const title = t.title.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!Number.isFinite(at) || at < 0 || at >= n || !title || starts.has(at)) continue;
    starts.set(at, title);
  }
  if (!starts.size) return null;
  if (!starts.has(0)) {
    const firstAt = Math.min(...starts.keys());
    starts.set(0, starts.get(firstAt)!);
    starts.delete(firstAt);
  }
  let ordered = [...starts.entries()].sort((a, b) => a[0] - b[0]);
  if (ordered.length > MAX_TOPICS) ordered = ordered.slice(0, MAX_TOPICS);
  return withPages(
    ordered.map(([from, title], i) => ({ ord: i, title, from, to: i + 1 < ordered.length ? ordered[i + 1][0] - 1 : n - 1 })),
    chunks,
  );
}

/** Topics from headings (a new heading opens a topic), else fixed groups of chunks. */
export function fallbackTopics(chunks: DraftChunk[]): DraftTopic[] {
  if (!chunks.length) return [];
  const starts: { from: number; title: string }[] = [];
  chunks.forEach((c, i) => {
    const prev = chunks[i - 1];
    if (i === 0 || (c.heading && c.heading !== prev?.heading)) starts.push({ from: i, title: c.heading || titleFromText(c.text) });
  });
  const useful = starts.length >= 2 && starts.length <= MAX_TOPICS;
  const plan = useful
    ? starts
    : Array.from({ length: Math.ceil(chunks.length / FALLBACK_CHUNKS_PER_TOPIC) }, (_, k) => {
        const from = k * FALLBACK_CHUNKS_PER_TOPIC;
        return { from, title: chunks[from].heading || titleFromText(chunks[from].text) };
      }).slice(0, MAX_TOPICS);
  return withPages(
    plan.map((s, i) => ({ ord: i, title: (s.title || `#${i + 1}`).slice(0, 200), from: s.from, to: i + 1 < plan.length ? plan[i + 1].from - 1 : chunks.length - 1 })),
    chunks,
  );
}
