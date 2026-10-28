import { AiSourcePicker } from "@/components/AiSourcePicker";
import { Loading, Pill } from "@/components/AppShell";
import { draftFromQuestion, QuestionEditor } from "@/components/QuestionEditor";
import { QuestionPreview } from "@/components/questionBank/QuestionPreview";
import { bankLabel, SectionPicker, TopicSelect, useTopics } from "@/components/questionBank/Topics";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText, questionTypeLabel } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { type UploadedFile } from "@/lib/uploadFile";
import { ArrowDown, ArrowUp, Pencil, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const fieldLabel = "text-foreground-secondary";
const selectClass = "mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-foreground";
const filterCls = "rounded-lg border border-input bg-card px-2 text-sm text-foreground";
/** The six auto-gradable question types -- the only ones a task's quiz can use (see server's
 *  `QUIZ_QUESTION_TYPES` in taskQuiz.ts / `AI_QUESTION_TYPES` in ai.ts). */
const QUIZ_TYPES = ["MULTIPLE_CHOICE", "MULTIPLE_SELECT", "TRUE_FALSE", "SHORT_ANSWER", "FILL_BLANK", "NUMERIC"] as const;

/**
 * "AI ilə yarat" for a free-form task's own title/description/instructions (not the quiz --
 * see TaskQuizSection for that). Mirrors ExamBuilder.tsx's AiDialog source-upload UI, but there's
 * no separate draft/accept step here: the result is plain text the teacher reviews and edits
 * right in this dialog, then applies into the task form; the task's own save is the approval.
 */
export function TaskAiTextDialog({ open, onOpenChange, onApply }: { open: boolean; onOpenChange: (v: boolean) => void; onApply: (r: { title: string; description: string; instructions: string }) => void }) {
  const [form, setForm] = useState({ topic: "", grade: "", language: "az" as "az" | "ru" | "en" | "de" });
  const [sourceFiles, setSourceFiles] = useState<UploadedFile[]>([]);
  const [sourceText, setSourceText] = useState("");
  // Empty string means "not set" -- the field is optional, and `openQuestionCount` is only sent
  // to the server when the teacher actually typed a count (see the server's field doc comment:
  // when set, `instructions` becomes N numbered open questions instead of a free-form assignment).
  const [openQuestionCount, setOpenQuestionCount] = useState<number | "">("");
  const [edited, setEdited] = useState<{ title: string; description: string; instructions: string } | null>(null);
  const usage = trpc.teacher.ai.usage.useQuery(undefined, { enabled: open });
  const generate = trpc.teacher.ai.generateTaskText.useMutation({
    onSuccess: (r) => { setEdited(r); void usage.refetch(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const reset = () => { generate.reset(); setEdited(null); setSourceFiles([]); setSourceText(""); setOpenQuestionCount(""); };
  useEffect(() => { if (!open) reset(); }, [open]);
  const source = sourceFiles.length ? { fileIds: sourceFiles.map((f) => f.fileId) } : sourceText.trim() ? { text: sourceText.trim() } : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t("modules.aiTextTitle")}</DialogTitle></DialogHeader>
        {!edited ? (
          <DialogBody className="grid content-start gap-3 sm:grid-cols-2">
            <label className="text-sm sm:col-span-2"><span className={fieldLabel}>{t("common.required", { label: t("common.topic") })}</span><Input required value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("common.gradeLevel")}</span><Input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} placeholder={t("builder.aiGradePlaceholder")} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("builder.aiLanguage")}</span>
              <select className={selectClass} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value as typeof form.language })}>
                {(["az", "ru", "en", "de"] as const).map((l) => <option key={l} value={l}>{t(`builder.aiLang.${l}`)}</option>)}
              </select>
            </label>
            <div className="sm:col-span-2">
              <AiSourcePicker files={sourceFiles} onFilesChange={setSourceFiles} text={sourceText} onTextChange={setSourceText} />
            </div>
            <label className="text-sm sm:col-span-2">
              <span className={fieldLabel}>{t("builder.aiOpenQuestionsLabel")}</span>
              <Input
                type="number"
                min={1}
                max={20}
                value={openQuestionCount}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setOpenQuestionCount(e.target.value === "" ? "" : Math.min(20, Math.max(1, n || 1)));
                }}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t("builder.aiOpenQuestionsHint")}</p>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
              <span className="text-xs text-muted-foreground">{t("builder.aiUsage", { used: usage.data?.used ?? 0, limit: usage.data?.limit ?? 100 })}</span>
              <Button
                disabled={form.topic.trim().length < 2 || generate.isPending}
                onClick={() => generate.mutate({ ...form, source, openQuestionCount: openQuestionCount === "" ? undefined : openQuestionCount })}
              >
                {generate.isPending ? t("builder.aiGenerating") : t("builder.aiGenerate")}
              </Button>
            </div>
          </DialogBody>
        ) : (
          <>
            <DialogDescription>{t("modules.aiTextReview")}</DialogDescription>
            <DialogBody className="grid content-start gap-3">
              <label className="text-sm"><span className={fieldLabel}>{t("common.name")}</span><Input value={edited.title} onChange={(e) => setEdited({ ...edited, title: e.target.value })} /></label>
              <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={3} value={edited.description} onChange={(e) => setEdited({ ...edited, description: e.target.value })} /></label>
              <label className="text-sm"><span className={fieldLabel}>{t("material.field.instructions")}</span><Textarea rows={4} value={edited.instructions} onChange={(e) => setEdited({ ...edited, instructions: e.target.value })} /></label>
            </DialogBody>
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="outline" onClick={() => setEdited(null)}>{t("common.back")}</Button>
              <Button
                disabled={!edited.title.trim()}
                onClick={() => {
                  onApply(edited);
                  onOpenChange(false);
                }}
              >
                {t("modules.aiTextApply")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskQuizBankDialog({ open, onOpenChange, taskId, existing }: { open: boolean; onOpenChange: (v: boolean) => void; taskId: string; existing: string[] }) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [topicId, setTopicId] = useState("");
  const topics = useTopics(open);
  const topicList = topics.data ?? [];
  const bank = trpc.teacher.questions.bank.useQuery({ search: search || undefined, type: (type || undefined) as never, topicId: topicId || undefined }, { enabled: open });
  const rows = (bank.data ?? []).filter((q) => (QUIZ_TYPES as readonly string[]).includes(q.type));
  const utils = trpc.useUtils();
  const add = trpc.teacher.tasks.quizAddQuestion.useMutation({
    onSuccess: () => void utils.teacher.tasks.quizList.invalidate({ id: taskId }),
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t("builder.bankTitle")}</DialogTitle></DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-0 flex-1" placeholder={t("common.search")} aria-label={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
          <TopicSelect topics={topicList} value={topicId} onChange={setTopicId} emptyLabel={t("qbank.allTopics")} ariaLabel={t("qbank.filterTopic")} className={`max-w-[14rem] ${filterCls}`} />
          <select className={filterCls} aria-label={t("modules.filterType")} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">{t("modules.allTypes")}</option>
            {QUIZ_TYPES.map((k) => <option key={k} value={k}>{questionTypeLabel(k)}</option>)}
          </select>
        </div>
        <DialogBody>
          <ul className="divide-y">
            {rows.map((q) => {
              const added = existing.includes(q.id);
              return (
                <li key={q.id} className="flex items-center gap-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-link">{bankLabel(topicList, q) ?? t("qbank.unsorted")}</div>
                    <QuestionPreview q={q} clamp />
                    <div className="text-xs text-muted-foreground">
                      {questionTypeLabel(q.type)} · {t("common.points", { count: q.points })}{!q.sectionId && q.topic ? ` · ${q.topic}` : ""}
                    </div>
                  </div>
                  <Button size="sm" variant={added ? "outline" : "default"} disabled={added || add.isPending} onClick={() => add.mutate({ id: taskId, questionId: q.id })}>
                    {added ? t("common.added") : t("common.add")}
                  </Button>
                </li>
              );
            })}
            {!rows.length && <li className="py-6 text-center text-sm text-muted-foreground">{t("builder.bankEmpty")}</li>}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Mirrors ExamBuilder.tsx's AiDialog (same draft/accept flow, same per-workspace AI quota) but
 *  files the accepted questions into a task's quiz (`taskId`) instead of an exam. */
function TaskQuizAiDialog({ open, onOpenChange, taskId }: { open: boolean; onOpenChange: (v: boolean) => void; taskId: string }) {
  const [form, setForm] = useState({ topic: "", grade: "", language: "az" as "az" | "ru" | "en" | "de", difficulty: "MEDIUM" as "EASY" | "MEDIUM" | "HARD", questionType: "MULTIPLE_CHOICE" as (typeof QUIZ_TYPES)[number], count: 5, points: 1 });
  const [picked, setPicked] = useState<string[]>([]);
  const [sectionId, setSectionId] = useState("");
  const [sourceFiles, setSourceFiles] = useState<UploadedFile[]>([]);
  const [sourceText, setSourceText] = useState("");
  const usage = trpc.teacher.ai.usage.useQuery(undefined, { enabled: open });
  const utils = trpc.useUtils();
  const invalidate = () => void utils.teacher.tasks.quizList.invalidate({ id: taskId });
  const generate = trpc.teacher.ai.generate.useMutation({
    onSuccess: (r) => { setPicked(r.questions.map((q) => q.tempId)); void usage.refetch(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const accept = trpc.teacher.ai.accept.useMutation({
    onSuccess: (rows) => {
      toast.success(t("builder.aiAdded", { count: rows.length }));
      generate.reset();
      setSourceFiles([]);
      setSourceText("");
      invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const draft = generate.data;
  const source = sourceFiles.length ? { fileIds: sourceFiles.map((f) => f.fileId) } : sourceText.trim() ? { text: sourceText.trim() } : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t("builder.aiTitle")}</DialogTitle></DialogHeader>
        {!draft ? (
          <DialogBody className="grid content-start gap-3 sm:grid-cols-2">
            <label className="text-sm sm:col-span-2"><span className={fieldLabel}>{t("common.required", { label: t("common.topic") })}</span><Input required value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("common.gradeLevel")}</span><Input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} placeholder={t("builder.aiGradePlaceholder")} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("builder.aiLanguage")}</span>
              <select className={selectClass} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value as typeof form.language })}>
                {(["az", "ru", "en", "de"] as const).map((l) => <option key={l} value={l}>{t(`builder.aiLang.${l}`)}</option>)}
              </select>
            </label>
            <label className="text-sm"><span className={fieldLabel}>{t("common.type")}</span>
              <select className={selectClass} value={form.questionType} onChange={(e) => setForm({ ...form, questionType: e.target.value as typeof form.questionType })}>
                {QUIZ_TYPES.map((type) => <option key={type} value={type}>{questionTypeLabel(type)}</option>)}
              </select>
            </label>
            <label className="text-sm"><span className={fieldLabel}>{t("common.difficulty")}</span>
              <select className={selectClass} value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: e.target.value as typeof form.difficulty })}>
                {(["EASY", "MEDIUM", "HARD"] as const).map((d) => <option key={d} value={d}>{t(`common.difficulty.${d}`)}</option>)}
              </select>
            </label>
            <label className="text-sm"><span className={fieldLabel}>{t("builder.aiCount")}</span><Input type="number" min={1} max={10} value={form.count} onChange={(e) => setForm({ ...form, count: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("builder.aiPoints")}</span><Input type="number" min={0.5} step={0.5} value={form.points} onChange={(e) => setForm({ ...form, points: Number(e.target.value) || 1 })} /></label>
            <div className="sm:col-span-2">
              <AiSourcePicker files={sourceFiles} onFilesChange={setSourceFiles} text={sourceText} onTextChange={setSourceText} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
              <span className="text-xs text-muted-foreground">{t("builder.aiUsage", { used: usage.data?.used ?? 0, limit: usage.data?.limit ?? 100 })}</span>
              <Button disabled={form.topic.trim().length < 2 || generate.isPending} onClick={() => generate.mutate({ ...form, source })}>{generate.isPending ? t("builder.aiGenerating") : t("builder.aiGenerate")}</Button>
            </div>
          </DialogBody>
        ) : (
          <>
            <DialogDescription>{t("modules.quizAiReview")}</DialogDescription>
            <DialogBody>
              <ul className="space-y-2">
                {draft.questions.map(({ tempId, question }) => (
                  <li key={tempId} className="rounded-xl border p-3 text-sm">
                    <label className="flex gap-3">
                      <input type="checkbox" className="mt-1 accent-link" checked={picked.includes(tempId)} onChange={(e) => setPicked(e.target.checked ? [...picked, tempId] : picked.filter((x) => x !== tempId))} />
                      <QuestionPreview q={question} explanation />
                    </label>
                  </li>
                ))}
              </ul>
              <div className="mt-4 space-y-1">
                <div className="text-sm font-medium">{t("builder.aiSection")}</div>
                <SectionPicker value={sectionId} onChange={setSectionId} />
              </div>
            </DialogBody>
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="outline" onClick={() => generate.reset()}>{t("common.back")}</Button>
              <Button disabled={!picked.length || !sectionId || accept.isPending} onClick={() => accept.mutate({ draftId: draft.draftId, tempIds: picked, sectionId, taskId })}>{t("builder.aiAccept", { count: picked.length })}</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A task's optional auto-graded quiz: an ordered subset of the same question bank exams draw
 * from. Mirrors ExamBuilder.tsx's QuestionsStep (add from bank / AI / new, reorder, edit, remove)
 * but wired to `trpc.teacher.tasks.quiz*` instead of `trpc.teacher.assessments.*`. Only rendered
 * once the task itself has been saved (quiz rows are keyed by a real taskId).
 */
export function TaskQuizSection({ taskId }: { taskId: string }) {
  const [bankOpen, setBankOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [newSection, setNewSection] = useState("");
  const utils = trpc.useUtils();
  const quiz = trpc.teacher.tasks.quizList.useQuery({ id: taskId });
  const topics = useTopics();
  const topicList = topics.data ?? [];
  const invalidate = () => void utils.teacher.tasks.quizList.invalidate({ id: taskId });
  const onError = (e: unknown) => toast.error(errorText(e));
  const createQ = trpc.teacher.tasks.quizCreateQuestion.useMutation({ onSuccess: () => { setEditing(null); invalidate(); }, onError });
  const updateQ = trpc.teacher.questions.update.useMutation({ onSuccess: () => { setEditing(null); invalidate(); }, onError });
  const removeQ = trpc.teacher.tasks.quizRemoveQuestion.useMutation({ onSuccess: invalidate, onError });
  const reorderQ = trpc.teacher.tasks.quizReorder.useMutation({ onSuccess: invalidate, onError });
  const rows = quiz.data ?? [];
  const total = rows.reduce((s, q) => s + q.points, 0);
  const move = (i: number, dir: -1 | 1) => {
    const ids = rows.map((q) => q.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorderQ.mutate({ id: taskId, questionIds: ids });
  };
  const iconButton = "rounded p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:text-border-strong disabled:hover:bg-transparent";

  if (quiz.isLoading) return <Loading />;

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{t("builder.questionsTitle", { count: rows.length, points: total })}</h3>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setBankOpen(true)}>{t("builder.fromBank")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setAiOpen(true)}><Sparkles className="h-4 w-4" aria-hidden /> {t("builder.withAi")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing("new")}>{t("builder.newQuestion")}</Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("modules.quizHint")}</p>
      {!!rows.length && (
        <ol className="space-y-3">
          {rows.map((q, i) => (
            <li key={q.id} className="rounded-xl border p-3">
              {editing === q.id ? (
                <QuestionEditor hideTopic={!!q.sectionId} initial={draftFromQuestion(q)} busy={updateQ.isPending} onCancel={() => setEditing(null)} onSubmit={(question) => updateQ.mutate({ id: q.id, question })} />
              ) : (
                <div className="flex gap-3">
                  <div className="flex flex-col gap-1">
                    <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className={iconButton} aria-label={t("builder.moveUpN", { n: i + 1 })}><ArrowUp className="h-4 w-4" aria-hidden /></button>
                    <button type="button" disabled={i === rows.length - 1} onClick={() => move(i, 1)} className={iconButton} aria-label={t("builder.moveDownN", { n: i + 1 })}><ArrowDown className="h-4 w-4" aria-hidden /></button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground-secondary">{i + 1}.</span>
                      <Pill>{questionTypeLabel(q.type)}</Pill>
                      <span>{t("common.points", { count: q.points })}</span>
                      {bankLabel(topicList, q) ? <span className="text-link">· {bankLabel(topicList, q)}</span> : q.topic && <span>· {q.topic}</span>}
                      {q.source === "AI" && <StatusBadge tone="info" icon={Sparkles}>AI</StatusBadge>}
                    </div>
                    <QuestionPreview q={q} clamp className="mt-1" onChangeAnswer={() => setEditing(q.id)} />
                  </div>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => setEditing(q.id)} className={iconButton} aria-label={t("builder.editN", { n: i + 1 })}><Pencil className="h-4 w-4" aria-hidden /></button>
                    <button
                      type="button"
                      onClick={() => confirm(t("modules.quizRemoveConfirm")) && removeQ.mutate({ id: taskId, questionId: q.id })}
                      className="rounded p-1.5 hover:bg-danger-surface hover:text-destructive"
                      aria-label={t("modules.quizRemoveN", { n: i + 1 })}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {!rows.length && editing !== "new" && <p className="text-sm text-muted-foreground">{t("modules.quizEmpty")}</p>}
      {editing === "new" && (
        <div className="rounded-xl border border-dashed border-link p-4">
          <div className="mb-3 font-medium">{t("builder.newQuestionTitle")}</div>
          <SectionPicker className="mb-4" value={newSection} onChange={setNewSection} />
          {newSection ? (
            <QuestionEditor hideTopic busy={createQ.isPending} submitLabel={t("common.add")} onCancel={rows.length ? () => setEditing(null) : undefined} onSubmit={(question) => createQ.mutate({ id: taskId, question, sectionId: newSection })} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("qbank.pickSectionFirst")}</p>
          )}
        </div>
      )}
      <TaskQuizBankDialog open={bankOpen} onOpenChange={setBankOpen} taskId={taskId} existing={rows.map((q) => q.id)} />
      <TaskQuizAiDialog open={aiOpen} onOpenChange={setAiOpen} taskId={taskId} />
    </div>
  );
}
