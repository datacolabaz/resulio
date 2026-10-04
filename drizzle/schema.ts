import {
  bigint,
  boolean,
  double,
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  ACTIVITY_ENTITY_TYPES,
  ATTEMPT_STATUSES,
  DEFAULT_INACTIVITY_MINUTES,
  type ActivityEventType,
  type AnswerKey,
  type AssessmentSettings,
  type QuestionContent,
  type StudentAnswer,
} from "../shared/assessment";
import {
  ACCOUNT_STATUSES,
  ADMIN_ROLES,
  PARTNER_STATUSES,
  SECURITY_EVENT_STATUSES,
  SECURITY_SEVERITIES,
  type AuditAction,
  type AuditTargetType,
  type SecurityEventType,
} from "../shared/adminPermissions";
import { REFERRAL_SOURCES } from "../shared/referralSources";
import type { ClassScheduleEntry } from "../shared/schedule";
import { SHARE_CHANNELS, SHARE_EVENT_TYPES, SHARE_TARGET_TYPES } from "../shared/shareTracking";
import {
  APPROVAL_DECISIONS,
  APPROVAL_TARGET_TYPES,
  LESSON_PROGRESS_STATES,
  MODULE_PROGRESS_STATES,
  SYLLABUS_ENROLLMENT_STATUSES,
  SYLLABUS_GRANT_STATUSES,
  SYLLABUS_ITEM_KINDS,
  SYLLABUS_ITEM_SCOPES,
  SYLLABUS_NODE_STATUSES,
  SYLLABUS_STATUSES,
  SYLLABUS_VERSION_STATUSES,
  UNLOCK_SOURCES,
  UNLOCK_TARGET_TYPES,
  type CompletionRulesPatch,
} from "../shared/syllabus";

const ID = 32;
const id = (name: string) => varchar(name, { length: ID });

export const UI_CONTEXTS = ["learning", "teaching", "partner"] as const;
export type UiContext = (typeof UI_CONTEXTS)[number];

/**
 * One row per human. Carries no role: learning, teaching and partner capabilities are
 * derived from group memberships, owned provider workspaces and partner profiles.
 */
export const users = mysqlTable(
  "users",
  {
    id: int("id").autoincrement().primaryKey(),
    /** Internal, provider-independent identifier carried in the session token. */
    openId: varchar("openId", { length: 64 }).notNull().unique(),
    name: text("name"),
    email: varchar("email", { length: 320 }),
    avatarUrl: text("avatarUrl"),
    loginMethod: varchar("loginMethod", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
    preferredLocale: varchar("preferredLocale", { length: 8 }).default("az"),
    /** UI preference only; never used for authorization. */
    lastActiveContext: mysqlEnum("lastActiveContext", UI_CONTEXTS),
    /** SUSPENDED blocks every protected procedure; the reason lives in audit_logs. */
    accountStatus: mysqlEnum("accountStatus", ACCOUNT_STATUSES).notNull().default("ACTIVE"),
    suspendedAt: timestamp("suspendedAt"),
    /** Session tokens issued before this instant are rejected. */
    sessionsValidAfter: timestamp("sessionsValidAfter", { fsp: 3 }),
    /** Last authenticated request, refreshed at most every few minutes. */
    lastSeenAt: timestamp("lastSeenAt"),
    /** IANA zone, captured client-side (e.g. browser Intl) at onboarding; display-only, never authoritative for deadlines. */
    timezone: varchar("timezone", { length: 64 }),
    /** Free text, e.g. "IELTS" or "Digər"; not a fixed enum so the offered list can change without a migration. */
    targetExam: varchar("targetExam", { length: 64 }),
    /** Free text: exam scoring formats vary too widely for a single numeric column (band score, percent, raw score). */
    targetScore: varchar("targetScore", { length: 32 }),
    targetExamDate: timestamp("targetExamDate"),
    /** Set once the student onboarding step is saved OR explicitly skipped; gates showing it again. */
    studentOnboardedAt: timestamp("studentOnboardedAt"),
    /** Captured at the same onboarding step as targetExam; optional, for the team's own acquisition tracking. */
    referralSource: mysqlEnum("referralSource", REFERRAL_SOURCES),
    /** Set only when referralSource is REFERRAL and the student tagged an existing Resulio user. Not a DB foreign key (same light-touch style as other user-id references in this schema), just an id. */
    referrerUserId: int("referrerUserId"),
    /** Set only when referralSource is REFERRAL and the student typed a name instead of tagging a user (that person isn't on Resulio, or the student couldn't find them). */
    referrerName: varchar("referrerName", { length: 160 }),
    /** Set the first time the first-login "share Resulio, earn a commission" card is shown or skipped. Shown at most once, ever, regardless of outcome. */
    referralOnboardingSeenAt: timestamp("referralOnboardingSeenAt"),
    /** Set when the teacher dismisses the dashboard referral card; the card reappears once this is more than 30 days old. */
    referralCardDismissedAt: timestamp("referralCardDismissedAt"),
    /** scrypt hash (server/_core/password.ts) for email + password sign-in; null = no password set. Never returned to clients. */
    passwordHash: varchar("passwordHash", { length: 255 }),
  },
  (t) => [index("users_account_status_idx").on(t.accountStatus), index("users_last_seen_idx").on(t.lastSeenAt)],
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const authAccounts = mysqlTable(
  "auth_accounts",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerAccountId: varchar("providerAccountId", { length: 191 }).notNull(),
    providerEmail: varchar("providerEmail", { length: 320 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("auth_accounts_provider_account_unique").on(t.provider, t.providerAccountId),
    index("auth_accounts_user_idx").on(t.userId),
  ],
);

export const PROVIDER_TYPES = ["TEACHER", "TRAINER", "CENTER", "SCHOOL"] as const;
export const SUBSCRIPTION_STATUSES = ["BETA", "TRIAL", "ACTIVE", "PAST_DUE", "CANCELED"] as const;

/** A teacher's or trainer's teaching space. Owns groups, questions, assessments and the subscription. */
export const providerWorkspaces = mysqlTable(
  "provider_workspaces",
  {
    id: id("id").primaryKey(),
    ownerUserId: int("ownerUserId").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    publicDisplayName: varchar("publicDisplayName", { length: 255 }).notNull().default(""),
    providerType: mysqlEnum("providerType", PROVIDER_TYPES).notNull().default("TEACHER"),
    subscriptionStatus: mysqlEnum("subscriptionStatus", SUBSCRIPTION_STATUSES).notNull().default("BETA"),
    /** One of TEACHING_CATEGORIES (shared/teachingCategories.ts). Plain varchar, not a DB enum, so the list can grow without a migration. */
    teachingCategory: varchar("teachingCategory", { length: 32 }).notNull().default("OTHER"),
    /** A known subcategory key for `teachingCategory`, or free text the teacher typed when they picked "Digər". */
    teachingSubcategory: varchar("teachingSubcategory", { length: 120 }).notNull().default(""),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("provider_workspaces_owner_idx").on(t.ownerUserId)],
);

export const GROUP_FORMATS = ["ONLINE", "IN_PERSON", "HYBRID"] as const;
/**
 * AUTO: `joinByInvite` activates membership immediately. APPROVAL: membership starts PENDING,
 * the teacher approves it. MANUAL: self-join is refused outright — the teacher must add every
 * student with `addMemberByEmail`. The invite code/link is the same value for both AUTO and
 * APPROVAL; Resulio does not keep a separate token per channel (see groups.ts).
 */
export const GROUP_JOIN_POLICIES = ["AUTO", "APPROVAL", "MANUAL"] as const;

export const groups = mysqlTable(
  "study_groups",
  {
    id: id("id").primaryKey(),
    providerWorkspaceId: id("providerWorkspaceId").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 120 }).notNull().default(""),
    grade: varchar("grade", { length: 32 }).notNull().default(""),
    description: text("description"),
    /** Free text so the list of teaching languages never needs a migration to extend. */
    language: varchar("language", { length: 64 }).notNull().default(""),
    format: mysqlEnum("format", GROUP_FORMATS).notNull().default("ONLINE"),
    startDate: timestamp("startDate"),
    /** Weekly meeting times, e.g. [{day:"WED",time:"17:00"},{day:"SAT",time:"11:00"}]. See shared/schedule.ts. */
    classSchedule: json("classSchedule").$type<ClassScheduleEntry[]>().notNull().default([]),
    /** Whether classSchedule/startDate are shown on the public join-preview screen. */
    scheduleVisible: boolean("scheduleVisible").notNull().default(false),
    /** Whether members see each other's released task scores; their own released scores are always visible. */
    scoresVisibleToGroup: boolean("scoresVisibleToGroup").notNull().default(true),
    inviteCode: varchar("inviteCode", { length: 32 }).notNull().unique(),
    joinPolicy: mysqlEnum("joinPolicy", GROUP_JOIN_POLICIES).notNull().default("APPROVAL"),
    /** Deactivating stops new joins without burning the code value the way regenerating does. */
    codeActive: boolean("codeActive").notNull().default(true),
    codeExpiresAt: timestamp("codeExpiresAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("groups_workspace_idx").on(t.providerWorkspaceId)],
);

export const MEMBERSHIP_ROLES = ["STUDENT"] as const;

/** A user's status inside another provider's group. ACTIVE STUDENT rows define the learning context. */
export const groupMembers = mysqlTable(
  "group_members",
  {
    id: int("id").autoincrement().primaryKey(),
    groupId: id("groupId").notNull(),
    userId: int("userId").notNull(),
    membershipRole: mysqlEnum("membershipRole", MEMBERSHIP_ROLES).notNull().default("STUDENT"),
    status: mysqlEnum("status", ["PENDING", "ACTIVE"]).notNull().default("PENDING"),
    joinedAt: timestamp("joinedAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("group_members_group_user_unique").on(t.groupId, t.userId),
    index("group_members_user_idx").on(t.userId),
  ],
);

export const EMAIL_INVITE_STATUSES = ["PENDING", "ACCEPTED", "REVOKED"] as const;

/**
 * A one-time, email-restricted group invite. The raw token is shown to the teacher exactly once
 * at creation (or resend) and is never persisted — only its SHA-256 hash is stored, so a leaked
 * database row cannot be used to join a group. Expiry is enforced on top of `status` so a PENDING
 * row still refuses to accept once `expiresAt` has passed.
 */
export const groupEmailInvites = mysqlTable(
  "group_email_invites",
  {
    id: id("id").primaryKey(),
    groupId: id("groupId").notNull(),
    invitedByUserId: int("invitedByUserId").notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    status: mysqlEnum("status", EMAIL_INVITE_STATUSES).notNull().default("PENDING"),
    expiresAt: timestamp("expiresAt").notNull(),
    acceptedAt: timestamp("acceptedAt"),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    index("group_email_invites_group_idx").on(t.groupId),
    index("group_email_invites_email_idx").on(t.email),
  ],
);

/**
 * A single-use group invite link. Like `group_email_invites`, only the SHA-256 of the 256-bit token
 * is stored — the raw link is shown to the teacher once, at creation. The first signed-in student
 * to redeem it is bound to it (`usedByUserId`, set by one conditional UPDATE so two simultaneous
 * redemptions can never both win) and joins as ACTIVE immediately; for everyone else the link is
 * dead. Status is derived (see groupInviteLinks.ts), never stored.
 */
export const groupInviteLinks = mysqlTable(
  "group_invite_links",
  {
    id: id("id").primaryKey(),
    groupId: id("groupId").notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    /** Teacher-only note, e.g. the student the link is meant for. Never shown on the public page. */
    label: varchar("label", { length: 120 }).notNull().default(""),
    createdByUserId: int("createdByUserId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    usedByUserId: int("usedByUserId"),
    usedAt: timestamp("usedAt"),
    revokedAt: timestamp("revokedAt"),
  },
  (t) => [index("group_invite_links_group_idx").on(t.groupId, t.createdAt)],
);

export const partnerProfiles = mysqlTable("partner_profiles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  status: mysqlEnum("status", PARTNER_STATUSES).notNull().default("PENDING"),
  referralCode: varchar("referralCode", { length: 32 }).notNull().unique(),
  approvedAt: timestamp("approvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  applicationAnswers: json("applicationAnswers").$type<Record<string, string>>(),
  decidedBy: int("decidedBy"),
  decidedAt: timestamp("decidedAt"),
});

/**
 * Append-only click/open/join tracking for public share links (group invite codes, task/exam/
 * material share codes, and partner referral codes). `targetId` is the already-public code the
 * link carries (the group's inviteCode, an assessment/task/material's shareCode, or a partner's
 * referralCode) -- never a second identifier to keep in sync. No row is ever updated or deleted;
 * counts are always computed live from this table so they can never drift from what happened.
 */
export const shareEvents = mysqlTable(
  "share_events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    targetType: mysqlEnum("targetType", SHARE_TARGET_TYPES).notNull(),
    targetId: varchar("targetId", { length: 64 }).notNull(),
    channel: mysqlEnum("channel", SHARE_CHANNELS).notNull().default("DIRECT"),
    eventType: mysqlEnum("eventType", SHARE_EVENT_TYPES).notNull(),
    /** Which surface generated the link, e.g. "group_join", "profile_referral". Free-form, not a DB enum, so a new placement never needs a migration. */
    campaign: varchar("campaign", { length: 40 }),
    /** Set when the actor was signed in at the time of the event (e.g. a JOINED event); NULL for anonymous CLICKED/OPENED. */
    actorUserId: int("actorUserId"),
    /** Random per-browser id from the recipient's localStorage: de-duplicates anonymous visitors and links their pre-login events to the account they later sign in with. */
    visitorId: varchar("visitorId", { length: 40 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("share_events_target_idx").on(t.targetType, t.targetId, t.createdAt)],
);

/**
 * Who referred a new signup, captured once at account creation (never updated -- first valid
 * referral wins). `userId` is unique so a second attribution attempt for the same user always
 * fails harmlessly; there is deliberately no commission/earnings column here because no payment
 * system exists yet in this app -- that ledger is a separate, later addition once payments do.
 */
export const referralAttributions = mysqlTable(
  "referral_attributions",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().unique(),
    partnerId: int("partnerId").notNull(),
    referralCode: varchar("referralCode", { length: 32 }).notNull(),
    channel: mysqlEnum("channel", SHARE_CHANNELS).notNull().default("DIRECT"),
    campaign: varchar("campaign", { length: 40 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("referral_attributions_partner_idx").on(t.partnerId, t.createdAt)],
);

export const PLATFORM_ROLES = ADMIN_ROLES;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Global platform authority only. Never STUDENT / TEACHER / PARTNER. */
export const platformRoles = mysqlTable(
  "platform_roles",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    role: mysqlEnum("role", PLATFORM_ROLES).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    /** NULL for rows created by migrations or the ops script. */
    createdBy: int("createdBy"),
  },
  (t) => [uniqueIndex("platform_roles_user_role_unique").on(t.userId, t.role)],
);

/** Question bank and draft questions. Mutable; never read by attempts or grading. */
export const questions = mysqlTable(
  "questions",
  {
    id: id("id").primaryKey(),
    providerWorkspaceId: id("providerWorkspaceId").notNull(),
    createdBy: int("createdBy").notNull(),
    type: varchar("type", { length: 32 }).notNull(),
    text: text("text").notNull(),
    points: double("points").notNull().default(1),
    difficulty: mysqlEnum("difficulty", ["EASY", "MEDIUM", "HARD"]).notNull().default("MEDIUM"),
    topic: varchar("topic", { length: 120 }).notNull().default(""),
    skill: varchar("skill", { length: 120 }).notNull().default(""),
    tags: json("tags").$type<string[]>().notNull(),
    explanation: text("explanation"),
    imageUrl: text("imageUrl"),
    content: json("content").$type<QuestionContent>().notNull(),
    answerKey: json("answerKey").$type<AnswerKey>().notNull(),
    source: mysqlEnum("source", ["MANUAL", "AI"]).notNull().default("MANUAL"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    index("questions_workspace_idx").on(t.providerWorkspaceId),
    index("questions_topic_idx").on(t.providerWorkspaceId, t.topic),
  ],
);

export const assessments = mysqlTable(
  "assessments",
  {
    id: id("id").primaryKey(),
    providerWorkspaceId: id("providerWorkspaceId").notNull(),
    createdBy: int("createdBy").notNull(),
    type: mysqlEnum("type", ["EXAM", "KSQ", "BSQ"]).notNull(),
    status: mysqlEnum("status", ["DRAFT", "PUBLISHED", "CLOSED"]).notNull().default("DRAFT"),
    /** Draft attempt rules; copied into a version on publish. */
    settings: json("settings").$type<AssessmentSettings>().notNull(),
    /** Availability window. Operational, can be adjusted after publish. */
    startAt: timestamp("startAt"),
    endAt: timestamp("endAt"),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Baku"),
    shareCode: varchar("shareCode", { length: 16 }).notNull().unique(),
    currentVersionId: id("currentVersionId"),
    hasDraftChanges: boolean("hasDraftChanges").notNull().default(true),
    /** Minutes without activity before the teacher sees "inactive"; null hides it. Operational, not versioned. */
    inactivityThresholdMinutes: int("inactivityThresholdMinutes").default(DEFAULT_INACTIVITY_MINUTES),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("assessments_workspace_idx").on(t.providerWorkspaceId, t.type)],
);

/** Ordered question list of the draft being edited. */
export const assessmentQuestions = mysqlTable(
  "assessment_questions",
  {
    assessmentId: id("assessmentId").notNull(),
    questionId: id("questionId").notNull(),
    position: int("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.assessmentId, t.questionId] })],
);

/**
 * Who may take an assessment, pinned to a concrete version. A null version means the
 * assessment was not yet published when assigned; it is pinned at first publish.
 */
export const assessmentAssignments = mysqlTable(
  "assessment_assignments",
  {
    id: int("id").autoincrement().primaryKey(),
    assessmentId: id("assessmentId").notNull(),
    assessmentVersionId: id("assessmentVersionId"),
    groupId: id("groupId"),
    studentId: int("studentId"),
    availableFrom: timestamp("availableFrom"),
    availableUntil: timestamp("availableUntil"),
    durationOverrideSeconds: int("durationOverrideSeconds"),
    attemptLimitOverride: int("attemptLimitOverride"),
    status: mysqlEnum("status", ["ACTIVE", "REVOKED"]).notNull().default("ACTIVE"),
    assignedBy: int("assignedBy").notNull(),
    assignedAt: timestamp("assignedAt").defaultNow().notNull(),
  },
  (t) => [
    index("assessment_assignments_assessment_idx").on(t.assessmentId),
    index("assessment_assignments_group_idx").on(t.groupId),
    index("assessment_assignments_student_idx").on(t.studentId),
  ],
);

/** Immutable published snapshot. Rows here are never updated except status. */
export const assessmentVersions = mysqlTable(
  "assessment_versions",
  {
    id: id("id").primaryKey(),
    assessmentId: id("assessmentId").notNull(),
    versionNo: int("versionNo").notNull(),
    status: mysqlEnum("status", ["PUBLISHED", "ARCHIVED"]).notNull().default("PUBLISHED"),
    settings: json("settings").$type<AssessmentSettings>().notNull(),
    publishedBy: int("publishedBy").notNull(),
    publishedAt: timestamp("publishedAt").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("assessment_versions_no_unique").on(t.assessmentId, t.versionNo)],
);

/** Questions frozen into a version, including the protected answer key. */
export const versionQuestions = mysqlTable(
  "version_questions",
  {
    id: id("id").primaryKey(),
    versionId: id("versionId").notNull(),
    sourceQuestionId: id("sourceQuestionId"),
    position: int("position").notNull(),
    type: varchar("type", { length: 32 }).notNull(),
    text: text("text").notNull(),
    points: double("points").notNull(),
    difficulty: mysqlEnum("difficulty", ["EASY", "MEDIUM", "HARD"]).notNull(),
    topic: varchar("topic", { length: 120 }).notNull().default(""),
    skill: varchar("skill", { length: 120 }).notNull().default(""),
    explanation: text("explanation"),
    imageUrl: text("imageUrl"),
    content: json("content").$type<QuestionContent>().notNull(),
    answerKey: json("answerKey").$type<AnswerKey>().notNull(),
  },
  (t) => [index("version_questions_version_idx").on(t.versionId, t.position)],
);

export const attempts = mysqlTable(
  "attempts",
  {
    id: id("id").primaryKey(),
    assessmentId: id("assessmentId").notNull(),
    versionId: id("versionId").notNull(),
    assignmentId: int("assignmentId").notNull(),
    studentId: int("studentId").notNull(),
    attemptNo: int("attemptNo").notNull(),
    status: mysqlEnum("status", ATTEMPT_STATUSES).notNull().default("IN_PROGRESS"),
    questionOrder: json("questionOrder").$type<string[]>().notNull(),
    startedAt: timestamp("startedAt").notNull(),
    /** Server expiry; the client timer is display only. */
    deadlineAt: timestamp("deadlineAt").notNull(),
    submittedAt: timestamp("submittedAt"),
    /** Answer changes and question navigation. Drives the derived "inactive" state. */
    lastActivityAt: timestamp("lastActivityAt"),
    lastAutosaveAt: timestamp("lastAutosaveAt"),
    /** Page open signal only; never resets inactivity. */
    lastHeartbeatAt: timestamp("lastHeartbeatAt"),
    answeredCount: int("answeredCount").notNull().default(0),
    totalQuestionCount: int("totalQuestionCount").notNull().default(0),
    autoSubmittedAt: timestamp("autoSubmittedAt"),
    voidedBy: int("voidedBy"),
    voidedAt: timestamp("voidedAt"),
  },
  (t) => [
    uniqueIndex("attempts_student_no_unique").on(t.assessmentId, t.studentId, t.attemptNo),
    index("attempts_status_deadline_idx").on(t.status, t.deadlineAt),
    index("attempts_student_idx").on(t.studentId),
    index("attempts_assessment_status_idx").on(t.assessmentId, t.status),
  ],
);

export const studentAnswers = mysqlTable(
  "student_answers",
  {
    attemptId: id("attemptId").notNull(),
    versionQuestionId: id("versionQuestionId").notNull(),
    answer: json("answer").$type<StudentAnswer>(),
    /** Client-side monotonic counter; a write with a lower revision is a stale retry and is ignored. */
    revision: int("revision").notNull().default(0),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.attemptId, t.versionQuestionId] })],
);

export const results = mysqlTable(
  "results",
  {
    id: id("id").primaryKey(),
    attemptId: id("attemptId").notNull().unique(),
    assessmentId: id("assessmentId").notNull(),
    versionId: id("versionId").notNull(),
    studentId: int("studentId").notNull(),
    totalPoints: double("totalPoints").notNull(),
    earnedPoints: double("earnedPoints").notNull(),
    percentage: double("percentage").notNull(),
    correctCount: int("correctCount").notNull(),
    wrongCount: int("wrongCount").notNull(),
    unansweredCount: int("unansweredCount").notNull(),
    pendingReviewCount: int("pendingReviewCount").notNull().default(0),
    durationSeconds: int("durationSeconds").notNull(),
    completedAt: timestamp("completedAt").notNull(),
  },
  (t) => [index("results_assessment_idx").on(t.assessmentId), index("results_student_idx").on(t.studentId)],
);

export const resultItems = mysqlTable(
  "result_items",
  {
    resultId: id("resultId").notNull(),
    versionQuestionId: id("versionQuestionId").notNull(),
    status: mysqlEnum("status", ["CORRECT", "WRONG", "UNANSWERED", "PENDING_REVIEW"]).notNull(),
    earned: double("earned").notNull(),
    topic: varchar("topic", { length: 120 }).notNull().default(""),
    skill: varchar("skill", { length: 120 }).notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.resultId, t.versionQuestionId] }),
    index("result_items_question_idx").on(t.versionQuestionId),
  ],
);

/** Append-only history. Never updated; removed only by the retention policy. Counts come from progress tables. */
export const studentActivityEvents = mysqlTable(
  "student_activity_events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    providerWorkspaceId: id("providerWorkspaceId").notNull(),
    groupId: id("groupId"),
    entityType: mysqlEnum("entityType", ACTIVITY_ENTITY_TYPES).notNull(),
    entityId: varchar("entityId", { length: 64 }).notNull(),
    eventType: varchar("eventType", { length: 40 }).$type<ActivityEventType>().notNull(),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    index("activity_entity_idx").on(t.providerWorkspaceId, t.entityType, t.entityId, t.createdAt),
    index("activity_user_idx").on(t.userId, t.createdAt),
  ],
);

/** One row per student and assessment, created on first activity. Roster totals come from membership. */
export const assessmentStudentProgress = mysqlTable(
  "assessment_student_progress",
  {
    id: int("id").autoincrement().primaryKey(),
    assessmentId: id("assessmentId").notNull(),
    assignmentId: int("assignmentId"),
    versionId: id("versionId"),
    studentId: int("studentId").notNull(),
    viewedAt: timestamp("viewedAt"),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    expiredAt: timestamp("expiredAt"),
    resultReleasedAt: timestamp("resultReleasedAt"),
    latestActivityAt: timestamp("latestActivityAt"),
    attemptCount: int("attemptCount").notNull().default(0),
    activeAttemptId: id("activeAttemptId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex("assessment_progress_student_unique").on(t.assessmentId, t.studentId),
    index("assessment_progress_activity_idx").on(t.assessmentId, t.latestActivityAt),
  ],
);

/**
 * Append-only record of sensitive platform actions. The application never updates or deletes rows;
 * docs/migrations/audit-append-only-triggers.sql enforces the same in the database.
 */
export const auditLogs = mysqlTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** NULL = SYSTEM (migration or ops script). */
    actorUserId: int("actorUserId"),
    actorAdminRole: varchar("actorAdminRole", { length: 32 }),
    action: varchar("action", { length: 64 }).$type<AuditAction>().notNull(),
    targetType: varchar("targetType", { length: 32 }).$type<AuditTargetType>().notNull(),
    targetId: varchar("targetId", { length: 64 }),
    workspaceId: id("workspaceId"),
    userId: int("userId"),
    beforeJson: json("beforeJson").$type<Record<string, unknown>>(),
    afterJson: json("afterJson").$type<Record<string, unknown>>(),
    reason: text("reason"),
    requestId: varchar("requestId", { length: 36 }),
    ipHash: varchar("ipHash", { length: 64 }),
    userAgentSummary: varchar("userAgentSummary", { length: 120 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    index("audit_created_idx").on(t.createdAt),
    index("audit_actor_idx").on(t.actorUserId, t.createdAt),
    index("audit_target_idx").on(t.targetType, t.targetId, t.createdAt),
    index("audit_user_idx").on(t.userId, t.createdAt),
    index("audit_workspace_idx").on(t.workspaceId, t.createdAt),
    index("audit_action_idx").on(t.action, t.createdAt),
  ],
);

/** Signals for human review. Repeats of the same signal within a short window increment `occurrences`. */
export const securityEvents = mysqlTable(
  "security_events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    type: varchar("type", { length: 40 }).$type<SecurityEventType>().notNull(),
    severity: mysqlEnum("severity", SECURITY_SEVERITIES).notNull(),
    status: mysqlEnum("status", SECURITY_EVENT_STATUSES).notNull().default("REVIEW_REQUIRED"),
    userId: int("userId"),
    workspaceId: id("workspaceId"),
    ipHash: varchar("ipHash", { length: 64 }),
    details: json("details").$type<Record<string, unknown>>(),
    occurrences: int("occurrences").notNull().default(1),
    firstSeenAt: timestamp("firstSeenAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy"),
    reviewedAt: timestamp("reviewedAt"),
  },
  (t) => [
    index("security_status_idx").on(t.status, t.lastSeenAt),
    index("security_type_idx").on(t.type, t.lastSeenAt),
    index("security_user_idx").on(t.userId),
  ],
);

/** Global state of a registered flag (shared/featureFlags.ts). A missing row means the code default. */
export const featureFlags = mysqlTable("feature_flags", {
  key: varchar("key", { length: 64 }).primaryKey(),
  enabled: boolean("enabled").notNull(),
  updatedBy: int("updatedBy"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const featureFlagOverrides = mysqlTable(
  "feature_flag_overrides",
  {
    id: int("id").autoincrement().primaryKey(),
    flagKey: varchar("flagKey", { length: 64 }).notNull(),
    scopeType: mysqlEnum("scopeType", ["USER", "WORKSPACE"]).notNull(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull(),
    createdBy: int("createdBy"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("feature_flag_override_scope_unique").on(t.flagKey, t.scopeType, t.scopeId)],
);

export const TASK_SUBMISSION_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "LATE", "REVIEWED"] as const;

/**
 * Who may open a task's share link (and its attached files). PUBLIC: anyone holding the link.
 * GROUPS: only signed-in ACTIVE members of the task's own `groupIds` (plus the owning teacher);
 * individually listed `studentIds` — which share-link claims also append to — grant nothing then.
 * See server/modules/taskAccess.ts.
 */
export const TASK_ACCESS_MODES = ["PUBLIC", "GROUPS"] as const;
export type TaskAccessMode = (typeof TASK_ACCESS_MODES)[number];

/**
 * A homework/assignment a teacher sends to a group and/or individual students. `groupIds`/
 * `studentIds` are JSON rather than join tables — same free-list convention as
 * `groups.classSchedule` — since they're never queried relationally, only read back whole and
 * filtered in application code.
 */
export const tasks = mysqlTable(
  "tasks",
  {
    id: id("id").primaryKey(),
    providerWorkspaceId: id("providerWorkspaceId").notNull(),
    createdBy: int("createdBy").notNull(),
    shareCode: varchar("shareCode", { length: 16 }).notNull().unique(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description").notNull(),
    instructions: text("instructions").notNull(),
    deadline: timestamp("deadline").notNull(),
    groupIds: json("groupIds").$type<string[]>().notNull(),
    studentIds: json("studentIds").$type<number[]>().notNull(),
    attachments: json("attachments").$type<Array<{ fileId: string; name: string; size: number }>>().notNull(),
    accessMode: mysqlEnum("accessMode", TASK_ACCESS_MODES).notNull().default("PUBLIC"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("tasks_workspace_idx").on(t.providerWorkspaceId)],
);

/** One row per student a task reaches, created lazily on first submission. */
export const taskSubmissions = mysqlTable(
  "task_submissions",
  {
    id: id("id").primaryKey(),
    taskId: id("taskId").notNull(),
    studentId: int("studentId").notNull(),
    status: mysqlEnum("status", TASK_SUBMISSION_STATUSES).notNull(),
    files: json("files").$type<Array<{ fileId: string; name: string; size: number }>>().notNull(),
    submittedAt: timestamp("submittedAt"),
    /** First time this student turned the task in; resubmissions leave it alone (first-submitter ranking). */
    firstSubmittedAt: timestamp("firstSubmittedAt"),
    /** The student's typed answer (optional when files are attached). */
    comment: text("comment"),
    /** Teacher's final score on a 0–100 scale; the AI suggestion never lands here by itself. */
    score: double("score"),
    teacherFeedback: text("teacherFeedback"),
    gradedAt: timestamp("gradedAt"),
    gradedByUserId: int("gradedByUserId"),
    /** Null = the grade is still private to the teacher. */
    feedbackReleasedAt: timestamp("feedbackReleasedAt"),
    /** The AI pre-review text is shown to the student only when the teacher opts in on release. */
    aiFeedbackReleased: boolean("aiFeedbackReleased").notNull().default(false),
  },
  (t) => [
    uniqueIndex("task_submissions_task_student_unique").on(t.taskId, t.studentId),
    index("task_submissions_task_first_idx").on(t.taskId, t.firstSubmittedAt),
  ],
);

export const SUBMISSION_AI_REVIEW_STATUSES = ["PENDING", "DONE", "FAILED", "SKIPPED"] as const;
export type SubmissionAiReviewStatus = (typeof SUBMISSION_AI_REVIEW_STATUSES)[number];

/** Automated pre-check of a task submission. Advisory only: the teacher decides the grade. */
export const submissionAiReviews = mysqlTable(
  "submission_ai_reviews",
  {
    id: id("id").primaryKey(),
    submissionId: id("submissionId").notNull().unique(),
    taskId: id("taskId").notNull(),
    workspaceId: id("workspaceId").notNull(),
    status: mysqlEnum("status", SUBMISSION_AI_REVIEW_STATUSES).notNull().default("PENDING"),
    /** Changes on every (re)run so a stale run cannot overwrite a newer one. */
    runId: varchar("runId", { length: 32 }).notNull(),
    checks: json("checks").$type<Array<{ code: string; level: "ok" | "warn" | "fail"; value?: string | number }>>().notNull(),
    model: varchar("model", { length: 120 }),
    suggestedScore: double("suggestedScore"),
    feedback: text("feedback"),
    details: json("details").$type<{ strengths: string[]; improvements: string[]; confidence: "low" | "medium" | "high"; needsTeacherReview: boolean }>(),
    errorCode: varchar("errorCode", { length: 40 }),
    inputChars: int("inputChars").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (t) => [index("submission_ai_reviews_task_idx").on(t.taskId)],
);

/** Append-only log of paid AI calls, used for the per-workspace daily cap. */
export const aiUsageEvents = mysqlTable(
  "ai_usage_events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    workspaceId: id("workspaceId").notNull(),
    kind: varchar("kind", { length: 40 }).notNull(),
    refId: varchar("refId", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("ai_usage_events_workspace_idx").on(t.workspaceId, t.createdAt)],
);

/** A file a teacher shares with a group and/or individual students. The actual bytes live in `files`
 *  (see below); fileId/mimeType/sizeBytes are denormalized here so the list view never needs a join. */
export const materials = mysqlTable(
  "materials",
  {
    id: id("id").primaryKey(),
    providerWorkspaceId: id("providerWorkspaceId").notNull(),
    createdBy: int("createdBy").notNull(),
    shareCode: varchar("shareCode", { length: 16 }).notNull().unique(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description").notNull(),
    subject: varchar("subject", { length: 120 }).notNull(),
    topic: varchar("topic", { length: 120 }).notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    fileId: varchar("fileId", { length: ID }),
    mimeType: varchar("mimeType", { length: 127 }),
    sizeBytes: int("sizeBytes"),
    groupIds: json("groupIds").$type<string[]>().notNull(),
    studentIds: json("studentIds").$type<number[]>().notNull(),
    uploadedAt: timestamp("uploadedAt").defaultNow().notNull(),
  },
  (t) => [index("materials_workspace_idx").on(t.providerWorkspaceId)],
);

/**
 * Binary content for task attachments, material files, and student submission files, stored as
 * base64 text (MySQL on Railway has no first-class blob helper in drizzle's mysql-core, and
 * base64-in-longtext avoids driver-specific binary-column edge cases for the moderate file sizes
 * this app handles — see server/modules/files.ts for the size cap). `isPublic` is true only for
 * material files, which — like exam share links — are meant to be reachable by anyone holding the
 * link; task attachments and submission files stay access-checked per request.
 */
export const files = mysqlTable(
  "files",
  {
    id: id("id").primaryKey(),
    workspaceId: id("workspaceId").notNull(),
    uploadedBy: int("uploadedBy").notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    mimeType: varchar("mimeType", { length: 127 }).notNull(),
    sizeBytes: int("sizeBytes").notNull(),
    dataBase64: longtext("dataBase64").notNull(),
    isPublic: boolean("isPublic").notNull().default(false),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("files_workspace_idx").on(t.workspaceId)],
);

export const notifications = mysqlTable(
  "notifications",
  {
    id: id("id").primaryKey(),
    userId: int("userId").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body").notNull(),
    isRead: boolean("isRead").notNull().default(false),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/**
 * When a deduplicated system notification (e.g. "ai:LIMIT_REACHED:<workspaceId>") last went to a
 * user. Separate from `notifications` so only the alert code depends on it.
 */
export const notificationDedupe = mysqlTable(
  "notification_dedupe",
  {
    userId: int("userId").notNull(),
    dedupeKey: varchar("dedupeKey", { length: 120 }).notNull(),
    lastSentAt: timestamp("lastSentAt").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.dedupeKey] })],
);

/**
 * Outbox and audit log of the notification dispatcher (server/notifications): one row per
 * (event, user, channel). `dedupeKey` is unique so the same notice is never delivered twice.
 */
export const notificationDeliveries = mysqlTable(
  "notification_deliveries",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    dedupeKey: varchar("dedupeKey", { length: 191 }).notNull().unique(),
    event: varchar("event", { length: 40 }).notNull(),
    userId: int("userId").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    /** QUEUED | SENDING | SENT | SKIPPED | FAILED */
    status: varchar("status", { length: 16 }).notNull().default("QUEUED"),
    attempts: int("attempts").notNull().default(0),
    nextAttemptAt: timestamp("nextAttemptAt"),
    /** Event data needed to render the message; never secrets. */
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    error: varchar("error", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    index("notification_deliveries_status_idx").on(t.status, t.nextAttemptAt),
    index("notification_deliveries_user_idx").on(t.userId, t.createdAt),
  ],
);

/** Per user opt-outs (and opt-ins) by event type and channel; no row = the event's default. */
export const notificationPreferences = mysqlTable(
  "notification_preferences",
  {
    userId: int("userId").notNull(),
    event: varchar("event", { length: 40 }).notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    enabled: boolean("enabled").notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.event, t.channel] })],
);

export const PUSH_PLATFORMS = ["ios", "android", "web"] as const;

/**
 * Push tokens of a user's devices (mobile app). Stored as-is because the push provider needs
 * them; treat as sensitive and never return them to clients or logs.
 */
export const pushDevices = mysqlTable(
  "push_devices",
  {
    id: id("id").primaryKey(),
    userId: int("userId").notNull(),
    platform: mysqlEnum("platform", PUSH_PLATFORMS).notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    token: varchar("token", { length: 255 }).notNull().unique(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"),
  },
  (t) => [index("push_devices_user_idx").on(t.userId)],
);

/** Superseded by `taskGradingSettings` (0024 copied its values there); kept because migrations only add. */
export const taskNotificationSettings = mysqlTable("task_notification_settings", {
  taskId: id("taskId").primaryKey(),
  aiFeedbackToStudent: boolean("aiFeedbackToStudent").notNull().default(true),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Teacher's per-task grading switches; no row = defaults (AI auto-grade on). */
export const taskGradingSettings = mysqlTable("task_grading_settings", {
  taskId: id("taskId").primaryKey(),
  autoGrade: boolean("autoGrade").notNull().default(true),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const GRADE_SOURCES = ["AI", "TEACHER"] as const;
export type GradeSource = (typeof GRADE_SOURCES)[number];
export const AUTO_GRADE_STATUSES = ["AI_GRADED", "NEEDS_TEACHER"] as const;
export type AutoGradeStatus = (typeof AUTO_GRADE_STATUSES)[number];

/**
 * Who set a submission's grade and what automatic grading decided. Kept beside task_submissions
 * (add-only migrations). An AI grade also has `task_submissions.gradedByUserId` null.
 */
export const submissionGrading = mysqlTable("submission_grading", {
  submissionId: id("submissionId").primaryKey(),
  source: mysqlEnum("source", GRADE_SOURCES),
  autoStatus: mysqlEnum("autoStatus", AUTO_GRADE_STATUSES),
  /** Why automatic grading left it to the teacher (AutoGradeBlock), else null. */
  autoReason: varchar("autoReason", { length: 40 }),
  /** Score the AI released or last updated to. */
  aiScore: double("aiScore"),
  reviewRunId: varchar("reviewRunId", { length: 32 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Last "your grade is ready" e-mail per submission and the score it announced; dedupes re-saves. */
export const gradeEmailLog = mysqlTable("grade_email_log", {
  submissionId: id("submissionId").primaryKey(),
  score: double("score"),
  sentAt: timestamp("sentAt").notNull(),
});

export const ANSWER_KEY_SOURCES = ["TEACHER", "AI_DRAFT"] as const;
export type AnswerKeySource = (typeof ANSWER_KEY_SOURCES)[number];
export const ANSWER_KEY_DRAFT_STATUSES = ["GENERATING", "READY", "FAILED"] as const;

/**
 * A task's hidden answer key / grading criteria, used only for AI grading and never sent to
 * students. AI_DRAFT = generated automatically and not yet saved by the teacher; the row also
 * guards against generating it twice. Its own table so task reads can never include it.
 */
export const taskAnswerKeys = mysqlTable("task_answer_keys", {
  taskId: id("taskId").primaryKey(),
  answerKey: text("answerKey"),
  source: mysqlEnum("source", ANSWER_KEY_SOURCES).notNull(),
  /** Only for AI_DRAFT. */
  draftStatus: mysqlEnum("draftStatus", ANSWER_KEY_DRAFT_STATUSES),
  updatedByUserId: int("updatedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ---------------------------------------------------------------------------
// Syllabus / structured learning (docs/SYLLABUS-ARCHITECTURE.md). New tables only: existing
// tables are extended through side tables so code keeps working before the migration runs.
// ---------------------------------------------------------------------------

/** The editable head of a syllabus: draft metadata plus a pointer to the latest published version. */
export const syllabi = mysqlTable(
  "syllabi",
  {
    id: id("id").primaryKey(),
    providerWorkspaceId: id("providerWorkspaceId").notNull(),
    createdBy: int("createdBy").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    subject: varchar("subject", { length: 120 }).notNull().default(""),
    level: varchar("level", { length: 64 }).notNull().default(""),
    language: varchar("language", { length: 64 }).notNull().default(""),
    coverFileId: id("coverFileId"),
    estimatedDurationLabel: varchar("estimatedDurationLabel", { length: 64 }).notNull().default(""),
    estimatedHours: int("estimatedHours"),
    status: mysqlEnum("status", SYLLABUS_STATUSES).notNull().default("DRAFT"),
    /** Partial CompletionRules (shared/syllabus.ts); missing fields fall back to the defaults. */
    completionRules: json("completionRules").$type<CompletionRulesPatch>().notNull(),
    currentVersionId: id("currentVersionId"),
    hasDraftChanges: boolean("hasDraftChanges").notNull().default(true),
    /** Bumped by every draft write; the builder sends it back to detect a stale tab. */
    draftRevision: int("draftRevision").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    archivedAt: timestamp("archivedAt"),
  },
  (t) => [index("syllabi_workspace_idx").on(t.providerWorkspaceId, t.status)],
);

/** Draft modules. Ids are stable across versions: progress and analytics key on them. Soft-deleted only. */
export const syllabusModules = mysqlTable(
  "syllabus_modules",
  {
    id: id("id").primaryKey(),
    syllabusId: id("syllabusId").notNull(),
    position: int("position").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    estimatedMinutes: int("estimatedMinutes"),
    objectives: json("objectives").$type<string[]>().notNull(),
    prerequisitesText: text("prerequisitesText"),
    status: mysqlEnum("status", SYLLABUS_NODE_STATUSES).notNull().default("READY"),
    completionRules: json("completionRules").$type<CompletionRulesPatch>(),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("syllabus_modules_syllabus_idx").on(t.syllabusId, t.position)],
);

export const syllabusLessons = mysqlTable(
  "syllabus_lessons",
  {
    id: id("id").primaryKey(),
    syllabusId: id("syllabusId").notNull(),
    moduleId: id("moduleId").notNull(),
    position: int("position").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    estimatedMinutes: int("estimatedMinutes"),
    objectives: json("objectives").$type<string[]>().notNull(),
    status: mysqlEnum("status", SYLLABUS_NODE_STATUSES).notNull().default("READY"),
    completionRules: json("completionRules").$type<CompletionRulesPatch>(),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("syllabus_lessons_module_idx").on(t.moduleId, t.position), index("syllabus_lessons_syllabus_idx").on(t.syllabusId)],
);

/** Everything inside a lesson, plus module (scope MODULE) and final (scope SYLLABUS) assessments. */
export const syllabusItems = mysqlTable(
  "syllabus_items",
  {
    id: id("id").primaryKey(),
    syllabusId: id("syllabusId").notNull(),
    scope: mysqlEnum("scope", SYLLABUS_ITEM_SCOPES).notNull().default("LESSON"),
    moduleId: id("moduleId"),
    lessonId: id("lessonId"),
    kind: mysqlEnum("kind", SYLLABUS_ITEM_KINDS).notNull(),
    position: int("position").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    required: boolean("required").notNull().default(true),
    /** Typed by `kind` (shared/syllabus.ts ITEM_CONTENT_SCHEMAS). */
    content: json("content").$type<Record<string, unknown>>().notNull(),
    assessmentId: id("assessmentId"),
    materialId: id("materialId"),
    /** STUDENT_PRACTICE: the draft's hidden container task (answer key, AI settings live on it). */
    taskId: id("taskId"),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("syllabus_items_lesson_idx").on(t.lessonId, t.kind, t.position), index("syllabus_items_syllabus_idx").on(t.syllabusId, t.scope)],
);

/** Immutable published snapshot. Rows are never updated except `status`. */
export const syllabusVersions = mysqlTable(
  "syllabus_versions",
  {
    id: id("id").primaryKey(),
    syllabusId: id("syllabusId").notNull(),
    versionNo: int("versionNo").notNull(),
    label: varchar("label", { length: 16 }).notNull(),
    status: mysqlEnum("status", SYLLABUS_VERSION_STATUSES).notNull().default("PUBLISHED"),
    /** Tree of module/lesson/item stubs with resolved rules (server/syllabus/types.ts VersionStructure). */
    structure: json("structure").$type<Record<string, unknown>>().notNull(),
    meta: json("meta").$type<Record<string, unknown>>().notNull(),
    changeNote: text("changeNote"),
    publishedBy: int("publishedBy").notNull(),
    publishedAt: timestamp("publishedAt").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("syllabus_versions_no_unique").on(t.syllabusId, t.versionNo)],
);

/** Frozen item content per version, incl. teacher-only fields (stripped when serving students). */
export const syllabusVersionItems = mysqlTable(
  "syllabus_version_items",
  {
    versionId: id("versionId").notNull(),
    itemId: id("itemId").notNull(),
    moduleId: id("moduleId"),
    lessonId: id("lessonId"),
    kind: mysqlEnum("kind", SYLLABUS_ITEM_KINDS).notNull(),
    content: json("content").$type<Record<string, unknown>>().notNull(),
    taskId: id("taskId"),
    assessmentId: id("assessmentId"),
    assessmentVersionId: id("assessmentVersionId"),
    materialSnapshot: json("materialSnapshot").$type<Record<string, unknown>>(),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.itemId] }), index("syllabus_version_items_lesson_idx").on(t.versionId, t.lessonId)],
);

/** Group or individual access. PENDING/EXPIRED are derived from the dates; re-granting inserts a new row. */
export const syllabusAccessGrants = mysqlTable(
  "syllabus_access_grants",
  {
    id: id("id").primaryKey(),
    syllabusId: id("syllabusId").notNull(),
    groupId: id("groupId"),
    studentId: int("studentId"),
    status: mysqlEnum("status", SYLLABUS_GRANT_STATUSES).notNull().default("ACTIVE"),
    startsAt: timestamp("startsAt"),
    endsAt: timestamp("endsAt"),
    note: varchar("note", { length: 255 }),
    grantedBy: int("grantedBy").notNull(),
    grantedAt: timestamp("grantedAt").defaultNow().notNull(),
    revokedBy: int("revokedBy"),
    revokedAt: timestamp("revokedAt"),
  },
  (t) => [
    index("syllabus_grants_syllabus_idx").on(t.syllabusId, t.status),
    index("syllabus_grants_group_idx").on(t.groupId),
    index("syllabus_grants_student_idx").on(t.studentId),
  ],
);

/** One per (syllabus, student), created on first open with access; pinned to a version. Survives revocation. */
export const syllabusEnrollments = mysqlTable(
  "syllabus_enrollments",
  {
    id: id("id").primaryKey(),
    syllabusId: id("syllabusId").notNull(),
    studentId: int("studentId").notNull(),
    versionId: id("versionId").notNull(),
    status: mysqlEnum("status", SYLLABUS_ENROLLMENT_STATUSES).notNull().default("ACTIVE"),
    enrolledAt: timestamp("enrolledAt").defaultNow().notNull(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    progressPct: double("progressPct").notNull().default(0),
    completedLessons: int("completedLessons").notNull().default(0),
    totalLessons: int("totalLessons").notNull().default(0),
    currentModuleId: id("currentModuleId"),
    currentLessonId: id("currentLessonId"),
    lastCompletedLessonId: id("lastCompletedLessonId"),
    lastCompletedItemId: id("lastCompletedItemId"),
    lastActivityAt: timestamp("lastActivityAt"),
    viaGroupId: id("viaGroupId"),
    upgradedFromVersionId: id("upgradedFromVersionId"),
    /** Facts changed but the recompute has not finished; the reconciler picks these up. */
    dirtyAt: timestamp("dirtyAt"),
    stateRevision: int("stateRevision").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex("syllabus_enrollments_unique").on(t.syllabusId, t.studentId),
    index("syllabus_enrollments_activity_idx").on(t.syllabusId, t.lastActivityAt),
    index("syllabus_enrollments_student_idx").on(t.studentId),
    index("syllabus_enrollments_dirty_idx").on(t.dirtyAt),
  ],
);

export const syllabusModuleProgress = mysqlTable(
  "syllabus_module_progress",
  {
    enrollmentId: id("enrollmentId").notNull(),
    moduleId: id("moduleId").notNull(),
    syllabusId: id("syllabusId").notNull(),
    status: mysqlEnum("status", MODULE_PROGRESS_STATES).notNull().default("LOCKED"),
    unlockedAt: timestamp("unlockedAt"),
    unlockSource: mysqlEnum("unlockSource", UNLOCK_SOURCES),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    completedLessons: int("completedLessons").notNull().default(0),
    totalLessons: int("totalLessons").notNull().default(0),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.enrollmentId, t.moduleId] }), index("syllabus_module_progress_idx").on(t.syllabusId, t.moduleId, t.status)],
);

export const syllabusLessonProgress = mysqlTable(
  "syllabus_lesson_progress",
  {
    enrollmentId: id("enrollmentId").notNull(),
    lessonId: id("lessonId").notNull(),
    syllabusId: id("syllabusId").notNull(),
    moduleId: id("moduleId").notNull(),
    status: mysqlEnum("status", LESSON_PROGRESS_STATES).notNull().default("LOCKED"),
    unlockedAt: timestamp("unlockedAt"),
    unlockSource: mysqlEnum("unlockSource", UNLOCK_SOURCES),
    openedAt: timestamp("openedAt"),
    startedAt: timestamp("startedAt"),
    theoryCompletedAt: timestamp("theoryCompletedAt"),
    completedAt: timestamp("completedAt"),
    activeSeconds: int("activeSeconds").notNull().default(0),
    /** Which requirements are met, for the "what is left" UI. */
    requirements: json("requirements").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.enrollmentId, t.lessonId] }), index("syllabus_lesson_progress_idx").on(t.syllabusId, t.lessonId, t.status)],
);

/** Student-side facts per item. Practice and assessment outcomes are read live from task_submissions / results. */
export const syllabusItemProgress = mysqlTable(
  "syllabus_item_progress",
  {
    enrollmentId: id("enrollmentId").notNull(),
    itemId: id("itemId").notNull(),
    syllabusId: id("syllabusId").notNull(),
    lessonId: id("lessonId"),
    kind: mysqlEnum("kind", SYLLABUS_ITEM_KINDS).notNull(),
    openedAt: timestamp("openedAt"),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    teacherMarkedAt: timestamp("teacherMarkedAt"),
    teacherMarkedBy: int("teacherMarkedBy"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.enrollmentId, t.itemId] }), index("syllabus_item_progress_idx").on(t.syllabusId, t.itemId)],
);

/** Audit of per-student exceptions (§12). Never deleted; revocation is a timestamp. */
export const syllabusManualUnlocks = mysqlTable(
  "syllabus_manual_unlocks",
  {
    id: id("id").primaryKey(),
    syllabusId: id("syllabusId").notNull(),
    enrollmentId: id("enrollmentId").notNull(),
    studentId: int("studentId").notNull(),
    targetType: mysqlEnum("targetType", UNLOCK_TARGET_TYPES).notNull(),
    targetId: id("targetId").notNull(),
    reason: text("reason").notNull(),
    unlockedBy: int("unlockedBy").notNull(),
    actorKind: mysqlEnum("actorKind", ["TEACHER", "ADMIN"]).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"),
    revokedBy: int("revokedBy"),
  },
  (t) => [index("syllabus_unlocks_enrollment_idx").on(t.enrollmentId), index("syllabus_unlocks_syllabus_idx").on(t.syllabusId, t.createdAt)],
);

export const syllabusApprovals = mysqlTable(
  "syllabus_approvals",
  {
    id: id("id").primaryKey(),
    enrollmentId: id("enrollmentId").notNull(),
    targetType: mysqlEnum("targetType", APPROVAL_TARGET_TYPES).notNull(),
    targetId: id("targetId").notNull(),
    decision: mysqlEnum("decision", APPROVAL_DECISIONS).notNull(),
    note: varchar("note", { length: 500 }),
    decidedBy: int("decidedBy").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("syllabus_approvals_target_idx").on(t.enrollmentId, t.targetType, t.targetId)],
);

/** Certificate-ready completion record (§18). Written once; never updated except revocation. */
export const syllabusCompletions = mysqlTable(
  "syllabus_completions",
  {
    id: id("id").primaryKey(),
    enrollmentId: id("enrollmentId").notNull().unique(),
    syllabusId: id("syllabusId").notNull(),
    versionId: id("versionId").notNull(),
    studentId: int("studentId").notNull(),
    completedAt: timestamp("completedAt").notNull(),
    overallPct: double("overallPct").notNull(),
    finalAssessmentPct: double("finalAssessmentPct"),
    verificationCode: varchar("verificationCode", { length: 24 }).notNull().unique(),
    certificateNo: varchar("certificateNo", { length: 32 }).unique(),
    certificateIssuedAt: timestamp("certificateIssuedAt"),
    snapshot: json("snapshot").$type<Record<string, unknown>>().notNull(),
    revokedAt: timestamp("revokedAt"),
    revokedBy: int("revokedBy"),
    revokeReason: varchar("revokeReason", { length: 500 }),
  },
  (t) => [index("syllabus_completions_syllabus_idx").on(t.syllabusId, t.completedAt)],
);

/** Marks hidden `tasks` rows that serve as syllabus practice submission containers (versionId null = draft copy). */
export const syllabusPracticeTasks = mysqlTable(
  "syllabus_practice_tasks",
  {
    taskId: id("taskId").primaryKey(),
    syllabusId: id("syllabusId").notNull(),
    itemId: id("itemId").notNull(),
    versionId: id("versionId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("syllabus_practice_tasks_item_idx").on(t.syllabusId, t.itemId)],
);

/** Marks per-student assessment_assignments created when a syllabus assessment item unlocks. */
export const syllabusAssessmentAssignments = mysqlTable(
  "syllabus_assessment_assignments",
  {
    assignmentId: int("assignmentId").primaryKey(),
    syllabusId: id("syllabusId").notNull(),
    enrollmentId: id("enrollmentId").notNull(),
    itemId: id("itemId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("syllabus_assessment_assignments_item_unique").on(t.enrollmentId, t.itemId)],
);

/**
 * Per-group learning settings kept beside study_groups (add-only). No row = defaults:
 * groupmates see each other's syllabus progress (owner decision, docs/SYLLABUS-ARCHITECTURE.md Q7).
 */
export const groupLearningSettings = mysqlTable("group_learning_settings", {
  groupId: id("groupId").primaryKey(),
  progressVisibleToGroup: boolean("progressVisibleToGroup").notNull().default(true),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/**
 * Append-only learning history (§29, §30, §42). History only: progression state lives in the progress
 * tables, so retention deletes here never change what a student has unlocked.
 */
export const learningActivity = mysqlTable(
  "learning_activity",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    workspaceId: id("workspaceId").notNull(),
    syllabusId: id("syllabusId").notNull(),
    versionId: id("versionId"),
    moduleId: id("moduleId"),
    lessonId: id("lessonId"),
    itemId: id("itemId"),
    taskId: id("taskId"),
    assessmentId: id("assessmentId"),
    groupId: id("groupId"),
    activityType: varchar("activityType", { length: 40 }).notNull(),
    occurredAt: timestamp("occurredAt", { fsp: 3 }).notNull(),
    durationSeconds: int("durationSeconds"),
    source: mysqlEnum("source", ["CLIENT", "SERVER"]).notNull(),
    metadata: json("metadata").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("learning_activity_syllabus_idx").on(t.syllabusId, t.occurredAt),
    index("learning_activity_user_idx").on(t.userId, t.syllabusId, t.occurredAt),
    index("learning_activity_lesson_idx").on(t.syllabusId, t.lessonId, t.activityType),
    index("learning_activity_item_idx").on(t.syllabusId, t.itemId, t.activityType),
    /** Retention job: delete events older than ACTIVITY_RETENTION_MONTHS in small batches. */
    index("learning_activity_time_idx").on(t.occurredAt),
  ],
);

/** Per-syllabus analytics settings (at-risk thresholds, daily digest). No row = defaults. */
export const syllabusAnalyticsSettings = mysqlTable("syllabus_analytics_settings", {
  syllabusId: id("syllabusId").primaryKey(),
  /** Partial RiskThresholds (shared/syllabusAnalytics.ts); invalid or missing fields fall back to the defaults. */
  thresholds: json("thresholds").$type<Record<string, unknown>>().notNull(),
  digestEnabled: boolean("digestEnabled").notNull().default(true),
  updatedBy: int("updatedBy").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const SYLLABUS_NOTICE_KINDS = ["UNLOCK", "APPROVAL"] as const;

/**
 * Notices waiting for their batching window (server/syllabus/notify.ts): one open row per recipient
 * batch, merged on every recompute and deleted when sent, so a restart never loses one.
 */
export const syllabusNoticeBatches = mysqlTable(
  "syllabus_notice_batches",
  {
    batchKey: varchar("batchKey", { length: 96 }).primaryKey(),
    kind: mysqlEnum("kind", SYLLABUS_NOTICE_KINDS).notNull(),
    syllabusId: id("syllabusId").notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    /** Bumped by every merge; the sender deletes only the revision it read. */
    revision: int("revision").notNull().default(0),
    dueAt: timestamp("dueAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("syllabus_notice_batches_due_idx").on(t.dueAt)],
);

export type Syllabus = typeof syllabi.$inferSelect;
export type SyllabusModuleRow = typeof syllabusModules.$inferSelect;
export type SyllabusLessonRow = typeof syllabusLessons.$inferSelect;
export type SyllabusItemRow = typeof syllabusItems.$inferSelect;
export type SyllabusVersion = typeof syllabusVersions.$inferSelect;
export type SyllabusVersionItem = typeof syllabusVersionItems.$inferSelect;
export type SyllabusAccessGrant = typeof syllabusAccessGrants.$inferSelect;
export type SyllabusEnrollment = typeof syllabusEnrollments.$inferSelect;
export type SyllabusModuleProgressRow = typeof syllabusModuleProgress.$inferSelect;
export type SyllabusLessonProgressRow = typeof syllabusLessonProgress.$inferSelect;
export type SyllabusItemProgressRow = typeof syllabusItemProgress.$inferSelect;
export type SyllabusManualUnlock = typeof syllabusManualUnlocks.$inferSelect;

export type ProviderWorkspace = typeof providerWorkspaces.$inferSelect;
export type PartnerProfile = typeof partnerProfiles.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type GroupEmailInvite = typeof groupEmailInvites.$inferSelect;
export type GroupInviteLink = typeof groupInviteLinks.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;
export type Assessment = typeof assessments.$inferSelect;
export type AssessmentVersion = typeof assessmentVersions.$inferSelect;
export type VersionQuestion = typeof versionQuestions.$inferSelect;
export type Attempt = typeof attempts.$inferSelect;
export type Result = typeof results.$inferSelect;
export type ResultItem = typeof resultItems.$inferSelect;
export type AssessmentAssignment = typeof assessmentAssignments.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskSubmission = typeof taskSubmissions.$inferSelect;
export type SubmissionAiReview = typeof submissionAiReviews.$inferSelect;
export type SubmissionGrading = typeof submissionGrading.$inferSelect;
