import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { lessonAttendance, lessonMeetings, lessons } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { sdk } from "../_core/sdk";
import { requireDb } from "../db";
import { activeGroupIdsOfStudent } from "../modules/groups";
import { workspaceOwnerId } from "../modules/workspaces";
import { lessonJoinDecision } from "./access";
import { hasAckedConsent } from "./service";
import { nanoid } from "nanoid";

/**
 * The one gated door to a lesson's real meeting URL: students never receive the provider's raw
 * join link directly (it isn't exposed through any tRPC query), only this redirect, which applies
 * the exact same `lessonJoinDecision` used everywhere else and records attendance before handing
 * the browser off to Google Meet / Zoom.
 */
export function registerLessonJoinRoute(app: Express) {
  app.get("/api/lessons/:id/join", async (req: Request, res: Response) => {
    const lessonId = req.params.id;
    let auth: { user: { id: number } };
    try {
      auth = await sdk.authenticateRequest(req);
    } catch {
      res.redirect(302, `${loginReturn(req)}`);
      return;
    }
    const db = requireDb();
    const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
    if (!lesson) {
      res.status(404).type("text/plain").send("Lesson not found.");
      return;
    }
    const ownerId = await workspaceOwnerId(lesson.workspaceId);
    const studentGroupIds = await activeGroupIdsOfStudent(auth.user.id);
    const decision = lessonJoinDecision(
      lesson,
      { userId: auth.user.id, managesWorkspace: ownerId === auth.user.id, studentId: auth.user.id, studentGroupIds },
      new Date(),
    );
    if (decision === "DENIED") {
      res.status(403).type("text/plain").send("You are not a recipient of this lesson.");
      return;
    }
    if (decision === "NOT_YET_OPEN") {
      res.status(403).type("text/plain").send("The join link is not open yet.");
      return;
    }
    if (decision === "CLOSED") {
      res.status(403).type("text/plain").send("The join window for this lesson has closed.");
      return;
    }
    // GDPR: a student must acknowledge the recording notice before Resulio hands them the meeting
    // URL at all -- the teacher (OWNER) started the recording and isn't gated by their own notice.
    if (decision !== "OWNER" && !(await hasAckedConsent(auth.user.id, lessonId))) {
      res.redirect(302, studentLessonReturn(req, lessonId));
      return;
    }
    const [meeting] = await db.select().from(lessonMeetings).where(eq(lessonMeetings.lessonId, lessonId)).limit(1);
    if (!meeting || meeting.status !== "CREATED" || !meeting.joinUrl) {
      res.status(503).type("text/plain").send("The meeting hasn't been created yet. Try again shortly.");
      return;
    }
    const url = decision === "OWNER" && meeting.hostUrl ? meeting.hostUrl : meeting.joinUrl;
    await recordJoin(lessonId, auth.user.id, decision === "OWNER" ? "TEACHER" : "STUDENT");
    res.redirect(302, url);
  });
}

/** One row per (lesson, user); `joinedAt` is set on the first join and left alone after that. */
async function recordJoin(lessonId: string, userId: number, _role: "TEACHER" | "STUDENT"): Promise<void> {
  const db = requireDb();
  const [existing] = await db
    .select({ id: lessonAttendance.id })
    .from(lessonAttendance)
    .where(and(eq(lessonAttendance.lessonId, lessonId), eq(lessonAttendance.userId, userId)))
    .limit(1);
  if (existing) return;
  await db.insert(lessonAttendance).values({ id: nanoid(), lessonId, userId, joinedAt: new Date(), source: "JOIN_LINK" });
}

function loginReturn(req: Request): string {
  const origin = ENV.frontendUrl;
  const dest = new URL(origin || `http://${req.get("host") || "localhost:3000"}`);
  dest.pathname = "/";
  dest.searchParams.set("returnTo", req.originalUrl);
  return dest.toString();
}

/** Back to the SPA's own lesson detail page, where the consent notice lives, flagged so it's shown even if already loaded in the background. */
function studentLessonReturn(req: Request, lessonId: string): string {
  const origin = ENV.frontendUrl;
  const dest = new URL(origin || `http://${req.get("host") || "localhost:3000"}`);
  dest.pathname = `/student/lessons/${lessonId}`;
  dest.searchParams.set("consent", "required");
  return dest.toString();
}
