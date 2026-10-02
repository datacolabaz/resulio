import { VISITOR_ID_PATTERN } from "@shared/shareTracking";
import { nanoid } from "nanoid";

const KEY = "resulio.visitorId";
let fallback: string | null = null;

/**
 * Random id for this browser, kept in localStorage, sent with share-link events so the teacher's
 * stats can count distinct visitors and tie a visitor's pre-login activity to the account they
 * sign in with later. Carries nothing about the person; storage being blocked just yields a
 * per-page-load id.
 */
export function visitorId(): string {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && VISITOR_ID_PATTERN.test(stored)) return stored;
    const fresh = nanoid(21);
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    fallback ??= nanoid(21);
    return fallback;
  }
}
