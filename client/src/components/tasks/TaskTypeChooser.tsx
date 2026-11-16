import { Pill } from "@/components/AppShell";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n/messages";
import { Code2, FileText, ListChecks, Share2 } from "lucide-react";

export type TaskType = "ADI" | "QUIZ" | "CODE" | "MATERIAL";

/**
 * Shown the moment a teacher clicks "+ Yeni tapşırıq", one step before the real form opens
 * (before even TaskCreateChooser's AI/manual pick). Picks the kind of thing being assigned, so
 * the teacher gets guided straight to the one creation path they actually need instead of a
 * single form bundling all of Quiz, SQL Lab, and plain-task fields together (the old experience,
 * which still runs underneath: ADI goes through the existing AI/manual chooser into
 * AssignmentFormDialog unchanged; QUIZ/CODE open that same form pre-set to the matching
 * section; MATERIAL opens the existing, separate materials form). No new backend concept is
 * introduced here -- a task stays a task row in the DB either way.
 */
export function TaskTypeChooser({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (v: boolean) => void; onPick: (type: TaskType) => void }) {
  const options: Array<{ type: TaskType; icon: typeof FileText; label: string; hint: string; badge?: string }> = [
    { type: "ADI", icon: FileText, label: t("modules.typeChooserAdiOption"), hint: t("modules.typeChooserAdiHint") },
    { type: "QUIZ", icon: ListChecks, label: t("modules.typeChooserQuizOption"), hint: t("modules.typeChooserQuizHint") },
    { type: "CODE", icon: Code2, label: t("modules.typeChooserCodeOption"), hint: t("modules.typeChooserCodeHint"), badge: t("modules.typeChooserCodeBadge") },
    { type: "MATERIAL", icon: Share2, label: t("modules.typeChooserMaterialOption"), hint: t("modules.typeChooserMaterialHint") },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t("modules.typeChooserTitle")}</DialogTitle></DialogHeader>
        <DialogBody className="grid gap-3 sm:grid-cols-2">
          {options.map((o) => (
            <button
              key={o.type}
              type="button"
              className="flex min-h-[9.5rem] flex-col items-start gap-2 rounded-lg border border-border p-4 text-left text-sm transition-colors hover:border-link hover:bg-muted"
              onClick={() => onPick(o.type)}
            >
              <o.icon className="h-5 w-5 text-link" aria-hidden />
              <span className="font-medium">{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.hint}</span>
              {o.badge && <Pill className="mt-auto">{o.badge}</Pill>}
            </button>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
