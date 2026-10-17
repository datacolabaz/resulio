import { AppShell, Loading, Panel, Pill } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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

export function StudentLessonDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const utils = trpc.useUtils();
  const detail = trpc.student.lessons.get.useQuery({ lessonId: id });
  const [note, setNote] = useState("");
  const addNote = trpc.student.lessons.addNote.useMutation({
    onSuccess: () => {
      setNote("");
      void utils.student.lessons.get.invalidate({ lessonId: id });
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const ackConsent = trpc.student.lessons.ackConsent.useMutation({
    onSuccess: () => void utils.student.lessons.get.invalidate({ lessonId: id }),
    onError: (e) => toast.error(errorText(e)),
  });

  if (!detail.data) return <AppShell area="learning"><Loading /></AppShell>;
  const { lesson, meeting, notes, records, consentAcked } = detail.data;
  const canJoin = meeting?.status === "CREATED" && lesson.status !== "CANCELLED";

  return (
    <AppShell area="learning">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-[family-name:var(--font-display)] text-2xl">{lesson.title}</h1>
          {statusPill(lesson.status)}
        </div>

        <Panel title={t("lessons.detail.whenTitle")}>
          <p className="text-sm">{fmtWindow(lesson.startsAt, lesson.endsAt)}</p>
          {canJoin && !consentAcked && (
            <div className="mt-3 space-y-2 rounded-lg bg-warning-surface p-3 text-sm text-warning">
              <p>{t("lessons.consent.notice")}</p>
              <Button size="sm" disabled={ackConsent.isPending} onClick={() => ackConsent.mutate({ lessonId: id })}>
                {t("lessons.consent.accept")}
              </Button>
            </div>
          )}
          {canJoin && consentAcked && (
            <Button asChild className="mt-3" size="sm">
              <a href={`/api/lessons/${lesson.id}/join`}>{t("lessons.student.join")}</a>
            </Button>
          )}
        </Panel>

        {records.length > 0 && (
          <Panel title={t("lessons.detail.recordsTitle")}>
            <ul className="divide-y text-sm">
              {records
                .filter((r) => r.captureStatus === "CAPTURED")
                .map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                    <span>{t(`lessons.detail.recordKind.${r.kind}`)}</span>
                  </li>
                ))}
            </ul>
          </Panel>
        )}

        <Panel title={t("lessons.detail.notesTitle")}>
          <div className="space-y-3">
            {notes.map((n) => (
              <div key={n.id} className="rounded-lg bg-muted p-3 text-sm">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">{fmtDateTime(n.createdAt)}</p>
              </div>
            ))}
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("lessons.detail.notePlaceholder")} rows={3} />
            <Button size="sm" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate({ lessonId: id, body: note.trim() })}>
              {t("lessons.detail.addNote")}
            </Button>
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
