import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as Array<{ key: string; value: unknown }>, reads: 0 }));

vi.mock("./db", () => ({
  requireDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          state.reads += 1;
          return state.rows;
        },
      }),
    }),
  }),
}));

import { clearSettingsCache, getPlatformSettings } from "./platformSettings";

describe("getPlatformSettings cache", () => {
  beforeEach(() => {
    clearSettingsCache();
    state.reads = 0;
    state.rows = [{ key: "ai.monthlyBudgetUsd", value: 10 }];
  });

  it("serves repeat reads from the cache", async () => {
    expect((await getPlatformSettings())["ai.monthlyBudgetUsd"]).toBe(10);
    state.rows = [{ key: "ai.monthlyBudgetUsd", value: 20 }];
    expect((await getPlatformSettings())["ai.monthlyBudgetUsd"]).toBe(10);
    expect(state.reads).toBe(1);
  });

  it("skips a warm cache when fresh is requested", async () => {
    await getPlatformSettings();
    state.rows = [{ key: "ai.monthlyBudgetUsd", value: 20 }];
    expect((await getPlatformSettings({ fresh: true }))["ai.monthlyBudgetUsd"]).toBe(20);
    expect((await getPlatformSettings())["ai.monthlyBudgetUsd"]).toBe(20);
    expect(state.reads).toBe(2);
  });

  it("falls back to defaults for unknown or invalid rows", async () => {
    state.rows = [
      { key: "ai.monthlyBudgetUsd", value: "lots" },
      { key: "not.a.setting", value: 1 },
    ];
    const settings = await getPlatformSettings({ fresh: true });
    expect(settings["ai.monthlyBudgetUsd"]).toBeNull();
    expect(settings).not.toHaveProperty("not.a.setting");
  });
});
