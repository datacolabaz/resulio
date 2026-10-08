import { AssessmentBody, Bullets } from "@/components/syllabus/ModuleDetailsBlocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t, type MessageKey } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { hasAssessmentDetails, MODULE_DETAILS_MAX_LINE, type ModuleDetails } from "@shared/syllabusModuleDetails";
import { Check, ChevronDown, ChevronUp, Pencil, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { applyDraft, draftOf, insertAfter, isDirty, moveItem, removeAt, setItem, validateDraft, type BlockDraft, type BlockKey, type BlockProblem } from "./moduleBlocks";
import { fieldLabel, toastError, useSyllabusRefresh } from "./shared";

const BLOCKS: Array<{ key: BlockKey; emoji: string; title: MessageKey; empty: MessageKey }> = [
  { key: "objectives", emoji: "🎯", title: "moduleDetails.objectives", empty: "moduleDetails.emptyObjectives" },
  { key: "prerequisites", emoji: "📋", title: "moduleDetails.prerequisites", empty: "moduleDetails.emptyPrerequisites" },
  { key: "assessment", emoji: "📝", title: "moduleDetails.assessment", empty: "moduleDetails.emptyAssessment" },
];

const filled = (details: ModuleDetails, block: BlockKey) => (block === "assessment" ? hasAssessmentDetails(details.assessment) : details[block].length > 0);

/** One input per item: Enter adds the next item, Backspace on an empty item removes it. */
export function ListEditor({ items, onChange, label }: { items: string[]; onChange: (items: string[]) => void; label: string }) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const [focus, setFocus] = useState<number | null>(null);
  useEffect(() => {
    if (focus === null) return;
    refs.current[focus]?.focus();
    setFocus(null);
  }, [focus, items]);
  const apply = (r: { items: string[]; focus: number }) => {
    onChange(r.items);
    setFocus(r.focus);
  };
  const iconBtn = "rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";
  return (
    <div role="group" aria-label={label} className="space-y-2">
      <ol className="space-y-2">
        {items.map((value, i) => (
          <li key={i} className="flex items-center gap-1">
            <span aria-hidden className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
            <Input
              ref={(el) => {
                refs.current[i] = el;
              }}
              value={value}
              maxLength={MODULE_DETAILS_MAX_LINE}
              placeholder={i === items.length - 1 ? t("moduleDetails.itemPlaceholder") : undefined}
              aria-label={t("moduleDetails.itemLabel", { label, n: i + 1 })}
              onChange={(e) => onChange(setItem(items, i, e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  apply(insertAfter(items, i));
                } else if (e.key === "Backspace" && value === "" && items.length > 1) {
                  e.preventDefault();
                  apply(removeAt(items, i));
                }
              }}
            />
            <button type="button" className={iconBtn} disabled={i === 0} onClick={() => onChange(moveItem(items, i, -1))} aria-label={t("moduleDetails.moveUp", { n: i + 1 })}>
              <ChevronUp className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={iconBtn} disabled={i === items.length - 1} onClick={() => onChange(moveItem(items, i, 1))} aria-label={t("moduleDetails.moveDown", { n: i + 1 })}>
              <ChevronDown className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={`${iconBtn} hover:text-destructive`} onClick={() => apply(removeAt(items, i))} aria-label={t("moduleDetails.removeItem", { n: i + 1 })}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          </li>
        ))}
      </ol>
      <Button type="button" size="sm" variant="ghost" onClick={() => apply({ items: [...items, ""], focus: items.length })}>
        <Plus className="mr-1 h-4 w-4" aria-hidden />
        {t("moduleDetails.addItem")}
      </Button>
    </div>
  );
}

function problemText(p: BlockProblem) {
  return p.code === "tooMany" ? t("moduleDetails.tooMany", { max: p.max }) : t("moduleDetails.tooLong", { n: p.n, max: p.max });
}

function AssessmentFields({ draft, onChange }: { draft: BlockDraft; onChange: (d: BlockDraft) => void }) {
  const id = useId();
  const text = (k: "heading" | "intro" | "pipeline" | "listIntro", label: string, placeholder?: string) => (
    <label className="block text-sm" htmlFor={`${id}-${k}`}>
      <span className={fieldLabel}>{label}</span>
      <Input id={`${id}-${k}`} maxLength={MODULE_DETAILS_MAX_LINE} value={draft[k]} placeholder={placeholder} onChange={(e) => onChange({ ...draft, [k]: e.target.value })} />
    </label>
  );
  return (
    <div className="space-y-3">
      {text("intro", t("moduleDetails.intro"))}
      <div className="text-sm">
        <span className={fieldLabel}>{t("moduleDetails.items")}</span>
        <ListEditor items={draft.items} onChange={(items) => onChange({ ...draft, items })} label={t("moduleDetails.items")} />
      </div>
      <details className="rounded-lg border border-border bg-card p-2" open={!!(draft.heading || draft.pipeline || draft.listIntro)}>
        <summary className="cursor-pointer text-sm text-foreground-secondary">{t("moduleDetails.more")}</summary>
        <div className="mt-2 space-y-3">
          {text("heading", t("moduleDetails.heading"))}
          {text("pipeline", t("moduleDetails.pipeline"), t("moduleDetails.pipelinePlaceholder"))}
          {text("listIntro", t("moduleDetails.listIntro"))}
        </div>
      </details>
    </div>
  );
}

export interface ModuleBlocksViewProps {
  moduleTitle: string;
  details: ModuleDetails;
  editing: BlockKey | null;
  draft: BlockDraft | null;
  saving: boolean;
  savedBlock: BlockKey | null;
  problem: BlockProblem | null;
  onEdit: (block: BlockKey) => void;
  onDraft: (draft: BlockDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}

/** The three end-of-module blocks on the builder's module card, as students see them, each editable in place. */
export function ModuleBlocksView(p: ModuleBlocksViewProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-xl border border-border p-3">
      <div>
        <h4 id={headingId} className="text-sm font-medium">{t("moduleDetails.builderTitle")}</h4>
        <p className="text-xs text-muted-foreground">{t("moduleDetails.builderHint")}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {BLOCKS.map((b) => {
          const isEditing = p.editing === b.key && p.draft;
          const has = filled(p.details, b.key);
          const title = t(b.title);
          return (
            <div key={b.key} className={`min-w-0 rounded-xl border border-border bg-muted/40 p-3 ${b.key === "assessment" || isEditing ? "md:col-span-2" : ""}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h5 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-foreground">
                  <span aria-hidden className="text-base leading-none">{b.emoji}</span>
                  {title}
                </h5>
                {p.savedBlock === b.key && !isEditing && (
                  <span role="status" className="inline-flex items-center gap-1 text-xs text-success">
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    {t("moduleDetails.saved")}
                  </span>
                )}
                {has && !isEditing && (
                  <Button type="button" size="sm" variant="ghost" disabled={!!p.editing} onClick={() => p.onEdit(b.key)} aria-label={t("moduleDetails.editBlock", { block: title, title: p.moduleTitle })}>
                    <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />
                    {t("moduleDetails.edit")}
                  </Button>
                )}
              </div>
              {isEditing && p.draft ? (
                <div
                  className="space-y-3"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") p.onCancel();
                  }}
                >
                  {b.key === "assessment" ? <AssessmentFields draft={p.draft} onChange={p.onDraft} /> : <ListEditor items={p.draft.items} onChange={(items) => p.onDraft({ ...p.draft!, items })} label={title} />}
                  {p.problem && <p role="alert" className="text-sm text-destructive">{problemText(p.problem)}</p>}
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {isDirty(p.details, b.key, p.draft) && <span className="mr-auto text-sm text-warning">{t("syllabus.unsaved")}</span>}
                    <Button type="button" size="sm" variant="outline" onClick={p.onCancel}>{t("common.cancel")}</Button>
                    <Button type="button" size="sm" disabled={p.saving || !isDirty(p.details, b.key, p.draft)} onClick={p.onSave}>
                      {p.saving ? t("syllabus.saving") : t("common.save")}
                    </Button>
                  </div>
                </div>
              ) : has ? (
                b.key === "assessment" ? <AssessmentBody a={p.details.assessment} /> : <Bullets items={p.details[b.key]} />
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="flex-1 text-sm text-foreground-secondary">{t(b.empty)}</p>
                  <Button type="button" size="sm" variant="outline" disabled={!!p.editing} onClick={() => p.onEdit(b.key)} aria-label={t("moduleDetails.addBlock", { block: title, title: p.moduleTitle })}>
                    <Plus className="mr-1 h-4 w-4" aria-hidden />
                    {t("moduleDetails.add")}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ModuleBlocksEditor({ syllabusId, moduleId, title, details }: { syllabusId: string; moduleId: string; title: string; details: ModuleDetails }) {
  const refresh = useSyllabusRefresh(syllabusId);
  const [editing, setEditing] = useState<BlockKey | null>(null);
  const [draft, setDraft] = useState<BlockDraft | null>(null);
  const [problem, setProblem] = useState<BlockProblem | null>(null);
  const [savedBlock, setSavedBlock] = useState<BlockKey | null>(null);
  useEffect(() => {
    if (!savedBlock) return;
    const timer = setTimeout(() => setSavedBlock(null), 5000);
    return () => clearTimeout(timer);
  }, [savedBlock]);
  const close = () => {
    setEditing(null);
    setDraft(null);
    setProblem(null);
  };
  const save = trpc.teacher.syllabus.updateModuleDetails.useMutation({
    onSuccess: () => {
      refresh();
      setSavedBlock(editing);
      close();
    },
    onError: toastError,
  });
  return (
    <ModuleBlocksView
      moduleTitle={title}
      details={details}
      editing={editing}
      draft={draft}
      saving={save.isPending}
      savedBlock={savedBlock}
      problem={problem}
      onEdit={(block) => {
        setEditing(block);
        setDraft(draftOf(details, block));
        setProblem(null);
        setSavedBlock(null);
      }}
      onDraft={(d) => {
        setDraft(d);
        setProblem(null);
      }}
      onCancel={close}
      onSave={() => {
        if (!editing || !draft) return;
        const found = validateDraft(draft);
        if (found) return setProblem(found);
        save.mutate({ moduleId, details: applyDraft(details, editing, draft) });
      }}
    />
  );
}
