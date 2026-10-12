import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ProviderWorkspace, User } from "../../drizzle/schema";
import { ASSESSMENT_TYPES, LIVE_STATUSES, questionInputSchema } from "../../shared/assessment";
import type { McpScope } from "../../shared/mcpConnector";
import { hitRateLimit } from "../_core/rateLimit";
import type { TeacherScope } from "../modules/access";
import * as activity from "../modules/activity";
import * as assessments from "../modules/assessments";
import * as attempts from "../modules/attempts";
import { AppError } from "../modules/errors";
import * as groups from "../modules/groups";
import { assertAccessGroups, assertRecipients } from "../modules/recipients";
import * as tasks from "../modules/tasks";
import * as bank from "../questionBank/bank";
import { ensureTopic, guardBankTables } from "../questionBank/topics";
import { recordMcpAudit, summarizeArgs, type AuditStatus } from "./audit";
import { frontendBase } from "./config";

/** Everything a tool call acts with, resolved from the access token on this request. */
export type McpContext = {
  user: User;
  workspace: ProviderWorkspace;
  scope: TeacherScope;
  scopes: McpScope[];
  clientId: string;
  base: string;
};

const WRITE_LIMIT = 60;
const WRITE_WINDOW_MS = 60 * 60_000;
const MAX_ROWS = 200;

/** A problem with the arguments themselves, explained to the model in plain words. */
class ToolInputError extends Error {}

const MESSAGES: Record<string, string> = {
  NOT_FOUND: "Not found in this Resulio workspace: it does not exist or belongs to another teacher.",
  FORBIDDEN: "That group or student does not belong to this Resulio workspace.",
  NO_QUESTIONS: "The exam has no questions yet, so it cannot be sent to students.",
  CLOSED: "The exam is closed and can no longer be changed or sent.",
  INVALID_QUESTION: "One of the questions is not valid for its question type.",
  TASK_GROUPS_REQUIRED: "This task is restricted to groups, so it needs at least one group.",
  QUESTION_BANK_NOT_READY: "The question bank is not available on this server yet. Try again later.",
  TOPIC_EXISTS: "A question bank section with that name could not be created. Try a different bank_section.",
  RATE_LIMITED: "Too many changes in a short time. Wait a few minutes and try again.",
};

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

const isoDate = z.iso.datetime({ offset: true });
const entityId = z.string().min(1).max(32);
const studentId = z.number().int().positive();

const appLinks = (ctx: McpContext) => {
  const front = frontendBase(ctx.base);
  return {
    exam: (id: string) => `${front}/teacher/assessments/${id}/edit`,
    examResults: (id: string) => `${front}/teacher/assessments/${id}/participants`,
    examShare: (code: string) => `${front}/exam/${code}`,
    tasks: () => `${front}/teacher/assignments`,
    taskShare: (code: string) => `${front}/task/${code}`,
  };
};

async function ownedGroups(ctx: McpContext, ids: string[]) {
  if (!ids.length) return [];
  const all = await groups.teacherGroups(ctx.scope);
  const picked = ids.map((id) => all.find((g) => g.id === id));
  const missing = ids.filter((_, i) => !picked[i]);
  if (missing.length) throw new ToolInputError(`Group not found in this Resulio workspace: ${missing.join(", ")}. Use list_groups to get valid ids.`);
  return picked.map((g) => ({ id: g!.id, name: g!.name, student_count: g!.studentCount }));
}

/** Only students who are active members of one of this teacher's groups can be picked individually. */
async function ownedStudents(ctx: McpContext, ids: number[]) {
  if (!ids.length) return [];
  const all = await groups.teacherStudents(ctx.scope);
  const picked = ids.map((id) => all.find((s) => s.id === id));
  const missing = ids.filter((_, i) => !picked[i]);
  if (missing.length) throw new ToolInputError(`Student not found among this teacher's students: ${missing.join(", ")}. Use list_students to get valid ids.`);
  return picked.map((s) => ({ id: s!.id, name: s!.name }));
}

type ToolDef<S extends z.ZodRawShape> = {
  title: string;
  description: string;
  /** The call needs at least one of these scopes. */
  scopes: McpScope[];
  write: boolean;
  input: S;
  run: (args: z.infer<z.ZodObject<S>>, ctx: McpContext) => Promise<{ status?: AuditStatus; data: unknown }>;
};

function register<S extends z.ZodRawShape>(server: McpServer, ctx: McpContext, name: string, def: ToolDef<S>) {
  server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      annotations: { readOnlyHint: !def.write, destructiveHint: false, idempotentHint: !def.write, openWorldHint: false },
    },
    (async (args: z.infer<z.ZodObject<S>>) => {
      const started = Date.now();
      const audit = (status: AuditStatus, errorCode: string | null) =>
        recordMcpAudit({ userId: ctx.user.id, workspaceId: ctx.workspace.id, clientId: ctx.clientId, tool: name, args: summarizeArgs(args), status, errorCode, durationMs: Date.now() - started });
      if (!def.scopes.some((s) => ctx.scopes.includes(s))) {
        await audit("DENIED", "INSUFFICIENT_SCOPE");
        return failure(`This connection was not granted permission for ${name} (needs ${def.scopes.join(" or ")}). Disconnect and reconnect Resulio in Claude to grant it.`);
      }
      if (def.write && hitRateLimit(`mcpWrite:u:${ctx.user.id}`, WRITE_LIMIT, WRITE_WINDOW_MS)) {
        await audit("DENIED", "RATE_LIMITED");
        return failure(MESSAGES.RATE_LIMITED);
      }
      try {
        const { status = "OK", data } = await def.run(args, ctx);
        await audit(status, null);
        return text(data);
      } catch (error) {
        if (error instanceof ToolInputError) {
          await audit("ERROR", "INVALID_INPUT");
          return failure(error.message);
        }
        if (error instanceof AppError) {
          await audit("ERROR", error.code);
          return failure(MESSAGES[error.code] ?? `Resulio refused the request (${error.code}).`);
        }
        console.error(`[MCP] ${name} failed`, error instanceof Error ? error.message : error);
        await audit("ERROR", "INTERNAL_ERROR");
        return failure("Resulio hit an internal error. Nothing more is known; try again later.");
      }
    }) as never,
  );
}

const PREVIEW_MESSAGE = "Nothing was sent. Show this preview to the teacher and call again with confirm=true once they agree.";

/** One MCP server per HTTP request (stateless Streamable HTTP), bound to the caller's teacher scope. */
export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "resulio", title: "Resulio", version: "1.0.0" },
    {
      instructions:
        `Resulio is an assessment platform. These tools act in the teacher workspace "${ctx.workspace.title}" of ${ctx.user.name ?? "the signed-in teacher"}. ` +
        "Exams are created as drafts that students cannot see. send_assignment makes an exam or task visible to the chosen groups or students, " +
        "so always call it with confirm=false first, show the preview to the teacher, and repeat with confirm=true only after they agree. " +
        "There are no delete tools; deleting is done in the Resulio web app.",
    },
  );
  const links = appLinks(ctx);

  register(server, ctx, "list_groups", {
    title: "List groups",
    description: "Lists the teacher's student groups with their ids and active student counts. Use the ids with send_assignment.",
    scopes: ["groups:read"],
    write: false,
    input: {},
    run: async () => {
      const rows = await groups.teacherGroups(ctx.scope);
      return {
        data: rows.slice(0, MAX_ROWS).map((g) => ({
          id: g.id,
          name: g.name,
          subject: g.subject,
          grade: g.grade,
          student_count: g.studentCount,
          pending_join_requests: g.pendingCount,
        })),
      };
    },
  });

  register(server, ctx, "list_students", {
    title: "List students",
    description: "Lists the teacher's students (active members of the teacher's groups) with their ids and groups, optionally for one group. Use the ids with send_assignment or get_results.",
    scopes: ["groups:read"],
    write: false,
    input: { group_id: entityId.optional() },
    run: async (args) => {
      const rows = await groups.teacherStudents(ctx.scope);
      return {
        data: rows
          .filter((s) => !args.group_id || s.groupIds.includes(args.group_id))
          .slice(0, MAX_ROWS * 2)
          .map((s) => ({ id: s.id, name: s.name, groups: s.groups, group_ids: s.groupIds })),
      };
    },
  });

  register(server, ctx, "list_exams", {
    title: "List exams",
    description:
      "Lists the teacher's exams (newest first) with status and availability window. status: DRAFT (not published), SCHEDULED (window not open yet), ACTIVE (students can take it), COMPLETED (window closed or exam closed).",
    scopes: ["exams:read", "exams:write"],
    write: false,
    input: {
      type: z.enum(ASSESSMENT_TYPES).optional().describe("EXAM, KSQ (small summative) or BSQ (big summative); all when omitted"),
      status: z.enum(LIVE_STATUSES).optional(),
      limit: z.number().int().min(1).max(MAX_ROWS).default(50),
    },
    run: async (args) => {
      const rows = await assessments.listForTeacher(ctx.scope, { type: args.type, liveStatus: args.status });
      return {
        data: rows.slice(0, args.limit).map((a) => ({
          id: a.id,
          title: a.title,
          type: a.type,
          status: a.liveStatus,
          published: Boolean(a.currentVersionId),
          unpublished_changes: a.hasDraftChanges && Boolean(a.currentVersionId),
          start_at: a.startAt,
          end_at: a.endAt,
          timezone: a.timezone,
          duration_minutes: Math.round(a.durationSeconds / 60),
          edit_url: links.exam(a.id),
        })),
      };
    },
  });

  register(server, ctx, "list_tasks", {
    title: "List tasks",
    description: "Lists the teacher's tasks (homework/assignments) with deadline, groups and submission counts. Task ids can be sent with send_assignment (kind task).",
    scopes: ["exams:read", "assignments:send"],
    write: false,
    input: { limit: z.number().int().min(1).max(MAX_ROWS).default(50) },
    run: async (args) => {
      const rows = await tasks.listForWorkspace(ctx.scope.workspaceId);
      return {
        data: rows
          .slice()
          .reverse()
          .slice(0, args.limit)
          .map((t) => ({
            id: t.id,
            title: t.title,
            deadline: t.deadline,
            group_ids: t.groupIds,
            student_ids: t.studentIds,
            access_mode: t.accessMode,
            submissions: t.submissions.filter((s) => s.status !== "NOT_STARTED" && s.status !== "IN_PROGRESS").length,
            reviewed: t.submissions.filter((s) => s.status === "REVIEWED").length,
          })),
      };
    },
  });

  register(server, ctx, "create_exam", {
    title: "Create exam (draft)",
    description:
      "Creates a new exam as a DRAFT with its questions. Students cannot see it until it is sent with send_assignment. " +
      "Questions are also saved to the teacher's question bank (bank_subject / bank_section). Supported question types: MULTIPLE_CHOICE " +
      "(content.options [{key,text}], answerKey.correct = key), MULTIPLE_SELECT (answerKey.correct = [keys]), TRUE_FALSE (answerKey.correct boolean), " +
      "SHORT_ANSWER (answerKey.accepted [strings]), LONG_ANSWER (graded by the teacher; optional answerKey.rubric), MATCHING (content.left/right, answerKey.pairs {leftKey: rightKey}), " +
      "ORDERING (content.items, answerKey.order [keys]), FILL_BLANK (content.blankCount, answerKey.blanks [[accepted]...]), NUMERIC (answerKey.value, tolerance). " +
      "Every question needs text, points (> 0) and type. Returns the exam id and a link to edit it in Resulio.",
    scopes: ["exams:write"],
    write: true,
    input: {
      title: z.string().trim().min(1).max(255),
      description: z.string().trim().max(5000).optional(),
      instructions: z.string().trim().max(5000).optional().describe("Shown to students before they start"),
      subject: z.string().trim().max(120).optional(),
      type: z.enum(ASSESSMENT_TYPES).default("EXAM"),
      duration_minutes: z.number().int().min(1).max(720),
      attempts_allowed: z.number().int().min(1).max(20).optional(),
      start_at: isoDate.optional().describe("When students may start, ISO 8601 with offset, e.g. 2026-10-20T09:00:00+04:00"),
      end_at: isoDate.optional().describe("When the exam closes, ISO 8601 with offset"),
      timezone: z.string().trim().min(1).max(64).optional().describe("IANA zone, default Asia/Baku"),
      questions: z.array(questionInputSchema).min(1).max(100),
      bank_subject: z.string().trim().min(1).max(120).optional().describe("Question bank subject to file the questions under (default: the exam subject, else Claude)"),
      bank_section: z.string().trim().min(1).max(120).optional().describe("Section inside the subject (default: the exam title)"),
    },
    run: async (args) => {
      const startAt = args.start_at ? new Date(args.start_at) : null;
      const endAt = args.end_at ? new Date(args.end_at) : null;
      if (startAt && endAt && endAt <= startAt) throw new ToolInputError("end_at must be after start_at.");
      const exam = await assessments.createAssessment(ctx.scope, {
        type: args.type,
        settings: {
          title: args.title,
          description: args.description ?? "",
          instructions: args.instructions ?? "",
          subject: args.subject ?? "",
          durationSeconds: args.duration_minutes * 60,
          ...(args.attempts_allowed ? { attemptsAllowed: args.attempts_allowed } : {}),
        },
      });
      if (startAt || endAt || args.timezone) {
        await assessments.updateSchedule(ctx.scope, exam.id, { startAt, endAt, timezone: args.timezone ?? exam.timezone });
      }
      const section = await guardBankTables(async () => {
        const subject = await ensureTopic(ctx.scope, args.bank_subject ?? (args.subject || "Claude"), null);
        return ensureTopic(ctx.scope, args.bank_section ?? args.title, subject.id);
      });
      for (const q of args.questions) await bank.createInAssessment(ctx.scope, exam.id, assessments.parseQuestion(q), section.id);
      const saved = await assessments.ownedAssessment(ctx.scope, exam.id);
      return {
        data: {
          exam_id: saved.id,
          title: saved.settings.title,
          type: saved.type,
          status: "DRAFT",
          question_count: args.questions.length,
          total_points: args.questions.reduce((s, q) => s + q.points, 0),
          start_at: saved.startAt,
          end_at: saved.endAt,
          edit_url: links.exam(saved.id),
          note: "Draft: students cannot see it. Use send_assignment to send it to groups or students.",
        },
      };
    },
  });

  register(server, ctx, "send_assignment", {
    title: "Send exam or task",
    description:
      "Sends an exam or a task to groups and/or individual students of this teacher (those already receiving it keep it). " +
      "For an exam it can also set the availability window and publishes the exam if it was never published. Students will see it; task recipients are notified " +
      "unless notify_students=false. Requires confirm=true; with confirm=false it only returns a preview.",
    scopes: ["assignments:send"],
    write: true,
    input: {
      kind: z.enum(["exam", "task"]),
      id: entityId.describe("Exam id (list_exams) or task id (list_tasks)"),
      group_ids: z.array(entityId).max(20).default([]).describe("Groups from list_groups"),
      student_ids: z.array(studentId).max(100).default([]).describe("Individual students from list_students"),
      start_at: isoDate.optional().describe("Exam only: new window start, ISO 8601 with offset; unchanged when omitted"),
      end_at: isoDate.optional().describe("Exam only: new window end, ISO 8601 with offset; unchanged when omitted"),
      timezone: z.string().trim().min(1).max(64).optional().describe("Exam only: IANA zone of the window"),
      notify_students: z.boolean().default(true).describe("Task only: send students a notification"),
      confirm: z.boolean().describe("Must be true to actually send. Call first with false, show the preview to the teacher, and repeat with true after they agree."),
    },
    run: async (args) => {
      if (!args.group_ids.length && !args.student_ids.length) throw new ToolInputError("Give at least one group in group_ids or one student in student_ids.");
      const pickedGroups = await ownedGroups(ctx, args.group_ids);
      const pickedStudents = await ownedStudents(ctx, args.student_ids);
      const recipients = { groups: pickedGroups, students: pickedStudents };

      if (args.kind === "task") {
        if (args.start_at || args.end_at || args.timezone) throw new ToolInputError("start_at, end_at and timezone apply to exams only; a task keeps the deadline set in Resulio.");
        const current = await tasks.assignmentOf(ctx.scope, args.id);
        if (!args.confirm) {
          return { status: "PREVIEW", data: { sent: false, kind: "task", task_id: current.id, title: current.title, deadline: current.deadline, ...recipients, notify_students: args.notify_students, message: PREVIEW_MESSAGE } };
        }
        const groupIds = [...new Set([...current.groupIds, ...args.group_ids])];
        const studentIds = [...new Set([...current.studentIds, ...args.student_ids])];
        assertAccessGroups(current.accessMode, groupIds);
        await assertRecipients(ctx.scope, groupIds, studentIds, current.accessMode, current.studentIds);
        const task = await tasks.updateAssignment(ctx.scope, current.id, { groupIds, studentIds }, { notify: args.notify_students });
        return { data: { sent: true, kind: "task", task_id: task.id, title: task.title, deadline: task.deadline, ...recipients, task_link: links.taskShare(task.shareCode), manage_url: links.tasks() } };
      }

      const exam = await assessments.ownedAssessment(ctx.scope, args.id);
      if (exam.status === "CLOSED") throw new AppError("CLOSED");
      if (!exam.currentVersionId && !(await assessments.draftQuestions(exam.id)).length) throw new AppError("NO_QUESTIONS");
      const startAt = args.start_at !== undefined ? new Date(args.start_at) : exam.startAt;
      const endAt = args.end_at !== undefined ? new Date(args.end_at) : exam.endAt;
      if (startAt && endAt && endAt <= startAt) throw new ToolInputError("end_at must be after start_at.");
      const preview = { kind: "exam", exam_id: exam.id, title: exam.settings.title, ...recipients, start_at: startAt, end_at: endAt, will_publish: !exam.currentVersionId };
      if (!args.confirm) return { status: "PREVIEW", data: { sent: false, ...preview, message: PREVIEW_MESSAGE } };
      if (args.start_at !== undefined || args.end_at !== undefined || args.timezone) {
        await assessments.updateSchedule(ctx.scope, exam.id, { startAt, endAt, timezone: args.timezone ?? exam.timezone });
      }
      if (!exam.currentVersionId) await assessments.publish(ctx.scope, exam.id);
      const targets = await assessments.getTargets(exam.id);
      await assessments.setTargets(ctx.scope, exam.id, {
        groupIds: [...new Set([...targets.groupIds, ...args.group_ids])],
        studentIds: [...new Set([...targets.studentIds, ...args.student_ids])],
      });
      const saved = assessments.summary(await assessments.ownedAssessment(ctx.scope, exam.id));
      return {
        data: {
          sent: true,
          ...preview,
          status: saved.liveStatus,
          unpublished_changes: saved.hasDraftChanges,
          exam_link: links.examShare(saved.shareCode),
          edit_url: links.exam(saved.id),
          ...(saved.hasDraftChanges ? { note: "The exam has unpublished draft changes; students get the published version until the teacher publishes them in Resulio." } : {}),
        },
      };
    },
  });

  register(server, ctx, "get_results", {
    title: "Results",
    description:
      "Results for one exam (exam_id: everyone it was sent to, whether they started or finished, percentage, points, times, answers waiting for manual grading) " +
      "or for one student (student_id: all their exam results, newest first). Give exactly one of exam_id or student_id.",
    scopes: ["results:read"],
    write: false,
    input: { exam_id: entityId.optional(), student_id: studentId.optional() },
    run: async (args) => {
      if ((args.exam_id === undefined) === (args.student_id === undefined)) throw new ToolInputError("Give exactly one of exam_id or student_id.");
      if (args.student_id !== undefined) {
        const rows = await attempts.teacherResults(ctx.scope, { studentId: args.student_id });
        if (!rows.length) await groups.assertTeacherHasStudent(ctx.scope, args.student_id);
        return {
          data: {
            student_id: args.student_id,
            results: rows.slice(0, MAX_ROWS).map((r) => ({
              exam_id: r.assessmentId,
              exam_title: r.assessmentTitle,
              type: r.type,
              attempt_no: r.attemptNo,
              percentage: r.percentage,
              earned_points: r.earnedPoints,
              total_points: r.totalPoints,
              pending_review_count: r.pendingReviewCount,
              completed_at: r.completedAt,
            })),
          },
        };
      }
      const examId = args.exam_id!;
      const view = await activity.assessmentParticipants(ctx.scope, examId);
      const results = await attempts.teacherResults(ctx.scope, { assessmentId: examId });
      const latest = new Map<number, (typeof results)[number]>();
      for (const r of results) if (!latest.has(r.studentId)) latest.set(r.studentId, r);
      return {
        data: {
          exam: { id: view.assessment.id, title: view.assessment.title, type: view.assessment.type, status: view.assessment.status },
          summary: view.summary,
          students: view.participants.slice(0, MAX_ROWS * 2).map((p) => {
            const r = latest.get(p.studentId);
            return {
              student_id: p.studentId,
              name: p.name,
              state: p.state,
              percentage: p.percentage,
              earned_points: r?.earnedPoints ?? null,
              total_points: r?.totalPoints ?? null,
              attempts_used: p.attemptsUsed,
              started_at: p.startedAt,
              submitted_at: p.submittedAt,
              duration_seconds: r?.durationSeconds ?? null,
              pending_review_count: p.pendingReviewCount,
            };
          }),
          results_url: links.examResults(view.assessment.id),
        },
      };
    },
  });

  return server;
}
