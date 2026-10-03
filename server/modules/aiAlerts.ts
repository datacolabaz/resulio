import { eq } from "drizzle-orm";
import { providerWorkspaces } from "../../drizzle/schema";
import { LlmHttpError } from "../_core/llm";
import { requireDb } from "../db";
import { dispatch } from "../notifications/dispatcher";
import type { AiAlertKind } from "../notifications/templates";
import { claimOnce } from "./notifications";

export type { AiAlertKind } from "../notifications/templates";
export { aiAlertText } from "../notifications/templates";

/**
 * Alerts to a workspace owner about AI pre-review: nearing / hitting the daily cap, and the
 * provider rejecting the key or the quota. Deduped per workspace so a busy day sends each once.
 */

export const AI_USAGE_WARN_RATIO = 0.8;
const HOUR_MS = 60 * 60 * 1000;

export const AI_ALERT_WINDOW_MS: Record<AiAlertKind, number> = {
  USAGE_80: 24 * HOUR_MS,
  LIMIT_REACHED: 24 * HOUR_MS,
  PROVIDER_AUTH: 6 * HOUR_MS,
  PROVIDER_QUOTA: 6 * HOUR_MS,
};

/** Which usage alert applies once `used` reviews have been counted against `limit`. */
export function usageAlertFor(used: number, limit: number): "USAGE_80" | "LIMIT_REACHED" | null {
  if (used >= limit) return "LIMIT_REACHED";
  if (used >= Math.ceil(limit * AI_USAGE_WARN_RATIO)) return "USAGE_80";
  return null;
}

/** 401/403 = key rejected, 429 = quota or rate limit; anything else is not worth an alert. */
export function providerAlertFor(error: unknown): "PROVIDER_AUTH" | "PROVIDER_QUOTA" | null {
  if (!(error instanceof LlmHttpError)) return null;
  if (error.status === 401 || error.status === 403) return "PROVIDER_AUTH";
  if (error.status === 429) return "PROVIDER_QUOTA";
  return null;
}

/** Notifies the workspace owner unless the same alert went out within its window; never throws. */
export async function sendAiAlert(workspaceId: string, kind: AiAlertKind, values: { used?: number; limit?: number } = {}) {
  try {
    const [owner] = await requireDb()
      .select({ userId: providerWorkspaces.ownerUserId, workspace: providerWorkspaces.title })
      .from(providerWorkspaces)
      .where(eq(providerWorkspaces.id, workspaceId))
      .limit(1);
    if (!owner) return;
    const key = `ai:${kind}:${workspaceId}`;
    if (!(await claimOnce(owner.userId, key, AI_ALERT_WINDOW_MS[kind]))) return;
    const base = { userId: owner.userId, dedupeKey: `${key}:${Date.now()}` };
    const usage = { workspace: owner.workspace, used: values.used ?? 0, limit: values.limit ?? 0 };
    if (kind === "USAGE_80") dispatch({ ...base, event: "AI_LIMIT_80", data: usage });
    else if (kind === "LIMIT_REACHED") dispatch({ ...base, event: "AI_LIMIT_REACHED", data: usage });
    else dispatch({ ...base, event: "AI_PROVIDER_ERROR", data: { workspace: owner.workspace, problem: kind === "PROVIDER_AUTH" ? "AUTH" : "QUOTA" } });
  } catch (error) {
    console.error("[aiAlerts] could not notify", kind, error instanceof Error ? error.message : error);
  }
}
