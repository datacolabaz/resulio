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
// AI pre-review feedback to the student (no score)
// ---------------------------------------------------------------------------

export const AI_FEEDBACK_MAX_CHARS = 1500;
export const AI_FEEDBACK_MAX_ITEMS = 5;
export const AI_FEEDBACK_MAX_ITEM_CHARS = 300;

const AI_FEEDBACK: Record<ServerLocale, {
  subject: (title: string) => string;
  heading: string;
  intro: (title: string) => string;
  disclaimer: string;
  feedback: string;
  strengths: string;
  improvements: string;
  button: string;
  footer: string;
  push: { title: string; body: (title: string) => string };
}> = {
  az: {
    subject: (t) => `İlkin AI rəyi: ${t}`,
    heading: "İşiniz üçün ilkin AI rəyi",
    intro: (t) => `«${t}» tapşırığı üzrə göndərdiyiniz işə süni intellekt ilkin rəy yazdı.`,
    disclaimer: "Bu, avtomatik ilkin rəydir, qiymət deyil. Yekun qiyməti müəlliminiz verəcək.",
    feedback: "Rəy",
    strengths: "Güclü tərəflər",
    improvements: "İnkişaf üçün",
    button: "Tapşırığa bax",
    footer: "Bu məktub avtomatik göndərilib. Müəlliminiz bu məktubları söndürə bilər.",
    push: { title: "İlkin AI rəyi hazırdır", body: (t) => `«${t}» üzrə ilkin rəy e-poçtunuza göndərildi.` },
  },
  en: {
    subject: (t) => `Preliminary AI feedback: ${t}`,
    heading: "Preliminary AI feedback on your work",
    intro: (t) => `An AI wrote preliminary feedback on what you submitted for “${t}”.`,
    disclaimer: "This is automatic preliminary feedback, not a grade. Your teacher will give the final grade.",
    feedback: "Feedback",
    strengths: "Strengths",
    improvements: "To improve",
    button: "View task",
    footer: "This e-mail was sent automatically. Your teacher can turn these e-mails off.",
    push: { title: "Preliminary AI feedback is ready", body: (t) => `Feedback on “${t}” was sent to your e-mail.` },
  },
  ru: {
    subject: (t) => `Предварительный отзыв ИИ: ${t}`,
    heading: "Предварительный отзыв ИИ о вашей работе",
    intro: (t) => `ИИ написал предварительный отзыв о работе, которую вы отправили по заданию «${t}».`,
    disclaimer: "Это автоматический предварительный отзыв, а не оценка. Итоговую оценку поставит преподаватель.",
    feedback: "Отзыв",
    strengths: "Сильные стороны",
    improvements: "Что улучшить",
    button: "Открыть задание",
    footer: "Письмо отправлено автоматически. Преподаватель может отключить такие письма.",
    push: { title: "Предварительный отзыв ИИ готов", body: (t) => `Отзыв по заданию «${t}» отправлен вам на почту.` },
  },
};

export function cleanAiFeedback(input: { feedback: string; strengths: string[]; improvements: string[] }) {
  const list = (items: string[]) =>
    items.map((s) => cleanModelText(s, AI_FEEDBACK_MAX_ITEM_CHARS).replace(/\s*\n\s*/g, " ")).filter(Boolean).slice(0, AI_FEEDBACK_MAX_ITEMS);
  return { feedback: cleanModelText(input.feedback, AI_FEEDBACK_MAX_CHARS), strengths: list(input.strengths), improvements: list(input.improvements) };
}

export function buildAiFeedbackEmail(input: {
  to: string;
  locale: ServerLocale;
  taskTitle: string;
  feedback: string;
  strengths: string[];
  improvements: string[];
  appUrl: string;
}): EmailMessage {
  const tx = AI_FEEDBACK[input.locale];
  const title = cleanTitle(input.taskTitle);
  const { feedback, strengths, improvements } = cleanAiFeedback(input);
  const url = `${input.appUrl}/student/assignments`;
  const html = emailLayout({
    heading: escapeHtml(tx.heading),
    paragraphs: [
      escapeHtml(tx.intro(title)),
      `<em>${escapeHtml(tx.disclaimer)}</em>`,
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
    tx.disclaimer,
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

export function aiFeedbackPushText(locale: ServerLocale, taskTitle: string) {
  const tx = AI_FEEDBACK[locale].push;
  return { title: tx.title, body: tx.body(cleanTitle(taskTitle, 80)) };
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
      body: "{workspace}: AI provayderi 401/403 xətası qaytardı — açar yanlışdır və ya ləğv edilib. AI_API_KEY dəyərini yoxlayın.",
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
      body: "{workspace}: the AI provider returned 401/403 — the key is invalid or revoked. Check AI_API_KEY.",
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
      body: "{workspace}: провайдер ИИ вернул ошибку 401/403 — ключ неверный или отозван. Проверьте AI_API_KEY.",
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
