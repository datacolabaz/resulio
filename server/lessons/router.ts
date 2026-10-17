import { z } from "zod";
import { studentProcedure, teacherProcedure, router } from "../_core/trpc";
import { lessonSeriesInput, lessonNoteInput, MEETING_PROVIDERS, type MeetingProvider } from "../../shared/lessonIntegration";
import { activeGroupIdsOfStudent } from "../modules/groups";
import * as service from "./service";
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

const lessonIdInput = z.object({ lessonId: z.string().trim().min(1).max(32) });

export const teacherLessonsRouter = router({
  connections: connectionsRouter,
  create: teacherProcedure.input(lessonSeriesInput).mutation(({ ctx, input }) => service.createSeries(ctx.scope, input)),
  list: teacherProcedure.query(({ ctx }) => service.listForWorkspace(ctx.scope)),
  get: teacherProcedure.input(lessonIdInput).query(({ ctx, input }) => service.lessonDetail(ctx.scope, input.lessonId)),
  cancel: teacherProcedure.input(lessonIdInput).mutation(({ ctx, input }) => service.cancelLesson(ctx.scope, input.lessonId)),
  retryMeeting: teacherProcedure.input(lessonIdInput).mutation(({ ctx, input }) => service.retryMeeting(ctx.scope, input.lessonId)),
  addNote: teacherProcedure.input(lessonNoteInput).mutation(({ ctx, input }) => service.addTeacherNote(ctx.scope, input)),
});

export const studentLessonsRouter = router({
  list: studentProcedure.query(async ({ ctx }) => service.studentLessons(ctx.user.id, await activeGroupIdsOfStudent(ctx.user.id))),
  get: studentProcedure.input(lessonIdInput).query(async ({ ctx, input }) => service.studentLessonDetail(ctx.user.id, await activeGroupIdsOfStudent(ctx.user.id), input.lessonId)),
  addNote: studentProcedure
    .input(lessonNoteInput.omit({ visibility: true }))
    .mutation(async ({ ctx, input }) => service.addStudentNote(ctx.user.id, await activeGroupIdsOfStudent(ctx.user.id), input)),
  ackConsent: studentProcedure.input(lessonIdInput).mutation(({ ctx, input }) => service.ackRecordingConsent(ctx.user.id, input.lessonId)),
});
