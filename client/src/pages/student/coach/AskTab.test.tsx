// @vitest-environment happy-dom
import { QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrpcMock } from "@/test/trpcMock";

const mock = vi.hoisted(() => ({ value: null as unknown as ReturnType<typeof import("@/test/trpcMock").createTrpcMock> }));
vi.mock("@/lib/trpc", async () => {
  const { createTrpcMock } = await import("@/test/trpcMock");
  mock.value = createTrpcMock();
  return { trpc: mock.value.trpc };
});

type Mode = "CLARIFY" | "HINT" | "EXPLAIN" | "EXAMPLE" | "CHECK" | "EVALUATE" | "RECALL";
const now = new Date("2026-10-12T10:00:00Z");
const QUOTE = "Prosessor əmrləri yaddaşdan oxuyur";
const user = (id: string, action: string, content = "") => ({ id, role: "USER", action, mode: null, content, cites: [], grounding: null, recall: false, createdAt: now });
const bot = (id: string, mode: Mode, content: string, extra: Record<string, unknown> = {}) => ({ id, role: "ASSISTANT", action: "ASK", mode, content, cites: [{ chunkId: "c1", page: 3, quote: QUOTE }], grounding: "MATERIAL", recall: false, createdAt: now, ...extra });

let el: HTMLDivElement;
let root: Root;
let AskTab: typeof import("./AskTab").AskTab;
let LocaleProvider: typeof import("@/i18n/locale").LocaleProvider;

const wait = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await wait();
  expect(check()).toBe(true);
};
const text = () => el.textContent ?? "";
const button = (label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (label: string) => {
  const b = button(label);
  expect(b, label).toBeDefined();
  await act(async () => b!.click());
  await wait();
};
const type = async (value: string) => {
  const ta = el.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await wait();
};

/** A thread already on screen: `th1` with these messages. */
async function renderWith(messages: unknown[], extra: Record<string, (input: any) => unknown> = {}) {
  const { handlers, queryClient } = mock.value;
  queryClient.clear();
  for (const k of Object.keys(handlers)) delete handlers[k];
  Object.assign(handlers, {
    "auth.me": () => ({ id: 7, locale: "az" }),
    "student.coach.tutor.locked": () => ({ locked: false }),
    "student.coach.tutor.threads": () => (messages.length ? [{ id: "th1", title: "Prosessor", messageCount: messages.length, lastMessageAt: now }] : []),
    "student.coach.tutor.thread": () => ({ id: "th1", topicId: "t1", title: "Prosessor", messages }),
    "*": () => null,
    ...extra,
  });
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(LocaleProvider, null, createElement(AskTab, { topicId: "t1" })))));
  await wait();
  if (messages.length) {
    const select = el.querySelector("select")!;
    await act(async () => {
      select.value = "th1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await wait();
  }
}

beforeAll(async () => {
  await import("@/lib/trpc");
  ({ AskTab } = await import("./AskTab"));
  ({ LocaleProvider } = await import("@/i18n/locale"));
}, 60_000);

beforeEach(() => {
  localStorage.setItem("resulio-locale", "az");
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.restoreAllMocks();
});

describe("Soruş tab", () => {
  it.each([
    ["CLARIFY", null],
    ["HINT", "İpucu"],
    ["EXPLAIN", null],
    ["EXAMPLE", null],
    ["CHECK", "Yoxlama sualı"],
    ["EVALUATE", "Cavabınızın yoxlanışı"],
    ["RECALL", null],
  ] as const)("renders a %s reply with its sources", async (mode, badge) => {
    await renderWith([user("u1", "ASK", "Prosessor nə edir?"), bot("a1", mode, `${mode} cavabı`, { recall: mode === "RECALL" })]);
    await until(() => text().includes(`${mode} cavabı`));
    expect(text()).toContain("Materialınızdan");
    expect(text()).toContain("səh. 3");
    if (badge) expect(text()).toContain(badge);
    if (mode === "RECALL") expect(text()).toContain("Təkrar sualı");
  });

  it("renders NOT_FOUND and empty cites", async () => {
    await renderWith([user("u1", "ASK", "Futbol?"), bot("a1", "CLARIFY", "Mövzudan kənardır.", { grounding: "NOT_FOUND", cites: [] })]);
    await until(() => text().includes("Mövzudan kənardır."));
    expect(text()).toContain("Mövzudan kənar");
    expect(text()).not.toContain("səh.");
  });

  it("survives malformed messages: one bad bubble shows an inline notice, the rest stays", async () => {
    const boom = { toString: () => { throw new Error("bad content"); } };
    await renderWith([
      user("u1", "QUIZ_ME"),
      bot("a1", "CHECK", "Sağlam sual?"),
      bot("a2", "CLARIFY", "Siyahı yox", { cites: "[]", grounding: { x: 1 }, mode: 5 }),
      bot("a3", "CLARIFY", "Naməlum", { cites: [null, { page: "x" }, { chunkId: "c1", page: 4, quote: "q" }], grounding: "BOOK", action: "WHAT" }),
      bot("a4", "CLARIFY", boom as unknown as string),
      user("u2", "NOPE", "son"),
    ]);
    await until(() => text().includes("Sağlam sual?"));
    expect(text()).toContain("Siyahı yox");
    expect(text()).toContain("Naməlum");
    expect(text()).toContain("səh. 4");
    expect(text()).toContain("son");
    expect(text()).toContain("Cavab göstərilə bilmədi, yenidən cəhd edin.");
    expect(el.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("Məni yoxla: one question, then the typed answer is sent for evaluation", async () => {
    const calls: any[] = [];
    let messages: unknown[] = [];
    await renderWith([], {
      "student.coach.tutor.thread": () => ({ id: "th1", topicId: "t1", title: "Prosessor", messages }),
      "student.coach.tutor.ask": (input: any) => {
        calls.push(input);
        messages =
          input.action === "QUIZ_ME"
            ? [user("u1", "QUIZ_ME"), bot("a1", "CHECK", "Prosessor əmrlə nə edir?")]
            : [...messages, user("u2", "ASK", input.text), bot("a2", "EVALUATE", "Qismən düzgündür.")];
        return { id: "th1", topicId: "t1", title: "Prosessor", messages };
      },
    });
    await click("Məni yoxla");
    await until(() => text().includes("Prosessor əmrlə nə edir?"));
    expect(el.querySelector("textarea")!.placeholder).toBe("Cavabınızı yazın…");
    await type("oxuyur və icra edir");
    await until(() => text().includes("Qismən düzgündür."));
    expect(calls).toMatchObject([{ action: "QUIZ_ME", text: "" }, { action: "ASK", text: "oxuyur və icra edir", threadId: "th1" }]);
    expect(text()).toContain("Cavabınızın yoxlanışı");
    expect(el.querySelector("textarea")!.placeholder).toBe("Sualınızı yazın…");
  });

  it("a failed reply shows inline with a retry that resends the same request", async () => {
    let fail = true;
    const calls: any[] = [];
    let saved: unknown = null;
    await renderWith([], {
      "student.coach.tutor.thread": () => saved,
      "student.coach.tutor.ask": (input: any) => {
        calls.push(input);
        if (fail) throw new TRPCClientError("AI_INVALID_OUTPUT");
        saved = { id: "th1", topicId: "t1", title: "x", messages: [user("u1", "ASK", input.text), bot("a1", "CLARIFY", "İndi alındı.")] };
        return saved;
      },
    });
    await type("sual ver");
    await until(() => text().includes("Cavab göstərilə bilmədi"));
    expect(text()).toContain("sual ver");
    fail = false;
    await click("Yenidən cəhd et");
    await until(() => text().includes("İndi alındı."));
    expect(calls.map((c) => c.text)).toEqual(["sual ver", "sual ver"]);
    expect(text()).not.toContain("Cavab göstərilə bilmədi");
  });

  it("a crash anywhere in the chat stays inside the tab and can be retried", async () => {
    let broken = true;
    await renderWith([], {
      "student.coach.tutor.threads": () => (broken ? [{ id: "th1", get title(): string { throw new Error("boom"); }, messageCount: 1, lastMessageAt: now }] : []),
    });
    await until(() => text().includes("Cavab göstərilə bilmədi"));
    broken = false;
    mock.value.queryClient.clear();
    await click("Yenidən cəhd et");
    await until(() => text().includes("Məni yoxla"));
    expect(text()).not.toContain("Cavab göstərilə bilmədi");
  });
});
