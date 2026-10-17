import { AppShell, EmptyState, Loading, Panel, Pill } from "@/components/AppShell";
import { LessonFormDialog } from "@/components/lessons/LessonFormDialog";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { errorText, fmtWindow } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { LessonStatus, MeetingProvider } from "@shared/lessonIntegration";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";

type ListedLesson = RouterOutputs["teacher"]["lessons"]["list"][number];

function statusPill(status: LessonStatus) {
  const cls = status === "CANCELLED" ? "text-destructive" : status === "LIVE" ? "text-success" : "text-foreground-secondary";
  return <Pill className={cls}>{t(`lessons.status.${status}`)}</Pill>;
}

function meetingNote(meetingStatus: "PENDING" | "CREATED" | "FAILED" | null, lastError?: string | null) {
  if (meetingStatus === "CREATED" || meetingStatus === null) return null;
  if (meetingStatus === "FAILED")
    return (
      <div className="space-y-1 rounded-lg bg-danger-surface px-3 py-2 text-sm text-destructive">
        <p>{t("lessons.list.meetingFailed")}</p>
        {lastError && <p className="break-words text-xs opacity-80">{lastError}</p>}
      </div>
    );
  return <p className="rounded-lg bg-warning-surface px-3 py-2 text-sm text-warning">{t("lessons.list.meetingPending")}</p>;
}

export function LessonsPage() {
  const utils = trpc.useUtils();
  const list = trpc.teacher.lessons.list.useQuery();
  const connections = trpc.teacher.lessons.connections.status.useQuery();
  const [dialog, setDialog] = useState<"closed" | "new" | ListedLesson>("closed");
  const cancel = trpc.teacher.lessons.cancel.useMutation({
    onSuccess: () => void utils.teacher.lessons.list.invalidate(),
    onError: (e) => toast.error(errorText(e)),
  });
  const del = trpc.teacher.lessons.delete.useMutation({
    onSuccess: () => {
      toast.success(t("lessons.list.deleted"));
      void utils.teacher.lessons.list.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const retry = trpc.teacher.lessons.retryMeeting.useMutation({
    onSuccess: () => {
      toast.success(t("lessons.list.retried"));
      void utils.teacher.lessons.list.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const connectedProviders: MeetingProvider[] = (connections.data ?? []).filter((c) => c.connected).map((c) => c.provider);

  return (
    <AppShell area="teaching">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">{t("lessons.list.title")}</h1>
          <Button onClick={() => setDialog("new")}>{t("lessons.list.new")}</Button>
        </div>

        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <EmptyState title={t("lessons.list.empty")} body={t("lessons.list.emptyBody")} action={<Button onClick={() => setDialog("new")}>{t("lessons.list.new")}</Button>} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {list.data.map((lesson) => (
              <Panel key={lesson.id} title={lesson.title} action={statusPill(lesson.status)}>
                <div className="space-y-2 text-sm">
                  <p className="text-foreground-secondary">{fmtWindow(lesson.startsAt, lesson.endsAt)}</p>
                  {meetingNote(lesson.meeting?.status ?? null, lesson.meeting?.lastError)}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Link href={`/teacher/lessons/${lesson.id}`} className="text-sm font-medium text-link underline underline-offset-4">
                      {t("lessons.list.openDetail")}
                    </Link>
                    {lesson.meeting?.status === "FAILED" && (
                      <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate({ lessonId: lesson.id })}>
                        {t("lessons.list.retry")}
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => setDialog(lesson)}>
                      {t("lessons.list.edit")}
                    </Button>
                    {lesson.status !== "CANCELLED" && (
                      <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate({ lessonId: lesson.id })}>
                        {t("lessons.list.cancel")}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={del.isPending}
                      onClick={() => confirm(t("lessons.list.deleteConfirm")) && del.mutate({ lessonId: lesson.id })}
                    >
                      {t("lessons.list.delete")}
                    </Button>
                  </div>
                </div>
              </Panel>
            ))}
          </div>
        )}
      </div>
      <LessonFormDialog
        open={dialog !== "closed"}
        onOpenChange={(o) => !o && setDialog("closed")}
        connectedProviders={connectedProviders}
        lesson={dialog === "closed" || dialog === "new" ? null : dialog}
      />
    </AppShell>
  );
}
