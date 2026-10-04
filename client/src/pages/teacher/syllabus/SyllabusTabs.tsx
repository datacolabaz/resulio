import { EmptyState, ErrorNote, Loading, Panel, Pill } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { CompletionRulesForm } from "@/components/syllabus/CompletionRulesForm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { fmtDateTime, fromLocalInput, toLocalInput } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { DEFAULT_COMPLETION_RULES, type CompletionRulesPatch, type SyllabusGrantState } from "@shared/syllabus";
import { Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Tree } from "./SyllabusDetail";
import { fieldsFromSyllabus, fieldsPayload, SyllabusFieldsForm } from "./SyllabusFields";
import { fieldLabel, GrantStateBadge, problemText, toastError, useSyllabusRefresh } from "./shared";

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

function GrantDialog({
  syllabusId,
  open,
  onOpenChange,
  preset,
}: {
  syllabusId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  preset: { groupIds: string[]; studentIds: number[] } | null;
}) {
  const utils = trpc.useUtils();
  const groups = trpc.teacher.groups.list.useQuery(undefined, { enabled: open });
  const students = trpc.teacher.students.useQuery(undefined, { enabled: open });
  const blank = () => ({ groupIds: preset?.groupIds ?? [], studentIds: preset?.studentIds ?? [], startsAt: "", endsAt: "", note: "" });
  const [f, setF] = useState(blank);
  const [lastKey, setLastKey] = useState("");
  const key = `${open}-${JSON.stringify(preset)}`;
  if (key !== lastKey) {
    setLastKey(key);
    if (open) setF(blank());
  }
  const grant = trpc.teacher.syllabus.grant.useMutation({
    onSuccess: () => {
      void utils.teacher.syllabus.grants.invalidate({ id: syllabusId });
      void utils.teacher.syllabus.list.invalidate();
      toast.success(t("syllabus.access.granted"));
      onOpenChange(false);
    },
    onError: toastError,
  });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const startsAt = fromLocalInput(f.startsAt);
  const endsAt = fromLocalInput(f.endsAt);
  const badRange = !!startsAt && !!endsAt && endsAt <= startsAt;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader><DialogTitle>{t("syllabus.access.grantTitle")}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset>
              <legend className={`mb-1 text-sm ${fieldLabel}`}>{t("common.groups")}</legend>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
                {(groups.data ?? []).map((g) => (
                  <label key={g.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="accent-link" checked={f.groupIds.includes(g.id)} onChange={() => setF({ ...f, groupIds: toggle(f.groupIds, g.id) })} />
                    <span className="min-w-0 break-words">{g.name}</span>
                  </label>
                ))}
                {!groups.data?.length && <div className="text-xs text-muted-foreground">{t("modules.noGroups")}</div>}
              </div>
            </fieldset>
            <fieldset>
              <legend className={`mb-1 text-sm ${fieldLabel}`}>{t("common.students")}</legend>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
                {(students.data ?? []).map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="accent-link" checked={f.studentIds.includes(s.id)} onChange={() => setF({ ...f, studentIds: toggle(f.studentIds, s.id) })} />
                    <span className="min-w-0 break-words">{s.name ?? s.email}</span>
                  </label>
                ))}
                {!students.data?.length && <div className="text-xs text-muted-foreground">{t("modules.noStudents")}</div>}
              </div>
            </fieldset>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm"><span className={fieldLabel}>{t("syllabus.access.startsAt")}</span><Input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("syllabus.access.endsAt")}</span><Input type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></label>
          </div>
          <p className="text-xs text-muted-foreground">{t("syllabus.access.datesHelp")}</p>
          {badRange && <p role="alert" className="text-xs text-destructive">{t("syllabus.access.badRange")}</p>}
          <label className="text-sm"><span className={fieldLabel}>{t("syllabus.access.note")}</span><Input maxLength={255} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            disabled={(!f.groupIds.length && !f.studentIds.length) || badRange || grant.isPending}
            onClick={() => grant.mutate({ id: syllabusId, groupIds: f.groupIds, studentIds: f.studentIds, startsAt, endsAt, note: f.note || undefined })}
          >
            {t("syllabus.access.grant")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
    <div className="flex items-center justify-between gap-3 py-2">
      <label htmlFor={id} className="min-w-0 break-words text-sm">{label}</label>
      <Switch id={id} disabled={q.isLoading || set.isPending} checked={!!q.data?.progressVisibleToGroup} onCheckedChange={(v) => set.mutate({ groupId, visible: v })} />
    </div>
  );
}

const STATE_ORDER: SyllabusGrantState[] = ["ACTIVE", "PENDING", "EXPIRED", "REVOKED"];

export function AccessTab({ tree }: { tree: Tree }) {
  const s = tree.syllabus;
  const utils = trpc.useUtils();
  const grants = trpc.teacher.syllabus.grants.useQuery({ id: s.id });
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
      {!s.currentVersionId && <p className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning">{t("syllabus.access.notPublished")}</p>}
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
      <GrantDialog syllabusId={s.id} open={grantOpen} onOpenChange={setGrantOpen} preset={preset} />
      <DatesDialog syllabusId={s.id} grant={datesFor} onClose={() => setDatesFor(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

function DiffLine({ label, c }: { label: string; c: { added: number; removed: number; changed: number } }) {
  if (!c.added && !c.removed && !c.changed) return null;
  return (
    <li className="flex flex-wrap gap-x-3 text-sm">
      <span className="font-medium">{label}</span>
      {c.added > 0 && <span className="text-success">{t("syllabus.publish.added", { count: c.added })}</span>}
      {c.removed > 0 && <span className="text-destructive">{t("syllabus.publish.removed", { count: c.removed })}</span>}
      {c.changed > 0 && <span className="text-warning">{t("syllabus.publish.changed", { count: c.changed })}</span>}
    </li>
  );
}

export function PublishDialog({ syllabusId, open, onOpenChange }: { syllabusId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const refresh = useSyllabusRefresh(syllabusId);
  const utils = trpc.useUtils();
  const preview = trpc.teacher.syllabus.publishPreview.useQuery({ id: syllabusId }, { enabled: open, refetchOnWindowFocus: false });
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [problems, setProblems] = useState<{ code: string; title?: string }[] | null>(null);
  const publish = trpc.teacher.syllabus.publish.useMutation({
    onSuccess: (r) => {
      if (!r.published) {
        setProblems(r.problems);
        return;
      }
      toast.success(t("syllabus.publish.done", { label: label.trim() || preview.data?.nextLabel || "" }));
      setLabel("");
      setNote("");
      setProblems(null);
      refresh();
      void utils.teacher.syllabus.versions.invalidate({ id: syllabusId });
      onOpenChange(false);
    },
    onError: toastError,
  });
  const p = preview.data;
  const shownProblems = problems ?? p?.problems ?? [];
  const d = p?.diff;
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setProblems(null); }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{t("syllabus.publish.title")}</DialogTitle></DialogHeader>
        {preview.isLoading ? (
          <Loading />
        ) : preview.error ? (
          <ErrorNote error={preview.error} />
        ) : p && d ? (
          <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">{t("syllabus.publish.help")}</p>
            {shownProblems.length > 0 && (
              <div role="alert" className="rounded-xl border border-destructive/40 bg-danger-surface p-3 text-sm text-destructive">
                <p className="mb-1 font-medium">{t("syllabus.publish.problems")}</p>
                <ul className="list-disc space-y-0.5 pl-5">{shownProblems.map((pr, i) => <li key={i}>{problemText(pr)}</li>)}</ul>
              </div>
            )}
            <div className="rounded-xl border border-border p-3">
              <p className="mb-2 text-sm font-medium">{t("syllabus.publish.changes")}</p>
              {d.firstVersion ? (
                <p className="text-sm">{t("syllabus.publish.first")}</p>
              ) : !d.changed ? (
                <p className="text-sm text-muted-foreground">{t("syllabus.publish.noChanges")}</p>
              ) : (
                <ul className="space-y-1">
                  <DiffLine label={t("syllabus.publish.modules")} c={d.modules} />
                  <DiffLine label={t("syllabus.publish.lessons")} c={d.lessons} />
                  <DiffLine label={t("syllabus.publish.items")} c={d.items} />
                  {d.reordered && <li className="text-sm">{t("syllabus.publish.reordered")}</li>}
                  {d.rulesChanged && <li className="text-sm">{t("syllabus.publish.rulesChanged")}</li>}
                </ul>
              )}
              {(p.excluded.modules > 0 || p.excluded.lessons > 0) && (
                <p className="mt-2 text-xs text-warning">{t("syllabus.publish.excluded", { modules: p.excluded.modules, lessons: p.excluded.lessons })}</p>
              )}
            </div>
            <label className="text-sm">
              <span className={fieldLabel}>{t("syllabus.publish.label")}</span>
              <Input maxLength={16} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={p.nextLabel} />
            </label>
            <label className="text-sm">
              <span className={fieldLabel}>{t("syllabus.publish.note")}</span>
              <Textarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("syllabus.publish.notePlaceholder")} />
            </label>
            <p className="text-xs text-muted-foreground">{t("syllabus.publish.studentsNote")}</p>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={!p || shownProblems.length > 0 || publish.isPending} onClick={() => publish.mutate({ id: syllabusId, label: label.trim() || undefined, changeNote: note.trim() || undefined })}>
            {publish.isPending ? t("syllabus.publish.publishing") : t("syllabus.publish.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
