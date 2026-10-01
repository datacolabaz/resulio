import { z } from "zod";
import {
  ADMIN_REASON_MAX,
  ADMIN_REASON_MIN,
  ADMIN_ROLES,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  PARTNER_DECISIONS,
  PARTNER_STATUSES,
  SECURITY_EVENT_STATUSES,
  SECURITY_EVENT_TYPES,
  SECURITY_SEVERITIES,
} from "../shared/adminPermissions";
import { adminProcedure, router } from "./_core/trpc";
import { listAudit } from "./modules/admin/audit";
import * as roles from "./modules/admin/roles";
import * as security from "./modules/admin/security";
import * as adminUsers from "./modules/admin/users";
import { AppError } from "./modules/errors";
import * as partners from "./modules/partners";

const reason = z.string().trim().min(ADMIN_REASON_MIN).max(ADMIN_REASON_MAX);
const userId = z.number().int().positive();
const cursor = z.number().int().positive().optional();
const limit = z.number().int().min(1).max(200).optional();

export const adminRouter = router({
  /** Roles/permissions the server will honour for this admin (allowlist applied). */
  me: adminProcedure("overview.view").query(({ ctx }) => ({ roles: ctx.admin.roles, permissions: ctx.admin.permissions })),

  users: router({
    search: adminProcedure("users.search")
      .input(z.object({ query: z.string().trim().max(255).optional(), before: userId.optional(), limit }).optional())
      .query(({ input }) => adminUsers.searchUsers(input?.query, input?.before, input?.limit)),
    get: adminProcedure("users.view")
      .input(z.object({ userId }))
      .query(({ input }) => adminUsers.getUser(input.userId)),
    suspend: adminProcedure("users.suspend")
      .input(z.object({ userId, reason }))
      .mutation(({ ctx, input }) => adminUsers.suspendUser(ctx.admin, input.userId, input.reason)),
    unsuspend: adminProcedure("users.suspend")
      .input(z.object({ userId, reason }))
      .mutation(({ ctx, input }) => adminUsers.unsuspendUser(ctx.admin, input.userId, input.reason)),
    revokeSessions: adminProcedure("users.revokeSessions")
      .input(z.object({ userId, reason }))
      .mutation(({ ctx, input }) => adminUsers.revokeSessions(ctx.admin, input.userId, input.reason)),
  }),

  roles: router({
    list: adminProcedure("roles.manage").query(() => roles.listAdmins()),
    grant: adminProcedure("roles.manage")
      .input(z.object({ userId, role: z.enum(ADMIN_ROLES), reason }))
      .mutation(({ ctx, input }) => roles.grantRole(ctx.admin, input.userId, input.role, input.reason)),
    revoke: adminProcedure("roles.manage")
      .input(z.object({ userId, role: z.enum(ADMIN_ROLES), reason }))
      .mutation(({ ctx, input }) => roles.revokeRole(ctx.admin, input.userId, input.role, input.reason)),
  }),

  partners: router({
    list: adminProcedure("partners.view")
      .input(z.object({ status: z.enum(PARTNER_STATUSES).optional() }).optional())
      .query(({ input }) => partners.listPartnerProfiles(input?.status)),
    decide: adminProcedure("partners.decide")
      .input(z.object({ id: z.number().int().positive(), decision: z.enum(PARTNER_DECISIONS), reason }))
      .mutation(({ ctx, input }) => partners.decidePartnerProfile(ctx.admin, input.id, input.decision, input.reason)),
  }),

  audit: router({
    /** Support admins only see entries for the user or workspace they are inspecting. */
    list: adminProcedure("audit.viewSupport")
      .input(
        z.object({
          from: z.date().optional(),
          to: z.date().optional(),
          actorUserId: userId.optional(),
          action: z.enum(AUDIT_ACTIONS).optional(),
          targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
          targetId: z.string().max(64).optional(),
          userId: userId.optional(),
          workspaceId: z.string().max(32).optional(),
          before: cursor,
          limit,
        }),
      )
      .query(({ ctx, input }) => {
        if (!ctx.admin.permissions.includes("audit.view")) {
          if (input.userId === undefined && !input.workspaceId) throw new AppError("FORBIDDEN");
          return listAudit({ userId: input.userId, workspaceId: input.workspaceId, before: input.before, limit: input.limit });
        }
        return listAudit(input);
      }),
  }),

  security: router({
    list: adminProcedure("security.view")
      .input(
        z.object({
          status: z.enum(SECURITY_EVENT_STATUSES).optional(),
          type: z.enum(SECURITY_EVENT_TYPES).optional(),
          severity: z.enum(SECURITY_SEVERITIES).optional(),
          userId: userId.optional(),
          before: cursor,
          limit,
        }),
      )
      .query(({ input }) => security.listSecurityEvents(input)),
    review: adminProcedure("security.review")
      .input(z.object({ id: z.number().int().positive(), status: z.enum(["REVIEWED", "DISMISSED"]), reason }))
      .mutation(({ ctx, input }) => security.reviewSecurityEvent(ctx.admin, input.id, input.status, input.reason)),
  }),
});
