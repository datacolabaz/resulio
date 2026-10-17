import { AppShell, Loading, Panel, Pill } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { API_BASE } from "@/const";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime, fmtWindow } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import type { LessonStatus } from "@shared/lessonIntegration";
import { useState } from "react";
import { toast } from "sonner";
import { useParams } from "wouter";

function statusPill(status: LessonStatus) {
  const cls = status === "CANCELLED" ? "text-destructive" : status === "LIVE" ? "text-success" : "text-foreground-secondary";
  return <Pill className={cls}>{t(`lessons.status.${status}`)}</Pill>;
}

export function LessonDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const utils = trpc.useUtils();
  const detail = trpc.teacher.lessons.get.useQuery({ lessonId: id });
  const students = trpc.teacher.students.useQuery();
  const nameOf = (userId: number) => students.data?.find((s) => s.id === userId)?.name ?? t("lessons.detail.userId", { id: userId });
  const [note, setNote] = useState("");
  const addNote = trpc.teacher.lessons.addNote.useMutation({
    onSuccess: () => {
      setNote("");
      void utils.teacher.lessons.get.invalidate({ lessonId: id });
    },
    onError: (e) => toast.error(errorText(e)),
  });

  if (!detail.data) return <AppShell area="teaching"><Loading /></AppShell>;
  const { lesson, meeting, notes, attendance, records } = detail.data;

  return (
    <AppShell area="teaching">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">{lesson.title}</h1>
          {statusPill(lesson.status)}
        </div>

        <Panel title={t("lessons.detail.whenTitle")}>
          <p className="text-sm">{fmtWindow(lesson.startsAt, lesson.endsAt)}</p>
          {meeting?.status === "CREATED" && lesson.status !== "CANCELLED" && (
            <Button asChild className="mt-3" size="sm">
              <a href={`${API_BASE}/api/lessons/${lesson.id}/join`}>{t("lessons.detail.startMeeting")}</a>
            </Button>
          )}
          {meeting?.status === "FAILED" && <p className="mt-2 text-sm text-destructive">{t("lessons.list.meetingFailed")}</p>}
        </Panel>

        <Panel title={t("lessons.detail.attendanceTitle")}>
          {attendance.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("lessons.detail.noAttendance")}</p>
          ) : (
            <ul className="divide-y text-sm">
              {attendance.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                  <span>{nameOf(a.userId)}</span>
                  <span className="text-muted-foreground">{a.joinedAt ? fmtDateTime(a.joinedAt) : "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={t("lessons.detail.recordsTitle")}>
          {records.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("lessons.detail.noRecords")}</p>
          ) : (
            <ul className="divide-y text-sm">
              {records.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <span>{t(`lessons.detail.recordKind.${r.kind}`)}</span>
                  <span className="text-muted-foreground">{t(`lessons.detail.captureStatus.${r.captureStatus}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={t("lessons.detail.notesTitle")}>
          <div className="space-y-3">
            {notes.map((n) => (
              <div key={n.id} className="rounded-lg bg-muted p-3 text-sm">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">{fmtDateTime(n.createdAt)}{n.visibility === "TEACHER_ONLY" ? ` · ${t("lessons.detail.teacherOnly")}` : ""}</p>
              </div>
            ))}
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("lessons.detail.notePlaceholder")} rows={3} />
            <Button size="sm" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate({ lessonId: id, body: note.trim(), visibility: "SHARED" })}>
              {t("lessons.detail.addNote")}
            </Button>
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
