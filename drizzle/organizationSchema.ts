import { index, int, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { WORKSPACE_MEMBER_ROLES, WORKSPACE_MEMBER_STATUSES } from "../shared/organization";

/**
 * Təşkilat / Korporativ Workspace (docs/ORGANIZATION-PLAN.md). Side tables only, like
 * lessonSchema.ts: additive to `providerWorkspaces`, which keeps its single `ownerUserId` exactly
 * as before. Re-exported from schema.ts (`export * from "./organizationSchema"`) the same way
 * lessonSchema.ts is, so drizzle-kit (which only reads schema.ts, see drizzle.config.ts) and the
 * runtime db client (server/db.ts's `import * as schema from "../drizzle/schema"`) both pick these
 * tables up.
 */

const ID = 32;
const id = (name: string) => varchar(name, { length: ID });

/** A named grouping of staff/students for analytics and (later) scoped management, within one workspace. */
export const departments = mysqlTable(
  "departments",
  {
    id: id("id").primaryKey(),
    workspaceId: id("workspaceId").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    createdByUserId: int("createdByUserId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [uniqueIndex("departments_workspace_name_unique").on(t.workspaceId, t.name), index("departments_workspace_idx").on(t.workspaceId)],
);

/**
 * A staff seat on a Provider Workspace beyond its single `providerWorkspaces.ownerUserId`. A row
 * is created PENDING (userId null, only invitedEmail + tokenHash set) when invited, and flips to
 * ACTIVE with userId filled in on accept -- mirrors `groupEmailInvites`/`acceptEmailInvite`.
 * Removing a member sets status REVOKED rather than deleting the row, so who had access to what
 * stays auditable. The unique index on (workspaceId, userId) only constrains ACTIVE/REVOKED rows
 * in practice: MySQL treats every NULL as distinct, so any number of PENDING (userId-less)
 * invites for the same workspace can coexist.
 */
export const workspaceMembers = mysqlTable(
  "workspace_members",
  {
    id: id("id").primaryKey(),
    workspaceId: id("workspaceId").notNull(),
    userId: int("userId"),
    invitedEmail: varchar("invitedEmail", { length: 320 }).notNull(),
    role: mysqlEnum("role", WORKSPACE_MEMBER_ROLES).notNull(),
    status: mysqlEnum("status", WORKSPACE_MEMBER_STATUSES).notNull().default("PENDING"),
    departmentId: id("departmentId"),
    invitedByUserId: int("invitedByUserId").notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).unique(),
    expiresAt: timestamp("expiresAt"),
    joinedAt: timestamp("joinedAt"),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    index("workspace_members_workspace_idx").on(t.workspaceId),
    index("workspace_members_user_idx").on(t.userId),
    index("workspace_members_email_idx").on(t.invitedEmail),
    uniqueIndex("workspace_members_workspace_user_unique").on(t.workspaceId, t.userId),
  ],
);

export type Department = typeof departments.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
