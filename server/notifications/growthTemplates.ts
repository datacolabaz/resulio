import { emailLayout, escapeHtml, type EmailMessage } from "../_core/email";
import type { ServerLocale } from "../_core/locale";
import { cleanTitle } from "./templates";

/** Growth Engine notices: the teacher's daily risk digest, a retake for the student, the review plan reminder. */

export const teacherGrowthPath = "/teacher/growth";
export const studentAssessmentsPath = "/student/assessments";

const joinNames = (names: string[], more: number, andMore: (n: number) => string) =>
  names.map((n) => cleanTitle(n, 60)).join(", ") + (more > 0 ? ` ${andMore(more)}` : "");

const RISK_DIGEST: Record<ServerLocale, { title: (n: number) => string; body: (names: string) => string; more: (n: number) => string; heading: string; button: string; footer: string }> = {
  az: {
    title: (n) => `Risk radarı: ${n} tələbə yüksək riskdədir`,
    body: (names) => `Bu gün yüksək risk səviyyəsinə keçənlər: ${names}.`,
    more: (n) => `və daha ${n} nəfər`,
    heading: "Diqqət tələb edən tələbələr",
    button: "Risk radarını aç",
    footer: "Bu xülasəni İnkişaf radarının ayarlarında söndürə bilərsiniz.",
  },
  en: {
    title: (n) => `Risk radar: ${n} students at high risk`,
    body: (names) => `Moved to high risk today: ${names}.`,
    more: (n) => `and ${n} more`,
    heading: "Students who need attention",
    button: "Open the risk radar",
    footer: "You can turn this digest off in the Growth radar settings.",
  },
  ru: {
    title: (n) => `Радар риска: студентов с высоким риском: ${n}`,
    body: (names) => `Сегодня перешли в высокий риск: ${names}.`,
    more: (n) => `и ещё ${n}`,
    heading: "Студенты, которым нужно внимание",
    button: "Открыть радар риска",
    footer: "Сводку можно отключить в настройках радара роста.",
  },
};

export function riskDigestInApp(locale: ServerLocale, d: { count: number; names: string[] }) {
  const tx = RISK_DIGEST[locale];
  return { title: tx.title(d.count), body: tx.body(joinNames(d.names, d.count - d.names.length, tx.more)) };
}

export function buildRiskDigestEmail(d: { count: number; names: string[]; to: string; locale: ServerLocale; appUrl: string }): EmailMessage {
  const tx = RISK_DIGEST[d.locale];
  const url = `${d.appUrl}${teacherGrowthPath}`;
  const line = tx.body(joinNames(d.names, d.count - d.names.length, tx.more));
  const html = emailLayout({ heading: escapeHtml(tx.heading), paragraphs: [escapeHtml(line)], buttonLabel: escapeHtml(tx.button), buttonUrl: escapeHtml(url), footer: escapeHtml(tx.footer) });
  return { to: d.to, subject: tx.title(d.count), html, text: [tx.heading, "", line, "", `${tx.button}: ${url}`, "", tx.footer].join("\n") };
}

const RETAKE: Record<ServerLocale, { title: string; body: (from: string, topics: string) => string }> = {
  az: { title: "Sizə fərdi təkrar testi təyin olundu", body: (f, t) => `${f || "Müəlliminiz"} bu mövzular üzrə qısa test hazırladı: ${t}.` },
  en: { title: "A personal review test was assigned to you", body: (f, t) => `${f || "Your teacher"} prepared a short test on: ${t}.` },
  ru: { title: "Вам назначен персональный тест на повторение", body: (f, t) => `${f || "Преподаватель"} подготовил короткий тест по темам: ${t}.` },
};

export const studentGrowthPath = "/student/growth";

const PLAN_REMINDER: Record<ServerLocale, { title: string; body: (items: number, minutes: number) => string }> = {
  az: { title: "Bugünkü təkrar addımlarınız gözləyir", body: (n, m) => `Planınızda bu gün ${n} addım qalıb (təxminən ${m} dəqiqə).` },
  en: { title: "Today's review steps are waiting", body: (n, m) => `${n} ${n === 1 ? "step is" : "steps are"} left in your plan today (about ${m} min).` },
  ru: { title: "Сегодняшние шаги повторения ждут вас", body: (n, m) => `В вашем плане на сегодня осталось шагов: ${n} (примерно ${m} мин).` },
};

export function planReminderInApp(locale: ServerLocale, d: { items: number; minutes: number }) {
  const tx = PLAN_REMINDER[locale];
  return { title: tx.title, body: tx.body(d.items, d.minutes) };
}

export function retakeAssignedInApp(locale: ServerLocale, d: { topics: string[]; from: string }) {
  const tx = RETAKE[locale];
  return { title: tx.title, body: tx.body(cleanTitle(d.from, 60), d.topics.map((t) => cleanTitle(t, 60)).join(", ")) };
}

const GROUP_WEAK_TOPIC: Record<ServerLocale, { title: (group: string) => string; body: (topics: string) => string; more: (n: number) => string; heading: string; button: string; footer: string }> = {
  az: {
    title: (group) => `${group}: zəif mövzular aşkarlandı`,
    body: (topics) => `Qrupun nəticələrinə görə zəif mövzular: ${topics}. Bu mövzularda qısa təkrar test hazırlaya bilərsiniz.`,
    more: (n) => `və daha ${n} mövzu`,
    heading: "Qrupda zəif mövzular",
    button: "Təkrar test hazırla",
    footer: "Bu xülasəni qrupun ayarlarında söndürə bilərsiniz.",
  },
  en: {
    title: (group) => `${group}: weak topics found`,
    body: (topics) => `Based on this group's results, these topics are weak: ${topics}. You can prepare a short follow-up test for them.`,
    more: (n) => `and ${n} more`,
    heading: "Weak topics in this group",
    button: "Prepare a follow-up test",
    footer: "You can turn this digest off in the group's settings.",
  },
  ru: {
    title: (group) => `${group}: обнаружены слабые темы`,
    body: (topics) => `По результатам группы слабыми оказались темы: ${topics}. Можно подготовить короткий повторный тест по ним.`,
    more: (n) => `и ещё ${n}`,
    heading: "Слабые темы в этой группе",
    button: "Подготовить повторный тест",
    footer: "Эту сводку можно отключить в настройках группы.",
  },
};

export function groupWeakTopicDigestInApp(locale: ServerLocale, d: { groupName: string; count: number; topics: string[] }) {
  const tx = GROUP_WEAK_TOPIC[locale];
  return { title: tx.title(cleanTitle(d.groupName, 60)), body: tx.body(joinNames(d.topics, d.count - d.topics.length, tx.more)) };
}

export function buildGroupWeakTopicDigestEmail(d: { groupName: string; count: number; topics: string[]; url: string; to: string; locale: ServerLocale }): EmailMessage {
  const tx = GROUP_WEAK_TOPIC[d.locale];
  const line = tx.body(joinNames(d.topics, d.count - d.topics.length, tx.more));
  const title = tx.title(cleanTitle(d.groupName, 60));
  const html = emailLayout({ heading: escapeHtml(tx.heading), paragraphs: [escapeHtml(line)], buttonLabel: escapeHtml(tx.button), buttonUrl: escapeHtml(d.url), footer: escapeHtml(tx.footer) });
  return { to: d.to, subject: title, html, text: [tx.heading, "", line, "", `${tx.button}: ${d.url}`, "", tx.footer].join("\n") };
}
