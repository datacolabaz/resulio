import type { EmailMessage } from "../_core/email";
import type { ServerLocale } from "../_core/locale";
import type { EventData, EventType } from "./events";
import { aiAlertText, aiGradeInAppText, buildAiGradeEmail, buildGradeEmail, gradeInAppText } from "./templates";

export interface Recipient {
  locale: ServerLocale;
  email: string | null;
}

/** One event as each channel shows it. `email` is null when the event has no e-mail form. */
export interface RenderedNotification {
  title: string;
  body: string;
  /** Path in the web/mobile app the notification should open. */
  path: string;
  email: EmailMessage | null;
}

export function renderNotification<E extends EventType>(event: E, data: EventData[E], recipient: Recipient, appUrl: string): RenderedNotification {
  const { locale } = recipient;
  const to = recipient.email ?? "";
  switch (event) {
    case "AI_GRADE_READY": {
      const d = data as EventData["AI_GRADE_READY"];
      const email = buildAiGradeEmail({ to, locale, appUrl, taskTitle: d.taskTitle, score: d.score, feedback: d.feedback, strengths: d.strengths, improvements: d.improvements });
      return { ...aiGradeInAppText(locale, d.taskTitle, d.score), path: "/student/assignments", email };
    }
    case "GRADE_RELEASED":
    case "GRADE_UPDATED": {
      const d = data as EventData["GRADE_RELEASED"];
      const kind = event === "GRADE_RELEASED" ? "released" : "updated";
      const mail = buildGradeEmail({ to, locale, kind, taskTitle: d.taskTitle, score: d.score, appUrl });
      const inApp = kind === "released" ? gradeInAppText(locale) : { title: mail.subject, body: "" };
      return { ...inApp, path: "/student/assignments", email: mail };
    }
    case "AI_LIMIT_80":
    case "AI_LIMIT_REACHED": {
      const d = data as EventData["AI_LIMIT_80"];
      return { ...aiAlertText(locale, event === "AI_LIMIT_80" ? "USAGE_80" : "LIMIT_REACHED", d), path: "/settings", email: null };
    }
    case "AI_PROVIDER_ERROR": {
      const d = data as EventData["AI_PROVIDER_ERROR"];
      return { ...aiAlertText(locale, d.problem === "AUTH" ? "PROVIDER_AUTH" : "PROVIDER_QUOTA", d), path: "/settings", email: null };
    }
    default:
      throw new Error(`No renderer for ${String(event)}`);
  }
}
