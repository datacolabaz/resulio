import { Loading, Panel } from "@/components/AppShell";
import { MasteryBadge } from "@/components/growth/Mastery";
import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { getLocale, t } from "@/i18n/messages";
import { errorText, fmtDay, fmtDayKeyShort } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import type { RiskLevel, RiskReason } from "@shared/growth";
import { useState } from "react";
import { toast } from "sonner";

const selectClass = "mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-foreground";

export const LEVEL_TONE: Record<RiskLevel, Tone> = { HIGH: "danger", MEDIUM: "warning", WATCH: "info", NONE: "neutral" };

export function RiskBadge({ level }: { level: RiskLevel }) {
  return <StatusBadge tone={LEVEL_TONE[level]}>{t(`growth.level.${level}`)}</StatusBadge>;
}

export const reasonText = (r: RiskReason) => t(`growth.reason.${r.code}`, { value: r.value, topics: (r.topics ?? []).join(", ") });

function Reasons({ reasons }: { reasons: RiskReason[] }) {
  return (
    <ul className="space-y-1">
      {reasons.map((r) => (
        <li key={r.code} className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="break-words">{reasonText(r)}</span>
          <span className="text-xs text-muted-foreground">{t("growth.reason.points", { points: r.points })}</span>
        </li>
      ))}
    </ul>
  );
}

export function RiskRadarTab() {
  const groups = trpc.teacher.groups.list.useQuery();
  const [groupId, setGroupId] = useState("");
  const [studentId, setStudentId] = useState<number | null>(null);
  const list = trpc.teacher.growth.riskList.useQuery({ groupId: groupId || null });
  if (!list.data) return <Loading />;
  if (!list.data.enabled) return <Panel><p className="text-sm text-muted-foreground">{t("growth.risk.off")}</p></Panel>;
  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-muted-foreground">{t("growth.risk.intro")}</p>
      <label className="block max-w-sm text-sm font-medium">
        {t("growth.weak.pickGroup")}
        <select className={selectClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">{t("growth.risk.allGroups")}</option>
          {(groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </label>
      <Panel>
        {!list.data.rows.length ? (
          <p className="text-sm text-muted-foreground">{t("growth.risk.empty")}</p>
        ) : (
          <ul className="divide-y">
            {list.data.rows.map((r) => (
              <li key={r.studentId} className="grid gap-2 py-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,2fr)] md:items-start">
                <div className="min-w-0">
                  <button type="button" className="break-words text-left font-medium text-primary underline-offset-2 hover:underline" onClick={() => setStudentId(r.studentId)}>
                    {r.name}
                  </button>
                  <div className="break-words text-xs text-muted-foreground">{r.groups.join(", ")}</div>
                </div>
                <div className="flex items-center gap-2">
                  <RiskBadge level={r.level} />
                  <span className="text-sm tabular-nums">{r.score}</span>
                </div>
                <Reasons reasons={r.reasons} />
              </li>
            ))}
          </ul>
        )}
        {list.data.dismissed > 0 && <p className="mt-3 text-xs text-muted-foreground">{t("growth.risk.dismissedHidden", { count: list.data.dismissed })}</p>}
      </Panel>
      <RiskDetailSheet studentId={studentId} onClose={() => setStudentId(null)} />
    </div>
  );
}

function RiskDetailSheet({ studentId, onClose }: { studentId: number | null; onClose: () => void }) {
  return (
    <Sheet open={studentId != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl" aria-describedby={undefined}>
        {studentId != null && <RiskDetail studentId={studentId} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  );
}

function RiskDetail({ studentId, onClose }: { studentId: number; onClose: () => void }) {
  const utils = trpc.useUtils();
  const detail = trpc.teacher.growth.riskDetail.useQuery({ studentId });
  const weakness = trpc.teacher.growth.studentWeakness.useQuery({ studentId });
  const dismiss = trpc.teacher.growth.dismissRisk.useMutation({
    onSuccess: () => {
      toast.success(t("growth.risk.dismissed"));
      void utils.teacher.growth.riskList.invalidate();
      onClose();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!detail.data || !weakness.data) return <Loading />;
  const { risk, history, actions, parentReports } = detail.data;
  return (
    <div className="space-y-6 p-1">
      <SheetHeader className="pr-10">
        <SheetTitle>{weakness.data.student.name}</SheetTitle>
      </SheetHeader>
      <section className="space-y-2">
        {risk && risk.level !== "NONE" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <RiskBadge level={risk.level} />
              <span className="text-sm">{t("growth.risk.score", { score: risk.score })}</span>
            </div>
            <Reasons reasons={risk.reasons} />
            {history.length > 1 && (
              <p className="text-xs text-muted-foreground">{t("growth.risk.history", { list: history.map((h) => `${fmtDayKeyShort(h.dayKey)} ${h.score}`).join(" · ") })}</p>
            )}
            <Button size="sm" variant="outline" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ studentId })}>{t("growth.risk.dismiss")}</Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("growth.risk.noRisk")}</p>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">{t("growth.student.gains")}</h3>
        {!weakness.data.gains.length ? (
          <p className="text-sm text-muted-foreground">{t("growth.student.noGains")}</p>
        ) : (
          <ul className="space-y-1">
            {weakness.data.gains.map((g) => (
              <li key={g.topicKey} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="break-words">{g.label}</span>
                <span className="flex items-center gap-2"><MasteryBadge status={g.status} /><span className="text-xs text-muted-foreground">{t("growth.student.gainValue", { value: g.gain })}</span></span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <RetakeForm studentId={studentId} topics={weakness.data.topics.filter((m) => m.status === "CRITICAL" || m.status === "REVIEW").map((m) => ({ key: m.topicKey, label: m.label }))} />
      <MaterialShare studentId={studentId} />
      <Notes studentId={studentId} notes={detail.data.notes} />
      <ParentReport studentId={studentId} enabled={parentReports} />
      {actions.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t("growth.actions.log")}</h3>
          <ul className="space-y-1 text-sm">
            {actions.map((a) => <li key={a.id} className="flex justify-between gap-2"><span>{t(`growth.action.${a.type}`)}</span><span className="text-xs text-muted-foreground">{fmtDay(a.createdAt)}</span></li>)}
          </ul>
        </section>
      )}
    </div>
  );
}

function RetakeForm({ studentId, topics }: { studentId: number; topics: { key: string; label: string }[] }) {
  const utils = trpc.useUtils();
  const [picked, setPicked] = useState<string[]>(() => topics.slice(0, 2).map((x) => x.key));
  const [count, setCount] = useState(10);
  const preview = trpc.teacher.growth.retakePreview.useQuery({ studentId, topicKeys: picked }, { enabled: picked.length > 0 });
  const create = trpc.teacher.growth.createRetake.useMutation({
    onSuccess: (r) => {
      toast.success(t("growth.retake.created", { count: r.questionCount }));
      void utils.teacher.growth.riskDetail.invalidate({ studentId });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : p.length >= 5 ? p : [...p, key]));
  return (
    <section className="space-y-2 rounded-xl border border-border p-3">
      <h3 className="text-sm font-semibold">{t("growth.retake.title")}</h3>
      {!topics.length ? (
        <p className="text-sm text-muted-foreground">{t("growth.retake.noTopics")}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t("growth.retake.hint")}</p>
          <fieldset>
            <legend className="text-xs text-muted-foreground">{t("growth.retake.topics")}</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {topics.map((x) => (
                <label key={x.key} className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-sm">
                  <input type="checkbox" checked={picked.includes(x.key)} onChange={() => toggle(x.key)} />
                  <span className="break-words">{x.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block max-w-40 text-xs text-muted-foreground">
            {t("growth.retake.count")}
            <Input type="number" min={3} max={30} className="mt-1" value={count} onChange={(e) => setCount(Math.max(3, Math.min(30, Number(e.target.value) || 3)))} />
          </label>
          {preview.data && <p className="text-xs text-muted-foreground">{t("growth.retake.available", preview.data)}</p>}
          <Button size="sm" disabled={!picked.length || create.isPending || (preview.data?.available ?? 0) < 3} onClick={() => create.mutate({ studentId, topicKeys: picked, count })}>
            {t("growth.retake.create")}
          </Button>
        </>
      )}
    </section>
  );
}

function MaterialShare({ studentId }: { studentId: number }) {
  const utils = trpc.useUtils();
  const materials = trpc.teacher.tasks.materials.useQuery();
  const [materialId, setMaterialId] = useState("");
  const share = trpc.teacher.growth.shareMaterial.useMutation({
    onSuccess: () => {
      toast.success(t("growth.material.shared"));
      void utils.teacher.growth.riskDetail.invalidate({ studentId });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <section className="space-y-2 rounded-xl border border-border p-3">
      <h3 className="text-sm font-semibold">{t("growth.material.title")}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t("growth.material.pick")}
          <select className={selectClass} value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
            <option value="">{t("growth.material.pick")}</option>
            {(materials.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </label>
        <Button size="sm" disabled={!materialId || share.isPending} onClick={() => share.mutate({ studentId, materialId })}>{t("growth.material.share")}</Button>
      </div>
    </section>
  );
}

function Notes({ studentId, notes }: { studentId: number; notes: { id: string; body: string; createdAt: Date; author: string | null }[] }) {
  const utils = trpc.useUtils();
  const [body, setBody] = useState("");
  const refresh = () => void utils.teacher.growth.riskDetail.invalidate({ studentId });
  const add = trpc.teacher.growth.addNote.useMutation({ onSuccess: () => { setBody(""); refresh(); }, onError: (e) => toast.error(errorText(e)) });
  const del = trpc.teacher.growth.deleteNote.useMutation({ onSuccess: refresh, onError: (e) => toast.error(errorText(e)) });
  return (
    <section className="space-y-2 rounded-xl border border-border p-3">
      <h3 className="text-sm font-semibold">{t("growth.notes.title")}</h3>
      <Textarea value={body} maxLength={2000} placeholder={t("growth.notes.placeholder")} onChange={(e) => setBody(e.target.value)} />
      <Button size="sm" disabled={!body.trim() || add.isPending} onClick={() => add.mutate({ studentId, body })}>{t("growth.notes.add")}</Button>
      {!notes.length ? (
        <p className="text-sm text-muted-foreground">{t("growth.notes.empty")}</p>
      ) : (
        <ul className="divide-y">
          {notes.map((n) => (
            <li key={n.id} className="py-2 text-sm">
              <p className="whitespace-pre-wrap break-words">{n.body}</p>
              <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{fmtDay(n.createdAt)}</span>
                <Button size="sm" variant="ghost" onClick={() => del.mutate({ noteId: n.id })}>{t("growth.notes.delete")}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ParentReport({ studentId, enabled }: { studentId: number; enabled: boolean }) {
  const utils = trpc.useUtils();
  const shares = trpc.teacher.growth.reportShares.useQuery({ studentId }, { enabled });
  const [email, setEmail] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const refresh = () => {
    void utils.teacher.growth.reportShares.invalidate({ studentId });
    void utils.teacher.growth.riskDetail.invalidate({ studentId });
  };
  const create = trpc.teacher.growth.createReport.useMutation({
    onSuccess: (r) => {
      setUrl(r.url);
      setEmail("");
      toast.success(t("growth.report.created"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const revoke = trpc.teacher.growth.revokeReport.useMutation({ onSuccess: refresh, onError: (e) => toast.error(errorText(e)) });
  return (
    <section className="space-y-2 rounded-xl border border-border p-3">
      <h3 className="text-sm font-semibold">{t("growth.report.title")}</h3>
      {!enabled ? (
        <p className="text-sm text-muted-foreground">{t("growth.report.off")}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t("growth.report.hint")}</p>
          <label className="block text-xs text-muted-foreground">
            {t("growth.report.email")}
            <Input type="email" className="mt-1" value={email} maxLength={255} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate({ studentId, email: email.trim() || null, locale: getLocale() })}>{t("growth.report.create")}</Button>
          {url && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted p-2 text-xs">
              <span className="min-w-0 flex-1 break-all">{url}</span>
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success(t("growth.report.copied")))}>{t("growth.report.copy")}</Button>
            </div>
          )}
          {(shares.data ?? []).length > 0 && (
            <div>
              <div className="text-xs font-medium">{t("growth.report.active")}</div>
              <ul className="divide-y">
                {shares.data!.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs text-muted-foreground">
                    <span>{fmtDay(s.createdAt)} · {t("growth.report.views", { count: s.viewCount, date: fmtDay(s.expiresAt) })}</span>
                    <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: s.id })}>{t("growth.report.revoke")}</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
