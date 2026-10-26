import { acceptInviteInput, departmentIdInput, departmentInput, inviteMemberInput, memberIdInput, renameDepartmentInput, updateMemberInput } from "../../shared/organization";
import { protectedProcedure, rateLimit, router, teacherProcedure } from "../_core/trpc";
import * as service from "./service";

const MINUTE = 60_000;

/**
 * Təşkilat / Korporativ Workspace endpoints. member/department management is teacherProcedure
 * (OWNER/ADMIN only -- enforced again inside service.ts, not just by who can resolve a scope);
 * accepting an invite and listing one's own pending invites are plain protectedProcedure, since
 * the whole point is to grant workspace access to someone who may not have any yet.
 */
export const organizationRouter = router({
  members: router({
    list: teacherProcedure.query(({ ctx }) => service.listMembers(ctx.scope)),
    invite: teacherProcedure
      .use(rateLimit("orgInviteMember", 20, MINUTE))
      .input(inviteMemberInput)
      .mutation(({ ctx, input }) => service.inviteMember(ctx.scope, input)),
    update: teacherProcedure.input(updateMemberInput).mutation(({ ctx, input }) => service.updateMember(ctx.scope, input)),
    remove: teacherProcedure.input(memberIdInput).mutation(({ ctx, input }) => service.removeMember(ctx.scope, input.memberId)),
  }),
  departments: router({
    list: teacherProcedure.query(({ ctx }) => service.listDepartments(ctx.scope)),
    create: teacherProcedure.input(departmentInput).mutation(({ ctx, input }) => service.createDepartment(ctx.scope, input)),
    rename: teacherProcedure.input(renameDepartmentInput).mutation(({ ctx, input }) => service.renameDepartment(ctx.scope, input.departmentId, input.name)),
    remove: teacherProcedure.input(departmentIdInput).mutation(({ ctx, input }) => service.deleteDepartment(ctx.scope, input.departmentId)),
  }),
  myInvites: protectedProcedure.query(({ ctx }) => service.invitesForEmail(ctx.user.email ?? "")),
  acceptInvite: protectedProcedure
    .use(rateLimit("orgAcceptInvite", 10, MINUTE))
    .input(acceptInviteInput)
    .mutation(({ ctx, input }) => service.acceptInvite(ctx.user.id, ctx.user.email ?? "", input.token)),
});
