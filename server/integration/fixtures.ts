import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { vi } from "vitest";
import { attempts, authAccounts, groupMembers, partnerProfiles, platformRoles, providerWorkspaces, users, type User } from "../../drizzle/schema";
import type { AdminRole } from "../../shared/adminPermissions";
import type { AssessmentSettings, QuestionInput } from "../../shared/assessment";
import type { TrpcContext } from "../_core/context";
import type { SessionTimes } from "../_core/sdk";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import * as assessments from "../modules/assessments";
import * as groups from "../modules/groups";
import { appRouter } from "../routers";

export const db = () => requireDb();

export async function makeUser(name: string): Promise<User> {
  const openId = `it_${nanoid(16)}`;
  const [row] = await db().insert(users).values({ openId, name, email: `${openId}@example.test`, loginMethod: "google" }).$returningId();
  const [user] = await db().select().from(users).where(eq(users.id, row.id));
  return user;
}

export async function makeTeacher(name: string) {
  const user = await makeUser(name);
  const id = `ws_${nanoid(12)}`;
  await db().insert(providerWorkspaces).values({ id, ownerUserId: user.id, title: `${name} məkanı` });
  const scope: TeacherScope = { workspaceId: id, userId: user.id };
  return { user, scope, workspaceId: id };
}

export async function makePartner(name: string) {
  const user = await makeUser(name);
  await db().insert(partnerProfiles).values({ userId: user.id, status: "APPROVED", referralCode: nanoid(10), approvedAt: new Date() });
  return user;
}

export async function makeGroup(scope: TeacherScope, members: User[], status: "ACTIVE" | "PENDING" = "ACTIVE") {
  const group = await groups.createGroup(scope, { name: `Qrup ${nanoid(4)}`, subject: "", grade: "", description: "" });
  if (members.length) await db().insert(groupMembers).values(members.map((m) => ({ groupId: group.id, userId: m.id, status })));
  return group;
}

export const mcQuestion = (text: string, correct = "a"): QuestionInput => ({
  type: "MULTIPLE_CHOICE",
  text,
  points: 1,
  difficulty: "MEDIUM",
  topic: "Test",
  skill: "",
  tags: [],
  content: { options: [{ key: "a", text: "A" }, { key: "b", text: "B" }, { key: "c", text: "C" }] },
  answerKey: { correct },
});

export async function publishedAssessment(
  scope: TeacherScope,
  opts: { groupIds?: string[]; studentIds?: number[]; questions?: number; settings?: Partial<AssessmentSettings> } = {},
) {
  const a = await assessments.createAssessment(scope, { type: "EXAM", settings: { title: `İmtahan ${nanoid(4)}`, ...opts.settings } });
  for (let i = 0; i < (opts.questions ?? 3); i++) await assessments.createQuestionInAssessment(scope, a.id, mcQuestion(`Sual ${i + 1}`));
  await assessments.setTargets(scope, a.id, { groupIds: opts.groupIds ?? [], studentIds: opts.studentIds ?? [] });
  await assessments.publish(scope, a.id);
  return assessments.ownedAssessment(scope, a.id);
}

/** Question ids of an attempt in presentation order. */
export async function questionIdsOf(attemptId: string) {
  const [row] = await db().select({ order: attempts.questionOrder }).from(attempts).where(eq(attempts.id, attemptId));
  return row.order;
}

/** Moves the server deadline into the past, as if the clock had run out. */
export async function expire(attemptId: string, secondsAgo = 1) {
  await db().update(attempts).set({ deadlineAt: new Date(Date.now() - secondsAgo * 1000) }).where(eq(attempts.id, attemptId));
}

/** Session times of a caller who signed in `authAgoMs` ago (default: just now). */
export const signedIn = (authAgoMs = 0): SessionTimes => {
  const at = Date.now() - authAgoMs;
  return { issuedAtMs: at, authTimeMs: at };
};

/** Admin with a platform role and a linked Google account; SUPER_ADMIN is added to the allowlist unless disabled. */
export async function makeAdmin(role: AdminRole, opts: { allowlisted?: boolean; google?: boolean } = {}) {
  const user = await makeUser(role);
  await db().insert(platformRoles).values({ userId: user.id, role });
  if (opts.google !== false) {
    await db().insert(authAccounts).values({ userId: user.id, provider: "google", providerAccountId: `g_${nanoid(12)}`, providerEmail: user.email });
  }
  if (role === "SUPER_ADMIN" && opts.allowlisted !== false) {
    process.env.SUPER_ADMIN_EMAILS = [process.env.SUPER_ADMIN_EMAILS, user.email].filter(Boolean).join(",");
  }
  return user;
}

export async function reloadUser(id: number) {
  const [user] = await db().select().from(users).where(eq(users.id, id));
  return user;
}

export function caller(
  user: User | null,
  headers: Record<string, string> = {},
  opts: { session?: SessionTimes | null; requestId?: string } = {},
) {
  const req = { ip: `10.1.${user?.id ?? 0}.1`, protocol: "https", headers, requestId: opts.requestId };
  const ctx: TrpcContext = {
    user,
    session: opts.session ?? null,
    req: req as unknown as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

/** Resolves to "OK" or "<TRPC_CODE>:<message>" so authorization outcomes are easy to compare. */
export async function outcome(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof TRPCError ? `${e.code}:${e.message}` : `THROWN:${(e as Error).message}`;
  }
}
