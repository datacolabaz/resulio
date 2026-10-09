import { inArray } from "drizzle-orm";
import { z } from "zod";
import { platformSettings } from "../drizzle/schema";
import { requireDb, type DbOrTx } from "./db";

/**
 * Admin-set values kept in platform_settings. A missing row means the default below. Secrets never
 * go here: API keys and storage credentials stay in the environment (Railway variables).
 */
const nullableCount = z.number().int().min(0).nullable();
export const PLATFORM_SETTINGS = {
  /** Estimated AI spend per month the admin plans for (USD); null = no budget set. */
  "ai.monthlyBudgetUsd": z.number().min(0).max(1_000_000).nullable(),
  /** Global default per-teacher limits; null or 0 = unlimited (see shared/aiUsage.ts). */
  "ai.defaultMonthlyTokenQuota": nullableCount,
  "ai.defaultDailyRequestCap": nullableCount,
  /** Soft storage quota shown on the storage page (bytes); null = none. Nothing is refused at it. */
  "storage.softQuotaBytes": nullableCount,
} as const;
export type PlatformSettingKey = keyof typeof PLATFORM_SETTINGS;
export type PlatformSettings = { [K in PlatformSettingKey]: z.infer<(typeof PLATFORM_SETTINGS)[K]> };

export const SETTING_DEFAULTS: PlatformSettings = {
  "ai.monthlyBudgetUsd": null,
  "ai.defaultMonthlyTokenQuota": null,
  "ai.defaultDailyRequestCap": null,
  "storage.softQuotaBytes": null,
};

const KEYS = Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[];
const CACHE_MS = 30_000;
let cache: { at: number; value: PlatformSettings } | null = null;

export function parseSettings(rows: Array<{ key: string; value: unknown }>): PlatformSettings {
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    const schema = PLATFORM_SETTINGS[row.key as PlatformSettingKey];
    if (!schema) continue;
    const parsed = schema.safeParse(row.value);
    if (parsed.success) out[row.key] = parsed.data;
  }
  return out as PlatformSettings;
}

/** Cached for 30 s per process; `fresh` skips the cache (admin reads and audit diffs). */
export async function getPlatformSettings({ fresh = false }: { fresh?: boolean } = {}): Promise<PlatformSettings> {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < CACHE_MS) return cache.value;
  const rows = await requireDb().select({ key: platformSettings.key, value: platformSettings.value }).from(platformSettings).where(inArray(platformSettings.key, KEYS));
  const value = parseSettings(rows);
  cache = { at: now, value };
  return value;
}

/** Writes the given keys (inside the caller's transaction, next to its audit row). */
export async function writePlatformSettings(tx: DbOrTx, patch: Partial<PlatformSettings>, updatedBy: number) {
  for (const [key, value] of Object.entries(patch)) {
    const schema = PLATFORM_SETTINGS[key as PlatformSettingKey];
    if (!schema) continue;
    const parsed = schema.parse(value);
    await tx.insert(platformSettings).values({ key, value: parsed, updatedBy }).onDuplicateKeyUpdate({ set: { value: parsed, updatedBy } });
  }
  cache = null;
}

export function clearSettingsCache() {
  cache = null;
}
