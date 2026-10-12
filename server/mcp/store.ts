import { and, eq, gt, inArray, isNotNull, isNull, lt, max, min, or } from "drizzle-orm";
import {
  mcpAuditLog,
  oauthClients,
  oauthCodes,
  oauthTokens,
  type OAuthClientRow,
  type OAuthCodeRow,
  type OAuthTokenRow,
} from "../../drizzle/schema";
import { requireDb } from "../db";

export type NewClient = Omit<OAuthClientRow, "createdAt">;
export type NewRequest = Pick<OAuthCodeRow, "id" | "clientId" | "redirectUri" | "codeChallenge" | "scopes" | "resource" | "state" | "expiresAt">;
export type NewToken = Omit<OAuthTokenRow, "revokedAt" | "lastUsedAt" | "createdAt">;
export type NewAudit = { userId: number; workspaceId: string | null; clientId: string | null; tool: string; args: Record<string, unknown> | null; status: string; errorCode: string | null; durationMs: number | null };
export type Connection = { clientId: string; clientName: string; connectedAt: Date; lastUsedAt: Date | null };

/** Persistence of the connector's OAuth state. Single-use and rotation rely on the conditional updates reporting whether they changed a row. */
export interface OAuthStore {
  createClient(row: NewClient): Promise<void>;
  getClient(id: string): Promise<OAuthClientRow | null>;
  createRequest(row: NewRequest): Promise<void>;
  getRequest(id: string): Promise<OAuthCodeRow | null>;
  /** Binds a pending, unexpired request to the user and stores the code hash. False if it was not pending any more. */
  approveRequest(id: string, values: { userId: number; workspaceId: string; codeHash: string; expiresAt: Date }, now: Date): Promise<boolean>;
  /** Closes a pending request without a code (denied). */
  closeRequest(id: string, now: Date): Promise<void>;
  getCodeByHash(codeHash: string): Promise<OAuthCodeRow | null>;
  /** Marks the code used. False if it already was. */
  consumeCode(id: string, now: Date): Promise<boolean>;
  insertTokens(rows: NewToken[]): Promise<void>;
  getTokenByHash(tokenHash: string): Promise<OAuthTokenRow | null>;
  /** False if the token was already revoked. */
  revokeToken(id: string, now: Date): Promise<boolean>;
  revokeFamily(familyId: string, now: Date): Promise<void>;
  revokeUserClient(userId: number, clientId: string, now: Date): Promise<number>;
  touchToken(id: string, now: Date): Promise<void>;
  /** Clients with a live refresh token for this user, with the latest token use. */
  listConnections(userId: number, now: Date): Promise<Connection[]>;
  insertAudit(row: NewAudit): Promise<void>;
  /** Deletes expired requests/codes and tokens that expired or were revoked before `before`. */
  sweep(before: Date): Promise<void>;
}

export const drizzleStore: OAuthStore = {
  async createClient(row) {
    await requireDb().insert(oauthClients).values(row);
  },
  async getClient(id) {
    const [row] = await requireDb().select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1);
    return row ?? null;
  },
  async createRequest(row) {
    await requireDb().insert(oauthCodes).values(row);
  },
  async getRequest(id) {
    const [row] = await requireDb().select().from(oauthCodes).where(eq(oauthCodes.id, id)).limit(1);
    return row ?? null;
  },
  async approveRequest(id, values, now) {
    const [result] = await requireDb()
      .update(oauthCodes)
      .set({ ...values, approvedAt: now })
      .where(and(eq(oauthCodes.id, id), isNull(oauthCodes.approvedAt), isNull(oauthCodes.usedAt), gt(oauthCodes.expiresAt, now)));
    return result.affectedRows === 1;
  },
  async closeRequest(id, now) {
    await requireDb()
      .update(oauthCodes)
      .set({ usedAt: now })
      .where(and(eq(oauthCodes.id, id), isNull(oauthCodes.usedAt)));
  },
  async getCodeByHash(codeHash) {
    const [row] = await requireDb().select().from(oauthCodes).where(eq(oauthCodes.codeHash, codeHash)).limit(1);
    return row ?? null;
  },
  async consumeCode(id, now) {
    const [result] = await requireDb()
      .update(oauthCodes)
      .set({ usedAt: now })
      .where(and(eq(oauthCodes.id, id), isNull(oauthCodes.usedAt)));
    return result.affectedRows === 1;
  },
  async insertTokens(rows) {
    if (rows.length) await requireDb().insert(oauthTokens).values(rows);
  },
  async getTokenByHash(tokenHash) {
    const [row] = await requireDb().select().from(oauthTokens).where(eq(oauthTokens.tokenHash, tokenHash)).limit(1);
    return row ?? null;
  },
  async revokeToken(id, now) {
    const [result] = await requireDb()
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.id, id), isNull(oauthTokens.revokedAt)));
    return result.affectedRows === 1;
  },
  async revokeFamily(familyId, now) {
    await requireDb()
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.familyId, familyId), isNull(oauthTokens.revokedAt)));
  },
  async revokeUserClient(userId, clientId, now) {
    const [result] = await requireDb()
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.clientId, clientId), isNull(oauthTokens.revokedAt)));
    return result.affectedRows;
  },
  async touchToken(id, now) {
    await requireDb().update(oauthTokens).set({ lastUsedAt: now }).where(eq(oauthTokens.id, id));
  },
  async listConnections(userId, now) {
    const db = requireDb();
    const live = await db
      .select({ clientId: oauthTokens.clientId, connectedAt: min(oauthTokens.createdAt) })
      .from(oauthTokens)
      .where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.kind, "REFRESH"), isNull(oauthTokens.revokedAt), gt(oauthTokens.expiresAt, now)))
      .groupBy(oauthTokens.clientId);
    if (!live.length) return [];
    const ids = live.map((l) => l.clientId);
    const [clients, used] = await Promise.all([
      db.select({ id: oauthClients.id, name: oauthClients.name }).from(oauthClients).where(inArray(oauthClients.id, ids)),
      db
        .select({ clientId: oauthTokens.clientId, lastUsedAt: max(oauthTokens.lastUsedAt) })
        .from(oauthTokens)
        .where(and(eq(oauthTokens.userId, userId), inArray(oauthTokens.clientId, ids)))
        .groupBy(oauthTokens.clientId),
    ]);
    return live
      .map((l) => ({
        clientId: l.clientId,
        clientName: clients.find((c) => c.id === l.clientId)?.name ?? l.clientId,
        connectedAt: l.connectedAt ?? now,
        lastUsedAt: used.find((u) => u.clientId === l.clientId)?.lastUsedAt ?? null,
      }))
      .sort((a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0));
  },
  async insertAudit(row) {
    await requireDb().insert(mcpAuditLog).values(row);
  },
  async sweep(before) {
    const db = requireDb();
    await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, before));
    await db.delete(oauthTokens).where(or(lt(oauthTokens.expiresAt, before), and(isNotNull(oauthTokens.revokedAt), lt(oauthTokens.revokedAt, before))));
  },
};

let current: OAuthStore = drizzleStore;

export const oauthStore = (): OAuthStore => current;

/** Tests swap in an in-memory store. */
export function setOAuthStore(store: OAuthStore | null) {
  current = store ?? drizzleStore;
}