import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { RECALL_MODES } from "../../shared/coach";
import { rateLimit, router, studentProcedure } from "../_core/trpc";
import { isSchemaBehind } from "../syllabus/availability";
import { assertCoachEnabled, coachEnabledFor } from "./availability";
import { coachLimits, coachQuota } from "./quota";
import * as store from "./store";

const MINUTE = 60_000;

/** Coach tables not migrated yet → COACH_DB_NOT_READY instead of a 500. */
const tablesGuard = async <T extends { ok: boolean; error?: { cause?: unknown } }>(path: string, result: T) => {
  if (!result.ok && isSchemaBehind(result.error)) {
    console.warn(`[coach] ${path}: database schema is behind (migration not applied yet)`);
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "COACH_DB_NOT_READY" });
  }
  return result;
};

/** The student's own coach data only; the `study_coach` flag must be on for them. */
export const coachProcedure = studentProcedure.use(async ({ ctx, next, path }) => {
  await assertCoachEnabled(ctx.user.id);
  return tablesGuard(path, await next());
});

/** Like coachProcedure, and the privacy notice must have been accepted. */
export const coachConsentedProcedure = coachProcedure.use(async ({ ctx, next }) => {
  await store.assertConsent(ctx.user.id);
  return next();
});

export const studentCoachRouter = router({
  enabled: studentProcedure.query(async ({ ctx }) => ({ enabled: await coachEnabledFor(ctx.user.id) })),
  status: coachProcedure.query(async ({ ctx }) => ({
    settings: await store.settingsOf(ctx.user.id),
    quota: await coachQuota(ctx.user.id),
    limits: await coachLimits(),
  })),
  acceptConsent: coachProcedure.use(rateLimit("coachSettings", 20, MINUTE)).mutation(({ ctx }) => store.acceptConsent(ctx.user.id)),
  saveSettings: coachProcedure
    .use(rateLimit("coachSettings", 20, MINUTE))
    .input(z.object({ recallMode: z.enum(RECALL_MODES).optional(), reminders: z.boolean().optional() }))
    .mutation(({ ctx, input }) => store.saveSettings(ctx.user.id, input)),
});
