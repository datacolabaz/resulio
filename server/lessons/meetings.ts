import { eq } from "drizzle-orm";
import { lessonMeetings, type LessonRow, type TeacherMeetingConnectionRow } from "../../drizzle/schema";
import { requireDb } from "../db";
import { createGoogleMeetMeeting, refreshGoogleMeetToken } from "./providers/googleMeet";
import { createZoomMeeting, refreshZoomToken } from "./providers/zoom";
import { connectionById, decryptedAccessToken, decryptedRefreshToken, markConnectionError, recordRefreshedTokens } from "./tokenStore";

/** A token is refreshed once it is within 5 minutes of expiry, so a slow provider call never races past it. */
const REFRESH_SKEW_MS = 5 * 60_000;

/** The connection's current access token, refreshing it first if it is missing or about to expire. */
export async function validAccessToken(connection: TeacherMeetingConnectionRow): Promise<string> {
  const expiresAt = connection.tokenExpiresAt?.getTime() ?? 0;
  if (expiresAt - Date.now() > REFRESH_SKEW_MS) return decryptedAccessToken(connection);
  const refreshToken = decryptedRefreshToken(connection);
  if (!refreshToken) return decryptedAccessToken(connection); // No refresh token on file: use what we have and let the provider call fail loudly if it's dead.
  const refreshed = connection.provider === "GOOGLE_MEET" ? await refreshGoogleMeetToken(refreshToken) : await refreshZoomToken(refreshToken);
  await recordRefreshedTokens(connection.id, refreshed.accessToken, refreshed.expiresAt, refreshed.refreshToken);
  return refreshed.accessToken;
}

async function upsertMeetingRow(lessonId: string, values: Partial<typeof lessonMeetings.$inferInsert>) {
  const db = requireDb();
  const [existing] = await db.select().from(lessonMeetings).where(eq(lessonMeetings.lessonId, lessonId)).limit(1);
  if (existing) {
    await db.update(lessonMeetings).set(values).where(eq(lessonMeetings.lessonId, lessonId));
  } else {
    await db.insert(lessonMeetings).values({ lessonId, connectionId: values.connectionId ?? "", provider: values.provider ?? "GOOGLE_MEET", status: "PENDING", ...values });
  }
}

/**
 * Creates (or retries) the external meeting for one lesson occurrence. Never throws: failures are
 * recorded on the `lesson_meetings` row (status FAILED, lastError) so the sweeper can retry and the
 * teacher can see why, rather than losing the lesson save over a transient provider error.
 */
export async function createMeetingForLesson(lesson: Pick<LessonRow, "id" | "title" | "startsAt" | "endsAt" | "platform">, connection: TeacherMeetingConnectionRow): Promise<void> {
  const durationMinutes = Math.max(5, Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 60_000));
  try {
    const accessToken = await validAccessToken(connection);
    if (lesson.platform === "GOOGLE_MEET") {
      const created = await createGoogleMeetMeeting(accessToken, { title: lesson.title, startsAt: lesson.startsAt, endsAt: lesson.endsAt, timezone: "Asia/Baku" });
      await upsertMeetingRow(lesson.id, {
        connectionId: connection.id,
        provider: "GOOGLE_MEET",
        status: "CREATED",
        externalMeetingId: created.externalMeetingId,
        joinUrl: created.joinUrl,
        providerCalendarEventId: created.providerCalendarEventId,
        lastError: null,
      });
    } else {
      const created = await createZoomMeeting(accessToken, { title: lesson.title, startsAt: lesson.startsAt, durationMinutes, timezone: "Asia/Baku" });
      await upsertMeetingRow(lesson.id, {
        connectionId: connection.id,
        provider: "ZOOM",
        status: "CREATED",
        externalMeetingId: created.externalMeetingId,
        joinUrl: created.joinUrl,
        hostUrl: created.hostUrl,
        passcode: created.passcode,
        lastError: null,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertMeetingRow(lesson.id, { connectionId: connection.id, provider: lesson.platform, status: "FAILED", lastError: message.slice(0, 255) });
    if (/\b(invalid_grant|401|403)\b/i.test(message)) await markConnectionError(connection.id, message);
  }
}

/** Looks up the connection by id (used by the retry sweeper, which only has `lesson_meetings.connectionId`). */
export async function connectionForRetry(connectionId: string): Promise<TeacherMeetingConnectionRow | null> {
  return connectionById(connectionId);
}
