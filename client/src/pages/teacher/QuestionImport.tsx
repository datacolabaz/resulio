import { AppShell, ErrorNote, Loading, Panel } from "@/components/AppShell";
import { draftFromQuestion, QuestionEditor } from "@/components/QuestionEditor";
import { QuestionPreview } from "@/components/questionBank/QuestionPreview";
import { SectionPicker, SectionSelect, topicSelectClass, useTopics, type TopicRow } from "@/components/questionBank/Topics";
import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { isMessageKey, t, type MessageKey } from "@/i18n/messages";
import { errorText, fmtDateTime, questionTypeLabel } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { formatFileSize, uploadFile, UploadError, type UploadedFile } from "@/lib/uploadFile";
import { BLOCKING_ISSUES, IMPORT_EXTENSIONS, type ImportIssue } from "@shared/questionImport";
import { ArrowLeft, FileUp, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams } from "wouter";

type Job = RouterOutputs["teacher"]["questionImport"]["list"][number];
type Detail = RouterOutputs["teacher"]["questionImport"]["detail"];
type Item = Detail["items"][number];

const LIST_PATH = "/teacher/library/import";
const ACCEPT = IMPORT_EXTENSIONS.join(",");

const STATUS_TONE: Record<Job["status"], Tone> = { QUEUED: "neutral", PROCESSING: "info", READY: "warning", FAILED: "danger", COMPLETED: "success" };
const running = (status: string) => status === "QUEUED" || status === "PROCESSING";

function msg(key: string, fallback: MessageKey): string {
  return isMessageKey(key) ? t(key) : t(fallback);
}

const failureText = (code: string | null) => msg(`qimport.failed.${code ?? ""}`, "qimport.failed.INTERNAL");

function JobStatus({ job }: { job: Pick<Job, "status"> }) {
  return <StatusBadge tone={STATUS_TONE[job.status]}>{t(`qimport.status.${job.status}`)}</StatusBadge>;
}

function Progress({ job }: { job: Pick<Job, "chunksDone" | "chunkCount"> }) {
  const total = Math.max(1, job.chunkCount);
  const pct = Math.round((Math.min(job.chunksDone, total) / total) * 100);
  return (
    <div className="space-y-1">
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t("qimport.progress", { done: job.chunksDone, total })}>
        <div className="h-full bg-link transition-all motion-reduce:transition-none" style={{ width: `${Math.max(pct, 4)}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{t("qimport.progress", { done: job.chunksDone, total })}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload and history
// ---------------------------------------------------------------------------

function UploadPanel() {
  const [, nav] = useLocation();
  const availability = trpc.teacher.questionImport.availability.useQuery(undefined, { retry: false });
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [sectionId, setSectionId] = useState("");
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const start = trpc.teacher.questionImport.start.useMutation({
    onSuccess: (job) => nav(`${LIST_PATH}/${job.id}`),
    onError: (e) => toast.error(errorText(e)),
  });

  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    setUploading(true);
    try {
      setFile(await uploadFile(picked, "question-import"));
    } catch (e) {
      const code = e instanceof UploadError ? e.code : "";
      toast.error(code === "FILE_TOO_LARGE" ? t("files.tooLarge") : code === "FILE_TYPE_NOT_ALLOWED" ? t("error.IMPORT_FILE_TYPE") : t("files.uploadFailed"));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };

  if (availability.isLoading) return <Loading />;
  if (availability.error) return <ErrorNote error={availability.error} />;
  const a = availability.data!;
  return (
    <Panel title={t("qimport.title")}>
      <p className="mb-3 text-sm text-muted-foreground">{t("qimport.intro")}</p>
      {!a.enabled ? (
        <p role="status" className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm">{t("qimport.unavailable")}</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <input ref={input} type="file" accept={ACCEPT} className="sr-only" aria-label={t("qimport.chooseFile")} disabled={uploading} onChange={(e) => void pick(e.target.files?.[0])} />
              <Button type="button" variant="outline" disabled={uploading} onClick={() => input.current?.click()}>
                <FileUp className="mr-1 h-4 w-4" aria-hidden />
                {uploading ? t("qimport.uploading") : file ? t("files.replace") : t("qimport.chooseFile")}
              </Button>
              {file && (
                <span className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-sm">
                  <span className="min-w-0 truncate">{file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">({formatFileSize(file.size)})</span>
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("qimport.limits", { size: formatFileSize(a.maxBytes), pages: a.maxPages, left: a.remainingToday })}
            </p>
          </div>
          <div className="max-w-xl space-y-1">
            <SectionPicker value={sectionId} onChange={setSectionId} />
            <p className="text-xs text-muted-foreground">{t("qimport.sectionHelp")}</p>
          </div>
          <Button disabled={!file || !sectionId || start.isPending || a.remainingToday <= 0} onClick={() => file && sectionId && start.mutate({ fileId: file.fileId, sectionId })}>
            {start.isPending ? t("qimport.starting") : t("qimport.start")}
          </Button>
        </div>
      )}
    </Panel>
  );
}

const sectionPath = (topics: TopicRow[], id: string | null) => (id ? topics.find((x) => x.id === id)?.path : undefined);

function JobRow({ job, topics }: { job: Job; topics: TopicRow[] }) {
  const utils = trpc.useUtils();
  const refresh = () => void utils.teacher.questionImport.list.invalidate();
  const retry = trpc.teacher.questionImport.retry.useMutation({ onSuccess: refresh, onError: (e) => toast.error(errorText(e)) });
  const remove = trpc.teacher.questionImport.remove.useMutation({
    onSuccess: () => {
      toast.success(t("qimport.removed"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`${LIST_PATH}/${job.id}`} className="min-w-0 truncate font-medium text-link hover:underline">
            {job.fileName}
          </Link>
          <JobStatus job={job} />
        </div>
        <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>{fmtDateTime(job.createdAt)}</span>
          {sectionPath(topics, job.sectionId) && <span>{sectionPath(topics, job.sectionId)}</span>}
          {job.pageCount && job.mimeType === "application/pdf" && <span>{t("qimport.pages", { count: job.pageCount })}</span>}
          {(job.status === "READY" || job.status === "COMPLETED") && <span>{t("qimport.counts", { pending: job.pending, accepted: job.accepted, rejected: job.rejected })}</span>}
        </div>
        {running(job.status) && <Progress job={job} />}
        {job.status === "FAILED" && <p className="text-xs text-destructive">{failureText(job.errorCode)}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        {job.status === "FAILED" && (
          <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate({ id: job.id })}>
            <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
            {t("qimport.retry")}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-destructive" disabled={remove.isPending} onClick={() => confirm(t("qimport.removeConfirm")) && remove.mutate({ id: job.id })}>
          <Trash2 className="mr-1 h-4 w-4" aria-hidden />
          {t("common.delete")}
        </Button>
      </div>
    </li>
  );
}

export function QuestionImportPage() {
  const list = trpc.teacher.questionImport.list.useQuery(undefined, {
    retry: false,
    refetchInterval: (q) => (q.state.data?.some((j) => running(j.status)) ? 3000 : false),
  });
  const topics = useTopics();
  return (
    <AppShell area="teaching" title={t("qimport.title")}>
      <div className="mx-auto max-w-4xl space-y-4">
        <Link href="/teacher/library" className="inline-flex items-center gap-1 text-sm text-link hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t("modules.questionBank")}
        </Link>
        <UploadPanel />
        <Panel title={t("qimport.history")}>
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <ErrorNote error={list.error} />
          ) : !list.data?.length ? (
            <p className="text-sm text-muted-foreground">{t("qimport.empty")}</p>
          ) : (
            <ul className="divide-y">
              {list.data.map((job) => (
                <JobRow key={job.id} job={job} topics={topics.data ?? []} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

type Q = {
  type: string;
  text: string;
  difficulty: string;
  points: number;
  topic: string;
  explanation?: string;
  content: { options?: { key: string; text: string }[]; unit?: string; blankCount?: number };
  answerKey: { correct?: string | string[] | boolean; accepted?: string[]; blanks?: string[][]; value?: number; rubric?: string };
};

const ISSUE_TONE = (issue: ImportIssue): Tone => (BLOCKING_ISSUES.includes(issue) ? "danger" : issue === "AI_ANSWER" ? "info" : "warning");

/** The item's section (the upload's by default) and the AI's hint, applied only when the teacher says so. */
function ItemSection({ item, topics, disabled, onChange }: { item: Item; topics: TopicRow[]; disabled: boolean; onChange: (patch: { sectionId?: string; useSuggestion?: boolean }) => void }) {
  const suggestion = item.suggestedSectionId ? topics.find((x) => x.id === item.suggestedSectionId)?.name : item.suggestedSection;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SectionSelect
        topics={topics}
        value={item.sectionId}
        disabled={disabled}
        emptyLabel={t("qbank.pickSection")}
        ariaLabel={t("qimport.sectionFor")}
        className={`max-w-full ${topicSelectClass}`}
        onChange={(sectionId) => sectionId && onChange({ sectionId })}
      />
      {suggestion && (
        <span className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted px-2 py-1 text-xs">
          <Sparkles className="h-3.5 w-3.5 text-link" aria-hidden />
          <span>{t(item.suggestedSectionId ? "qimport.suggestedSection" : "qimport.suggestedNewSection", { name: suggestion })}</span>
          <Button size="sm" variant="outline" className="h-7" disabled={disabled} onClick={() => onChange({ useSuggestion: true })}>
            {t("qimport.applySuggestion")}
          </Button>
        </span>
      )}
    </div>
  );
}

function ReviewItem({
  item,
  topics,
  duplicateText,
  selected,
  onSelect,
  jobId,
}: {
  item: Item;
  topics: TopicRow[];
  duplicateText: string | undefined;
  selected: boolean;
  onSelect: (v: boolean) => void;
  jobId: string;
}) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const refresh = () => void utils.teacher.questionImport.detail.invalidate({ id: jobId });
  const update = trpc.teacher.questionImport.updateItem.useMutation({
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const reject = trpc.teacher.questionImport.reject.useMutation({ onSuccess: refresh, onError: (e) => toast.error(errorText(e)) });
  const accept = trpc.teacher.questionImport.accept.useMutation({
    onSuccess: (r) => {
      if (r.accepted) toast.success(t("qimport.acceptedToast", { count: r.accepted }));
      if (r.skipped.length) toast.error(t("error.IMPORT_ITEM_INVALID"));
      refresh();
      void utils.teacher.questionImport.list.invalidate();
      void utils.teacher.questions.bank.invalidate();
      void utils.teacher.questionTopics.list.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const q = item.question as unknown as Q;
  const pending = item.status === "PENDING";
  const busy = update.isPending || reject.isPending || accept.isPending;
  const issues = item.issues as ImportIssue[];

  return (
    <li className={`rounded-xl border p-4 ${item.status === "REJECTED" ? "border-border bg-muted opacity-75" : item.blocking ? "border-destructive/40" : "border-border"}`}>
      <div className="flex items-start gap-3">
        {pending && (
          <input type="checkbox" className="mt-1 accent-link" aria-label={t("qbank.selectQuestion")} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
        )}
        <span className="mt-0.5 w-6 shrink-0 text-sm font-semibold text-muted-foreground">{item.position}.</span>
        <div className="min-w-0 flex-1 space-y-2">
          {editing ? (
            <QuestionEditor
              hideTopic
              initial={draftFromQuestion(q)}
              busy={update.isPending}
              onCancel={() => setEditing(false)}
              onSubmit={(question) => update.mutate({ id: item.id, question })}
            />
          ) : (
            <QuestionPreview q={q} explanation />
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{questionTypeLabel(q.type)}</span>
            {item.sourcePage && <span>· {t("qimport.sourcePage", { page: item.sourcePage })}</span>}
            {item.sourceNumber && <span>· {t("qimport.sourceNumber", { number: item.sourceNumber })}</span>}
            <StatusBadge tone={item.answerSource === "SOURCE" ? "success" : item.answerSource === "TEACHER" ? "neutral" : "info"}>{t(`qimport.answerSource.${item.answerSource}`)}</StatusBadge>
            {item.answerSource !== "TEACHER" && <StatusBadge tone={item.confidence === "HIGH" ? "success" : item.confidence === "MEDIUM" ? "warning" : "danger"}>{t(`qimport.confidence.${item.confidence}`)}</StatusBadge>}
            {item.status !== "PENDING" && <StatusBadge tone={item.status === "ACCEPTED" ? "success" : "neutral"}>{t(`qimport.itemStatus.${item.status}`)}</StatusBadge>}
          </div>
          {issues.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {issues.map((issue) => (
                <li key={issue}>
                  <StatusBadge tone={ISSUE_TONE(issue)}>{msg(`qimport.issue.${issue}`, "qimport.issue.INVALID_QUESTION")}</StatusBadge>
                </li>
              ))}
            </ul>
          )}
          {duplicateText && <p className="text-xs text-muted-foreground">{t("qimport.duplicateOf", { text: duplicateText })}</p>}
          {pending && !editing && <ItemSection item={item} topics={topics} disabled={busy} onChange={(patch) => update.mutate({ id: item.id, ...patch })} />}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {pending && !editing && (
            <>
              <Button size="sm" disabled={busy || item.blocking} onClick={() => accept.mutate({ jobId, ids: [item.id] })}>
                {t("qimport.accept")}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                {t("common.edit")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => reject.mutate({ ids: [item.id], rejected: true })}>
                {t("qimport.reject")}
              </Button>
            </>
          )}
          {item.status === "REJECTED" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate({ ids: [item.id], rejected: false })}>
              {t("qimport.restore")}
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

type ItemFilter = "all" | "pending" | "review" | "duplicates";

function matches(item: Item, filter: ItemFilter) {
  if (filter === "pending") return item.status === "PENDING";
  if (filter === "review") return item.status === "PENDING" && (item.issues as ImportIssue[]).some((i) => i !== "DUPLICATE_IN_BANK" && i !== "DUPLICATE_IN_FILE");
  if (filter === "duplicates") return (item.issues as ImportIssue[]).some((i) => i === "DUPLICATE_IN_BANK" || i === "DUPLICATE_IN_FILE");
  return true;
}

function ReviewList({ detail }: { detail: Detail }) {
  const utils = trpc.useUtils();
  const topics = useTopics();
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const jobId = detail.job.id;
  const visible = useMemo(() => detail.items.filter((i) => matches(i, filter)), [detail.items, filter]);
  const acceptable = detail.items.filter((i) => i.status === "PENDING" && !i.blocking);
  const chosen = [...selected].filter((id) => detail.items.some((i) => i.id === id && i.status === "PENDING"));
  const after = () => {
    setSelected(new Set());
    void utils.teacher.questionImport.detail.invalidate({ id: jobId });
    void utils.teacher.questionImport.list.invalidate();
    void utils.teacher.questions.bank.invalidate();
    void utils.teacher.questionTopics.list.invalidate();
  };
  const accept = trpc.teacher.questionImport.accept.useMutation({
    onSuccess: (r) => {
      if (r.accepted) toast.success(t("qimport.acceptedToast", { count: r.accepted }));
      if (r.skipped.length) toast.message(t("qimport.skippedToast", { count: r.skipped.length }));
      after();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const reject = trpc.teacher.questionImport.reject.useMutation({ onSuccess: after, onError: (e) => toast.error(errorText(e)) });
  const pendingVisible = visible.filter((i) => i.status === "PENDING");

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/95 p-3 backdrop-blur">
        <select className={topicSelectClass} aria-label={t("qimport.filterLabel")} value={filter} onChange={(e) => setFilter(e.target.value as ItemFilter)}>
          <option value="all">{t("qimport.filter.all")}</option>
          <option value="pending">{t("qimport.filter.pending")}</option>
          <option value="review">{t("qimport.filter.review")}</option>
          <option value="duplicates">{t("qimport.filter.duplicates")}</option>
        </select>
        {pendingVisible.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-link"
              checked={pendingVisible.every((i) => selected.has(i.id))}
              onChange={(e) => setSelected(new Set(e.target.checked ? pendingVisible.map((i) => i.id) : []))}
            />
            {t("qbank.selectAll")}
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-link" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
          {t("qimport.skipDuplicates")}
        </label>
        <div className="ml-auto flex flex-wrap gap-2">
          {chosen.length > 0 && (
            <>
              <Button variant="outline" disabled={reject.isPending} onClick={() => reject.mutate({ ids: chosen, rejected: true })}>
                {t("qimport.rejectSelected")}
              </Button>
              <Button variant="outline" disabled={accept.isPending} onClick={() => accept.mutate({ jobId, ids: chosen, skipDuplicates })}>
                {t("qimport.acceptSelected", { count: chosen.length })}
              </Button>
            </>
          )}
          <Button disabled={!acceptable.length || accept.isPending} onClick={() => accept.mutate({ jobId, ids: "ALL", skipDuplicates })}>
            {t("qimport.acceptAll", { count: acceptable.length })}
          </Button>
        </div>
      </div>
      {!visible.length ? (
        <p className="text-sm text-muted-foreground">{t("qimport.noItems")}</p>
      ) : (
        <ul className="space-y-3">
          {visible.map((item) => (
            <ReviewItem
              key={item.id}
              item={item}
              jobId={jobId}
              topics={topics.data ?? []}
              duplicateText={item.duplicateOfQuestionId ? detail.duplicates[item.duplicateOfQuestionId] : undefined}
              selected={selected.has(item.id)}
              onSelect={(v) =>
                setSelected((cur) => {
                  const next = new Set(cur);
                  if (v) next.add(item.id);
                  else next.delete(item.id);
                  return next;
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function QuestionImportReviewPage() {
  const { id = "" } = useParams<{ id: string }>();
  const utils = trpc.useUtils();
  const detail = trpc.teacher.questionImport.detail.useQuery(
    { id },
    { retry: false, refetchInterval: (q) => (q.state.data && running(q.state.data.job.status) ? 3000 : false) },
  );
  const retry = trpc.teacher.questionImport.retry.useMutation({
    onSuccess: () => void utils.teacher.questionImport.detail.invalidate({ id }),
    onError: (e) => toast.error(errorText(e)),
  });
  const topics = useTopics();
  const data = detail.data;
  const job = data?.job;
  return (
    <AppShell area="teaching" title={t("qimport.title")}>
      <div className="mx-auto max-w-4xl space-y-4">
        <Link href={LIST_PATH} className="inline-flex items-center gap-1 text-sm text-link hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t("qimport.backToList")}
        </Link>
        {detail.isLoading ? (
          <Loading />
        ) : detail.error || !data || !job ? (
          <ErrorNote error={detail.error} />
        ) : (
          <>
            <Panel>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-lg font-semibold">{job.fileName}</h1>
                <JobStatus job={job} />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>{fmtDateTime(job.createdAt)}</span>
                {job.pageCount && job.mimeType === "application/pdf" && <span>{t("qimport.pages", { count: job.pageCount })}</span>}
                {data.items.length > 0 && <span>{t("qimport.summary", { count: data.items.length })}</span>}
              </div>
              {running(job.status) && (
                <div className="mt-3 space-y-2">
                  <Progress job={job} />
                  <p className="text-sm text-muted-foreground">{t("qimport.processingNote")}</p>
                </div>
              )}
              {job.status === "FAILED" && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <p role="alert" className="text-sm text-destructive">{failureText(job.errorCode)}</p>
                  <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate({ id })}>
                    <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
                    {t("qimport.retry")}
                  </Button>
                </div>
              )}
              {(job.status === "READY" || job.status === "COMPLETED") && (
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {job.errorCode && <p className="text-warning">{t("qimport.partial", { reason: failureText(job.errorCode) })}</p>}
                  {job.inputMode === "text" && <p>{t("qimport.textMode")}</p>}
                  <p>{t("qimport.numberNote", { section: sectionPath(topics.data ?? [], job.sectionId) ?? "" })}</p>
                </div>
              )}
            </Panel>
            {(job.status === "READY" || job.status === "COMPLETED") && <ReviewList detail={data} />}
          </>
        )}
      </div>
    </AppShell>
  );
}
