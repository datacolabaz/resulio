/**
 * Growth Engine (risk radar, weakness map, review plan) — shared constants. See docs/GROWTH-ENGINE.md.
 *
 * Topics are keyed by a canonical `topicKey` so analytics survive renames and free-text topics:
 *   "qt:<question_topics.id>"  a question bank section (the canonical topic),
 *   "tx:<nameKey>"             a free-text topic that no section matches yet,
 *   "sk:<nameKey>"             a skill (second dimension, free text only).
 * Items without any topic are summed under UNTAGGED_TOPIC_KEY; the teacher sees that count as a data-quality hint.
 */

export const GROWTH_DIMENSIONS = ["TOPIC", "SKILL"] as const;
export type GrowthDimension = (typeof GROWTH_DIMENSIONS)[number];

/** Where the evidence came from: a regular exam, a teacher-assigned retake, or a student's own practice. */
export const EVIDENCE_ORIGINS = ["EXAM", "RETAKE", "PRACTICE"] as const;
export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

export const SECTION_KEY_PREFIX = "qt:";
export const TEXT_KEY_PREFIX = "tx:";
export const SKILL_KEY_PREFIX = "sk:";

/** Items with no topic at all. Never shown as a topic and never used for mastery or risk. */
export const UNTAGGED_TOPIC_KEY = "";

export const sectionTopicKey = (sectionId: string) => `${SECTION_KEY_PREFIX}${sectionId}`;
export const isSectionKey = (key: string) => key.startsWith(SECTION_KEY_PREFIX);
export const isTextKey = (key: string) => key.startsWith(TEXT_KEY_PREFIX);
export const sectionIdOfKey = (key: string) => (isSectionKey(key) ? key.slice(SECTION_KEY_PREFIX.length) : null);

/** Longest canonical key: prefix + a 120-character name key. */
export const TOPIC_KEY_MAX = 128;
