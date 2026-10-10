import { and, eq, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentMeta, fileObjects, files, materials, notifications, questionTopics, uploadSessions } from "../../drizzle/schema";
import { normalizeForMatch } from "../../shared/questionImport";
import { resetRateLimits } from "../_core/rateLimit";
import { loadMetaRows, runMaterialMetaBackfill } from "../materials/meta";
import { runScheduledMaterialSweep } from "../materials/notify";
import { claimMaterial, publicMaterial, studentMaterials } from "../materials/service";
import { suggestTags } from "../materials/tags";
import { runUploadSweep } from "../materials/directUpload";
import { activeGroupIdsOfStudent } from "../modules/groups";
import { downloadAccess } from "../modules/files";
import { caller, db, makeGroup, makeTeacher, makeUser, outcome } from "./fixtures";

/**
 * Materials with templates (migration 0042): backfill of older rows, drafts and scheduled
 * publishing with their notices, recipients-only visibility on the share page and downloads,
 * workspace tags, task details, and direct uploads against a fake R2 signer.
 */

const r2 = vi.hoisted(() => ({
  on: true,
  objects: new Map<string, { size: number; contentType: string }>(),
  removed: [] as string[],
  aborted: [] as string[],
}));

vi.mock("../fileStorage/r2", async (importOriginal) => {
  const real = await importOriginal<typeof import("../fileStorage/r2")>();
  const signer = {
    bucket: "test-bucket",
    presignPut: async (key: string) => `https://r2.test/${key}?put`,
    createMultipart: async () => `mp-${Math.random().toString(36).slice(2)}`,
    presignPart: async (key: string, _id: string, n: number) => `https://r2.test/${key}?part=${n}`,
    completeMultipart: async () => 1,
    abortMultipart: async (key: string) => void r2.aborted.push(key),
    head: async (key: string) => r2.objects.get(key) ?? null,
    remove: async (key: string) => {
      r2.objects.delete(key);
      r2.removed.push(key);
    },
  };
  return { ...real, uploadSigner: () => (r2.on ? signer : null) };
});

beforeEach(() => {
  resetRateLimits();
  r2.on = true;
});

async function setup() {
  const teacher = await makeTeacher("Müəllim");
  const [a, b] = [await makeUser("Ayan"), await makeUser("Bəxtiyar")];
  const group = await makeGroup(teacher.scope, [a]);
  await makeGroup(teacher.scope, [b]);
  const stranger = await makeUser("Kənar");
  return { teacher, a, b, group, stranger, api: caller(teacher.user) };
}

const sees = async (userId: number, id: string) => (await studentMaterials(userId, await activeGroupIdsOfStudent(userId))).some((m) => m.id === id);
const noticesOf = async (userId: number, title: string) =>
  (await db().select().from(notifications).where(and(eq(notifications.userId, userId), like(notifications.title, `%${title}%`)))).length;
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const quiet = () => new Promise((r) => setTimeout(r, 400));
const linkMaterial = (title: string, over: Record<string, unknown> = {}) => ({ title, fileName: "", url: "https://www.youtube.com/watch?v=x", meta: { template: "GENERAL" as const, kind: "LINK" as const, values: {} }, ...over });

describe("backfill", () => {
  it("describes older materials as published GENERAL files, already announced, topic as a tag", async () => {
    const { teacher, a } = await setup();
    const id = nanoid();
    await db()
      .insert(materials)
      .values({ id, providerWorkspaceId: teacher.workspaceId, createdBy: teacher.user.id, shareCode: nanoid(10), title: "Köhnə", description: "", subject: "İnformatika", topic: "VLOOKUP", fileName: "a.xlsx", fileId: null, mimeType: "application/vnd.ms-excel", sizeBytes: 10, groupIds: [], studentIds: [a.id] });
    expect(await runMaterialMetaBackfill()).toBeGreaterThanOrEqual(1);
    const row = (await loadMetaRows("MATERIAL", [id])).get(id)!;
    expect(row).toMatchObject({ template: "GENERAL", kind: "DATASET", status: "PUBLISHED", visibility: "LINK", notify: false });
    expect(row.notifiedAt).not.toBeNull();
    expect(row.extra).toEqual({ subject: "İnformatika" });
    const listed = (await caller(teacher.user).teacher.tasks.materials()).find((m) => m.id === id)!;
    expect(listed.meta.values.topics).toEqual(["VLOOKUP"]);
    expect(await sees(a.id, id)).toBe(true);
    await runMaterialMetaBackfill();
    expect(await noticesOf(a.id, "Köhnə")).toBe(0);
  });
});

describe("publishing", () => {
  it("a draft stays hidden and silent until published, then students are told once", async () => {
    const { api, a, group } = await setup();
    const title = `Qaralama ${nanoid(4)}`;
    const m = await api.teacher.tasks.createMaterial(linkMaterial(title, { groupIds: [group.id], status: "DRAFT" }));
    await quiet();
    expect(await sees(a.id, m.id)).toBe(false);
    expect(await noticesOf(a.id, title)).toBe(0);
    expect(await publicMaterial(m.shareCode, null)).toBeNull();
    expect(await outcome(claimMaterial(a.id, m.shareCode))).toMatch(/MATERIAL_NOT_AVAILABLE/);
    await api.teacher.tasks.updateMaterial({ id: m.id, patch: {}, status: "PUBLISHED" });
    expect(await eventually(() => noticesOf(a.id, title), (n) => n > 0)).toBe(1);
    expect(await sees(a.id, m.id)).toBe(true);
    await api.teacher.tasks.updateMaterial({ id: m.id, patch: { title: `${title} 2` } });
    await quiet();
    expect(await noticesOf(a.id, title)).toBe(1);
  });

  it("an edit tells only students it newly reaches", async () => {
    const { api, a, b, group } = await setup();
    const title = `Yeni alan ${nanoid(4)}`;
    const m = await api.teacher.tasks.createMaterial(linkMaterial(title, { groupIds: [group.id] }));
    await eventually(() => noticesOf(a.id, title), (n) => n > 0);
    await api.teacher.tasks.updateMaterial({ id: m.id, patch: { studentIds: [b.id] } });
    expect(await eventually(() => noticesOf(b.id, title), (n) => n > 0)).toBe(1);
    expect(await noticesOf(a.id, title)).toBe(1);
  });

  it("no notice when the teacher turns notifications off", async () => {
    const { api, a, group } = await setup();
    const title = `Səssiz ${nanoid(4)}`;
    const m = await api.teacher.tasks.createMaterial(linkMaterial(title, { groupIds: [group.id], notifyStudents: false }));
    await quiet();
    expect(await sees(a.id, m.id)).toBe(true);
    expect(await noticesOf(a.id, title)).toBe(0);
  });

  it("a scheduled material appears at its time and the sweeper announces it exactly once", async () => {
    const { api, a, group } = await setup();
    const title = `Planlı ${nanoid(4)}`;
    const m = await api.teacher.tasks.createMaterial(linkMaterial(title, { groupIds: [group.id], publishAt: new Date(Date.now() + 3_600_000) }));
    expect(m.meta.publishAt).not.toBeNull();
    await runScheduledMaterialSweep();
    await quiet();
    expect(await sees(a.id, m.id)).toBe(false);
    expect(await noticesOf(a.id, title)).toBe(0);
    await db()
      .update(contentMeta)
      .set({ publishAt: new Date(Date.now() - 1000) })
      .where(and(eq(contentMeta.entityType, "MATERIAL"), eq(contentMeta.entityId, m.id)));
    expect(await sees(a.id, m.id)).toBe(true);
    expect(await runScheduledMaterialSweep()).toBeGreaterThanOrEqual(1);
    await runScheduledMaterialSweep();
    expect(await noticesOf(a.id, title)).toBe(1);
  });

  it("a publish time already passed means now", async () => {
    const { api, a, group } = await setup();
    const m = await api.teacher.tasks.createMaterial(linkMaterial(`Keçmiş ${nanoid(4)}`, { groupIds: [group.id], publishAt: new Date(Date.now() - 60_000) }));
    expect(m.meta.publishAt).toBeNull();
    expect(await sees(a.id, m.id)).toBe(true);
  });

  it("edit without details keeps the template and values", async () => {
    const { api, group } = await setup();
    const m = await api.teacher.tasks.createMaterial(
      linkMaterial(`IT ${nanoid(4)}`, { groupIds: [group.id], meta: { template: "IT", kind: "LINK", values: { direction: "BACKEND", technologies: ["SQL"] } } }),
    );
    const saved = await api.teacher.tasks.updateMaterial({ id: m.id, patch: { title: "IT yeni" } });
    expect(saved.meta).toMatchObject({ template: "IT", kind: "LINK", url: "https://www.youtube.com/watch?v=x", values: { direction: "BACKEND", technologies: ["SQL"] } });
  });

  it("a material is exactly one of a file or a link; switching to a link drops the file", async () => {
    const { api } = await setup();
    expect(await outcome(api.teacher.tasks.createMaterial(linkMaterial("Linksiz", { url: null })))).toMatch(/MATERIAL_SOURCE_REQUIRED/);
    expect(await outcome(api.teacher.tasks.createMaterial(linkMaterial("Pis link", { url: "javascript:alert(1)" })))).toMatch(/BAD_REQUEST/);
    expect(await outcome(api.teacher.tasks.createMaterial(linkMaterial("İkisi", { fileName: "a.pdf", meta: { template: "GENERAL", kind: "FILE", values: {} } })))).toMatch(/MATERIAL_SOURCE_REQUIRED/);
    const m = await api.teacher.tasks.createMaterial({ title: "Fayl", fileName: "a.pdf", fileId: "f1", mimeType: "application/pdf", sizeBytes: 3 });
    const saved = await api.teacher.tasks.updateMaterial({ id: m.id, patch: {}, url: "https://notion.so/x", meta: { template: "GENERAL", kind: "LINK", values: {} } });
    expect(saved).toMatchObject({ fileName: "", fileId: null, mimeType: null });
    expect(saved.meta.url).toBe("https://notion.so/x");
  });
});

describe("recipients-only visibility", () => {
  async function restricted() {
    const s = await setup();
    const fileId = nanoid();
    await db().insert(files).values({ id: fileId, workspaceId: s.teacher.workspaceId, uploadedBy: s.teacher.user.id, fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 3, dataBase64: "", isPublic: true });
    const m = await s.api.teacher.tasks.createMaterial({
      title: `Gizli ${nanoid(4)}`,
      fileName: "a.pdf",
      fileId,
      mimeType: "application/pdf",
      sizeBytes: 3,
      groupIds: [s.group.id],
      visibility: "RECIPIENTS",
    });
    const [file] = await db().select().from(files).where(eq(files.id, fileId));
    return { ...s, m, file };
  }

  it("the share page shows it only to recipients and the teacher", async () => {
    const { m, a, stranger, teacher } = await restricted();
    expect(await publicMaterial(m.shareCode, null)).toMatchObject({ access: "SIGN_IN_REQUIRED", material: null });
    expect(await publicMaterial(m.shareCode, { userId: stranger.id, groupIds: [] })).toMatchObject({ access: "DENIED", material: null });
    expect((await publicMaterial(m.shareCode, { userId: a.id, groupIds: await activeGroupIdsOfStudent(a.id) }))?.access).toBe("ALLOWED");
    expect((await publicMaterial(m.shareCode, { userId: teacher.user.id, groupIds: [] }))?.access).toBe("OWNER");
  });

  it("the share link cannot add an outsider", async () => {
    const { m, stranger } = await restricted();
    expect(await outcome(claimMaterial(stranger.id, m.shareCode))).toMatch(/MATERIAL_RESTRICTED/);
    expect(await sees(stranger.id, m.id)).toBe(false);
  });

  it("its file is not open to anyone; opening it by link again makes it open", async () => {
    const { m, a, stranger, file, api } = await restricted();
    expect(await downloadAccess(file, null)).toBe("SIGN_IN_REQUIRED");
    expect(await downloadAccess(file, stranger.id)).toBe("DENIED");
    expect(await downloadAccess(file, a.id)).toBe("ALLOWED");
    await api.teacher.tasks.updateMaterial({ id: m.id, patch: {}, visibility: "LINK" });
    expect(await downloadAccess(file, null)).toBe("OPEN");
    expect(await outcome(claimMaterial(stranger.id, m.shareCode))).toBe("OK");
  });

  it("a draft's file stays closed even when shared by link", async () => {
    const { m, file, api } = await restricted();
    await api.teacher.tasks.updateMaterial({ id: m.id, patch: {}, visibility: "LINK", status: "DRAFT" });
    expect(await downloadAccess(file, null)).toBe("SIGN_IN_REQUIRED");
  });
});

describe("tags", () => {
  it("are shared per workspace, deduplicated, and topics also come from the question bank", async () => {
    const { api, teacher } = await setup();
    const other = await makeTeacher("Digər");
    const meta = (technologies: string[]) => ({ template: "IT" as const, kind: "LINK" as const, values: { technologies, topics: ["JOIN"] } });
    await api.teacher.tasks.createMaterial(linkMaterial("SQL 1", { meta: meta(["SQL"]) }));
    await api.teacher.tasks.createMaterial(linkMaterial("SQL 2", { meta: meta(["sql ", "Python"]) }));
    expect(await suggestTags(teacher.workspaceId, "TECHNOLOGY", "sq")).toEqual([{ name: "SQL", source: "TAG" }]);
    expect((await suggestTags(teacher.workspaceId, "TECHNOLOGY", "")).map((t) => t.name)).toEqual(["SQL", "Python"]);
    expect(await suggestTags(other.workspaceId, "TECHNOLOGY", "sq")).toEqual([]);
    await db().insert(questionTopics).values({ id: nanoid(), providerWorkspaceId: teacher.workspaceId, name: "Funksiyalar", nameKey: normalizeForMatch("Funksiyalar"), createdBy: teacher.user.id });
    expect(await api.teacher.tasks.suggestTags({ type: "TOPIC", query: "funk" })).toEqual([{ name: "Funksiyalar", source: "QUESTION_BANK" }]);
    expect(await suggestTags(teacher.workspaceId, "TECHNOLOGY", "funk")).toEqual([]);
  });
});

describe("task made from the material form", () => {
  it("keeps its template details, and the material sweeper leaves it alone", async () => {
    const { api, group } = await setup();
    const task = await api.teacher.tasks.create({
      title: "Layihə: panel",
      instructions: "Power BI",
      deadline: new Date(Date.now() + 7 * 86_400_000),
      groupIds: [group.id],
      meta: { template: "PROJECT", kind: "TASK", values: { submissionFormat: "LINK", maxScore: 100 } },
    });
    const row = (await loadMetaRows("TASK", [task.id])).get(task.id)!;
    expect(row).toMatchObject({ template: "PROJECT", kind: "TASK" });
    expect(row.extra).toMatchObject({ submissionFormat: "LINK", maxScore: 100 });
    expect(row.notifiedAt).not.toBeNull();
  });
});

describe("direct uploads", () => {
  const MB = 1024 * 1024;

  it("single PUT: completes only when the object matches, then records the file once", async () => {
    const { api, teacher } = await setup();
    const bad = await api.teacher.tasks.startUpload({ fileName: "dərs.mp4", sizeBytes: 30 * MB, kind: "VIDEO" });
    expect(bad).toMatchObject({ mode: "single", contentType: "video/mp4", partCount: 1 });
    expect(await outcome(api.teacher.tasks.completeUpload({ sessionId: bad.sessionId }))).toMatch(/UPLOAD_INCOMPLETE/);
    const [aborted] = await db().select().from(uploadSessions).where(eq(uploadSessions.id, bad.sessionId));
    expect(aborted.status).toBe("ABORTED");

    const s = await api.teacher.tasks.startUpload({ fileName: "dərs.mp4", sizeBytes: 30 * MB, kind: "VIDEO" });
    const [session] = await db().select().from(uploadSessions).where(eq(uploadSessions.id, s.sessionId));
    r2.objects.set(session.objectKey, { size: 30 * MB - 1, contentType: "video/mp4" });
    expect(await outcome(api.teacher.tasks.completeUpload({ sessionId: s.sessionId }))).toMatch(/UPLOAD_INCOMPLETE/);
    expect(r2.removed).toContain(session.objectKey);

    const ok = await api.teacher.tasks.startUpload({ fileName: "dərs.mp4", sizeBytes: 30 * MB, kind: "VIDEO" });
    const [okSession] = await db().select().from(uploadSessions).where(eq(uploadSessions.id, ok.sessionId));
    r2.objects.set(okSession.objectKey, { size: 30 * MB, contentType: "video/mp4" });
    const other = await makeTeacher("Başqası");
    expect(await outcome(caller(other.user).teacher.tasks.completeUpload({ sessionId: ok.sessionId }))).toMatch(/NOT_FOUND/);
    const file = await api.teacher.tasks.completeUpload({ sessionId: ok.sessionId });
    expect(file).toMatchObject({ name: "dərs.mp4", size: 30 * MB, mimeType: "video/mp4" });
    const [fileRow] = await db().select().from(files).where(eq(files.id, file.id));
    expect(fileRow).toMatchObject({ workspaceId: teacher.workspaceId, sizeBytes: 30 * MB });
    const [obj] = await db().select().from(fileObjects).where(eq(fileObjects.fileId, file.id));
    expect(obj).toMatchObject({ backend: "r2", bucket: "test-bucket", objectKey: okSession.objectKey });
    expect(await outcome(api.teacher.tasks.completeUpload({ sessionId: ok.sessionId }))).toMatch(/UPLOAD_NOT_PENDING/);
  });

  it("multipart: signs only real parts; abort cleans up", async () => {
    const { api } = await setup();
    const s = await api.teacher.tasks.startUpload({ fileName: "sales.zip", sizeBytes: 120 * MB, kind: "DATASET" });
    expect(s).toMatchObject({ mode: "multipart", partSize: 16 * MB, partCount: 8, url: null });
    const urls = await api.teacher.tasks.uploadPartUrls({ sessionId: s.sessionId, partNumbers: [1, 2, 2, 99] });
    expect(urls.map((u) => u.partNumber)).toEqual([1, 2]);
    await api.teacher.tasks.abortUpload({ sessionId: s.sessionId });
    const [row] = await db().select().from(uploadSessions).where(eq(uploadSessions.id, s.sessionId));
    expect(row.status).toBe("ABORTED");
    expect(r2.aborted).toContain(row.objectKey);
    expect(await outcome(api.teacher.tasks.uploadPartUrls({ sessionId: s.sessionId, partNumbers: [3] }))).toMatch(/UPLOAD_NOT_PENDING/);
  });

  it("refuses wrong types, files over the kind's limit, and works only with R2", async () => {
    const { api } = await setup();
    expect(await outcome(api.teacher.tasks.startUpload({ fileName: "x.html", sizeBytes: 10 * MB, kind: "FILE" }))).toMatch(/FILE_TYPE_NOT_ALLOWED/);
    expect(await outcome(api.teacher.tasks.startUpload({ fileName: "x.pdf", sizeBytes: 51 * MB, kind: "FILE" }))).toMatch(/FILE_TOO_LARGE/);
    expect((await api.teacher.tasks.uploadConfig()).direct).toBe(true);
    r2.on = false;
    expect((await api.teacher.tasks.uploadConfig()).direct).toBe(false);
    expect(await outcome(api.teacher.tasks.startUpload({ fileName: "x.pdf", sizeBytes: 20 * MB, kind: "FILE" }))).toMatch(/DIRECT_UPLOAD_UNAVAILABLE/);
  });

  it("the sweeper expires abandoned uploads and deletes their objects", async () => {
    const { api } = await setup();
    const s = await api.teacher.tasks.startUpload({ fileName: "big.mp4", sizeBytes: 200 * MB, kind: "VIDEO" });
    await db().update(uploadSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploadSessions.id, s.sessionId));
    expect(await runUploadSweep()).toBeGreaterThanOrEqual(1);
    const [row] = await db().select().from(uploadSessions).where(eq(uploadSessions.id, s.sessionId));
    expect(row.status).toBe("EXPIRED");
    expect(r2.aborted).toContain(row.objectKey);
    expect(r2.removed).toContain(row.objectKey);
  });
});
