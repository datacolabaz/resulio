import { ErrorNote, Loading } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "./shared";

/**
 * Confirmation for deleting a syllabus. Enrolled students block the delete (the server refuses it
 * too), so the dialog offers archiving instead of a button that would only fail.
 */
export function DeleteSyllabusDialog({
  syllabusId,
  open,
  onOpenChange,
  onDeleted,
}: {
  syllabusId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDeleted?: () => void;
}) {
  const utils = trpc.useUtils();
  const list = trpc.teacher.syllabus.list.useQuery(undefined, { enabled: open });
  const s = list.data?.find((r) => r.id === syllabusId) ?? null;
  const done = () => {
    void utils.teacher.syllabus.list.invalidate();
    onOpenChange(false);
  };
  const remove = trpc.teacher.syllabus.remove.useMutation({
    onSuccess: () => {
      toast.success(t("syllabus.delete.done", { title: s?.title ?? "" }));
      done();
      onDeleted?.();
    },
    onError: (e) => {
      toastError(e);
      void utils.teacher.syllabus.list.invalidate();
    },
  });
  const archive = trpc.teacher.syllabus.setArchived.useMutation({
    onSuccess: () => {
      toast.success(t("syllabus.archived.done", { title: s?.title ?? "" }));
      if (syllabusId) void utils.teacher.syllabus.get.invalidate({ id: syllabusId });
      done();
    },
    onError: toastError,
  });
  const blocked = !!s && s.enrolledCount > 0;
  const busy = remove.isPending || archive.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("syllabus.delete.title")}</DialogTitle>
          {s && !blocked && <DialogDescription>{t("syllabus.delete.body", { title: s.title, modules: s.moduleCount, lessons: s.lessonCount })}</DialogDescription>}
        </DialogHeader>
        <DialogBody className="grid content-start gap-3">
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <ErrorNote error={list.error} />
          ) : !s ? null : blocked ? (
            <p role="alert" className="flex gap-2 rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <span>{t("syllabus.delete.blocked", { count: s.enrolledCount })}</span>
            </p>
          ) : (
            <>
              {s.currentVersionId && <p className="rounded-xl border border-border bg-muted p-3 text-sm">{t("syllabus.delete.published")}</p>}
              {s.liveGrantCount > 0 && <p className="rounded-xl border border-border bg-muted p-3 text-sm">{t("syllabus.delete.grants", { count: s.liveGrantCount })}</p>}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          {blocked ? (
            !s.archivedAt && (
              <Button disabled={busy} onClick={() => archive.mutate({ id: s.id, archived: true })}>
                {t("syllabus.delete.archiveInstead")}
              </Button>
            )
          ) : (
            <Button variant="destructive" disabled={!s || busy} onClick={() => s && remove.mutate({ id: s.id })}>
              {remove.isPending ? t("syllabus.delete.deleting") : t("syllabus.delete.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
