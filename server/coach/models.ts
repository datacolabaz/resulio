import { ENV } from "../_core/env";
import { getPlatformSettings } from "../platformSettings";

/**
 * Model routing. main: summaries, questions, tutor, first-pass grading; lite: cheap tasks (topic
 * names, segmentation); pro: only hard open-answer grading; ocr: reading scanned pages and images.
 * Order: platform_settings `coach.models` (switches at once) → COACH_* env vars → AI_MODEL.
 */
export interface CoachModels {
  main: string;
  lite: string;
  pro: string;
  ocr: string;
}
export type CoachModelRole = keyof CoachModels;

export function resolveCoachModels(env: Partial<CoachModels>, override: Partial<CoachModels> | null, fallback: string): CoachModels {
  const pick = (k: CoachModelRole) => override?.[k]?.trim() || env[k]?.trim() || "";
  const main = pick("main") || fallback;
  return { main, lite: pick("lite") || main, pro: pick("pro") || main, ocr: pick("ocr") || main };
}

export async function coachModels(): Promise<CoachModels> {
  let override: Partial<CoachModels> | null = null;
  try {
    override = (await getPlatformSettings())["coach.models"];
  } catch {
    override = null;
  }
  return resolveCoachModels({ main: ENV.coachModel, lite: ENV.coachLiteModel, pro: ENV.coachProModel, ocr: ENV.coachOcrModel }, override, ENV.llm.model);
}
