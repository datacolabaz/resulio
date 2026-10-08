import { EmptyState, ErrorNote, Loading, Panel } from "@/components/AppShell";
import { ShareBox } from "@/components/ShareBox";
import { JoinRequestStatusBadge } from "@/components/syllabus/JoinRequestStatus";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SettingToggle } from "@/components/ui/setting-toggle";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime, fmtDay } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { JOIN_DECISION_NOTE_MAX, syllabusSharePath, UPCOMING_GROUP_WINDOW_DAYS, type JoinDecision } from "@shared/syllabusJoin";
import { ExternalLink, Link2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Tree } from "./SyllabusDetail";
import { toastError } from "./shared";

type ShareableSyllabus = { id: string; currentVersionId: string | null; archivedAt: Date | string | null; status: string };

/** "Linki kopyala" from the builder header and the syllabus card menu: creates the link on first use. */
export function useCopyShareLink() {
  const utils = trpc.useUtils();
  const ensure = trpc.teacher.syllabus.ensureShareLink.useMutation();
  const copy = async (s: ShareableSyllabus) => {
    if (s.archivedAt || s.status === "ARCHIVED") return void toast.error(t("sylShare.link.archived"));
    if (!s.currentVersionId) return void toast.error(t("sylShare.link.notPublished"));
    try {
      const link = await ensure.mutateAsync({ id: s.id });
      void utils.teacher.syllabus.shareLink.invalidate({ id: s.id });
      if (!link.active) return void toast.error(t("sylShare.link.disabledToast"));
      await navigator.clipboard.writeText(`${window.location.origin}${syllabusSharePath(link.code)}`);
      toast.success(t("share.copied"));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? errorText(error) : t("share.copyFailed"));
    }
  };
  return { copy, pending: ensure.isPending };
}

export function CopyShareLinkButton({ syllabus }: { syllabus: ShareableSyllabus }) {
  const { copy, pending } = useCopyShareLink();
  return (
    <Button variant="outline" disabled={pending} onClick={() => void copy(syllabus)}>
      <Link2 className="mr-1 h-4 w-4" aria-hidden />
      {t("common.copyLink")}
    </Button>
  );
}

/** Access tab: the public link with share buttons, plus regenerate and turn off / on. */
export function ShareLinkPanel({ tree }: { tree: Tree }) {
  const s = tree.syllabus;
  const utils = trpc.useUtils();
  const state = trpc.teacher.syllabus.shareLink.useQuery({ id: s.id });
  const refresh = () => void utils.teacher.syllabus.shareLink.invalidate({ id: s.id });
  const ensure = trpc.teacher.syllabus.ensureShareLink.useMutation({ onSuccess: refresh, onError: toastError });
  const regenerate = trpc.teacher.syllabus.regenerateShareLink.useMutation({ onSuccess: refresh, onError: toastError });
  const setActive = trpc.teacher.syllabus.setShareLinkActive.useMutation({ onSuccess: refresh, onError: toastError });
  const busy = ensure.isPending || regenerate.isPending || setActive.isPending;
  const link = state.data?.link ?? null;
  const archived = !!s.archivedAt;
  return (
    <Panel title={t("sylShare.link.title")}>
      <p className="mb-3 text-sm text-muted-foreground">{t("sylShare.link.help")}</p>
      {state.isLoading ? (
        <Loading />
      ) : state.error ? (
        <ErrorNote error={state.error} />
      ) : !state.data?.shareable ? (
        <p className="rounded-xl border border-border bg-muted p-3 text-sm">{t(archived ? "sylShare.link.archived" : "sylShare.link.notPublished")}</p>
      ) : !link ? (
        <Button disabled={busy} onClick={() => ensure.mutate({ id: s.id })}>
          <Link2 className="mr-1 h-4 w-4" aria-hidden />
          {t("sylShare.link.create")}
        </Button>
      ) : (
        <div className="space-y-3">
          {link.active ? (
            <ShareBox path={syllabusSharePath(link.code)} fileName={`resulio-syllabus-${link.code}`} />
          ) : (
            <p role="status" className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning">{t("sylShare.link.disabledNote")}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {link.active && (
              <Button asChild size="sm" variant="outline">
                <a href={syllabusSharePath(link.code)} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden />
                  {t("sylShare.link.openPage")}
                </a>
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm(t("sylShare.link.regenerateConfirm")) && regenerate.mutate({ id: s.id })}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t("sylShare.link.regenerate")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setActive.mutate({ id: s.id, active: !link.active })}>
              {t(link.active ? "sylShare.link.disable" : "sylShare.link.enable")}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Access tab: which of the syllabus' granted groups are offered on the public page (explicit opt-in per group). */
export function GroupListingsPanel({ syllabusId }: { syllabusId: string }) {
  const utils = trpc.useUtils();
  const listings = trpc.teacher.syllabus.groupListings.useQuery({ id: syllabusId });
  const set = trpc.teacher.syllabus.setGroupListed.useMutation({
    onSuccess: () => void utils.teacher.syllabus.groupListings.invalidate({ id: syllabusId }),
    onError: toastError,
  });
  if (!listings.data?.length) return null;
  const status = (g: (typeof listings.data)[number]) => {
    if (!g.startDate) return t("sylShare.listing.noStart");
    const date = fmtDay(g.startDate);
    if (!g.listed) return t("sylShare.listing.hidden", { date });
    return t(g.upcoming ? "sylShare.listing.visible" : "sylShare.listing.outOfWindow", { date });
  };
  return (
    <Panel title={t("sylShare.listing.title")}>
      <p className="mb-2 text-sm text-muted-foreground">{t("sylShare.listing.help", { days: UPCOMING_GROUP_WINDOW_DAYS })}</p>
      <ul className="divide-y divide-border">
        {listings.data.map((g) => (
          <li key={g.groupId} className="py-2">
            <div className="break-words text-sm font-semibold">{g.name}</div>
            <SettingToggle
              variant="plain"
              className="pt-1"
              id={`listing-${g.groupId}`}
              label={t("sylShare.listing.toggle")}
              hint={status(g)}
              disabled={set.isPending}
              checked={g.listed}
              onCheckedChange={(v) => set.mutate({ id: syllabusId, groupId: g.groupId, listed: v })}
            />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

type JoinRequestRow = RouterOutputs["teacher"]["syllabus"]["joinRequests"][number];

function DecideDialog({ syllabusId, pending, onClose }: { syllabusId: string; pending: { row: JoinRequestRow; decision: JoinDecision } | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [note, setNote] = useState("");
  const decide = trpc.teacher.syllabus.decideJoinRequest.useMutation({
    onSuccess: (res) => {
      toast.success(t(res.status === "ACCEPTED" ? "sylShare.requests.acceptedToast" : "sylShare.requests.rejectedToast"));
      void utils.teacher.syllabus.joinRequests.invalidate({ id: syllabusId });
      void utils.teacher.syllabus.joinRequestCounts.invalidate();
      void utils.teacher.syllabus.students.invalidate({ id: syllabusId });
      setNote("");
      onClose();
    },
    onError: toastError,
  });
  const row = pending?.row;
  const accepting = pending?.decision === "ACCEPTED";
  const student = row?.studentName || row?.studentEmail || "—";
  return (
    <Dialog open={!!pending} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(accepting ? "sylShare.requests.acceptTitle" : "sylShare.requests.rejectTitle")}</DialogTitle>
          {accepting && row && (
            <DialogDescription>
              {row.type === "GROUP"
                ? t("sylShare.requests.acceptGroupNote", { student, group: row.groupName ?? "—" })
                : t("sylShare.requests.acceptIndividualNote")}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t(accepting ? "sylShare.requests.note" : "sylShare.requests.reason")}</span>
            <Textarea value={note} maxLength={JOIN_DECISION_NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant={accepting ? "default" : "destructive"}
            disabled={decide.isPending || !pending}
            onClick={() => pending && decide.mutate({ requestId: pending.row.id, decision: pending.decision, note: note.trim() || null })}
          >
            {t(accepting ? "sylShare.requests.accept" : "sylShare.requests.reject")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestList({ rows, onDecide }: { rows: JoinRequestRow[]; onDecide: (row: JoinRequestRow, decision: JoinDecision) => void }) {
  const open = rows.filter((r) => r.status === "PENDING");
  const answered = rows.filter((r) => r.status !== "PENDING");
  if (!rows.length) return <p className="text-sm text-muted-foreground">{t("sylShare.requests.empty")}</p>;
  const item = (r: JoinRequestRow) => (
    <li key={r.id} className="flex flex-wrap items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words font-medium">{r.studentName || r.studentEmail}</span>
          <JoinRequestStatusBadge status={r.status} />
        </div>
        <div className="mt-0.5 break-words text-xs text-muted-foreground">
          {[r.studentEmail, r.type === "GROUP" ? t("sylShare.join.requestGroup", { group: r.groupName ?? "—" }) : null, t("sylShare.join.sentAt", { date: fmtDateTime(r.createdAt) })]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {r.message && <p className="mt-1 whitespace-pre-line break-words rounded-lg bg-muted px-3 py-2 text-sm">{r.message}</p>}
        {r.decidedAt && (
          <div className="mt-1 break-words text-xs text-foreground-secondary">
            {t("sylShare.requests.decidedAt", { date: fmtDateTime(r.decidedAt) })}
            {r.decisionNote ? ` · ${r.decisionNote}` : ""}
          </div>
        )}
      </div>
      {r.status === "PENDING" && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onDecide(r, "ACCEPTED")}>{t("sylShare.requests.accept")}</Button>
          <Button size="sm" variant="outline" className="text-destructive" onClick={() => onDecide(r, "REJECTED")}>{t("sylShare.requests.reject")}</Button>
        </div>
      )}
    </li>
  );
  return (
    <div>
      {open.length > 0 && <ul className="divide-y divide-border">{open.map(item)}</ul>}
      {answered.length > 0 && (
        <details className="mt-2" open={!open.length}>
          <summary className="cursor-pointer text-sm text-muted-foreground">{t("sylShare.requests.answered")} ({answered.length})</summary>
          <ul className="divide-y divide-border">{answered.map(item)}</ul>
        </details>
      )}
    </div>
  );
}

/** "Kurs / syllabus müraciətləri": requests from the public page, group and individual apart. */
export function RequestsTab({ tree }: { tree: Tree }) {
  const syllabusId = tree.syllabus.id;
  const requests = trpc.teacher.syllabus.joinRequests.useQuery({ id: syllabusId });
  const [pending, setPending] = useState<{ row: JoinRequestRow; decision: JoinDecision } | null>(null);
  const rows = requests.data ?? [];
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">{t("sylShare.requests.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("sylShare.requests.help")}</p>
      </div>
      {requests.isLoading ? (
        <Loading />
      ) : requests.error ? (
        <ErrorNote error={requests.error} />
      ) : !rows.length ? (
        <EmptyState title={t("sylShare.requests.title")} body={t("sylShare.requests.empty")} />
      ) : (
        <>
          <Panel title={t("sylShare.requests.group")}>
            <RequestList rows={rows.filter((r) => r.type === "GROUP")} onDecide={(row, decision) => setPending({ row, decision })} />
          </Panel>
          <Panel title={t("sylShare.requests.individual")}>
            <RequestList rows={rows.filter((r) => r.type === "INDIVIDUAL")} onDecide={(row, decision) => setPending({ row, decision })} />
          </Panel>
        </>
      )}
      <DecideDialog syllabusId={syllabusId} pending={pending} onClose={() => setPending(null)} />
    </div>
  );
}

/** Open requests of one syllabus, from the workspace-wide counts (tab badge, syllabus cards). */
export function usePendingJoinRequests() {
  const counts = trpc.teacher.syllabus.joinRequestCounts.useQuery(undefined, { staleTime: 60_000, retry: false });
  return (syllabusId: string) => counts.data?.find((c) => c.syllabusId === syllabusId)?.count ?? 0;
}
