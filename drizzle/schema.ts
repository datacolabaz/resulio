import {
  bigint,
  boolean,
  double,
  index,
  int,
  json,
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
    /** e.g. "Mon,Wed,Fri" — free text, not a fixed day-of-week enum, to allow irregular schedules. */
    classDays: varchar("classDays", { length: 64 }),
    classTime: varchar("classTime", { length: 32 }),
    /** Whether classDays/classTime/startDate are shown on the public join-preview screen. */
    scheduleVisible: boolean("scheduleVisible").notNull().default(false),
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

export type ProviderWorkspace = typeof providerWorkspaces.$inferSelect;
export type PartnerProfile = typeof partnerProfiles.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type GroupEmailInvite = typeof groupEmailInvites.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;
export type Assessment = typeof assessments.$inferSelect;
export type AssessmentVersion = typeof assessmentVersions.$inferSelect;
export type VersionQuestion = typeof versionQuestions.$inferSelect;
export type Attempt = typeof attempts.$inferSelect;
export type Result = typeof results.$inferSelect;
export type ResultItem = typeof resultItems.$inferSelect;
export type AssessmentAssignment = typeof assessmentAssignments.$inferSelect;
