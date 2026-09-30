import { describe, expect, it } from "vitest";
import { formatDateTime, formatDay, formatDuration, formatRelative, formatTime } from "../client/src/lib/dates";

const BAKU = { timeZone: "Asia/Baku" };
/** 29 Sep 2026, 21:34 in Baku (UTC+4). */
const INSTANT = "2026-09-29T17:34:00Z";

describe("formatDateTime", () => {
  it("renders the approved patterns", () => {
    expect(formatDateTime(INSTANT, "az", BAKU)).toBe("29.09.2026, 21:34");
    expect(formatDateTime(INSTANT, "ru", BAKU)).toBe("29.09.2026, 21:34");
    expect(formatDateTime(INSTANT, "en", BAKU)).toBe("Sep 29, 2026, 21:34");
  });

  it("never produces the ICU fallback pattern", () => {
    for (const locale of ["az", "ru", "en"] as const) {
      expect(formatDateTime(INSTANT, locale, BAKU)).not.toMatch(/M\d{2}/);
    }
  });

  it("accepts Date, ISO string and epoch milliseconds for the same instant", () => {
    const d = new Date(INSTANT);
    expect(formatDateTime(d, "az", BAKU)).toBe("29.09.2026, 21:34");
    expect(formatDateTime(d.getTime(), "az", BAKU)).toBe("29.09.2026, 21:34");
  });

  it("converts to the requested time zone", () => {
    expect(formatDateTime(INSTANT, "az", { timeZone: "UTC" })).toBe("29.09.2026, 17:34");
    expect(formatDateTime("2026-09-29T21:30:00Z", "en", BAKU)).toBe("Sep 30, 2026, 01:30");
  });

  it("uses a 24-hour clock with midnight as 00", () => {
    expect(formatTime("2026-09-29T20:00:00Z", "en", BAKU)).toBe("00:00");
    expect(formatTime("2026-09-29T09:05:00Z", "en", BAKU)).toBe("13:05");
  });

  it("renders empty and invalid input as a dash", () => {
    for (const v of [null, undefined, "", "not a date"]) {
      expect(formatDateTime(v, "az")).toBe("—");
      expect(formatDay(v, "en")).toBe("—");
    }
  });
});

describe("formatDay", () => {
  it("drops the time", () => {
    expect(formatDay(INSTANT, "az", BAKU)).toBe("29.09.2026");
    expect(formatDay(INSTANT, "en", BAKU)).toBe("Sep 29, 2026");
    expect(formatDay("2026-01-05T08:00:00Z", "en", BAKU)).toBe("Jan 5, 2026");
  });
});

describe("formatRelative", () => {
  const now = new Date(INSTANT).getTime();
  it("describes recent instants", () => {
    expect(formatRelative(now - 20_000, "en", now, BAKU)).toBe("just now");
    expect(formatRelative(now - 5 * 60_000, "en", now, BAKU)).toBe("5 min ago");
    expect(formatRelative(now - 3 * 3_600_000, "en", now, BAKU)).toBe("Today, 18:34");
    expect(formatRelative(now - 24 * 3_600_000, "en", now, BAKU)).toBe("Yesterday, 21:34");
    expect(formatRelative(now - 3 * 86_400_000, "az", now, BAKU)).toBe("26.09.2026, 21:34");
  });

  it("falls back to the full date for future instants beyond today", () => {
    expect(formatRelative(now + 2 * 86_400_000, "en", now, BAKU)).toBe("Oct 1, 2026, 21:34");
  });
});

describe("formatDuration", () => {
  it("uses the largest sensible units", () => {
    expect(formatDuration(3_900, "en")).toBe("1 h 5 min");
    expect(formatDuration(3_900, "az")).toBe("1 saat 5 dəq");
    expect(formatDuration(45 * 60, "en")).toBe("45 min");
    expect(formatDuration(90, "ru")).toBe("1 мин 30 с");
    expect(formatDuration(null, "az")).toBe("—");
  });
});
