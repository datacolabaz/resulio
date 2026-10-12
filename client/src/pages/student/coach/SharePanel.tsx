import { Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { errorText, fmtDay } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { Share2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * "Müəllimlə paylaş" on a ready material: off until the student picks a teacher. The teacher sees
 * only the file and the prepared summaries; revoking takes effect at once.
 */
export function SharePanel({ materialId }: { materialId: string }) {
  const utils = trpc.useUtils();
  const targets = trpc.student.coach.shares.targets.useQuery();
  const list = trpc.student.coach.shares.list.useQuery({ id: materialId });
  const [pick, setPick] = useState("");
  const [open, setOpen] = useState(false);
  const onDone = (data: NonNullable<typeof list.data>) => {
    utils.student.coach.shares.list.setData({ id: materialId }, data);
    setPick("");
  };
  const share = trpc.student.coach.shares.share.useMutation({
    onSuccess: (data) => {
      onDone(data);
      toast.success(t("coachShare.shared"));
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const revoke = trpc.student.coach.shares.revoke.useMutation({ onSuccess: onDone, onError: (e) => toast.error(errorText(e)) });
  const shared = list.data ?? [];
  const available = (targets.data ?? []).filter((tg) => !shared.some((s) => s.teacherId === tg.teacherId && s.workspaceId === tg.workspaceId));
  const chosen = available.find((tg) => `${tg.teacherId}:${tg.workspaceId}` === pick);

  return (
    <Panel title={t("coachShare.title")}>
      <p className="text-sm text-muted-foreground">{shared.length ? t("coachShare.onIntro") : t("coachShare.offIntro")}</p>
      {!!shared.length && (
        <ul className="mt-3 space-y-2">
          {shared.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 break-words">{s.name ?? t("coachShare.formerTeacher")}</span>
              <span className="text-xs text-muted-foreground">{fmtDay(s.createdAt)}</span>
              <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate({ shareId: s.id })}>
                <X className="mr-1 h-4 w-4" aria-hidden />
                {t("coachShare.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!open ? (
        <Button size="sm" variant="outline" className="mt-3" onClick={() => setOpen(true)}>
          <Share2 className="mr-1 h-4 w-4" aria-hidden />
          {t("coachShare.action")}
        </Button>
      ) : targets.data && !targets.data.length ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("coachShare.noTeachers")}</p>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="block text-sm font-medium">
            {t("coachShare.pickTeacher")}
            <select className="mt-1 w-full max-w-sm rounded-lg border border-input bg-card px-3 py-2 text-foreground" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">—</option>
              {available.map((tg) => (
                <option key={`${tg.teacherId}:${tg.workspaceId}`} value={`${tg.teacherId}:${tg.workspaceId}`}>
                  {tg.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">{t("coachShare.whatTeacherSees")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!chosen || share.isPending} onClick={() => chosen && share.mutate({ id: materialId, target: { teacherId: chosen.teacherId, workspaceId: chosen.workspaceId } })}>
              {t("coachShare.confirm")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
