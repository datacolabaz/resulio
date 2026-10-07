import { EmptyState, ErrorNote, Loading, Pill } from "@/components/AppShell";
import { TeacherWorkflowOverview } from "@/components/syllabus/Workflow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getLocale, t } from "@/i18n/messages";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fileDownloadUrl } from "@/lib/uploadFile";
import { Archive, ArchiveRestore, BookOpen, EllipsisVertical, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { DeleteSyllabusDialog } from "./DeleteSyllabusDialog";
import { emptySyllabusFields, fieldsPayload, SyllabusFieldsForm } from "./SyllabusFields";
import { SyllabusShell, SyllabusStatusBadge, toastError } from "./shared";

type SyllabusRow = RouterOutputs["teacher"]["syllabus"]["list"][number];

function CardMenu({ s, onDelete }: { s: SyllabusRow; onDelete: () => void }) {
  const utils = trpc.useUtils();
  const archived = !!s.archivedAt;
  const archive = trpc.teacher.syllabus.setArchived.useMutation({
    onSuccess: () => {
      toast.success(t(archived ? "syllabus.restored.done" : "syllabus.archived.done", { title: s.title }));
      void utils.teacher.syllabus.list.invalidate();
      void utils.teacher.syllabus.get.invalidate({ id: s.id });
    },
    onError: toastError,
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="outline"
          className="absolute right-2 top-2 h-8 w-8 bg-card/90 backdrop-blur"
          aria-label={t("syllabus.card.actions", { title: s.title })}
        >
          <EllipsisVertical className="h-4 w-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={archive.isPending}
          onSelect={() => (archived || confirm(t("syllabus.settings.archiveConfirm"))) && archive.mutate({ id: s.id, archived: !archived })}
        >
          {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
          {archived ? t("syllabus.settings.unarchive") : t("syllabus.settings.archive")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 aria-hidden />
          {t("syllabus.delete.action")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [, nav] = useLocation();
  const utils = trpc.useUtils();
  const [f, setF] = useState(emptySyllabusFields);
  const create = trpc.teacher.syllabus.create.useMutation({
    onSuccess: (row) => {
      void utils.teacher.syllabus.list.invalidate();
      onOpenChange(false);
      setF(emptySyllabusFields);
      nav(`/teacher/syllabus/${row.id}`);
    },
    onError: toastError,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t("syllabus.new")}</DialogTitle></DialogHeader>
        <DialogBody>
          <SyllabusFieldsForm idPrefix="new-syllabus" value={f} onChange={setF} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={!f.title.trim() || create.isPending} onClick={() => create.mutate(fieldsPayload(f))}>{t("syllabus.create")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SampleButton({ variant = "outline" }: { variant?: "outline" | "default" }) {
  const [, nav] = useLocation();
  const utils = trpc.useUtils();
  const sample = trpc.teacher.syllabus.createSample.useMutation({
    onSuccess: (row) => {
      void utils.teacher.syllabus.list.invalidate();
      nav(`/teacher/syllabus/${row.id}`);
    },
    onError: toastError,
  });
  return (
    <Button variant={variant} disabled={sample.isPending} onClick={() => sample.mutate({ locale: getLocale() })}>
      <Sparkles className="mr-1 h-4 w-4" aria-hidden />
      {sample.isPending ? t("syllabus.sample.creating") : t("syllabus.sample.create")}
    </Button>
  );
}

function SyllabusListBody() {
  const list = trpc.teacher.syllabus.list.useQuery();
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  if (list.isLoading) return <Loading />;
  if (list.error?.message === "SYLLABUS_DB_NOT_READY") return <EmptyState title={t("syllabus.dbNotReady.title")} body={t("error.SYLLABUS_DB_NOT_READY")} />;
  if (list.error) return <ErrorNote error={list.error} />;
  const rows = list.data ?? [];
  const archivedCount = rows.filter((r) => r.archivedAt).length;
  const visible = rows.filter((r) => showArchived || !r.archivedAt);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{t("syllabus.intro")}</p>
        <div className="flex flex-wrap gap-2">
          {rows.length > 0 && <SampleButton />}
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            {t("syllabus.new")}
          </Button>
        </div>
      </div>
      {rows.length === 0 ? (
        <>
          <EmptyState
            title={t("syllabus.empty.title")}
            body={t("syllabus.empty.body")}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <SampleButton variant="default" />
                <Button variant="outline" onClick={() => setOpen(true)}>{t("syllabus.new")}</Button>
              </div>
            }
          />
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{t("ux.teacherSteps.title")}</h2>
            <TeacherWorkflowOverview />
          </section>
        </>
      ) : (
        <>
          {archivedCount > 0 && (
            <label className="flex items-center gap-2 text-sm text-foreground-secondary">
              <input type="checkbox" className="accent-link" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              {t("syllabus.showArchived", { count: archivedCount })}
            </label>
          )}
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((s) => (
              <li key={s.id} className="relative">
                <Link
                  href={`/teacher/syllabus/${s.id}`}
                  className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card transition-colors hover:border-link focus-visible:outline-2 focus-visible:outline-link"
                >
                  {s.coverFileId ? (
                    <img src={fileDownloadUrl(s.coverFileId)} alt="" className="h-32 w-full object-cover" />
                  ) : (
                    <div className="flex h-32 items-center justify-center bg-muted text-muted-foreground"><BookOpen className="h-8 w-8" aria-hidden /></div>
                  )}
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <SyllabusStatusBadge status={s.status} />
                      {s.currentVersionLabel && <Pill>{s.currentVersionLabel}</Pill>}
                      {s.currentVersionId && s.hasDraftChanges && !s.archivedAt && <Pill>{t("syllabus.draftChanges")}</Pill>}
                    </div>
                    <div className="break-words font-semibold">{s.title}</div>
                    {(s.subject || s.level) && <div className="text-sm text-muted-foreground">{[s.subject, s.level].filter(Boolean).join(" · ")}</div>}
                    <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-2 text-xs text-foreground-secondary">
                      <span>{t("syllabus.count.modules", { count: s.moduleCount })}</span>
                      <span>{t("syllabus.count.lessons", { count: s.lessonCount })}</span>
                      <span>{t("syllabus.count.grants", { count: s.activeGrantCount })}</span>
                      <span>{t("syllabus.count.enrolled", { count: s.enrolledCount })}</span>
                      {s.enrolledCount > 0 && <span>{t("syllabus.count.avgProgress", { pct: s.averageProgressPct })}</span>}
                    </div>
                  </div>
                </Link>
                <CardMenu s={s} onDelete={() => setDeleting(s.id)} />
              </li>
            ))}
          </ul>
        </>
      )}
      <CreateDialog open={open} onOpenChange={setOpen} />
      <DeleteSyllabusDialog syllabusId={deleting} open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)} />
    </div>
  );
}

export function SyllabusListPage() {
  return (
    <SyllabusShell>
      <SyllabusListBody />
    </SyllabusShell>
  );
}
