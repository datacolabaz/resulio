import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * "AI konspekt": drafts a study note from one bank section's own questions, lets the teacher edit
 * it, then saves it as a material for the groups they pick. The AI output is never sent to
 * students unreviewed -- draft and publish are two separate steps the teacher triggers themselves.
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

function SummaryDialog({ sectionId, sectionName, onClose }: { sectionId: string; sectionName: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const groupsQuery = trpc.teacher.groups.list.useQuery();
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

  const toggleGroup = (id: string, checked: boolean) => setGroupIds((cur) => (checked ? [...cur, id] : cur.filter((x) => x !== id)));

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
              <div className="grid gap-2">
                <span className="text-sm font-medium">{t("qbank.summary.recipients")}</span>
                <div className="grid max-h-40 gap-1.5 overflow-y-auto rounded-lg border border-input p-2">
                  {(groupsQuery.data ?? []).length === 0 && <span className="text-sm text-muted-foreground">{t("qbank.summary.noGroups")}</span>}
                  {(groupsQuery.data ?? []).map((g) => (
                    <label key={g.id} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={groupIds.includes(g.id)} onCheckedChange={(v) => toggleGroup(g.id, v === true)} />
                      {g.name}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={draft.isPending || publish.isPending || !text.trim() || !groupIds.length} onClick={() => publish.mutate({ sectionId, text, groupIds })}>
            {publish.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} {t("qbank.summary.publish")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
