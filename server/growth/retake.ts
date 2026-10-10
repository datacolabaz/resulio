import type { Difficulty } from "../../shared/assessment";

/**
 * Picking a retake's questions, pure. Questions the student has not seen come first; topics take
 * turns so every chosen topic is covered; within that, difficulty follows a 30/50/20 easy/medium/hard
 * mix as far as the bank allows.
 */

export const RETAKE_MIX: Record<Difficulty, number> = { EASY: 0.3, MEDIUM: 0.5, HARD: 0.2 };
export const RETAKE_MIN = 3;
export const RETAKE_MAX = 30;

export interface RetakeCandidate {
  id: string;
  topicKey: string;
  difficulty: Difficulty;
  seen: boolean;
}

export function difficultyQuota(count: number): Record<Difficulty, number> {
  const easy = Math.round(count * RETAKE_MIX.EASY);
  const hard = Math.floor(count * RETAKE_MIX.HARD);
  return { EASY: easy, HARD: hard, MEDIUM: Math.max(0, count - easy - hard) };
}

function shuffled<T>(list: T[], rng: () => number) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pickRetakeQuestions(candidates: RetakeCandidate[], count: number, rng: () => number = Math.random): { ids: string[]; reusedSeen: number } {
  const unique = [...new Map(candidates.map((c) => [c.id, c])).values()];
  const byTopic = new Map<string, RetakeCandidate[]>();
  for (const c of shuffled(unique, rng)) byTopic.set(c.topicKey, [...(byTopic.get(c.topicKey) ?? []), c]);
  const quota = difficultyQuota(count);
  const picked: RetakeCandidate[] = [];
  const topics = [...byTopic.keys()];
  while (picked.length < count && topics.some((k) => byTopic.get(k)!.length)) {
    for (const k of topics) {
      if (picked.length >= count) break;
      const list = byTopic.get(k)!;
      if (!list.length) continue;
      const rank = (c: RetakeCandidate) => (c.seen ? 2 : 0) + (quota[c.difficulty] > 0 ? 0 : 1);
      let best = 0;
      for (let i = 1; i < list.length; i++) if (rank(list[i]) < rank(list[best])) best = i;
      const [c] = list.splice(best, 1);
      quota[c.difficulty]--;
      picked.push(c);
    }
  }
  return { ids: picked.map((c) => c.id), reusedSeen: picked.filter((c) => c.seen).length };
}
