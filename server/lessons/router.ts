import { z } from "zod";
import { teacherProcedure, router } from "../_core/trpc";
import { MEETING_PROVIDERS, type MeetingProvider } from "../../shared/lessonIntegration";
import { connectionsOf, disconnect } from "./tokenStore";

/**
 * Teacher-facing lesson-integration endpoints. The OAuth connect/callback round trip itself is
 * plain Express routes (oauthRoutes.ts) because it redirects the browser to Google/Zoom and back;
 * everything that can be a normal RPC -- reading connection status, disconnecting -- lives here.
 */

export type ConnectionStatusView = {
  provider: MeetingProvider;
  connected: boolean;
  status: "ACTIVE" | "ERROR" | "REVOKED" | null;
  accountEmail: string | null;
  connectedAt: string | null;
  lastError: string | null;
};

const connectionsRouter = router({
  /** One row per provider, connected or not, so the settings page can render both buttons in a fixed order. */
  status: teacherProcedure.query(async ({ ctx }): Promise<ConnectionStatusView[]> => {
    const rows = await connectionsOf(ctx.scope.userId);
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    return MEETING_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      if (!row || row.status === "REVOKED") return { provider, connected: false, status: row?.status ?? null, accountEmail: null, connectedAt: null, lastError: null };
      return {
        provider,
        connected: row.status === "ACTIVE",
        status: row.status,
        accountEmail: row.accountEmail,
        connectedAt: row.connectedAt.toISOString(),
        lastError: row.lastError,
      };
    });
  }),
  disconnect: teacherProcedure.input(z.object({ provider: z.enum(MEETING_PROVIDERS) })).mutation(async ({ ctx, input }) => {
    const did = await disconnect(ctx.scope.userId, input.provider);
    return { disconnected: did };
  }),
});

export const teacherLessonsRouter = router({
  connections: connectionsRouter,
});
