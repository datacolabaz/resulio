import { and, desc, eq, gte, inArray, like, lt, or, sql, type SQL } from "drizzle-orm";
import { AI_PRICE_FALLBACK_MODEL, MICRO_USD, nextPeriodStart, periodStart, type AiCallStatus, type AiFeature } from "../../shared/aiUsage";
import { aiModelPrices, aiRequestLogs, aiTeacherLimits, files, providerWorkspaces, users } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { isGeminiUrl } from "../_core/aiConfig";
import { requireDb, type Tx } from "../db";
import { appendAudit } from "../modules/admin/audit";
import type { AdminContext } from "../modules/admin/authz";
import { AppError } from "../modules/errors";
import { getPlatformSettings, writePlatformSettings, type PlatformSettings } from "../platformSettings";
import { resolveLimits } from "./limits";
import { clearPriceCache } from "./pricing";

/** Admin views over ai_request_logs, prices, the budget and teacher limits. All costs are estimates. */

const n = (v: unknown) => Number(v ?? 0);
const usd = (micro: unknown) => n(micro) / MICRO_USD;
/** Calendar day in Baku time, for the daily chart. */
const bakuDay = sql<string>`date_format(date_add(${aiRequestLogs.createdAt}, interval 4 hour), '%Y-%m-%d')`;

/** The configured models, so the price table can show which ones are in use. */
export function configuredModels() {
  const base = ENV.llm.model;
  return [...new Set([base, ENV.questionImportModel, ENV.syllabusImportModel, ENV.aiReviewModel].map((m) => m.trim()).filter(Boolean))];
}

/** Month spend vs budget; the end-of-month projection extrapolates the pace so far. */
export function budgetView(spentUsd: number, budgetUsd: number | null, now: Date) {
  const start = periodStart("month", now).getTime();
  const end = nextPeriodStart("month", now).getTime();
  const elapsed = Math.min(1, Math.max((now.getTime() - start) / (end - start), 1 / 31));
  return {
    spentUsd,
    budgetUsd,
    ratio: budgetUsd ? spentUsd / budgetUsd : null,
    projectedUsd: spentUsd / elapsed,
    resetsAt: new Date(end),
  };
}

export async function aiMonthTotals(now = new Date()) {
  const [row] = await requireDb()
    .select({
      requests: sql<number>`count(*)`,
      tokens: sql<number>`coalesce(sum(${aiRequestLogs.totalTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${aiRequestLogs.costMicroUsd}), 0)`,
    })
    .from(aiRequestLogs)
    .where(gte(aiRequestLogs.createdAt, periodStart("month", now)));
  return { requests: n(row?.requests), tokens: n(row?.tokens), costUsd: usd(row?.cost) };
}

export async function aiAnalytics(now = new Date()) {
  const db = requireDb();
  const monthFrom = periodStart("month", now);
  const inMonth = gte(aiRequestLogs.createdAt, monthFrom);
  const measures = {
    requests: sql<number>`count(*)`,
    tokens: sql<number>`coalesce(sum(${aiRequestLogs.totalTokens}), 0)`,
    cost: sql<number>`coalesce(sum(${aiRequestLogs.costMicroUsd}), 0)`,
  };
  const [totals] = await db
    .select({
      ...measures,
      promptTokens: sql<number>`coalesce(sum(${aiRequestLogs.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${aiRequestLogs.completionTokens}), 0)`,
      errors: sql<number>`coalesce(sum(${aiRequestLogs.status} = 'ERROR'), 0)`,
      rateLimited: sql<number>`coalesce(sum(${aiRequestLogs.status} = 'RATE_LIMITED'), 0)`,
      estimated: sql<number>`coalesce(sum(${aiRequestLogs.tokensEstimated}), 0)`,
      avgLatencyMs: sql<number>`coalesce(avg(${aiRequestLogs.latencyMs}), 0)`,
    })
    .from(aiRequestLogs)
    .where(inMonth);
  const [previous] = await db
    .select({ cost: measures.cost })
    .from(aiRequestLogs)
    .where(and(gte(aiRequestLogs.createdAt, periodStart("month", new Date(monthFrom.getTime() - 1))), lt(aiRequestLogs.createdAt, monthFrom)));
  const byFeature = await db.select({ feature: aiRequestLogs.feature, ...measures }).from(aiRequestLogs).where(inMonth).groupBy(aiRequestLogs.feature);
  const byModel = await db.select({ model: aiRequestLogs.model, ...measures }).from(aiRequestLogs).where(inMonth).groupBy(aiRequestLogs.model);
  const daily = await db
    .select({ day: bakuDay, ...measures })
    .from(aiRequestLogs)
    .where(gte(aiRequestLogs.createdAt, new Date(periodStart("day", now).getTime() - 29 * 86_400_000)))
    .groupBy(bakuDay)
    .orderBy(bakuDay);
  const topUsers = await db
    .select({ userId: aiRequestLogs.userId, name: users.name, email: users.email, ...measures })
    .from(aiRequestLogs)
    .leftJoin(users, eq(users.id, aiRequestLogs.userId))
    .where(inMonth)
    .groupBy(aiRequestLogs.userId, users.name, users.email)
    .orderBy(desc(measures.cost), desc(measures.tokens))
    .limit(10);
  const settings = await getPlatformSettings();
  const row = (r: { requests: unknown; tokens: unknown; cost: unknown }) => ({ requests: n(r.requests), tokens: n(r.tokens), costUsd: usd(r.cost) });
  return {
    provider: { gemini: isGeminiUrl(ENV.llm.baseUrl), configured: ENV.llmConfigured, models: configuredModels() },
    month: {
      from: monthFrom,
      ...row(totals ?? { requests: 0, tokens: 0, cost: 0 }),
      promptTokens: n(totals?.promptTokens),
      completionTokens: n(totals?.completionTokens),
      errors: n(totals?.errors),
      rateLimited: n(totals?.rateLimited),
      estimated: n(totals?.estimated),
      avgLatencyMs: Math.round(n(totals?.avgLatencyMs)),
    },
    previousMonthCostUsd: usd(previous?.cost),
    budget: budgetView(usd(totals?.cost), settings["ai.monthlyBudgetUsd"], now),
    byFeature: byFeature.map((r) => ({ feature: r.feature, ...row(r) })).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    byModel: byModel.map((r) => ({ model: r.model, ...row(r) })).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    daily: daily.map((r) => ({ day: r.day, ...row(r) })),
    topUsers: topUsers.map((r) => ({ userId: r.userId, name: r.name, email: r.email, ...row(r) })),
  };
}

export async function listAiLogs(f: { before?: number; limit?: number; feature?: AiFeature; status?: AiCallStatus; userId?: number }) {
  const where: SQL[] = [];
  if (f.before !== undefined) where.push(lt(aiRequestLogs.id, f.before));
  if (f.feature) where.push(eq(aiRequestLogs.feature, f.feature));
  if (f.status) where.push(eq(aiRequestLogs.status, f.status));
  if (f.userId !== undefined) where.push(eq(aiRequestLogs.userId, f.userId));
  const rows = await requireDb()
    .select({ log: aiRequestLogs, name: users.name, email: users.email })
    .from(aiRequestLogs)
    .leftJoin(users, eq(users.id, aiRequestLogs.userId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(aiRequestLogs.id))
    .limit(Math.min(f.limit ?? 50, 200));
  return rows.map((r) => ({ ...r.log, costUsd: usd(r.log.costMicroUsd), userName: r.name, userEmail: r.email }));
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export async function listPrices(now = new Date()) {
  const db = requireDb();
  const rows = await db.select().from(aiModelPrices).orderBy(aiModelPrices.model);
  const seen = await db
    .selectDistinct({ model: aiRequestLogs.model })
    .from(aiRequestLogs)
    .where(gte(aiRequestLogs.createdAt, new Date(now.getTime() - 30 * 86_400_000)));
  const priced = new Set(rows.map((r) => r.model.toLowerCase()));
  const inUse = [...new Set([...configuredModels(), ...seen.map((s) => s.model).filter(Boolean)])];
  return { prices: rows, unpricedModels: inUse.filter((m) => !priced.has(m.toLowerCase())), configuredModels: configuredModels() };
}

export async function upsertPrice(admin: AdminContext, input: { model: string; inputUsdPerMillion: number; outputUsdPerMillion: number; note: string }) {
  const model = input.model.trim().toLowerCase();
  const result = await requireDb().transaction(async (tx) => {
    const [before] = await tx.select().from(aiModelPrices).where(eq(aiModelPrices.model, model)).for("update");
    const values = { inputUsdPerMillion: input.inputUsdPerMillion, outputUsdPerMillion: input.outputUsdPerMillion, note: input.note.trim(), updatedBy: admin.userId };
    if (before) await tx.update(aiModelPrices).set(values).where(eq(aiModelPrices.model, model));
    else await tx.insert(aiModelPrices).values({ model, ...values });
    await appendAudit(
      tx,
      admin,
      {
        action: "AI_PRICE_CHANGED",
        targetType: "AI_MODEL_PRICE",
        targetId: model.slice(0, 64),
        before: before ? { inputUsdPerMillion: before.inputUsdPerMillion, outputUsdPerMillion: before.outputUsdPerMillion } : null,
        after: { inputUsdPerMillion: values.inputUsdPerMillion, outputUsdPerMillion: values.outputUsdPerMillion },
      },
      admin.meta,
    );
    return { model, ...values };
  });
  clearPriceCache();
  return result;
}

export async function deletePrice(admin: AdminContext, model: string) {
  const key = model.trim().toLowerCase();
  if (key === AI_PRICE_FALLBACK_MODEL) throw new AppError("FORBIDDEN");
  await requireDb().transaction(async (tx) => {
    const [before] = await tx.select().from(aiModelPrices).where(eq(aiModelPrices.model, key)).for("update");
    if (!before) throw new AppError("NOT_FOUND");
    await tx.delete(aiModelPrices).where(eq(aiModelPrices.model, key));
    await appendAudit(
      tx,
      admin,
      { action: "AI_PRICE_DELETED", targetType: "AI_MODEL_PRICE", targetId: key.slice(0, 64), before: { inputUsdPerMillion: before.inputUsdPerMillion, outputUsdPerMillion: before.outputUsdPerMillion } },
      admin.meta,
    );
  });
  clearPriceCache();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Settings (budget, default limits, storage soft quota)
// ---------------------------------------------------------------------------

export async function updateSettings(admin: AdminContext, patch: Partial<PlatformSettings>) {
  const before = await getPlatformSettings({ fresh: true });
  const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => before[k as keyof PlatformSettings] !== v)) as Partial<PlatformSettings>;
  if (!Object.keys(changed).length) return before;
  await requireDb().transaction(async (tx) => {
    await writePlatformSettings(tx, changed, admin.userId);
    await appendAudit(
      tx,
      admin,
      {
        action: "PLATFORM_SETTINGS_CHANGED",
        targetType: "PLATFORM_SETTING",
        targetId: Object.keys(changed).join(",").slice(0, 64),
        before: Object.fromEntries(Object.keys(changed).map((k) => [k, before[k as keyof PlatformSettings]])),
        after: changed,
      },
      admin.meta,
    );
  });
  return getPlatformSettings({ fresh: true });
}

// ---------------------------------------------------------------------------
// Teacher limits
// ---------------------------------------------------------------------------

/** Teachers (workspace owners) with this month's usage, their override and the limits in effect. */
export async function teacherLimits(input: { query?: string; limit?: number }, now = new Date()) {
  const db = requireDb();
  const needle = input.query?.trim();
  const teachers = await db
    .selectDistinct({ id: users.id, name: users.name, email: users.email, accountStatus: users.accountStatus })
    .from(providerWorkspaces)
    .innerJoin(users, eq(users.id, providerWorkspaces.ownerUserId))
    .where(needle ? or(like(users.name, `%${needle}%`), like(users.email, `%${needle}%`)) : undefined)
    .limit(Math.min(input.limit ?? 200, 500));
  const settings = await getPlatformSettings();
  const defaults = { monthlyTokenQuota: settings["ai.defaultMonthlyTokenQuota"], dailyRequestCap: settings["ai.defaultDailyRequestCap"] };
  const ids = teachers.map((t) => t.id);
  if (!ids.length) return { defaults, teachers: [] };
  const monthFrom = periodStart("month", now);
  const dayFrom = periodStart("day", now);
  const counted = sql`(${aiTeacherLimits.usageResetAt} is null or ${aiRequestLogs.createdAt} >= ${aiTeacherLimits.usageResetAt})`;
  const usage = await db
    .select({
      userId: aiRequestLogs.userId,
      tokens: sql<number>`coalesce(sum(${aiRequestLogs.totalTokens}), 0)`,
      countedTokens: sql<number>`coalesce(sum(case when ${counted} then ${aiRequestLogs.totalTokens} else 0 end), 0)`,
      cost: sql<number>`coalesce(sum(${aiRequestLogs.costMicroUsd}), 0)`,
      requests: sql<number>`count(*)`,
      todayOps: sql<number>`count(distinct case when ${aiRequestLogs.createdAt} >= ${dayFrom} and ${counted} then ${aiRequestLogs.operationId} end)`,
    })
    .from(aiRequestLogs)
    .leftJoin(aiTeacherLimits, eq(aiTeacherLimits.userId, aiRequestLogs.userId))
    .where(and(gte(aiRequestLogs.createdAt, monthFrom), inArray(aiRequestLogs.userId, ids)))
    .groupBy(aiRequestLogs.userId);
  const overrides = await db.select().from(aiTeacherLimits).where(inArray(aiTeacherLimits.userId, ids));
  const stored = await db
    .select({ userId: providerWorkspaces.ownerUserId, bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)` })
    .from(files)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, files.workspaceId))
    .where(inArray(providerWorkspaces.ownerUserId, ids))
    .groupBy(providerWorkspaces.ownerUserId);
  const storedBy = new Map(stored.map((s) => [s.userId, n(s.bytes)]));
  const usageBy = new Map(usage.map((u) => [u.userId, u]));
  const overrideBy = new Map(overrides.map((o) => [o.userId, o]));
  const rows = teachers.map((t) => {
    const u = usageBy.get(t.id);
    const o = overrideBy.get(t.id) ?? null;
    const effective = resolveLimits(defaults, o);
    return {
      ...t,
      monthTokens: n(u?.tokens),
      countedTokens: n(u?.countedTokens),
      costUsd: usd(u?.cost),
      requests: n(u?.requests),
      todayOperations: n(u?.todayOps),
      storageBytes: storedBy.get(t.id) ?? 0,
      override: o ? { monthlyTokenQuota: o.monthlyTokenQuota, dailyRequestCap: o.dailyRequestCap, usageResetAt: o.usageResetAt } : null,
      effective,
      monthRatio: effective.monthlyTokenQuota ? n(u?.countedTokens) / effective.monthlyTokenQuota : null,
    };
  });
  rows.sort((a, b) => b.monthTokens - a.monthTokens || (a.name ?? "").localeCompare(b.name ?? ""));
  return { defaults, teachers: rows };
}

async function lockLimitRow(tx: Tx, userId: number) {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError("NOT_FOUND");
  const [row] = await tx.select().from(aiTeacherLimits).where(eq(aiTeacherLimits.userId, userId)).for("update");
  return row ?? null;
}

export async function setTeacherLimit(admin: AdminContext, userId: number, input: { monthlyTokenQuota: number | null; dailyRequestCap: number | null }) {
  return requireDb().transaction(async (tx) => {
    const before = await lockLimitRow(tx, userId);
    const values = { monthlyTokenQuota: input.monthlyTokenQuota, dailyRequestCap: input.dailyRequestCap, updatedBy: admin.userId };
    if (before) await tx.update(aiTeacherLimits).set(values).where(eq(aiTeacherLimits.userId, userId));
    else await tx.insert(aiTeacherLimits).values({ userId, ...values });
    await appendAudit(
      tx,
      admin,
      {
        action: "AI_LIMIT_CHANGED",
        targetType: "USER",
        targetId: userId,
        userId,
        before: before ? { monthlyTokenQuota: before.monthlyTokenQuota, dailyRequestCap: before.dailyRequestCap } : null,
        after: { monthlyTokenQuota: input.monthlyTokenQuota, dailyRequestCap: input.dailyRequestCap },
      },
      admin.meta,
    );
    return { userId, ...input };
  });
}

/** Usage before now stops counting toward this teacher's current day and month (logs are kept). */
export async function resetTeacherUsage(admin: AdminContext, userId: number, now = new Date()) {
  return requireDb().transaction(async (tx) => {
    const before = await lockLimitRow(tx, userId);
    if (before) await tx.update(aiTeacherLimits).set({ usageResetAt: now, updatedBy: admin.userId }).where(eq(aiTeacherLimits.userId, userId));
    else await tx.insert(aiTeacherLimits).values({ userId, usageResetAt: now, updatedBy: admin.userId });
    await appendAudit(
      tx,
      admin,
      { action: "AI_USAGE_RESET", targetType: "USER", targetId: userId, userId, before: { usageResetAt: before?.usageResetAt?.toISOString() ?? null }, after: { usageResetAt: now.toISOString() } },
      admin.meta,
    );
    return { userId, usageResetAt: now };
  });
}
