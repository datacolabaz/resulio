import { Pill } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import type { SyllabusItemKind } from "@shared/syllabus";
import { ChevronDown, ChevronRight, MonitorPlay, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { contentFromDraft, draftFromContent, DraftFields, type ItemDraft } from "./ItemEditors";
import { fieldLabel, KIND_ICON, kindLabel, toastError, useMaterials, useSyllabusRefresh } from "./shared";

export interface DraftItemRow {
  id: string;
  kind: SyllabusItemKind;
  title: string;
  required: boolean;
  content: Record<string, unknown>;
  assessmentId: string | null;
  taskId: string | null;
  updatedAt: Date | string;
}

/** One item with its editor: collapsed summary row, expanded form with its own Save. */
export function ItemCard({
  syllabusId,
  item,
  handle,
  defaultOpen = false,
}: {
  syllabusId: string;
  item: DraftItemRow;
  handle?: ReactNode;
  defaultOpen?: boolean;
}) {
  const refresh = useSyllabusRefresh(syllabusId);
  const materials = useMaterials();
  const [open, setOpen] = useState(defaultOpen);
  const [title, setTitle] = useState(item.title);
  const [required, setRequired] = useState(item.required);
  const [assessmentId, setAssessmentId] = useState(item.assessmentId);
  const [draft, setDraft] = useState<ItemDraft>(() => draftFromContent(item.kind, item.content));
  const [dirty, setDirty] = useState(false);
  const stamp = String(item.updatedAt);
  useEffect(() => {
    if (dirty) return;
    setTitle(item.title);
    setRequired(item.required);
    setAssessmentId(item.assessmentId);
    setDraft(draftFromContent(item.kind, item.content));
  }, [stamp]);

  const update = trpc.teacher.syllabus.updateItem.useMutation({
    onSuccess: () => {
      setDirty(false);
      refresh();
      toast.success(t("syllabus.saved"));
    },
    onError: toastError,
  });
  const remove = trpc.teacher.syllabus.deleteItem.useMutation({ onSuccess: refresh, onError: toastError });
  const touch = () => setDirty(true);
  const save = () => {
    const result = contentFromDraft(draft);
    if ("error" in result) {
      toast.error(t(result.error));
      return;
    }
    update.mutate({
      itemId: item.id,
      patch: { title: title.trim() || kindLabel(item.kind), required, content: result.content, ...(item.kind === "ASSESSMENT" ? { assessmentId } : {}) },
    });
  };
  const Icon = KIND_ICON[item.kind];

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 p-2.5">
        {handle}
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
          {!item.required && <Pill>{t("syllabus.optional")}</Pill>}
          {item.kind === "ASSESSMENT" && !item.assessmentId && <Pill className="text-warning">{t("syllabus.as.missing")}</Pill>}
          {dirty && <Pill className="text-warning">{t("syllabus.unsaved")}</Pill>}
        </button>
        {item.kind === "TEACHER_PRACTICE" && (
          <Link href={`/teacher/syllabus/${syllabusId}/present/${item.id}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-link hover:bg-muted">
            <MonitorPlay className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">{t("syllabus.present.open")}</span>
          </Link>
        )}
        <button
          type="button"
          className="rounded p-1 text-destructive hover:bg-danger-surface"
          onClick={() => confirm(t("syllabus.item.deleteConfirm", { title: item.title })) && remove.mutate({ itemId: item.id })}
          aria-label={t("syllabus.item.delete", { title: item.title })}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {open && (
        <div className="space-y-4 border-t border-border p-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="text-sm">
              <span className={fieldLabel}>{t("syllabus.item.title")}</span>
              <Input maxLength={255} value={title} onChange={(e) => { setTitle(e.target.value); touch(); }} />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" className="accent-link" checked={required} onChange={(e) => { setRequired(e.target.checked); touch(); }} />
              {t("syllabus.item.required")}
            </label>
          </div>
          <DraftFields
            id={`item-${item.id}`}
            draft={draft}
            onChange={(d) => { setDraft(d); touch(); }}
            taskId={item.taskId}
            title={title}
            assessmentId={assessmentId}
            onAssessment={(v) => { setAssessmentId(v); touch(); }}
            materials={materials.list}
          />
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
            {dirty && (
              <Button
                variant="outline"
                onClick={() => {
                  setDirty(false);
                  setTitle(item.title);
                  setRequired(item.required);
                  setAssessmentId(item.assessmentId);
                  setDraft(draftFromContent(item.kind, item.content));
                }}
              >
                {t("syllabus.discard")}
              </Button>
            )}
            <Button disabled={!dirty || update.isPending} onClick={save}>{update.isPending ? t("syllabus.saving") : t("common.save")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Add …" for one kind at one placement; the new item opens for editing. */
export function useCreateItem(syllabusId: string, onCreated?: (id: string) => void) {
  const refresh = useSyllabusRefresh(syllabusId);
  return trpc.teacher.syllabus.createItem.useMutation({
    onSuccess: (row) => {
      refresh();
      onCreated?.(row.id);
    },
    onError: toastError,
  });
}
