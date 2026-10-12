import { eq } from "drizzle-orm";
import { coachEvents, coachSettings } from "../../drizzle/schema";
import type { CoachEventType, RecallMode } from "../../shared/coach";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";

/** Coach settings, the privacy notice acceptance and the event log. */

export interface CoachSettingsView {
  recallMode: RecallMode;
  reminders: boolean;
  consentAt: Date | null;
}

export async function settingsOf(studentId: number): Promise<CoachSettingsView> {
  const [row] = await requireDb().select().from(coachSettings).where(eq(coachSettings.studentId, studentId)).limit(1);
  return { recallMode: row?.recallMode ?? "NORMAL", reminders: row?.reminders ?? true, consentAt: row?.consentAt ?? null };
}

export async function acceptConsent(studentId: number, now = new Date()) {
  await requireDb().insert(coachSettings).values({ studentId, consentAt: now }).onDuplicateKeyUpdate({ set: { consentAt: now } });
  await logEvent(studentId, "CONSENT");
  return settingsOf(studentId);
}

export async function saveSettings(studentId: number, patch: { recallMode?: RecallMode; reminders?: boolean }) {
  const set = { ...(patch.recallMode ? { recallMode: patch.recallMode } : {}), ...(patch.reminders !== undefined ? { reminders: patch.reminders } : {}) };
  if (Object.keys(set).length) await requireDb().insert(coachSettings).values({ studentId, ...set }).onDuplicateKeyUpdate({ set });
  return settingsOf(studentId);
}

/** Coach actions stay closed until the privacy notice is accepted. */
export async function assertConsent(studentId: number) {
  if (!(await settingsOf(studentId)).consentAt) throw new AppError("COACH_CONSENT_REQUIRED");
}

/** Best effort: a failed log write never fails the action. */
export async function logEvent(studentId: number, type: CoachEventType, refId?: string | null, meta?: Record<string, unknown>) {
  try {
    await requireDb().insert(coachEvents).values({ studentId, type, refId: refId?.slice(0, 32) ?? null, meta: meta ?? null });
  } catch (error) {
    console.warn("[coach] event log failed", type, error instanceof Error ? error.message : error);
  }
}
