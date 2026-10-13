import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { userFeatureSeen } from "../drizzle/schema";
import { WHATS_NEW_IDS } from "../shared/whatsNew";
import { protectedProcedure, rateLimit, router } from "./_core/trpc";
import { requireDb } from "./db";
import { isMissingTable } from "./notifications/preferences";

export type WhatsNewMarkRow = { featureId: string; seenAt: Date | null; dismissedAt: Date | null };

/**
 * The user's seen/dismissed marks. `ready: false` before migration 0060: the client then keeps the
 * marks in localStorage only, and nothing breaks.
 */
export async function whatsNewState(userId: number): Promise<{ ready: boolean; items: WhatsNewMarkRow[] }> {
  try {
    const rows = await requireDb()
      .select({ featureId: userFeatureSeen.featureId, seenAt: userFeatureSeen.seenAt, dismissedAt: userFeatureSeen.dismissedAt })
      .from(userFeatureSeen)
      .where(eq(userFeatureSeen.userId, userId));
    return { ready: true, items: rows };
  } catch (error) {
    if (isMissingTable(error)) return { ready: false, items: [] };
    throw error;
  }
}

/** Keeps the first time of each mark: opening a page twice, or closing a card again, changes nothing. */
export async function markWhatsNew(userId: number, featureIds: string[], kind: "seen" | "dismissed", now = new Date()): Promise<{ ready: boolean }> {
  const ids = [...new Set(featureIds)];
  if (!ids.length) return { ready: true };
  const column = kind === "seen" ? userFeatureSeen.seenAt : userFeatureSeen.dismissedAt;
  try {
    await requireDb()
      .insert(userFeatureSeen)
      .values(ids.map((featureId) => ({ userId, featureId, [kind === "seen" ? "seenAt" : "dismissedAt"]: now })))
      .onDuplicateKeyUpdate({ set: { [kind === "seen" ? "seenAt" : "dismissedAt"]: sql`coalesce(${column}, ${now})` } });
    return { ready: true };
  } catch (error) {
    if (isMissingTable(error)) return { ready: false };
    throw error;
  }
}

const ids = z.object({ ids: z.array(z.enum(WHATS_NEW_IDS)).min(1).max(WHATS_NEW_IDS.length) });

export const whatsNewRouter = router({
  state: protectedProcedure.query(({ ctx }) => whatsNewState(ctx.user.id)),
  markSeen: protectedProcedure
    .use(rateLimit("whatsNewMark", 60, 60_000))
    .input(ids)
    .mutation(({ ctx, input }) => markWhatsNew(ctx.user.id, input.ids, "seen")),
  dismiss: protectedProcedure
    .use(rateLimit("whatsNewMark", 60, 60_000))
    .input(ids)
    .mutation(({ ctx, input }) => markWhatsNew(ctx.user.id, input.ids, "dismissed")),
});
