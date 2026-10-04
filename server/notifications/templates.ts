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
