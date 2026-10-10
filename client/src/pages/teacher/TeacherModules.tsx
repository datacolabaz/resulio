import { PlaceBadge } from "@/components/ActivityBlocks";
import { AppShell, EmptyState, Loading, Panel, Pill } from "@/components/AppShell";
import { MultiFileUpload, SingleFileUpload } from "@/components/FileUpload";
import { CompactGroupStudentPicker, GroupStudentPicker, useGroupStudentTargets } from "@/components/GroupStudentPicker";
import { draftFromQuestion, QuestionEditor } from "@/components/QuestionEditor";
import { StatusBadge } from "@/components/StatusBadge";
import { ShareBox, ShareFunnelSummary } from "@/components/ShareBox";
import { MaterialUsageBadge, useMaterialSyllabusUsage } from "@/components/syllabus/CrossLinks";
import { SubmissionReview } from "@/components/SubmissionReview";
import { TaskEngagementList } from "@/components/TaskEngagementList";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { QuestionPreview } from "@/components/questionBank/QuestionPreview";
import { bankLabel, SectionPicker, SectionSelect, TopicManagerDialog, TopicSelect, useTopics } from "@/components/questionBank/Topics";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime, fromLocalInput, questionTypeLabel, subscriptionLabel, toLocalInput } from "@/lib/format";
import { recipientsPayload } from "@/lib/groupStudentSelection";
import { fileDownloadUrl } from "@/lib/uploadFile";
import { trpc } from "@/lib/trpc";
import { QUESTION_TYPES } from "@shared/assessment";
import { FileUp, FolderTree, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";

const fieldLabel = "text-foreground-secondary";
const filterSelect = "rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground";

type TaskAccessMode = "PUBLIC" | "GROUPS";

function AccessModePicker({ value, onChange }: { value: TaskAccessMode; onChange: (v: TaskAccessMode) => void }) {
  const options: Array<{ mode: TaskAccessMode; label: string; hint: string }> = [
    { mode: "PUBLIC", label: t("modules.accessPublic"), hint: t("modules.accessPublicHint") },
    { mode: "GROUPS", label: t("modules.accessGroups"), hint: t("modules.accessGroupsHint") },
  ];
  return (
    <fieldset>
      <legend className="mb-1 text-sm text-foreground-secondary">{t("modules.accessTitle")}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.mode}
            className={`flex cursor-pointer gap-2 rounded-lg border p-2.5 text-sm ${value === o.mode ? "border-link bg-muted" : "border-border"}`}
          >
            <input type="radio" name="task-access-mode" className="mt-0.5 accent-link" checked={value === o.mode} onChange={() => onChange(o.mode)} />
            <span className="min-w-0">
              <span className="block font-medium">{o.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Open-link vs. selected-groups badge on a task card. */
function AccessBadge({ accessMode, groupIds, groupNames }: { accessMode: TaskAccessMode; groupIds: string[]; groupNames: Map<string, string> }) {
  if (accessMode === "PUBLIC") return <Pill>{t("modules.accessBadgePublic")}</Pill>;
  const names = groupIds.map((id) => groupNames.get(id)).filter((n): n is string => !!n);
  return <Pill className="max-w-full break-words">{t("modules.accessBadgeGroups", { groups: names.join(", ") || "—" })}</Pill>;
}

interface AssignmentInitial {
  id: string;
  title: string;
  description: string;
  instructions: string;
  deadline: Date | string;
  groupIds: string[];
  studentIds: number[];
  attachments: Array<{ fileId: string; name: string; size: number }>;
  accessMode: TaskAccessMode;
}

function AssignmentFormDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (v: boolean) => void; initial?: AssignmentInitial }) {
  const utils = trpc.useUtils();
  const [f, setF] = useState({
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    instructions: initial?.instructions ?? "",
    deadline: initial ? toLocalInput(initial.deadline) : "",
    attachments: (initial?.attachments ?? []).map((a) => ({ ...a, mimeType: "" })),
    accessMode: initial?.accessMode ?? ("PUBLIC" as TaskAccessMode),
  });
  // A restricted task ignores individual students, so leftovers from open-link days don't reopen as picks.
  const targets = useGroupStudentTargets(initial && { groupIds: initial.groupIds, studentIds: initial.accessMode === "GROUPS" ? [] : initial.studentIds });
  const groupsOnly = f.accessMode === "GROUPS";
  const done = () => { void utils.teacher.tasks.list.invalidate(); onOpenChange(false); };
  const create = trpc.teacher.tasks.create.useMutation({ onError: (e) => toast.error(errorText(e)) });
  const update = trpc.teacher.tasks.update.useMutation({ onError: (e) => toast.error(errorText(e)) });
  const keyQ = trpc.teacher.tasks.answerKey.useQuery({ taskId: initial?.id }, { enabled: open, refetchOnWindowFocus: false });
  const [answerKey, setAnswerKey] = useState<string | null>(null);
  const [keyFromAi, setKeyFromAi] = useState(false);
  const [notifyStudents, setNotifyStudents] = useState(true);
  const keyText = answerKey ?? keyQ.data?.text ?? "";
  useEffect(() => {
    if (open) return;
    setAnswerKey(null);
    setKeyFromAi(false);
    setNotifyStudents(true);
  }, [open]);
  const saveKey = trpc.teacher.tasks.saveAnswerKey.useMutation();
  const draftKey = trpc.teacher.tasks.draftAnswerKey.useMutation({
    onSuccess: (r) => {
      setAnswerKey(r.text);
      setKeyFromAi(true);
      toast.success(t("modules.answerKeyAiDone"));
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const keyAvailable = !!keyQ.data?.available;
  const showAiDraftBadge = keyFromAi || (keyQ.data?.source === "AI_DRAFT" && answerKey === null);
  // Saving the form marks an AI draft as reviewed.
  const keyNeedsSave = keyAvailable && (keyText.trim() !== (keyQ.data?.text ?? "").trim() || keyQ.data?.source === "AI_DRAFT");
  const deadline = fromLocalInput(f.deadline);
  const missingGroups = groupsOnly && !targets.selection.groupIds.length;
  const submit = async () => {
    if (!deadline) return;
    const attachments = f.attachments.map(({ fileId, name, size }) => ({ fileId, name, size }));
    const payload = {
      title: f.title,
      description: f.description,
      instructions: f.instructions,
      deadline,
      ...recipientsPayload(targets.selection, targets.students, { kept: targets.kept, groupsOnly }),
      attachments,
      accessMode: f.accessMode,
    };
    let row: { id: string };
    try {
      row = initial ? await update.mutateAsync({ id: initial.id, patch: payload, notifyStudents }) : await create.mutateAsync({ ...payload, notifyStudents });
    } catch {
      return;
    }
    if (keyNeedsSave && (initial || keyText.trim())) {
      try {
        await saveKey.mutateAsync({ taskId: row.id, text: keyText });
      } catch {
        toast.error(t("modules.answerKeySaveFailed"));
      }
    }
    done();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{initial ? t("modules.editTaskTitle") : t("modules.newTaskTitle")}</DialogTitle></DialogHeader>
        <DialogBody className="grid content-start gap-3">
          <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("common.name") })}</span><Input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("modules.deadline") })}</span><Input required type="datetime-local" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></label>
          <div>
            <p className={`mb-1 text-sm ${fieldLabel}`}>{t("modules.attachments")}</p>
            <MultiFileUpload context="task-attachment" value={f.attachments} onChange={(attachments) => setF({ ...f, attachments })} />
          </div>
          <div className="text-sm">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="task-answer-key" className={fieldLabel}>{t("modules.answerKey")}</label>
              {showAiDraftBadge && <StatusBadge tone="warning">{t("modules.answerKeyAiDraftBadge")}</StatusBadge>}
            </div>
            <Textarea
              id="task-answer-key"
              rows={5}
              maxLength={8000}
              disabled={!keyAvailable || draftKey.isPending}
              placeholder={t("modules.answerKeyPlaceholder")}
              value={keyText}
              onChange={(e) => setAnswerKey(e.target.value)}
            />
            {keyQ.data && !keyAvailable && <p className="mt-1 text-xs text-muted-foreground">{t("modules.answerKeyUnavailable")}</p>}
            {keyAvailable && (
              <>
                <p className="mt-1 text-xs text-muted-foreground">{t("modules.answerKeyHelp")}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!keyQ.data?.aiEnabled || f.title.trim().length < 2 || draftKey.isPending}
                    onClick={() => {
                      if (keyText.trim() && !confirm(t("modules.answerKeyReplaceConfirm"))) return;
                      draftKey.mutate({
                        title: f.title,
                        description: [f.description, f.instructions].filter(Boolean).join("\n\n"),
                        attachments: f.attachments.map(({ fileId, name }) => ({ fileId, name })),
                      });
                    }}
                  >
                    <Sparkles className="mr-1 h-4 w-4" />
                    {draftKey.isPending ? t("modules.answerKeyAiWorking") : t("modules.answerKeyAi")}
                  </Button>
                  {!keyQ.data?.aiEnabled && <span className="text-xs text-muted-foreground">{t("aiReview.disabledNote")}</span>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t("modules.answerKeyDatasetNote")}</p>
              </>
            )}
          </div>
          <AccessModePicker value={f.accessMode} onChange={(accessMode) => setF({ ...f, accessMode })} />
          <GroupStudentPicker
            groups={targets.groups}
            students={targets.students}
            value={targets.selection}
            onChange={targets.setSelection}
            groupsOnly={groupsOnly}
            keptCount={targets.kept.length}
            hints={groupsOnly ? { whole: t("modules.taskGroupsOnlyHint"), partial: t("modules.taskGroupsOnlyHint") } : { whole: t("modules.taskGroupWhole"), partial: t("modules.taskGroupPartial") }}
            summary
          />
          {missingGroups && <p role="alert" className="text-xs text-destructive">{t("modules.accessGroupsRequired")}</p>}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 accent-link" checked={notifyStudents} onChange={(e) => setNotifyStudents(e.target.checked)} />
            <span className="min-w-0">
              <span className="block">{t("modules.notifyStudents")}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t(initial ? "modules.notifyStudentsHintEdit" : "modules.notifyStudentsHint")}</span>
            </span>
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            disabled={f.title.trim().length < 2 || !deadline || missingGroups || !targets.ready || create.isPending || update.isPending || saveKey.isPending || draftKey.isPending}
            onClick={() => void submit()}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Places 1–3 by first submission time (resubmissions don't count). */
function submissionPlaces(subs: Array<{ id: string; firstSubmittedAt: Date | null; submittedAt: Date | null }>) {
  const timed = subs
    .map((s) => ({ id: s.id, at: s.firstSubmittedAt ?? s.submittedAt }))
    .filter((s): s is { id: string; at: Date } => !!s.at)
    .sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
  return new Map(timed.slice(0, 3).map((s, i) => [s.id, i + 1]));
}

export function AssignmentsPage() {
  const utils = trpc.useUtils();
  const list = trpc.teacher.tasks.list.useQuery();
  const students = trpc.teacher.students.useQuery();
  const studentByI = new Map((students.data ?? []).map((s) => [s.id, s]));
  const groupsQ = trpc.teacher.groups.list.useQuery();
  const groupNames = new Map((groupsQ.data ?? []).map((g) => [g.id, g.name]));
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AssignmentInitial | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [submissionsId, setSubmissionsId] = useState<string | null>(null);
  const activityQ = trpc.teacher.tasks.activity.useQuery({ id: submissionsId ?? "" }, { enabled: !!submissionsId });
  const reviewsQ = trpc.teacher.tasks.reviews.useQuery(
    { taskId: submissionsId ?? "" },
    { enabled: !!submissionsId, refetchInterval: (q) => (q.state.data?.reviews.some((r) => r.status === "PENDING" && !r.stale) ? 4000 : false) },
  );
  const reviewBySubmission = new Map((reviewsQ.data?.reviews ?? []).map((r) => [r.submissionId, r]));
  // A finished review may have auto-graded its submission; reload the grades shown on the cards.
  const pendingReviews = (reviewsQ.data?.reviews ?? []).filter((r) => r.status === "PENDING").length;
  const lastPending = useRef(pendingReviews);
  useEffect(() => {
    if (pendingReviews < lastPending.current) void utils.teacher.tasks.list.invalidate();
    lastPending.current = pendingReviews;
  }, [pendingReviews, utils]);
  const refreshReviews = () => { void utils.teacher.tasks.list.invalidate(); void reviewsQ.refetch(); };
  const setAutoGrade = trpc.teacher.tasks.setAutoGrade.useMutation({
    onSuccess: () => void reviewsQ.refetch(),
    onError: (e) => toast.error(errorText(e)),
  });
  const engagementQ = trpc.teacher.tasks.engagement.useQuery({ id: shareId ?? "" }, { enabled: !!shareId, refetchInterval: 30_000 });
  const remove = trpc.teacher.tasks.remove.useMutation({
    onSuccess: () => void utils.teacher.tasks.list.invalidate(),
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <AppShell area="teaching">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button onClick={() => setOpen(true)}>{t("modules.newTask")}</Button>
        </div>
        {list.isLoading ? <Loading /> : !list.data?.length ? (
          <EmptyState title={t("modules.noTasks")} body={t("modules.noTasksBody")} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {list.data.map((a) => (
              <Panel
                key={a.id}
                title={a.title}
                action={
                  <button
                    type="button"
                    className="cursor-pointer disabled:cursor-default"
                    aria-label={t("modules.viewSubmissions")}
                    onClick={() => setSubmissionsId(submissionsId === a.id ? null : a.id)}
                  >
                    <Pill>{t("modules.submissions", { count: a.submissions.length })}</Pill>
                  </button>
                }
              >
                <p className="break-words text-sm text-foreground-secondary">{a.description}</p>
                <p className="mt-2 text-xs text-muted-foreground">{t("modules.deadlineValue", { date: fmtDateTime(a.deadline) })}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <AccessBadge accessMode={a.accessMode} groupIds={a.groupIds} groupNames={groupNames} />
                  {a.answerKeyState === "AI_DRAFT" && (
                    <button type="button" className="cursor-pointer" onClick={() => setEditing(a)}>
                      <StatusBadge tone="warning">{t("modules.answerKeyAiDraftBadge")}</StatusBadge>
                    </button>
                  )}
                  {a.answerKeyState === "GENERATING" && <span className="text-xs text-muted-foreground">{t("modules.answerKeyGenerating")}</span>}
                </div>
                {a.attachments.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {a.attachments.map((file) => (
                      <li key={file.fileId}>
                        <a href={fileDownloadUrl(file.fileId)} className="rounded-lg border border-border bg-muted px-2 py-1 text-xs text-link underline-offset-2 hover:underline">
                          {file.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                {submissionsId === a.id && a.submissions.length > 0 && (
                  <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
                    {a.submissions.map((s) => {
                      const student = studentByI.get(s.studentId);
                      const place = submissionPlaces(a.submissions).get(s.id);
                      return (
                        <li key={s.id} className="p-2.5 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="min-w-0 break-words font-medium">{student?.name ?? student?.email ?? `#${s.studentId}`}</span>
                              {place && <PlaceBadge place={place} />}
                            </span>
                            {s.status === "LATE" ? <StatusBadge tone="warning">{t("student.late")}</StatusBadge> : <StatusBadge tone="success">{t("student.onTime")}</StatusBadge>}
                          </div>
                          {s.submittedAt && <p className="mt-1 text-xs text-muted-foreground">{t("modules.submittedAt", { date: fmtDateTime(s.submittedAt) })}</p>}
                          {s.files.length > 0 && (
                            <ul className="mt-1.5 flex flex-wrap gap-1.5">
                              {s.files.map((file) => (
                                <li key={file.fileId}>
                                  <a href={fileDownloadUrl(file.fileId)} className="rounded-lg border border-border bg-muted px-2 py-1 text-xs text-link underline-offset-2 hover:underline">
                                    {file.name}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          )}
                          <SubmissionReview
                            key={`${s.id}:${s.gradedAt ?? ""}`}
                            submission={s}
                            review={reviewBySubmission.get(s.id)}
                            autoGrade={!!reviewsQ.data?.autoGrade.enabled}
                            onChanged={refreshReviews}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
                {submissionsId === a.id && a.submissions.length > 0 && reviewsQ.data && !reviewsQ.data.ai.enabled && (
                  <p className="mt-2 text-xs text-muted-foreground">{t("aiReview.disabledNote")}</p>
                )}
                {submissionsId === a.id && reviewsQ.data?.ai.enabled && (
                  <div className="mt-2 text-xs">
                    <label className="flex items-center gap-2" title={t("aiReview.autoGradeHelp")}>
                      <input
                        type="checkbox"
                        className="accent-link"
                        disabled={setAutoGrade.isPending || !reviewsQ.data.autoGrade.available}
                        checked={reviewsQ.data.autoGrade.enabled}
                        onChange={(e) => setAutoGrade.mutate({ taskId: a.id, enabled: e.target.checked })}
                      />
                      {t("aiReview.autoGrade")}
                    </label>
                    {!reviewsQ.data.autoGrade.available && <p className="mt-1 text-muted-foreground">{t("aiReview.autoGradeUnavailable")}</p>}
                  </div>
                )}
                {submissionsId === a.id && !!activityQ.data?.eligible.length && (() => {
                  const submittedIds = new Set(a.submissions.map((s) => s.studentId));
                  const viewedNotSubmitted = activityQ.data!.eligible.filter((e) => e.viewedAt && !submittedIds.has(e.studentId));
                  const notViewed = activityQ.data!.eligible.filter((e) => !e.viewedAt && !submittedIds.has(e.studentId));
                  if (!viewedNotSubmitted.length && !notViewed.length) return null;
                  return (
                    <div className="mt-3 space-y-2 text-xs">
                      {viewedNotSubmitted.length > 0 && (
                        <div>
                          <p className="font-medium text-foreground-secondary">{t("modules.viewedNotSubmitted")}</p>
                          <p className="mt-1 break-words text-muted-foreground">{viewedNotSubmitted.map((e) => e.name ?? e.email ?? `#${e.studentId}`).join(", ")}</p>
                        </div>
                      )}
                      {notViewed.length > 0 && (
                        <div>
                          <p className="font-medium text-foreground-secondary">{t("modules.notViewed")}</p>
                          <p className="mt-1 break-words text-muted-foreground">{notViewed.map((e) => e.name ?? e.email ?? `#${e.studentId}`).join(", ")}</p>
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setShareId(shareId === a.id ? null : a.id)}>{t("common.share")}</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(a)}>{t("common.edit")}</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-danger-surface hover:text-destructive"
                    disabled={remove.isPending}
                    onClick={() => confirm(t("modules.deleteTaskConfirm")) && remove.mutate({ id: a.id })}
                  >
                    {t("common.delete")}
                  </Button>
                </div>
                {shareId === a.id && (
                  <div className="mt-3">
                    <ShareBox
                      path={`/task/${a.shareCode}`}
                      fileName={`resulio-task-${a.shareCode}`}
                      tracking={{ targetType: "TASK", targetId: a.shareCode, campaign: "task_share" }}
                      onTracked={() => void engagementQ.refetch()}
                    />
                    <ShareFunnelSummary data={engagementQ.data?.funnel} showSubmitted />
                    <TaskEngagementList data={engagementQ.data} />
                  </div>
                )}
              </Panel>
            ))}
          </div>
        )}
      </div>
      {open && <AssignmentFormDialog open onOpenChange={setOpen} />}
      {editing && <AssignmentFormDialog open onOpenChange={(v) => !v && setEditing(null)} initial={editing} />}
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
  const [topicId, setTopicId] = useState("");
  const topics = useTopics();
  const topicList = topics.data ?? [];
  const bank = trpc.teacher.questions.bank.useQuery({
    search: search || undefined,
    type: (type || undefined) as never,
    source: (source || undefined) as never,
    topicId: topicId || undefined,
  });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [newSection, setNewSection] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [topicsOpen, setTopicsOpen] = useState(false);
  const done = () => {
    setEditing(null);
    void utils.teacher.questions.bank.invalidate();
    void utils.teacher.questionTopics.list.invalidate();
  };
  const create = trpc.teacher.questions.create.useMutation({
    onSuccess: (q) => {
      done();
      const label = bankLabel(topicList, q);
      if (label) toast.success(t("qbank.filedAs", { ref: label }));
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const update = trpc.teacher.questions.update.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  const move = trpc.teacher.questionTopics.move.useMutation({
    onSuccess: (r) => {
      toast.success(t("qbank.moved", { count: r.count }));
      setSelected(new Set());
      done();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const rows = bank.data ?? [];
  const toggle = (id: string, on: boolean) => setSelected((cur) => { const next = new Set(cur); if (on) next.add(id); else next.delete(id); return next; });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder={t("common.search")} aria-label={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <TopicSelect topics={topicList} value={topicId} onChange={setTopicId} emptyLabel={t("qbank.allTopics")} ariaLabel={t("qbank.filterTopic")} className={`max-w-[16rem] ${filterSelect}`} />
        <select className={filterSelect} aria-label={t("modules.filterType")} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">{t("modules.allTypes")}</option>
          {QUESTION_TYPES.map((k) => <option key={k} value={k}>{questionTypeLabel(k)}</option>)}
        </select>
        <select className={filterSelect} aria-label={t("modules.filterSource")} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">{t("modules.allSources")}</option>
          <option value="MANUAL">{t("modules.sourceManual")}</option>
          <option value="AI">AI</option>
        </select>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setTopicsOpen(true)}><FolderTree className="mr-1 h-4 w-4" aria-hidden />{t("qbank.topics.manage")}</Button>
          <Button variant="outline" asChild><Link href="/teacher/library/import"><FileUp className="mr-1 h-4 w-4" aria-hidden />{t("qimport.open")}</Link></Button>
          <Button onClick={() => setEditing("new")}>{t("modules.newQuestion")}</Button>
        </div>
      </div>
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted p-3 text-sm">
          <span>{t("qbank.selected", { count: selected.size })}</span>
          <SectionSelect
            topics={topicList}
            value=""
            disabled={move.isPending}
            onChange={(sectionId) => sectionId && move.mutate({ questionIds: [...selected], sectionId })}
            emptyLabel={t("qbank.moveTo")}
            ariaLabel={t("qbank.moveTo")}
            className={filterSelect}
          />
          <span className="text-xs text-muted-foreground">{t("qbank.moveNote")}</span>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{t("common.cancel")}</Button>
        </div>
      )}
      {editing === "new" && (
        <Panel title={t("modules.newQuestionTitle")}>
          <SectionPicker className="mb-4" value={newSection} onChange={setNewSection} />
          {newSection ? (
            <QuestionEditor hideTopic busy={create.isPending} onCancel={() => setEditing(null)} onSubmit={(question) => create.mutate({ question, sectionId: newSection })} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("qbank.pickSectionFirst")}</p>
          )}
        </Panel>
      )}
      <Panel>
        {bank.isLoading ? <Loading /> : !rows.length ? <p className="text-sm text-muted-foreground">{t("modules.noQuestions")}</p> : (
          <ul className="divide-y">
            <li className="pb-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" className="accent-link" checked={rows.every((q) => selected.has(q.id))} onChange={(e) => setSelected(new Set(e.target.checked ? rows.map((q) => q.id) : []))} />
                {t("qbank.selectAll")}
              </label>
            </li>
            {rows.map((q) => (
              <li key={q.id} className="py-3">
                {editing === q.id ? (
                  <QuestionEditor hideTopic={!!q.sectionId} initial={draftFromQuestion(q)} busy={update.isPending} onCancel={() => setEditing(null)} onSubmit={(question) => update.mutate({ id: q.id, question })} />
                ) : (
                  <div className="flex items-start gap-3">
                    <input type="checkbox" className="mt-1 accent-link" aria-label={t("qbank.selectQuestion")} checked={selected.has(q.id)} onChange={(e) => toggle(q.id, e.target.checked)} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-link">{bankLabel(topicList, q) ?? t("qbank.unsorted")}</div>
                      <QuestionPreview q={q} onChangeAnswer={() => setEditing(q.id)} />
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span>{questionTypeLabel(q.type)}</span><span>· {t("common.points", { count: q.points })}</span>
                        {!q.sectionId && q.topic && <span>· {q.topic}</span>}{q.skill && <span>· {q.skill}</span>}
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
      <TopicManagerDialog open={topicsOpen} onOpenChange={setTopicsOpen} />
    </div>
  );
}

interface MaterialInitial {
  id: string;
  title: string;
  description: string;
  subject: string;
  topic: string;
  fileName: string;
  fileId: string | null;
  groupIds: string[];
  studentIds: number[];
}

function MaterialFormDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (v: boolean) => void; initial?: MaterialInitial }) {
  const utils = trpc.useUtils();
  const [f, setF] = useState({
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    subject: initial?.subject ?? "",
    topic: initial?.topic ?? "",
    file: initial?.fileId ? { fileId: initial.fileId, name: initial.fileName, size: 0, mimeType: "" } : null,
  });
  const targets = useGroupStudentTargets(initial);
  const done = () => { void utils.teacher.tasks.materials.invalidate(); onOpenChange(false); };
  const create = trpc.teacher.tasks.createMaterial.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  const update = trpc.teacher.tasks.updateMaterial.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{initial ? t("modules.editMaterialTitle") : t("modules.newMaterialTitle")}</DialogTitle></DialogHeader>
        <DialogBody className="grid content-start gap-4">
          <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("modules.materialName") })}</span><Input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <div>
            <p className={`mb-1 text-sm ${fieldLabel}`}>{t("common.required", { label: t("modules.fileName") })}</p>
            <SingleFileUpload context="material" value={f.file} onChange={(file) => setF({ ...f, file })} />
          </div>
          <section aria-labelledby="material-sharing" className="grid gap-2 border-t pt-3">
            <h3 id="material-sharing" className="text-sm font-semibold">{t("modules.materialSharing")}</h3>
            <CompactGroupStudentPicker
              groups={targets.groups}
              students={targets.students}
              value={targets.selection}
              onChange={targets.setSelection}
              keptCount={targets.kept.length}
              hints={{ whole: t("modules.materialGroupWhole"), partial: t("modules.materialGroupPartial") }}
            />
          </section>
          <Accordion type="single" collapsible defaultValue={initial?.description || initial?.subject || initial?.topic ? "details" : undefined}>
            <AccordionItem value="details" className="rounded-lg border px-3 last:border-b">
              <AccordionTrigger className="py-3">
                <span className="min-w-0">
                  <span className="block">{t("modules.advancedOptions")}</span>
                  <span className="block text-xs font-normal text-muted-foreground">{t("modules.advancedOptionsHint")}</span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="grid gap-3">
                <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm"><span className={fieldLabel}>{t("common.subject")}</span><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
                  <label className="text-sm"><span className={fieldLabel}>{t("common.topic")}</span><Input value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} /></label>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            disabled={f.title.trim().length < 2 || !f.file || !targets.ready || create.isPending || update.isPending}
            onClick={() => {
              if (!f.file) return;
              const file = { fileName: f.file.name, fileId: f.file.fileId, mimeType: f.file.mimeType || null, sizeBytes: f.file.size || null };
              const payload = {
                title: f.title,
                description: f.description,
                subject: f.subject,
                topic: f.topic,
                ...recipientsPayload(targets.selection, targets.students, { kept: targets.kept }),
              };
              // An unchanged file keeps its stored type and size (the form only knows its name).
              if (initial) update.mutate({ id: initial.id, patch: f.file.fileId === initial.fileId ? payload : { ...payload, ...file } });
              else create.mutate({ ...payload, ...file });
            }}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MaterialsTab() {
  const utils = trpc.useUtils();
  const list = trpc.teacher.tasks.materials.useQuery();
  const syllabusUsage = useMaterialSyllabusUsage();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MaterialInitial | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
  const activityQ = trpc.teacher.tasks.materialActivity.useQuery({ id: activityId ?? "" }, { enabled: !!activityId });
  const shareFunnelQ = trpc.teacher.tasks.materialShareFunnel.useQuery({ id: shareId ?? "" }, { enabled: !!shareId, refetchInterval: 30_000 });
  const remove = trpc.teacher.tasks.removeMaterial.useMutation({
    onSuccess: () => void utils.teacher.tasks.materials.invalidate(),
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button onClick={() => setOpen(true)}>{t("modules.newMaterial")}</Button>
      </div>
      {!list.data?.length ? <EmptyState title={t("modules.noMaterials")} body={t("modules.noMaterialsBody")} /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((m) => (
            <Panel
              key={m.id}
              title={m.title}
              action={
                <button
                  type="button"
                  className="cursor-pointer text-xs text-link underline-offset-2 hover:underline"
                  onClick={() => setActivityId(activityId === m.id ? null : m.id)}
                >
                  {t("modules.viewActivity")}
                </button>
              }
            >
              <p className="break-words text-sm text-foreground-secondary">{m.description}</p>
              <p className="mt-2 break-words text-xs text-muted-foreground">{[m.subject, m.topic].filter(Boolean).join(" · ")}</p>
              <MaterialUsageBadge count={syllabusUsage.get(m.id)} />
              {m.fileId && (
                <a href={fileDownloadUrl(m.fileId)} className="mt-2 inline-block rounded-lg border border-border bg-muted px-2 py-1 text-xs text-link underline-offset-2 hover:underline">
                  {m.fileName}
                </a>
              )}
              {activityId === m.id && (
                !activityQ.data ? <Loading /> : !activityQ.data.eligible.length ? (
                  <p className="mt-3 text-xs text-muted-foreground">{t("modules.noRecipientsYet")}</p>
                ) : (
                  <ul className="mt-3 divide-y divide-border rounded-xl border border-border text-xs">
                    {activityQ.data.eligible.map((e) => (
                      <li key={e.studentId} className="flex flex-wrap items-center justify-between gap-2 p-2">
                        <span className="min-w-0 break-words font-medium">{e.name ?? e.email ?? `#${e.studentId}`}</span>
                        <span className="flex gap-1.5">
                          {e.downloadedAt ? (
                            <StatusBadge tone="success">{t("modules.downloaded")}</StatusBadge>
                          ) : e.viewedAt ? (
                            <StatusBadge tone="info">{t("modules.viewed")}</StatusBadge>
                          ) : (
                            <StatusBadge tone="neutral">{t("modules.notViewedShort")}</StatusBadge>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setShareId(shareId === m.id ? null : m.id)}>{t("common.share")}</Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(m)}>{t("common.edit")}</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-danger-surface hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => confirm(t("modules.deleteMaterialConfirm")) && remove.mutate({ id: m.id })}
                >
                  {t("common.delete")}
                </Button>
              </div>
              {shareId === m.id && (
                <div className="mt-3">
                  <ShareBox
                    path={`/material/${m.shareCode}`}
                    fileName={`resulio-material-${m.shareCode}`}
                    tracking={{ targetType: "MATERIAL", targetId: m.shareCode, campaign: "material_share" }}
                    onTracked={() => void shareFunnelQ.refetch()}
                  />
                  <ShareFunnelSummary data={shareFunnelQ.data} />
                </div>
              )}
            </Panel>
          ))}
        </div>
      )}
      {open && <MaterialFormDialog open onOpenChange={setOpen} />}
      {editing && <MaterialFormDialog open onOpenChange={(v) => !v && setEditing(null)} initial={editing} />}
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
