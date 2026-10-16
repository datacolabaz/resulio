/**
 * Document/share-link titles for a task, material or exam — same "<name> — <Kind> | Resulio"
 * format as syllabusPageTitle (shared/syllabusJoin.ts) and groupPageTitle (shared/groupLinks.ts),
 * so a /task/<code>, /material/<code> or /exam/<code> link looks consistent with every other
 * shared link, both in the browser tab (client/src/pages/PublicFlows.tsx) and in a
 * WhatsApp/Telegram/iMessage preview (server/_core/linkPreview.ts).
 */
export const taskPageTitle = (title: string) => (title.trim() ? `${title.trim()} — Tapşırıq | Resulio` : "Tapşırıq | Resulio");
export const materialPageTitle = (title: string) => (title.trim() ? `${title.trim()} — Material | Resulio` : "Material | Resulio");
export const examPageTitle = (title: string) => (title.trim() ? `${title.trim()} — İmtahan | Resulio` : "İmtahan | Resulio");

/** `newShareCode()` in tasks.ts/materials/service.ts/assessments.ts: nanoid(10) with "-"/"_"
 *  swapped for "x", upper-cased. Case-insensitive here too, and loose on length so it still
 *  matches the public router's bounds (z.string().trim().min(4).max(32)) if that ever changes.
 *  null for anything else (never looked up). */
export function normalizeTaskMaterialCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(code) ? code : null;
}
