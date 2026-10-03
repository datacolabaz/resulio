import { and, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { pushDevices, PUSH_PLATFORMS } from "../../drizzle/schema";
import { envString } from "../_core/env";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { isMissingTable } from "./preferences";

/**
 * Mobile push. Provider-agnostic interface; Expo is the built-in provider (fits a React Native /
 * Expo app). Off unless PUSH_PROVIDER is set. Tokens are sensitive: never log or return them.
 */

export type PushPlatform = (typeof PUSH_PLATFORMS)[number];
export const PUSH_PROVIDERS = ["expo"] as const;
export type PushProviderName = (typeof PUSH_PROVIDERS)[number];

export interface PushMessage {
  title: string;
  body: string;
  /** Small string map for the app, e.g. { event, path }. */
  data: Record<string, string>;
}

export type PushTicket = { ok: true } | { ok: false; invalidToken: boolean; error: string };

export interface PushProvider {
  name: PushProviderName;
  /** One ticket per token, same order. Throws on transport errors (retried by the dispatcher). */
  send(tokens: string[], message: PushMessage): Promise<PushTicket[]>;
}

export const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const PUSH_TIMEOUT_MS = 10_000;

export function expoProvider(accessToken: string, doFetch: typeof fetch = fetch): PushProvider {
  return {
    name: "expo",
    async send(tokens, message) {
      const response = await doFetch(EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify(tokens.map((to) => ({ to, title: message.title, body: message.body, data: message.data, sound: "default" }))),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Expo push responded ${response.status}`);
      const json = (await response.json().catch(() => ({}))) as { data?: Array<{ status?: string; details?: { error?: string }; message?: string }> };
      return tokens.map((_, i) => {
        const t = json.data?.[i];
        if (t?.status === "ok") return { ok: true } as const;
        const error = t?.details?.error ?? "UNKNOWN";
        return { ok: false, invalidToken: error === "DeviceNotRegistered", error } as const;
      });
    },
  };
}

/** PUSH_PROVIDER=expo (optional EXPO_ACCESS_TOKEN) turns push on; anything else leaves it off. */
export function pushProvider(env: NodeJS.ProcessEnv = process.env): PushProvider | null {
  const name = envString("PUSH_PROVIDER", env).toLowerCase();
  if (name === "expo") return expoProvider(envString("EXPO_ACCESS_TOKEN", env));
  return null;
}

export const pushEnabled = (env: NodeJS.ProcessEnv = process.env) => pushProvider(env) !== null;

// ---------------------------------------------------------------------------
// Device registry
// ---------------------------------------------------------------------------

function wrapMissing<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error) => {
    throw isMissingTable(error) ? new AppError("DATABASE_UNAVAILABLE") : error;
  });
}

/** Upserts by token: a token that moved to another account (sign-out/sign-in on the phone) follows the new user. */
export async function registerDevice(userId: number, input: { platform: PushPlatform; token: string; provider: PushProviderName }) {
  const now = new Date();
  await wrapMissing(
    requireDb()
      .insert(pushDevices)
      .values({ id: nanoid(), userId, platform: input.platform, provider: input.provider, token: input.token, lastSeenAt: now })
      .onDuplicateKeyUpdate({ set: { userId, platform: input.platform, provider: input.provider, lastSeenAt: now, revokedAt: null } }),
  );
  return { ok: true };
}

export async function unregisterDevice(userId: number, token: string) {
  await wrapMissing(
    requireDb().update(pushDevices).set({ revokedAt: new Date() }).where(and(eq(pushDevices.userId, userId), eq(pushDevices.token, token))),
  );
  return { ok: true };
}

/** Active tokens of a user for one provider; empty if the device table is not migrated yet. */
export async function activeTokens(userId: number, provider: PushProviderName): Promise<string[]> {
  try {
    const rows = await requireDb()
      .select({ token: pushDevices.token })
      .from(pushDevices)
      .where(and(eq(pushDevices.userId, userId), eq(pushDevices.provider, provider), isNull(pushDevices.revokedAt)));
    return rows.map((r) => r.token);
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

export async function revokeTokens(tokens: string[]) {
  if (!tokens.length) return;
  await requireDb().update(pushDevices).set({ revokedAt: new Date() }).where(inArray(pushDevices.token, tokens));
}
