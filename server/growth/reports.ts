import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { assessments, providerWorkspaces, reportShares, results, users } from "../../drizzle/schema";
import { emailLayout, escapeHtml, publicAppUrl, sendEmail, sendEmailInBackground } from "../_core/email";
import type { ServerLocale } from "../_core/locale";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { assertTeacherHasStudent } from "../modules/groups";
import { logAction } from "./actions";
import { growthEnabledFor } from "./availability";
import { masteryRows, topGains } from "./mastery";
import { onlyReleased, releasedResultIds } from "./released";
import { growthSettingsOf } from "./riskStore";
import { studentStats } from "./weakness";

/**
 * Parent reports: a read-only link (only the token's SHA-256 is stored) with a print view, and an
 * optional e-mail of that link. Needs the teacher's consent (growth settings) and shows only what
 * the student can see: released results, strong and priority topics. Never notes or the risk score.
 */

const DAY_MS = 86_400_000;
const REPORT_DAYS = 30;
const RECENT_RESULTS = 10;

export const hashReportToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const reportPath = (token: string) => `/report/${token}`;

const MAIL: Record<ServerLocale, { subject: (name: string) => string; heading: string; body: (name: string, from: string) => string; button: string; footer: string }> = {
  az: {
    subject: (n) => `${n}: inkişaf hesabatı`,
    heading: "Tələbənin inkişaf hesabatı",
    body: (n, f) => `${f} sizinlə ${n} üzrə son nəticələri və mövzu üzrə vəziyyəti paylaşdı.`,
    button: "Hesabatı aç",
    footer: "Keçid 30 gün etibarlıdır və yalnız baxmaq üçündür.",
  },
  en: {
    subject: (n) => `${n}: progress report`,
    heading: "Student progress report",
    body: (n, f) => `${f} shared ${n}'s recent results and topic progress with you.`,
    button: "Open the report",
    footer: "The link is valid for 30 days and is view-only.",
  },
  ru: {
    subject: (n) => `${n}: отчёт о прогрессе`,
    heading: "Отчёт о прогрессе студента",
    body: (n, f) => `${f} поделился с вами последними результатами и прогрессом по темам: ${n}.`,
    button: "Открыть отчёт",
    footer: "Ссылка действует 30 дней и только для просмотра.",
  },
};

async function workspaceName(workspaceId: string) {
  const [ws] = await requireDb().select({ title: providerWorkspaces.title, display: providerWorkspaces.publicDisplayName }).from(providerWorkspaces).where(eq(providerWorkspaces.id, workspaceId)).limit(1);
  return ws?.display || ws?.title || "";
}

export async function createReportShare(scope: TeacherScope, input: { studentId: number; email: string | null; locale: ServerLocale }) {
  await assertTeacherHasStudent(scope, input.studentId);
  if (!(await growthSettingsOf(scope.workspaceId)).parentReports) throw new AppError("GROWTH_PARENT_REPORTS_OFF");
  const token = randomBytes(24).toString("base64url");
  const id = nanoid();
  const expiresAt = new Date(Date.now() + REPORT_DAYS * DAY_MS);
  await requireDb().insert(reportShares).values({ id, workspaceId: scope.workspaceId, studentId: input.studentId, tokenHash: hashReportToken(token), createdBy: scope.userId, expiresAt });
  await logAction(scope, input.studentId, "REPORT", id);
  const url = `${publicAppUrl()}${reportPath(token)}`;
  if (input.email) {
    const [student] = await requireDb().select({ name: users.name }).from(users).where(eq(users.id, input.studentId)).limit(1);
    const tx = MAIL[input.locale];
    const name = student?.name ?? "";
    const from = await workspaceName(scope.workspaceId);
    const line = tx.body(name, from);
    const html = emailLayout({ heading: escapeHtml(tx.heading), paragraphs: [escapeHtml(line)], buttonLabel: escapeHtml(tx.button), buttonUrl: escapeHtml(url), footer: escapeHtml(tx.footer) });
    const to = input.email;
    sendEmailInBackground(() => sendEmail({ to, subject: tx.subject(name), html, text: [tx.heading, "", line, "", `${tx.button}: ${url}`, "", tx.footer].join("\n") }));
  }
  return { id, url, expiresAt };
}

export async function activeShares(scope: TeacherScope, studentId: number) {
  await assertTeacherHasStudent(scope, studentId);
  return requireDb()
    .select({ id: reportShares.id, createdAt: reportShares.createdAt, expiresAt: reportShares.expiresAt, viewCount: reportShares.viewCount, lastViewedAt: reportShares.lastViewedAt })
    .from(reportShares)
    .where(and(eq(reportShares.workspaceId, scope.workspaceId), eq(reportShares.studentId, studentId), isNull(reportShares.revokedAt), gt(reportShares.expiresAt, new Date())))
    .orderBy(desc(reportShares.createdAt));
}

export async function revokeShare(scope: TeacherScope, id: string) {
  await requireDb()
    .update(reportShares)
    .set({ revokedAt: new Date() })
    .where(and(eq(reportShares.id, id), eq(reportShares.workspaceId, scope.workspaceId)));
}

/** The public report behind a token; NOT_FOUND for unknown, expired or revoked links and when consent was withdrawn. */
export async function publicReport(token: string) {
  const db = requireDb();
  const [share] = await db.select().from(reportShares).where(eq(reportShares.tokenHash, hashReportToken(token))).limit(1);
  const now = new Date();
  if (!share || share.revokedAt || share.expiresAt.getTime() <= now.getTime()) throw new AppError("NOT_FOUND");
  if (!(await growthEnabledFor(share.workspaceId)) || !(await growthSettingsOf(share.workspaceId, db)).parentReports) throw new AppError("NOT_FOUND");
  await db
    .update(reportShares)
    .set({ viewCount: sql`${reportShares.viewCount} + 1`, lastViewedAt: now })
    .where(eq(reportShares.id, share.id));

  const released = await releasedResultIds(share.workspaceId, share.studentId, db);
  const stats = onlyReleased(await studentStats(share.workspaceId, share.studentId, db), released);
  const mastery = masteryRows(stats).filter((m) => m.dimension === "TOPIC");
  const [student] = await db.select({ name: users.name }).from(users).where(eq(users.id, share.studentId)).limit(1);
  const ids = [...released];
  const recent = ids.length
    ? await db
        .select({ id: results.id, completedAt: results.completedAt, percentage: results.percentage, settings: assessments.settings })
        .from(results)
        .innerJoin(assessments, eq(assessments.id, results.assessmentId))
        .where(inArray(results.id, ids))
        .orderBy(desc(results.completedAt))
        .limit(RECENT_RESULTS)
    : [];
  const scored = recent.filter((r) => r.percentage != null);
  return {
    studentName: student?.name ?? "",
    teacher: await workspaceName(share.workspaceId),
    generatedAt: now,
    expiresAt: share.expiresAt,
    average: scored.length ? Math.round((scored.reduce((s, r) => s + r.percentage!, 0) / scored.length) * 10) / 10 : null,
    results: recent.map((r) => ({ title: r.settings.title, completedAt: r.completedAt, percentage: r.percentage })),
    strong: mastery.filter((m) => m.status === "STRONG").sort((a, b) => b.mastery - a.mastery).slice(0, 5).map((m) => ({ label: m.label, mastery: m.mastery })),
    priority: topGains(mastery, stats).map((g) => ({ label: g.label, mastery: g.mastery })),
  };
}
