import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "../_core/rateLimit";
import * as filesModule from "../modules/files";
import * as shareTracking from "../modules/shareTracking";
import * as tasks from "../modules/tasks";
import { caller, makeTeacher, makeUser } from "./fixtures";

beforeEach(() => resetRateLimits());

/**
 * Covers the two confirmed root causes behind a real teacher's bug report: the public task page
 * exposed none of a task's attached files to the recipient (not open, not download), and the
 * share-funnel's "Klik" count was actually the sender's own share-button presses, not anything a
 * recipient did. See shared/shareTracking.ts and server/_core/files.ts for the fix itself.
 */

async function taskWithAttachment(scope: Awaited<ReturnType<typeof makeTeacher>>["scope"]) {
  // A real task-attachment upload always goes through POST /api/files/upload (server/_core/files.ts),
  // which is what actually decides isPublic; saveFile is called here directly only to avoid
  // standing up an Express app in this test, with the exact same isPublic value that route now passes.
  const saved = await filesModule.saveFile({
    workspaceId: scope.workspaceId,
    uploadedBy: scope.userId,
    fileName: "Excel_SUMIF_SUMIFS_3_Exercises.xlsx",
    buffer: Buffer.from("not a real workbook, just test bytes"),
    isPublic: true, // task-attachment, per the files.ts upload route
  });
  const task = await tasks.createAssignment(
    scope,
    {
      title: "SUMIF vs SUMIFS",
      description: "",
      instructions: "",
      deadline: new Date(Date.now() + 86_400_000),
      groupIds: [],
      studentIds: [],
      attachments: [{ fileId: saved.id, name: saved.name, size: saved.size }],
    },
  );
  return { task, fileId: saved.id };
}

describe("public task page: file access for recipients", () => {
  it("exposes the task's attachments through the public (pre-auth) task query", async () => {
    const teacher = await makeTeacher("Fayl müəllimi");
    const { task } = await taskWithAttachment(teacher.scope);
    const anon = caller(null);
    const seen = await anon.public.task({ shareCode: task.shareCode });
    expect(seen?.access).toBe("ALLOWED");
    expect(seen?.task?.attachments).toEqual([{ fileId: expect.any(String), name: "Excel_SUMIF_SUMIFS_3_Exercises.xlsx", size: expect.any(Number) }]);
  });

  it("lets a signed-in recipient who was never granted workspace or submission access still download the task's attachment", async () => {
    const teacher = await makeTeacher("Fayl müəllimi 2");
    const { fileId } = await taskWithAttachment(teacher.scope);
    const stranger = await makeUser("Qohum olmayan tələbə");
    const file = await filesModule.fileRow(fileId);
    expect(file).not.toBeNull();
    // Would throw FORBIDDEN before the fix (isPublic was always false for task-attachment uploads).
    await expect(filesModule.assertCanDownload(file!, stranger.id)).resolves.toBeUndefined();
  });

  it("still keeps a student's own submission file private to that student and the owning teacher", async () => {
    const teacher = await makeTeacher("Fayl müəllimi 3");
    const student = await makeUser("Təslim edən tələbə");
    const saved = await filesModule.saveFile({
      workspaceId: teacher.workspaceId,
      uploadedBy: student.id,
      fileName: "homework.pdf",
      buffer: Buffer.from("test"),
      isPublic: false, // submission context never becomes public
    });
    const stranger = await makeUser("Yad tələbə");
    const file = await filesModule.fileRow(saved.id);
    await expect(filesModule.assertCanDownload(file!, stranger.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("share funnel: sender-side vs. recipient-side events are never blended", () => {
  it("keeps CLICKED (sender shared), OPENED/DOWNLOADED/JOINED (recipient acted) as distinct, separately-counted columns", async () => {
    const teacher = await makeTeacher("Statistika müəllimi");
    const { task } = await taskWithAttachment(teacher.scope);

    // The teacher presses the WhatsApp share button twice -- this is CLICKED, and must never be
    // read as "two recipients clicked the link".
    await shareTracking.recordShareEvent({ targetType: "TASK", targetId: task.shareCode, channel: "WHATSAPP", eventType: "CLICKED" });
    await shareTracking.recordShareEvent({ targetType: "TASK", targetId: task.shareCode, channel: "WHATSAPP", eventType: "CLICKED" });
    // One recipient actually opens the public page.
    await shareTracking.recordShareEvent({ targetType: "TASK", targetId: task.shareCode, channel: "WHATSAPP", eventType: "OPENED" });
    // That same recipient downloads the attached file.
    await shareTracking.recordShareEvent({ targetType: "TASK", targetId: task.shareCode, channel: "WHATSAPP", eventType: "DOWNLOADED" });

    const funnel = await shareTracking.shareFunnel("TASK", task.shareCode);
    const expected = { clicked: 2, opened: 1, openedUnique: 1, downloaded: 1, downloadedUnique: 1, joined: 0, submitted: 0 };
    expect(funnel.byChannel.WHATSAPP).toEqual(expected);
    expect(funnel.totals).toEqual(expected);
  });

  it("records a download server-side only when the file belongs to the shared task, attributed to the link's channel", async () => {
    const teacher = await makeTeacher("Statistika müəllimi 3");
    const { task, fileId } = await taskWithAttachment(teacher.scope);
    const file = await filesModule.fileRow(fileId);
    await filesModule.recordShareDownload(file!, { targetType: "TASK", shareCode: task.shareCode, channel: "TELEGRAM", visitorId: "visitor-abc-123" }, null);
    await filesModule.recordShareDownload(file!, { targetType: "TASK", shareCode: "NOTTHISTASK", channel: "TELEGRAM" }, null);
    const funnel = await shareTracking.shareFunnel("TASK", task.shareCode);
    expect(funnel.byChannel.TELEGRAM.downloaded).toBe(1);
    expect(funnel.totals.downloaded).toBe(1);
  });

  it("shows the teacher who opened, downloaded and submitted, and keeps the teacher's own preview out", async () => {
    const teacher = await makeTeacher("Statistika müəllimi 4");
    const { task } = await taskWithAttachment(teacher.scope);
    const student = await makeUser("Linklə gələn tələbə");
    const visitorId = "browser-of-student-1";
    // Anonymous open on the student's browser, then sign-in + claim from the same browser.
    await shareTracking.recordShareEvent({ targetType: "TASK", targetId: task.shareCode, channel: "TELEGRAM", eventType: "OPENED", visitorId });
    await shareTracking.recordShareEvent({ targetType: "TASK", targetId: task.shareCode, channel: "TELEGRAM", eventType: "DOWNLOADED", visitorId });
    await caller(student).student.claimTask({ shareCode: task.shareCode, channel: "TELEGRAM", visitorId });
    await caller(student).student.claimTask({ shareCode: task.shareCode, channel: "TELEGRAM", visitorId });
    // The teacher previewing their own link must not count.
    await shareTracking.recordShareEvent({ targetType: "TASK", targetId: task.shareCode, channel: "COPY_LINK", eventType: "OPENED", actorUserId: teacher.scope.userId });
    // Someone who never signs in.
    await shareTracking.recordShareEvent({ targetType: "TASK", targetId: task.shareCode, channel: "WHATSAPP", eventType: "OPENED", visitorId: "anonymous-browser-9" });

    const report = await caller(teacher.user).teacher.tasks.engagement({ id: task.id });
    expect(report.funnel.byChannel.TELEGRAM).toMatchObject({ opened: 1, openedUnique: 1, downloaded: 1, joined: 1 });
    expect(report.funnel.byChannel.COPY_LINK.opened).toBe(0);
    expect(report.anonymous).toEqual({ visitors: 1, opens: 1, downloads: 0 });
    const row = report.students.find((s) => s.studentId === student.id);
    expect(row).toMatchObject({ channel: "TELEGRAM", downloadCount: 1, submittedAt: null, onRoster: true });
    expect(row?.openedAt).toBeInstanceOf(Date);
  });

  it("accepts a public, anonymous DOWNLOADED event through the same shareEvent mutation used for CLICKED/OPENED", async () => {
    const teacher = await makeTeacher("Statistika müəllimi 2");
    const { task } = await taskWithAttachment(teacher.scope);
    const anon = caller(null);
    await expect(
      anon.public.shareEvent({ targetType: "TASK", targetId: task.shareCode, channel: "DIRECT", eventType: "DOWNLOADED" }),
    ).resolves.toEqual({ ok: true });
    const funnel = await shareTracking.shareFunnel("TASK", task.shareCode);
    expect(funnel.totals.downloaded).toBe(1);
  });
});
