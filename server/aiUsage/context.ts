import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import type { AiFeature } from "../../shared/aiUsage";

/** Who an AI call is for. Carried across awaits and setImmediate, so background job runs keep it. */
export interface AiUsageContext {
  feature: AiFeature;
  /** The teacher whose quota pays for the call. */
  userId: number | null;
  workspaceId: string | null;
  /** One user action; generated when not given. */
  operationId: string;
}

const storage = new AsyncLocalStorage<AiUsageContext>();

/** Runs `fn` (and anything it schedules) with this usage context; model calls inside are logged against it. */
export function withAiUsage<T>(ctx: Omit<AiUsageContext, "operationId"> & { operationId?: string }, fn: () => T): T {
  return storage.run({ ...ctx, operationId: ctx.operationId ?? nanoid() }, fn);
}

export function currentAiUsage(): AiUsageContext | undefined {
  return storage.getStore();
}
