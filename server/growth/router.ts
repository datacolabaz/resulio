import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, rateLimit, router, studentProcedure, teacherProcedure } from "../_core/trpc";
import { isSchemaBehind } from "../syllabus/availability";
import * as actions from "./actions";
import { assertGrowthEnabled, growthEnabledFor, studentGrowthGroups } from "./availability";
import * as reports from "./reports";
import { RETAKE_MAX, RETAKE_MIN } from "./retake";
import * as planStore from "./planStore";
import * as practice from "./practice";
import * as riskStore from "./riskStore";
import * as studentView from "./studentView";
import * as topicHealth from "./topicHealth";
import * as weakness from "./weakness";

const MINUTE = 60_000;
const entityId = z.string().trim().min(1).max(32);
const studentInput = z.object({ studentId: z.number().int().positive() });
const topicKeys = z.array(z.string().trim().min(1).max(128)).min(1).max(5);

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

  settings: growthTeacherProcedure.query(({ ctx }) => riskStore.growthSettingsOf(ctx.scope.workspaceId)),
  updateSettings: growthTeacherProcedure
    .use(rateLimit("growthSettings", 20, MINUTE))
    .input(z.object({ riskEnabled: z.boolean().optional(), digestEnabled: z.boolean().optional(), parentReports: z.boolean().optional() }))
    .mutation(({ ctx, input }) => riskStore.updateGrowthSettings(ctx.scope.workspaceId, ctx.scope.userId, input)),
  riskList: growthTeacherProcedure.input(z.object({ groupId: entityId.nullable() })).query(({ ctx, input }) => actions.riskList(ctx.scope, input.groupId)),
  riskDetail: growthTeacherProcedure.input(studentInput).query(({ ctx, input }) => actions.riskDetail(ctx.scope, input.studentId)),
  dismissRisk: growthTeacherProcedure.use(rateLimit("growthAction", 60, MINUTE)).input(studentInput).mutation(({ ctx, input }) => actions.dismiss(ctx.scope, input.studentId)),
  addNote: growthTeacherProcedure
    .use(rateLimit("growthAction", 60, MINUTE))
    .input(studentInput.extend({ body: z.string().trim().min(1).max(2000) }))
    .mutation(({ ctx, input }) => actions.addNote(ctx.scope, input.studentId, input.body)),
  deleteNote: growthTeacherProcedure
    .use(rateLimit("growthAction", 60, MINUTE))
    .input(z.object({ noteId: entityId }))
    .mutation(({ ctx, input }) => actions.deleteNote(ctx.scope, input.noteId)),
  shareMaterial: growthTeacherProcedure
    .use(rateLimit("growthAction", 60, MINUTE))
    .input(studentInput.extend({ materialId: entityId }))
    .mutation(({ ctx, input }) => actions.shareMaterial(ctx.scope, input.studentId, input.materialId)),
  retakePreview: growthTeacherProcedure
    .input(studentInput.extend({ topicKeys: topicKeys }))
    .query(({ ctx, input }) => actions.retakePreview(ctx.scope, input.studentId, input.topicKeys)),
  createRetake: growthTeacherProcedure
    .use(rateLimit("growthRetake", 10, MINUTE))
    .input(studentInput.extend({ topicKeys: topicKeys, count: z.number().int().min(RETAKE_MIN).max(RETAKE_MAX) }))
    .mutation(({ ctx, input }) => actions.createRetake(ctx.scope, input)),
  groupPractice: growthTeacherProcedure.query(({ ctx }) => practice.groupPracticeSettings(ctx.scope)),
  setGroupPractice: growthTeacherProcedure
    .use(rateLimit("growthSettings", 20, MINUTE))
    .input(z.object({ groupId: entityId, enabled: z.boolean() }))
    .mutation(({ ctx, input }) => practice.setGroupPractice(ctx.scope, input.groupId, input.enabled)),
  reportShares: growthTeacherProcedure.input(studentInput).query(({ ctx, input }) => reports.activeShares(ctx.scope, input.studentId)),
  createReport: growthTeacherProcedure
    .use(rateLimit("growthReport", 10, MINUTE))
    .input(studentInput.extend({ email: z.string().trim().email().max(255).nullable(), locale: z.enum(["az", "en", "ru"]) }))
    .mutation(({ ctx, input }) => reports.createReportShare(ctx.scope, input)),
  revokeReport: growthTeacherProcedure
    .use(rateLimit("growthAction", 60, MINUTE))
    .input(z.object({ id: entityId }))
    .mutation(({ ctx, input }) => reports.revokeShare(ctx.scope, input.id)),
});

/** Parent report behind a share token; the token itself is the credential. */
export const publicGrowthReport = publicProcedure
  .use(rateLimit("publicGrowthReport", 30, MINUTE))
  .input(z.object({ token: z.string().trim().min(16).max(128) }))
  .query(({ input }) => reports.publicReport(input.token));

export const studentGrowthRouter = router({
  enabled: studentProcedure.query(async ({ ctx }) => ({ enabled: (await studentGrowthGroups(ctx.user.id)).length > 0 })),
  spaces: growthStudentProcedure.query(({ ctx }) => studentView.studentSpaces(ctx.user.id)),
  weakness: growthStudentProcedure.input(z.object({ groupId: entityId })).query(({ ctx, input }) => studentView.studentWeaknessMap(ctx.user.id, input.groupId)),
  plan: growthStudentProcedure.input(z.object({ groupId: entityId })).query(({ ctx, input }) => planStore.getPlan(ctx.user.id, input.groupId)),
  createPlan: growthStudentProcedure
    .use(rateLimit("growthPlanCreate", 10, MINUTE))
    .input(z.object({ groupId: entityId, dailyMinutes: z.number().int().min(10).max(180) }))
    .mutation(({ ctx, input }) => planStore.createPlan(ctx.user.id, input.groupId, input.dailyMinutes)),
  completeItem: growthStudentProcedure
    .use(rateLimit("growthPlanItem", 120, MINUTE))
    .input(z.object({ itemId: entityId }))
    .mutation(({ ctx, input }) => planStore.completeItem(ctx.user.id, input.itemId)),
  completePlan: growthStudentProcedure
    .use(rateLimit("growthPlanItem", 120, MINUTE))
    .input(z.object({ planId: entityId }))
    .mutation(({ ctx, input }) => planStore.completePlan(ctx.user.id, input.planId)),
  saveSettings: growthStudentProcedure
    .use(rateLimit("growthStudentSettings", 20, MINUTE))
    .input(z.object({ groupId: entityId, dailyMinutes: z.number().int().min(10).max(180).optional(), reminders: z.boolean().optional() }))
    .mutation(({ ctx, input }) => planStore.saveStudentSettings(ctx.user.id, input.groupId, { dailyMinutes: input.dailyMinutes, reminders: input.reminders })),
  startPractice: growthStudentProcedure
    .use(rateLimit("growthPractice", 5, MINUTE))
    .input(z.object({ groupId: entityId, topicKey: z.string().trim().min(1).max(128), itemId: entityId.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const started = await practice.startPractice(ctx.user.id, input);
      if (input.itemId) await planStore.linkPracticeToItem(ctx.user.id, input.itemId, started.assessmentId);
      return started;
    }),
});
