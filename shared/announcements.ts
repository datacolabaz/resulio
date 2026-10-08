/**
 * Platform announcements sent by admins to browser-push subscribers and, for signed-in users, the
 * in-app feed. Shared by the admin UI and the server, which validates everything again.
 */

export const ANNOUNCEMENT_AUDIENCES = ["ALL", "SIGNED_IN", "ANONYMOUS", "TEACHERS", "STUDENTS"] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export const ANNOUNCEMENT_LOCALES = ["az", "en", "ru"] as const;
export type AnnouncementLocale = (typeof ANNOUNCEMENT_LOCALES)[number];

/** AUTO = each recipient gets their own language, falling back to Azerbaijani. */
export const ANNOUNCEMENT_LANGUAGES = ["AUTO", ...ANNOUNCEMENT_LOCALES] as const;
export type AnnouncementLanguage = (typeof ANNOUNCEMENT_LANGUAGES)[number];

export const ANNOUNCEMENT_STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED"] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

export const ANNOUNCEMENT_TITLE_MAX = 80;
export const ANNOUNCEMENT_BODY_MAX = 240;
export const ANNOUNCEMENT_URL_MAX = 500;

export interface AnnouncementText {
  title: string;
  body: string;
}
export type AnnouncementTexts = Partial<Record<AnnouncementLocale, AnnouncementText>>;

const filled = (t: AnnouncementText | undefined): t is AnnouncementText => !!t && !!t.title.trim() && !!t.body.trim();

/** The text a recipient with `locale` gets, or null when nothing usable was written. */
export function pickAnnouncementText(texts: AnnouncementTexts, language: AnnouncementLanguage, locale: string): AnnouncementText | null {
  if (language !== "AUTO") return filled(texts[language]) ? texts[language]! : null;
  const own = texts[locale as AnnouncementLocale];
  if (filled(own)) return own;
  for (const l of ANNOUNCEMENT_LOCALES) if (filled(texts[l])) return texts[l]!;
  return null;
}

/** A single language needs its own text; AUTO needs Azerbaijani (the fallback) and allows the others. */
export function announcementTextsValid(language: AnnouncementLanguage, texts: AnnouncementTexts): boolean {
  if (language !== "AUTO") return filled(texts[language]);
  if (!filled(texts.az)) return false;
  return ANNOUNCEMENT_LOCALES.every((l) => {
    const text = texts[l];
    if (!text) return true;
    const title = !!text.title.trim();
    const body = !!text.body.trim();
    return title === body;
  });
}

/** Relative in-app path ("/about") or an absolute https URL. */
export function isSafeAnnouncementUrl(url: string): boolean {
  if (url.length > ANNOUNCEMENT_URL_MAX) return false;
  if (url.startsWith("/")) return !url.startsWith("//") && !url.startsWith("/\\");
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Who an audience reaches: which signed-in users (in-app + their push devices) and whether anonymous subscribers. */
export function audiencePlan(audience: AnnouncementAudience): { users: "ALL" | "TEACHERS" | "STUDENTS" | null; anonymous: boolean } {
  switch (audience) {
    case "ALL":
      return { users: "ALL", anonymous: true };
    case "SIGNED_IN":
      return { users: "ALL", anonymous: false };
    case "ANONYMOUS":
      return { users: null, anonymous: true };
    case "TEACHERS":
      return { users: "TEACHERS", anonymous: false };
    case "STUDENTS":
      return { users: "STUDENTS", anonymous: false };
  }
}
