import { describe, expect, it } from "vitest";
import { clockJumped, clockOffset, crossedWarning, displaySeconds, remainingMs } from "../client/src/lib/examClock";
import { fmtClock } from "../client/src/lib/format";

const SERVER_START = Date.parse("2026-10-09T10:00:00Z");
const DEADLINE = SERVER_START + 50 * 60_000;
/** The device clock of the student's laptop runs 7 minutes behind the server. */
const SKEW = -7 * 60_000;
const device = (serverMs: number) => serverMs + SKEW;
const shown = (ms: number) => fmtClock(displaySeconds(ms) * 1000);

describe("exam clock offset", () => {
  it("takes the server clock at the middle of the round trip", () => {
    const sentAt = device(SERVER_START) - 400;
    const receivedAt = device(SERVER_START) + 400;
    expect(clockOffset(SERVER_START, sentAt, receivedAt)).toBe(-SKEW);
    expect(clockOffset(SERVER_START, device(SERVER_START))).toBe(-SKEW);
  });

  it("shows the server's remaining time on a device with a wrong clock", () => {
    const offset = clockOffset(SERVER_START, device(SERVER_START));
    expect(shown(remainingMs(DEADLINE, offset, device(SERVER_START)))).toBe("50:00");
    expect(shown(remainingMs(DEADLINE, offset, device(SERVER_START + 3 * 60_000 + 41_000)))).toBe("46:19");
    // Without the offset the same device would show 7 extra minutes.
    expect(shown(remainingMs(DEADLINE, 0, device(SERVER_START)))).toBe("57:00");
  });
});

describe("exam clock is derived, never counted down", () => {
  const offset = clockOffset(SERVER_START, device(SERVER_START));

  it("is exact after a background tab got no timer ticks for minutes", () => {
    // Intensive throttling: one wake-up per minute, or none at all while frozen.
    const before = remainingMs(DEADLINE, offset, device(SERVER_START + 60_000));
    const afterBackground = remainingMs(DEADLINE, offset, device(SERVER_START + 9 * 60_000 + 30_000));
    expect(shown(before)).toBe("49:00");
    expect(shown(afterBackground)).toBe("40:30");
  });

  it("is exact after the laptop slept, and reaches zero (never negative) if the deadline passed meanwhile", () => {
    expect(shown(remainingMs(DEADLINE, offset, device(SERVER_START + 30 * 60_000)))).toBe("20:00");
    expect(remainingMs(DEADLINE, offset, device(DEADLINE + 5 * 60_000))).toBe(0);
    expect(shown(0)).toBe("00:00");
  });

  it("shows 00:00 exactly at the deadline, not a second early", () => {
    expect(shown(remainingMs(DEADLINE, offset, device(DEADLINE - 400)))).toBe("00:01");
    expect(shown(remainingMs(DEADLINE, offset, device(DEADLINE)))).toBe("00:00");
  });

  it("a refresh recomputes the same remaining time from the stored deadline", () => {
    const at = SERVER_START + 12 * 60_000 + 5000;
    const beforeRefresh = remainingMs(DEADLINE, offset, device(at));
    // The reloaded page measures the offset again from the server's current time.
    const reloadedOffset = clockOffset(at + 800, device(at + 800));
    const afterRefresh = remainingMs(DEADLINE, reloadedOffset, device(at + 800));
    expect(beforeRefresh - afterRefresh).toBe(800);
    expect(shown(afterRefresh)).toBe("37:55");
  });

  it("a device clock change is detected and a server resync restores the true time", () => {
    const at = SERVER_START + 20 * 60_000;
    const lastTick = device(at);
    const jumpedTick = device(at) + 250 - 5 * 60_000;
    expect(clockJumped(lastTick, jumpedTick, 250)).toBe(true);
    // Until the resync the old offset is wrong by the size of the jump...
    expect(shown(remainingMs(DEADLINE, offset, jumpedTick))).toBe("35:00");
    // ...afterwards the new offset absorbs it.
    const resynced = clockOffset(at + 250, jumpedTick);
    expect(shown(remainingMs(DEADLINE, resynced, jumpedTick))).toBe("30:00");
  });

  it("treats regular ticks as continuous and long gaps (frozen tab, sleep) as jumps", () => {
    expect(clockJumped(1000, 1250, 250)).toBe(false);
    expect(clockJumped(1000, 3000, 250)).toBe(false);
    expect(clockJumped(1000, 66_000, 250)).toBe(true);
    expect(clockJumped(10_000, 5000, 250)).toBe(true);
  });
});

describe("low-time warnings", () => {
  it("warns once when 5 and 1 minutes are crossed", () => {
    expect(crossedWarning(null, 4 * 60_000)).toBeNull();
    expect(crossedWarning(5 * 60_000 + 200, 5 * 60_000 - 50)).toBe(5 * 60_000);
    expect(crossedWarning(5 * 60_000 - 50, 5 * 60_000 - 300)).toBeNull();
    expect(crossedWarning(60_100, 59_900)).toBe(60_000);
  });

  it("after a long gap only the most urgent warning is given, and none at zero", () => {
    expect(crossedWarning(10 * 60_000, 30_000)).toBe(60_000);
    expect(crossedWarning(2 * 60_000, 0)).toBeNull();
  });
});
