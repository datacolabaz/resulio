import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { teacherMeetingConnections, type TeacherMeetingConnectionRow } from "../../drizzle/schema";
import type { ConnectionStatus, MeetingProvider } from "../../shared/lessonIntegration";
import { requireDb } from "../db";
import { decryptToken, encryptToken } from "./tokenCrypto";

/**
 * CRUD + decrypt-on-read for `teacher_meeting_connections`, the one place that touches the
 * encrypted token columns. Meeting-provider clients (googleMeet.ts, zoom.ts) and sweepers go
 * through here rather than reading the table directly, so the cipher never leaks into a log or
 * an error message by accident.
 */

export type UpsertConnectionInput = {
  workspaceId: string;
  userId: number;
  provider: MeetingProvider;
  externalAccountId: string | null;
  accountEmail: string | null;
  scope: string | null;
  accessToken: string;
  /** Omitted when the provider didn't return a new one on this exchange (e.g. a re-consent without `prompt=consent`). */
  refreshToken?: string | null;
  tokenExpiresAt: Date | null;
};

/** Connect (or reconnect) a teacher's provider account. One row per (userId, provider) -- a later connect replaces the row's tokens, never adds a second. */
export async function upsertConnection(input: UpsertConnectionInput): Promise<TeacherMeetingConnectionRow> {
  const db = requireDb();
  const existing = await connectionOf(input.userId, input.provider);
  const values = {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: input.provider,
    status: "ACTIVE" as ConnectionStatus,
    externalAccountId: input.externalAccountId,
    accountEmail: input.accountEmail,
    scope: input.scope,
    accessTokenCipher: encryptToken(input.accessToken),
    tokenExpiresAt: input.tokenExpiresAt,
    lastError: null,
    revokedAt: null,
  };
  if (existing) {
    await db
      .update(teacherMeetingConnections)
      .set({
        ...values,
        // Keep the previous refresh token when this exchange didn't hand back a new one.
        refreshTokenCipher: input.refreshToken ? encryptToken(input.refreshToken) : undefined,
      })
      .where(eq(teacherMeetingConnections.id, existing.id));
    return { ...existing, ...values, refreshTokenCipher: input.refreshToken ? encryptToken(input.refreshToken) : existing.refreshTokenCipher } as TeacherMeetingConnectionRow;
  }
  const id = nanoid();
  await db.insert(teacherMeetingConnections).values({ id, ...values, refreshTokenCipher: input.refreshToken ? encryptToken(input.refreshToken) : null });
  const [row] = await db.select().from(teacherMeetingConnections).where(eq(teacherMeetingConnections.id, id)).limit(1);
  return row;
}

export async function connectionOf(userId: number, provider: MeetingProvider): Promise<TeacherMeetingConnectionRow | null> {
  const [row] = await requireDb()
    .select()
    .from(teacherMeetingConnections)
    .where(and(eq(teacherMeetingConnections.userId, userId), eq(teacherMeetingConnections.provider, provider)))
    .limit(1);
  return row ?? null;
}

export async function connectionsOf(userId: number): Promise<TeacherMeetingConnectionRow[]> {
  return requireDb().select().from(teacherMeetingConnections).where(eq(teacherMeetingConnections.userId, userId));
}

/** The connection a specific meeting was (or should be) created through -- used by sweepers/capture, which only have the connection id. */
export async function connectionById(id: string): Promise<TeacherMeetingConnectionRow | null> {
  const [row] = await requireDb().select().from(teacherMeetingConnections).where(eq(teacherMeetingConnections.id, id)).limit(1);
  return row ?? null;
}

export function decryptedAccessToken(row: TeacherMeetingConnectionRow): string {
  return decryptToken(row.accessTokenCipher);
}

export function decryptedRefreshToken(row: TeacherMeetingConnectionRow): string | null {
  return row.refreshTokenCipher ? decryptToken(row.refreshTokenCipher) : null;
}

/** After a successful token refresh: new access token, and a new refresh token only if the provider rotated it. */
export async function recordRefreshedTokens(id: string, accessToken: string, tokenExpiresAt: Date | null, refreshToken?: string | null): Promise<void> {
  const db = requireDb();
  await db
    .update(teacherMeetingConnections)
    .set({
      accessTokenCipher: encryptToken(accessToken),
      refreshTokenCipher: refreshToken ? encryptToken(refreshToken) : undefined,
      tokenExpiresAt,
      status: "ACTIVE",
      lastError: null,
    })
    .where(eq(teacherMeetingConnections.id, id));
}

/** A refresh or a provider call failed hard enough that the connection needs the teacher's attention. */
export async function markConnectionError(id: string, message: string): Promise<void> {
  await requireDb()
    .update(teacherMeetingConnections)
    .set({ status: "ERROR", lastError: message.slice(0, 255) })
    .where(eq(teacherMeetingConnections.id, id));
}

/** Teacher-initiated disconnect. Scoped to `userId` so one teacher can never revoke another's connection by guessing an id. */
export async function disconnect(userId: number, provider: MeetingProvider): Promise<boolean> {
  const db = requireDb();
  const existing = await connectionOf(userId, provider);
  if (!existing) return false;
  await db.update(teacherMeetingConnections).set({ status: "REVOKED", revokedAt: new Date(), accessTokenCipher: encryptToken(""), refreshTokenCipher: null }).where(eq(teacherMeetingConnections.id, existing.id));
  return true;
}
