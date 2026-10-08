/**
 * Where clicking an inbox notification goes: an app path is navigated in place, an http(s) link
 * (admin announcements) opens in a new tab, anything else is not followed.
 */
export function notificationTarget(path: string | null | undefined): { href: string; external: boolean } | null {
  const value = path?.trim();
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) return { href: value, external: false };
  if (/^https?:\/\//i.test(value)) return { href: value, external: true };
  return null;
}
