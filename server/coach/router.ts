import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COACH_LOCALES, COACH_MAX_PASTE_CHARS, coachLocaleOf, MATERIAL_GOALS, RECALL_MODES, type CoachLocale } from "../../shared/coach";
import { rateLimit, router, studentProcedure } from "../_core/trpc";
import { isSchemaBehind } from "../syllabus/availability";
import { assertCoachEnabled, coachEnabledFor } from "./availability";
import * as materials from "./materials";
import { coachLimits, coachQuota } from "./quota";
import * as store from "./store";

const MINUTE = 60_000;

/** Coach tables not migrated yet → COACH_DB_NOT_READY instead of a 500. */
const tablesGuard = async <T extends { ok: boolean; error?: { cause?: unknown } }>(path: string, result: T) => {
  if (!result.ok && isSchemaBehind(result.error)) {
    console.warn(`[coach] ${path}: database schema is behind (migration not applied yet)`);
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "COACH_DB_NOT_READY" });
  }
  return result;
};

/** The student's own coach data only; the `study_coach` flag must be on for them. */
export const coachProcedure = studentProcedure.use(async ({ ctx, next, path }) => {
  await assertCoachEnabled(ctx.user.id);
  return tablesGuard(path, await next());
});

/** Like coachProcedure, and the privacy notice must have been accepted. */
export const coachConsentedProcedure = coachProcedure.use(async ({ ctx, next }) => {
  await store.assertConsent(ctx.user.id);
  return next();
});

/**
 * The app language the client is showing right now; generated content is written in it. Falls
 * back to the user's saved language.
 */
export const localeInput = z.enum(COACH_LOCALES).optional();
export const localeOf = (input: CoachLocale | undefined, user: { preferredLocale?: string | null }): CoachLocale => input ?? coachLocaleOf(user.preferredLocale);

const idInput = z.object({ id: z.string().min(1).max(32) });
const titleInput = z.string().max(200).optional();

const materialsRouter = router({
  list: coachConsentedProcedure.query(({ ctx }) => materials.listMaterials(ctx.user.id)),
  get: coachConsentedProcedure.input(idInput).query(({ ctx, input }) => materials.materialDetail(ctx.user.id, input.id)),
  createFromFile: coachConsentedProcedure
    .use(rateLimit("coachUpload", 10, MINUTE))
    .input(z.object({ fileId: z.string().min(1).max(32), title: titleInput, goal: z.enum(MATERIAL_GOALS).default("LEARN_ALL"), locale: localeInput }))
    .mutation(({ ctx, input }) => materials.createFromFile(ctx.user.id, { ...input, locale: localeOf(input.locale, ctx.user) })),
  createFromText: coachConsentedProcedure
    .use(rateLimit("coachUpload", 10, MINUTE))
    .input(z.object({ text: z.string().min(1).max(COACH_MAX_PASTE_CHARS + 10_000), title: titleInput, goal: z.enum(MATERIAL_GOALS).default("LEARN_ALL"), locale: localeInput }))
    .mutation(({ ctx, input }) => materials.createFromText(ctx.user.id, { ...input, locale: localeOf(input.locale, ctx.user) })),
  retry: coachConsentedProcedure
    .use(rateLimit("coachUpload", 10, MINUTE))
    .input(idInput.extend({ locale: localeInput }))
    .mutation(({ ctx, input }) => materials.retryMaterial(ctx.user.id, input.id, localeOf(input.locale, ctx.user))),
  rename: coachConsentedProcedure
    .input(idInput.extend({ title: z.string().min(1).max(200) }))
    .mutation(({ ctx, input }) => materials.renameMaterial(ctx.user.id, input.id, input.title)),
  remove: coachConsentedProcedure.input(idInput).mutation(({ ctx, input }) => materials.deleteMaterial(ctx.user.id, input.id)),
  chunks: coachConsentedProcedure.input(idInput).query(({ ctx, input }) => materials.materialChunks(ctx.user.id, input.id)),
  updateChunk: coachConsentedProcedure
    .use(rateLimit("coachEdit", 60, MINUTE))
    .input(idInput.extend({ chunkId: z.string().min(1).max(32), text: z.string().min(1).max(materials.CHUNK_EDIT_MAX_CHARS + 2000) }))
    .mutation(({ ctx, input }) => materials.updateChunk(ctx.user.id, input.id, input.chunkId, input.text)),
  markReviewed: coachConsentedProcedure.input(idInput).mutation(({ ctx, input }) => materials.markReviewed(ctx.user.id, input.id)),
});

export const studentCoachRouter = router({
  enabled: studentProcedure.query(async ({ ctx }) => ({ enabled: await coachEnabledFor(ctx.user.id) })),
  status: coachProcedure.query(async ({ ctx }) => ({
    settings: await store.settingsOf(ctx.user.id),
    quota: await coachQuota(ctx.user.id),
    limits: await coachLimits(),
  })),
  acceptConsent: coachProcedure.use(rateLimit("coachSettings", 20, MINUTE)).mutation(({ ctx }) => store.acceptConsent(ctx.user.id)),
  saveSettings: coachProcedure
    .use(rateLimit("coachSettings", 20, MINUTE))
    .input(z.object({ recallMode: z.enum(RECALL_MODES).optional(), reminders: z.boolean().optional() }))
    .mutation(({ ctx, input }) => store.saveSettings(ctx.user.id, input)),
  materials: materialsRouter,
});
