import { emailLayout, escapeHtml, type EmailMessage } from "../_core/email";
import { fillTemplate, type ServerLocale } from "../_core/locale";

/** Texts of every notification, AZ/EN/RU. Pure: no DB, no env. */

/** Single line, no control characters, bounded — for titles that end up in subjects and headings. */
export function cleanTitle(value: string, max = 150): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Model output: drop control characters (keeping line breaks), collapse blank runs, bound the length. */
export function cleanModelText(value: string, max: number): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

const htmlText = (value: string) => escapeHtml(value).replace(/\n/g, "<br>");

// ---------------------------------------------------------------------------
// Grade released / updated
// ---------------------------------------------------------------------------

export type GradeEmailKind = "released" | "updated";

const GRADE: Record<ServerLocale, {
  subject: Record<GradeEmailKind, (title: string) => string>;
  heading: Record<GradeEmailKind, string>;
  intro: Record<GradeEmailKind, (title: string) => string>;
  score: Record<GradeEmailKind, (score: string) => string>;
  readOnSite: string;
  button: string;
  footer: string;
  inApp: { title: string; body: string };
}> = {
  az: {
    subject: { released: (t) => `Tapşırığınız qiymətləndirildi: ${t}`, updated: (t) => `Qiymətiniz yeniləndi: ${t}` },
    heading: { released: "Tapşırığınız qiymətləndirildi", updated: "Qiymətiniz yeniləndi" },
    intro: { released: (t) => `Müəlliminiz «${t}» tapşırığını qiymətləndirdi.`, updated: (t) => `Müəlliminiz «${t}» tapşırığı üzrə qiymətinizi yenilədi.` },
    score: { released: (s) => `Balınız: ${s}`, updated: (s) => `Yeni balınız: ${s}` },
    readOnSite: "Müəllimin rəyini Resulio-da oxuya bilərsiniz.",
    button: "Nəticəyə bax",
    footer: "Bu məktub Resulio tərəfindən avtomatik göndərilib, çünki müəlliminiz işinizi qiymətləndirdi.",
    inApp: { title: "Tapşırıq qiymətləndirildi", body: "Müəllim rəy yazdı" },
  },
  en: {
    subject: { released: (t) => `Your task has been graded: ${t}`, updated: (t) => `Your grade was updated: ${t}` },
    heading: { released: "Your task has been graded", updated: "Your grade was updated" },
    intro: { released: (t) => `Your teacher graded “${t}”.`, updated: (t) => `Your teacher updated your grade for “${t}”.` },
    score: { released: (s) => `Your score: ${s}`, updated: (s) => `New score: ${s}` },
    readOnSite: "You can read your teacher's feedback on Resulio.",
    button: "View result",
    footer: "Resulio sent this e-mail automatically because your teacher graded your work.",
    inApp: { title: "Task graded", body: "Your teacher left feedback" },
  },
  ru: {
    subject: { released: (t) => `Ваше задание оценено: ${t}`, updated: (t) => `Оценка обновлена: ${t}` },
    heading: { released: "Ваше задание оценено", updated: "Оценка обновлена" },
    intro: { released: (t) => `Преподаватель оценил задание «${t}».`, updated: (t) => `Преподаватель обновил оценку за задание «${t}».` },
    score: { released: (s) => `Ваш балл: ${s}`, updated: (s) => `Новый балл: ${s}` },
    readOnSite: "Отзыв преподавателя можно прочитать на Resulio.",
    button: "Посмотреть результат",
    footer: "Это письмо отправлено Resulio автоматически, потому что преподаватель оценил вашу работу.",
    inApp: { title: "Задание оценено", body: "Преподаватель оставил отзыв" },
  },
};

export function gradeInAppText(locale: ServerLocale) {
  return GRADE[locale].inApp;
}

export function buildGradeEmail(input: { to: string; locale: ServerLocale; kind: GradeEmailKind; taskTitle: string; score: number | null; appUrl: string }): EmailMessage {
  const tx = GRADE[input.locale];
  const title = cleanTitle(input.taskTitle);
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

// ---------------------------------------------------------------------------
// Automatic AI grade: the student's "result ready" notice
// ---------------------------------------------------------------------------

export const AI_FEEDBACK_MAX_CHARS = 1500;
export const AI_FEEDBACK_MAX_ITEMS = 5;
export const AI_FEEDBACK_MAX_ITEM_CHARS = 300;
/** Same cap as the teacher's feedback field. */
export const GRADE_FEEDBACK_MAX_CHARS = 4000;

const AI_GRADE: Record<ServerLocale, {
  subject: (title: string) => string;
  heading: string;
  intro: (title: string) => string;
  score: (score: string) => string;
  label: string;
  note: string;
  feedback: string;
  strengths: string;
  improvements: string;
  button: string;
  footer: string;
  inApp: { title: string; body: (title: string, score: string) => string };
}> = {
  az: {
    subject: (t) => `Nəticəniz hazırdır: ${t}`,
    heading: "Nəticəniz hazırdır",
    intro: (t) => `«${t}» tapşırığı üzrə göndərdiyiniz iş yoxlanıldı.`,
    score: (s) => `Balınız: ${s}`,
    label: "AI tərəfindən qiymətləndirilib",
    note: "Bu qiyməti süni intellekt avtomatik verib. Müəlliminiz onu yoxlayıb dəyişə bilər.",
    feedback: "Rəy",
    strengths: "Güclü tərəflər",
    improvements: "İnkişaf üçün",
    button: "Nəticəyə bax",
    footer: "Bu məktub Resulio tərəfindən avtomatik göndərilib.",
    inApp: { title: "Nəticəniz hazırdır", body: (t, s) => `«${t}»: ${s} · AI tərəfindən qiymətləndirilib` },
  },
  en: {
    subject: (t) => `Your result is ready: ${t}`,
    heading: "Your result is ready",
    intro: (t) => `Your submission for “${t}” has been checked.`,
    score: (s) => `Your score: ${s}`,
    label: "Graded by AI",
    note: "This grade was given automatically by AI. Your teacher may review and change it.",
    feedback: "Feedback",
    strengths: "Strengths",
    improvements: "To improve",
    button: "View result",
    footer: "Resulio sent this e-mail automatically.",
    inApp: { title: "Your result is ready", body: (t, s) => `“${t}”: ${s} · Graded by AI` },
  },
  ru: {
    subject: (t) => `Ваш результат готов: ${t}`,
    heading: "Ваш результат готов",
    intro: (t) => `Ваша работа по заданию «${t}» проверена.`,
    score: (s) => `Ваш балл: ${s}`,
    label: "Оценено ИИ",
    note: "Эту оценку автоматически поставил ИИ. Преподаватель может проверить и изменить её.",
    feedback: "Отзыв",
    strengths: "Сильные стороны",
    improvements: "Что улучшить",
    button: "Посмотреть результат",
    footer: "Это письмо отправлено Resulio автоматически.",
    inApp: { title: "Ваш результат готов", body: (t, s) => `«${t}»: ${s} · Оценено ИИ` },
  },
};

const scoreText = (score: number) => `${score}/100`;

export function cleanAiFeedback(input: { feedback: string; strengths: string[]; improvements: string[] }) {
  const list = (items: string[]) =>
    items.map((s) => cleanModelText(s, AI_FEEDBACK_MAX_ITEM_CHARS).replace(/\s*\n\s*/g, " ")).filter(Boolean).slice(0, AI_FEEDBACK_MAX_ITEMS);
  return { feedback: cleanModelText(input.feedback, AI_FEEDBACK_MAX_CHARS), strengths: list(input.strengths), improvements: list(input.improvements) };
}

/** The AI review as the plain-text feedback stored on the submission (the teacher can edit it later). */
export function formatAiGradeFeedback(locale: ServerLocale, input: { feedback: string; strengths: string[]; improvements: string[] }): string {
  const tx = AI_GRADE[locale];
  const { feedback, strengths, improvements } = cleanAiFeedback(input);
  const section = (heading: string, items: string[]) => (items.length ? [`${heading}:\n${items.map((i) => `- ${i}`).join("\n")}`] : []);
  return [feedback, ...section(tx.strengths, strengths), ...section(tx.improvements, improvements)].filter(Boolean).join("\n\n").slice(0, GRADE_FEEDBACK_MAX_CHARS);
}

export function buildAiGradeEmail(input: {
  to: string;
  locale: ServerLocale;
  taskTitle: string;
  score: number;
  feedback: string;
  strengths: string[];
  improvements: string[];
  appUrl: string;
}): EmailMessage {
  const tx = AI_GRADE[input.locale];
  const title = cleanTitle(input.taskTitle);
  const { feedback, strengths, improvements } = cleanAiFeedback(input);
  const score = tx.score(scoreText(input.score));
  const url = `${input.appUrl}/student/assignments`;
  const html = emailLayout({
    heading: escapeHtml(tx.heading),
    paragraphs: [
      escapeHtml(tx.intro(title)),
      `<strong>${escapeHtml(score)}</strong> · ${escapeHtml(tx.label)}`,
      `<em>${escapeHtml(tx.note)}</em>`,
      ...(feedback ? [`<strong>${escapeHtml(tx.feedback)}:</strong><br>${htmlText(feedback)}`] : []),
    ],
    lists: [
      { heading: escapeHtml(tx.strengths), items: strengths.map(escapeHtml) },
      { heading: escapeHtml(tx.improvements), items: improvements.map(escapeHtml) },
    ],
    buttonLabel: escapeHtml(tx.button),
    buttonUrl: escapeHtml(url),
    footer: escapeHtml(tx.footer),
  });
  const bullets = (heading: string, items: string[]) => (items.length ? ["", `${heading}:`, ...items.map((i) => `- ${i}`)] : []);
  const text = [
    tx.heading,
    "",
    tx.intro(title),
    `${score} · ${tx.label}`,
    tx.note,
    ...(feedback ? ["", `${tx.feedback}:`, feedback] : []),
    ...bullets(tx.strengths, strengths),
    ...bullets(tx.improvements, improvements),
    "",
    `${tx.button}: ${url}`,
    "",
    tx.footer,
  ].join("\n");
  return { to: input.to, subject: tx.subject(title), html, text };
}

export function aiGradeInAppText(locale: ServerLocale, taskTitle: string, score: number) {
  const tx = AI_GRADE[locale].inApp;
  return { title: tx.title, body: tx.body(cleanTitle(taskTitle, 80), scoreText(score)) };
}


// ---------------------------------------------------------------------------
// AI usage / provider alerts to the workspace owner
// ---------------------------------------------------------------------------

export type AiAlertKind = "USAGE_80" | "LIMIT_REACHED" | "PROVIDER_AUTH" | "PROVIDER_QUOTA";

const AI_ALERT: Record<ServerLocale, Record<AiAlertKind, { title: string; body: string }>> = {
  az: {
    USAGE_80: {
      title: "AI yoxlama limitinin 80%-i istifadə olunub",
      body: "{workspace}: bu gün {used}/{limit} AI yoxlama istifadə edildi. Limit dolanda yeni təhvillər AI ilə yoxlanmayacaq.",
    },
    LIMIT_REACHED: {
      title: "AI yoxlama bu gün dayandı, sabah yenilənəcək",
      body: "{workspace}: gündəlik limit ({limit}) doldu. Avtomatik yoxlamalar işləyir; AI yoxlaması 24 saat ərzində yenidən açılacaq.",
    },
    PROVIDER_AUTH: {
      title: "AI xidməti API açarını qəbul etmədi",
      body: "{workspace}: AI provayderi açarı rədd etdi — açar yanlışdır və ya ləğv edilib. AI_API_KEY dəyərini yoxlayın.",
    },
    PROVIDER_QUOTA: {
      title: "AI xidmətinin limiti bitib",
      body: "{workspace}: AI provayderi 429 xətası qaytardı — hesabın kvotası bitib və ya sorğu limiti aşılıb. AI yoxlamaları müvəqqəti işləmir.",
    },
  },
  en: {
    USAGE_80: {
      title: "80% of today's AI checks used",
      body: "{workspace}: {used} of {limit} AI checks used today. New submissions won't be AI-checked once the limit is reached.",
    },
    LIMIT_REACHED: {
      title: "AI checks stopped for today; they resume tomorrow",
      body: "{workspace}: the daily limit ({limit}) is used up. Automatic checks keep running; AI checks resume within 24 hours.",
    },
    PROVIDER_AUTH: {
      title: "The AI service rejected the API key",
      body: "{workspace}: the AI provider rejected the key — it is invalid or revoked. Check AI_API_KEY.",
    },
    PROVIDER_QUOTA: {
      title: "AI service quota exhausted",
      body: "{workspace}: the AI provider returned 429 — the account quota is used up or the rate limit was exceeded. AI checks are paused for now.",
    },
  },
  ru: {
    USAGE_80: {
      title: "Использовано 80% дневного лимита проверок ИИ",
      body: "{workspace}: сегодня использовано {used} из {limit} проверок ИИ. После достижения лимита новые работы не будут проверяться ИИ.",
    },
    LIMIT_REACHED: {
      title: "Проверка ИИ на сегодня остановлена, завтра возобновится",
      body: "{workspace}: дневной лимит ({limit}) исчерпан. Автоматические проверки работают; проверка ИИ возобновится в течение 24 часов.",
    },
    PROVIDER_AUTH: {
      title: "Сервис ИИ отклонил API-ключ",
      body: "{workspace}: провайдер ИИ отклонил ключ — он неверный или отозван. Проверьте AI_API_KEY.",
    },
    PROVIDER_QUOTA: {
      title: "Исчерпан лимит сервиса ИИ",
      body: "{workspace}: провайдер ИИ вернул ошибку 429 — квота аккаунта исчерпана или превышен лимит запросов. Проверки ИИ временно недоступны.",
    },
  },
};

export function aiAlertText(locale: ServerLocale, kind: AiAlertKind, values: { workspace: string; used?: number; limit?: number }) {
  const t = AI_ALERT[locale][kind];
  const v = { workspace: values.workspace, used: values.used ?? 0, limit: values.limit ?? 0 };
  return { title: fillTemplate(t.title, v), body: fillTemplate(t.body, v) };
}

// ---------------------------------------------------------------------------
// AI-drafted answer key, to the task's teacher
// ---------------------------------------------------------------------------

const ANSWER_KEY_DRAFTED: Record<ServerLocale, { title: string; body: string }> = {
  az: {
    title: "AI cavab açarı layihəsi hazırladı — yoxlayın",
    body: "«{task}» üçün cavab açarı yox idi. AI layihə hazırladı və təhvilləri onunla qiymətləndirir. Tapşırığı redaktə edib açarı yoxlayın və yadda saxlayın.",
  },
  en: {
    title: "AI drafted an answer key — please review",
    body: "“{task}” had no answer key. The AI drafted one and grades submissions with it. Edit the task to review and save the key.",
  },
  ru: {
    title: "ИИ подготовил черновик ключа ответов — проверьте",
    body: "У задания «{task}» не было ключа ответов. ИИ подготовил черновик и оценивает работы по нему. Откройте задание, проверьте ключ и сохраните.",
  },
};

export function answerKeyDraftedText(locale: ServerLocale, taskTitle: string) {
  const t = ANSWER_KEY_DRAFTED[locale];
  return { title: t.title, body: fillTemplate(t.body, { task: cleanTitle(taskTitle, 120) }) };
}

// ---------------------------------------------------------------------------
// Syllabus: access granted, unlocks (batched), approval needed (teacher), completed
// ---------------------------------------------------------------------------

const LOCALE_TAG: Record<ServerLocale, string> = { az: "az-AZ", en: "en-GB", ru: "ru-RU" };

/** Date only, in the platform's time zone (the student's own zone is unknown to the server). */
export function noticeDate(locale: ServerLocale, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(LOCALE_TAG[locale], { timeZone: "Asia/Baku", year: "numeric", month: "long", day: "numeric" });
}

export const syllabusPath = (syllabusId: string) => `/student/syllabus/${encodeURIComponent(syllabusId)}`;
export const syllabusLessonPath = (syllabusId: string, lessonId: string) => `${syllabusPath(syllabusId)}/lessons/${encodeURIComponent(lessonId)}`;
export const teacherApprovalsPath = (syllabusId: string) => `/teacher/syllabus/${encodeURIComponent(syllabusId)}?tab=students`;

const SYL_ACCESS: Record<ServerLocale, {
  title: (s: string) => string;
  body: string;
  bodyLater: (date: string) => string;
  heading: string;
  intro: (s: string) => string;
  later: (date: string) => string;
  button: string;
  footer: string;
}> = {
  az: {
    title: (s) => `Yeni syllabus: ${s}`,
    body: "Müəlliminiz sizə öyrənmə yolu açdı. Birinci dərsdən başlayın.",
    bodyLater: (d) => `Giriş ${d} tarixində açılacaq.`,
    heading: "Sizə yeni syllabus açıldı",
    intro: (s) => `Müəlliminiz sizə «${s}» syllabus-una giriş verdi. Dərslər ardıcıl açılır: birini tamamlayanda növbəti açılır.`,
    later: (d) => `Giriş ${d} tarixində başlayır.`,
    button: "Syllabus-a bax",
    footer: "Bu məktub Resulio tərəfindən avtomatik göndərilib, çünki müəlliminiz sizə syllabus açdı.",
  },
  en: {
    title: (s) => `New syllabus: ${s}`,
    body: "Your teacher opened a learning path for you. Start with the first lesson.",
    bodyLater: (d) => `Access opens on ${d}.`,
    heading: "A new syllabus is open for you",
    intro: (s) => `Your teacher gave you access to the syllabus “${s}”. Lessons open in order: finishing one opens the next.`,
    later: (d) => `Access starts on ${d}.`,
    button: "Open syllabus",
    footer: "Resulio sent this e-mail automatically because your teacher gave you a syllabus.",
  },
  ru: {
    title: (s) => `Новый силлабус: ${s}`,
    body: "Преподаватель открыл вам учебный путь. Начните с первого урока.",
    bodyLater: (d) => `Доступ откроется ${d}.`,
    heading: "Вам открыт новый силлабус",
    intro: (s) => `Преподаватель открыл вам доступ к силлабусу «${s}». Уроки открываются по порядку: завершив один, вы откроете следующий.`,
    later: (d) => `Доступ начнётся ${d}.`,
    button: "Открыть силлабус",
    footer: "Это письмо отправлено Resulio автоматически, потому что преподаватель открыл вам силлабус.",
  },
};

export function syllabusAccessInApp(locale: ServerLocale, syllabusTitle: string, startsAt: string | null) {
  const tx = SYL_ACCESS[locale];
  const date = startsAt ? noticeDate(locale, startsAt) : "";
  return { title: tx.title(cleanTitle(syllabusTitle, 120)), body: date ? tx.bodyLater(date) : tx.body };
}

export function buildSyllabusAccessEmail(input: { to: string; locale: ServerLocale; syllabusId: string; syllabusTitle: string; startsAt: string | null; appUrl: string }): EmailMessage {
  const tx = SYL_ACCESS[input.locale];
  const title = cleanTitle(input.syllabusTitle);
  const date = input.startsAt ? noticeDate(input.locale, input.startsAt) : "";
  const url = `${input.appUrl}${syllabusPath(input.syllabusId)}`;
  const lines = [tx.intro(title), ...(date ? [tx.later(date)] : [])];
  const html = emailLayout({
    heading: escapeHtml(tx.heading),
    paragraphs: lines.map(escapeHtml),
    buttonLabel: escapeHtml(tx.button),
    buttonUrl: escapeHtml(url),
    footer: escapeHtml(tx.footer),
  });
  const text = [tx.heading, "", ...lines, "", `${tx.button}: ${url}`, "", tx.footer].join("\n");
  return { to: input.to, subject: tx.title(title), html, text };
}

const SYL_UNLOCK: Record<ServerLocale, { lesson: string; lessons: (n: number) => string; module: string; body: (s: string, names: string) => string }> = {
  az: {
    lesson: "Yeni dərs açıldı",
    lessons: (n) => `${n} yeni dərs açıldı`,
    module: "Yeni modul açıldı",
    body: (s, names) => `${s}: ${names}`,
  },
  en: {
    lesson: "A new lesson is open",
    lessons: (n) => `${n} new lessons are open`,
    module: "A new module is open",
    body: (s, names) => `${s}: ${names}`,
  },
  ru: {
    lesson: "Открыт новый урок",
    lessons: (n) => `Открыто новых уроков: ${n}`,
    module: "Открыт новый модуль",
    body: (s, names) => `${s}: ${names}`,
  },
};

export function syllabusUnlockedInApp(locale: ServerLocale, d: { syllabusTitle: string; lessons: string[]; modules: string[] }) {
  const tx = SYL_UNLOCK[locale];
  const title = d.modules.length ? tx.module : d.lessons.length > 1 ? tx.lessons(d.lessons.length) : tx.lesson;
  const names = [...d.modules, ...d.lessons].map((n) => cleanTitle(n, 60)).slice(0, 4);
  const more = d.modules.length + d.lessons.length - names.length;
  return { title, body: tx.body(cleanTitle(d.syllabusTitle, 80), names.join(", ") + (more > 0 ? ` +${more}` : "")) };
}

const SYL_APPROVAL: Record<ServerLocale, { title: string; one: (name: string, s: string) => string; many: (n: number, s: string) => string }> = {
  az: {
    title: "Təsdiq gözləyir",
    one: (n, s) => `${n} «${s}» syllabus-unda növbəti mərhələyə keçmək üçün təsdiqinizi gözləyir.`,
    many: (n, s) => `«${s}»: ${n} tələbə təsdiqinizi gözləyir.`,
  },
  en: {
    title: "Approval needed",
    one: (n, s) => `${n} is waiting for your approval to move on in “${s}”.`,
    many: (n, s) => `“${s}”: ${n} students are waiting for your approval.`,
  },
  ru: {
    title: "Требуется подтверждение",
    one: (n, s) => `${n} ждёт вашего подтверждения, чтобы продолжить «${s}».`,
    many: (n, s) => `«${s}»: подтверждения ждут студентов: ${n}.`,
  },
};

export function syllabusApprovalInApp(locale: ServerLocale, d: { syllabusTitle: string; count: number; studentName: string | null }) {
  const tx = SYL_APPROVAL[locale];
  const s = cleanTitle(d.syllabusTitle, 80);
  return { title: tx.title, body: d.count === 1 && d.studentName ? tx.one(cleanTitle(d.studentName, 60), s) : tx.many(d.count, s) };
}

export const teacherGroupPath = (groupId: string) => `/teacher/groups/${encodeURIComponent(groupId)}`;

const GROUP_JOINED: Record<ServerLocale, { title: string; body: (name: string, group: string) => string; someone: string }> = {
  az: {
    title: "Yeni tələbə qoşuldu",
    body: (n, g) => `${n} dəvət linki ilə «${g}» qrupuna qoşuldu.`,
    someone: "Bir tələbə",
  },
  en: {
    title: "New student joined",
    body: (n, g) => `${n} joined “${g}” via the invite link.`,
    someone: "A student",
  },
  ru: {
    title: "Новый студент в группе",
    body: (n, g) => `${n} вступил(а) в группу «${g}» по ссылке-приглашению.`,
    someone: "Студент",
  },
};

export function groupMemberJoinedInApp(locale: ServerLocale, d: { groupName: string; studentName: string | null }) {
  const tx = GROUP_JOINED[locale];
  const name = d.studentName?.trim() ? cleanTitle(d.studentName, 60) : tx.someone;
  return { title: tx.title, body: tx.body(name, cleanTitle(d.groupName, 80)) };
}

export const teacherJoinRequestsPath = (syllabusId: string) => `/teacher/syllabus/${encodeURIComponent(syllabusId)}?tab=requests`;

const SYL_JOIN_REQUESTED: Record<ServerLocale, {
  title: string;
  group: (name: string, group: string, s: string) => string;
  individual: (name: string, s: string) => string;
  someone: string;
}> = {
  az: {
    title: "Yeni kurs müraciəti",
    group: (n, g, s) => `${n} «${s}» proqramı üzrə «${g}» qrupuna qoşulmaq istəyir.`,
    individual: (n, s) => `${n} «${s}» proqramı üzrə fərdi iştirak üçün müraciət etdi.`,
    someone: "Bir tələbə",
  },
  en: {
    title: "New course request",
    group: (n, g, s) => `${n} wants to join the group “${g}” for “${s}”.`,
    individual: (n, s) => `${n} asked to take part in “${s}” individually.`,
    someone: "A student",
  },
  ru: {
    title: "Новая заявка на курс",
    group: (n, g, s) => `${n} хочет вступить в группу «${g}» по программе «${s}».`,
    individual: (n, s) => `${n} подал(а) заявку на индивидуальное участие в программе «${s}».`,
    someone: "Студент",
  },
};

export function syllabusJoinRequestedInApp(locale: ServerLocale, d: { syllabusTitle: string; studentName: string | null; groupName: string | null }) {
  const tx = SYL_JOIN_REQUESTED[locale];
  const name = d.studentName?.trim() ? cleanTitle(d.studentName, 60) : tx.someone;
  const s = cleanTitle(d.syllabusTitle, 80);
  return { title: tx.title, body: d.groupName ? tx.group(name, cleanTitle(d.groupName, 80), s) : tx.individual(name, s) };
}

const SYL_JOIN_DECIDED: Record<ServerLocale, {
  accepted: string;
  rejected: string;
  acceptedGroup: (g: string, s: string) => string;
  acceptedIndividual: (s: string) => string;
  acceptedIndividualOpen: (s: string) => string;
  rejectedBody: (s: string) => string;
  note: (n: string) => string;
}> = {
  az: {
    accepted: "Müraciətiniz qəbul edildi",
    rejected: "Müraciətiniz qəbul edilmədi",
    acceptedGroup: (g, s) => `«${s}» proqramı üzrə «${g}» qrupuna əlavə olundunuz.`,
    acceptedIndividual: (s) => `Müəllim «${s}» proqramı üzrə fərdi iştirak müraciətinizi qəbul etdi. Müəllim sizinlə əlaqə saxlayacaq.`,
    acceptedIndividualOpen: (s) => `Müəllim «${s}» proqramı üzrə fərdi iştirak müraciətinizi qəbul etdi. Proqram artıq sizə açıqdır.`,
    rejectedBody: (s) => `Müəllim «${s}» proqramı üzrə müraciətinizi qəbul etmədi.`,
    note: (n) => `Müəllimin qeydi: ${n}`,
  },
  en: {
    accepted: "Your request was accepted",
    rejected: "Your request was declined",
    acceptedGroup: (g, s) => `You were added to the group “${g}” for “${s}”.`,
    acceptedIndividual: (s) => `The teacher accepted your request to take part in “${s}” individually and will get in touch.`,
    acceptedIndividualOpen: (s) => `The teacher accepted your request to take part in “${s}” individually. The programme is now open to you.`,
    rejectedBody: (s) => `The teacher declined your request for “${s}”.`,
    note: (n) => `Teacher's note: ${n}`,
  },
  ru: {
    accepted: "Ваша заявка принята",
    rejected: "Ваша заявка отклонена",
    acceptedGroup: (g, s) => `Вы добавлены в группу «${g}» по программе «${s}».`,
    acceptedIndividual: (s) => `Преподаватель принял вашу заявку на индивидуальное участие в программе «${s}» и свяжется с вами.`,
    acceptedIndividualOpen: (s) => `Преподаватель принял вашу заявку на индивидуальное участие в программе «${s}». Программа уже открыта для вас.`,
    rejectedBody: (s) => `Преподаватель отклонил вашу заявку по программе «${s}».`,
    note: (n) => `Комментарий преподавателя: ${n}`,
  },
};

export function syllabusJoinDecidedInApp(
  locale: ServerLocale,
  d: { syllabusTitle: string; decision: "ACCEPTED" | "REJECTED"; groupName: string | null; note: string | null; accessGranted?: boolean },
) {
  const tx = SYL_JOIN_DECIDED[locale];
  const s = cleanTitle(d.syllabusTitle, 80);
  const main =
    d.decision === "REJECTED"
      ? tx.rejectedBody(s)
      : d.groupName
        ? tx.acceptedGroup(cleanTitle(d.groupName, 80), s)
        : d.accessGranted
          ? tx.acceptedIndividualOpen(s)
          : tx.acceptedIndividual(s);
  const note = d.note?.trim() ? ` ${tx.note(cleanTitle(d.note, 300))}` : "";
  return { title: d.decision === "ACCEPTED" ? tx.accepted : tx.rejected, body: main + note };
}

const SYL_DONE: Record<ServerLocale, {
  title: (s: string) => string;
  body: string;
  heading: string;
  intro: (s: string) => string;
  code: (c: string) => string;
  button: string;
  footer: string;
}> = {
  az: {
    title: (s) => `Təbriklər! «${s}» tamamlandı`,
    body: "Bütün dərsləri və tələbləri tamamladınız.",
    heading: "Syllabus tamamlandı",
    intro: (s) => `Təbriklər! «${s}» syllabus-unun bütün dərslərini və tələblərini tamamladınız.`,
    code: (c) => `Tamamlanma kodu: ${c}`,
    button: "Nəticəyə bax",
    footer: "Bu məktub Resulio tərəfindən avtomatik göndərilib.",
  },
  en: {
    title: (s) => `Congratulations! “${s}” completed`,
    body: "You completed every lesson and requirement.",
    heading: "Syllabus completed",
    intro: (s) => `Congratulations! You completed every lesson and requirement of the syllabus “${s}”.`,
    code: (c) => `Completion code: ${c}`,
    button: "View result",
    footer: "Resulio sent this e-mail automatically.",
  },
  ru: {
    title: (s) => `Поздравляем! «${s}» завершён`,
    body: "Вы выполнили все уроки и требования.",
    heading: "Силлабус завершён",
    intro: (s) => `Поздравляем! Вы выполнили все уроки и требования силлабуса «${s}».`,
    code: (c) => `Код завершения: ${c}`,
    button: "Посмотреть результат",
    footer: "Это письмо отправлено Resulio автоматически.",
  },
};

export function syllabusCompletedInApp(locale: ServerLocale, syllabusTitle: string) {
  const tx = SYL_DONE[locale];
  return { title: tx.title(cleanTitle(syllabusTitle, 120)), body: tx.body };
}

export function buildSyllabusCompletedEmail(input: { to: string; locale: ServerLocale; syllabusId: string; syllabusTitle: string; verificationCode: string | null; appUrl: string }): EmailMessage {
  const tx = SYL_DONE[input.locale];
  const title = cleanTitle(input.syllabusTitle);
  const url = `${input.appUrl}${syllabusPath(input.syllabusId)}`;
  const code = input.verificationCode ? cleanTitle(input.verificationCode, 40) : "";
  const lines = [tx.intro(title), ...(code ? [tx.code(code)] : [])];
  const html = emailLayout({
    heading: escapeHtml(tx.heading),
    paragraphs: lines.map(escapeHtml),
    buttonLabel: escapeHtml(tx.button),
    buttonUrl: escapeHtml(url),
    footer: escapeHtml(tx.footer),
  });
  const text = [tx.heading, "", ...lines, "", `${tx.button}: ${url}`, "", tx.footer].join("\n");
  return { to: input.to, subject: tx.title(title), html, text };
}

export const teacherAnalyticsPath = (syllabusId: string) => `/teacher/syllabus/${encodeURIComponent(syllabusId)}?tab=analytics`;

const SYL_RISK: Record<ServerLocale, {
  title: (n: number) => string;
  body: (s: string, names: string, more: number) => string;
  heading: string;
  intro: (s: string, n: number) => string;
  names: (names: string, more: number) => string;
  button: string;
  footer: string;
}> = {
  az: {
    title: (n) => `Risk altında olan tələbələr: ${n}`,
    body: (s, names, more) => `«${s}»: ${names}${more > 0 ? ` və daha ${more} nəfər` : ""}.`,
    heading: "Gündəlik risk xülasəsi",
    intro: (s, n) => `«${s}» syllabus-unda ${n} tələbə risk altındadır (uzun müddət fəaliyyət yoxdur, qiymətləndirmədən keçməyib və ya qrupdan geri qalır).`,
    names: (names, more) => `${names}${more > 0 ? ` və daha ${more} nəfər` : ""}`,
    button: "Analitikaya bax",
    footer: "Bu xülasəni bildiriş ayarlarından və ya syllabus analitikasından söndürə bilərsiniz.",
  },
  en: {
    title: (n) => `Students at risk: ${n}`,
    body: (s, names, more) => `“${s}”: ${names}${more > 0 ? ` and ${more} more` : ""}.`,
    heading: "Daily at-risk digest",
    intro: (s, n) => `${n} students in the syllabus “${s}” are at risk (no recent activity, failed assessments, or falling behind the group).`,
    names: (names, more) => `${names}${more > 0 ? ` and ${more} more` : ""}`,
    button: "Open analytics",
    footer: "You can turn this digest off in notification settings or in the syllabus analytics.",
  },
  ru: {
    title: (n) => `Студенты в зоне риска: ${n}`,
    body: (s, names, more) => `«${s}»: ${names}${more > 0 ? ` и ещё ${more}` : ""}.`,
    heading: "Ежедневная сводка по рискам",
    intro: (s, n) => `В силлабусе «${s}» студентов в зоне риска: ${n} (нет активности, не сдана проверка или отставание от группы).`,
    names: (names, more) => `${names}${more > 0 ? ` и ещё ${more}` : ""}`,
    button: "Открыть аналитику",
    footer: "Сводку можно отключить в настройках уведомлений или в аналитике силлабуса.",
  },
};

type RiskDigest = { syllabusId: string; syllabusTitle: string; count: number; names: string[] };

const digestNames = (d: RiskDigest) => {
  const names = d.names.map((n) => cleanTitle(n, 60)).slice(0, 5);
  return { names: names.join(", "), more: Math.max(0, d.count - names.length) };
};

export function syllabusAtRiskInApp(locale: ServerLocale, d: RiskDigest) {
  const tx = SYL_RISK[locale];
  const { names, more } = digestNames(d);
  return { title: tx.title(d.count), body: tx.body(cleanTitle(d.syllabusTitle, 80), names, more) };
}

export function buildSyllabusAtRiskEmail(input: RiskDigest & { to: string; locale: ServerLocale; appUrl: string }): EmailMessage {
  const tx = SYL_RISK[input.locale];
  const title = cleanTitle(input.syllabusTitle);
  const { names, more } = digestNames(input);
  const url = `${input.appUrl}${teacherAnalyticsPath(input.syllabusId)}`;
  const lines = [tx.intro(title, input.count), tx.names(names, more)];
  const html = emailLayout({
    heading: escapeHtml(tx.heading),
    paragraphs: lines.map(escapeHtml),
    buttonLabel: escapeHtml(tx.button),
    buttonUrl: escapeHtml(url),
    footer: escapeHtml(tx.footer),
  });
  const text = [tx.heading, "", ...lines, "", `${tx.button}: ${url}`, "", tx.footer].join("\n");
  return { to: input.to, subject: tx.title(input.count), html, text };
}

// ---------------------------------------------------------------------------
// Tasks: assigned (one, or the open tasks of a joined group), deadline moved
// ---------------------------------------------------------------------------

export const TASK_EXCERPT_MAX_CHARS = 300;
/** Tasks listed by name in a batched notice; the rest are counted. */
export const TASK_NOTICE_MAX_ITEMS = 5;

export const studentTasksPath = "/student/assignments";
export const studentTaskPath = (taskId: string) => `${studentTasksPath}?task=${encodeURIComponent(taskId)}`;

/** Single-line start of a task description for notices. */
export function taskExcerpt(description: string, max = TASK_EXCERPT_MAX_CHARS): string {
  const flat = cleanTitle(description, Number.MAX_SAFE_INTEGER);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const BAKU_TIME: Record<ServerLocale, string> = { az: "Bakı vaxtı", en: "Baku time", ru: "по бакинскому времени" };

/** Date and time in Asia/Baku, labelled as such. */
export function taskDeadline(locale: ServerLocale, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const when = d.toLocaleString(LOCALE_TAG[locale], { timeZone: "Asia/Baku", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${when} (${BAKU_TIME[locale]})`;
}

const TASK_NEW: Record<ServerLocale, {
  subject: (title: string) => string;
  subjectMany: (n: number) => string;
  heading: string;
  headingMany: string;
  intro: (from: string) => string;
  introMany: (from: string, n: number) => string;
  deadline: (d: string) => string;
  more: (n: number) => string;
  button: string;
  buttonMany: string;
  footer: string;
}> = {
  az: {
    subject: (t) => `Yeni tapşırıq: ${t}`,
    subjectMany: (n) => `${n} açıq tapşırığınız var`,
    heading: "Sizə yeni tapşırıq verildi",
    headingMany: "Qrupunuzdakı açıq tapşırıqlar",
    intro: (f) => (f ? `${f} sizə yeni tapşırıq verdi.` : "Müəlliminiz sizə yeni tapşırıq verdi."),
    introMany: (f, n) => `Qrupa qoşuldunuz. ${f ? `${f} tərəfindən verilmiş` : "Müəlliminizin verdiyi"} ${n} açıq tapşırıq sizi gözləyir.`,
    deadline: (d) => `Son tarix: ${d}`,
    more: (n) => `və daha ${n} tapşırıq`,
    button: "Tapşırığa keç",
    buttonMany: "Tapşırıqlara keç",
    footer: "Bu məktub Resulio tərəfindən avtomatik göndərilib, çünki müəlliminiz sizə tapşırıq verdi. Bu bildirişləri Ayarlar → Bildirişlər bölməsində söndürə bilərsiniz.",
  },
  en: {
    subject: (t) => `New task: ${t}`,
    subjectMany: (n) => `You have ${n} open tasks`,
    heading: "You have a new task",
    headingMany: "Open tasks in your group",
    intro: (f) => (f ? `${f} gave you a new task.` : "Your teacher gave you a new task."),
    introMany: (f, n) => `You joined a group. ${n} open tasks ${f ? `from ${f}` : "from your teacher"} are waiting for you.`,
    deadline: (d) => `Deadline: ${d}`,
    more: (n) => `and ${n} more`,
    button: "Open task",
    buttonMany: "Open tasks",
    footer: "Resulio sent this e-mail automatically because your teacher gave you a task. You can turn these notices off in Settings → Notifications.",
  },
  ru: {
    subject: (t) => `Новое задание: ${t}`,
    subjectMany: (n) => `Открытых заданий: ${n}`,
    heading: "Вам выдано новое задание",
    headingMany: "Открытые задания вашей группы",
    intro: (f) => (f ? `${f}: вам выдано новое задание.` : "Преподаватель выдал вам новое задание."),
    introMany: (f, n) => `Вы вступили в группу. Вас ждут открытые задания${f ? ` (${f})` : ""}: ${n}.`,
    deadline: (d) => `Срок: ${d}`,
    more: (n) => `и ещё ${n}`,
    button: "Перейти к заданию",
    buttonMany: "Перейти к заданиям",
    footer: "Это письмо отправлено Resulio автоматически, потому что преподаватель выдал вам задание. Эти уведомления можно отключить в Настройки → Уведомления.",
  },
};

type TaskAssignedData = { tasks: Array<{ taskId: string; title: string; excerpt: string; deadline: string }>; total: number; from: string };

const taskItems = (d: TaskAssignedData) =>
  d.tasks.slice(0, TASK_NOTICE_MAX_ITEMS).map((x) => ({ ...x, title: cleanTitle(x.title), excerpt: taskExcerpt(x.excerpt) }));

/** Where the notice leads: the task itself, or the task list for a batch. */
export function taskAssignedPath(d: TaskAssignedData): string {
  return d.total === 1 && d.tasks[0] ? studentTaskPath(d.tasks[0].taskId) : studentTasksPath;
}

export function taskAssignedInApp(locale: ServerLocale, d: TaskAssignedData) {
  const tx = TASK_NEW[locale];
  const items = taskItems(d);
  if (d.total === 1 && items[0]) return { title: tx.subject(cleanTitle(items[0].title, 120)), body: tx.deadline(taskDeadline(locale, items[0].deadline)) };
  const names = items.map((x) => cleanTitle(x.title, 60)).join(", ");
  const more = d.total - items.length;
  return { title: tx.subjectMany(d.total), body: names + (more > 0 ? ` ${tx.more(more)}` : "") };
}

export function buildTaskAssignedEmail(input: TaskAssignedData & { to: string; locale: ServerLocale; appUrl: string }): EmailMessage {
  const tx = TASK_NEW[input.locale];
  const items = taskItems(input);
  const from = cleanTitle(input.from, 120);
  const url = `${input.appUrl}${taskAssignedPath(input)}`;
  const footer = escapeHtml(tx.footer);
  if (input.total === 1 && items[0]) {
    const task = items[0];
    const deadline = tx.deadline(taskDeadline(input.locale, task.deadline));
    const html = emailLayout({
      heading: escapeHtml(tx.heading),
      paragraphs: [escapeHtml(tx.intro(from)), `<strong>${escapeHtml(task.title)}</strong>`, ...(task.excerpt ? [escapeHtml(task.excerpt)] : []), `<strong>${escapeHtml(deadline)}</strong>`],
      buttonLabel: escapeHtml(tx.button),
      buttonUrl: escapeHtml(url),
      footer,
    });
    const text = [tx.heading, "", tx.intro(from), "", task.title, ...(task.excerpt ? [task.excerpt] : []), "", deadline, "", `${tx.button}: ${url}`, "", tx.footer].join("\n");
    return { to: input.to, subject: tx.subject(task.title), html, text };
  }
  const lines = items.map((x) => `${x.title} — ${tx.deadline(taskDeadline(input.locale, x.deadline))}`);
  const more = input.total - items.length;
  const html = emailLayout({
    heading: escapeHtml(tx.headingMany),
    paragraphs: [escapeHtml(tx.introMany(from, input.total))],
    lists: [{ heading: "", items: [...lines.map(escapeHtml), ...(more > 0 ? [escapeHtml(tx.more(more))] : [])] }],
    buttonLabel: escapeHtml(tx.buttonMany),
    buttonUrl: escapeHtml(url),
    footer,
  });
  const text = [tx.headingMany, "", tx.introMany(from, input.total), "", ...lines.map((l) => `- ${l}`), ...(more > 0 ? [`- ${tx.more(more)}`] : []), "", `${tx.buttonMany}: ${url}`, "", tx.footer].join("\n");
  return { to: input.to, subject: tx.subjectMany(input.total), html, text };
}

const TASK_MOVED: Record<ServerLocale, { title: (t: string) => string; body: (d: string) => string; heading: string; intro: (t: string) => string; before: (d: string) => string; button: string; footer: string }> = {
  az: {
    title: (t) => `Son tarix dəyişdi: ${t}`,
    body: (d) => `Yeni son tarix: ${d}`,
    heading: "Tapşırığın son tarixi dəyişdi",
    intro: (t) => `Müəlliminiz «${t}» tapşırığının son tarixini dəyişdi.`,
    before: (d) => `Əvvəlki son tarix: ${d}`,
    button: "Tapşırığa keç",
    footer: "Bu məktub Resulio tərəfindən avtomatik göndərilib. Bu bildirişləri Ayarlar → Bildirişlər bölməsində söndürə bilərsiniz.",
  },
  en: {
    title: (t) => `Deadline changed: ${t}`,
    body: (d) => `New deadline: ${d}`,
    heading: "A task's deadline changed",
    intro: (t) => `Your teacher changed the deadline of “${t}”.`,
    before: (d) => `Previous deadline: ${d}`,
    button: "Open task",
    footer: "Resulio sent this e-mail automatically. You can turn these notices off in Settings → Notifications.",
  },
  ru: {
    title: (t) => `Срок изменён: ${t}`,
    body: (d) => `Новый срок: ${d}`,
    heading: "Срок задания изменён",
    intro: (t) => `Преподаватель изменил срок задания «${t}».`,
    before: (d) => `Прежний срок: ${d}`,
    button: "Перейти к заданию",
    footer: "Это письмо отправлено Resulio автоматически. Эти уведомления можно отключить в Настройки → Уведомления.",
  },
};

type TaskUpdatedData = { taskId: string; title: string; deadline: string; previousDeadline: string };

export function taskUpdatedInApp(locale: ServerLocale, d: TaskUpdatedData) {
  const tx = TASK_MOVED[locale];
  return { title: tx.title(cleanTitle(d.title, 120)), body: tx.body(taskDeadline(locale, d.deadline)) };
}

export function buildTaskUpdatedEmail(input: TaskUpdatedData & { to: string; locale: ServerLocale; appUrl: string }): EmailMessage {
  const tx = TASK_MOVED[input.locale];
  const title = cleanTitle(input.title);
  const url = `${input.appUrl}${studentTaskPath(input.taskId)}`;
  const now = tx.body(taskDeadline(input.locale, input.deadline));
  const before = tx.before(taskDeadline(input.locale, input.previousDeadline));
  const html = emailLayout({
    heading: escapeHtml(tx.heading),
    paragraphs: [escapeHtml(tx.intro(title)), `<strong>${escapeHtml(now)}</strong>`, escapeHtml(before)],
    buttonLabel: escapeHtml(tx.button),
    buttonUrl: escapeHtml(url),
    footer: escapeHtml(tx.footer),
  });
  const text = [tx.heading, "", tx.intro(title), now, before, "", `${tx.button}: ${url}`, "", tx.footer].join("\n");
  return { to: input.to, subject: tx.title(title), html, text };
}

// ---------------------------------------------------------------------------
// Exam result (only for exams whose teacher chose to e-mail results)
// ---------------------------------------------------------------------------

export const examResultPath = (resultId: string) => `/student/results/${encodeURIComponent(resultId)}`;

const EXAM_RESULT: Record<ServerLocale, {
  subject: (t: string) => string;
  heading: string;
  intro: (t: string) => string;
  score: (earned: string, total: string, pct: string) => string;
  counts: (correct: number, wrong: number) => string;
  penaltyRule: (ratio: number) => string;
  penalty: (wrong: number, points: string) => string;
  button: string;
  footer: string;
}> = {
  az: {
    subject: (t) => `İmtahan nəticəniz: ${t}`,
    heading: "İmtahan nəticəniz hazırdır",
    intro: (t) => `«${t}» imtahanının nəticəsi:`,
    score: (e, t, p) => `Bal: ${e} / ${t} (${p}%)`,
    counts: (c, w) => `Düzgün: ${c}, səhv: ${w}`,
    penaltyRule: (r) => `Bu imtahanda ${r} səhv cavab 1 düzgün cavabı aparır (qapalı suallar).`,
    penalty: (w, p) => `${w} səhv cavaba görə çıxılan bal: ${p}`,
    button: "Ətraflı bax",
    footer: "Bu məktub Resulio tərəfindən avtomatik göndərilib, çünki müəlliminiz imtahan nəticələrinin e-poçtla göndərilməsini seçib.",
  },
  en: {
    subject: (t) => `Your exam result: ${t}`,
    heading: "Your exam result is ready",
    intro: (t) => `Your result for “${t}”:`,
    score: (e, t, p) => `Score: ${e} / ${t} (${p}%)`,
    counts: (c, w) => `Correct: ${c}, wrong: ${w}`,
    penaltyRule: (r) => `In this exam every ${r} wrong answers cancel 1 correct answer (closed questions).`,
    penalty: (w, p) => `Deducted for ${w} wrong ${w === 1 ? "answer" : "answers"}: ${p}`,
    button: "View details",
    footer: "Resulio sent this e-mail automatically because your teacher chose to e-mail exam results.",
  },
  ru: {
    subject: (t) => `Ваш результат экзамена: ${t}`,
    heading: "Результат экзамена готов",
    intro: (t) => `Результат экзамена «${t}»:`,
    score: (e, t, p) => `Баллы: ${e} / ${t} (${p}%)`,
    counts: (c, w) => `Верно: ${c}, неверно: ${w}`,
    penaltyRule: (r) => `В этом экзамене каждые ${r} неверных ответа отменяют 1 верный (закрытые вопросы).`,
    penalty: (w, p) => `Снято за неверные ответы (${w}): ${p}`,
    button: "Подробнее",
    footer: "Это письмо отправлено Resulio автоматически, потому что преподаватель выбрал отправку результатов экзамена по e-mail.",
  },
};

/** Up to two decimals with the locale's decimal mark (server ICU builds may lack `az`). */
function formatScore(n: number, locale: ServerLocale) {
  const s = String(Math.round(n * 100) / 100);
  return locale === "en" ? s : s.replace(".", ",");
}

export function buildExamResultEmail(input: {
  to: string;
  locale: ServerLocale;
  appUrl: string;
  resultId: string;
  title: string;
  earnedPoints: number;
  totalPoints: number;
  percentage: number;
  correctCount: number;
  wrongCount: number;
  penalty: { ratio: number; wrongCount: number; penaltyPoints: number } | null;
}): EmailMessage {
  const tx = EXAM_RESULT[input.locale];
  const num = (n: number) => formatScore(n, input.locale);
  const title = cleanTitle(input.title);
  const url = `${input.appUrl}${examResultPath(input.resultId)}`;
  const score = tx.score(num(input.earnedPoints), num(input.totalPoints), num(input.percentage));
  const counts = tx.counts(input.correctCount, input.wrongCount);
  const penalty = input.penalty ? [tx.penaltyRule(input.penalty.ratio), tx.penalty(input.penalty.wrongCount, `−${num(input.penalty.penaltyPoints)}`)] : [];
  const html = emailLayout({
    heading: escapeHtml(tx.heading),
    paragraphs: [escapeHtml(tx.intro(title)), `<strong>${escapeHtml(score)}</strong>`, escapeHtml(counts), ...penalty.map(escapeHtml)],
    buttonLabel: escapeHtml(tx.button),
    buttonUrl: escapeHtml(url),
    footer: escapeHtml(tx.footer),
  });
  const text = [tx.heading, "", tx.intro(title), score, counts, ...penalty, "", `${tx.button}: ${url}`, "", tx.footer].join("\n");
  return { to: input.to, subject: tx.subject(title), html, text };
}
