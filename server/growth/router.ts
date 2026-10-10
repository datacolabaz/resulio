import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { rateLimit, router, studentProcedure, teacherProcedure } from "../_core/trpc";
import { isSchemaBehind } from "../syllabus/availability";
import { assertGrowthEnabled, growthEnabledFor, studentGrowthGroups } from "./availability";
import * as topicHealth from "./topicHealth";
import * as weakness from "./weakness";

const MINUTE = 60_000;
const entityId = z.string().trim().min(1).max(32);

/** Growth tables not migrated yet → GROWTH_DB_NOT_READY instead of a 500. */
const tablesGuard = async <T extends { ok: boolean; error?: { cause?: unknown } }>(path: string, result: T) => {
  if (!result.ok && isSchemaBehind(result.error)) {
    console.warn(`[growth] ${path}: database schema is behind (migration not applied yet)`);
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "GROWTH_DB_NOT_READY" });
  }
  return result;
};

/** Teacher side: owner of the workspace and the `growth_engine` flag on for it. */
export const growthTeacherProcedure = teacherProcedure.use(async ({ ctx, next, path }) => {
  await assertGrowthEnabled(ctx.scope.workspaceId);
  return tablesGuard(path, await next());
});

/** Student side: own records only; each service call checks membership and the flag per group. */
export const growthStudentProcedure = studentProcedure.use(async ({ next, path }) => tablesGuard(path, await next()));

export const teacherGrowthRouter = router({
  enabled: teacherProcedure.query(async ({ ctx }) => ({ enabled: await growthEnabledFor(ctx.scope.workspaceId) })),
  topicHealth: growthTeacherProcedure.query(({ ctx }) => topicHealth.topicHealth(ctx.scope)),
  mapAlias: growthTeacherProcedure
    .use(rateLimit("growthMapAlias", 60, MINUTE))
    .input(z.object({ aliasKey: z.string().trim().min(1).max(120), label: z.string().trim().max(120), questionTopicId: entityId.nullable() }))
    .mutation(({ ctx, input }) => topicHealth.mapAlias(ctx.scope, input)),
  removeAlias: growthTeacherProcedure
    .use(rateLimit("growthMapAlias", 60, MINUTE))
    .input(z.object({ aliasKey: z.string().trim().min(1).max(120) }))
    .mutation(({ ctx, input }) => topicHealth.removeAlias(ctx.scope, input.aliasKey)),
  recompute: growthTeacherProcedure.use(rateLimit("growthRecompute", 3, MINUTE)).mutation(({ ctx }) => topicHealth.recomputeWorkspace(ctx.scope)),
  groupWeakness: growthTeacherProcedure.input(z.object({ groupId: entityId })).query(({ ctx, input }) => weakness.groupWeakness(ctx.scope, input.groupId)),
  studentWeakness: growthTeacherProcedure
    .input(z.object({ studentId: z.number().int().positive() }))
    .query(({ ctx, input }) => weakness.studentWeakness(ctx.scope, input.studentId)),
});

export const studentGrowthRouter = router({
  enabled: studentProcedure.query(async ({ ctx }) => ({ enabled: (await studentGrowthGroups(ctx.user.id)).length > 0 })),
});
