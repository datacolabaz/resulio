import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { DIFFICULTIES, QUESTION_TYPES, questionInputSchema } from "../../shared/assessment";
import { topicInputSchema, topicNameSchema } from "../../shared/questionImport";
import { rateLimit, router, teacherProcedure } from "../_core/trpc";
import * as assessments from "../modules/assessments";
import type { TeacherScope } from "../modules/access";
import { isMissingTable } from "../notifications/preferences";
import * as imports from "./importJobs";
import * as topics from "./topics";

const MINUTE = 60_000;
const entityId = z.string().trim().min(1).max(32);
const ids = z.array(entityId).min(1).max(500);

/** Bank tables (migration 0030) not migrated yet → QUESTION_BANK_NOT_READY instead of a 500. */
const bankProcedure = teacherProcedure.use(async ({ next, path }) => {
  const result = await next();
  if (!result.ok && isMissingTable(result.error)) {
    console.warn(`[questionBank] ${path}: database schema is behind (migration not applied yet)`);
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "QUESTION_BANK_NOT_READY" });
  }
  return result;
});

export const questionBankFilter = z
  .object({
    topic: z.string().max(120).optional(),
    /** A topic and all its subtopics. */
    topicId: entityId.optional(),
    difficulty: z.enum(DIFFICULTIES).optional(),
    type: z.enum(QUESTION_TYPES).optional(),
    source: z.enum(["MANUAL", "AI"]).optional(),
    search: z.string().max(200).optional(),
  })
  .default({});

/** The bank with each question's topic id; topic filtering needs migration 0030, the rest does not. */
export async function bankWithTopics(scope: TeacherScope, filter: z.infer<typeof questionBankFilter>) {
  const { topicId, ...rest } = filter;
  const onlyIds = topicId ? await topics.guardBankTables(() => topics.questionIdsUnder(scope, topicId)) : undefined;
  if (onlyIds && !onlyIds.length) return [];
  const rows = await assessments.questionBank(scope, { ...rest, ids: onlyIds });
  const topicOf = await topics.topicIdsOf(scope.workspaceId, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, topicId: topicOf.get(r.id) ?? null }));
}

const topicPatch = topicInputSchema.partial().extend({ name: topicNameSchema.optional() });

export const questionTopicsRouter = router({
  list: bankProcedure.query(({ ctx }) => topics.listTopics(ctx.scope)),
  create: bankProcedure
    .use(rateLimit("questionTopicCreate", 60, MINUTE))
    .input(topicInputSchema)
    .mutation(({ ctx, input }) => topics.createTopic(ctx.scope, input)),
  update: bankProcedure
    .input(z.object({ id: entityId, patch: topicPatch }))
    .mutation(({ ctx, input }) => topics.updateTopic(ctx.scope, input.id, input.patch)),
  remove: bankProcedure.input(z.object({ id: entityId })).mutation(({ ctx, input }) => topics.deleteTopic(ctx.scope, input.id)),
  assign: bankProcedure
    .input(z.object({ questionIds: ids, topicId: entityId.nullable() }))
    .mutation(({ ctx, input }) => topics.assignTopic(ctx.scope, input.questionIds, input.topicId)),
  syllabusOutline: bankProcedure.query(({ ctx }) => topics.syllabusOutline(ctx.scope)),
  fromSyllabus: bankProcedure
    .use(rateLimit("questionTopicsFromSyllabus", 10, MINUTE))
    .input(z.object({ syllabusId: entityId }))
    .mutation(({ ctx, input }) => topics.topicsFromSyllabus(ctx.scope, input.syllabusId)),
});

export const questionImportRouter = router({
  availability: bankProcedure.query(({ ctx }) => imports.importAvailability(ctx.scope)),
  list: bankProcedure.query(({ ctx }) => imports.listImports(ctx.scope)),
  detail: bankProcedure.input(z.object({ id: entityId })).query(({ ctx, input }) => imports.importDetail(ctx.scope, input.id)),
  start: bankProcedure
    .use(rateLimit("questionImportStart", 10, MINUTE))
    .input(z.object({ fileId: entityId, topicId: entityId.nullable().optional() }))
    .mutation(({ ctx, input }) => imports.startImport(ctx.scope, input)),
  retry: bankProcedure
    .use(rateLimit("questionImportStart", 10, MINUTE))
    .input(z.object({ id: entityId }))
    .mutation(({ ctx, input }) => imports.retryImport(ctx.scope, input.id)),
  remove: bankProcedure.input(z.object({ id: entityId })).mutation(({ ctx, input }) => imports.deleteImport(ctx.scope, input.id)),
  updateItem: bankProcedure
    .input(
      z.object({
        id: entityId,
        question: questionInputSchema.optional(),
        topicId: entityId.nullable().optional(),
        proposedTopic: z.string().trim().max(120).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => imports.updateItem(ctx.scope, input.id, input)),
  reject: bankProcedure
    .input(z.object({ ids, rejected: z.boolean().default(true) }))
    .mutation(({ ctx, input }) => imports.rejectItems(ctx.scope, input.ids, input.rejected)),
  accept: bankProcedure
    .use(rateLimit("questionImportAccept", 30, MINUTE))
    .input(z.object({ jobId: entityId, ids: z.union([ids, z.literal("ALL")]), skipDuplicates: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => imports.acceptItems(ctx.scope, input.jobId, input.ids, { skipDuplicates: input.skipDuplicates })),
});
