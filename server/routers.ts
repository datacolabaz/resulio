import { normalizeEmail, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@shared/auth";
import { COOKIE_NAME } from "@shared/const";
import { defaultGroupType, GROUP_CLASS_MAX, GROUP_LEVEL_MAX, GROUP_TYPES } from "@shared/groupType";
import { REFERRAL_SOURCES } from "@shared/referralSources";
import { CLASS_TIME_PATTERN, GROUP_LANGUAGES, WEEK_DAYS } from "@shared/schedule";
import { TEACHING_CATEGORIES } from "@shared/teachingCategories";
import { timestampDate, timestampIso } from "@shared/timestamp";
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
import { completeSignIn, issueSessionCookie, safeCampaign, safeChannel, safeRef } from "./_core/authSession";
import type { TrpcContext } from "./_core/context";
import { clearNamedCookie } from "./_core/cookies";
import { ENV } from "./_core/env";
import { requestMeta } from "./_core/requestMeta";
import { systemRouter } from "./_core/systemRouter";
import { GROUP_FORMATS, GROUP_JOIN_POLICIES, PROVIDER_TYPES, PUSH_PLATFORMS, TASK_ACCESS_MODES, UI_CONTEXTS, type TaskAccessMode } from "../drizzle/schema";
import { adminRouter } from "./adminRouter";
import { myAiQuota } from "./aiUsage/limits";
import {
  limited,
  partnerProcedure,
  protectedProcedure,
  publicProcedure,
  rateLimit,
  router,
  studentProcedure,
  teacherProcedure,
} from "./_core/trpc";
import * as db from "./db";
import { canEnterContext, defaultContext, ensurePartnerProfile, resolveAccess, type TeacherScope } from "./modules/access";
import * as activity from "./modules/activity";
import { adminView } from "./modules/admin/authz";
import * as ai from "./modules/ai";
import * as aiReview from "./modules/aiReview";
import * as answerKey from "./modules/answerKey";
import * as autoGrade from "./modules/autoGrade";
import * as analytics from "./modules/analytics";
import * as assessments from "./modules/assessments";
import * as attempts from "./modules/attempts";
import { AppError } from "./modules/errors";
import * as groupEmailInvites from "./modules/groupEmailInvites";
import * as groupInviteLinks from "./modules/groupInviteLinks";
import * as groupJoin from "./modules/groupJoin";
import * as groupProfiles from "./modules/groupProfiles";
import * as groups from "./modules/groups";
import * as motivation from "./modules/motivation";
import * as notifications from "./modules/notifications";
import * as partners from "./modules/partners";
import * as passwordAuth from "./modules/passwordAuth";
import * as referrals from "./modules/referrals";
import * as shareTracking from "./modules/shareTracking";
import { canSeeTaskContent, rosterStudentIds } from "./modules/taskAccess";
import * as tasks from "./modules/tasks";
import * as taskNotify from "./modules/taskNotify";
import * as workspaces from "./modules/workspaces";
import { CHANNELS, EVENT_TYPES } from "./notifications/events";
import * as notificationPreferences from "./notifications/preferences";
import * as push from "./notifications/push";
import * as webPush from "./notifications/webPush";
import * as bank from "./questionBank/bank";
import { questionBankFilter, questionImportRouter, questionTopicsRouter, sectionPicksSchema } from "./questionBank/router";
import { store } from "./resulioStore";
import { announceGroupJoin } from "./syllabus/notify";
import { publicSyllabusProcedure, studentSyllabusRouter, teacherSyllabusRouter } from "./syllabus/router";
import { SHARE_CAMPAIGNS, SHARE_CHANNELS, SHARE_TARGET_TYPES, VISITOR_ID_PATTERN } from "../shared/shareTracking";

const MINUTE = 60_000;
const assessmentId = z.string().min(1).max(32);
const entityId = z.string().min(1).max(32);
/** Attached to a join/claim call when the student arrived via a tagged share link; both optional since most arrivals are still untagged DIRECT visits. */
const shareAttribution = z.object({
  channel: z.enum(SHARE_CHANNELS).optional(),
  campaign: z.enum(SHARE_CAMPAIGNS).optional(),
  visitorId: z.string().regex(VISITOR_ID_PATTERN).optional(),
});

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
    hasPassword: !!user.passwordHash,
  };
}

/**
 * Validates the recipients belong to this teacher and returns who they reach (group members only, for a GROUPS-restricted task).
 * `alreadyRecipients`: on edit, students already on the row (e.g. joined via the share link) may stay.
 */
async function assertRecipients(scope: TeacherScope, groupIds: string[], studentIds: number[], accessMode: TaskAccessMode = "PUBLIC", alreadyRecipients: readonly number[] = []) {
  for (const g of groupIds) await groups.assertGroupOwner(scope, g);
  const own = new Set([...(await groups.teacherStudentIds(scope)), ...alreadyRecipients]);
  if (!studentIds.every((s) => own.has(s))) throw new AppError("FORBIDDEN");
  const fromGroups = await groups.activeStudentIdsOfGroups(groupIds);
  return rosterStudentIds({ accessMode, groupIds, studentIds }, fromGroups);
}

/** Unknown single-use tokens are unguessable (256 bits), but repeated misses from one caller are still cut off. */
function limitInviteLinkMisses(ctx: TrpcContext) {
  const who = ctx.user ? `u:${ctx.user.id}` : `ip:${ctx.req.ip ?? "unknown"}`;
  limited(ctx, `inviteLinkMiss:${who}`, 20, 15 * MINUTE, "inviteLinkMiss");
}

function assertAccessGroups(accessMode: TaskAccessMode, groupIds: string[]) {
  if (accessMode === "GROUPS" && !groupIds.length) throw new AppError("TASK_GROUPS_REQUIRED");
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Same ?ref= / ?src= / ?campaign= passthrough the Google flow signs into its OAuth state; unknown values are dropped, never rejected. */
const signInAttribution = z.object({
  ref: z.string().max(64).optional(),
  src: z.string().max(32).optional(),
  campaign: z.string().max(64).optional(),
});

const attributionOf = (input: z.infer<typeof signInAttribution>) => ({
  ref: safeRef(input.ref),
  source: safeChannel(input.src),
  campaign: safeCampaign(input.campaign),
});

// 191 = auth_accounts.providerAccountId, which holds the email for password sign-in.
const signInEmail = z.string().trim().max(191).email();
const newPassword = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

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
      await issueSessionCookie(ctx.req, ctx.res, user);
      return publicUser(user);
    }),

  demoAvailable: publicProcedure.query(() => ENV.enableDemoLogin),

  /**
   * Email + password sign-in, the alternative to Google. Unknown email and wrong password give the
   * same INVALID_CREDENTIALS; a Google-only account's email gets GOOGLE_ACCOUNT_NO_PASSWORD. Limited per IP (generous: a whole class may share one school NAT) and
   * per email, so one account can't be brute-forced from many addresses.
   */
  passwordLogin: publicProcedure
    .use(rateLimit("passwordLogin", 30, MINUTE))
    .input(z.object({ email: signInEmail, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) }).merge(signInAttribution))
    .mutation(async ({ ctx, input }) => {
      limited(ctx, `passwordLoginEmail:${normalizeEmail(input.email)}`, 10, 15 * MINUTE, "passwordLoginEmail");
      const result = await passwordAuth.loginWithPassword(input);
      await completeSignIn(ctx.req, ctx.res, result, attributionOf(input));
      return { ok: true } as const;
    }),

  /** Creates a new account only; an email that already has any account is refused (see registerWithPassword). */
  passwordRegister: publicProcedure
    .use(rateLimit("passwordRegister", 20, 10 * MINUTE))
    .input(z.object({ name: z.string().trim().min(2).max(120), email: signInEmail, password: newPassword }).merge(signInAttribution))
    .mutation(async ({ ctx, input }) => {
      const result = await passwordAuth.registerWithPassword(input);
      await completeSignIn(ctx.req, ctx.res, result, attributionOf(input));
      return { ok: true } as const;
    }),

  /** Settings: add a password to the signed-in account (e.g. a Google account), or change it. */
  setPassword: protectedProcedure
    .use(rateLimit("setPassword", 5, 10 * MINUTE))
    .input(z.object({ currentPassword: z.string().max(PASSWORD_MAX_LENGTH).optional(), newPassword }))
    .mutation(async ({ ctx, input }) => {
      const { revokedOtherSessions } = await passwordAuth.setOwnPassword(ctx.user, ctx.session, input);
      if (revokedOtherSessions) await issueSessionCookie(ctx.req, ctx.res, ctx.user);
      return { ok: true } as const;
    }),

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
        targetExamDate: timestampIso().optional().nullable(),
        referralSource: z.enum(REFERRAL_SOURCES).optional(),
        referrerUserId: z.number().int().positive().optional(),
        referrerName: z.string().trim().min(1).max(160).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db.completeStudentOnboarding(ctx.user.id, {
        timezone: input.timezone,
        targetExam: input.targetExam,
        targetScore: input.targetScore,
        targetExamDate: input.targetExamDate === undefined ? undefined : input.targetExamDate === null ? null : new Date(input.targetExamDate),
        referralSource: input.referralSource,
        referrerUserId: input.referrerUserId,
        referrerName: input.referrerName,
      });
      return { ok: true } as const;
    }),

  /** "Who recommended you" tag search on the onboarding step — name only, nothing else about the match is exposed. */
  searchReferrer: protectedProcedure
    .use(rateLimit("searchReferrer", 30, MINUTE))
    .input(z.object({ query: z.string().trim().max(60) }))
    .query(({ ctx, input }) => db.searchUsersByName(input.query, ctx.user.id)),
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
  /** Optional so an older client mid-deploy still saves; the server then infers it (groups.typeFieldsOf). */
  groupType: z.enum(GROUP_TYPES).optional(),
  /** Fənn (school class) or İstiqamət (course). */
  subject: z.string().trim().max(120).default(""),
  /** Sinif — kept only for school classes. */
  grade: z.string().trim().max(GROUP_CLASS_MAX).default(""),
  /** Səviyyə — kept only for courses; a GROUP_LEVELS key or free text. */
  level: z.string().trim().max(GROUP_LEVEL_MAX).default(""),
  description: z.string().trim().max(2000).default(""),
  language: z.enum(GROUP_LANGUAGES).or(z.literal("")).default(""),
  format: z.enum(GROUP_FORMATS).default("ONLINE"),
  startDate: timestampIso().optional().nullable(),
  classSchedule: z
    .array(classScheduleEntryInput)
    .max(7)
    .refine((entries) => new Set(entries.map((e) => e.day)).size === entries.length, { message: "Duplicate day" })
    .default([]),
  scheduleVisible: z.boolean().default(false),
  scoresVisibleToGroup: z.boolean().default(true),
});

/** Turns the wire-format ISO string into a Date for Drizzle, passing through null/undefined untouched. */
function groupPatchForDb<T extends { startDate?: string | null }>({ startDate, ...rest }: T) {
  return { ...rest, ...(startDate === undefined ? {} : { startDate: startDate === null ? null : new Date(startDate) }) };
}

const teacherGroupsRouter = router({
  list: teacherProcedure.query(({ ctx }) => groups.teacherGroups(ctx.scope)),
  /** The type a new group's form starts on: the latest group's, else the workspace category's. */
  newGroupDefaults: teacherProcedure.query(async ({ ctx }) => ({
    groupType: defaultGroupType({
      latestGroupType: await groupProfiles.latestGroupType(ctx.scope.workspaceId),
      teachingCategory: ctx.workspace.teachingCategory,
      providerType: ctx.workspace.providerType,
    }),
  })),
  overview: teacherProcedure.query(({ ctx }) => analytics.groupsOverview(ctx.scope)),
  create: teacherProcedure.input(groupInput).mutation(({ ctx, input }) => groups.createGroup(ctx.scope, groupPatchForDb(input))),
  update: teacherProcedure
    .input(
      z.object({
        id: entityId,
        // Without these overrides `.partial()` would still fill in defaults and flip settings the patch never mentioned.
        patch: groupInput.partial().extend({
          subject: groupInput.shape.subject.removeDefault().optional(),
          grade: groupInput.shape.grade.removeDefault().optional(),
          level: groupInput.shape.level.removeDefault().optional(),
          scheduleVisible: z.boolean().optional(),
          scoresVisibleToGroup: z.boolean().optional(),
        }),
      }),
    )
    .mutation(({ ctx, input }) => groups.renameGroup(ctx.scope, input.id, groupPatchForDb(input.patch))),
  detail: teacherProcedure.input(z.object({ id: entityId })).query(async ({ ctx, input }) => {
    const group = await groups.teacherGroup(ctx.scope, input.id);
    const members = await groups.groupMembersList(ctx.scope, input.id);
    return { ...group, members };
  }),
  addMember: teacherProcedure
    .use(rateLimit("addMember", 60, MINUTE))
    .input(z.object({ groupId: entityId, email: z.string().trim().email().max(320) }))
    .mutation(async ({ ctx, input }) => {
      const added = await groups.addMemberByEmail(ctx.scope, input.groupId, input.email);
      taskNotify.notifyOpenTasksOnJoin(input.groupId, added.studentId);
      announceGroupJoin(input.groupId, added.studentId);
      return added;
    }),
  approveMember: teacherProcedure
    .input(z.object({ groupId: entityId, studentId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const result = await groups.approveMember(ctx.scope, input.groupId, input.studentId);
      taskNotify.notifyOpenTasksOnJoin(input.groupId, input.studentId);
      announceGroupJoin(input.groupId, input.studentId);
      return result;
    }),
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
    .input(z.object({ groupId: entityId, expiresAt: timestampIso().nullable() }))
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
  /** Opens/submissions per day, per-student stats and first submitters for this group's tasks. */
  activity: teacherProcedure
    .input(z.object({ groupId: entityId, days: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(14) }))
    .query(({ ctx, input }) => motivation.teacherGroupActivity(ctx.scope, input.groupId, input.days)),
  inviteLinkList: teacherProcedure
    .input(z.object({ groupId: entityId }))
    .query(({ ctx, input }) => groupInviteLinks.listInviteLinks(ctx.scope, input.groupId)),
  /** One link per label when labels are given, else `count` unlabeled links. Raw links are returned only here. */
  inviteLinkCreate: teacherProcedure
    .use(rateLimit("inviteLinkCreate", 20, MINUTE))
    .input(
      z.object({
        groupId: entityId,
        count: z.number().int().min(1).max(groupInviteLinks.MAX_INVITE_LINKS_PER_BATCH).optional(),
        labels: z.array(z.string().trim().max(120)).max(groupInviteLinks.MAX_INVITE_LINKS_PER_BATCH).optional(),
        expiresInDays: z.number().int().min(1).max(groupInviteLinks.MAX_INVITE_LINK_EXPIRY_DAYS).optional(),
      }),
    )
    .mutation(({ ctx, input }) => groupInviteLinks.createInviteLinks(ctx.scope, input.groupId, input)),
  inviteLinkRevoke: teacherProcedure
    .use(rateLimit("inviteLinkRevoke", 60, MINUTE))
    .input(z.object({ groupId: entityId, linkId: entityId }))
    .mutation(({ ctx, input }) => groupInviteLinks.revokeInviteLink(ctx.scope, input.groupId, input.linkId)),
  inviteLinkReissue: teacherProcedure
    .use(rateLimit("inviteLinkReissue", 30, MINUTE))
    .input(z.object({ groupId: entityId, linkId: entityId, expiresInDays: z.number().int().min(1).max(groupInviteLinks.MAX_INVITE_LINK_EXPIRY_DAYS).optional() }))
    .mutation(({ ctx, input }) => groupInviteLinks.reissueInviteLink(ctx.scope, input.groupId, input.linkId, input.expiresInDays)),
  /** Clicks/opens/joins on this group's invite code link and its single-use links, broken down by channel (Telegram, WhatsApp, QR, copy link). */
  shareFunnel: teacherProcedure.input(z.object({ groupId: entityId })).query(async ({ ctx, input }) => {
    const group = await groups.assertGroupOwner(ctx.scope, input.groupId);
    const targets = [group.inviteCode, ...(await groupInviteLinks.inviteLinkShareTargets(group.id))];
    return shareTracking.shareFunnel("GROUP", targets, { excludeUserIds: [ctx.user.id] });
  }),
});

const teacherQuestionsRouter = router({
  bank: teacherProcedure.input(questionBankFilter).query(({ ctx, input }) => bank.bankRows(ctx.scope, input)),
  /** A new bank question is always filed in a section, which gives it its bank number. */
  create: teacherProcedure
    .input(z.object({ question: questionInputSchema, sectionId: entityId }))
    .mutation(({ ctx, input }) => bank.createBankQuestion(ctx.scope, input.question, { sectionId: input.sectionId })),
  update: teacherProcedure
    .input(z.object({ id: entityId, question: questionInputSchema }))
    .mutation(({ ctx, input }) => bank.updateBankQuestion(ctx.scope, input.id, input.question)),
  confirmAnswers: teacherProcedure
    .input(z.object({ ids: z.array(entityId).min(1).max(200) }))
    .mutation(({ ctx, input }) => bank.confirmBankAnswers(ctx.scope, input.ids)),
});

const teacherAssessmentsRouter = router({
  list: teacherProcedure
    .input(z.object({ type: z.enum(ASSESSMENT_TYPES).optional(), liveStatus: z.enum(LIVE_STATUSES).optional() }).default({}))
    .query(({ ctx, input }) => assessments.listForTeacher(ctx.scope, input)),
  detail: teacherProcedure
    .input(z.object({ id: assessmentId }))
    .query(async ({ ctx, input }) => {
      const detail = await assessments.teacherDetail(ctx.scope, input.id);
      return { ...detail, questions: await bank.withPlacements(ctx.scope, detail.questions) };
    }),
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
    .input(z.object({ id: assessmentId, question: questionInputSchema, sectionId: entityId }))
    .mutation(({ ctx, input }) => bank.createInAssessment(ctx.scope, input.id, input.question, input.sectionId)),
  /** Hand-picked and/or randomly drawn questions from one or more bank sections. */
  addFromBank: teacherProcedure
    .input(z.object({ id: assessmentId, picks: sectionPicksSchema }))
    .mutation(({ ctx, input }) => bank.addFromBank(ctx.scope, input.id, input.picks)),
  replaceQuestion: teacherProcedure
    .input(z.object({ id: assessmentId, questionId: entityId, withQuestionId: entityId }))
    .mutation(({ ctx, input }) => assessments.replaceQuestionInAssessment(ctx.scope, input.id, input.questionId, input.withQuestionId)),
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
  /** Clicks/opens/joins on this exam's share link, broken down by channel. */
  shareFunnel: teacherProcedure.input(z.object({ id: assessmentId })).query(async ({ ctx, input }) => {
    const row = await assessments.ownedAssessment(ctx.scope, input.id);
    return shareTracking.shareFunnel("EXAM", row.shareCode, { excludeUserIds: [ctx.user.id] });
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
  /** The teacher's own AI limits (set by the platform admin) and usage against them. */
  quota: teacherProcedure.query(({ ctx }) => myAiQuota(ctx.user.id)),
  generate: teacherProcedure
    .use(rateLimit("aiGenerate", 10, MINUTE))
    .input(ai.aiGenerateSchema)
    .mutation(({ ctx, input }) => ai.generateQuestions(ctx.scope, input)),
  accept: teacherProcedure
    .input(z.object({ draftId: z.string().min(1).max(32), tempIds: z.array(z.string().min(1).max(32)).min(1).max(50), assessmentId: assessmentId.optional(), sectionId: entityId }))
    .mutation(({ ctx, input }) => ai.acceptAiQuestions(ctx.scope, input.draftId, input.tempIds, input.sectionId, input.assessmentId)),
});

const recipients = {
  groupIds: z.array(entityId).max(100).default([]),
  studentIds: z.array(z.number().int().positive()).max(1000).default([]),
};

const assignmentInput = z.object({
  title: z.string().trim().min(2).max(255),
  description: z.string().trim().max(5000).default(""),
  instructions: z.string().trim().max(5000).default(""),
  deadline: timestampDate(),
  ...recipients,
  attachments: z
    .array(z.object({ fileId: z.string().trim().min(1).max(32), name: z.string().max(255), size: z.number().int().nonnegative() }))
    .max(20)
    .default([]),
  // No .default(): zod 4 applies defaults inside .partial() too, which would reset the mode on every patch that omits it.
  accessMode: z.enum(TASK_ACCESS_MODES).optional(),
});

const materialInput = z.object({
  title: z.string().trim().min(2).max(255),
  description: z.string().trim().max(5000).default(""),
  subject: z.string().trim().max(120).default(""),
  topic: z.string().trim().max(120).default(""),
  fileName: z.string().trim().min(1).max(255),
  fileId: z.string().trim().min(1).max(32).nullable().default(null),
  mimeType: z.string().trim().max(127).nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  ...recipients,
});

/** Resolves the recipients a patch currently points at, falling back to the row's own groupIds/studentIds when the patch doesn't touch them. */
async function assertPatchedRecipients(
  scope: TeacherScope,
  current: { groupIds: string[]; studentIds: number[] },
  patch: { groupIds?: string[]; studentIds?: number[] },
) {
  return assertRecipients(scope, patch.groupIds ?? current.groupIds, patch.studentIds ?? current.studentIds, "PUBLIC", current.studentIds);
}

const teacherTasksRouter = router({
  list: teacherProcedure.query(async ({ ctx }) => {
    const rows = await tasks.listForWorkspace(ctx.scope.workspaceId);
    const keyStates = await answerKey.answerKeyStates(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, answerKeyState: keyStates.get(r.id) ?? null }));
  }),
  /** The hidden answer key / grading criteria for the task form (teacher only, never students). */
  answerKey: teacherProcedure
    .input(z.object({ taskId: entityId.optional() }))
    .query(({ ctx, input }) => answerKey.answerKeyForTeacher(ctx.scope, input.taskId)),
  saveAnswerKey: teacherProcedure
    .input(z.object({ taskId: entityId, text: z.string().max(answerKey.ANSWER_KEY_MAX_CHARS) }))
    .mutation(({ ctx, input }) => answerKey.saveAnswerKey(ctx.scope, input.taskId, input.text)),
  /** "AI ilə cavab açarı hazırla": a draft from the form's current title, description and files; not saved. */
  draftAnswerKey: teacherProcedure
    .use(rateLimit("draftAnswerKey", 5, MINUTE))
    .input(
      z.object({
        title: z.string().trim().max(255),
        description: z.string().trim().max(10_000).default(""),
        attachments: z.array(z.object({ fileId: z.string().trim().min(1).max(32), name: z.string().max(255) })).max(20).default([]),
      }),
    )
    .mutation(({ ctx, input }) => answerKey.draftAnswerKeyForTeacher(ctx.scope, input)),
  /** `notifyStudents` false: no notices for this save ("Tələbələrə bildiriş göndər" unticked). */
  create: teacherProcedure
    .input(assignmentInput.extend({ notifyStudents: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const { notifyStudents, ...fields } = input;
      const accessMode = fields.accessMode ?? "PUBLIC";
      assertAccessGroups(accessMode, fields.groupIds);
      await assertRecipients(ctx.scope, fields.groupIds, fields.studentIds, accessMode);
      return tasks.createAssignment(ctx.scope, { ...fields, accessMode }, { notify: notifyStudents });
    }),
  update: teacherProcedure
    .input(z.object({ id: entityId, patch: assignmentInput.partial(), notifyStudents: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const current = await tasks.assignmentOf(ctx.scope, input.id);
      const accessMode = input.patch.accessMode ?? current.accessMode;
      const groupIds = input.patch.groupIds ?? current.groupIds;
      const studentIds = input.patch.studentIds ?? current.studentIds;
      assertAccessGroups(accessMode, groupIds);
      const touchesRecipients = input.patch.groupIds !== undefined || input.patch.studentIds !== undefined || accessMode !== current.accessMode;
      if (touchesRecipients) await assertRecipients(ctx.scope, groupIds, studentIds, accessMode, current.studentIds);
      return tasks.updateAssignment(ctx.scope, input.id, input.patch, { notify: input.notifyStudents });
    }),
  remove: teacherProcedure.input(z.object({ id: entityId })).mutation(async ({ ctx, input }) => {
    const result = await tasks.deleteAssignment(ctx.scope, input.id);
    await answerKey.deleteAnswerKey(input.id);
    return result;
  }),
  /** Who among the students this task reaches has opened it (submission status comes separately, from `list`). */
  activity: teacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => activity.taskActivity(ctx.scope, input.id)),
  materials: teacherProcedure.query(({ ctx }) => tasks.listMaterialsForWorkspace(ctx.scope.workspaceId)),
  createMaterial: teacherProcedure
    .input(materialInput)
    .mutation(async ({ ctx, input }) => {
      await assertRecipients(ctx.scope, input.groupIds, input.studentIds);
      return tasks.createMaterial(ctx.scope, input);
    }),
  updateMaterial: teacherProcedure
    .input(z.object({ id: entityId, patch: materialInput.partial() }))
    .mutation(async ({ ctx, input }) => {
      const current = await tasks.materialOf(ctx.scope, input.id);
      if (input.patch.groupIds !== undefined || input.patch.studentIds !== undefined) {
        await assertPatchedRecipients(ctx.scope, current, input.patch);
      }
      return tasks.updateMaterial(ctx.scope, input.id, input.patch);
    }),
  removeMaterial: teacherProcedure.input(z.object({ id: entityId })).mutation(({ ctx, input }) => tasks.deleteMaterial(ctx.scope, input.id)),
  /** Who among the students this material reaches has viewed and/or downloaded it. */
  materialActivity: teacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => activity.materialActivity(ctx.scope, input.id)),
  /** Clicks/opens/joins on this task's share link, broken down by channel. */
  shareFunnel: teacherProcedure.input(z.object({ id: entityId })).query(async ({ ctx, input }) => {
    const row = await tasks.assignmentOf(ctx.scope, input.id);
    return shareTracking.shareFunnel("TASK", row.shareCode, { excludeUserIds: [ctx.user.id, row.createdBy] });
  }),
  /** AI pre-reviews of this task's submissions (advisory) plus the workspace's AI quota. */
  reviews: teacherProcedure.input(z.object({ taskId: entityId })).query(({ ctx, input }) => aiReview.reviewsForTask(ctx.scope, input.taskId)),
  rerunReview: teacherProcedure
    .use(rateLimit("rerunAiReview", 10, MINUTE))
    .input(z.object({ submissionId: entityId }))
    .mutation(({ ctx, input }) => aiReview.rerunReview(ctx.scope, input.submissionId)),
  /** Whether a clean AI review of this task's submissions becomes the released grade at once (on by default). */
  setAutoGrade: teacherProcedure
    .input(z.object({ taskId: entityId, enabled: z.boolean() }))
    .mutation(({ ctx, input }) => autoGrade.setAutoGrade(ctx.scope, input.taskId, input.enabled)),
  grade: teacherProcedure
    .input(
      z.object({
        submissionId: entityId,
        score: z.number().min(0).max(100).nullable(),
        feedback: z.string().max(4000).default(""),
        release: z.boolean(),
        shareAiFeedback: z.boolean().default(false),
      }),
    )
    .mutation(({ ctx, input }) => tasks.gradeSubmission(ctx.scope, input)),
  /** Share funnel (incl. submissions per channel) plus who opened, downloaded and submitted this task. */
  engagement: teacherProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => activity.taskEngagement(ctx.scope, input.id)),
  /** Clicks/opens/joins on this material's share link, broken down by channel. */
  materialShareFunnel: teacherProcedure.input(z.object({ id: entityId })).query(async ({ ctx, input }) => {
    const row = await tasks.materialOf(ctx.scope, input.id);
    return shareTracking.shareFunnel("MATERIAL", row.shareCode, { excludeUserIds: [ctx.user.id, row.createdBy] });
  }),
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
  questionTopics: questionTopicsRouter,
  questionImport: questionImportRouter,
  assessments: teacherAssessmentsRouter,
  results: teacherResultsRouter,
  analytics: teacherAnalyticsRouter,
  ai: teacherAiRouter,
  tasks: teacherTasksRouter,
  syllabus: teacherSyllabusRouter,
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
    .input(z.object({ inviteCode: z.string().trim().min(4).max(32) }).merge(shareAttribution))
    .mutation(async ({ ctx, input }) => {
      const code = input.inviteCode.toUpperCase();
      const joined = await groups.joinByInvite(ctx.user.id, code);
      groupJoin.afterLinkJoin(joined, ctx.user.name ?? null, groupJoin.linkJoinKey(joined.membershipId));
      await shareTracking.recordShareEvent({
        targetType: "GROUP",
        targetId: code,
        channel: input.channel ?? "DIRECT",
        eventType: "JOINED",
        campaign: input.campaign,
        actorUserId: ctx.user.id,
        visitorId: input.visitorId,
      });
      return { groupId: joined.groupId, groupName: joined.groupName, status: joined.status };
    }),
  /** Single-use invite link: the first signed-in redeemer joins as ACTIVE at once; nobody else can use it afterwards. */
  redeemInviteLink: studentProcedure
    .use(rateLimit("redeemInviteLink", 10, MINUTE))
    .input(z.object({ token: z.string().trim().min(16).max(128) }).merge(shareAttribution))
    .mutation(async ({ ctx, input }) => {
      let joined: groupInviteLinks.RedeemResult;
      try {
        joined = await groupInviteLinks.redeemInviteLink(ctx.user.id, input.token);
      } catch (error) {
        if (error instanceof AppError && error.code === "INVITE_LINK_NOT_FOUND") limitInviteLinkMisses(ctx);
        throw error;
      }
      if (joined.outcome === "JOINED") {
        groupJoin.afterLinkJoin({ ...joined, userId: ctx.user.id }, ctx.user.name ?? null, groupJoin.singleUseLinkJoinKey(joined.linkId));
        await shareTracking.recordShareEvent({
          targetType: "GROUP",
          targetId: groupInviteLinks.inviteLinkShareTarget(joined.linkId),
          channel: input.channel ?? "DIRECT",
          eventType: "JOINED",
          campaign: input.campaign,
          actorUserId: ctx.user.id,
          visitorId: input.visitorId,
        });
      }
      return { groupId: joined.groupId, groupName: joined.groupName, outcome: joined.outcome };
    }),
  acceptEmailInvite: studentProcedure
    .use(rateLimit("acceptEmailInvite", 10, MINUTE))
    .input(z.object({ token: z.string().trim().min(16).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const result = await groupEmailInvites.acceptEmailInvite(ctx.user.id, ctx.user.email ?? "", input.token);
      taskNotify.notifyOpenTasksOnJoin(result.groupId, ctx.user.id);
      announceGroupJoin(result.groupId, ctx.user.id);
      return result;
    }),
  tasks: studentProcedure.query(async ({ ctx }) => {
    const rows = await tasks.studentAssignments(ctx.user.id, await groups.activeGroupIdsOfStudent(ctx.user.id));
    await activity.markAssignmentsViewed(rows.map((r) => ({ id: r.id, providerWorkspaceId: r.providerWorkspaceId })), ctx.user.id);
    return rows;
  }),
  /** Exam progress scoped to one of the student's groups — see analytics.studentGroupProgress. */
  /** Group leaderboard: classmates' names, ranks and first places only. */
  groupBoard: studentProcedure
    .input(z.object({ groupId: entityId }))
    .query(({ ctx, input }) => motivation.studentGroupBoard(ctx.user.id, input.groupId)),
  /** The student's own activity, on-time rate, first places, released scores and group positions. */
  profile: studentProcedure.query(({ ctx }) => motivation.studentProfile(ctx.user.id)),
  groupProgress: studentProcedure
    .input(z.object({ groupId: entityId }))
    .query(({ ctx, input }) => analytics.studentGroupProgress(ctx.user.id, input.groupId)),
  submitTask: studentProcedure
    .use(rateLimit("submitTask", 20, MINUTE))
    .input(
      z.object({
        assignmentId: z.string().min(1).max(32),
        files: z
          .array(z.object({ fileId: z.string().trim().min(1).max(32), name: z.string().max(255), size: z.number().int().nonnegative() }))
          .max(10)
          .default([]),
        answerText: z.string().max(tasks.MAX_ANSWER_TEXT).default(""),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const groupIds = await groups.activeGroupIdsOfStudent(ctx.user.id);
      return tasks.submitAssignment(ctx.user.id, groupIds, input.assignmentId, input.files, input.answerText);
    }),
  materials: studentProcedure.query(async ({ ctx }) => {
    const rows = await tasks.studentMaterials(ctx.user.id, await groups.activeGroupIdsOfStudent(ctx.user.id));
    await activity.markMaterialsViewed(rows.map((r) => ({ id: r.id, providerWorkspaceId: r.providerWorkspaceId })), ctx.user.id);
    return rows;
  }),
  /** Self-enrolling via a teacher's share link: adds the student as an individual recipient. */
  claimTask: studentProcedure
    .use(rateLimit("claimTask", 20, MINUTE))
    .input(z.object({ shareCode: z.string().trim().min(4).max(32) }).merge(shareAttribution))
    .mutation(async ({ ctx, input }) => {
      const result = await tasks.claimAssignment(ctx.user.id, ctx.user.name, input.shareCode);
      await shareTracking.recordShareEvent({
        targetType: "TASK",
        targetId: input.shareCode,
        channel: input.channel ?? "DIRECT",
        eventType: "JOINED",
        campaign: input.campaign,
        actorUserId: ctx.user.id,
        visitorId: input.visitorId,
      });
      return result;
    }),
  claimMaterial: studentProcedure
    .use(rateLimit("claimMaterial", 20, MINUTE))
    .input(z.object({ shareCode: z.string().trim().min(4).max(32) }).merge(shareAttribution))
    .mutation(async ({ ctx, input }) => {
      const result = await tasks.claimMaterial(ctx.user.id, input.shareCode);
      await shareTracking.recordShareEvent({
        targetType: "MATERIAL",
        targetId: input.shareCode,
        channel: input.channel ?? "DIRECT",
        eventType: "JOINED",
        campaign: input.campaign,
        actorUserId: ctx.user.id,
        visitorId: input.visitorId,
      });
      return result;
    }),
  syllabus: studentSyllabusRouter,
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
    .query(async ({ ctx, input }) => {
      const a = await tasks.assignmentByShareCode(input.shareCode);
      if (!a) return null;
      const access = await tasks.viewerAccess(a, ctx.user?.id ?? null);
      // Nothing about a restricted task (title, files, …) leaves the server unless this visitor may see it.
      const task = canSeeTaskContent(access)
        ? { id: a.id, title: a.title, description: a.description, deadline: a.deadline, attachments: a.attachments }
        : null;
      return { access, accessMode: a.accessMode, task };
    }),
  material: publicProcedure
    .use(rateLimit("publicMaterial", 60, MINUTE))
    .input(z.object({ shareCode: z.string().trim().min(4).max(32) }))
    .query(async ({ input }) => {
      const m = await tasks.materialByShareCode(input.shareCode);
      return m
        ? { id: m.id, title: m.title, description: m.description, subject: m.subject, topic: m.topic, fileName: m.fileName, fileId: m.fileId }
        : null;
    }),
  invite: publicProcedure
    .use(rateLimit("publicInvite", 60, MINUTE))
    .input(z.object({ inviteCode: z.string().trim().min(4).max(32) }))
    .query(({ input }) => groups.publicInvite(input.inviteCode.toUpperCase())),
  emailInvite: publicProcedure
    .use(rateLimit("publicEmailInvite", 60, MINUTE))
    .input(z.object({ token: z.string().trim().min(16).max(128) }))
    .query(({ input }) => groupEmailInvites.publicEmailInvitePreview(input.token)),
  /** Single-use link preview: group details only while the link is still redeemable (or for the person who redeemed it). */
  inviteLink: publicProcedure
    .use(rateLimit("publicInviteLink", 60, MINUTE))
    .input(z.object({ token: z.string().trim().min(16).max(128) }))
    .query(async ({ ctx, input }) => {
      const preview = await groupInviteLinks.publicInviteLinkPreview(input.token, ctx.user?.id ?? null);
      if (preview.state === "NOT_FOUND") limitInviteLinkMisses(ctx);
      return preview;
    }),
  /** Shared syllabus page (`/syllabus/<code>`); separate from group invites, grants no access. */
  syllabus: publicSyllabusProcedure,
  /**
   * Fire-and-forget click/open/download logging for a share link, callable anonymously (pre-login)
   * and without a `targetId` existence check — it only ever feeds a teacher/partner-facing count,
   * so a stray or spoofed row has no effect beyond slightly noisy analytics. "JOINED" is never
   * accepted here; it is only ever recorded server-side, tied to the actor, by the mutation that
   * actually performs the join/claim (see student.join / claimTask / claimMaterial). "CLICKED" is
   * the sender's own share-button press (see shared/shareTracking.ts); "OPENED" and "DOWNLOADED"
   * are both recipient-side, fired from the public page itself.
   */
  shareEvent: publicProcedure
    // Anonymous calls are keyed by IP, and a whole class often shares one school NAT address.
    .use(rateLimit("shareEvent", 120, MINUTE))
    .input(
      z.object({
        targetType: z.enum(SHARE_TARGET_TYPES),
        targetId: z.string().trim().min(1).max(64),
        channel: z.enum(SHARE_CHANNELS),
        eventType: z.enum(["CLICKED", "OPENED", "DOWNLOADED"]),
        campaign: z.enum(SHARE_CAMPAIGNS).optional(),
        visitorId: z.string().regex(VISITOR_ID_PATTERN).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await shareTracking.recordShareEvent({ ...input, actorUserId: ctx.user?.id ?? null });
      return { ok: true };
    }),
});

const inboxRouter = router({
  list: protectedProcedure.query(({ ctx }) => notifications.listFor(ctx.user.id)),
  read: protectedProcedure.input(z.object({ id: z.string().min(1).max(32) })).mutation(async ({ ctx, input }) => {
    await notifications.markRead(ctx.user.id, input.id);
    return { ok: true };
  }),
  /** Which events reach this user on which channel (all on unless turned off). */
  preferences: protectedProcedure.query(({ ctx }) => notificationPreferences.preferencesFor(ctx.user.id)),
  setPreference: protectedProcedure
    .use(rateLimit("notificationPreference", 60, MINUTE))
    .input(z.object({ event: z.enum(EVENT_TYPES), channel: z.enum(CHANNELS), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await notificationPreferences.setPreference(ctx.user.id, input.event, input.channel, input.enabled);
      return { ok: true };
    }),
});

/** Mobile push tokens; the app registers after sign-in and unregisters on sign-out. See docs/NOTIFICATIONS.md. */
const pushToken = z
  .string()
  .trim()
  .min(8)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, "INVALID_TOKEN");

const devicesRouter = router({
  register: protectedProcedure
    .use(rateLimit("registerDevice", 20, MINUTE))
    .input(z.object({ platform: z.enum(PUSH_PLATFORMS), token: pushToken, provider: z.enum(push.PUSH_PROVIDERS).default("expo") }))
    .mutation(async ({ ctx, input }) => {
      await push.registerDevice(ctx.user.id, input);
      return { ok: true, pushEnabled: push.pushEnabled() };
    }),
  unregister: protectedProcedure
    .use(rateLimit("unregisterDevice", 20, MINUTE))
    .input(z.object({ token: pushToken }))
    .mutation(async ({ ctx, input }) => {
      await push.unregisterDevice(ctx.user.id, input.token);
      return { ok: true };
    }),
});

/**
 * Browser push for signed-in users and anonymous visitors. The client re-syncs its subscription on
 * every visit with permission granted, so the owner follows the session (sign-in attaches, sign-out detaches).
 */
const webPushRouter = router({
  /** The VAPID public key is read at request time, so changing it on Railway needs no client rebuild. */
  config: publicProcedure.query(() => {
    const config = webPush.webPushConfig();
    return { enabled: !!config, publicKey: config?.publicKey ?? null };
  }),
  subscribe: publicProcedure
    .use(rateLimit("webPushSubscribe", 20, MINUTE))
    .input(z.object({ subscription: webPush.webPushSubscriptionInput, locale: z.enum(["az", "en", "ru"]) }))
    .mutation(async ({ ctx, input }) => {
      if (!webPush.webPushEnabled()) return { ok: false, enabled: false };
      const userId = ctx.user && ctx.user.accountStatus !== "SUSPENDED" ? ctx.user.id : null;
      const userAgent = typeof ctx.req.headers?.["user-agent"] === "string" ? ctx.req.headers["user-agent"] : null;
      await webPush.saveSubscription({ ...input.subscription, userId, locale: input.locale, userAgent });
      return { ok: true, enabled: true };
    }),
  unsubscribe: publicProcedure
    .use(rateLimit("webPushUnsubscribe", 20, MINUTE))
    .input(z.object({ endpoint: z.string().max(2048).refine(webPush.isPushServiceEndpoint, "INVALID_ENDPOINT") }))
    .mutation(async ({ input }) => webPush.deleteSubscription(input.endpoint)),
});

// ---------------------------------------------------------------------------
// Contexts: workspaces, partner, admin
// ---------------------------------------------------------------------------

const workspacesRouter = router({
  mine: protectedProcedure.query(async ({ ctx }) => (await resolveAccess(ctx.user.id)).workspaces),
  /** Today's AI pre-review usage against the daily cap, per owned workspace (read-only). */
  aiUsage: protectedProcedure.query(({ ctx }) => aiReview.usageForOwner(ctx.user.id)),
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
  /** Every user is auto-provisioned a referral profile on first lookup -- see `ensurePartnerProfile`. */
  profile: protectedProcedure.query(async ({ ctx }) => {
    const p = await ensurePartnerProfile(ctx.user.id);
    return { status: p.status, referralCode: p.status === "APPROVED" ? p.referralCode : null };
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
  /**
   * Real clicks/opens/signups by channel, plus the masked list of who actually signed up through
   * this partner's link. Deliberately no earnings/commission figures: this app has no payment or
   * subscription system yet, so there is nothing real to compute a commission from -- showing a
   * number there would be exactly the fabricated stat this feature's own spec says never to show.
   */
  referralStats: partnerProcedure.query(({ ctx }) => referrals.referralStats(ctx.partner.id, ctx.partner.referralCode)),
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
  devices: devicesRouter,
  webPush: webPushRouter,
});

export type AppRouter = typeof appRouter;
