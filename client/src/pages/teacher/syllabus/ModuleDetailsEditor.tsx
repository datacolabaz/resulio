import { ModuleDetailsBlocks } from "@/components/syllabus/ModuleDetailsBlocks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { hasModuleDetails, MODULE_DETAILS_MAX_LINE, MODULE_DETAILS_MAX_LINES, type ModuleDetails } from "@shared/syllabusModuleDetails";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { fieldLabel, linesToList, toastError, useSyllabusRefresh } from "./shared";

const toLines = (text: string) => linesToList(text, MODULE_DETAILS_MAX_LINES).map((l) => l.slice(0, MODULE_DETAILS_MAX_LINE));

function formOf(d: ModuleDetails) {
  return {
    objectives: d.objectives.join("\n"),
    prerequisites: d.prerequisites.join("\n"),
    heading: d.assessment.heading,
    intro: d.assessment.intro,
    pipeline: d.assessment.pipeline,
    listIntro: d.assessment.listIntro,
    items: d.assessment.items.join("\n"),
  };
}

function detailsOf(f: ReturnType<typeof formOf>): ModuleDetails {
  return {
    objectives: toLines(f.objectives),
    prerequisites: toLines(f.prerequisites),
    assessment: { heading: f.heading.trim(), intro: f.intro.trim(), pipeline: f.pipeline.trim(), listIntro: f.listIntro.trim(), items: toLines(f.items) },
  };
}

function ModuleDetailsDialog({ syllabusId, moduleId, title, details, open, onOpenChange }: { syllabusId: string; moduleId: string; title: string; details: ModuleDetails; open: boolean; onOpenChange: (v: boolean) => void }) {
  const refresh = useSyllabusRefresh(syllabusId);
  const [f, setF] = useState(() => formOf(details));
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setF(formOf(details));
  }
  const save = trpc.teacher.syllabus.updateModuleDetails.useMutation({
    onSuccess: () => {
      refresh();
      onOpenChange(false);
    },
    onError: toastError,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const lines = (k: "objectives" | "prerequisites" | "items", label: string, emoji?: string) => (
    <label className="text-sm">
      <span className={fieldLabel}>
        {emoji && <span aria-hidden className="mr-1">{emoji}</span>}
        {label}
      </span>
      <Textarea rows={4} value={f[k]} onChange={set(k)} placeholder={t("moduleDetails.linesHint")} />
    </label>
  );
  const line = (k: "heading" | "intro" | "pipeline" | "listIntro", label: string, placeholder?: string) => (
    <label className="text-sm">
      <span className={fieldLabel}>{label}</span>
      <Input maxLength={MODULE_DETAILS_MAX_LINE} value={f[k]} onChange={set(k)} placeholder={placeholder} />
    </label>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t("moduleDetails.editNamed", { title })}</DialogTitle></DialogHeader>
        <DialogBody className="grid content-start gap-3">
          <p className="text-sm text-muted-foreground">{t("moduleDetails.builderHint")}</p>
          {lines("objectives", t("moduleDetails.objectives"), "🎯")}
          {lines("prerequisites", t("moduleDetails.prerequisites"), "📋")}
          <fieldset className="grid gap-3 rounded-xl border border-border p-3">
            <legend className="px-1 text-sm font-medium">
              <span aria-hidden className="mr-1">📝</span>
              {t("moduleDetails.assessment")}
            </legend>
            {line("heading", t("moduleDetails.heading"))}
            {line("intro", t("moduleDetails.intro"))}
            {line("pipeline", t("moduleDetails.pipeline"), t("moduleDetails.pipelinePlaceholder"))}
            {line("listIntro", t("moduleDetails.listIntro"))}
            {lines("items", t("moduleDetails.items"))}
          </fieldset>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate({ moduleId, details: detailsOf(f) })}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Builder: the module's end-of-module blocks as students will see them, with an editor. */
export function ModuleDetailsPanel({ syllabusId, moduleId, title, details }: { syllabusId: string; moduleId: string; title: string; details: ModuleDetails }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl bg-muted/50 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t("moduleDetails.builderTitle")}</h4>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={t("moduleDetails.editNamed", { title })}>
          <Pencil className="mr-1 h-4 w-4" aria-hidden />
          {t("moduleDetails.edit")}
        </Button>
      </div>
      {hasModuleDetails(details) ? <ModuleDetailsBlocks details={details} as="h4" /> : <p className="text-xs text-muted-foreground">{t("moduleDetails.empty")}</p>}
      <ModuleDetailsDialog syllabusId={syllabusId} moduleId={moduleId} title={title} details={details} open={open} onOpenChange={setOpen} />
    </div>
  );
}
