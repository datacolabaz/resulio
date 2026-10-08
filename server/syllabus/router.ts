import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  APPROVAL_TARGET_TYPES,
  completionRulesPatchSchema,
  SYLLABUS_ITEM_KINDS,
  SYLLABUS_ITEM_SCOPES,
  SYLLABUS_NODE_STATUSES,
  UNLOCK_TARGET_TYPES,
} from "../../shared/syllabus";
import { analyticsSettingsSchema } from "../../shared/syllabusAnalytics";
import { moduleDetailsSchema } from "../../shared/syllabusModuleDetails";
import { timestampDate } from "../../shared/timestamp";
import { rateLimit, router, studentProcedure, teacherProcedure } from "../_core/trpc";
import * as access from "./access";
import * as analytics from "./analytics";
import { clientActivityBatchSchema } from "./activityRules";
import * as authoring from "./authoring";
import { assertSyllabusEnabled, isSchemaBehind, syllabusEnabledFor } from "./availability";
import * as draft from "./draft";
import * as learning from "./learning";
import * as links from "./links";
import * as publishing from "./publishing";
import * as sample from "./sample";
import * as teacherViews from "./teacherViews";

const MINUTE = 60_000;
const entityId = z.string().trim().min(1).max(32);
const studentId = z.number().int().positive();
const revision = z.number().int().min(0).optional();
const shortText = (max: number) => z.string().trim().max(max);
const objectives = z.array(z.string().trim().min(1).max(300)).max(30);

/**
 * Syllabus tables or columns not migrated yet → SYLLABUS_DB_NOT_READY on every endpoint, so the UI
 * can say "the database is being updated" instead of a generic error or a silently empty list.
 */
const tablesGuard = async <T extends { ok: boolean; error?: { cause?: unknown } }>(path: string, result: T) => {
  if (!result.ok && isSchemaBehind(result.error)) {
    console.warn(`[syllabus] ${path}: database schema is behind (migration not applied yet)`);
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "SYLLABUS_DB_NOT_READY" });
  }
  return result;
};

/** Teacher side: owner of the workspace (teacherProcedure) and the feature flag on for it. */
const syllabusTeacherProcedure = teacherProcedure.use(async ({ ctx, next, path }) => {
  await assertSyllabusEnabled(ctx.scope.workspaceId);
  return tablesGuard(path, await next());
});

/** Student side: access is decided per syllabus (grant + its workspace's flag) inside learning.ts. */
const syllabusStudentProcedure = studentProcedure.use(async ({ next, path }) => tablesGuard(path, await next()));

const syllabusFields = z.object({
  title: shortText(255).min(1),
  description: shortText(20_000),
  subject: shortText(120),
  level: shortText(64),
  language: shortText(64),
  estimatedDurationLabel: shortText(64),
  estimatedHours: z.number().int().min(0).max(10_000).nullable(),
  coverFileId: entityId.nullable(),
  completionRules: completionRulesPatchSchema,
});

const moduleFields = z.object({
  title: shortText(255).min(1),
  description: shortText(20_000),
  estimatedMinutes: z.number().int().min(0).max(100_000).nullable(),
  objectives,
  prerequisitesText: shortText(5_000),
  status: z.enum(SYLLABUS_NODE_STATUSES),
  completionRules: completionRulesPatchSchema.nullable(),
});
const lessonFields = moduleFields.omit({ prerequisitesText: true });

const itemFields = z.object({
  title: shortText(255).min(1),
  required: z.boolean(),
  content: z.record(z.string(), z.unknown()),
  assessmentId: entityId.nullable(),
});

const placement = z.object({ scope: z.enum(SYLLABUS_ITEM_SCOPES), moduleId: entityId.nullish(), lessonId: entityId.nullish() });
const orderedIds = z.array(entityId).max(500);
const dateOrNull = timestampDate().nullable();

export const teacherSyllabusRouter = router({
  /** Lets the client show or hide the Syllabus entry for this workspace; never throws. */
  enabled: teacherProcedure.query(async ({ ctx }) => ({ enabled: await syllabusEnabledFor(ctx.scope.workspaceId).catch(() => false) })),
  list: syllabusTeacherProcedure.query(({ ctx }) => authoring.listSyllabi(ctx.scope)),
  forGroup: syllabusTeacherProcedure.input(z.object({ groupId: entityId })).query(({ ctx, input }) => links.syllabiForGroup(ctx.scope, input.groupId)),
  materialUsage: syllabusTeacherProcedure.query(({ ctx }) => links.materialUsage(ctx.scope)),
  get: syllabusTeacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => authoring.draftTree(ctx.scope, input.id)),
  create: syllabusTeacherProcedure
    .input(syllabusFields.partial().extend({ title: shortText(255).min(1) }))
    .mutation(({ ctx, input }) => authoring.createSyllabus(ctx.scope, input)),
  update: syllabusTeacherProcedure
    .input(z.object({ id: entityId, patch: syllabusFields.partial(), expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.updateSyllabus(ctx.scope, input.id, input.patch, input.expectedRevision)),
  setArchived: syllabusTeacherProcedure
    .input(z.object({ id: entityId, archived: z.boolean() }))
    .mutation(({ ctx, input }) => authoring.setArchived(ctx.scope, input.id, input.archived)),
  remove: syllabusTeacherProcedure
    .use(rateLimit("syllabusRemove", 20, MINUTE))
    .input(z.object({ id: entityId }))
    .mutation(({ ctx, input }) => authoring.deleteSyllabus(ctx.scope, input.id)),

  createModule: syllabusTeacherProcedure
    .input(z.object({ syllabusId: entityId, data: moduleFields.partial().extend({ title: shortText(255).min(1) }), expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.createModule(ctx.scope, input.syllabusId, input.data, input.expectedRevision)),
  updateModule: syllabusTeacherProcedure
    .input(z.object({ moduleId: entityId, patch: moduleFields.partial(), expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.updateModule(ctx.scope, input.moduleId, input.patch, input.expectedRevision)),
  updateModuleDetails: syllabusTeacherProcedure
    .input(z.object({ moduleId: entityId, details: moduleDetailsSchema, expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.updateModuleDetails(ctx.scope, input.moduleId, input.details, input.expectedRevision)),
  deleteModule: syllabusTeacherProcedure
    .input(z.object({ moduleId: entityId, expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.deleteModule(ctx.scope, input.moduleId, input.expectedRevision)),
  duplicateModule: syllabusTeacherProcedure
    .input(z.object({ moduleId: entityId, expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.duplicateModule(ctx.scope, input.moduleId, input.expectedRevision)),
  reorderModules: syllabusTeacherProcedure
    .input(z.object({ syllabusId: entityId, orderedIds, expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.reorderModules(ctx.scope, input.syllabusId, input.orderedIds, input.expectedRevision)),

  createLesson: syllabusTeacherProcedure
    .input(z.object({ moduleId: entityId, data: lessonFields.partial().extend({ title: shortText(255).min(1) }), expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.createLesson(ctx.scope, input.moduleId, input.data, input.expectedRevision)),
  updateLesson: syllabusTeacherProcedure
    .input(z.object({ lessonId: entityId, patch: lessonFields.partial(), expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.updateLesson(ctx.scope, input.lessonId, input.patch, input.expectedRevision)),
  moveLesson: syllabusTeacherProcedure
    .input(z.object({ lessonId: entityId, targetModuleId: entityId, expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.moveLesson(ctx.scope, input.lessonId, input.targetModuleId, input.expectedRevision)),
  deleteLesson: syllabusTeacherProcedure
    .input(z.object({ lessonId: entityId, expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.deleteLesson(ctx.scope, input.lessonId, input.expectedRevision)),
  duplicateLesson: syllabusTeacherProcedure
    .input(z.object({ lessonId: entityId, expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.duplicateLesson(ctx.scope, input.lessonId, input.expectedRevision)),
  reorderLessons: syllabusTeacherProcedure
    .input(z.object({ moduleId: entityId, orderedIds, expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.reorderLessons(ctx.scope, input.moduleId, input.orderedIds, input.expectedRevision)),

  createItem: syllabusTeacherProcedure
    .input(
      z.object({
        syllabusId: entityId,
        placement,
        data: itemFields.partial().extend({ kind: z.enum(SYLLABUS_ITEM_KINDS), title: shortText(255).min(1) }),
        expectedRevision: revision,
      }),
    )
    .mutation(({ ctx, input }) => authoring.createItem(ctx.scope, input.syllabusId, input.placement, input.data, input.expectedRevision)),
  updateItem: syllabusTeacherProcedure
    .input(z.object({ itemId: entityId, patch: itemFields.partial(), expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.updateItem(ctx.scope, input.itemId, input.patch, input.expectedRevision)),
  deleteItem: syllabusTeacherProcedure
    .input(z.object({ itemId: entityId, expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.deleteItem(ctx.scope, input.itemId, input.expectedRevision)),
  reorderItems: syllabusTeacherProcedure
    .input(z.object({ syllabusId: entityId, placement, orderedIds, expectedRevision: revision }))
    .mutation(({ ctx, input }) => authoring.reorderItems(ctx.scope, input.syllabusId, input.placement, input.orderedIds, input.expectedRevision)),

  createSample: syllabusTeacherProcedure
    .use(rateLimit("syllabusCreateSample", 5, MINUTE))
    .input(z.object({ locale: z.enum(["az", "en", "ru"]).default("az") }))
    .mutation(({ ctx, input }) => sample.createSampleSyllabus(ctx.scope, input.locale)),
  preview: syllabusTeacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => draft.preview(ctx.scope, input.id)),
  publishPreview: syllabusTeacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => draft.publishPreview(ctx.scope, input.id)),
  publish: syllabusTeacherProcedure
    .use(rateLimit("syllabusPublish", 10, MINUTE))
    .input(z.object({ id: entityId, label: shortText(16).optional(), changeNote: shortText(2_000).optional() }))
    .mutation(({ ctx, input }) => publishing.publish(ctx.scope, input.id, { label: input.label, changeNote: input.changeNote })),
  versions: syllabusTeacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => publishing.listVersions(ctx.scope, input.id)),
  version: syllabusTeacherProcedure
    .input(z.object({ id: entityId, versionId: entityId }))
    .query(({ ctx, input }) => publishing.versionDetail(ctx.scope, input.id, input.versionId)),
  moveStudents: syllabusTeacherProcedure
    .input(
      z.object({
        id: entityId,
        versionId: entityId,
        studentIds: z.array(studentId).max(500).optional(),
        groupId: entityId.optional(),
        all: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => teacherViews.moveStudents(ctx.scope, input.id, input.versionId, input)),

  grants: syllabusTeacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => access.listGrants(ctx.scope, input.id)),
  grant: syllabusTeacherProcedure
    .use(rateLimit("syllabusGrant", 30, MINUTE))
    .input(
      z.object({
        id: entityId,
        groupIds: z.array(entityId).max(100).default([]),
        studentIds: z.array(studentId).max(500).default([]),
        startsAt: dateOrNull.default(null),
        endsAt: dateOrNull.default(null),
        note: shortText(255).optional(),
      }),
    )
    .mutation(({ ctx, input }) => access.grantAccess(ctx.scope, input.id, input)),
  revokeGrant: syllabusTeacherProcedure
    .input(z.object({ id: entityId, grantId: entityId }))
    .mutation(({ ctx, input }) => access.revokeGrant(ctx.scope, input.id, input.grantId)),
  updateGrantDates: syllabusTeacherProcedure
    .input(z.object({ id: entityId, grantId: entityId, startsAt: dateOrNull, endsAt: dateOrNull }))
    .mutation(({ ctx, input }) => access.updateGrantDates(ctx.scope, input.id, input.grantId, input)),

  students: syllabusTeacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => teacherViews.students(ctx.scope, input.id)),
  student: syllabusTeacherProcedure
    .input(z.object({ id: entityId, studentId }))
    .query(({ ctx, input }) => teacherViews.studentDetail(ctx.scope, input.id, input.studentId)),
  manualUnlock: syllabusTeacherProcedure
    .use(rateLimit("syllabusManualUnlock", 30, MINUTE))
    .input(z.object({ id: entityId, studentId, targetType: z.enum(UNLOCK_TARGET_TYPES), targetId: entityId, reason: shortText(1_000).min(3) }))
    .mutation(({ ctx, input }) =>
      teacherViews.manualUnlock(ctx.scope, input.id, input.studentId, { type: input.targetType, id: input.targetId }, input.reason),
    ),
  revokeUnlock: syllabusTeacherProcedure
    .input(z.object({ id: entityId, studentId, unlockId: entityId }))
    .mutation(({ ctx, input }) => teacherViews.revokeUnlock(ctx.scope, input.id, input.studentId, input.unlockId)),
  decideApproval: syllabusTeacherProcedure
    .input(
      z.object({
        id: entityId,
        studentId,
        targetType: z.enum(APPROVAL_TARGET_TYPES),
        targetId: entityId,
        decision: z.enum(["APPROVED", "RETURNED"]),
        note: shortText(500).default(""),
      }),
    )
    .mutation(({ ctx, input }) =>
      teacherViews.decideApproval(ctx.scope, input.id, input.studentId, { type: input.targetType, id: input.targetId }, input.decision, input.note),
    ),
  approvals: syllabusTeacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => teacherViews.pendingApprovals(ctx.scope, input.id)),
  fileInfo: syllabusTeacherProcedure
    .input(z.object({ ids: z.array(entityId).max(100) }))
    .query(({ ctx, input }) => teacherViews.fileInfo(ctx.scope, input.ids)),
  markTeacherPractice: syllabusTeacherProcedure
    .input(z.object({ id: entityId, itemId: entityId, studentIds: z.array(studentId).max(500).optional(), groupId: entityId.optional() }))
    .mutation(({ ctx, input }) => teacherViews.markTeacherPractice(ctx.scope, input.id, input.itemId, input)),

  groupSettings: syllabusTeacherProcedure
    .input(z.object({ groupId: entityId }))
    .query(({ ctx, input }) => teacherViews.groupLearningSettingsOf(ctx.scope, input.groupId)),
  setProgressVisibleToGroup: syllabusTeacherProcedure
    .input(z.object({ groupId: entityId, visible: z.boolean() }))
    .mutation(({ ctx, input }) => teacherViews.setProgressVisibleToGroup(ctx.scope, input.groupId, input.visible)),

  analytics: syllabusTeacherProcedure
    .use(rateLimit("syllabusAnalytics", 60, MINUTE))
    .input(z.object({ id: entityId, groupId: entityId.nullish() }))
    .query(({ ctx, input }) => analytics.syllabusAnalytics(ctx.scope, input.id, input.groupId ?? null)),
  analyticsTimeline: syllabusTeacherProcedure
    .input(z.object({ id: entityId, studentId }))
    .query(({ ctx, input }) => analytics.studentTimeline(ctx.scope, input.id, input.studentId)),
  analyticsSettings: syllabusTeacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => analytics.getSettings(ctx.scope, input.id)),
  saveAnalyticsSettings: syllabusTeacherProcedure
    .input(z.object({ id: entityId, settings: analyticsSettingsSchema }))
    .mutation(({ ctx, input }) => analytics.saveSettings(ctx.scope, input.id, input.settings)),
});

export const studentSyllabusRouter = router({
  /** Lets the client show or hide the student's Syllabus entry; never throws. */
  enabled: studentProcedure.query(async ({ ctx }) => ({ enabled: await learning.hasAny(ctx.user.id) })),
  list: syllabusStudentProcedure.query(({ ctx }) => learning.mySyllabi(ctx.user.id)),
  path: syllabusStudentProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => learning.learningPath(ctx.user.id, input.id)),
  overview: syllabusStudentProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => learning.overview(ctx.user.id, input.id)),
  lesson: syllabusStudentProcedure
    .input(z.object({ id: entityId, lessonId: entityId }))
    .query(({ ctx, input }) => learning.lesson(ctx.user.id, input.id, input.lessonId)),
  completeTheory: syllabusStudentProcedure
    .use(rateLimit("syllabusCompleteTheory", 60, MINUTE))
    .input(z.object({ id: entityId, itemId: entityId }))
    .mutation(({ ctx, input }) => learning.completeTheory(ctx.user.id, input.id, input.itemId)),
  track: syllabusStudentProcedure
    .use(rateLimit("syllabusTrack", 60, MINUTE))
    .input(z.object({ id: entityId, events: clientActivityBatchSchema }))
    .mutation(({ ctx, input }) => learning.track(ctx.user.id, input.id, input.events)),
  startAssessment: syllabusStudentProcedure
    .use(rateLimit("syllabusStartAssessment", 10, MINUTE))
    .input(z.object({ id: entityId, itemId: entityId }))
    .mutation(({ ctx, input }) => learning.startAssessment(ctx.user.id, input.id, input.itemId)),
  submitPractice: syllabusStudentProcedure
    .use(rateLimit("syllabusSubmitPractice", 20, MINUTE))
    .input(
      z.object({
        id: entityId,
        itemId: entityId,
        files: z.array(z.object({ fileId: entityId })).max(10).default([]),
        answerText: z.string().max(20_000).default(""),
      }),
    )
    .mutation(({ ctx, input }) => learning.submitPractice(ctx.user.id, input.id, input.itemId, input.files, input.answerText)),
  groupProgress: syllabusStudentProcedure
    .use(rateLimit("syllabusGroupProgress", 60, MINUTE))
    .input(z.object({ id: entityId, groupId: entityId }))
    .query(({ ctx, input }) => learning.groupProgress(ctx.user.id, input.id, input.groupId)),
  activity: syllabusStudentProcedure
    .use(rateLimit("syllabusMyActivity", 30, MINUTE))
    .input(z.object({ id: entityId }))
    .query(({ ctx, input }) => analytics.myTimeline(ctx.user.id, input.id)),
});
