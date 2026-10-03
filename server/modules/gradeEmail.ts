import { and, eq, sql } from "drizzle-orm";
import { gradeEmailLog, taskSubmissions, tasks, users } from "../../drizzle/schema";
import { emailEnabled, emailLayout, escapeHtml, publicAppUrl, sendEmail, type EmailMessage } from "../_core/email";
import { serverLocale, type ServerLocale } from "../_core/locale";
import { requireDb } from "../db";

/**
 * "Your grade is ready" e-mail to the student when the teacher releases a grade, and an "updated"
 * one when the released score later changes. The teacher's feedback text is never included.
 */

export type GradeEmailKind = "released" | "updated";

const sameScore = (a: number | null, b: number | null) => a === b;

export interface GradeSave {
  before: { wasReleased: boolean; score: number | null };
  after: { release: boolean; score: number | null };
}

/**
 * What (if anything) to e-mail after a grade save. `emailedScore` is the score of the last grade
 * e-mail for this submission, `undefined` if none was sent. Plain re-saves, and hiding then
 * showing the same score again, send nothing.
 */
export function gradeEmailKind({ before, after }: GradeSave, emailedScore: number | null | undefined): GradeEmailKind | null {
  if (!after.release) return null;
  if (before.wasReleased && sameScore(before.score, after.score)) return null;
  if (emailedScore !== undefined && sameScore(emailedScore, after.score)) return null;
  return emailedScore !== undefined || before.wasReleased ? "updated" : "released";
}

const TEXT: Record<ServerLocale, {
  subject: Record<GradeEmailKind, (title: string) => string>;
  heading: Record<GradeEmailKind, string>;
  intro: Record<GradeEmailKind, (title: string) => string>;
  score: Record<GradeEmailKind, (score: string) => string>;
  readOnSite: string;
  button: string;
  footer: string;
}> = {
  az: {
    subject: { released: (t) => `Tapşırığınız qiymətləndirildi: ${t}`, updated: (t) => `Qiymətiniz yeniləndi: ${t}` },
    heading: { released: "Tapşırığınız qiymətləndirildi", updated: "Qiymətiniz yeniləndi" },
    intro: { released: (t) => `Müəlliminiz «${t}» tapşırığını qiymətləndirdi.`, updated: (t) => `Müəlliminiz «${t}» tapşırığı üzrə qiymətinizi yenilədi.` },
    score: { released: (s) => `Balınız: ${s}`, updated: (s) => `Yeni balınız: ${s}` },
    readOnSite: "Müəllimin rəyini Resulio-da oxuya bilərsiniz.",
    button: "Nəticəyə bax",
    footer: "Bu məktub Resulio tərəfindən avtomatik göndərilib, çünki müəlliminiz işinizi qiymətləndirdi.",
  },
  en: {
    subject: { released: (t) => `Your task has been graded: ${t}`, updated: (t) => `Your grade was updated: ${t}` },
    heading: { released: "Your task has been graded", updated: "Your grade was updated" },
    intro: { released: (t) => `Your teacher graded “${t}”.`, updated: (t) => `Your teacher updated your grade for “${t}”.` },
    score: { released: (s) => `Your score: ${s}`, updated: (s) => `New score: ${s}` },
    readOnSite: "You can read your teacher's feedback on Resulio.",
    button: "View result",
    footer: "Resulio sent this e-mail automatically because your teacher graded your work.",
  },
  ru: {
    subject: { released: (t) => `Ваше задание оценено: ${t}`, updated: (t) => `Оценка обновлена: ${t}` },
    heading: { released: "Ваше задание оценено", updated: "Оценка обновлена" },
    intro: { released: (t) => `Преподаватель оценил задание «${t}».`, updated: (t) => `Преподаватель обновил оценку за задание «${t}».` },
    score: { released: (s) => `Ваш балл: ${s}`, updated: (s) => `Новый балл: ${s}` },
    readOnSite: "Отзыв преподавателя можно прочитать на Resulio.",
    button: "Посмотреть результат",
    footer: "Это письмо отправлено Resulio автоматически, потому что преподаватель оценил вашу работу.",
  },
};

export function buildGradeEmail(input: { to: string; locale: ServerLocale; kind: GradeEmailKind; taskTitle: string; score: number | null; appUrl: string }): EmailMessage {
  const tx = TEXT[input.locale];
  const title = input.taskTitle.replace(/[\r\n\t]+/g, " ").trim().slice(0, 150);
  const score = input.score === null ? null : `${input.score}/100`;
  const url = `${input.appUrl}/student/assignments`;
  const lines = [tx.intro[input.kind](title), ...(score ? [tx.score[input.kind](score)] : []), tx.readOnSite];
  const html = emailLayout({
    heading: escapeHtml(tx.heading[input.kind]),
    paragraphs: [
      escapeHtml(tx.intro[input.kind](title)),
      ...(score ? [`<strong>${escapeHtml(tx.score[input.kind](score))}</strong>`] : []),
      escapeHtml(tx.readOnSite),
    ],
    buttonLabel: escapeHtml(tx.button),
    buttonUrl: escapeHtml(url),
    footer: escapeHtml(tx.footer),
  });
  const text = [tx.heading[input.kind], "", ...lines, "", `${tx.button}: ${url}`, "", tx.footer].join("\n");
  return { to: input.to, subject: tx.subject[input.kind](title), html, text };
}

/**
 * Decides, claims the e-mail in `grade_email_log` (so double clicks and concurrent saves send
 * once), then sends. Runs in the background after the grade is saved; the caller swallows errors.
 */
export async function deliverGradeEmail(submissionId: string, save: GradeSave) {
  if (gradeEmailKind(save, undefined) === null || !emailEnabled()) return;
  const db = requireDb();
  const score = save.after.score;
  const [row] = await db
    .select({ title: tasks.title, email: users.email, locale: users.preferredLocale, score: taskSubmissions.score, releasedAt: taskSubmissions.feedbackReleasedAt })
    .from(taskSubmissions)
    .innerJoin(tasks, eq(tasks.id, taskSubmissions.taskId))
    .innerJoin(users, eq(users.id, taskSubmissions.studentId))
    .where(eq(taskSubmissions.id, submissionId))
    .limit(1);
  const to = row?.email?.trim();
  // A newer save may already have hidden the grade or changed the score; that save decides then.
  if (!row || !to || !row.releasedAt || !sameScore(row.score, score)) return;

  const [log] = await db.select({ score: gradeEmailLog.score }).from(gradeEmailLog).where(eq(gradeEmailLog.submissionId, submissionId)).limit(1);
  const kind = gradeEmailKind(save, log ? log.score : undefined);
  if (!kind) return;
  const now = new Date();
  const [claim] = log
    ? await db
        .update(gradeEmailLog)
        .set({ score, sentAt: now })
        .where(and(eq(gradeEmailLog.submissionId, submissionId), sql`NOT (${gradeEmailLog.score} <=> ${score})`))
    : await db.insert(gradeEmailLog).ignore().values({ submissionId, score, sentAt: now });
  if (claim.affectedRows !== 1) return;

  const result = await sendEmail(buildGradeEmail({ to, locale: serverLocale(row.locale), kind, taskTitle: row.title, score, appUrl: publicAppUrl() }));
  if (!result.ok) console.warn("[gradeEmail] not sent", submissionId, result.reason);
}
