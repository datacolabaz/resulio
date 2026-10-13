// @vitest-environment happy-dom
import { QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ value: null as unknown as ReturnType<typeof import("@/test/trpcMock").createTrpcMock> }));
vi.mock("@/lib/trpc", async () => {
  const { createTrpcMock } = await import("@/test/trpcMock");
  mock.value = createTrpcMock();
  return { trpc: mock.value.trpc };
});

let el: HTMLDivElement;
let root: Root;
let WhatsNewCards: typeof import("./WhatsNew").WhatsNewCards;
let LocaleProvider: typeof import("@/i18n/locale").LocaleProvider;
let userId = 100;
let calls: { path: string; input: unknown }[] = [];

const wait = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const text = () => el.textContent ?? "";
const button = (label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (b: HTMLButtonElement | undefined) => {
  expect(b).toBeDefined();
  await act(async () => b!.click());
  await wait();
};

async function render(area: "learning" | "teaching", handlers: Record<string, (input: any) => unknown>) {
  const { handlers: h, queryClient } = mock.value;
  queryClient.clear();
  for (const k of Object.keys(h)) delete h[k];
  const id = ++userId;
  const record = (path: string) => (input: unknown) => {
    calls.push({ path, input });
    return { ready: true };
  };
  Object.assign(h, {
    "auth.me": () => ({ id, locale: "az", workspaces: area === "teaching" ? [{ id: "w1", title: "W" }] : [] }),
    "whatsNew.state": () => ({ ready: true, items: [] }),
    "whatsNew.markSeen": record("markSeen"),
    "whatsNew.dismiss": record("dismiss"),
    "*": () => null,
    ...handlers,
  });
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(LocaleProvider, null, createElement(WhatsNewCards, { area })))));
  for (let i = 0; i < 10; i++) await wait();
  return id;
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await import("@/lib/trpc");
  ({ WhatsNewCards } = await import("./WhatsNew"));
  ({ LocaleProvider } = await import("@/i18n/locale"));
}, 60_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T09:00:00Z"));
  localStorage.setItem("resulio-locale", "az");
  calls = [];
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const studentFlags = (coach: boolean, growth: boolean) => ({
  "student.coach.enabled": () => ({ enabled: coach }),
  "student.growth.enabled": () => ({ enabled: growth }),
});

describe("Yeniliklər cards", () => {
  it("shows only the features the student can open", async () => {
    await render("learning", studentFlags(true, false));
    expect(text()).toContain("Yeniliklər");
    expect(text()).toContain("AI köməkçi");
    expect(text()).not.toContain("Mövzu xəritəm");
    expect(button("Hamısını gördüm")).toBeUndefined();
    expect(el.querySelector('a[href="/student/coach"]')?.textContent).toContain("Sına");
  });

  it("closes one card and stores the dismissal on the server", async () => {
    await render("learning", studentFlags(true, true));
    expect(text()).toContain("Mövzu xəritəm");
    await click(el.querySelector<HTMLButtonElement>('button[aria-label="“AI köməkçi” kartını bağla"]') ?? undefined);
    expect(text()).not.toContain("AI köməkçi");
    expect(text()).toContain("Mövzu xəritəm");
    expect(calls).toEqual([{ path: "dismiss", input: { ids: ["study-coach"] } }]);
  });

  it("closes every card with “Hamısını gördüm”", async () => {
    await render("learning", studentFlags(true, true));
    await click(button("Hamısını gördüm"));
    expect(text()).not.toContain("Yeniliklər");
    expect(calls).toEqual([{ path: "dismiss", input: { ids: ["study-coach", "growth-plan"] } }]);
  });

  it("skips features already seen on the server", async () => {
    await render("learning", { ...studentFlags(true, true), "whatsNew.state": () => ({ ready: true, items: [{ featureId: "study-coach", seenAt: "2026-10-13T08:00:00Z", dismissedAt: null }] }) });
    expect(text()).not.toContain("AI köməkçi");
    expect(text()).toContain("Mövzu xəritəm");
  });

  it("falls back to localStorage before the migration", async () => {
    const id = await render("learning", { ...studentFlags(true, false), "whatsNew.state": () => ({ ready: false, items: [] }) });
    await click(button("Bağla"));
    expect(text()).not.toContain("AI köməkçi");
    expect(calls).toEqual([]);
    expect(JSON.parse(localStorage.getItem(`resulio.whatsNew.u${id}`) ?? "{}")["study-coach"].dismissedAt).toEqual(expect.any(Number));
  });

  it("shows teachers only what their account has (no Claude without a subscription, no shares tab without shares)", async () => {
    await render("teaching", {
      "teacher.growth.enabled": () => ({ enabled: true }),
      "teacher.coachShares.list": () => [],
      "mcpConnector.status": () => ({ isTeacher: true, entitlement: { status: "NONE" } }),
    });
    expect(text()).toContain("İnkişaf radarı");
    expect(text()).toContain("Müəllim təsdiqi ilə qoşulma");
    expect(text()).not.toContain("Claude");
    expect(text()).not.toContain("Şagirdlərin paylaşdıqları");
  });

  it("links the Claude card to its Settings panel when the subscription is active", async () => {
    await render("teaching", {
      "teacher.growth.enabled": () => ({ enabled: false }),
      "teacher.coachShares.list": () => [{ id: "s1" }],
      "mcpConnector.status": () => ({ isTeacher: true, entitlement: { status: "ACTIVE" } }),
    });
    expect(el.querySelector('a[href="/settings#claude-connector"]')).not.toBeNull();
    expect(text()).toContain("Şagirdlərin paylaşdıqları");
    expect(text()).not.toContain("İnkişaf radarı");
  });

  it("is gone after the release window", async () => {
    vi.setSystemTime(new Date("2027-01-15T09:00:00Z"));
    await render("learning", studentFlags(true, true));
    expect(text()).toBe("");
  });
});
