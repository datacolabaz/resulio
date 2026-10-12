import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { studentAnswerSchema } from "../../shared/assessment";
import { COACH_HARD_MAX_UPLOAD_MB, COACH_LOCALES, COACH_MAX_PASTE_CHARS, coachLocaleOf, MATERIAL_GOALS, PRACTICE_FORMATS, RECALL_MODES, SUMMARY_FORMATS, TUTOR_ACTIONS, type CoachLocale } from "../../shared/coach";
import { rateLimit, router, studentProcedure, teacherProcedure } from "../_core/trpc";
import { MAX_PART_URLS_PER_CALL } from "../materials/directUpload";
import { isSchemaBehind } from "../syllabus/availability";
import { assertCoachEnabled, coachEnabledFor } from "./availability";
import * as materials from "./materials";
import * as packs from "./packs";
import * as practice from "./practice";
import * as review from "./review";
import * as tutor from "./tutor";
import * as shares from "./shares";
import * as uploads from "./uploads";
import * as retention from "./retention";
import { inExam } from "./examLock";
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

const sessionInput = z.object({ sessionId: z.string().min(1).max(32) });

/** Files above the API upload limit, straight to R2 (server/coach/uploads.ts). */
const uploadsRouter = router({
  start: coachConsentedProcedure
    .use(rateLimit("coachUploadStart", 20, MINUTE))
    .input(z.object({ fileName: z.string().trim().min(1).max(255), sizeBytes: z.number().int().positive().max(COACH_HARD_MAX_UPLOAD_MB * 1024 * 1024) }))
    .mutation(({ ctx, input }) => uploads.startCoachUpload(ctx.user.id, input)),
  partUrls: coachConsentedProcedure
    .use(rateLimit("coachUploadParts", 120, MINUTE))
    .input(sessionInput.extend({ partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(MAX_PART_URLS_PER_CALL) }))
    .mutation(({ ctx, input }) => uploads.coachUploadPartUrls(ctx.user.id, input.sessionId, input.partNumbers)),
  complete: coachConsentedProcedure.input(sessionInput).mutation(({ ctx, input }) => uploads.completeCoachUpload(ctx.user.id, input.sessionId)),
  abort: coachConsentedProcedure.input(sessionInput).mutation(({ ctx, input }) => uploads.abortCoachUpload(ctx.user.id, input.sessionId)),
});

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

const learnRouter = router({
  topic: coachConsentedProcedure.input(z.object({ topicId: z.string().min(1).max(32) })).query(({ ctx, input }) => packs.topicDetail(ctx.user.id, input.topicId)),
  pack: coachConsentedProcedure
    .input(z.object({ topicId: z.string().min(1).max(32), format: z.enum(SUMMARY_FORMATS), locale: localeInput }))
    .query(({ ctx, input }) => packs.getPack(ctx.user.id, input.topicId, input.format, localeOf(input.locale, ctx.user))),
  generate: coachConsentedProcedure
    .use(rateLimit("coachGenerate", 12, MINUTE))
    .input(z.object({ topicId: z.string().min(1).max(32), format: z.enum(SUMMARY_FORMATS), locale: localeInput }))
    .mutation(({ ctx, input }) => packs.generatePack(ctx.user.id, input.topicId, input.format, localeOf(input.locale, ctx.user))),
  edit: coachConsentedProcedure
    .use(rateLimit("coachEdit", 60, MINUTE))
    .input(
      z.object({
        artifactId: z.string().min(1).max(32),
        section: z.number().int().min(0).max(50).optional(),
        point: z.number().int().min(0).max(50).optional(),
        concept: z.number().int().min(0).max(50).optional(),
        text: z.string().min(1).max(1000),
      }),
    )
    .mutation(({ ctx, input }) => packs.editPack(ctx.user.id, input)),
  cited: coachConsentedProcedure
    .input(z.object({ chunkIds: z.array(z.string().min(1).max(32)).max(10) }))
    .query(({ ctx, input }) => packs.citedChunks(ctx.user.id, input.chunkIds)),
});

const quizIdInput = z.object({ quizId: z.string().min(1).max(32) });

const practiceRouter = router({
  list: coachConsentedProcedure
    .input(z.object({ topicId: z.string().min(1).max(32).optional() }))
    .query(({ ctx, input }) => practice.listQuizzes(ctx.user.id, input.topicId)),
  get: coachConsentedProcedure.input(quizIdInput).query(({ ctx, input }) => practice.getQuiz(ctx.user.id, input.quizId)),
  progress: coachConsentedProcedure.input(z.object({ topicId: z.string().min(1).max(32) })).query(({ ctx, input }) => practice.topicProgress(ctx.user.id, input.topicId)),
  start: coachConsentedProcedure
    .use(rateLimit("coachGenerate", 12, MINUTE))
    .input(z.object({ topicId: z.string().min(1).max(32), format: z.enum(PRACTICE_FORMATS), count: z.union([z.literal(5), z.literal(10), z.literal(15)]), locale: localeInput }))
    .mutation(({ ctx, input }) => practice.startQuiz(ctx.user.id, { ...input, locale: localeOf(input.locale, ctx.user) })),
  saveAnswer: coachConsentedProcedure
    .use(rateLimit("coachAnswer", 240, MINUTE))
    .input(quizIdInput.extend({ itemId: z.string().min(1).max(32), answer: studentAnswerSchema }))
    .mutation(({ ctx, input }) => practice.saveAnswer(ctx.user.id, input.quizId, input.itemId, input.answer)),
  hint: coachConsentedProcedure
    .use(rateLimit("coachAnswer", 240, MINUTE))
    .input(quizIdInput.extend({ itemId: z.string().min(1).max(32) }))
    .mutation(({ ctx, input }) => practice.useHint(ctx.user.id, input.quizId, input.itemId)),
  submit: coachConsentedProcedure
    .use(rateLimit("coachSubmit", 20, MINUTE))
    .input(quizIdInput.extend({ answers: z.record(z.string().max(32), studentAnswerSchema.optional()) }))
    .mutation(({ ctx, input }) => practice.submitQuiz(ctx.user.id, input.quizId, input.answers)),
  regrade: coachConsentedProcedure
    .use(rateLimit("coachSubmit", 20, MINUTE))
    .input(quizIdInput.extend({ itemId: z.string().min(1).max(32) }))
    .mutation(({ ctx, input }) => practice.regradeItem(ctx.user.id, input.quizId, input.itemId)),
});

const tutorRouter = router({
  threads: coachConsentedProcedure.input(z.object({ topicId: z.string().min(1).max(32) })).query(({ ctx, input }) => tutor.listThreads(ctx.user.id, input.topicId)),
  thread: coachConsentedProcedure.input(z.object({ threadId: z.string().min(1).max(32) })).query(({ ctx, input }) => tutor.getThread(ctx.user.id, input.threadId)),
  locked: coachConsentedProcedure.query(async ({ ctx }) => ({ locked: await inExam(ctx.user.id) })),
  ask: coachConsentedProcedure
    .use(rateLimit("coachTutor", 10, MINUTE))
    .input(
      z
        .object({
          topicId: z.string().min(1).max(32),
          threadId: z.string().min(1).max(32).optional(),
          action: z.enum(TUTOR_ACTIONS),
          text: z.string().max(tutor.TUTOR_MAX_CHARS + 500).default(""),
          locale: localeInput,
        })
        .refine((v) => v.action !== "ASK" || v.text.trim().length > 0, { message: "VALIDATION_ERROR", path: ["text"] }),
    )
    .mutation(({ ctx, input }) => tutor.ask(ctx.user.id, { ...input, locale: localeOf(input.locale, ctx.user) })),
  remove: coachConsentedProcedure.input(z.object({ threadId: z.string().min(1).max(32) })).mutation(({ ctx, input }) => tutor.deleteThread(ctx.user.id, input.threadId)),
});

const reviewRouter = router({
  queue: coachConsentedProcedure.query(({ ctx }) => review.reviewQueue(ctx.user.id)),
  /** Student home card: null when the coach is off, the notice not accepted, or reminders are off. */
  home: studentProcedure.query(async ({ ctx }) => {
    if (!(await coachEnabledFor(ctx.user.id))) return null;
    try {
      return await review.homeSummary(ctx.user.id);
    } catch (error) {
      if (isSchemaBehind(error)) return null;
      throw error;
    }
  }),
  mistakes: coachConsentedProcedure.input(z.object({ includeFixed: z.boolean().default(false) })).query(({ ctx, input }) => review.listMistakes(ctx.user.id, input.includeFixed)),
  fixMistake: coachConsentedProcedure.input(idInput).mutation(({ ctx, input }) => review.markMistakeFixed(ctx.user.id, input.id)),
  materialProgress: coachConsentedProcedure.input(idInput).query(({ ctx, input }) => review.materialProgress(ctx.user.id, input.id)),
});

/** "AI yaddaşı": what the coach remembers, deletable one by one or all at once. */
const memoryRouter = router({
  list: coachConsentedProcedure.query(({ ctx }) => review.memory(ctx.user.id)),
  forgetTopic: coachConsentedProcedure.input(z.object({ topicId: z.string().min(1).max(32) })).mutation(({ ctx, input }) => review.forgetTopic(ctx.user.id, input.topicId)),
  forgetMistake: coachConsentedProcedure.input(idInput).mutation(({ ctx, input }) => review.forgetMistake(ctx.user.id, input.id)),
  forgetAll: coachConsentedProcedure.use(rateLimit("coachSettings", 20, MINUTE)).mutation(({ ctx }) => review.forgetAll(ctx.user.id)),
});

const shareTarget = z.object({ teacherId: z.number().int().positive(), workspaceId: z.string().min(1).max(32) });

/** "Müəllimlə paylaş": off by default; one material, one teacher, revocable. */
const sharesRouter = router({
  targets: coachConsentedProcedure.query(({ ctx }) => shares.shareTargets(ctx.user.id)),
  list: coachConsentedProcedure.input(idInput).query(({ ctx, input }) => shares.materialShares(ctx.user.id, input.id)),
  share: coachConsentedProcedure
    .use(rateLimit("coachShare", 20, MINUTE))
    .input(idInput.extend({ target: shareTarget }))
    .mutation(({ ctx, input }) => shares.shareMaterial(ctx.user.id, input.id, input.target)),
  revoke: coachConsentedProcedure.input(z.object({ shareId: z.string().min(1).max(32) })).mutation(({ ctx, input }) => shares.revokeShare(ctx.user.id, input.shareId)),
});

export const studentCoachRouter = router({
  enabled: studentProcedure.query(async ({ ctx }) => ({ enabled: await coachEnabledFor(ctx.user.id) })),
  status: coachProcedure.query(async ({ ctx }) => ({
    settings: await store.settingsOf(ctx.user.id),
    quota: await coachQuota(ctx.user.id),
    limits: await coachLimits(),
    upload: await materials.uploadLimits(),
  })),
  acceptConsent: coachProcedure.use(rateLimit("coachSettings", 20, MINUTE)).mutation(({ ctx }) => store.acceptConsent(ctx.user.id)),
  saveSettings: coachProcedure
    .use(rateLimit("coachSettings", 20, MINUTE))
    .input(z.object({ recallMode: z.enum(RECALL_MODES).optional(), reminders: z.boolean().optional() }))
    .mutation(({ ctx, input }) => store.saveSettings(ctx.user.id, input)),
  materials: materialsRouter,
  uploads: uploadsRouter,
  learn: learnRouter,
  practice: practiceRouter,
  review: reviewRouter,
  memory: memoryRouter,
  tutor: tutorRouter,
  shares: sharesRouter,
  /** Every coach row and file of the student; works with the flag off too, so data can always be removed. */
  deleteAllData: studentProcedure
    .use(rateLimit("coachSettings", 20, MINUTE))
    .input(z.object({ confirm: z.literal(true) }))
    .mutation(async ({ ctx }) => {
      try {
        return await retention.deleteAllCoachData(ctx.user.id);
      } catch (error) {
        if (isSchemaBehind(error)) return { ok: true as const, materials: 0 };
        throw error;
      }
    }),
});

/** Teacher side: materials students shared with them, read-only (never quizzes, chat or mastery). */
export const teacherCoachSharesRouter = router({
  list: teacherProcedure.query(async ({ ctx }) => {
    try {
      return await shares.sharedWithTeacher(ctx.user.id, ctx.workspace.id);
    } catch (error) {
      if (isSchemaBehind(error)) return [];
      throw error;
    }
  }),
  get: teacherProcedure
    .input(z.object({ shareId: z.string().min(1).max(32), locale: localeInput }))
    .query(({ ctx, input }) => shares.sharedView(ctx.user.id, ctx.workspace.id, input.shareId, localeOf(input.locale, ctx.user))),
});
