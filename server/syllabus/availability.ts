import { and, eq } from "drizzle-orm";
import { featureFlagOverrides, featureFlags } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { isMissingTable } from "../notifications/preferences";

/**
 * Feature flag for Syllabus. Off unless one of these turns it on for a workspace:
 *   1. env SYLLABUS_ENABLED_WORKSPACES — comma-separated workspace ids, or "*";
 *   2. a `feature_flag_overrides` row (flagKey SYLLABUS, scopeType WORKSPACE) — the admin toggle;
 *   3. a global `feature_flags` row (key SYLLABUS, enabled = 1).
 * An override row with enabled = 0 turns a workspace off even when the global flag is on; the env
 * list always wins. Missing tables mean "off" for 2 and 3, never an error.
 */

export const SYLLABUS_FLAG = "SYLLABUS";
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: boolean }>();

export function envEnables(workspaceId: string, list: readonly string[] = ENV.syllabusEnabledWorkspaces) {
  return list.includes("*") || list.includes(workspaceId);
}

async function dbEnables(workspaceId: string): Promise<boolean> {
  const db = requireDb();
  try {
    const [override] = await db
      .select({ enabled: featureFlagOverrides.enabled })
      .from(featureFlagOverrides)
      .where(and(eq(featureFlagOverrides.flagKey, SYLLABUS_FLAG), eq(featureFlagOverrides.scopeType, "WORKSPACE"), eq(featureFlagOverrides.scopeId, workspaceId)))
      .limit(1);
    if (override) return override.enabled;
    const [global] = await db.select({ enabled: featureFlags.enabled }).from(featureFlags).where(eq(featureFlags.key, SYLLABUS_FLAG)).limit(1);
    return global?.enabled ?? false;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

export async function syllabusEnabledFor(workspaceId: string): Promise<boolean> {
  if (envEnables(workspaceId)) return true;
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await dbEnables(workspaceId);
  cache.set(workspaceId, { at: Date.now(), value });
  return value;
}

export async function assertSyllabusEnabled(workspaceId: string) {
  if (!(await syllabusEnabledFor(workspaceId))) throw new AppError("SYLLABUS_NOT_AVAILABLE");
}

export function clearAvailabilityCache(workspaceId?: string) {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

/** Admin toggle: writes the workspace override row. */
export async function setWorkspaceEnabled(workspaceId: string, enabled: boolean, actorUserId: number) {
  const db = requireDb();
  const before = await syllabusEnabledFor(workspaceId);
  await db
    .insert(featureFlagOverrides)
    .values({ flagKey: SYLLABUS_FLAG, scopeType: "WORKSPACE", scopeId: workspaceId, enabled, createdBy: actorUserId })
    .onDuplicateKeyUpdate({ set: { enabled, createdBy: actorUserId } });
  clearAvailabilityCache(workspaceId);
  return { before, after: await syllabusEnabledFor(workspaceId), envForced: envEnables(workspaceId) };
}

/**
 * The database is behind the code: a syllabus table (1146) or column (1054) does not exist yet,
 * i.e. a migration has not been applied. `db:verify` keeps schema and migrations in step, so in
 * practice these errors only mean "deploy has not migrated yet".
 */
export function isSchemaBehind(error: unknown): boolean {
  if (isMissingTable(error)) return true;
  let e = error as { errno?: number; code?: string; cause?: unknown } | undefined;
  for (let i = 0; e && i < 5; i++) {
    if (e.errno === 1054 || e.code === "ER_BAD_FIELD_ERROR") return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Syllabus tables not migrated yet → a stable "database not ready" error instead of a 500. */
export async function guardTables<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isSchemaBehind(error)) throw new AppError("SYLLABUS_DB_NOT_READY");
    throw error;
  }
}
