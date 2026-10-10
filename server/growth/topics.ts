import { SKILL_KEY_PREFIX, TEXT_KEY_PREFIX, UNTAGGED_TOPIC_KEY, sectionTopicKey, type EvidenceOrigin, type GrowthDimension } from "../../shared/growth";
import type { ItemStatus } from "../../shared/assessment";
import { normalizeForMatch } from "../../shared/questionImport";

/**
 * Topic resolution, pure. A result item carries the topic text frozen at publish time; this maps it
 * onto one canonical key so a renamed section, two spellings of one topic and old free-text topics
 * all land in the same place. Order:
 *   1. the bank section the source question is filed in now;
 *   2. a teacher's alias of the frozen text (to a section, or just a label);
 *   3. the only section whose name matches the text;
 *   4. the text itself ("tx:<nameKey>");
 *   5. nothing (empty text) → null, counted as "untagged".
 */

export const topicNameKey = (text: string) => normalizeForMatch(text).slice(0, 120);

export interface CatalogSection {
  id: string;
  name: string;
  parentName: string | null;
}

export interface TopicAlias {
  aliasKey: string;
  label: string;
  questionTopicId: string | null;
}

export interface TopicCatalog {
  sections: Map<string, CatalogSection>;
  /** nameKey of a section name → ids of the sections with that name. */
  sectionsByName: Map<string, string[]>;
  aliases: Map<string, TopicAlias>;
}

export interface ResolvedTopic {
  topicKey: string;
  questionTopicId: string | null;
  label: string;
}

export function buildCatalog(sections: CatalogSection[], aliases: TopicAlias[]): TopicCatalog {
  const byName = new Map<string, string[]>();
  for (const s of sections) {
    const k = topicNameKey(s.name);
    if (!k) continue;
    byName.set(k, [...(byName.get(k) ?? []), s.id]);
  }
  return { sections: new Map(sections.map((s) => [s.id, s])), sectionsByName: byName, aliases: new Map(aliases.map((a) => [a.aliasKey, a])) };
}

export function sectionLabel(s: CatalogSection) {
  return s.parentName ? `${s.parentName} / ${s.name}` : s.name;
}

function fromSection(cat: TopicCatalog, id: string): ResolvedTopic | null {
  const s = cat.sections.get(id);
  return s ? { topicKey: sectionTopicKey(s.id), questionTopicId: s.id, label: sectionLabel(s) } : null;
}

export function resolveTopic(input: { filedSectionId: string | null; frozenTopic: string }, cat: TopicCatalog): ResolvedTopic | null {
  if (input.filedSectionId) {
    const hit = fromSection(cat, input.filedSectionId);
    if (hit) return hit;
  }
  const text = input.frozenTopic.trim();
  const key = topicNameKey(text);
  if (!key) return null;
  const alias = cat.aliases.get(key);
  if (alias?.questionTopicId) {
    const hit = fromSection(cat, alias.questionTopicId);
    if (hit) return hit;
  }
  if (alias) return { topicKey: `${TEXT_KEY_PREFIX}${key}`, questionTopicId: null, label: alias.label };
  const named = cat.sectionsByName.get(key);
  if (named?.length === 1) {
    const hit = fromSection(cat, named[0]);
    if (hit) return hit;
  }
  return { topicKey: `${TEXT_KEY_PREFIX}${key}`, questionTopicId: null, label: text.slice(0, 120) };
}

export function resolveSkill(frozenSkill: string): ResolvedTopic | null {
  const text = frozenSkill.trim();
  const key = topicNameKey(text);
  return key ? { topicKey: `${SKILL_KEY_PREFIX}${key}`, questionTopicId: null, label: text.slice(0, 120) } : null;
}

export interface GradedItemInput {
  status: ItemStatus;
  earned: number;
  points: number;
  topic: ResolvedTopic | null;
  skill: ResolvedTopic | null;
}

export interface TopicStatRow {
  dimension: GrowthDimension;
  topicKey: string;
  questionTopicId: string | null;
  label: string;
  questionCount: number;
  correctCount: number;
  wrongCount: number;
  unansweredCount: number;
  pendingCount: number;
  /** Graded points only: pending items add to neither side until they are graded. */
  earned: number;
  possible: number;
  wrongPoints: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One attempt's items, summed per topic and per skill. Earned points are per item, before the
 * exam's wrong-answer penalty (that is an exam-level rule, not a topic weakness); partial credit counts.
 */
export function buildTopicStats(items: GradedItemInput[]): TopicStatRow[] {
  const rows = new Map<string, TopicStatRow>();
  const add = (dimension: GrowthDimension, t: ResolvedTopic, item: GradedItemInput) => {
    const id = `${dimension}|${t.topicKey}`;
    const row = rows.get(id) ?? {
      dimension,
      topicKey: t.topicKey,
      questionTopicId: t.questionTopicId,
      label: t.label,
      questionCount: 0,
      correctCount: 0,
      wrongCount: 0,
      unansweredCount: 0,
      pendingCount: 0,
      earned: 0,
      possible: 0,
      wrongPoints: 0,
    };
    const points = Math.max(0, item.points);
    row.questionCount++;
    if (item.status === "PENDING_REVIEW") row.pendingCount++;
    else {
      row.possible += points;
      row.earned += Math.min(points, Math.max(0, item.earned));
      if (item.status === "CORRECT") row.correctCount++;
      else if (item.status === "WRONG") {
        row.wrongCount++;
        row.wrongPoints += points;
      } else row.unansweredCount++;
    }
    rows.set(id, row);
  };
  for (const item of items) {
    add("TOPIC", item.topic ?? UNTAGGED_TOPIC, item);
    if (item.skill) add("SKILL", item.skill, item);
  }
  return [...rows.values()].map((r) => ({ ...r, earned: round2(r.earned), possible: round2(r.possible), wrongPoints: round2(r.wrongPoints) }));
}

/** Items without a topic, kept as one row per result: the data-quality count, and the mark that the result was processed. */
export const UNTAGGED_TOPIC: ResolvedTopic = { topicKey: UNTAGGED_TOPIC_KEY, questionTopicId: null, label: "" };

/** Generated assessments are marked in assessment_origins; everything else is a regular exam. */
export const originOf = (origin: string | null | undefined): EvidenceOrigin => (origin === "RETAKE" || origin === "PRACTICE" ? origin : "EXAM");
