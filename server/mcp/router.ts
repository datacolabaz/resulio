import { z } from "zod";
import { protectedProcedure, rateLimit, router } from "../_core/trpc";
import { managedWorkspaces } from "../modules/access";
import { AppError } from "../modules/errors";
import { apiBaseUrl, mcpResourceUrl } from "./config";
import { hasOpenUpgradeRequest, mcpEntitlement, requestMcpUpgrade } from "./entitlement";
import { approveConsent, consentDetails, denyConsent, revokeConnection } from "./oauth";
import { oauthStore } from "./store";

const MINUTE = 60_000;
const requestId = z.object({ request: z.string().min(1).max(64) });

/** The teacher side of the Claude connector: settings panel status/disconnect, upgrade request and the consent page. */
export const mcpConnectorRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const [workspaces, entitlement, upgradeRequested] = await Promise.all([managedWorkspaces(ctx.user.id), mcpEntitlement(ctx.user.id), hasOpenUpgradeRequest(ctx.user.id)]);
    const active = entitlement.status === "ACTIVE";
    return {
      isTeacher: workspaces.length > 0,
      entitlement,
      upgradeRequested,
      connectorUrl: active ? mcpResourceUrl(apiBaseUrl(ctx.req)) : null,
      clients: active ? await oauthStore().listConnections(ctx.user.id, new Date()) : [],
    };
  }),
  requestUpgrade: protectedProcedure
    .use(rateLimit("mcpUpgrade", 10, 60 * MINUTE))
    .mutation(async ({ ctx }) => {
      if (!(await managedWorkspaces(ctx.user.id)).length) throw new AppError("NO_WORKSPACE");
      return { outcome: await requestMcpUpgrade(ctx.user) };
    }),
  revoke: protectedProcedure
    .use(rateLimit("mcpDisconnect", 30, 10 * MINUTE))
    .input(z.object({ clientId: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) => revokeConnection(ctx.user, input.clientId)),
  consent: protectedProcedure.input(requestId).query(({ ctx, input }) => consentDetails(ctx.user, input.request)),
  approve: protectedProcedure
    .use(rateLimit("mcpConsent", 30, 10 * MINUTE))
    .input(requestId.extend({ workspaceId: z.string().min(1).max(32).nullish() }))
    .mutation(({ ctx, input }) => approveConsent(ctx.user, input.request, input.workspaceId ?? null)),
  deny: protectedProcedure
    .use(rateLimit("mcpConsent", 30, 10 * MINUTE))
    .input(requestId)
    .mutation(({ ctx, input }) => denyConsent(ctx.user, input.request)),
});
