/** Languages of server-written texts (notifications, e-mails); mirrors the client's supported locales. */
export type ServerLocale = "az" | "en" | "ru";

/** A user's stored `preferredLocale`, falling back to Azerbaijani. */
export function serverLocale(value: string | null | undefined): ServerLocale {
  return value === "en" || value === "ru" ? value : "az";
}

export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
