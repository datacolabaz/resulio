import { CompactGroupStudentPicker, useGroupStudentTargets } from "@/components/GroupStudentPicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { recipientsPayload } from "@/lib/groupStudentSelection";
import { trpc } from "@/lib/trpc";
import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * "AI konspekt": drafts a study note from one bank section's own questions, lets the teacher edit
 * it, then saves it as a material for the groups/students they pick -- the same recipient picker
 * every other material uses. The AI output is never sent to students unreviewed -- draft and
 * publish are two separate steps the teacher triggers themselves.
 */
export function SectionSummaryButton({ sectionId, sectionName, questionCount }: { sectionId: string; sectionName: string; questionCount: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" disabled={questionCount === 0} title={questionCount === 0 ? t("qbank.summary.needsQuestions") : undefined} onClick={() => setOpen(true)}>
        <Sparkles className="h-4 w-4" aria-hidden /> {t("qbank.summary.button")}
      </Button>
      {open && <SummaryDialog sectionId={sectionId} sectionName={sectionName} onClose={() => setOpen(false)} />}
    </>
  );
}

export function SummaryDialog({ sectionId, sectionName, onClose }: { sectionId: string; sectionName: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const targets = useGroupStudentTargets(undefined);
  const draft = trpc.teacher.questionSummary.draft.useMutation({
    onSuccess: (r) => setText(r.text),
    onError: (e) => {
      toast.error(errorText(e));
      onClose();
    },
  });
  const publish = trpc.teacher.questionSummary.publish.useMutation({
    onSuccess: () => {
      toast.success(t("qbank.summary.published"));
      onClose();
    },
    onError: (e) => toast.error(errorText(e)),
  });

  // Drafted once, on open; re-fetching happens only via the explicit "yenidən yarat" button.
  useEffect(() => {
    draft.mutate({ sectionId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId]);

  const recipients = recipientsPayload(targets.selection, targets.students, { kept: targets.kept });
  const hasRecipients = recipients.groupIds.length > 0 || recipients.studentIds.length > 0;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("qbank.summary.title", { name: sectionName })}</DialogTitle>
          <DialogDescription>{t("qbank.summary.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          {draft.isPending ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("qbank.summary.generating")}
            </div>
          ) : draft.isError ? null : (
            <>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} className="font-mono text-sm" aria-label={t("qbank.summary.title", { name: sectionName })} />
              <Button size="sm" variant="ghost" className="w-fit" disabled={draft.isPending} onClick={() => draft.mutate({ sectionId })}>
                <Sparkles className="h-4 w-4" aria-hidden /> {t("qbank.summary.regenerate")}
              </Button>
              {targets.ready && (
                <section className="grid gap-2 border-t pt-3">
                  <h3 className="text-sm font-semibold">{t("modules.materialSharing")}</h3>
                  <CompactGroupStudentPicker
                    groups={targets.groups}
                    students={targets.students}
                    value={targets.selection}
                    onChange={targets.setSelection}
                    keptCount={targets.kept.length}
                    hints={{ whole: t("modules.materialGroupWhole"), partial: t("modules.materialGroupPartial") }}
                  />
                </section>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={draft.isPending || publish.isPending || !text.trim() || !hasRecipients} onClick={() => publish.mutate({ sectionId, text, ...recipients })}>
            {publish.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} {t("qbank.summary.publish")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
