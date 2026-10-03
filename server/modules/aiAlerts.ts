import { eq } from "drizzle-orm";
import { providerWorkspaces, users } from "../../drizzle/schema";
import { fillTemplate, serverLocale, type ServerLocale } from "../_core/locale";
import { llmFailureReason } from "../_core/llm";
import { requireDb } from "../db";
import { notifyOnce } from "./notifications";

/**
 * In-app alerts to a workspace owner about AI pre-review: nearing / hitting the daily cap, and the
 * provider rejecting the key or the quota. Deduped per workspace so a busy day sends each once.
 */

export const AI_USAGE_WARN_RATIO = 0.8;
const HOUR_MS = 60 * 60 * 1000;

export type AiAlertKind = "USAGE_80" | "LIMIT_REACHED" | "PROVIDER_AUTH" | "PROVIDER_QUOTA";

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

/** Key rejected or quota / rate limit hit; anything else is not worth an alert. */
export function providerAlertFor(error: unknown): "PROVIDER_AUTH" | "PROVIDER_QUOTA" | null {
  const reason = llmFailureReason(error);
  if (reason === "AI_KEY_INVALID") return "PROVIDER_AUTH";
  if (reason === "AI_QUOTA") return "PROVIDER_QUOTA";
  return null;
}

const TEXT: Record<ServerLocale, Record<AiAlertKind, { title: string; body: string }>> = {
  az: {
    USAGE_80: {
      title: "AI yoxlama limitinin 80%-i istifadə olunub",
      body: "{workspace}: bu gün {used}/{limit} AI yoxlama istifadə edildi. Limit dolanda yeni təhvillər AI ilə yoxlanmayacaq.",
    },
    LIMIT_REACHED: {
      title: "AI yoxlama bu gün dayandı, sabah yenilənəcək",
      body: "{workspace}: gündəlik limit ({limit}) doldu. Avtomatik yoxlamalar işləyir; AI yoxlaması 24 saat ərzində yenidən açılacaq.",
    },
    PROVIDER_AUTH: {
      title: "AI xidməti API açarını qəbul etmədi",
      body: "{workspace}: AI provayderi açarı rədd etdi — açar yanlışdır və ya ləğv edilib. AI_API_KEY dəyərini yoxlayın.",
    },
    PROVIDER_QUOTA: {
      title: "AI xidmətinin limiti bitib",
      body: "{workspace}: AI provayderi 429 xətası qaytardı — hesabın kvotası bitib və ya sorğu limiti aşılıb. AI yoxlamaları müvəqqəti işləmir.",
    },
  },
  en: {
    USAGE_80: {
      title: "80% of today's AI checks used",
      body: "{workspace}: {used} of {limit} AI checks used today. New submissions won't be AI-checked once the limit is reached.",
    },
    LIMIT_REACHED: {
      title: "AI checks stopped for today; they resume tomorrow",
      body: "{workspace}: the daily limit ({limit}) is used up. Automatic checks keep running; AI checks resume within 24 hours.",
    },
    PROVIDER_AUTH: {
      title: "The AI service rejected the API key",
      body: "{workspace}: the AI provider rejected the key — it is invalid or revoked. Check AI_API_KEY.",
    },
    PROVIDER_QUOTA: {
      title: "AI service quota exhausted",
      body: "{workspace}: the AI provider returned 429 — the account quota is used up or the rate limit was exceeded. AI checks are paused for now.",
    },
  },
  ru: {
    USAGE_80: {
      title: "Использовано 80% дневного лимита проверок ИИ",
      body: "{workspace}: сегодня использовано {used} из {limit} проверок ИИ. После достижения лимита новые работы не будут проверяться ИИ.",
    },
    LIMIT_REACHED: {
      title: "Проверка ИИ на сегодня остановлена, завтра возобновится",
      body: "{workspace}: дневной лимит ({limit}) исчерпан. Автоматические проверки работают; проверка ИИ возобновится в течение 24 часов.",
    },
    PROVIDER_AUTH: {
      title: "Сервис ИИ отклонил API-ключ",
      body: "{workspace}: провайдер ИИ отклонил ключ — он неверный или отозван. Проверьте AI_API_KEY.",
    },
    PROVIDER_QUOTA: {
      title: "Исчерпан лимит сервиса ИИ",
      body: "{workspace}: провайдер ИИ вернул ошибку 429 — квота аккаунта исчерпана или превышен лимит запросов. Проверки ИИ временно недоступны.",
    },
  },
};

export function aiAlertText(locale: ServerLocale, kind: AiAlertKind, values: { workspace: string; used?: number; limit?: number }) {
  const t = TEXT[locale][kind];
  const v = { workspace: values.workspace, used: values.used ?? 0, limit: values.limit ?? 0 };
  return { title: fillTemplate(t.title, v), body: fillTemplate(t.body, v) };
}

/** Notifies the workspace owner unless the same alert went out within its window; never throws. */
export async function sendAiAlert(workspaceId: string, kind: AiAlertKind, values: { used?: number; limit?: number } = {}) {
  try {
    const [owner] = await requireDb()
      .select({ userId: providerWorkspaces.ownerUserId, workspace: providerWorkspaces.title, locale: users.preferredLocale })
      .from(providerWorkspaces)
      .innerJoin(users, eq(users.id, providerWorkspaces.ownerUserId))
      .where(eq(providerWorkspaces.id, workspaceId))
      .limit(1);
    if (!owner) return;
    const { title, body } = aiAlertText(serverLocale(owner.locale), kind, { workspace: owner.workspace, ...values });
    await notifyOnce(owner.userId, `ai:${kind}:${workspaceId}`, AI_ALERT_WINDOW_MS[kind], title.slice(0, 255), body);
  } catch (error) {
    console.error("[aiAlerts] could not notify", kind, error instanceof Error ? error.message : error);
  }
}
