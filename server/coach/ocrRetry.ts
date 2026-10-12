import { eq } from "drizzle-orm";
import { coachMaterials } from "../../drizzle/schema";
import type { MaterialPageReport } from "../../shared/coach";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { fileBytes, fileRow } from "../modules/files";
import { addRecoveredPages, materialDetail, onMaterialReady, ownedMaterial, pageReportOf, savePageReport } from "./materials";
import { ocrPagesOf, pageReport, stopsOcr, type OcrOutcome } from "./ocr";
import { assertCoachAiAllowed } from "./quota";

/**
 * Pages OCR could not read while the material was processed are tried again in the background
 * (after 1, 3 and 10 minutes) and join the ready material in place; meanwhile the material says
 * they are still being processed. Only after the last try are they reported as failed, with a
 * button to try once more (no new upload). Timers live in this process; a restart resumes them
 * when the material is next opened.
 */

export const OCR_RETRY_DELAYS_MS = [60_000, 180_000, 600_000];

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();

export function scheduleOcrRetry(materialId: string, delayMs: number) {
  clearTimeout(timers.get(materialId));
  const timer = setTimeout(() => {
    timers.delete(materialId);
    void retryPendingPages(materialId).catch((error) => console.warn("[coach] OCR retry failed", materialId, error instanceof Error ? error.message : error));
  }, delayMs);
  timer.unref?.();
  timers.set(materialId, timer);
}

/** Picks up retries a restart dropped (the due time is in the report). */
export function resumeOcrRetry(materialId: string, report: MaterialPageReport | null, now = Date.now()) {
  if (!report?.pending?.length || timers.has(materialId) || running.has(materialId)) return;
  const due = report.retryAt ? Date.parse(report.retryAt) - now : (OCR_RETRY_DELAYS_MS[report.retries ?? 0] ?? 0);
  scheduleOcrRetry(materialId, Number.isFinite(due) ? Math.max(0, due) : 0);
}

const uniq = (pages: number[]) => [...new Set(pages)].sort((a, b) => a - b);

/** The report after one background try: recognised pages leave `pending`; the last try (or a hard stop) moves the rest to `failed`. */
export function nextReport(report: MaterialPageReport, outcome: Pick<OcrOutcome, "recognised" | "failed" | "error">, now = Date.now()): MaterialPageReport {
  const got = pageReport(outcome.recognised, [], []);
  const retries = (report.retries ?? 0) + 1;
  const still = uniq(outcome.failed.filter((p) => (report.pending ?? []).includes(p)));
  const final = still.length > 0 && (retries >= OCR_RETRY_DELAYS_MS.length || stopsOcr(outcome.error));
  return {
    low: uniq([...report.low, ...got.low]),
    image: uniq([...report.image, ...got.image]),
    failed: uniq([...report.failed, ...(final ? still : [])]),
    skipped: report.skipped,
    pending: final ? [] : still,
    retries,
    retryAt: !final && still.length ? new Date(now + OCR_RETRY_DELAYS_MS[retries]).toISOString() : null,
  };
}

/** One background try for a material's pending pages. */
export async function retryPendingPages(materialId: string) {
  if (running.has(materialId)) return;
  running.add(materialId);
  try {
    const [material] = await requireDb().select().from(coachMaterials).where(eq(coachMaterials.id, materialId)).limit(1);
    if (!material || material.status !== "READY") return;
    const report = await pageReportOf(materialId);
    const pending = report?.pending ?? [];
    if (!report || !pending.length) return;
    let outcome: OcrOutcome;
    try {
      const file = material.fileId ? await fileRow(material.fileId) : null;
      if (!file) throw new AppError("FILE_NOT_FOUND");
      await assertCoachAiAllowed(material.studentId);
      outcome = await ocrPagesOf(material, await fileBytes(file), pending);
    } catch (error) {
      outcome = { recognised: [], failed: pending, error };
    }
    const pages = outcome.recognised.filter((p) => p.text.trim()).map((p) => ({ page: p.page, text: p.text, method: "OCR" as const, quality: p.quality }));
    if (pages.length) await addRecoveredPages(materialId, pages);
    const next = nextReport(report, outcome);
    await savePageReport(materialId, material.studentId, next);
    const errorCode = next.failed.length ? "OCR_PARTIAL" : material.errorCode === "OCR_PARTIAL" ? null : material.errorCode;
    if (errorCode !== material.errorCode) await requireDb().update(coachMaterials).set({ errorCode, updatedAt: material.updatedAt }).where(eq(coachMaterials.id, materialId));
    console.info("[coach] OCR retry", materialId, { tried: pending.length, recognised: outcome.recognised.length, pending: next.pending?.length ?? 0, failed: next.failed.length });
    if (next.pending?.length) scheduleOcrRetry(materialId, OCR_RETRY_DELAYS_MS[next.retries ?? 0] ?? OCR_RETRY_DELAYS_MS[OCR_RETRY_DELAYS_MS.length - 1]);
  } finally {
    running.delete(materialId);
  }
}

/** "Yenidən cəhd et" on pages that failed every background try: one more try now. */
export async function retryFailedPages(studentId: number, materialId: string) {
  const m = await ownedMaterial(studentId, materialId);
  if (m.status !== "READY") throw new AppError("COACH_NOT_READY");
  const report = await pageReportOf(materialId);
  if (report?.failed.length && !running.has(materialId)) {
    const pending = uniq([...(report.pending ?? []), ...report.failed]);
    await savePageReport(materialId, studentId, { ...report, failed: [], pending, retries: OCR_RETRY_DELAYS_MS.length - 1, retryAt: new Date().toISOString() });
    if (m.errorCode === "OCR_PARTIAL") await requireDb().update(coachMaterials).set({ errorCode: null, updatedAt: m.updatedAt }).where(eq(coachMaterials.id, materialId));
    scheduleOcrRetry(materialId, 0);
  }
  return materialDetail(studentId, materialId);
}

onMaterialReady(async ({ materialId }) => resumeOcrRetry(materialId, await pageReportOf(materialId)));
