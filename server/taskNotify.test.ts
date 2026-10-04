import { describe, expect, it } from "vitest";
import { createSendThrottle, retryAfterMs } from "./_core/email";
import type { ServerLocale } from "./_core/locale";
import { createDispatcher, type DeliveryRow, type DeliveryStatus, type NewDelivery, type OutboxStore } from "./notifications/dispatcher";
import { ADAPTERS, type ChannelAdapter } from "./notifications/channels";
import type { Channel } from "./notifications/events";
import { channelEnabled, type PreferenceMap } from "./notifications/preferences";
import { renderNotification } from "./notifications/render";
import { buildTaskAssignedEmail, buildTaskUpdatedEmail, taskDeadline, taskExcerpt, TASK_EXCERPT_MAX_CHARS } from "./notifications/templates";
import {
  openTasksForJoin,
  planTaskSaveNotices,
  taskAssignedKey,
  taskNoticeItem,
  taskRecipients,
  taskSaveDispatches,
  type MemberRow,
} from "./modules/taskNotify";

const TEACHER = 1;
const member = (groupId: string, userId: number, status = "ACTIVE", membershipRole = "STUDENT"): MemberRow => ({ groupId, userId, status, membershipRole });

describe("task recipients", () => {
  const members = [member("g1", 10), member("g1", 11), member("g2", 11), member("g2", 12), member("g1", 13, "PENDING"), member("g2", 14, "ACTIVE", "TEACHER"), member("g3", 15), member("g1", TEACHER)];

  it("joins active group members and individually picked students, once each, without the teacher", () => {
    const task = { accessMode: "PUBLIC" as const, groupIds: ["g1", "g2"], studentIds: [12, 20, TEACHER] };
    expect(taskRecipients(task, members, TEACHER).sort((a, b) => a - b)).toEqual([10, 11, 12, 20]);
  });

  it("leaves out pending members, non-students and groups the task is not in", () => {
    const ids = taskRecipients({ accessMode: "PUBLIC", groupIds: ["g1", "g2"], studentIds: [] }, members, TEACHER);
    expect(ids).not.toContain(13);
    expect(ids).not.toContain(14);
    expect(ids).not.toContain(15);
  });

  it("a groups-only task reaches group members only, as the task page does", () => {
    expect(taskRecipients({ accessMode: "GROUPS", groupIds: ["g2"], studentIds: [10, 20] }, members, TEACHER).sort()).toEqual([11, 12]);
  });

  it("an open-link task with nobody selected notifies nobody", () => {
    expect(taskRecipients({ accessMode: "PUBLIC", groupIds: [], studentIds: [] }, members, TEACHER)).toEqual([]);
  });
});

describe("create vs edit", () => {
  const d1 = new Date("2026-10-10T14:00:00Z");

  it("create: everyone; edit: only students the task newly reaches", () => {
    expect(planTaskSaveNotices({ before: null, after: { recipients: [10, 11, 11], deadline: d1 }, notify: true })).toEqual({ assigned: [10, 11], deadlineMoved: [] });
    expect(planTaskSaveNotices({ before: { recipients: [10, 11], deadline: d1 }, after: { recipients: [10, 11, 12], deadline: d1 }, notify: true })).toEqual({ assigned: [12], deadlineMoved: [] });
    expect(planTaskSaveNotices({ before: { recipients: [10, 11], deadline: d1 }, after: { recipients: [10], deadline: d1 }, notify: true })).toEqual({ assigned: [], deadlineMoved: [] });
  });

  it("announces a deadline moved by an hour or more to students who already had the task", () => {
    const later = new Date(d1.getTime() + 60 * 60_000);
    expect(planTaskSaveNotices({ before: { recipients: [10, 11], deadline: d1 }, after: { recipients: [10, 11, 12], deadline: later }, notify: true })).toEqual({ assigned: [12], deadlineMoved: [10, 11] });
    const nudged = new Date(d1.getTime() + 30 * 60_000);
    expect(planTaskSaveNotices({ before: { recipients: [10], deadline: d1 }, after: { recipients: [10], deadline: nudged }, notify: true }).deadlineMoved).toEqual([]);
  });

  it("sends nothing when the teacher unticks the checkbox", () => {
    expect(planTaskSaveNotices({ before: null, after: { recipients: [10], deadline: d1 }, notify: false })).toEqual({ assigned: [], deadlineMoved: [] });
  });

  it("keys every notice by task and student and carries no answer key or files", () => {
    const task = { id: "t1", title: "Essay", description: "Write 300 words.", deadline: d1, attachments: [{ fileId: "f", name: "key.pdf", size: 1 }] };
    const [assigned, moved] = taskSaveDispatches(task, { assigned: [10], deadlineMoved: [11] }, "Riyaziyyat", new Date("2026-10-09T14:00:00Z"));
    expect(assigned).toMatchObject({ event: "TASK_ASSIGNED", userId: 10, dedupeKey: "task-assigned:t1:10" });
    expect(assigned.data).toEqual({ tasks: [{ taskId: "t1", title: "Essay", excerpt: "Write 300 words.", deadline: d1.toISOString() }], total: 1, from: "Riyaziyyat" });
    expect(JSON.stringify(assigned.data)).not.toContain("key.pdf");
    expect(moved).toMatchObject({ event: "TASK_UPDATED", userId: 11, dedupeKey: `task-deadline:t1:11:${d1.getTime()}` });
  });
});

describe("joining a group", () => {
  const now = new Date("2026-10-05T10:00:00Z");
  const task = (id: string, groupIds: string[], deadline: string, createdBy = TEACHER) => ({ id, groupIds, deadline: new Date(deadline), createdBy });

  it("lists the group's open, unsubmitted tasks, soonest first", () => {
    const rows = [task("late", ["g1"], "2026-10-20T00:00:00Z"), task("soon", ["g1", "g2"], "2026-10-06T00:00:00Z"), task("past", ["g1"], "2026-10-01T00:00:00Z"), task("other", ["g2"], "2026-10-07T00:00:00Z"), task("done", ["g1"], "2026-10-08T00:00:00Z"), task("practice", ["g1"], "2026-10-08T00:00:00Z")];
    const open = openTasksForJoin(rows, { groupId: "g1", userId: 10, submitted: new Set(["done"]), containers: new Set(["practice"]), now });
    expect(open.map((t) => t.id)).toEqual(["soon", "late"]);
  });
});

function memoryStore() {
  const rows: Array<DeliveryRow & { dedupeKey: string; status: DeliveryStatus; error: string | null; nextAttemptAt: Date | null }> = [];
  const store: OutboxStore = {
    async insert(row: NewDelivery) {
      if (rows.some((r) => r.dedupeKey === row.dedupeKey)) return null;
      rows.push({ ...row, id: rows.length + 1, attempts: 0, nextAttemptAt: null });
      return rows.length;
    },
    async claim(id) {
      const row = rows.find((r) => r.id === id && r.status === "QUEUED");
      if (!row) return null;
      Object.assign(row, { status: "SENDING", attempts: row.attempts + 1 });
      return { ...row };
    },
    async finish(id, outcome) {
      Object.assign(rows.find((r) => r.id === id)!, outcome);
    },
    async due() {
      return [];
    },
  };
  return { store, rows };
}

function harness(prefs: PreferenceMap = new Map()) {
  const { store, rows } = memoryStore();
  const sent: Array<{ channel: Channel; userId: number; title: string }> = [];
  const adapter = (channel: Channel): ChannelAdapter => ({
    async send(userId, content) {
      sent.push({ channel, userId, title: content.title });
      return { status: "SENT" };
    },
  });
  const dispatcher = createDispatcher({
    store,
    adapters: { IN_APP: adapter("IN_APP"), EMAIL: adapter("EMAIL"), PUSH: adapter("PUSH") },
    preferences: async () => prefs,
    recipient: async () => ({ locale: "az", email: "student@example.com" }),
    appUrl: () => "https://resulio.co",
    guards: {},
  });
  return { ...dispatcher, rows, sent };
}

describe("delivery", () => {
  const task = { id: "t1", title: "Esse", description: "", deadline: new Date("2026-10-10T14:00:00Z") };
  const inputs = taskSaveDispatches(task, { assigned: [10, 11], deadlineMoved: [] }, "Müəllim", null);

  it("sends in-app to everyone before any e-mail, and a re-save never resends", async () => {
    const h = harness();
    await h.dispatchManyNow(inputs);
    await h.dispatchManyNow(inputs);
    const order = h.sent.map((s) => `${s.channel}:${s.userId}`);
    expect([...order].sort()).toEqual(["EMAIL:10", "EMAIL:11", "IN_APP:10", "IN_APP:11", "PUSH:10", "PUSH:11"]);
    expect(order.slice(4).sort()).toEqual(["EMAIL:10", "EMAIL:11"]);
    expect(h.sent[0].title).toBe("Yeni tapşırıq: Esse");
  });

  it("respects a student's opt-out per channel", async () => {
    const h = harness(new Map([["TASK_ASSIGNED:EMAIL", false]]));
    await h.dispatchManyNow(inputs);
    expect(h.sent.some((s) => s.channel === "EMAIL")).toBe(false);
    expect(h.rows.filter((r) => r.channel === "EMAIL").map((r) => r.error)).toEqual(["OPTED_OUT", "OPTED_OUT"]);
  });

  it("is on by default; the deadline notice e-mails only on opt-in", () => {
    const none: PreferenceMap = new Map();
    expect(channelEnabled(none, "TASK_ASSIGNED", "IN_APP")).toBe(true);
    expect(channelEnabled(none, "TASK_ASSIGNED", "EMAIL")).toBe(true);
    expect(channelEnabled(none, "TASK_UPDATED", "IN_APP")).toBe(true);
    expect(channelEnabled(none, "TASK_UPDATED", "EMAIL")).toBe(false);
  });

  it("a task announced inside a join batch is not announced again on its own", async () => {
    const h = harness();
    expect(await h.reserve({ event: "TASK_ASSIGNED", userId: 10, dedupeKey: taskAssignedKey("t1", 10), reason: "BATCHED" })).toBe(true);
    expect(await h.reserve({ event: "TASK_ASSIGNED", userId: 10, dedupeKey: taskAssignedKey("t1", 10), reason: "BATCHED" })).toBe(false);
    await h.dispatchManyNow(inputs);
    expect(h.sent.filter((s) => s.userId === 10)).toEqual([]);
    expect(h.sent.filter((s) => s.userId === 11)).toHaveLength(3);
  });

  it("skips the e-mail of a student without an address", async () => {
    const content = renderNotification("TASK_ASSIGNED", inputs[0].data as never, { locale: "az", email: null }, "https://resulio.co");
    expect(await ADAPTERS.EMAIL.send(10, content, "TASK_ASSIGNED")).toEqual({ status: "SKIPPED", reason: "NO_EMAIL" });
  });
});

describe("task e-mail", () => {
  const deadline = "2026-10-05T14:00:00Z";
  const nasty = { taskId: "t/1", title: "<script>alert(1)</script> & co", excerpt: taskExcerpt(`<img src=x onerror=alert(1)> "quoted"\n${"x".repeat(1000)}`), deadline };
  const build = (locale: ServerLocale, tasks = [nasty], total = 1) => buildTaskAssignedEmail({ to: "s@example.com", locale, appUrl: "https://resulio.co", tasks, total, from: "Aysel <b>müəllim</b>" });

  it("escapes everything the teacher typed and shortens the description", () => {
    const mail = build("az");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain("<b>müəllim");
    expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    expect(mail.html).toContain("&quot;quoted&quot;");
    expect(nasty.excerpt.length).toBeLessThanOrEqual(TASK_EXCERPT_MAX_CHARS);
    expect(nasty.excerpt.endsWith("…")).toBe(true);
  });

  it("has an AZ subject, the deadline in Baku time and a button to the task", () => {
    const mail = build("az");
    expect(mail.subject).toBe("Yeni tapşırıq: <script>alert(1)</script> & co");
    expect(mail.html).toContain("Tapşırığa keç");
    expect(mail.html).toContain("https://resulio.co/student/assignments?task=t%2F1");
    expect(mail.text).toContain("Tapşırığa keç: https://resulio.co/student/assignments?task=t%2F1");
    expect(mail.text).toContain("18:00");
    expect(mail.text).toContain("Bakı vaxtı");
    expect(taskDeadline("en", deadline)).toContain("Baku time");
  });

  it("follows the student's language", () => {
    expect(build("en").subject.startsWith("New task: ")).toBe(true);
    expect(build("ru").subject.startsWith("Новое задание: ")).toBe(true);
    expect(build("ru").html).toContain("Перейти к заданию");
  });

  it("lists a join batch and counts the rest", () => {
    const items = Array.from({ length: 7 }, (_, i) => taskNoticeItem({ id: `t${i}`, title: `Task ${i}`, description: "", deadline: new Date(deadline) }));
    const mail = build("az", items, 7);
    expect(mail.subject).toBe("7 açıq tapşırığınız var");
    expect(mail.text).toContain("Task 4");
    expect(mail.text).not.toContain("Task 5");
    expect(mail.text).toContain("və daha 2 tapşırıq");
    expect(mail.text).toContain("https://resulio.co/student/assignments\n");
  });

  it("a moved deadline shows old and new times", () => {
    const mail = buildTaskUpdatedEmail({ to: "s@example.com", locale: "az", appUrl: "https://resulio.co", taskId: "t1", title: "Esse", deadline, previousDeadline: "2026-10-04T14:00:00Z" });
    expect(mail.subject).toBe("Son tarix dəyişdi: Esse");
    expect(mail.text).toContain("Əvvəlki son tarix");
  });
});

describe("e-mail throttle", () => {
  it("spaces sends evenly and slows down after a rate-limit answer", async () => {
    let clock = 0;
    const waits: number[] = [];
    const throttle = createSendThrottle(8, { now: () => clock, sleep: async (ms) => { waits.push(ms); } });
    for (let i = 0; i < 4; i++) await throttle.take();
    expect(waits).toEqual([125, 250, 375]);
    clock = 10_000;
    throttle.slowDown(2_000);
    expect(throttle.rate).toBe(4);
    waits.length = 0;
    await throttle.take();
    expect(waits).toEqual([2_000]);
    expect(retryAfterMs("3")).toBe(3_000);
    expect(retryAfterMs(null)).toBe(1_000);
    expect(retryAfterMs("999")).toBe(60_000);
  });
});
