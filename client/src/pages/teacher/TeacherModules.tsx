import { AppShell, EmptyState, Loading, Panel, Pill } from "@/components/AppShell";
import { draftFromQuestion, QuestionEditor } from "@/components/QuestionEditor";
import { StatusBadge } from "@/components/StatusBadge";
import { ShareBox } from "@/components/ShareBox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime, fromLocalInput, questionTypeLabel, subscriptionLabel } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { QUESTION_TYPES } from "@shared/assessment";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const fieldLabel = "text-foreground-secondary";
const filterSelect = "rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground";

function RecipientPicker({
  groupIds,
  studentIds,
  onChange,
}: {
  groupIds: string[];
  studentIds: number[];
  onChange: (v: { groupIds: string[]; studentIds: number[] }) => void;
}) {
  const groups = trpc.teacher.groups.list.useQuery();
  const students = trpc.teacher.students.useQuery();
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <fieldset>
        <legend className="mb-1 text-sm text-foreground-secondary">{t("common.groups")}</legend>
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2">
          {(groups.data ?? []).map((g) => (
            <label key={g.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-link" checked={groupIds.includes(g.id)} onChange={() => onChange({ groupIds: toggle(groupIds, g.id), studentIds })} />
              <span className="min-w-0 break-words">{g.name}</span>
            </label>
          ))}
          {!groups.data?.length && <div className="text-xs text-muted-foreground">{t("modules.noGroups")}</div>}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-sm text-foreground-secondary">{t("common.students")}</legend>
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2">
          {(students.data ?? []).map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-link" checked={studentIds.includes(s.id)} onChange={() => onChange({ groupIds, studentIds: toggle(studentIds, s.id) })} />
              <span className="min-w-0 break-words">{s.name ?? s.email}</span>
            </label>
          ))}
          {!students.data?.length && <div className="text-xs text-muted-foreground">{t("modules.noStudents")}</div>}
        </div>
      </fieldset>
    </div>
  );
}

export function AssignmentsPage() {
  const utils = trpc.useUtils();
  const list = trpc.teacher.tasks.list.useQuery();
  const [open, setOpen] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [f, setF] = useState({ title: "", description: "", instructions: "", deadline: "", groupIds: [] as string[], studentIds: [] as number[] });
  const create = trpc.teacher.tasks.create.useMutation({
    onSuccess: () => { setOpen(false); setF({ title: "", description: "", instructions: "", deadline: "", groupIds: [], studentIds: [] }); void utils.teacher.tasks.list.invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const deadline = fromLocalInput(f.deadline);
  return (
    <AppShell area="teaching">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t("modules.tasksBeta")}</p>
          <Button onClick={() => setOpen(true)}>{t("modules.newTask")}</Button>
        </div>
        {list.isLoading ? <Loading /> : !list.data?.length ? (
          <EmptyState title={t("modules.noTasks")} body={t("modules.noTasksBody")} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {list.data.map((a) => (
              <Panel key={a.id} title={a.title} action={<Pill>{t("modules.submissions", { count: a.submissions.length })}</Pill>}>
                <p className="break-words text-sm text-foreground-secondary">{a.description}</p>
                <p className="mt-2 text-xs text-muted-foreground">{t("modules.deadlineValue", { date: fmtDateTime(a.deadline) })}</p>
                <div className="mt-3">
                  <Button size="sm" variant="outline" onClick={() => setShareId(shareId === a.id ? null : a.id)}>{t("common.share")}</Button>
                  {shareId === a.id && (
                    <div className="mt-3">
                      <ShareBox path={`/task/${a.shareCode}`} fileName={`resulio-task-${a.shareCode}`} />
                    </div>
                  )}
                </div>
              </Panel>
            ))}
          </div>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{t("modules.newTaskTitle")}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("common.name") })}</span><Input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("modules.deadline") })}</span><Input required type="datetime-local" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></label>
            <RecipientPicker groupIds={f.groupIds} studentIds={f.studentIds} onChange={(v) => setF({ ...f, ...v })} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button
              disabled={f.title.trim().length < 2 || !deadline || create.isPending}
              onClick={() => deadline && create.mutate({ title: f.title, description: f.description, instructions: f.instructions, deadline, groupIds: f.groupIds, studentIds: f.studentIds, attachments: [] })}
            >
              {t("common.send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

export function LibraryPage() {
  return (
    <AppShell area="teaching">
      <Tabs defaultValue="bank" className="min-h-screen">
        <TabsList>
          <TabsTrigger value="bank">{t("modules.questionBank")}</TabsTrigger>
          <TabsTrigger value="materials">{t("nav.materials")}</TabsTrigger>
        </TabsList>
        <TabsContent value="bank" className="pt-3"><QuestionBankTab /></TabsContent>
        <TabsContent value="materials" className="pt-3"><MaterialsTab /></TabsContent>
      </Tabs>
    </AppShell>
  );
}

function QuestionBankTab() {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [source, setSource] = useState("");
  const bank = trpc.teacher.questions.bank.useQuery({ search: search || undefined, type: (type || undefined) as never, source: (source || undefined) as never });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const done = () => { setEditing(null); void utils.teacher.questions.bank.invalidate(); };
  const create = trpc.teacher.questions.create.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  const update = trpc.teacher.questions.update.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder={t("common.search")} aria-label={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={filterSelect} aria-label={t("modules.filterType")} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">{t("modules.allTypes")}</option>
          {QUESTION_TYPES.map((k) => <option key={k} value={k}>{questionTypeLabel(k)}</option>)}
        </select>
        <select className={filterSelect} aria-label={t("modules.filterSource")} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">{t("modules.allSources")}</option>
          <option value="MANUAL">{t("modules.sourceManual")}</option>
          <option value="AI">AI</option>
        </select>
        <Button className="ml-auto" onClick={() => setEditing("new")}>{t("modules.newQuestion")}</Button>
      </div>
      {editing === "new" && (
        <Panel title={t("modules.newQuestionTitle")}><QuestionEditor busy={create.isPending} onCancel={() => setEditing(null)} onSubmit={(question) => create.mutate({ question })} /></Panel>
      )}
      <Panel>
        {bank.isLoading ? <Loading /> : !bank.data?.length ? <p className="text-sm text-muted-foreground">{t("modules.noQuestions")}</p> : (
          <ul className="divide-y">
            {bank.data.map((q) => (
              <li key={q.id} className="py-3">
                {editing === q.id ? (
                  <QuestionEditor initial={draftFromQuestion(q)} busy={update.isPending} onCancel={() => setEditing(null)} onSubmit={(question) => update.mutate({ id: q.id, question })} />
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="whitespace-pre-wrap break-words text-sm">{q.text}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span>{questionTypeLabel(q.type)}</span><span>· {t("common.points", { count: q.points })}</span>
                        {q.topic && <span>· {q.topic}</span>}{q.skill && <span>· {q.skill}</span>}
                        {q.source === "AI" && <StatusBadge tone="info" icon={Sparkles}>AI</StatusBadge>}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setEditing(q.id)}>{t("common.edit")}</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function MaterialsTab() {
  const utils = trpc.useUtils();
  const list = trpc.teacher.tasks.materials.useQuery();
  const [open, setOpen] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [f, setF] = useState({ title: "", description: "", subject: "", topic: "", fileName: "", groupIds: [] as string[], studentIds: [] as number[] });
  const create = trpc.teacher.tasks.createMaterial.useMutation({
    onSuccess: () => { setOpen(false); void utils.teacher.tasks.materials.invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("modules.materialsBeta")}</p>
        <Button onClick={() => setOpen(true)}>{t("modules.newMaterial")}</Button>
      </div>
      {!list.data?.length ? <EmptyState title={t("modules.noMaterials")} body={t("modules.noMaterialsBody")} /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((m) => (
            <Panel key={m.id} title={m.title}>
              <p className="break-words text-sm text-foreground-secondary">{m.description}</p>
              <p className="mt-2 break-words text-xs text-muted-foreground">{[m.subject, m.topic, m.fileName].filter(Boolean).join(" · ")}</p>
              <div className="mt-3">
                <Button size="sm" variant="outline" onClick={() => setShareId(shareId === m.id ? null : m.id)}>{t("common.share")}</Button>
                {shareId === m.id && (
                  <div className="mt-3">
                    <ShareBox path={`/material/${m.shareCode}`} fileName={`resulio-material-${m.shareCode}`} />
                  </div>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{t("modules.newMaterialTitle")}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("common.name") })}</span><Input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm"><span className={fieldLabel}>{t("common.subject")}</span><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
              <label className="text-sm"><span className={fieldLabel}>{t("common.topic")}</span><Input value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} /></label>
            </div>
            <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("modules.fileName") })}</span><Input required value={f.fileName} onChange={(e) => setF({ ...f, fileName: e.target.value })} placeholder={t("modules.fileNamePlaceholder")} /></label>
            <RecipientPicker groupIds={f.groupIds} studentIds={f.studentIds} onChange={(v) => setF({ ...f, ...v })} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button disabled={f.title.trim().length < 2 || !f.fileName.trim() || create.isPending} onClick={() => create.mutate(f)}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function UsagePage() {
  const workspace = trpc.teacher.workspace.useQuery();
  const w = workspace.data;
  const u = w?.usage;
  return (
    <AppShell area="teaching">
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={t("modules.plan")}>
          {!w ? <Loading /> : (
            <>
              <div className="break-words text-sm text-muted-foreground">{w.title}</div>
              <div className="text-2xl font-semibold">{subscriptionLabel(w.subscriptionStatus)}</div>
              <p className="mt-2 text-sm text-muted-foreground">{t("modules.planNote")}</p>
            </>
          )}
        </Panel>
        <Panel title={t("modules.aiUsage")}>
          {!u ? <Loading /> : (
            <>
              <div className="text-2xl font-semibold">{u.used} / {u.limit}</div>
              <div
                className="mt-3 h-2 rounded-full bg-muted"
                role="progressbar"
                aria-label={t("modules.aiUsageBar", { used: u.used, limit: u.limit })}
                aria-valuemin={0}
                aria-valuemax={u.limit}
                aria-valuenow={u.used}
              >
                <div className="h-2 rounded-full bg-link" style={{ width: `${Math.min(100, (u.used / u.limit) * 100)}%` }} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t("modules.aiUsageNote")}</p>
            </>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
