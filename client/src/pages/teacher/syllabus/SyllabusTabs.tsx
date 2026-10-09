import { EmptyState, ErrorNote, Loading, Panel, Pill } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { CompletionRulesForm } from "@/components/syllabus/CompletionRulesForm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SettingToggle } from "@/components/ui/setting-toggle";
import { t } from "@/i18n/messages";
import { fmtDateTime, fromLocalInput, toLocalInput } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { DEFAULT_COMPLETION_RULES, type CompletionRulesPatch, type SyllabusGrantState } from "@shared/syllabus";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { DeleteSyllabusDialog } from "./DeleteSyllabusDialog";
import { GrantDialog } from "./GrantDialog";
import { GroupListingsPanel, ShareLinkPanel } from "./ShareAndRequests";
import type { Tree } from "./SyllabusDetail";
import { fieldsFromSyllabus, fieldsPayload, SyllabusFieldsForm } from "./SyllabusFields";
import { fieldLabel, GrantStateBadge, toastError, useSyllabusRefresh } from "./shared";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function SettingsTab({ tree }: { tree: Tree }) {
  const s = tree.syllabus;
  const refresh = useSyllabusRefresh(s.id);
  const [f, setF] = useState(() => fieldsFromSyllabus(s));
  const [rules, setRules] = useState<CompletionRulesPatch>(() => s.completionRules ?? {});
  const [dirty, setDirty] = useState(false);
  const update = trpc.teacher.syllabus.update.useMutation({
    onSuccess: () => {
      setDirty(false);
      refresh();
      toast.success(t("syllabus.saved"));
    },
    onError: toastError,
  });
  const archive = trpc.teacher.syllabus.setArchived.useMutation({ onSuccess: refresh, onError: toastError });
  const archived = !!s.archivedAt;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [, nav] = useLocation();
  return (
    <div className="space-y-4">
      <Panel title={t("syllabus.settings.details")}>
        <SyllabusFieldsForm idPrefix={`syl-${s.id}`} value={f} onChange={(v) => { setF(v); setDirty(true); }} />
      </Panel>
      <Panel title={t("syllabus.rules.title")}>
        <p className="mb-3 text-sm text-muted-foreground">{t("syllabus.rules.syllabusHelp")}</p>
        <CompletionRulesForm idPrefix={`syl-rules-${s.id}`} level="syllabus" patch={rules} inherited={DEFAULT_COMPLETION_RULES} onChange={(r) => { setRules(r); setDirty(true); }} />
      </Panel>
      <div className="sticky bottom-0 z-10 flex flex-wrap justify-end gap-2 border-t border-border bg-background/95 py-3 backdrop-blur">
        {dirty && <span className="mr-auto self-center text-sm text-warning">{t("syllabus.unsaved")}</span>}
        <Button disabled={!dirty || !f.title.trim() || update.isPending} onClick={() => update.mutate({ id: s.id, patch: { ...fieldsPayload(f), completionRules: rules } })}>
          {update.isPending ? t("syllabus.saving") : t("common.save")}
        </Button>
      </div>
      <Panel title={archived ? t("syllabus.settings.unarchiveTitle") : t("syllabus.settings.archiveTitle")}>
        <p className="mb-3 text-sm text-muted-foreground">{archived ? t("syllabus.settings.unarchiveHelp") : t("syllabus.settings.archiveHelp")}</p>
        <Button
          variant={archived ? "outline" : "destructive"}
          disabled={archive.isPending}
          onClick={() => (archived || confirm(t("syllabus.settings.archiveConfirm"))) && archive.mutate({ id: s.id, archived: !archived })}
        >
          {archived ? t("syllabus.settings.unarchive") : t("syllabus.settings.archive")}
        </Button>
      </Panel>
      <Panel title={t("syllabus.settings.deleteTitle")}>
        <p className="mb-3 text-sm text-muted-foreground">{t("syllabus.settings.deleteHelp")}</p>
        <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
          <Trash2 className="mr-1 h-4 w-4" aria-hidden />
          {t("syllabus.delete.action")}
        </Button>
      </Panel>
      <DeleteSyllabusDialog syllabusId={s.id} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={() => nav("/teacher/syllabus")} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export function VersionsTab({ tree }: { tree: Tree }) {
  const s = tree.syllabus;
  const versions = trpc.teacher.syllabus.versions.useQuery({ id: s.id });
  const utils = trpc.useUtils();
  const move = trpc.teacher.syllabus.moveStudents.useMutation({
    onSuccess: (r) => {
      toast.success(t("syllabus.versions.moved", { count: r.moved }));
      void utils.teacher.syllabus.versions.invalidate({ id: s.id });
    },
    onError: toastError,
  });
  if (versions.isLoading) return <Loading />;
  if (versions.error) return <ErrorNote error={versions.error} />;
  const rows = versions.data ?? [];
  if (!rows.length) return <EmptyState title={t("syllabus.versions.emptyTitle")} body={t("syllabus.versions.emptyBody")} />;
  const othersEnrolled = (id: string) => rows.filter((v) => v.id !== id).reduce((n, v) => n + v.enrolledCount, 0);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("syllabus.versions.help")}</p>
      <ul className="space-y-2">
        {rows.map((v) => {
          const current = v.id === s.currentVersionId;
          return (
            <li key={v.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{v.label}</span>
                {current ? <StatusBadge tone="success">{t("syllabus.versions.current")}</StatusBadge> : <Pill>{t(`syllabus.versions.status.${v.status}`)}</Pill>}
                <span className="text-xs text-muted-foreground">{fmtDateTime(v.publishedAt)}</span>
                <span className="ml-auto text-xs text-foreground-secondary">{t("syllabus.count.enrolled", { count: v.enrolledCount })}</span>
              </div>
              {v.changeNote && <p className="mt-1 whitespace-pre-wrap text-sm">{v.changeNote}</p>}
              {current && othersEnrolled(v.id) > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={move.isPending}
                  onClick={() => confirm(t("syllabus.versions.moveConfirm", { label: v.label })) && move.mutate({ id: s.id, versionId: v.id, all: true })}
                >
                  {t("syllabus.versions.moveAll", { label: v.label, count: othersEnrolled(v.id) })}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

type Grant = RouterOutputs["teacher"]["syllabus"]["grants"][number];

function DatesDialog({ syllabusId, grant, onClose }: { syllabusId: string; grant: Grant | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [lastId, setLastId] = useState<string | null>(null);
  if ((grant?.id ?? null) !== lastId) {
    setLastId(grant?.id ?? null);
    setStartsAt(toLocalInput(grant?.startsAt ?? null));
    setEndsAt(toLocalInput(grant?.endsAt ?? null));
  }
  const update = trpc.teacher.syllabus.updateGrantDates.useMutation({
    onSuccess: () => {
      void utils.teacher.syllabus.grants.invalidate({ id: syllabusId });
      onClose();
    },
    onError: toastError,
  });
  const s = fromLocalInput(startsAt);
  const e = fromLocalInput(endsAt);
  const badRange = !!s && !!e && e <= s;
  return (
    <Dialog open={!!grant} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t("syllabus.access.datesTitle", { label: grant?.label ?? "" })}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs text-muted-foreground">{t("syllabus.access.datesExplain")}</p>
          <label className="text-sm"><span className={fieldLabel}>{t("syllabus.access.startsAt")}</span><Input type="datetime-local" value={startsAt} onChange={(ev) => setStartsAt(ev.target.value)} /></label>
          <label className="text-sm"><span className={fieldLabel}>{t("syllabus.access.endsAt")}</span><Input type="datetime-local" value={endsAt} onChange={(ev) => setEndsAt(ev.target.value)} /></label>
          {badRange && <p role="alert" className="text-xs text-destructive">{t("syllabus.access.badRange")}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button disabled={badRange || update.isPending || !grant} onClick={() => grant && update.mutate({ id: syllabusId, grantId: grant.id, startsAt: s, endsAt: e })}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GroupVisibility({ groupId, label }: { groupId: string; label: string }) {
  const utils = trpc.useUtils();
  const q = trpc.teacher.syllabus.groupSettings.useQuery({ groupId });
  const set = trpc.teacher.syllabus.setProgressVisibleToGroup.useMutation({
    onSuccess: () => void utils.teacher.syllabus.groupSettings.invalidate({ groupId }),
    onError: toastError,
  });
  const id = `vis-${groupId}`;
  return (
    <SettingToggle
      variant="plain"
      className="py-2"
      id={id}
      label={label}
      disabled={q.isLoading || set.isPending}
      checked={!!q.data?.progressVisibleToGroup}
      onCheckedChange={(v) => set.mutate({ groupId, visible: v })}
    />
  );
}

const STATE_ORDER: SyllabusGrantState[] = ["ACTIVE", "PENDING", "EXPIRED", "REVOKED"];

export function AccessTab({ tree }: { tree: Tree }) {
  const s = tree.syllabus;
  const utils = trpc.useUtils();
  const grants = trpc.teacher.syllabus.grants.useQuery({ id: s.id });
  const flag = trpc.teacher.syllabus.enabled.useQuery(undefined, { staleTime: 5 * 60_000 });
  const [grantOpen, setGrantOpen] = useState(false);
  const [preset, setPreset] = useState<{ groupIds: string[]; studentIds: number[] } | null>(null);
  const [datesFor, setDatesFor] = useState<Grant | null>(null);
  const revoke = trpc.teacher.syllabus.revokeGrant.useMutation({
    onSuccess: () => {
      void utils.teacher.syllabus.grants.invalidate({ id: s.id });
      void utils.teacher.syllabus.list.invalidate();
    },
    onError: toastError,
  });
  const archived = !!s.archivedAt;
  const rows = [...(grants.data ?? [])].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  const liveGroups = [...new Map(rows.filter((g) => g.groupId && g.state !== "REVOKED").map((g) => [g.groupId!, g.label])).entries()];
  return (
    <div className="space-y-4">
      {flag.data?.enabled === false && <p role="alert" className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning">{t("pub.flagOff")}</p>}
      {!s.currentVersionId && <p className="rounded-xl border border-border bg-muted p-3 text-sm">{t("syllabus.access.notPublished")}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("syllabus.access.help")}</p>
        <Button disabled={archived} onClick={() => { setPreset(null); setGrantOpen(true); }}>
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          {t("syllabus.access.grantTitle")}
        </Button>
      </div>
      {grants.isLoading ? (
        <Loading />
      ) : grants.error ? (
        <ErrorNote error={grants.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("syllabus.access.emptyTitle")} body={t("syllabus.access.emptyBody")} />
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
          {rows.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words font-medium">{g.label}</span>
                  <Pill>{g.groupId ? t("syllabus.access.group") : t("syllabus.access.student")}</Pill>
                  <GrantStateBadge state={g.state} />
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {g.startsAt || g.endsAt
                    ? t("syllabus.access.window", { from: g.startsAt ? fmtDateTime(g.startsAt) : "—", to: g.endsAt ? fmtDateTime(g.endsAt) : "—" })
                    : t("syllabus.access.noWindow")}
                  {" · "}
                  {g.revokedAt ? t("syllabus.access.revokedAt", { at: fmtDateTime(g.revokedAt) }) : t("syllabus.access.grantedAt", { at: fmtDateTime(g.grantedAt) })}
                </div>
                {g.note && <div className="mt-0.5 text-xs text-foreground-secondary">{g.note}</div>}
              </div>
              <div className="flex flex-wrap gap-2">
                {g.state !== "REVOKED" && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setDatesFor(g)}>{t("syllabus.access.editDates")}</Button>
                    <Button size="sm" variant="outline" className="text-destructive" disabled={revoke.isPending} onClick={() => confirm(t("syllabus.access.revokeConfirm", { label: g.label })) && revoke.mutate({ id: s.id, grantId: g.id })}>
                      {t("syllabus.access.revoke")}
                    </Button>
                  </>
                )}
                {(g.state === "REVOKED" || g.state === "EXPIRED") && !archived && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setPreset({ groupIds: g.groupId ? [g.groupId] : [], studentIds: g.studentId ? [g.studentId] : [] });
                      setGrantOpen(true);
                    }}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
                    {t("syllabus.access.restore")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {liveGroups.length > 0 && (
        <Panel title={t("syllabus.access.visibilityTitle")}>
          <p className="mb-2 text-sm text-muted-foreground">{t("syllabus.access.visibilityHelp")}</p>
          <div className="divide-y divide-border">
            {liveGroups.map(([groupId, label]) => <GroupVisibility key={groupId} groupId={groupId} label={label} />)}
          </div>
        </Panel>
      )}
      <ShareLinkPanel tree={tree} />
      <GroupListingsPanel syllabusId={s.id} />
      <GrantDialog syllabusId={s.id} open={grantOpen} onOpenChange={setGrantOpen} preset={preset} />
      <DatesDialog syllabusId={s.id} grant={datesFor} onClose={() => setDatesFor(null)} />
    </div>
  );
}
