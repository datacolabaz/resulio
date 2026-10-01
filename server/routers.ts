import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { CLASS_TIME_PATTERN, GROUP_LANGUAGES, WEEK_DAYS } from "@shared/schedule";
import { TEACHING_CATEGORIES } from "@shared/teachingCategories";
import { z } from "zod";
import {
  ASSESSMENT_TYPES,
  assessmentSettingsPatchSchema,
  assignmentOverridesSchema,
  DIFFICULTIES,
  LIVE_STATUSES,
  QUESTION_TYPES,
  questionInputSchema,
  scheduleSchema,
  studentAnswerSchema,
  targetsSchema,
} from "../shared/assessment";
import { clearNamedCookie, getSessionCookieOptions } from "./_core/cookies";
import { ENV } from "./_core/env";
import { requestMeta } from "./_core/requestMeta";
import { sdk } from "./_core/sdk";
import { systemRouter } from "./_core/systemRouter";
import { GROUP_FORMATS, GROUP_JOIN_POLICIES, PROVIDER_TYPES, UI_CONTEXTS } from "../drizzle/schema";
import { adminRouter } from "./adminRouter";
import {
  partnerProcedure,
  protectedProcedure,
  publicProcedure,
  rateLimit,
  router,
  studentProcedure,
  teacherProcedure,
} from "./_core/trpc";
import * as db from "./db";
import { canEnterContext, defaultContext, partnerProfileOf, resolveAccess, type TeacherScope } from "./modules/access";
import * as activity from "./modules/activity";
import { adminView } from "./modules/admin/authz";
import * as ai from "./modules/ai";
import * as analytics from "./modules/analytics";
import * as assessments from "./modules/assessments";
import * as attempts from "./modules/attempts";
import { AppError } from "./modules/errors";
import * as groupEmailInvites from "./modules/groupEmailInvites";
import * as groups from "./modules/groups";
import * as partners from "./modules/partners";
import * as workspaces from "./modules/workspaces";
import { store } from "./resulioStore";

const MINUTE = 60_000;
const assessmentId = z.string().min(1).max(32);
const entityId = z.string().min(1).max(32);

function publicUser(user: NonNullable<Awaited<ReturnType<typeof db.getUserByOpenId>>>) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    locale: user.preferredLocale ?? "az",
    lastActiveContext: user.lastActiveContext ?? null,
    studentOnboardedAt: user.studentOnboardedAt,
    targetExam: user.targetExam,
    targetScore: user.targetScore,
    targetExamDate: user.targetExamDate,
    timezone: user.timezone,
  };
}

/** The signed-in person plus every activity context derived from real ownership/membership rows. */
async function me(user: NonNullable<Awaited<ReturnType<typeof db.getUserByOpenId>>>) {
  const access = await resolveAccess(user.id);
  const admin = user.accountStatus === "ACTIVE" ? adminView(access.platformRoles, user.email) : null;
  return {
    ...publicUser(user),
    contexts: access.contexts,
    activeMemberships: access.activeMemberships,
    pendingMemberships: access.pendingMemberships,
    workspaces: access.workspaces,
    partnerStatus: access.partnerStatus,
    accountStatus: user.accountStatus,
    admin,
    isAdmin: !!admin,
    defaultContext: defaultContext(access, user.lastActiveContext ?? null),
  };
}

async function assertRecipients(scope: TeacherScope, groupIds: string[], studentIds: number[]) {
  for (const g of groupIds) await groups.assertGroupOwner(scope, g);
  const own = new Set(await groups.teacherStudentIds(scope));
  if (!studentIds.every((s) => own.has(s))) throw new AppError("FORBIDDEN");
  const fromGroups = await groups.activeStudentIdsOfGroups(groupIds);
  return [...new Set([...fromGroups, ...studentIds])];
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const authRouter = router({
  me: publicProcedure.query(({ ctx }) => (ctx.user ? me(ctx.user) : null)),

  logout: publicProcedure.mutation(({ ctx }) => {
    clearNamedCookie(ctx.res, COOKIE_NAME, ctx.req);
    return { success: true } as const;
  }),

  /** Local development only: sign in as a seeded demo account. */
  demoLogin: publicProcedure
    .use(rateLimit("demoLogin", 20, MINUTE))
    .input(z.object({ role: z.enum(["TEACHER", "STUDENT"]) }))
    .mutation(async ({ ctx, input }) => {
      if (!ENV.enableDemoLogin) throw new AppError("DEMO_DISABLED");
      const openId = input.role === "TEACHER" ? "demo-teacher" : "demo-student";
      const user = await db.getUserByOpenId(openId);
      if (!user) throw new AppError("NOT_FOUND");
      const token = await sdk.createSessionToken(openId, { name: user.name ?? "", expiresInMs: ONE_YEAR_MS });
      ctx.res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(ctx.req), maxAge: ONE_YEAR_MS });
      return publicUser(user);
    }),

  demoAvailable: publicProcedure.query(() => ENV.enableDemoLogin),

  /**
   * Remembers which UI the user last worked in. This is a preference only: it grants nothing,
   * and it is accepted only for contexts the user's own records already allow.
   */
  setActiveContext: protectedProcedure
    .use(rateLimit("setActiveContext", 60, MINUTE))
    .input(z.object({ context: z.enum(UI_CONTEXTS) }))
    .mutation(async ({ ctx, input }) => {
      const access = await resolveAccess(ctx.user.id);
      if (!canEnterContext(access, input.context)) throw new AppError("CONTEXT_UNAVAILABLE");
      if (ctx.user.lastActiveContext !== input.context) await db.setLastActiveContext(ctx.user.id, input.context);
      return { context: input.context };
    }),

  setLocale: protectedProcedure
    .input(z.object({ locale: z.enum(["az", "ru", "en"]) }))
    .mutation(async ({ ctx, input }) => {
      await db.setPreferredLocale(ctx.user.id, input.locale);
      return { locale: input.locale };
    }),

  /**
   * Every field is optional and the call itself may be empty — that's how "skip" is expressed.
   * Either way `studentOnboardedAt` is stamped so the step is never shown to this user again.
   */
  completeStudentOnboarding: protectedProcedure
    .use(rateLimit("completeStudentOnboarding", 10, MINUTE))
    .input(
      z.object({
        timezone: z.string().trim().max(64).optional(),
        targetExam: z.string().trim().max(64).optional(),
        targetScore: z.string().trim().max(32).optional(),
        targetExamDate: z.string().datetime().optional().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db.completeStudentOnboarding(ctx.user.id, {
        timezone: input.timezone,
        targetExam: input.targetExam,
        targetScore: input.targetScore,
        targetExamDate: input.targetExamDate === undefined ? undefined : input.targetExamDate === null ? null : new Date(input.targetExamDate),
      });
      return { ok: true } as const;
    }),
});

// ---------------------------------------------------------------------------
// Teacher
// ---------------------------------------------------------------------------

const classScheduleEntryInput = z.object({
  day: z.enum(WEEK_DAYS),
  time: z.string().regex(CLASS_TIME_PATTERN),
});

const groupInput = z.object({
  name: z.string().trim().min(2).max(120),
  subject: z.string().trim().max(120).default(""),
  grade: z.string().trim().max(40).default(""),
  description: z.string().trim().max(2000).default(""),
  language: z.enum(GROUP_LANGUAGES).or(z.literal("")).default(""),
  format: z.enum(GROUP_FORMATS).default("ONLINE"),
  startDate: z.string().datetime().optional().nullable(),
  classSchedule: z
    .array(classScheduleEntryInput)
    .max(7)
    .refine((entries) => new Set(entries.map((e) => e.day)).size === entries.length, { message: "Duplicate day" })
    .default([]),
  scheduleVisible: z.boolean().default(false),
});

/** Turns the wire-format ISO string into a Date for Drizzle, passing through null/undefined untouched. */
function groupPatchForDb<T extends { startDate?: string | null }>({ startDate, ...rest }: T) {
  return { ...rest, ...(startDate === undefined ? {} : { startDate: startDate === null ? null : new Date(startDate) }) };
}

const teacherGroupsRouter = router({
  list: teacherProcedure.query(({ ctx }) => groups.teacherGroups(ctx.scope)),
  overview: teacherProcedure.query(({ ctx }) => analytics.groupsOverview(ctx.scope)),
  create: teacherProcedure.input(groupInput).mutation(({ ctx, input }) => groups.createGroup(ctx.scope, groupPatchForDb(input))),
  update: teacherProcedure
    .input(z.object({ id: entityId, patch: groupInput.partial() }))
    .mutation(({ ctx, input }) => groups.renameGroup(ctx.scope, input.id, groupPatchForDb(input.patch))),
  detail: teacherProcedure.input(z.object({ id: entityId })).query(async ({ ctx, input }) => {
    const group = await groups.assertGroupOwner(ctx.scope, input.id);
    const members = await groups.groupMembersList(ctx.scope, input.id);
    return { ...group, members };
  }),
  addMember: teacherProcedure
    .use(rateLimit("addMember", 60, MINUTE))
    .input(z.object({ groupId: entityId, email: z.string().trim().email().max(320) }))
    .mutation(({ ctx, input }) => groups.addMemberByEmail(ctx.scope, input.groupId, input.email)),
  approveMember: teacherProcedure
    .input(z.object({ groupId: entityId, studentId: z.number().int().positive() }))
    .mutation(({ ctx, input }) => groups.approveMember(ctx.scope, input.groupId, input.studentId)),
  removeMember: teacherProcedure
    .input(z.object({ groupId: entityId, studentId: z.number().int().positive() }))
    .mutation(({ ctx, input }) => groups.removeMember(ctx.scope, input.groupId, input.studentId)),
  analytics: teacherProcedure
    .input(z.object({ id: entityId }))
    .query(({ ctx, input }) => analytics.groupAnalytics(ctx.scope, input.id)),
  setJoinPolicy: teacherProcedure
    .input(z.object({ groupId: entityId, joinPolicy: z.enum(GROUP_JOIN_POLICIES) }))
    .mutation(({ ctx, input }) => groups.setJoinPolicy(ctx.scope, input.groupId, input.joinPolicy)),
  regenerateInviteCode: teacherProcedure
    .use(rateLimit("regenerateInviteCode", 10, MINUTE))
    .input(z.object({ groupId: entityId }))
    .mutation(({ ctx, input }) => groups.regenerateInviteCode(ctx.scope, input.groupId)),
  setInviteCodeActive: teacherProcedure
    .input(z.object({ groupId: entityId, active: z.boolean() }))
    .mutation(({ ctx, input }) => groups.setInviteCodeActive(ctx.scope, input.groupId, input.active)),
  setInviteCodeExpiry: teacherProcedure
    .input(z.object({ groupId: entityId, expiresAt: z.string().datetime().nullable() }))
    .mutation(({ ctx, input }) => groups.setInviteCodeExpiry(ctx.scope, input.groupId, input.expiresAt === null ? null : new Date(input.expiresAt))),
  emailInviteList: teacherProcedure
    .input(z.object({ groupId: entityId }))
    .query(({ ctx, input }) => groupEmailInvites.listEmailInvites(ctx.scope, input.groupId)),
  emailInviteCreate: teacherProcedure
    .use(rateLimit("emailInviteCreate", 30, MINUTE))
    .input(z.object({ groupId: entityId, email: z.string().trim().email().max(320) }))
    .mutation(({ ctx, input }) => groupEmailInvites.createEmailInvite(ctx.scope, input.groupId, input.email)),
  emailInviteRevoke: teacherProcedure
    .use(rateLimit("emailInviteRevoke", 30, MINUTE))
    .input(z.object({ groupId: entityId, inviteId: entityId }))
    .mutation(({ ctx, input }) => groupEmailInvites.revokeEmailInvite(ctx.scope, input.groupId, input.inviteId)),
  emailInviteResend: teacherProcedure
    .use(rateLimit("emailInviteResend", 20, MINUTE))
    .input(z.object({ groupId: entityId, inviteId: entityId }))
    .mutation(({ ctx, input }) => groupEmailInvites.resendEmailInvite(ctx.scope, input.groupId, input.inviteId)),
});

const questionBankFilter = z
  .object({
    topic: z.string().max(120).optional(),
    difficulty: z.enum(DIFFICULTIES).optional(),
    type: z.enum(QUESTION_TYPES).optional(),
    source: z.enum(["MANUAL", "AI"]).optional(),
    search: z.string().max(200).optional(),
  })
  .default({});

const teacherQuestionsRouter = router({
  bank: teacherProcedure.input(questionBankFilter).query(({ ctx, input }) => assessments.questionBank(ctx.scope, input)),
  create: teacherProcedure
    .input(z.object({ question: questionInputSchema }))
    .mutation(({ ctx, input }) => assessments.createQuestion(ctx.scope, input.question)),
  update: teacherProcedure
    .input(z.object({ id: entityId, question: questionInputSchema }))
    .mutation(({ ctx, input }) => assessments.updateQuestion(ctx.scope, input.id, input.question)),
});

const teacherAssessmentsRouter = router({
  list: teacherProcedure
    .input(z.object({ type: z.enum(ASSESSMENT_TYPES).optional(), liveStatus: z.enum(LIVE_STATUSES).optional() }).default({}))
    .query(({ ctx, input }) => assessments.listForTeacher(ctx.scope, input)),
  detail: teacherProcedure
    .input(z.object({ id: assessmentId }))
    .query(({ ctx, input }) => assessments.teacherDetail(ctx.scope, input.id)),
  create: teacherProcedure
    .input(z.object({ type: z.enum(ASSESSMENT_TYPES), settings: assessmentSettingsPatchSchema.optional() }))
    .mutation(({ ctx, input }) => assessments.createAssessment(ctx.scope, input)),
  updateSettings: teacherProcedure
    .input(z.object({ id: assessmentId, patch: assessmentSettingsPatchSchema }))
    .mutation(({ ctx, input }) => assessments.updateSettings(ctx.scope, input.id, input.patch)),
  updateSchedule: teacherProcedure
    .input(z.object({ id: assessmentId, schedule: scheduleSchema }))
    .mutation(({ ctx, input }) => assessments.updateSchedule(ctx.scope, input.id, input.schedule)),
  setTargets: teacherProcedure
    .input(z.object({ id: assessmentId, targets: targetsSchema, overrides: assignmentOverridesSchema.optional() }))
    .mutation(({ ctx, input }) => assessments.setTargets(ctx.scope, input.id, input.targets, input.overrides)),
  addQuestion: teacherProcedure
    .input(z.object({ id: assessmentId, questionId: entityId }))
    .mutation(({ ctx, input }) => assessments.addQuestionToAssessment(ctx.scope, input.id, input.questionId)),
  createQuestion: teacherProcedure
    .input(z.object({ id: assessmentId, question: questionInputSchema }))
    .mutation(({ ctx, input }) => assessments.createQuestionInAssessment(ctx.scope, input.id, input.question)),
  removeQuestion: teacherProcedure
    .input(z.object({ id: assessmentId, questionId: entityId }))
    .mutation(({ ctx, input }) => assessments.removeQuestionFromAssessment(ctx.scope, input.id, input.questionId)),
  reorder: teacherProcedure
    .input(z.object({ id: assessmentId, questionIds: z.array(entityId).max(500) }))
    .mutation(({ ctx, input }) => assessments.reorderQuestions(ctx.scope, input.id, input.questionIds)),
  preview: teacherProcedure
    .input(z.object({ id: assessmentId }))
    .query(({ ctx, input }) => assessments.studentPreview(ctx.scope, input.id)),
  publish: teacherProcedure
    .input(z.object({ id: assessmentId, moveAssignments: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => assessments.publish(ctx.scope, input.id, { moveAssignments: input.moveAssignments })),
  close: teacherProcedure
    .input(z.object({ id: assessmentId }))
    .mutation(({ ctx, input }) => assessments.closeAssessment(ctx.scope, input.id)),
  versions: teacherProcedure
    .input(z.object({ id: assessmentId }))
    .query(({ ctx, input }) => assessments.versionsOf(ctx.scope, input.id)),
  participants: teacherProcedure
    .input(z.object({ id: assessmentId }))
    .query(({ ctx, input }) => activity.assessmentParticipants(ctx.scope, input.id)),
  setInactivityThreshold: teacherProcedure
    .input(z.object({ id: assessmentId, minutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.null()]) }))
    .mutation(({ ctx, input }) => activity.setInactivityThreshold(ctx.scope, input.id, input.minutes)),
  csv: teacherProcedure.input(z.object({ id: assessmentId })).query(async ({ ctx, input }) => {
    const rows = await analytics.ranking(ctx.scope, input.id);
    const header = ["rank", "student", "percentage", "earned", "total", "correct", "questions", "duration_seconds", "pending_review"];
    const lines = rows.map((r) =>
      [r.rank, r.studentName, r.percentage, r.earnedPoints, r.totalPoints, r.correctCount, r.totalQuestions, r.durationSeconds, r.pendingReviewCount]
        .map(csvCell)
        .join(","),
    );
    return [header.join(","), ...lines].join("\n");
  }),
});

const teacherResultsRouter = router({
  list: teacherProcedure
    .input(
      z
        .object({ assessmentId: assessmentId.optional(), studentId: z.number().int().positive().optional(), pendingOnly: z.boolean().optional() })
        .default({}),
    )
    .query(({ ctx, input }) => attempts.teacherResults(ctx.scope, input)),
  detail: teacherProcedure
    .input(z.object({ id: entityId }))
    .query(({ ctx, input }) => attempts.resultForTeacher(ctx.scope, input.id)),
  pendingReviews: teacherProcedure
    .input(z.object({ assessmentId: assessmentId.optional() }).default({}))
    .query(({ ctx, input }) => attempts.pendingReviews(ctx.scope, input.assessmentId)),
  grade: teacherProcedure
    .input(z.object({ resultId: entityId, questionId: entityId, points: z.number().min(0).max(1000) }))
    .mutation(({ ctx, input }) => attempts.gradeOpenAnswer(ctx.scope, input.resultId, input.questionId, input.points)),
});

const teacherAnalyticsRouter = router({
  overview: teacherProcedure.query(({ ctx }) => analytics.teacherOverview(ctx.scope)),
  assessment: teacherProcedure
    .input(z.object({ id: assessmentId }))
    .query(({ ctx, input }) => analytics.assessmentAnalytics(ctx.scope, input.id)),
  ranking: teacherProcedure
    .input(z.object({ id: assessmentId }))
    .query(({ ctx, input }) => analytics.ranking(ctx.scope, input.id)),
  questions: teacherProcedure
    .input(z.object({ id: assessmentId }))
    .query(({ ctx, input }) => analytics.questionAnalytics(ctx.scope, input.id)),
  students: teacherProcedure.query(({ ctx }) => analytics.studentsAnalytics(ctx.scope)),
  student: teacherProcedure
    .input(z.object({ studentId: z.number().int().positive() }))
    .query(({ ctx, input }) => analytics.studentProgress(input.studentId, ctx.scope)),
  topics: teacherProcedure.query(({ ctx }) => analytics.topicsAnalytics(ctx.scope)),
});

const teacherAiRouter = router({
  usage: teacherProcedure.query(({ ctx }) => store.usageOf(ctx.scope.workspaceId)),
  generate: teacherProcedure
    .use(rateLimit("aiGenerate", 10, MINUTE))
    .input(ai.aiGenerateSchema)
    .mutation(({ ctx, input }) => ai.generateQuestions(ctx.scope, input)),
  accept: teacherProcedure
    .input(z.object({ draftId: z.string().min(1).max(32), tempIds: z.array(z.string().min(1).max(32)).min(1).max(50), assessmentId: assessmentId.optional() }))
    .mutation(({ ctx, input }) => ai.acceptAiQuestions(ctx.scope, input.draftId, input.tempIds, input.assessmentId)),
});

const recipients = {
  groupIds: z.array(entityId).max(100).default([]),
  studentIds: z.array(z.number().int().positive()).max(1000).default([]),
};

const assignmentInput = z.object({
  title: z.string().trim().min(2).max(255),
  description: z.string().trim().max(5000).default(""),
  instructions: z.string().trim().max(5000).default(""),
  deadline: z.coerce.date(),
  ...recipients,
  attachments: z.array(z.object({ name: z.string().max(255), size: z.string().max(32) })).max(20).default([]),
});

const materialInput = z.object({
  title: z.string().trim().min(2).max(255),
  description: z.string().trim().max(5000).default(""),
  subject: z.string().trim().max(120).default(""),
  topic: z.string().trim().max(120).default(""),
  fileName: z.string().trim().min(1).max(255),
  ...recipients,
});

/** Resolves the recipients a patch currently points at, falling back to the row's own groupIds/studentIds when the patch doesn't touch them. */
async function assertPatchedRecipients(
  scope: TeacherScope,
  current: { groupIds: string[]; studentIds: number[] },
  patch: { groupIds?: string[]; studentIds?: number[] },
) {
  return assertRecipients(scope, patch.groupIds ?? current.groupIds, patch.studentIds ?? current.studentIds);
}

const teacherTasksRouter = router({
  list: teacherProcedure.query(({ ctx }) =>
    store
      .workspaceAssignments(ctx.scope.workspaceId)
      .map((a) => ({ ...a, submissions: store.submissions.filter((s) => s.assignmentId === a.id) })),
  ),
  create: teacherProcedure
    .input(assignmentInput)
    .mutation(async ({ ctx, input }) => {
      const ids = await assertRecipients(ctx.scope, input.groupIds, input.studentIds);
      return store.createAssignment(ctx.scope, { ...input, deadline: input.deadline.toISOString() }, ids);
    }),
  update: teacherProcedure
    .input(z.object({ id: entityId, patch: assignmentInput.partial() }))
    .mutation(async ({ ctx, input }) => {
      const current = store.assignmentOf(ctx.scope, input.id);
      const touchesRecipients = input.patch.groupIds !== undefined || input.patch.studentIds !== undefined;
      const before = touchesRecipients ? new Set(await assertRecipients(ctx.scope, current.groupIds, current.studentIds)) : null;
      const after = touchesRecipients ? await assertPatchedRecipients(ctx.scope, current, input.patch) : null;
      const { deadline, ...rest } = input.patch;
      const row = store.updateAssignment(ctx.scope, input.id, { ...rest, ...(deadline ? { deadline: deadline.toISOString() } : {}) });
      if (after && before) for (const sid of after) if (!before.has(sid)) store.notify(sid, "Yeni tapşırıq", row.title);
      return row;
    }),
  remove: teacherProcedure.input(z.object({ id: entityId })).mutation(({ ctx, input }) => store.deleteAssignment(ctx.scope, input.id)),
  materials: teacherProcedure.query(({ ctx }) => store.workspaceMaterials(ctx.scope.workspaceId)),
  createMaterial: teacherProcedure
    .input(materialInput)
    .mutation(async ({ ctx, input }) => {
      await assertRecipients(ctx.scope, input.groupIds, input.studentIds);
      return store.createMaterial(ctx.scope, input);
    }),
  updateMaterial: teacherProcedure
    .input(z.object({ id: entityId, patch: materialInput.partial() }))
    .mutation(async ({ ctx, input }) => {
      const current = store.materialOf(ctx.scope, input.id);
      if (input.patch.groupIds !== undefined || input.patch.studentIds !== undefined) {
        await assertPatchedRecipients(ctx.scope, current, input.patch);
      }
      return store.updateMaterial(ctx.scope, input.id, input.patch);
    }),
  removeMaterial: teacherProcedure.input(z.object({ id: entityId })).mutation(({ ctx, input }) => store.deleteMaterial(ctx.scope, input.id)),
});

const workspaceInput = z.object({
  title: z.string().trim().min(2).max(255),
  publicDisplayName: z.string().trim().max(255).default(""),
  providerType: z.enum(PROVIDER_TYPES).default("TEACHER"),
  teachingCategory: z.enum(TEACHING_CATEGORIES).default("OTHER"),
  // Free text: either a known subcategory key, or whatever the teacher typed under "Digər".
  teachingSubcategory: z.string().trim().max(120).default(""),
});

const teacherRouter = router({
  /** The workspace resolved for this request (verified ownership), incl. its subscription. */
  workspace: teacherProcedure.query(({ ctx }) => ({ ...ctx.workspace, usage: store.usageOf(ctx.workspace.id) })),
  updateWorkspace: teacherProcedure
    .input(workspaceInput.partial())
    .mutation(({ ctx, input }) => workspaces.updateWorkspace(ctx.scope, input)),
  dashboard: teacherProcedure.query(({ ctx }) => analytics.teacherDashboard(ctx.scope)),
  activity: teacherProcedure.query(({ ctx }) => activity.assessmentActivityCards(ctx.scope)),
  students: teacherProcedure.query(({ ctx }) => groups.teacherStudents(ctx.scope)),
  groups: teacherGroupsRouter,
  questions: teacherQuestionsRouter,
  assessments: teacherAssessmentsRouter,
  results: teacherResultsRouter,
  analytics: teacherAnalyticsRouter,
  ai: teacherAiRouter,
  tasks: teacherTasksRouter,
});

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

const studentRouter = router({
  dashboard: studentProcedure.query(async ({ ctx }) => {
    const [list, results, progress] = await Promise.all([
      attempts.studentAssessments(ctx.user.id),
      attempts.studentResults(ctx.user.id),
      analytics.studentProgress(ctx.user.id),
    ]);
    return {
      active: list.filter((a) => a.liveStatus === "ACTIVE" && (a.resume !== null || a.attemptsUsed < a.attemptsAllowed)),
      upcoming: list.filter((a) => a.liveStatus === "SCHEDULED"),
      recentResults: results.slice(0, 5),
      averageScore: progress.summary.average,
      weakTopics: progress.topics.filter((t) => t.classification === "WEAK").slice(0, 5),
    };
  }),
  assessments: studentProcedure
    .input(z.object({ type: z.enum(ASSESSMENT_TYPES).optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const list = await attempts.studentAssessments(ctx.user.id);
      return input.type ? list.filter((a) => a.type === input.type) : list;
    }),
  assessment: studentProcedure
    .input(z.object({ id: assessmentId }))
    .query(({ ctx, input }) => attempts.studentAssessmentDetail(input.id, ctx.user.id)),
  start: studentProcedure
    .use(rateLimit("startAttempt", 10, MINUTE))
    .input(z.object({ assessmentId }))
    .mutation(({ ctx, input }) => attempts.startAttempt(input.assessmentId, ctx.user.id)),
  session: studentProcedure
    .input(z.object({ attemptId: entityId }))
    .query(({ ctx, input }) => attempts.attemptView(input.attemptId, ctx.user.id)),
  save: studentProcedure
    .use(rateLimit("saveAnswers", 120, MINUTE))
    .input(
      z.object({
        attemptId: entityId,
        entries: z
          .array(z.object({ questionId: entityId, answer: studentAnswerSchema, revision: z.number().int().min(1).max(2_000_000_000).optional() }))
          .min(1)
          .max(200),
      }),
    )
    .mutation(({ ctx, input }) => attempts.saveAnswers(input.attemptId, ctx.user.id, input.entries)),
  ping: studentProcedure
    .use(rateLimit("sessionPing", 30, MINUTE))
    .input(z.object({ attemptId: entityId, interacted: z.boolean() }))
    .mutation(({ ctx, input }) => attempts.sessionPing(input.attemptId, ctx.user.id, input.interacted)),
  trackView: studentProcedure
    .use(rateLimit("trackView", 60, MINUTE))
    .input(z.object({ assessmentId }))
    .mutation(({ ctx, input }) => activity.markAssessmentViewed(input.assessmentId, ctx.user.id)),
  submit: studentProcedure
    .use(rateLimit("submitAttempt", 10, MINUTE))
    .input(z.object({ attemptId: entityId }))
    .mutation(({ ctx, input }) => attempts.submitAttempt(input.attemptId, ctx.user.id)),
  results: studentProcedure.query(({ ctx }) => attempts.studentResults(ctx.user.id)),
  result: studentProcedure
    .input(z.object({ id: entityId }))
    .query(({ ctx, input }) => attempts.resultForStudent(input.id, ctx.user.id)),
  progress: studentProcedure.query(({ ctx }) => analytics.studentProgress(ctx.user.id)),
  groups: studentProcedure.query(({ ctx }) => groups.studentGroups(ctx.user.id)),
  join: studentProcedure
    .use(rateLimit("joinGroup", 10, MINUTE))
    .input(z.object({ inviteCode: z.string().trim().min(4).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const joined = await groups.joinByInvite(ctx.user.id, input.inviteCode.toUpperCase());
      const verb = joined.status === "ACTIVE" ? "Yeni tələbə qoşuldu" : "Qoşulma sorğusu";
      store.notify(joined.ownerUserId, verb, `${ctx.user.name ?? "Tələbə"} → ${joined.groupName}`);
      return { groupId: joined.groupId, groupName: joined.groupName, status: joined.status };
    }),
  acceptEmailInvite: studentProcedure
    .use(rateLimit("acceptEmailInvite", 10, MINUTE))
    .input(z.object({ token: z.string().trim().min(16).max(128) }))
    .mutation(({ ctx, input }) => groupEmailInvites.acceptEmailInvite(ctx.user.id, ctx.user.email ?? "", input.token)),
  tasks: studentProcedure.query(async ({ ctx }) =>
    store.studentAssignments(ctx.user.id, await groups.activeGroupIdsOfStudent(ctx.user.id)),
  ),
  submitTask: studentProcedure
    .use(rateLimit("submitTask", 20, MINUTE))
    .input(z.object({ assignmentId: z.string().min(1).max(32), files: z.array(z.string().trim().min(1).max(255)).min(1).max(10) }))
    .mutation(async ({ ctx, input }) => {
      const groupIds = await groups.activeGroupIdsOfStudent(ctx.user.id);
      const asg = store.assignments.find((a) => a.id === input.assignmentId);
      const ownerId = asg ? await workspaces.workspaceOwnerId(asg.workspaceId) : null;
      try {
        return store.submitAssignment(ctx.user.id, groupIds, input.assignmentId, input.files, ownerId ?? undefined);
      } catch {
        throw new AppError("NOT_FOUND");
      }
    }),
  materials: studentProcedure.query(async ({ ctx }) =>
    store.studentMaterials(ctx.user.id, await groups.activeGroupIdsOfStudent(ctx.user.id)),
  ),
  /** Self-enrolling via a teacher's share link: adds the student as an individual recipient. */
  claimTask: studentProcedure
    .use(rateLimit("claimTask", 20, MINUTE))
    .input(z.object({ shareCode: z.string().trim().min(4).max(32) }))
    .mutation(({ ctx, input }) => {
      const asg = store.assignments.find((row) => row.shareCode === input.shareCode);
      if (!asg) throw new AppError("NOT_FOUND");
      if (!asg.studentIds.includes(ctx.user.id)) {
        asg.studentIds = [...asg.studentIds, ctx.user.id];
        store.notify(asg.createdBy, "Qoşuldu", `${ctx.user.name ?? "Tələbə"} → ${asg.title}`);
      }
      return { id: asg.id };
    }),
  claimMaterial: studentProcedure
    .use(rateLimit("claimMaterial", 20, MINUTE))
    .input(z.object({ shareCode: z.string().trim().min(4).max(32) }))
    .mutation(({ ctx, input }) => {
      const m = store.materials.find((row) => row.shareCode === input.shareCode);
      if (!m) throw new AppError("NOT_FOUND");
      if (!m.studentIds.includes(ctx.user.id)) m.studentIds = [...m.studentIds, ctx.user.id];
      return { id: m.id };
    }),
});

// ---------------------------------------------------------------------------
// Public + shared
// ---------------------------------------------------------------------------

const publicRouter = router({
  exam: publicProcedure
    .use(rateLimit("publicExam", 60, MINUTE))
    .input(z.object({ shareCode: z.string().trim().min(4).max(32) }))
    .query(({ input }) => assessments.publicByShareCode(input.shareCode)),
  task: publicProcedure
    .use(rateLimit("publicTask", 60, MINUTE))
    .input(z.object({ shareCode: z.string().trim().min(4).max(32) }))
    .query(({ input }) => {
      const a = store.assignments.find((row) => row.shareCode === input.shareCode);
      return a ? { id: a.id, title: a.title, description: a.description, deadline: a.deadline } : null;
    }),
  material: publicProcedure
    .use(rateLimit("publicMaterial", 60, MINUTE))
    .input(z.object({ shareCode: z.string().trim().min(4).max(32) }))
    .query(({ input }) => {
      const m = store.materials.find((row) => row.shareCode === input.shareCode);
      return m ? { id: m.id, title: m.title, description: m.description, subject: m.subject, topic: m.topic, fileName: m.fileName } : null;
    }),
  invite: publicProcedure
    .use(rateLimit("publicInvite", 60, MINUTE))
    .input(z.object({ inviteCode: z.string().trim().min(4).max(32) }))
    .query(({ input }) => groups.publicInvite(input.inviteCode.toUpperCase())),
  emailInvite: publicProcedure
    .use(rateLimit("publicEmailInvite", 60, MINUTE))
    .input(z.object({ token: z.string().trim().min(16).max(128) }))
    .query(({ input }) => groupEmailInvites.publicEmailInvitePreview(input.token)),
});

const inboxRouter = router({
  list: protectedProcedure.query(({ ctx }) => store.notifications.filter((n) => n.userId === ctx.user.id).slice(0, 100)),
  read: protectedProcedure.input(z.object({ id: z.string().min(1).max(32) })).mutation(({ ctx, input }) => {
    store.markRead(ctx.user.id, input.id);
    return { ok: true };
  }),
});

// ---------------------------------------------------------------------------
// Contexts: workspaces, partner, admin
// ---------------------------------------------------------------------------

const workspacesRouter = router({
  mine: protectedProcedure.query(async ({ ctx }) => (await resolveAccess(ctx.user.id)).workspaces),
  /** Opens (or adds) a teaching context for the same users.id. */
  create: protectedProcedure
    .use(rateLimit("createWorkspace", 5, MINUTE))
    .input(workspaceInput)
    .mutation(async ({ ctx, input }) => {
      const ws = await workspaces.createWorkspace(ctx.user, input);
      await db.setLastActiveContext(ctx.user.id, "teaching");
      return ws;
    }),
});

const partnerRouter = router({
  profile: protectedProcedure.query(async ({ ctx }) => {
    const p = await partnerProfileOf(ctx.user.id);
    return p ? { status: p.status, referralCode: p.status === "APPROVED" ? p.referralCode : null } : null;
  }),
  /** Applies, or re-submits answers while the admin has requested more information. */
  requestProfile: protectedProcedure
    .use(rateLimit("partnerApply", 5, MINUTE))
    .input(
      z
        .object({
          answers: z
            .record(z.string().trim().min(1).max(40), z.string().trim().max(2000))
            .refine((a) => Object.keys(a).length <= 12, "TOO_MANY_FIELDS")
            .optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const p = await partners.applyAsPartner(ctx.user.id, input?.answers, requestMeta(ctx.req));
      return { status: p.status };
    }),
  dashboard: partnerProcedure.query(({ ctx }) => ({
    status: ctx.partner.status,
    referralCode: ctx.partner.referralCode,
    approvedAt: ctx.partner.approvedAt,
  })),
});

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  workspaces: workspacesRouter,
  partner: partnerRouter,
  admin: adminRouter,
  teacher: teacherRouter,
  student: studentRouter,
  public: publicRouter,
  inbox: inboxRouter,
});

export type AppRouter = typeof appRouter;
