import { z } from "zod";
import type { CoachLocale } from "../../shared/coach";
import type { Message } from "../_core/llm";
import { clip, sanitizeForPrompt } from "../modules/aiContext";
import { DATA_RULE, languageRule } from "./ai";
import type { DraftChunk } from "./chunker";
import { AI_TITLE_MAX_WORDS, balanceTopics, finishTitles, type TopicStart } from "./structure";

/**
 * Topics of a material: consecutive chunk ranges with a title. The lite model proposes them from
 * an outline (headings + first lines); `normalizeTopics` keeps only a valid, ordered cover of all
 * chunks, and `fallbackTopics` builds one from headings when the model is unavailable.
 */

export const MAX_TOPICS = 30;
/** Without usable headings a topic is about this many pages. */
export const FALLBACK_PAGES_PER_TOPIC = 8;

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

export const titlesSchema = z.object({ titles: z.array(z.object({ n: z.number(), title: z.string() })).max(80) });
export const titlesJsonSchema = {
  name: "coach_topic_titles",
  schema: {
    type: "object",
    properties: { titles: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, title: { type: "string" } }, required: ["n", "title"] } } },
    required: ["titles"],
  },
};

/** One short title per topic that has no heading of its own, from the start of its text. */
export function titleMessages(topics: { n: number; text: string }[], locale: CoachLocale): Message[] {
  return [
    {
      role: "system",
      content: [
        `Give each numbered study-text excerpt a short topic title: at most ${AI_TITLE_MAX_WORDS} words, a noun phrase naming what it teaches (like a textbook heading), in sentence case, no numbering, no ending punctuation.`,
        'Never copy or cut a sentence of the excerpt, never use a person\'s name. Return JSON {"titles":[{"n","title"}]} with one entry per excerpt.',
        languageRule(locale),
        DATA_RULE,
      ].join("\n"),
    },
    { role: "user", content: topics.map((t) => `#${t.n}: ${clip(sanitizeForPrompt(t.text.replace(/\s+/g, " ")), 600).text}`).join("\n\n") },
  ];
}

/** Headings plus the first words of each chunk; shorter lines for long materials so the one lite call stays quick. */
export function outlineOf(chunks: DraftChunk[]): string {
  const words = chunks.length > 300 ? 50 : chunks.length > 120 ? 90 : 160;
  return chunks
    .map((c) => `#${c.ord} (p.${c.pageFrom}${c.pageTo !== c.pageFrom ? `-${c.pageTo}` : ""})${c.heading ? ` [${sanitizeForPrompt(c.heading).slice(0, 100)}]` : ""}: ${clip(sanitizeForPrompt(c.text.replace(/\s+/g, " ")), words).text}`)
    .join("\n");
}

export function segmentMessages(chunks: DraftChunk[], locale: CoachLocale, pages: { min: number; max: number } = { min: 2, max: 6 }): Message[] {
  const size = pages.max > 0 ? `Aim for topics of about ${Math.max(1, pages.min)}-${pages.max} pages: split a long section at its sub-headings, join very short neighbouring sections.` : "";
  return [
    {
      role: "system",
      content: [
        "You split a student's study material into its main topics.",
        `Return JSON {"topics":[{"title","firstChunk"}]}: consecutive topics in reading order; the first starts at chunk 0; each topic starts where the previous ends. Between 1 and ${MAX_TOPICS} topics; prefer the material's own sections; a topic usually spans several chunks.`,
        size,
        "Titles: short (2-8 words), specific, in sentence case (not ALL CAPS), no numbering. Name what the section teaches; never use a person's name (author, lecturer), a course code or a university as a title.",
        languageRule(locale),
        DATA_RULE,
      ]
        .filter(Boolean)
        .join("\n"),
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

/** Keeps a start only when the previous kept one is at least `minPages` pages back. */
function spaced(starts: { from: number; title: string }[], chunks: DraftChunk[], minPages: number) {
  const kept: typeof starts = [];
  for (const s of starts) {
    const prev = kept.at(-1);
    if (!prev || chunks[s.from].pageFrom - chunks[prev.from].pageFrom >= minPages) kept.push(s);
  }
  return kept;
}

/**
 * Topics without AI: a new heading opens a topic (headings closer than a fair share of the pages
 * are merged when there are too many), else groups of ~FALLBACK_PAGES_PER_TOPIC pages.
 */
export function fallbackTopics(chunks: DraftChunk[]): DraftTopic[] {
  if (!chunks.length) return [];
  const pageSpan = chunks.at(-1)!.pageTo - chunks[0].pageFrom + 1;
  const starts: { from: number; title: string }[] = [];
  chunks.forEach((c, i) => {
    const prev = chunks[i - 1];
    if (i === 0 || (c.heading && c.heading !== prev?.heading)) starts.push({ from: i, title: c.heading });
  });
  let byHeadings = starts;
  for (let minPages = Math.ceil(pageSpan / MAX_TOPICS); byHeadings.length > MAX_TOPICS; minPages++) byHeadings = spaced(starts, chunks, minPages);
  let plan = byHeadings;
  if (byHeadings.length < 2) {
    const perTopic = Math.max(FALLBACK_PAGES_PER_TOPIC, Math.ceil(pageSpan / MAX_TOPICS));
    const groups = spaced(chunks.map((c, i) => ({ from: i, title: c.heading })), chunks, perTopic);
    plan = groups.length ? groups : [{ from: 0, title: "" }];
  }
  // No heading: no title here (never the first words of the text); a short one is asked for later.
  return withPages(
    plan.map((s, i) => ({ ord: i, title: s.title.slice(0, 200), from: s.from, to: i + 1 < plan.length ? plan[i + 1].from - 1 : chunks.length - 1 })),
    chunks,
  );
}

export const startsOf = (topics: Pick<DraftTopic, "from" | "title">[]): TopicStart[] => topics.map((t) => ({ from: t.from, title: t.title }));

export interface TopicPlan {
  locale: CoachLocale;
  /** How the material writes its words mid-sentence (`casingHints`). */
  hints: Map<string, string>;
  /** Names from the title page (the author). */
  names: string[];
  /** `coach.limits.topicMinPages` / `topicMaxPages`; 0 = no merging / no splitting. */
  minPages: number;
  maxPages: number;
}

/** Whatever proposed the starts (table of contents, model, headings): readable titles, then balanced lengths. */
export function finishTopics(starts: TopicStart[], chunks: DraftChunk[], plan: TopicPlan): DraftTopic[] {
  if (!chunks.length || !starts.length) return [];
  const titled = finishTitles(starts, chunks, plan);
  const balanced = balanceTopics(titled, chunks, { minPages: plan.minPages, maxPages: plan.maxPages, maxTopics: MAX_TOPICS, locale: plan.locale, hints: plan.hints });
  return withPages(
    balanced.map((s, i) => ({ ord: i, title: s.title.slice(0, 200), from: s.from, to: i + 1 < balanced.length ? balanced[i + 1].from - 1 : chunks.length - 1 })),
    chunks,
  );
}
