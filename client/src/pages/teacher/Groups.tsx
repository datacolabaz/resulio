import { ProgressChart, RankingTable, TopicBars } from "@/components/AnalyticsBlocks";
import { AppShell, EmptyState, ErrorNote, Loading, Panel, Pill, StatCard } from "@/components/AppShell";
import { ShareBox } from "@/components/ShareBox";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime, liveLabel } from "@/lib/format";
import { liveStatus } from "@/lib/status";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { Link, useParams } from "wouter";

const fieldLabel = "text-foreground-secondary";
const GROUP_FORMATS = ["ONLINE", "IN_PERSON", "HYBRID"] as const;
const JOIN_POLICIES = ["AUTO", "APPROVAL", "MANUAL"] as const;
type JoinPolicy = (typeof JOIN_POLICIES)[number];

export function GroupsPage() {
  const groups = trpc.teacher.groups.list.useQuery();
  const overview = trpc.teacher.groups.overview.useQuery();
  const [open, setOpen] = useState(false);
  return (
    <AppShell area="teaching">
      <div className="space-y-5">
        <div className="flex justify-end"><Button onClick={() => setOpen(true)}>{t("groups.new")}</Button></div>
        {groups.isLoading ? (
          <Loading />
        ) : !groups.data?.length ? (
          <EmptyState title={t("groups.empty")} body={t("groups.emptyBody")} action={<Button onClick={() => setOpen(true)}>{t("groups.create")}</Button>} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {groups.data.map((g) => {
              const o = overview.data?.find((x) => x.groupId === g.id);
              return (
                <Link key={g.id} href={`/teacher/groups/${g.id}`} className="rounded-2xl border bg-card p-5 transition hover:shadow-card">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="break-words font-semibold">{g.name}</div>
                      <div className="text-xs text-muted-foreground">{[g.subject, g.grade].filter(Boolean).join(" · ") || "—"}</div>
                    </div>
                    {g.pendingCount > 0 && <StatusBadge tone="warning" className="shrink-0">{t("groups.requestsCount", { count: g.pendingCount })}</StatusBadge>}
                  </div>
                  <dl className="mt-4 grid grid-cols-3 gap-2 text-center text-sm">
                    <div className="flex flex-col-reverse"><dt className="text-xs text-muted-foreground">{t("groups.statStudents")}</dt><dd className="text-lg font-semibold">{g.studentCount}</dd></div>
                    <div className="flex flex-col-reverse"><dt className="text-xs text-muted-foreground">{t("groups.statExams")}</dt><dd className="text-lg font-semibold">{o?.examCount ?? 0}</dd></div>
                    <div className="flex flex-col-reverse"><dt className="text-xs text-muted-foreground">{t("groups.statAverage")}</dt><dd className="text-lg font-semibold">{o ? `${o.averageScore}%` : "—"}</dd></div>
                  </dl>
                </Link>
              );
            })}
          </div>
        )}
      </div>
      <GroupFormDialog open={open} onOpenChange={setOpen} />
    </AppShell>
  );
}

interface GroupFormInitial {
  id: string;
  name: string;
  subject: string;
  grade: string;
  description: string | null;
  language: string;
  format: (typeof GROUP_FORMATS)[number];
  startDate: string | Date | null;
  classDays: string | null;
  classTime: string | null;
  scheduleVisible: boolean;
}

/** `startDate` ↔ a bare YYYY-MM-DD for <input type="date">; the server stores it as a timestamp. */
function dateOnly(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function GroupFormDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (v: boolean) => void; initial?: GroupFormInitial }) {
  const utils = trpc.useUtils();
  const [f, setF] = useState({
    name: initial?.name ?? "",
    subject: initial?.subject ?? "",
    grade: initial?.grade ?? "",
    description: initial?.description ?? "",
    language: initial?.language ?? "",
    format: initial?.format ?? ("ONLINE" as (typeof GROUP_FORMATS)[number]),
    startDate: dateOnly(initial?.startDate),
    classDays: initial?.classDays ?? "",
    classTime: initial?.classTime ?? "",
    scheduleVisible: initial?.scheduleVisible ?? false,
  });
  const done = () => { void utils.teacher.groups.invalidate(); onOpenChange(false); };
  const create = trpc.teacher.groups.create.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  const update = trpc.teacher.groups.update.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  const payload = () => ({ ...f, startDate: f.startDate ? new Date(f.startDate).toISOString() : null });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{initial ? t("groups.editTitle") : t("groups.newTitle")}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("common.name") })}</span><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm"><span className={fieldLabel}>{t("common.subject")}</span><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("common.gradeLevel")}</span><Input value={f.grade} onChange={(e) => setF({ ...f, grade: e.target.value })} /></label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm"><span className={fieldLabel}>{t("common.language")}</span><Input value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} placeholder={t("common.languagePlaceholder")} /></label>
            <label className="text-sm">
              <span className={fieldLabel}>{t("common.format")}</span>
              <select
                className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
                value={f.format}
                onChange={(e) => setF({ ...f, format: e.target.value as (typeof GROUP_FORMATS)[number] })}
              >
                {GROUP_FORMATS.map((v) => (
                  <option key={v} value={v}>{t(`groups.format.${v}`)}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <div className="rounded-xl border p-3">
            <div className="grid grid-cols-3 gap-3">
              <label className="text-sm"><span className={fieldLabel}>{t("common.startDate")}</span><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
              <label className="text-sm"><span className={fieldLabel}>{t("common.classDays")}</span><Input value={f.classDays} onChange={(e) => setF({ ...f, classDays: e.target.value })} placeholder={t("common.classDaysPlaceholder")} /></label>
              <label className="text-sm"><span className={fieldLabel}>{t("common.classTime")}</span><Input value={f.classTime} onChange={(e) => setF({ ...f, classTime: e.target.value })} placeholder={t("common.classTimePlaceholder")} /></label>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <label htmlFor="schedule-visible" className="flex-1 text-sm">
                <span className="block font-medium">{t("groups.scheduleVisibleLabel")}</span>
                <span className="block text-xs text-muted-foreground">{t("groups.scheduleVisibleHint")}</span>
              </label>
              <Switch id="schedule-visible" checked={f.scheduleVisible} onCheckedChange={(v) => setF({ ...f, scheduleVisible: v })} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            disabled={f.name.trim().length < 2 || create.isPending || update.isPending}
            onClick={() => (initial ? update.mutate({ id: initial.id, patch: payload() }) : create.mutate(payload()))}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmailInviteStatusBadge({ status }: { status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED" }) {
  const tone = status === "ACCEPTED" ? "success" : status === "PENDING" ? "warning" : "neutral";
  return <StatusBadge tone={tone}>{t(`groups.emailInviteStatus.${status}`)}</StatusBadge>;
}

function EmailInviteSection({ groupId }: { groupId: string }) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [freshLink, setFreshLink] = useState<{ token: string; email: string } | null>(null);
  const list = trpc.teacher.groups.emailInviteList.useQuery({ groupId });
  const refresh = () => { void utils.teacher.groups.emailInviteList.invalidate({ groupId }); };
  const create = trpc.teacher.groups.emailInviteCreate.useMutation({
    onSuccess: (res) => { setFreshLink({ token: res.token, email }); setEmail(""); refresh(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const revoke = trpc.teacher.groups.emailInviteRevoke.useMutation({ onSuccess: refresh, onError: (e) => toast.error(errorText(e)) });
  const resend = trpc.teacher.groups.emailInviteResend.useMutation({
    onSuccess: (res, vars) => {
      const invitedEmail = list.data?.find((i) => i.id === vars.inviteId)?.email ?? "";
      setFreshLink({ token: res.token, email: invitedEmail });
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });

  return (
    <section aria-labelledby="invite-email-token">
      <h3 id="invite-email-token" className="mb-2 text-sm font-medium">{t("groups.inviteByEmailLink")}</h3>
      <div className="flex gap-2">
        <Input
          type="email"
          aria-labelledby="invite-email-token"
          placeholder={t("groups.emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button disabled={!email.includes("@") || create.isPending} onClick={() => create.mutate({ groupId, email })}>
          {t("groups.sendInvite")}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("groups.emailLinkNote")}</p>

      {freshLink && (
        <div className="mt-3 rounded-xl border bg-muted/40 p-3">
          <p className="mb-2 text-xs text-foreground-secondary">{t("groups.emailLinkReady", { email: freshLink.email })}</p>
          <ShareBox path={`/invite/${freshLink.token}`} fileName={`resulio-invite-${freshLink.token.slice(0, 8)}`} />
        </div>
      )}

      {!!list.data?.length && (
        <ul className="mt-4 divide-y text-sm">
          {list.data.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="break-all">{inv.email}</div>
                <div className="text-xs text-muted-foreground">{fmtDateTime(inv.createdAt)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <EmailInviteStatusBadge status={inv.displayStatus} />
                {(inv.displayStatus === "PENDING" || inv.displayStatus === "EXPIRED") && (
                  <Button size="sm" variant="outline" disabled={resend.isPending} onClick={() => resend.mutate({ groupId, inviteId: inv.id })}>
                    {t("groups.resendInvite")}
                  </Button>
                )}
                {inv.displayStatus === "PENDING" && (
                  <Button size="sm" variant="ghost" className="text-destructive" disabled={revoke.isPending} onClick={() => revoke.mutate({ groupId, inviteId: inv.id })}>
                    {t("groups.revokeInvite")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  groupId,
  inviteCode,
  joinPolicy,
  codeActive,
  codeExpiresAt,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  groupId: string;
  inviteCode: string;
  joinPolicy: JoinPolicy;
  codeActive: boolean;
  codeExpiresAt: string | Date | null;
}) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [expiryInput, setExpiryInput] = useState(() => (codeExpiresAt ? new Date(codeExpiresAt).toISOString().slice(0, 10) : ""));
  const onGroupChange = () => void utils.teacher.groups.invalidate();
  const add = trpc.teacher.groups.addMember.useMutation({
    onSuccess: () => { toast.success(t("groups.studentAdded")); setEmail(""); onGroupChange(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const setPolicy = trpc.teacher.groups.setJoinPolicy.useMutation({ onSuccess: onGroupChange, onError: (e) => toast.error(errorText(e)) });
  const setActive = trpc.teacher.groups.setInviteCodeActive.useMutation({ onSuccess: onGroupChange, onError: (e) => toast.error(errorText(e)) });
  const setExpiry = trpc.teacher.groups.setInviteCodeExpiry.useMutation({ onSuccess: onGroupChange, onError: (e) => toast.error(errorText(e)) });
  const regenerate = trpc.teacher.groups.regenerateInviteCode.useMutation({
    onSuccess: () => { toast.success(t("groups.codeRegenerated")); setExpiryInput(""); onGroupChange(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(inviteCode);
      toast.success(t("groups.codeCopied"));
    } catch {
      toast.error(t("share.copyFailed"));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("groups.inviteTitle")}</DialogTitle></DialogHeader>
        <div className="space-y-5">
          <section aria-labelledby="invite-link">
            <h3 id="invite-link" className="mb-2 text-sm font-medium">{t("groups.inviteByLink")}</h3>
            <ShareBox path={`/join/${inviteCode}`} fileName={`resulio-group-${inviteCode}`} />
            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs text-foreground-secondary">{t("groups.inviteCodeLabel")}:</span>
              <code className="rounded bg-muted px-2 py-1 font-mono text-sm">{inviteCode}</code>
              <Button variant="outline" size="sm" onClick={() => void copyCode()}>{t("groups.copyCode")}</Button>
            </div>

            <div className="mt-3 rounded-xl border p-3">
              <label className="text-sm">
                <span className={fieldLabel}>{t("groups.joinPolicyLabel")}</span>
                <select
                  className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
                  value={joinPolicy}
                  disabled={setPolicy.isPending}
                  onChange={(e) => setPolicy.mutate({ groupId, joinPolicy: e.target.value as JoinPolicy })}
                >
                  {JOIN_POLICIES.map((p) => (
                    <option key={p} value={p}>{t(`groups.joinPolicy.${p}`)}</option>
                  ))}
                </select>
              </label>
              <p className="mt-2 text-xs text-muted-foreground">{t(`groups.joinPolicyHint.${joinPolicy}`)}</p>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
              <label htmlFor="code-active" className="flex-1 text-sm">
                <span className="block font-medium">{t("groups.codeActiveLabel")}</span>
                <span className="block text-xs text-muted-foreground">{t("groups.codeActiveHint")}</span>
              </label>
              <Switch id="code-active" checked={codeActive} disabled={setActive.isPending} onCheckedChange={(v) => setActive.mutate({ groupId, active: v })} />
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border p-3">
              <label className="flex-1 text-sm">
                <span className={fieldLabel}>{t("groups.codeExpiryLabel")}</span>
                <Input type="date" value={expiryInput} onChange={(e) => setExpiryInput(e.target.value)} />
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={setExpiry.isPending || !expiryInput}
                onClick={() => setExpiry.mutate({ groupId, expiresAt: new Date(expiryInput).toISOString() })}
              >
                {t("groups.codeExpirySet")}
              </Button>
              {!!codeExpiresAt && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={setExpiry.isPending}
                  onClick={() => { setExpiryInput(""); setExpiry.mutate({ groupId, expiresAt: null }); }}
                >
                  {t("groups.codeExpiryClear")}
                </Button>
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={regenerate.isPending}
              onClick={() => confirm(t("groups.regenerateConfirm")) && regenerate.mutate({ groupId })}
            >
              {t("groups.regenerateCode")}
            </Button>
          </section>
          <section aria-labelledby="invite-email">
            <h3 id="invite-email" className="mb-2 text-sm font-medium">{t("groups.inviteByEmail")}</h3>
            <div className="flex gap-2">
              <Input type="email" aria-labelledby="invite-email" placeholder={t("groups.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} />
              <Button disabled={!email.includes("@") || add.isPending} onClick={() => add.mutate({ groupId, email })}>{t("common.add")}</Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t("groups.emailNote")}</p>
          </section>
          <EmailInviteSection groupId={groupId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function GroupDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const utils = trpc.useUtils();
  const group = trpc.teacher.groups.detail.useQuery({ id });
  const analytics = trpc.teacher.groups.analytics.useQuery({ id });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const onDone = () => void utils.teacher.groups.invalidate();
  const approve = trpc.teacher.groups.approveMember.useMutation({ onSuccess: onDone, onError: (e) => toast.error(errorText(e)) });
  const remove = trpc.teacher.groups.removeMember.useMutation({ onSuccess: onDone, onError: (e) => toast.error(errorText(e)) });
  const g = group.data;
  const active = g?.members.filter((m) => m.status === "ACTIVE") ?? [];
  const pending = g?.members.filter((m) => m.status === "PENDING") ?? [];
  const ga = analytics.data;

  return (
    <AppShell area="teaching" title={g?.name}>
      {group.error ? (
        <ErrorNote error={group.error} />
      ) : !g ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">{[g.subject, g.grade].filter(Boolean).join(" · ")}</div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditOpen(true)}>{t("common.edit")}</Button>
              <Button onClick={() => setInviteOpen(true)}>{t("groups.invite")}</Button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t("common.students")} value={active.length} hint={pending.length ? t("groups.pendingHint", { count: pending.length }) : undefined} />
            <StatCard label={t("home.averageScore")} value={ga ? `${ga.averageScore}%` : "—"} />
            <StatCard label={t("common.exams")} value={ga?.history.length ?? 0} />
          </div>

          <Tabs defaultValue="students" className="min-h-screen">
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="students">{t("common.students")}</TabsTrigger>
              <TabsTrigger value="requests">{pending.length > 0 ? t("groups.tab.requestsCount", { count: pending.length }) : t("groups.tab.requests")}</TabsTrigger>
              <TabsTrigger value="assessments">{t("common.exams")}</TabsTrigger>
              <TabsTrigger value="analytics">{t("common.analytics")}</TabsTrigger>
            </TabsList>
            <TabsContent value="students" className="pt-3">
              <Panel>
                {!active.length ? (
                  <p className="text-sm text-muted-foreground">{t("groups.noStudents")}</p>
                ) : (
                  <div className="relative overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-muted-foreground">
                        <tr>
                          <th scope="col" className="py-2">{t("common.name")}</th>
                          <th scope="col">{t("common.email")}</th>
                          <th scope="col">{t("groups.joined")}</th>
                          <th scope="col"><span className="sr-only">{t("groups.remove")}</span></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {active.map((m) => (
                          <tr key={m.studentId}>
                            <td className="break-words py-2 pr-3">{m.name ?? "—"}</td>
                            <td className="break-all pr-3 text-muted-foreground">{m.email}</td>
                            <td className="whitespace-nowrap pr-3 text-muted-foreground">{fmtDateTime(m.joinedAt)}</td>
                            <td className="text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:bg-danger-surface hover:text-destructive"
                                aria-label={t("groups.removeStudent", { name: m.name ?? m.email ?? "" })}
                                onClick={() => confirm(t("groups.removeConfirm")) && remove.mutate({ groupId: id, studentId: m.studentId })}
                              >
                                {t("groups.remove")}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="requests" className="pt-3">
              <Panel>
                {!pending.length ? (
                  <p className="text-sm text-muted-foreground">{t("groups.noRequests")}</p>
                ) : (
                  <ul className="divide-y">
                    {pending.map((m) => (
                      <li key={m.studentId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                        <span className="min-w-0 break-words">{m.name} <span className="break-all text-muted-foreground">{m.email}</span></span>
                        <span className="flex gap-2">
                          <Button size="sm" onClick={() => approve.mutate({ groupId: id, studentId: m.studentId })}>{t("groups.approve")}</Button>
                          <Button size="sm" variant="outline" onClick={() => remove.mutate({ groupId: id, studentId: m.studentId })}>{t("groups.reject")}</Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="assessments" className="pt-3">
              <Panel>
                {!ga?.history.length ? (
                  <p className="text-sm text-muted-foreground">{t("groups.noExams")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-muted-foreground">
                        <tr>
                          <th scope="col" className="py-2">{t("common.exam")}</th>
                          <th scope="col">{t("common.status")}</th>
                          <th scope="col">{t("common.participation")}</th>
                          <th scope="col">{t("common.average")}</th>
                          <th scope="col">{t("common.median")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {ga.history.map((h) => (
                          <tr key={h.id}>
                            <td className="break-words py-2 pr-3"><Link href={`/teacher/assessments/${h.id}`} className="text-link underline-offset-4 hover:underline">{h.title}</Link></td>
                            <td className="pr-3"><StatusBadge {...liveStatus(h.liveStatus)}>{liveLabel(h.liveStatus)}</StatusBadge></td>
                            <td>{h.participationRate}%</td>
                            <td className="font-semibold">{h.averageScore}%</td>
                            <td>{h.medianScore}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="analytics" className="space-y-5 pt-3">
              {!ga ? <Loading /> : (
                <>
                  <div className="grid gap-5 lg:grid-cols-2">
                    <Panel title={t("groups.progress")}><ProgressChart data={ga.progress.map((p) => ({ label: p.label.slice(0, 16), value: p.averageScore }))} /></Panel>
                    <Panel title={t("common.ranking")}><RankingTable rows={ga.ranking} resultLink={false} /></Panel>
                  </div>
                  <div className="grid gap-5 lg:grid-cols-2">
                    <Panel title={t("common.topics")}><TopicBars rows={ga.topics} /></Panel>
                    <Panel title={t("groups.hardest")}>
                      <ul className="space-y-2 text-sm">
                        {ga.weakQuestions.map((q) => (
                          <li key={q.questionId} className="flex justify-between gap-3">
                            <span className="line-clamp-2 min-w-0 break-words" title={q.text}>{q.text}</span>
                            <span className="shrink-0 font-semibold text-destructive">{q.accuracyPercentage}%</span>
                          </li>
                        ))}
                        {!ga.weakQuestions.length && <li className="text-muted-foreground">{t("home.notEnoughData")}</li>}
                      </ul>
                    </Panel>
                  </div>
                </>
              )}
            </TabsContent>
          </Tabs>
          <InviteDialog
            open={inviteOpen}
            onOpenChange={setInviteOpen}
            groupId={id}
            inviteCode={g.inviteCode}
            joinPolicy={g.joinPolicy}
            codeActive={g.codeActive}
            codeExpiresAt={g.codeExpiresAt}
          />
          {editOpen && <GroupFormDialog open={editOpen} onOpenChange={setEditOpen} initial={g} />}
        </div>
      )}
    </AppShell>
  );
}
