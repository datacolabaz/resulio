// @vitest-environment happy-dom
import { QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockRef = vi.hoisted(() => ({ value: null as unknown as ReturnType<typeof import("@/test/trpcMock").createTrpcMock> }));
vi.mock("@/lib/trpc", async () => {
  const { createTrpcMock } = await import("@/test/trpcMock");
  mockRef.value = createTrpcMock();
  return { trpc: mockRef.value.trpc };
});

let el: HTMLDivElement;
let root: Root;
let MeetingProviderSettings: typeof import("./MeetingProviderSettings").MeetingProviderSettings;
let LocaleProvider: typeof import("@/i18n/locale").LocaleProvider;

const wait = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const button = (label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await import("@/lib/trpc");
  ({ MeetingProviderSettings } = await import("./MeetingProviderSettings"));
  ({ LocaleProvider } = await import("@/i18n/locale"));
}, 60_000);

beforeEach(() => {
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  const { handlers, queryClient } = mockRef.value;
  queryClient.clear();
  for (const k of Object.keys(handlers)) delete handlers[k];
  window.history.replaceState(null, "", "/settings");
  localStorage.clear();
  // Pre-seed so LocaleProvider picks "az" on its very first render, instead of relying on the
  // auth.me-driven effect to switch it after the fact (which this render-once test tree, built
  // with a single createElement call, never re-renders down into).
  localStorage.setItem("resulio-locale", "az");
  localStorage.setItem("resulio-locale-chosen", "1");
  Object.assign(handlers, {
    "auth.me": () => ({ id: 1, locale: "az", workspaces: [] }),
    "teacher.workspace": () => ({ id: "ws_1" }),
    "teacher.lessons.connections.status": () => [
      { provider: "GOOGLE_MEET", connected: false, status: null, accountEmail: null, connectedAt: null, lastError: null },
      { provider: "ZOOM", connected: true, status: "ACTIVE", accountEmail: "teacher@resulio.co", connectedAt: new Date().toISOString(), lastError: null },
    ],
    "teacher.lessons.connections.disconnect": () => ({ disconnected: true }),
    "*": () => null,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
});

describe("MeetingProviderSettings", () => {
  it("shows a Connect button for a provider with no connection and a Disconnect button with the account email for a connected one", async () => {
    await act(async () => root.render(createElement(QueryClientProvider, { client: mockRef.value.queryClient }, createElement(LocaleProvider, null, createElement(MeetingProviderSettings)))));
    for (let i = 0; i < 10; i++) await wait();

    expect(el.textContent).toContain("Google Meet");
    expect(el.textContent).toContain("Zoom");
    expect(el.textContent).toContain("teacher@resulio.co");
    expect(button("Qoşul")).toBeDefined();
    expect(button("Əlaqəni kəs")).toBeDefined();
  });

  it("disconnecting calls the mutation and refreshes the list", async () => {
    let disconnectCalls = 0;
    mockRef.value.handlers["teacher.lessons.connections.disconnect"] = (input: { provider: string }) => {
      disconnectCalls++;
      expect(input.provider).toBe("ZOOM");
      return { disconnected: true };
    };
    await act(async () => root.render(createElement(QueryClientProvider, { client: mockRef.value.queryClient }, createElement(LocaleProvider, null, createElement(MeetingProviderSettings)))));
    for (let i = 0; i < 10; i++) await wait();

    await act(async () => button("Əlaqəni kəs")!.click());
    await wait();

    expect(disconnectCalls).toBe(1);
  });
});
