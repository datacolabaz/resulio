import { EmptyState, ErrorNote, Loading } from "@/components/AppShell";
import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { TeacherWorkflowOverview } from "@/components/syllabus/Workflow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getLocale, t } from "@/i18n/messages";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fileDownloadUrl } from "@/lib/uploadFile";
import { Archive, ArchiveRestore, BookOpen, EllipsisVertical, EyeOff, FileUp, Link2, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { CardStats } from "./CardStudents";
import { DeleteSyllabusDialog } from "./DeleteSyllabusDialog";
import { ImportDialog, importFailureText, importPath } from "./ImportDialog";
import { NewRequestsBadge, PendingRequestsInbox, useCopyShareLink, usePendingJoinRequests } from "./ShareAndRequests";
import { emptySyllabusFields, fieldsPayload, SyllabusFieldsForm } from "./SyllabusFields";
import { SyllabusShell, SyllabusVisibilityBadges, toastError } from "./shared";

type SyllabusRow = RouterOutputs["teacher"]["syllabus"]["list"][number];

function CardMenu({ s, onDelete }: { s: SyllabusRow; onDelete: () => void }) {
  const utils = trpc.useUtils();
  const shareLink = useCopyShareLink();
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
        <DropdownMenuItem disabled={shareLink.pending} onSelect={() => void shareLink.copy(s)}>
          <Link2 aria-hidden />
          {t("common.copyLink")}
        </DropdownMenuItem>
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

const HIDDEN_IMPORTS_KEY = "resulio.syllabus.hiddenImports";
const readHiddenImports = (): string[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HIDDEN_IMPORTS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(-50) : [];
  } catch {
    return [];
  }
};

const IMPORT_TONE: Record<string, Tone> = { FAILED: "danger", READY: "success", QUEUED: "neutral", PROCESSING: "info" };

/**
 * AI imports not turned into a syllabus yet: running, waiting for review or failed (with the reason,
 * "try again" and "delete"). "Hide" puts the listed ones away on this device; a new import shows the card again.
 */
function OpenImports() {
  const utils = trpc.useUtils();
  const open = trpc.teacher.syllabus.aiImport.open.useQuery(undefined, {
    retry: false,
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "QUEUED" || j.status === "PROCESSING") ? 4000 : false),
  });
  const [hidden, setHidden] = useState(readHiddenImports);
  const refresh = () => void utils.teacher.syllabus.aiImport.open.invalidate();
  const retry = trpc.teacher.syllabus.aiImport.retry.useMutation({ onSuccess: refresh, onError: toastError });
  const remove = trpc.teacher.syllabus.aiImport.remove.useMutation({ onSuccess: refresh, onError: toastError });
  const jobs = (open.data ?? []).filter((j) => !hidden.includes(j.id));
  if (!jobs.length) return null;
  const hideAll = () => {
    const next = [...new Set([...hidden, ...jobs.map((j) => j.id)])].slice(-50);
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_IMPORTS_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable (private mode): hidden for this visit only.
    }
  };
  return (
    <section className="rounded-2xl border border-border bg-card p-3" aria-labelledby="open-imports-title">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 id="open-imports-title" className="text-sm font-semibold">{t("simport.openTitle")}</h2>
        <Button size="sm" variant="ghost" onClick={hideAll}>
          <EyeOff className="mr-1 h-3.5 w-3.5" aria-hidden />
          {t("simport.hideList")}
        </Button>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{t("simport.openHelp")}</p>
      <ul className="divide-y divide-border">
        {jobs.map((j) => {
          const failed = j.status === "FAILED";
          const name = j.title ?? j.fileName ?? t("simport.pastedText");
          return (
            <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={importPath(j.id)} className="min-w-0 break-words font-medium text-link hover:underline">{name}</Link>
                  <StatusBadge tone={IMPORT_TONE[j.status] ?? "neutral"}>{t(`simport.status.${j.status}`)}</StatusBadge>
                </div>
                {failed && <p className="mt-0.5 text-xs text-foreground-secondary">{importFailureText(j.errorCode)}</p>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {j.status === "READY" && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={importPath(j.id)}>{t("simport.review")}</Link>
                  </Button>
                )}
                {failed && (
                  <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate({ id: j.id })}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
                    {t("simport.retry")}
                  </Button>
                )}
                {(failed || j.status === "READY") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={remove.isPending}
                    onClick={() => confirm(t("simport.removeConfirm")) && remove.mutate({ id: j.id })}
                    aria-label={t("simport.removeNamed", { name })}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                    {t("common.delete")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ImportButton({ onClick, variant = "outline" }: { onClick: () => void; variant?: "outline" | "default" }) {
  return (
    <Button variant={variant} onClick={onClick}>
      <FileUp className="mr-1 h-4 w-4" aria-hidden />
      {t("simport.button")}
    </Button>
  );
}

function SyllabusListBody() {
  const list = trpc.teacher.syllabus.list.useQuery();
  const openRequests = usePendingJoinRequests();
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
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
          <ImportButton onClick={() => setImporting(true)} />
        </div>
      </div>
      <PendingRequestsInbox />
      <OpenImports />
      {rows.length === 0 ? (
        <>
          <EmptyState
            title={t("syllabus.empty.title")}
            body={t("syllabus.empty.body")}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <SampleButton variant="default" />
                <Button variant="outline" onClick={() => setOpen(true)}>{t("syllabus.new")}</Button>
                <ImportButton onClick={() => setImporting(true)} />
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
              <li key={s.id} className="relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition-colors hover:border-link">
                <Link href={`/teacher/syllabus/${s.id}`} className="flex flex-1 flex-col rounded-2xl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-link">
                  {s.coverFileId ? (
                    <img src={fileDownloadUrl(s.coverFileId)} alt="" className="h-32 w-full object-cover" />
                  ) : (
                    <div className="flex h-32 items-center justify-center bg-muted text-muted-foreground"><BookOpen className="h-8 w-8" aria-hidden /></div>
                  )}
                  <div className="flex flex-1 flex-col gap-2 p-4 pb-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <SyllabusVisibilityBadges syllabus={s} activeGrants={s.liveGrantCount} />
                    </div>
                    <div className="break-words font-semibold">{s.title}</div>
                    {(s.subject || s.level) && <div className="text-sm text-muted-foreground">{[s.subject, s.level].filter(Boolean).join(" · ")}</div>}
                  </div>
                </Link>
                <CardStats s={s} />
                <NewRequestsBadge syllabusId={s.id} count={openRequests(s.id)} className="absolute left-2 top-2" />
                <CardMenu s={s} onDelete={() => setDeleting(s.id)} />
              </li>
            ))}
          </ul>
        </>
      )}
      <CreateDialog open={open} onOpenChange={setOpen} />
      <ImportDialog open={importing} onOpenChange={setImporting} />
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
