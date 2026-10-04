import { MultiFileUpload } from "@/components/FileUpload";
import { StatusBadge } from "@/components/StatusBadge";
import { blockTypeLabel, TheoryEditor } from "@/components/syllabus/TheoryEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t, type MessageKey } from "@/i18n/messages";
import { difficultyLabel, errorText, fromLocalInput, toLocalInput } from "@/lib/format";
import { blocksForSave, blocksFromContent, type EditableBlock } from "@/lib/syllabus";
import { builderPath } from "@/lib/syllabusLearn";
import { trpc } from "@/lib/trpc";
import {
  assessmentItemContentSchema,
  DIFFICULTY_LEVELS,
  MAX_ATTEMPTS_LIMIT,
  resourceContentSchema,
  SCORE_POLICIES,
  studentPracticeContentSchema,
  SUBMISSION_TYPES,
  teacherPracticeContentSchema,
  theoryContentSchema,
  type AssessmentItemContent,
  type ResourceContent,
  type StudentPracticeContent,
  type SyllabusItemKind,
  type TeacherPracticeContent,
} from "@shared/syllabus";
import { ExternalLink, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { fieldLabel, selectCls } from "./shared";

type Attachment = { fileId: string; name: string; size: number };

function parsed<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } ; parse: (v: unknown) => T }, raw: unknown): T {
  const r = schema.safeParse(raw ?? {});
  return r.success && r.data !== undefined ? r.data : schema.parse({});
}

/** Editor state per kind; `toContent` turns it back into what updateItem accepts. */
export type ItemDraft =
  | { kind: "THEORY"; blocks: EditableBlock[] }
  | { kind: "TEACHER_PRACTICE"; c: TeacherPracticeContent }
  | { kind: "STUDENT_PRACTICE"; c: StudentPracticeContent }
  | { kind: "ASSESSMENT"; c: AssessmentItemContent }
  | { kind: "RESOURCE"; c: ResourceContent };

export function draftFromContent(kind: SyllabusItemKind, content: unknown): ItemDraft {
  switch (kind) {
    case "THEORY":
      return { kind, blocks: blocksFromContent(content) };
    case "TEACHER_PRACTICE":
      return { kind, c: parsed(teacherPracticeContentSchema, content) };
    case "STUDENT_PRACTICE":
      return { kind, c: parsed(studentPracticeContentSchema, content) };
    case "ASSESSMENT":
      return { kind, c: parsed(assessmentItemContentSchema, content) };
    case "RESOURCE":
      return { kind, c: parsed(resourceContentSchema, content) };
  }
}

/** Content for the server, or an error message key when something is incomplete. */
export function contentFromDraft(d: ItemDraft): { content: Record<string, unknown> } | { error: MessageKey } {
  if (d.kind === "THEORY") {
    const content = { blocks: blocksForSave(d.blocks) };
    return theoryContentSchema.safeParse(content).success ? { content } : { error: "syllabus.theory.invalid" };
  }
  if (d.kind === "STUDENT_PRACTICE") {
    const { deadline } = d.c;
    if (deadline.type === "RELATIVE_DAYS" && !deadline.days) return { error: "syllabus.sp.deadlineDaysRequired" };
    if (deadline.type === "ABSOLUTE" && !deadline.at) return { error: "syllabus.sp.deadlineAtRequired" };
  }
  if (d.kind === "RESOURCE" && !d.c.materialId && !d.c.url && !d.c.note.trim()) return { error: "syllabus.resource.required" };
  if (d.kind === "RESOURCE" && d.c.url && !/^https?:\/\/\S+$/i.test(d.c.url)) return { error: "syllabus.resource.badUrl" };
  return { content: JSON.parse(JSON.stringify(d.c)) as Record<string, unknown> };
}

function HintsField({ value, onChange, id }: { value: string[]; onChange: (v: string[]) => void; id: string }) {
  return (
    <fieldset className="text-sm">
      <legend className={`mb-1 ${fieldLabel}`}>{t("syllabus.practice.hints")}</legend>
      <div className="space-y-2">
        {value.map((h, i) => (
          <div key={i} className="flex gap-2">
            <Input id={`${id}-${i}`} maxLength={2000} value={h} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} aria-label={t("syllabus.practice.hintN", { n: i + 1 })} />
            <Button type="button" size="icon" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t("syllabus.practice.removeHint", { n: i + 1 })}>
              <Trash2 className="h-4 w-4 text-destructive" aria-hidden />
            </Button>
          </div>
        ))}
        {value.length < 20 && (
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([...value, ""])}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            {t("syllabus.practice.addHint")}
          </Button>
        )}
      </div>
    </fieldset>
  );
}

function DifficultySelect({ value, onChange }: { value: string; onChange: (v: (typeof DIFFICULTY_LEVELS)[number]) => void }) {
  return (
    <label className="text-sm">
      <span className={fieldLabel}>{t("syllabus.practice.difficulty")}</span>
      <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value as (typeof DIFFICULTY_LEVELS)[number])}>
        {DIFFICULTY_LEVELS.map((d) => <option key={d} value={d}>{difficultyLabel(d)}</option>)}
      </select>
    </label>
  );
}

function AttachmentsField({ value, onChange }: { value: Attachment[]; onChange: (v: Attachment[]) => void }) {
  return (
    <div className="text-sm">
      <p className={`mb-1 ${fieldLabel}`}>{t("syllabus.practice.attachments")}</p>
      <MultiFileUpload
        context="syllabus"
        value={value.map((a) => ({ ...a, mimeType: "" }))}
        onChange={(files) => onChange(files.map(({ fileId, name, size }) => ({ fileId, name, size })))}
      />
    </div>
  );
}

export function TeacherPracticeFields({ c, onChange, id }: { c: TeacherPracticeContent; onChange: (c: TeacherPracticeContent) => void; id: string }) {
  const set = (patch: Partial<TeacherPracticeContent>) => onChange({ ...c, ...patch });
  return (
    <div className="grid gap-3">
      <label className="text-sm"><span className={fieldLabel}>{t("syllabus.tp.problem")}</span><Textarea rows={5} maxLength={20_000} value={c.problem} onChange={(e) => set({ problem: e.target.value })} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <DifficultySelect value={c.difficulty} onChange={(difficulty) => set({ difficulty })} />
        <label className="text-sm"><span className={fieldLabel}>{t("syllabus.tp.expectedOutcome")}</span><Input maxLength={20_000} value={c.expectedOutcome} onChange={(e) => set({ expectedOutcome: e.target.value })} /></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm"><span className={fieldLabel}>{t("syllabus.tp.exampleInput")}</span><Textarea rows={3} spellCheck={false} className="font-mono" maxLength={20_000} value={c.exampleInput} onChange={(e) => set({ exampleInput: e.target.value })} /></label>
        <label className="text-sm"><span className={fieldLabel}>{t("syllabus.tp.exampleOutput")}</span><Textarea rows={3} spellCheck={false} className="font-mono" maxLength={20_000} value={c.exampleOutput} onChange={(e) => set({ exampleOutput: e.target.value })} /></label>
      </div>
      <HintsField id={`${id}-hint`} value={c.hints} onChange={(hints) => set({ hints })} />
      <div className="grid gap-3 rounded-xl border border-warning/40 bg-warning-surface p-3">
        <p className="text-xs font-medium text-warning">{t("syllabus.tp.teacherOnly")}</p>
        <label className="text-sm"><span className={fieldLabel}>{t("syllabus.tp.solution")}</span><Textarea rows={5} spellCheck={false} className="font-mono" maxLength={20_000} value={c.teacherOnly.solution} onChange={(e) => set({ teacherOnly: { ...c.teacherOnly, solution: e.target.value } })} /></label>
        <label className="text-sm"><span className={fieldLabel}>{t("syllabus.tp.notes")}</span><Textarea rows={3} maxLength={20_000} value={c.teacherOnly.notes} onChange={(e) => set({ teacherOnly: { ...c.teacherOnly, notes: e.target.value } })} /></label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-link" checked={c.revealSolutionToStudents} onChange={(e) => set({ revealSolutionToStudents: e.target.checked })} />
          {t("syllabus.tp.reveal")}
        </label>
      </div>
      <AttachmentsField value={c.attachments} onChange={(attachments) => set({ attachments })} />
    </div>
  );
}

/** The hidden container task's answer key (same endpoints and UI rules as ordinary assignments). */
function AnswerKeyField({ taskId, title, description, attachments }: { taskId: string; title: string; description: string; attachments: Attachment[] }) {
  const utils = trpc.useUtils();
  const keyQ = trpc.teacher.tasks.answerKey.useQuery({ taskId }, { refetchOnWindowFocus: false });
  const [text, setText] = useState<string | null>(null);
  useEffect(() => setText(null), [taskId]);
  const value = text ?? keyQ.data?.text ?? "";
  const save = trpc.teacher.tasks.saveAnswerKey.useMutation({
    onSuccess: () => {
      toast.success(t("syllabus.sp.keySaved"));
      setText(null);
      void utils.teacher.tasks.answerKey.invalidate({ taskId });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const draft = trpc.teacher.tasks.draftAnswerKey.useMutation({
    onSuccess: (r) => {
      setText(r.text);
      toast.success(t("modules.answerKeyAiDone"));
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const available = !!keyQ.data?.available;
  const dirty = value.trim() !== (keyQ.data?.text ?? "").trim() || (keyQ.data?.source === "AI_DRAFT" && text === null && !!value);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={`key-${taskId}`} className={fieldLabel}>{t("modules.answerKey")}</label>
        {keyQ.data?.source === "AI_DRAFT" && text === null && <StatusBadge tone="warning">{t("modules.answerKeyAiDraftBadge")}</StatusBadge>}
      </div>
      <Textarea id={`key-${taskId}`} rows={5} maxLength={8000} disabled={!available || draft.isPending} placeholder={t("modules.answerKeyPlaceholder")} value={value} onChange={(e) => setText(e.target.value)} />
      {keyQ.data && !available && <p className="text-xs text-muted-foreground">{t("modules.answerKeyUnavailable")}</p>}
      {available && (
        <>
          <p className="text-xs text-muted-foreground">{t("syllabus.sp.keyHelp")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate({ taskId, text: value })}>
              {t("syllabus.sp.saveKey")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!keyQ.data?.aiEnabled || title.trim().length < 2 || draft.isPending}
              onClick={() => {
                if (value.trim() && !confirm(t("modules.answerKeyReplaceConfirm"))) return;
                draft.mutate({ title, description: description.slice(0, 10_000), attachments: attachments.map(({ fileId, name }) => ({ fileId, name })) });
              }}
            >
              <Sparkles className="mr-1 h-4 w-4" aria-hidden />
              {draft.isPending ? t("modules.answerKeyAiWorking") : t("modules.answerKeyAi")}
            </Button>
            {!keyQ.data?.aiEnabled && <span className="text-xs text-muted-foreground">{t("aiReview.disabledNote")}</span>}
          </div>
        </>
      )}
    </div>
  );
}

export function StudentPracticeFields({
  c,
  onChange,
  id,
  taskId,
  title,
}: {
  c: StudentPracticeContent;
  onChange: (c: StudentPracticeContent) => void;
  id: string;
  taskId: string | null;
  title: string;
}) {
  const set = (patch: Partial<StudentPracticeContent>) => onChange({ ...c, ...patch });
  const deadline = c.deadline;
  return (
    <div className="grid gap-3">
      <label className="text-sm"><span className={fieldLabel}>{t("syllabus.sp.instructions")}</span><Textarea rows={5} maxLength={20_000} value={c.instructions} onChange={(e) => set({ instructions: e.target.value })} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <DifficultySelect value={c.difficulty} onChange={(difficulty) => set({ difficulty })} />
        <label className="text-sm">
          <span className={fieldLabel}>{t("syllabus.sp.submissionType")}</span>
          <select className={selectCls} value={c.submissionType} onChange={(e) => set({ submissionType: e.target.value as StudentPracticeContent["submissionType"] })}>
            {SUBMISSION_TYPES.map((s) => <option key={s} value={s}>{t(`syllabus.sp.submission.${s}` as MessageKey)}</option>)}
          </select>
        </label>
      </div>
      <label className="text-sm"><span className={fieldLabel}>{t("syllabus.sp.expectedResult")}</span><Textarea rows={2} maxLength={20_000} value={c.expectedResult} onChange={(e) => set({ expectedResult: e.target.value })} /></label>
      <HintsField id={`${id}-hint`} value={c.hints} onChange={(hints) => set({ hints })} />
      <fieldset className="grid gap-2 text-sm sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-end">
        <legend className={`mb-1 ${fieldLabel}`}>{t("syllabus.sp.deadline")}</legend>
        <select
          className={selectCls}
          value={deadline.type}
          onChange={(e) => {
            const type = e.target.value as StudentPracticeContent["deadline"]["type"];
            set({ deadline: type === "RELATIVE_DAYS" ? { type, days: deadline.days ?? 7 } : type === "ABSOLUTE" ? { type, at: deadline.at } : { type } });
          }}
          aria-label={t("syllabus.sp.deadline")}
        >
          {(["NONE", "RELATIVE_DAYS", "ABSOLUTE"] as const).map((d) => <option key={d} value={d}>{t(`syllabus.sp.deadline.${d}`)}</option>)}
        </select>
        {deadline.type === "RELATIVE_DAYS" && (
          <label className="flex items-center gap-2">
            <Input type="number" min={1} max={365} className="w-24" value={deadline.days ?? ""} onChange={(e) => set({ deadline: { type: "RELATIVE_DAYS", days: Math.min(365, Math.max(1, Math.round(Number(e.target.value) || 1))) } })} />
            <span className="text-foreground-secondary">{t("syllabus.sp.deadlineDays")}</span>
          </label>
        )}
        {deadline.type === "ABSOLUTE" && (
          <Input type="datetime-local" value={toLocalInput(deadline.at ?? null)} onChange={(e) => set({ deadline: { type: "ABSOLUTE", at: fromLocalInput(e.target.value) ?? undefined } })} aria-label={t("syllabus.sp.deadlineAt")} />
        )}
      </fieldset>
      <fieldset className="text-sm">
        <legend className={`mb-1 ${fieldLabel}`}>{t("syllabus.sp.evaluation")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["AI_AUTO", "TEACHER"] as const).map((ev) => (
            <label key={ev} className={`flex cursor-pointer gap-2 rounded-lg border p-2.5 ${c.evaluation === ev ? "border-link bg-muted" : "border-border"}`}>
              <input type="radio" name={`${id}-evaluation`} className="mt-0.5 accent-link" checked={c.evaluation === ev} onChange={() => set({ evaluation: ev })} />
              <span className="min-w-0">
                <span className="block font-medium">{t(`syllabus.sp.evaluation.${ev}`)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t(`syllabus.sp.evaluationHint.${ev}`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <input type="checkbox" className="accent-link" checked={c.passPct !== undefined} onChange={(e) => set({ passPct: e.target.checked ? 60 : undefined })} />
        <span>{t("syllabus.sp.ownPassPct")}</span>
        {c.passPct !== undefined && (
          <Input type="number" min={0} max={100} className="w-24" value={c.passPct} onChange={(e) => set({ passPct: Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))) })} aria-label={t("syllabus.sp.ownPassPct")} />
        )}
      </label>
      <AttachmentsField value={c.attachments} onChange={(attachments) => set({ attachments })} />
      {taskId ? (
        <AnswerKeyField taskId={taskId} title={title} description={[c.instructions, c.expectedResult].filter(Boolean).join("\n\n")} attachments={c.attachments} />
      ) : (
        <p className="text-xs text-muted-foreground">{t("syllabus.sp.keyAfterSave")}</p>
      )}
    </div>
  );
}

export function AssessmentFields({
  c,
  onChange,
  assessmentId,
  onAssessment,
}: {
  c: AssessmentItemContent;
  onChange: (c: AssessmentItemContent) => void;
  assessmentId: string | null;
  onAssessment: (id: string | null) => void;
}) {
  const list = trpc.teacher.assessments.list.useQuery({}, { refetchOnWindowFocus: true });
  const [here] = useLocation();
  const set = (patch: Partial<AssessmentItemContent>) => onChange({ ...c, ...patch });
  const selected = list.data?.find((a) => a.id === assessmentId);
  return (
    <div className="grid gap-3">
      <div className="text-sm">
        <label className="block">
          <span className={fieldLabel}>{t("syllabus.as.pick")}</span>
          <select className={selectCls} value={assessmentId ?? ""} onChange={(e) => onAssessment(e.target.value || null)}>
            <option value="">{t("syllabus.as.none")}</option>
            {(list.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
                {a.status !== "PUBLISHED" ? ` (${t("syllabus.as.notPublished")})` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a href={builderPath("/teacher/assessments/new", here)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-link underline">
            <ExternalLink className="h-4 w-4" aria-hidden />
            {t("syllabus.as.createNew")}
          </a>
          <Button type="button" size="sm" variant="ghost" onClick={() => void list.refetch()} disabled={list.isFetching}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
            {t("syllabus.as.refresh")}
          </Button>
          {selected && (
            <a href={builderPath(`/teacher/assessments/${selected.id}/edit`, here)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-link underline">
              {t("syllabus.as.openBuilder")}
            </a>
          )}
        </div>
        {selected && selected.status !== "PUBLISHED" && <p className="mt-1 text-xs text-warning">{t("syllabus.as.mustPublish")}</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className={fieldLabel}>{t("syllabus.as.passPct")}</span>
          <Input type="number" min={0} max={100} value={c.passPct ?? ""} placeholder={t("syllabus.as.inherit")} onChange={(e) => set({ passPct: e.target.value === "" ? undefined : Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
        </label>
        <label className="text-sm">
          <span className={fieldLabel}>{t("syllabus.as.maxAttempts")}</span>
          <select
            className={selectCls}
            value={c.maxAttempts === undefined ? "inherit" : c.maxAttempts === null ? "unlimited" : String(c.maxAttempts)}
            onChange={(e) => set({ maxAttempts: e.target.value === "inherit" ? undefined : e.target.value === "unlimited" ? null : Number(e.target.value) })}
          >
            <option value="inherit">{t("syllabus.as.inherit")}</option>
            <option value="unlimited">{t("syllabus.rules.unlimited")}</option>
            {Array.from({ length: MAX_ATTEMPTS_LIMIT }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className={fieldLabel}>{t("syllabus.as.cooldown")}</span>
          <Input type="number" min={0} max={10_080} value={c.cooldownMinutes ?? ""} placeholder={t("syllabus.as.inherit")} onChange={(e) => set({ cooldownMinutes: e.target.value === "" ? undefined : Math.min(10_080, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
        </label>
        <label className="text-sm">
          <span className={fieldLabel}>{t("syllabus.as.scorePolicy")}</span>
          <select className={selectCls} value={c.scorePolicy ?? ""} onChange={(e) => set({ scorePolicy: (e.target.value || undefined) as AssessmentItemContent["scorePolicy"] })}>
            <option value="">{t("syllabus.as.inherit")}</option>
            {SCORE_POLICIES.map((p) => <option key={p} value={p}>{t(`syllabus.rules.scorePolicy.${p}`)}</option>)}
          </select>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t("syllabus.as.inheritHelp")}</p>
    </div>
  );
}

export function ResourceFields({ c, onChange, materials }: { c: ResourceContent; onChange: (c: ResourceContent) => void; materials: { id: string; title: string }[] }) {
  const set = (patch: Partial<ResourceContent>) => onChange({ ...c, ...patch });
  return (
    <div className="grid gap-3">
      <label className="text-sm">
        <span className={fieldLabel}>{t("syllabus.material.pick")}</span>
        <select className={selectCls} value={c.materialId ?? ""} onChange={(e) => set({ materialId: e.target.value || undefined })}>
          <option value="">{t("syllabus.material.none")}</option>
          {materials.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
        <span className="mt-1 block text-xs text-muted-foreground">{materials.length ? t("syllabus.resource.byReference") : t("syllabus.material.empty")}</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm"><span className={fieldLabel}>{t("syllabus.link.url")}</span><Input type="url" maxLength={2000} value={c.url ?? ""} onChange={(e) => set({ url: e.target.value.trim() || undefined })} placeholder={t("syllabus.urlPlaceholder")} /></label>
        <label className="text-sm"><span className={fieldLabel}>{t("syllabus.link.title")}</span><Input maxLength={255} value={c.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} /></label>
      </div>
      <label className="text-sm"><span className={fieldLabel}>{t("syllabus.resource.note")}</span><Textarea rows={2} maxLength={2000} value={c.note} onChange={(e) => set({ note: e.target.value })} /></label>
    </div>
  );
}

export function DraftFields({
  draft,
  onChange,
  id,
  taskId,
  title,
  assessmentId,
  onAssessment,
  materials,
}: {
  draft: ItemDraft;
  onChange: (d: ItemDraft) => void;
  id: string;
  taskId: string | null;
  title: string;
  assessmentId: string | null;
  onAssessment: (id: string | null) => void;
  materials: { id: string; title: string; fileId: string | null }[];
}) {
  switch (draft.kind) {
    case "THEORY":
      return <TheoryEditor value={draft.blocks} onChange={(blocks) => onChange({ kind: "THEORY", blocks })} materials={materials} />;
    case "TEACHER_PRACTICE":
      return <TeacherPracticeFields id={id} c={draft.c} onChange={(c) => onChange({ kind: "TEACHER_PRACTICE", c })} />;
    case "STUDENT_PRACTICE":
      return <StudentPracticeFields id={id} c={draft.c} onChange={(c) => onChange({ kind: "STUDENT_PRACTICE", c })} taskId={taskId} title={title} />;
    case "ASSESSMENT":
      return <AssessmentFields c={draft.c} onChange={(c) => onChange({ kind: "ASSESSMENT", c })} assessmentId={assessmentId} onAssessment={onAssessment} />;
    case "RESOURCE":
      return <ResourceFields c={draft.c} onChange={(c) => onChange({ kind: "RESOURCE", c })} materials={materials} />;
  }
}

export { blockTypeLabel };
