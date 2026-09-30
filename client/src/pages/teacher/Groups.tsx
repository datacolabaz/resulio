import { ProgressChart, RankingTable, TopicBars } from "@/components/AnalyticsBlocks";
import { AppShell, EmptyState, ErrorNote, Loading, Panel, Pill, StatCard } from "@/components/AppShell";
import { ShareBox } from "@/components/ShareBox";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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

function GroupFormDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (v: boolean) => void; initial?: { id: string; name: string; subject: string; grade: string; description: string | null } }) {
  const utils = trpc.useUtils();
  const [f, setF] = useState({ name: initial?.name ?? "", subject: initial?.subject ?? "", grade: initial?.grade ?? "", description: initial?.description ?? "" });
  const done = () => { void utils.teacher.groups.invalidate(); onOpenChange(false); };
  const create = trpc.teacher.groups.create.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  const update = trpc.teacher.groups.update.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{initial ? t("groups.editTitle") : t("groups.newTitle")}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("common.name") })}</span><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm"><span className={fieldLabel}>{t("common.subject")}</span><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("common.gradeLevel")}</span><Input value={f.grade} onChange={(e) => setF({ ...f, grade: e.target.value })} /></label>
          </div>
          <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            disabled={f.name.trim().length < 2 || create.isPending || update.isPending}
            onClick={() => (initial ? update.mutate({ id: initial.id, patch: f }) : create.mutate(f))}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({ open, onOpenChange, groupId, inviteCode }: { open: boolean; onOpenChange: (v: boolean) => void; groupId: string; inviteCode: string }) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const add = trpc.teacher.groups.addMember.useMutation({
    onSuccess: () => { toast.success(t("groups.studentAdded")); setEmail(""); void utils.teacher.groups.invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t("groups.inviteTitle")}</DialogTitle></DialogHeader>
        <div className="space-y-5">
          <section aria-labelledby="invite-link">
            <h3 id="invite-link" className="mb-2 text-sm font-medium">{t("groups.inviteByLink")}</h3>
            <ShareBox path={`/join/${inviteCode}`} fileName={`resulio-group-${inviteCode}`} />
            <p className="mt-2 text-xs text-muted-foreground">{t("groups.inviteLinkNote", { code: inviteCode })}</p>
          </section>
          <section aria-labelledby="invite-email">
            <h3 id="invite-email" className="mb-2 text-sm font-medium">{t("groups.inviteByEmail")}</h3>
            <div className="flex gap-2">
              <Input type="email" aria-labelledby="invite-email" placeholder={t("groups.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} />
              <Button disabled={!email.includes("@") || add.isPending} onClick={() => add.mutate({ groupId, email })}>{t("common.add")}</Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t("groups.emailNote")}</p>
          </section>
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
          <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} groupId={id} inviteCode={g.inviteCode} />
          {editOpen && <GroupFormDialog open={editOpen} onOpenChange={setEditOpen} initial={g} />}
        </div>
      )}
    </AppShell>
  );
}
