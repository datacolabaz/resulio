/**
 * Exam countdown arithmetic. The remaining time is always derived from the server deadline and
 * the device clock corrected by the server offset, never from a counter, so throttled timers,
 * a frozen background tab or a sleeping laptop cannot make it drift.
 */

/** Server clock minus device clock, from one request: the server read its clock about mid-way through the round trip. */
export function clockOffset(serverNowMs: number, sentAtMs: number, receivedAtMs: number = sentAtMs): number {
  return serverNowMs - (sentAtMs + receivedAtMs) / 2;
}

export function remainingMs(deadlineMs: number, offsetMs: number, deviceNowMs: number = Date.now()): number {
  return Math.max(0, deadlineMs - (deviceNowMs + offsetMs));
}

/** Whole seconds shown on the clock; rounded up so 00:00 appears exactly at the deadline. */
export const displaySeconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/**
 * A gap between two readings of the device clock that a running interval cannot explain: the tab
 * was frozen or throttled, the laptop slept, or the device clock was changed.
 */
export function clockJumped(previousWallMs: number, wallMs: number, intervalMs: number): boolean {
  const gap = wallMs - previousWallMs;
  return gap < -1000 || gap > intervalMs + 4000;
}

export const LOW_TIME_WARNINGS_MS = [5 * 60_000, 60_000] as const;

/** The smallest warning threshold passed between two readings, or null. The first reading (`previous` null) never warns. */
export function crossedWarning(previousMs: number | null, nextMs: number, thresholds: readonly number[] = LOW_TIME_WARNINGS_MS): number | null {
  if (previousMs === null) return null;
  const crossed = thresholds.filter((t) => previousMs > t && nextMs <= t && nextMs > 0);
  return crossed.length ? Math.min(...crossed) : null;
}
