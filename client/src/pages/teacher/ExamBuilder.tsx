import { AppShell, ChoiceChip, ErrorNote, Loading, Panel, Pill } from "@/components/AppShell";
import { draftFromQuestion, QuestionEditor } from "@/components/QuestionEditor";
import { bankLabel, SectionPicker, sectionsOf, subjectsOf, TopicSelect, useTopics, type TopicRow } from "@/components/questionBank/Topics";
import { QuestionRenderer } from "@/components/QuestionRenderer";
import { ShareBox, ShareFunnelSummary } from "@/components/ShareBox";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t, type MessageKey } from "@/i18n/messages";
import { errorText, fmtDuration, fromLocalInput, questionTypeLabel, releaseLabel, reviewLabel, toLocalInput, typeLabel } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CLOSED_QUESTION_TYPES, DEFAULT_WRONG_PENALTY, QUESTION_TYPES, type AssessmentType, type QuestionInput, type QuestionType } from "@shared/assessment";
import { builderPath, safeSyllabusEditorPath } from "@/lib/syllabusLearn";
import { ArrowDown, ArrowLeft, ArrowUp, Check, FileUp, Library, Pencil, Replace, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { PublishDialog } from "./Assessments";

const STEPS: { key: "basics" | "questions" | "participants" | "rules" | "publish"; label: MessageKey }[] = [
  { key: "basics", label: "builder.step.basics" },
  { key: "questions", label: "builder.step.questions" },
  { key: "participants", label: "builder.step.participants" },
  { key: "rules", label: "builder.step.rules" },
  { key: "publish", label: "builder.step.publish" },
];
type StepKey = (typeof STEPS)[number]["key"];

const selectClass = "mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-foreground";
const fieldLabel = "text-foreground-secondary";

function Stepper({ current, onSelect, disabled }: { current: StepKey; onSelect: (s: StepKey) => void; disabled?: boolean }) {
  const idx = STEPS.findIndex((s) => s.key === current);
  return (
    <nav aria-label={t("builder.steps")}>
      <ol className="flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <li key={s.key}>
            <button
              type="button"
              disabled={disabled && i > 0}
              onClick={() => onSelect(s.key)}
              aria-current={s.key === current ? "step" : undefined}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground ${s.key === current ? "border-primary bg-primary font-medium text-primary-foreground" : i < idx ? "border-success/40 bg-success-surface text-foreground" : "border-input bg-card text-foreground hover:bg-muted"}`}
            >
              <span className={`flex h-5 w-5 items-center justify-center rounded-full border border-current text-xs ${i < idx ? "text-success" : ""}`}>
                {i < idx ? <Check className="h-3 w-3" aria-label={t("common.completedStep")} /> : i + 1}
              </span>
              {t(s.label)}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function BackToSyllabus({ href }: { href: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm text-link underline-offset-4 hover:underline">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {t("builder.backToSyllabus")}
    </Link>
  );
}

/** `/teacher/assessments/new` — step 1 creates the draft, then continues in the edit route. */
export function NewAssessmentPage() {
  const [, nav] = useLocation();
  const search = new URLSearchParams(useSearch());
  const initialType = (search.get("type") ?? "EXAM") as AssessmentType;
  const returnTo = safeSyllabusEditorPath(search.get("returnTo"));
  const [form, setForm] = useState({ type: initialType, title: "", subject: "", description: "", instructions: "" });
  const create = trpc.teacher.assessments.create.useMutation({
    onSuccess: (a) => nav(builderPath(`/teacher/assessments/${a.id}/edit?step=questions`, returnTo)),
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <AppShell area="teaching" title={t("builder.newTitle")}>
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <Stepper current="basics" onSelect={() => undefined} disabled />
          {returnTo && <BackToSyllabus href={returnTo} />}
        </div>
        <Panel title={t("builder.step.basics")}>
          <BasicsForm value={form} onChange={setForm} typeEditable />
          <div className="mt-5 flex justify-end">
            <Button
              disabled={!form.title.trim() || create.isPending}
              onClick={() => create.mutate({ type: form.type, settings: { title: form.title, subject: form.subject, description: form.description, instructions: form.instructions } })}
            >
              {t("builder.createContinue")}
            </Button>
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}

function BasicsForm({
  value,
  onChange,
  typeEditable,
}: {
  value: { type: AssessmentType; title: string; subject: string; description: string; instructions: string };
  onChange: (v: typeof value) => void;
  typeEditable?: boolean;
}) {
  const [schoolFormats, setSchoolFormats] = useState(value.type !== "EXAM");
  return (
    <div className="grid gap-4">
      {schoolFormats ? (
        <div role="group" aria-labelledby="basics-type">
          <div id="basics-type" className="text-sm text-foreground-secondary">{t("common.type")}</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {(["EXAM", "KSQ", "BSQ"] as const).map((type) => (
              <ChoiceChip key={type} selected={value.type === type} disabled={!typeEditable && value.type !== type} onClick={() => typeEditable && onChange({ ...value, type })} className="px-4">
                {typeLabel(type)}
              </ChoiceChip>
            ))}
          </div>
        </div>
      ) : typeEditable ? (
        <button type="button" onClick={() => setSchoolFormats(true)} className="justify-self-start text-sm text-link underline-offset-4 hover:underline">
          {t("builder.schoolFormats")}
        </button>
      ) : null}
      <label className="text-sm">
        <span className={fieldLabel}>{t("common.required", { label: t("common.name") })}</span>
        <Input required value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} placeholder={t("builder.titlePlaceholder")} />
      </label>
      <label className="text-sm"><span className={fieldLabel}>{t("common.subject")}</span><Input value={value.subject} onChange={(e) => onChange({ ...value, subject: e.target.value })} /></label>
      <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={2} value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} /></label>
      <label className="text-sm"><span className={fieldLabel}>{t("builder.instructions")}</span><Textarea rows={3} value={value.instructions} onChange={(e) => onChange({ ...value, instructions: e.target.value })} /></label>
    </div>
  );
}

/** `/teacher/assessments/:id/edit?step=` — full-page builder. */
export function EditAssessmentPage() {
  const { id = "" } = useParams<{ id: string }>();
  const search = new URLSearchParams(useSearch());
  const [, nav] = useLocation();
  const step = (STEPS.some((s) => s.key === search.get("step")) ? search.get("step") : "basics") as StepKey;
  const returnTo = safeSyllabusEditorPath(search.get("returnTo"));
  const detail = trpc.teacher.assessments.detail.useQuery({ id });
  const stepper = useRef<HTMLDivElement>(null);
  const go = (s: StepKey) => nav(builderPath(`/teacher/assessments/${id}/edit?step=${s}`, returnTo));
  const next = () => go(STEPS[Math.min(STEPS.length - 1, STEPS.findIndex((s) => s.key === step) + 1)].key);
  const a = detail.data;

  // A wizard step is new content: bring the stepper back into view, but only if it scrolled away.
  useEffect(() => {
    const el = stepper.current;
    if (el && el.getBoundingClientRect().top < 0) window.scrollTo({ top: 0, behavior: "instant" });
  }, [step]);

  return (
    <AppShell area="teaching" title={a ? t("builder.editTitle", { title: a.title }) : t("builder.edit")}>
      {detail.error ? (
        <ErrorNote error={detail.error} />
      ) : !a ? (
        <Loading />
      ) : (
        <div className="mx-auto max-w-5xl space-y-5">
          <div ref={stepper} className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <Stepper current={step} onSelect={go} />
            <div className="flex flex-wrap items-center gap-3">
              {returnTo && <BackToSyllabus href={returnTo} />}
              <Link href={`/teacher/assessments/${id}`} className="text-sm text-link underline-offset-4 hover:underline">{t("builder.detailLink")}</Link>
            </div>
          </div>
          {returnTo && a.status !== "PUBLISHED" && <div className="rounded-xl bg-muted p-3 text-sm">{t("builder.syllabusPublishHint")}</div>}
          {a.status === "CLOSED" && <div className="rounded-xl bg-muted p-3 text-sm">{t("builder.closedNote")}</div>}
          {a.currentVersionId && a.status !== "CLOSED" && (
            <div className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-foreground">{t("builder.editingPublished")}</div>
          )}
          {step === "basics" && <BasicsStep a={a} onNext={next} />}
          {step === "questions" && <QuestionsStep a={a} onNext={next} />}
          {step === "participants" && <ParticipantsStep a={a} onNext={next} />}
          {step === "rules" && <RulesStep a={a} onNext={next} />}
          {step === "publish" && <PublishStep a={a} />}
        </div>
      )}
    </AppShell>
  );
}

type Detail = RouterOutputs["teacher"]["assessments"]["detail"];

function useInvalidateDetail(id: string) {
  const utils = trpc.useUtils();
  return () => utils.teacher.assessments.detail.invalidate({ id });
}

function BasicsStep({ a, onNext }: { a: Detail; onNext: () => void }) {
  const [form, setForm] = useState({ type: a.type, title: a.settings.title, subject: a.settings.subject, description: a.settings.description, instructions: a.settings.instructions });
  const invalidate = useInvalidateDetail(a.id);
  const save = trpc.teacher.assessments.updateSettings.useMutation({ onSuccess: () => { void invalidate(); onNext(); }, onError: (e) => toast.error(errorText(e)) });
  return (
    <Panel title={t("builder.step.basics")}>
      <BasicsForm value={form} onChange={setForm} />
      <div className="mt-5 flex justify-end">
        <Button disabled={!form.title.trim() || save.isPending} onClick={() => save.mutate({ id: a.id, patch: { title: form.title, subject: form.subject, description: form.description, instructions: form.instructions } })}>
          {t("common.saveAndContinue")}
        </Button>
      </div>
    </Panel>
  );
}

function QuestionsStep({ a, onNext }: { a: Detail; onNext: () => void }) {
  const invalidate = useInvalidateDetail(a.id);
  const utils = trpc.useUtils();
  const topics = useTopics();
  const topicList = topics.data ?? [];
  const [editing, setEditing] = useState<string | "new" | null>(a.questions.length ? null : "new");
  const [newSection, setNewSection] = useState("");
  const [bankOpen, setBankOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [replacing, setReplacing] = useState<Detail["questions"][number] | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const onError = (e: unknown) => toast.error(errorText(e));
  const create = trpc.teacher.assessments.createQuestion.useMutation({
    onSuccess: () => {
      setEditing(null);
      void invalidate();
      void utils.teacher.questionTopics.list.invalidate();
    },
    onError,
  });
  const update = trpc.teacher.questions.update.useMutation({ onSuccess: () => { setEditing(null); void invalidate(); }, onError });
  const remove = trpc.teacher.assessments.removeQuestion.useMutation({ onSuccess: () => void invalidate(), onError });
  const reorder = trpc.teacher.assessments.reorder.useMutation({ onSuccess: () => void invalidate(), onError });
  const total = a.questions.reduce((s, q) => s + q.points, 0);

  const move = (i: number, dir: -1 | 1) => {
    const ids = a.questions.map((q) => q.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate({ id: a.id, questionIds: ids });
  };

  const iconButton = "rounded p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:text-border-strong disabled:hover:bg-transparent";

  return (
    <div className="space-y-4">
      <Panel
        title={t("builder.questionsTitle", { count: a.questions.length, points: total })}
        action={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setBuildOpen(true)}><Library className="h-4 w-4" aria-hidden /> {t("builder.buildFromBank")}</Button>
            <Button size="sm" variant="outline" onClick={() => setBankOpen(true)}>{t("builder.fromBank")}</Button>
            <Button size="sm" variant="outline" onClick={() => setAiOpen(true)}><Sparkles className="h-4 w-4" aria-hidden /> {t("builder.withAi")}</Button>
            <Button size="sm" onClick={() => setEditing("new")}>{t("builder.newQuestion")}</Button>
          </div>
        }
      >
        <ol className="space-y-3">
          {a.questions.map((q, i) => (
            <li key={q.id} className="rounded-xl border p-3">
              {editing === q.id ? (
                <QuestionEditor hideTopic={!!q.sectionId} initial={draftFromQuestion(q)} busy={update.isPending} onCancel={() => setEditing(null)} onSubmit={(question) => update.mutate({ id: q.id, question })} />
              ) : (
                <div className="flex gap-3">
                  <div className="flex flex-col gap-1">
                    <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className={iconButton} aria-label={t("builder.moveUpN", { n: i + 1 })}><ArrowUp className="h-4 w-4" aria-hidden /></button>
                    <button type="button" disabled={i === a.questions.length - 1} onClick={() => move(i, 1)} className={iconButton} aria-label={t("builder.moveDownN", { n: i + 1 })}><ArrowDown className="h-4 w-4" aria-hidden /></button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground-secondary">{i + 1}.</span>
                      <Pill>{questionTypeLabel(q.type)}</Pill>
                      <span>{t("common.points", { count: q.points })}</span>
                      {bankLabel(topicList, q) ? <span className="text-link">· {bankLabel(topicList, q)}</span> : q.topic && <span>· {q.topic}</span>}
                      {q.skill && <span>· {q.skill}</span>}
                      {q.source === "AI" && <StatusBadge tone="info" icon={Sparkles}>AI</StatusBadge>}
                    </div>
                    <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm" title={q.text}>{q.text}</div>
                  </div>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => setReplacing(q)} className={iconButton} aria-label={t("builder.replaceN", { n: i + 1 })} title={t("builder.replaceFromBank")}><Replace className="h-4 w-4" aria-hidden /></button>
                    <button type="button" onClick={() => setEditing(q.id)} className={iconButton} aria-label={t("builder.editN", { n: i + 1 })}><Pencil className="h-4 w-4" aria-hidden /></button>
                    <button
                      type="button"
                      onClick={() => confirm(t("builder.removeConfirm")) && remove.mutate({ id: a.id, questionId: q.id })}
                      className="rounded p-1.5 hover:bg-danger-surface hover:text-destructive"
                      aria-label={t("builder.removeN", { n: i + 1 })}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
        {editing === "new" && (
          <div className="mt-4 rounded-xl border border-dashed border-link p-4">
            <div className="mb-3 font-medium">{t("builder.newQuestionTitle")}</div>
            <SectionPicker className="mb-4" value={newSection} onChange={setNewSection} />
            {newSection ? (
              <QuestionEditor hideTopic busy={create.isPending} submitLabel={t("common.add")} onCancel={a.questions.length ? () => setEditing(null) : undefined} onSubmit={(question) => create.mutate({ id: a.id, question, sectionId: newSection })} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("qbank.pickSectionFirst")}</p>
            )}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{t("builder.bankEditNote")}</p>
      </Panel>
      <div className="flex justify-end"><Button disabled={!a.questions.length} onClick={onNext}>{t("common.continue")}</Button></div>
      <BankDialog open={bankOpen} onOpenChange={setBankOpen} assessmentId={a.id} existing={a.questions.map((q) => q.id)} />
      {buildOpen && <BuildFromBankDialog onOpenChange={setBuildOpen} a={a} topics={topicList} />}
      {replacing && <ReplaceDialog onOpenChange={(v) => !v && setReplacing(null)} a={a} question={replacing} topics={topicList} />}
      <AiDialog open={aiOpen} onOpenChange={setAiOpen} assessmentId={a.id} />
    </div>
  );
}

const filterCls = "rounded-lg border border-input bg-card px-2 text-sm text-foreground";

/** How many of a section's bank questions are not in the exam yet. */
function availableIn(section: TopicRow, a: Detail) {
  return Math.max(0, section.questionCount - a.questions.filter((q) => q.sectionId === section.id).length);
}

type SectionPlan = { on: boolean; count: number; picked: string[]; byHand: boolean };

/**
 * A general exam (several sections) or a topic exam (one): per section, a random number of
 * questions and/or hand-picked ones. Questions already in the exam are never drawn again.
 */
function BuildFromBankDialog({ onOpenChange, a, topics }: { onOpenChange: (v: boolean) => void; a: Detail; topics: TopicRow[] }) {
  const invalidate = useInvalidateDetail(a.id);
  const subjects = subjectsOf(topics);
  const [subjectId, setSubjectId] = useState(() => {
    const first = a.questions.find((q) => q.sectionId)?.sectionId;
    return topics.find((x) => x.id === first)?.parentId ?? subjects[0]?.id ?? "";
  });
  const [plan, setPlan] = useState<Record<string, SectionPlan>>({});
  const sections = subjectId ? sectionsOf(topics, subjectId) : [];
  const planOf = (id: string): SectionPlan => plan[id] ?? { on: false, count: 0, picked: [], byHand: false };
  const patch = (id: string, p: Partial<SectionPlan>) => setPlan((cur) => ({ ...cur, [id]: { ...planOf(id), ...p } }));
  const picks = sections
    .map((s) => ({ s, p: planOf(s.id) }))
    .filter(({ p }) => p.on && (p.count > 0 || p.picked.length > 0))
    .map(({ s, p }) => ({ sectionId: s.id, count: p.count || undefined, questionIds: p.picked.length ? p.picked : undefined }));
  const total = picks.reduce((n, p) => n + (p.count ?? 0) + (p.questionIds?.length ?? 0), 0);
  const add = trpc.teacher.assessments.addFromBank.useMutation({
    onSuccess: (r) => {
      toast.success(t("builder.bankAdded", { count: r.added }));
      for (const s of r.short) {
        const name = topics.find((x) => x.id === s.sectionId)?.name ?? "";
        toast.message(t("builder.bankShort", { name, requested: s.requested, drawn: s.drawn }));
      }
      void invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("builder.buildTitle")}</DialogTitle>
          <DialogDescription>{t("builder.buildHelp")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid content-start gap-4">
          {!subjects.length ? (
            <p className="text-sm text-muted-foreground">{t("builder.buildNoSections")}</p>
          ) : (
            <label className="text-sm">
              <span className={fieldLabel}>{t("qbank.subject")}</span>
              <select className={selectClass} value={subjectId} onChange={(e) => { setSubjectId(e.target.value); setPlan({}); }}>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          {subjectId && !sections.length && <p className="text-sm text-muted-foreground">{t("builder.buildNoSections")}</p>}
          <ul className="divide-y">
            {sections.map((s) => {
              const p = planOf(s.id);
              const available = availableIn(s, a);
              return (
                <li key={s.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <input type="checkbox" className="accent-link" checked={p.on} disabled={!available && !p.on} onChange={(e) => patch(s.id, { on: e.target.checked })} />
                      <span className="break-words font-medium">{s.name}</span>
                      <span className="text-xs text-muted-foreground">{t("builder.available", { count: available })}</span>
                    </label>
                    {p.on && (
                      <>
                        <label className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground">{t("builder.randomCount")}</span>
                          <Input
                            type="number"
                            className="w-20"
                            min={0}
                            max={Math.max(0, available - p.picked.length)}
                            value={p.count}
                            onChange={(e) => patch(s.id, { count: Math.min(Math.max(0, available - p.picked.length), Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
                          />
                        </label>
                        <Button size="sm" variant="ghost" aria-expanded={p.byHand} onClick={() => patch(s.id, { byHand: !p.byHand })}>
                          {t("builder.pickByHand", { count: p.picked.length })}
                        </Button>
                      </>
                    )}
                  </div>
                  {p.on && p.byHand && (
                    <SectionQuestionPicker
                      section={s}
                      topics={topics}
                      inExam={a.questions.map((q) => q.id)}
                      picked={p.picked}
                      onChange={(picked) => patch(s.id, { picked, count: Math.min(p.count, Math.max(0, available - picked.length)) })}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </DialogBody>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-sm text-muted-foreground">{t("builder.buildTotal", { count: total })}</span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={!picks.length || add.isPending} onClick={() => add.mutate({ id: a.id, picks })}>{t("builder.buildAdd", { count: total })}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionQuestionPicker({ section, topics, inExam, picked, onChange }: { section: TopicRow; topics: TopicRow[]; inExam: string[]; picked: string[]; onChange: (ids: string[]) => void }) {
  const bank = trpc.teacher.questions.bank.useQuery({ topicId: section.id });
  if (bank.isLoading) return <Loading />;
  const rows = bank.data ?? [];
  return (
    <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
      {rows.map((q) => {
        const added = inExam.includes(q.id);
        return (
          <li key={q.id}>
            <label className={`flex items-start gap-2 text-sm ${added ? "text-muted-foreground" : ""}`}>
              <input
                type="checkbox"
                className="mt-1 accent-link"
                disabled={added}
                checked={added || picked.includes(q.id)}
                onChange={(e) => onChange(e.target.checked ? [...picked, q.id] : picked.filter((x) => x !== q.id))}
              />
              <span className="min-w-0 flex-1">
                <span className="text-xs font-medium text-link">{bankLabel(topics, q)}</span>
                {added && <span className="ms-2 text-xs">{t("builder.alreadyInExam")}</span>}
                <span className="line-clamp-2 block break-words" title={q.text}>{q.text}</span>
              </span>
            </label>
          </li>
        );
      })}
      {!rows.length && <li className="py-3 text-center text-sm text-muted-foreground">{t("builder.bankEmpty")}</li>}
    </ul>
  );
}

/** Swap one exam question for another bank question (same place in the exam), from its section by default. */
function ReplaceDialog({ onOpenChange, a, question, topics }: { onOpenChange: (v: boolean) => void; a: Detail; question: Detail["questions"][number]; topics: TopicRow[] }) {
  const invalidate = useInvalidateDetail(a.id);
  const [topicId, setTopicId] = useState(question.sectionId ?? "");
  const [search, setSearch] = useState("");
  const bank = trpc.teacher.questions.bank.useQuery({ topicId: topicId || undefined, search: search || undefined });
  const replace = trpc.teacher.assessments.replaceQuestion.useMutation({
    onSuccess: () => {
      toast.success(t("builder.replaced"));
      void invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const inExam = new Set(a.questions.map((q) => q.id));
  const rows = (bank.data ?? []).filter((q) => !inExam.has(q.id));
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("builder.replaceFromBank")}</DialogTitle>
          <DialogDescription className="line-clamp-2 break-words">{question.text}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-0 flex-1" placeholder={t("common.search")} aria-label={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
          <TopicSelect topics={topics} value={topicId} onChange={setTopicId} emptyLabel={t("qbank.allTopics")} ariaLabel={t("qbank.filterTopic")} className={`max-w-[16rem] ${filterCls}`} />
        </div>
        <DialogBody>
          {bank.isLoading ? <Loading /> : (
            <ul className="divide-y">
              {rows.map((q) => (
                <li key={q.id} className="flex items-center gap-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-link">{bankLabel(topics, q) ?? t("qbank.unsorted")}</div>
                    <div className="line-clamp-2 break-words" title={q.text}>{q.text}</div>
                    <div className="text-xs text-muted-foreground">{questionTypeLabel(q.type)} · {t("common.points", { count: q.points })}</div>
                  </div>
                  <Button size="sm" disabled={replace.isPending} onClick={() => replace.mutate({ id: a.id, questionId: question.id, withQuestionId: q.id })}>
                    {t("builder.useThis")}
                  </Button>
                </li>
              ))}
              {!rows.length && <li className="py-6 text-center text-sm text-muted-foreground">{t("builder.bankEmpty")}</li>}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function BankDialog({ open, onOpenChange, assessmentId, existing }: { open: boolean; onOpenChange: (v: boolean) => void; assessmentId: string; existing: string[] }) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [topicId, setTopicId] = useState("");
  const topics = useTopics(open);
  const topicList = topics.data ?? [];
  const bank = trpc.teacher.questions.bank.useQuery({ search: search || undefined, type: (type || undefined) as never, topicId: topicId || undefined }, { enabled: open });
  const invalidate = useInvalidateDetail(assessmentId);
  const add = trpc.teacher.assessments.addQuestion.useMutation({ onSuccess: () => void invalidate(), onError: (e) => toast.error(errorText(e)) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t("builder.bankTitle")}</DialogTitle></DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-0 flex-1" placeholder={t("common.search")} aria-label={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
          <TopicSelect topics={topicList} value={topicId} onChange={setTopicId} emptyLabel={t("qbank.allTopics")} ariaLabel={t("qbank.filterTopic")} className={`max-w-[14rem] ${filterCls}`} />
          <select className={filterCls} aria-label={t("modules.filterType")} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">{t("modules.allTypes")}</option>
            {QUESTION_TYPES.map((k) => <option key={k} value={k}>{questionTypeLabel(k)}</option>)}
          </select>
          <Link href="/teacher/library/import" className="inline-flex items-center gap-1 self-center text-sm text-link hover:underline">
            <FileUp className="h-4 w-4" aria-hidden />
            {t("qimport.open")}
          </Link>
        </div>
        <DialogBody>
          <ul className="divide-y">
            {(bank.data ?? []).map((q) => {
              const added = existing.includes(q.id);
              return (
                <li key={q.id} className="flex items-center gap-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-link">{bankLabel(topicList, q) ?? t("qbank.unsorted")}</div>
                    <div className="line-clamp-2 break-words" title={q.text}>{q.text}</div>
                    <div className="text-xs text-muted-foreground">
                      {questionTypeLabel(q.type)} · {t("common.points", { count: q.points })}{!q.sectionId && q.topic ? ` · ${q.topic}` : ""}
                    </div>
                  </div>
                  <Button size="sm" variant={added ? "outline" : "default"} disabled={added || add.isPending} onClick={() => add.mutate({ id: assessmentId, questionId: q.id })}>
                    {added ? t("common.added") : t("common.add")}
                  </Button>
                </li>
              );
            })}
            {bank.data?.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">{t("builder.bankEmpty")}</li>}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

const AI_TYPES = ["MULTIPLE_CHOICE", "MULTIPLE_SELECT", "TRUE_FALSE", "SHORT_ANSWER", "FILL_BLANK", "NUMERIC"] as const;

function AiDialog({ open, onOpenChange, assessmentId }: { open: boolean; onOpenChange: (v: boolean) => void; assessmentId: string }) {
  const [form, setForm] = useState({ topic: "", grade: "", language: "az" as "az" | "ru" | "en" | "de", difficulty: "MEDIUM" as "EASY" | "MEDIUM" | "HARD", questionType: "MULTIPLE_CHOICE" as (typeof AI_TYPES)[number], count: 5, points: 1 });
  const [picked, setPicked] = useState<string[]>([]);
  const [sectionId, setSectionId] = useState("");
  const usage = trpc.teacher.ai.usage.useQuery(undefined, { enabled: open });
  const invalidate = useInvalidateDetail(assessmentId);
  const generate = trpc.teacher.ai.generate.useMutation({
    onSuccess: (r) => { setPicked(r.questions.map((q) => q.tempId)); void usage.refetch(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const accept = trpc.teacher.ai.accept.useMutation({
    onSuccess: (rows) => { toast.success(t("builder.aiAdded", { count: rows.length })); generate.reset(); void invalidate(); onOpenChange(false); },
    onError: (e) => toast.error(errorText(e)),
  });
  const draft = generate.data;

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
                {AI_TYPES.map((type) => <option key={type} value={type}>{questionTypeLabel(type)}</option>)}
              </select>
            </label>
            <label className="text-sm"><span className={fieldLabel}>{t("common.difficulty")}</span>
              <select className={selectClass} value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: e.target.value as typeof form.difficulty })}>
                {(["EASY", "MEDIUM", "HARD"] as const).map((d) => <option key={d} value={d}>{t(`common.difficulty.${d}`)}</option>)}
              </select>
            </label>
            <label className="text-sm"><span className={fieldLabel}>{t("builder.aiCount")}</span><Input type="number" min={1} max={10} value={form.count} onChange={(e) => setForm({ ...form, count: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("builder.aiPoints")}</span><Input type="number" min={0.5} step={0.5} value={form.points} onChange={(e) => setForm({ ...form, points: Number(e.target.value) || 1 })} /></label>
            <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
              <span className="text-xs text-muted-foreground">{t("builder.aiUsage", { used: usage.data?.used ?? 0, limit: usage.data?.limit ?? 100 })}</span>
              <Button disabled={form.topic.trim().length < 2 || generate.isPending} onClick={() => generate.mutate(form)}>{generate.isPending ? t("builder.aiGenerating") : t("builder.aiGenerate")}</Button>
            </div>
          </DialogBody>
        ) : (
          <>
            <DialogDescription>{t("builder.aiReview")}</DialogDescription>
            <DialogBody>
              <ul className="space-y-2">
                {draft.questions.map(({ tempId, question }) => (
                  <li key={tempId} className="rounded-xl border p-3 text-sm">
                    <label className="flex gap-3">
                      <input type="checkbox" className="mt-1 accent-link" checked={picked.includes(tempId)} onChange={(e) => setPicked(e.target.checked ? [...picked, tempId] : picked.filter((x) => x !== tempId))} />
                      <AiPreview q={question} />
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
              <Button disabled={!picked.length || !sectionId || accept.isPending} onClick={() => accept.mutate({ draftId: draft.draftId, tempIds: picked, sectionId, assessmentId })}>{t("builder.aiAccept", { count: picked.length })}</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AiPreview({ q }: { q: QuestionInput }) {
  const c = q.content as Record<string, any>;
  const k = q.answerKey as Record<string, any>;
  const answer = (value: string) => <div className="mt-1 text-xs text-success">{t("builder.answerValue", { value })}</div>;
  return (
    <div className="min-w-0 flex-1">
      <div className="whitespace-pre-wrap break-words">{q.text}</div>
      {Array.isArray(c.options) && (
        <ul className="mt-1 text-xs text-foreground-secondary">
          {c.options.map((o: { key: string; text: string }) => {
            const ok = Array.isArray(k.correct) ? k.correct.includes(o.key) : k.correct === o.key;
            return (
              <li key={o.key} className={ok ? "font-semibold text-success" : ""}>
                {ok && <Check className="mr-1 inline h-3 w-3" aria-label={t("common.correct")} />}
                {o.key}. {o.text}
              </li>
            );
          })}
        </ul>
      )}
      {q.type === "TRUE_FALSE" && answer(k.correct ? t("common.true") : t("common.false"))}
      {q.type === "SHORT_ANSWER" && answer((k.accepted ?? []).join(" / "))}
      {q.type === "FILL_BLANK" && answer((k.blanks ?? []).map((b: string[]) => b.join("/")).join(" | "))}
      {q.type === "NUMERIC" && answer(`${k.value}${k.tolerance ? ` ± ${k.tolerance}` : ""}`)}
      {q.explanation && <div className="mt-1 text-xs text-muted-foreground">{t("builder.explanationValue", { value: q.explanation })}</div>}
    </div>
  );
}

function ParticipantsStep({ a, onNext }: { a: Detail; onNext: () => void }) {
  const groups = trpc.teacher.groups.list.useQuery();
  const students = trpc.teacher.students.useQuery();
  const invalidate = useInvalidateDetail(a.id);
  const [groupIds, setGroupIds] = useState<string[]>(a.targets.groupIds);
  const [studentIds, setStudentIds] = useState<number[]>(a.targets.studentIds);
  const [useOverrides, setUseOverrides] = useState(false);
  const [ov, setOv] = useState({ availableFrom: "", availableUntil: "", durationMinutes: "", attempts: "" });
  const save = trpc.teacher.assessments.setTargets.useMutation({
    onSuccess: () => { toast.success(t("builder.targetsSaved")); void invalidate(); onNext(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const submit = () =>
    save.mutate({
      id: a.id,
      targets: { groupIds, studentIds },
      overrides: useOverrides
        ? {
            availableFrom: fromLocalInput(ov.availableFrom),
            availableUntil: fromLocalInput(ov.availableUntil),
            durationSeconds: ov.durationMinutes ? Math.round(Number(ov.durationMinutes) * 60) : null,
            attemptsAllowed: ov.attempts ? Number(ov.attempts) : null,
          }
        : undefined,
    });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t("common.groups")}>
          {!groups.data?.length ? (
            <p className="text-sm text-muted-foreground">
              {t("builder.noGroups")} <Link href="/teacher/groups" className="text-link underline-offset-4 hover:underline">{t("builder.createGroup")}</Link>
            </p>
          ) : (
            <ul className="space-y-2">
              {groups.data.map((g) => (
                <li key={g.id}>
                  <label className="flex items-center gap-3 rounded-xl border px-3 py-2 text-sm">
                    <input type="checkbox" className="accent-link" checked={groupIds.includes(g.id)} onChange={() => setGroupIds(toggle(groupIds, g.id))} />
                    <span className="min-w-0 flex-1 break-words">{g.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t("common.studentsCount", { count: g.studentCount })}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={t("builder.individualStudents")}>
          {!students.data?.length ? (
            <p className="text-sm text-muted-foreground">{t("builder.noActiveStudents")}</p>
          ) : (
            <ul className="max-h-80 space-y-2 overflow-y-auto">
              {students.data.map((s) => (
                <li key={s.id}>
                  <label className="flex items-center gap-3 rounded-xl border px-3 py-2 text-sm">
                    <input type="checkbox" className="accent-link" checked={studentIds.includes(s.id)} onChange={() => setStudentIds(toggle(studentIds, s.id))} />
                    <span className="min-w-0 flex-1 break-words">{s.name ?? s.email}</span>
                    <span className="max-w-[40%] truncate text-xs text-muted-foreground" title={s.groups.join(", ")}>{s.groups.join(", ")}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={t("builder.overridesTitle")}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-link" checked={useOverrides} onChange={(e) => setUseOverrides(e.target.checked)} />
          {t("builder.overridesToggle")}
        </label>
        {useOverrides && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm"><span className={fieldLabel}>{t("builder.start")}</span><Input type="datetime-local" value={ov.availableFrom} onChange={(e) => setOv({ ...ov, availableFrom: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("builder.end")}</span><Input type="datetime-local" value={ov.availableUntil} onChange={(e) => setOv({ ...ov, availableUntil: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("builder.durationMinutes")}</span><Input type="number" min={1} value={ov.durationMinutes} onChange={(e) => setOv({ ...ov, durationMinutes: e.target.value })} /></label>
            <label className="text-sm"><span className={fieldLabel}>{t("assessment.attemptsAllowed")}</span><Input type="number" min={1} max={20} value={ov.attempts} onChange={(e) => setOv({ ...ov, attempts: e.target.value })} /></label>
          </div>
        )}
      </Panel>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onNext}>{t("common.skip")}</Button>
        <Button disabled={save.isPending} onClick={submit}>{t("common.saveAndContinue")}</Button>
      </div>
    </div>
  );
}

function RulesStep({ a, onNext }: { a: Detail; onNext: () => void }) {
  const invalidate = useInvalidateDetail(a.id);
  const [f, setF] = useState({
    startAt: toLocalInput(a.startAt),
    endAt: toLocalInput(a.endAt),
    timezone: a.timezone,
    durationMinutes: String(Math.round(a.settings.durationSeconds / 60)),
    attemptsAllowed: String(a.settings.attemptsAllowed),
    randomize: a.settings.randomize,
    releaseMode: a.settings.releaseMode,
    reviewMode: a.settings.reviewMode,
    showCorrectAnswers: a.settings.showCorrectAnswers,
    showExplanations: a.settings.showExplanations,
    wrongPenalty: a.settings.wrongPenalty ?? DEFAULT_WRONG_PENALTY,
    emailResults: a.settings.emailResults ?? false,
  });
  const hasClosed = a.questions.some((q) => CLOSED_QUESTION_TYPES.includes(q.type as QuestionType));
  const schedule = trpc.teacher.assessments.updateSchedule.useMutation();
  const settings = trpc.teacher.assessments.updateSettings.useMutation();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const startAt = fromLocalInput(f.startAt);
    const endAt = fromLocalInput(f.endAt);
    if (startAt && endAt && endAt <= startAt) return toast.error(t("builder.endBeforeStart"));
    setBusy(true);
    try {
      await schedule.mutateAsync({ id: a.id, schedule: { startAt, endAt, timezone: f.timezone || "Asia/Baku" } });
      await settings.mutateAsync({
        id: a.id,
        patch: {
          durationSeconds: Math.max(60, Math.round(Number(f.durationMinutes) * 60)),
          attemptsAllowed: Math.min(20, Math.max(1, Number(f.attemptsAllowed) || 1)),
          randomize: f.randomize,
          releaseMode: f.releaseMode,
          reviewMode: f.reviewMode,
          showCorrectAnswers: f.showCorrectAnswers,
          showExplanations: f.showExplanations,
          wrongPenalty: { enabled: f.wrongPenalty.enabled, ratio: Math.min(10, Math.max(2, Math.round(f.wrongPenalty.ratio) || DEFAULT_WRONG_PENALTY.ratio)) },
          emailResults: f.emailResults,
        },
      });
      await invalidate();
      onNext();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel title={t("builder.timing")}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm"><span className={fieldLabel}>{t("builder.start")}</span><Input type="datetime-local" value={f.startAt} onChange={(e) => setF({ ...f, startAt: e.target.value })} /></label>
          <label className="text-sm"><span className={fieldLabel}>{t("builder.end")}</span><Input type="datetime-local" value={f.endAt} onChange={(e) => setF({ ...f, endAt: e.target.value })} /></label>
          <label className="text-sm"><span className={fieldLabel}>{t("builder.durationMinutes")}</span><Input type="number" min={1} max={720} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: e.target.value })} /></label>
          <label className="text-sm"><span className={fieldLabel}>{t("assessment.attemptsAllowed")}</span><Input type="number" min={1} max={20} value={f.attemptsAllowed} onChange={(e) => setF({ ...f, attemptsAllowed: e.target.value })} /></label>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t("builder.timingHelp")}</p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-link" checked={f.randomize} onChange={(e) => setF({ ...f, randomize: e.target.checked })} /> {t("builder.shufflePerStudent")}
        </label>
      </Panel>
      <Panel title={t("builder.resultRules")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1 text-foreground-secondary">{t("builder.whenVisible")}</legend>
            {(["IMMEDIATE", "AFTER_CLOSE", "AFTER_GRADING"] as const).map((m) => (
              <label key={m} className="flex items-center gap-2">
                <input type="radio" name="releaseMode" className="accent-link" checked={f.releaseMode === m} onChange={() => setF({ ...f, releaseMode: m })} /> {releaseLabel(m)}
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1 text-foreground-secondary">{t("builder.whatVisible")}</legend>
            {(["SCORE_ONLY", "WRONG_ONLY", "FULL"] as const).map((m) => (
              <label key={m} className="flex items-center gap-2">
                <input type="radio" name="reviewMode" className="accent-link" checked={f.reviewMode === m} onChange={() => setF({ ...f, reviewMode: m })} /> {reviewLabel(m)}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="mt-3 space-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-link" disabled={f.reviewMode === "SCORE_ONLY"} checked={f.showCorrectAnswers} onChange={(e) => setF({ ...f, showCorrectAnswers: e.target.checked })} /> {t("assessment.showCorrect")}</label>
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-link" disabled={f.reviewMode === "SCORE_ONLY"} checked={f.showExplanations} onChange={(e) => setF({ ...f, showExplanations: e.target.checked })} /> {t("assessment.showExplanations")}</label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 accent-link" checked={f.emailResults} onChange={(e) => setF({ ...f, emailResults: e.target.checked })} />
            <span>
              {t("builder.emailResults")}
              <span className="block text-xs text-muted-foreground">{t("builder.emailResultsHelp")}</span>
            </span>
          </label>
        </div>
      </Panel>
      {(hasClosed || f.wrongPenalty.enabled) && (
        <Panel title={t("builder.penaltyTitle")}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="accent-link" checked={f.wrongPenalty.enabled} onChange={(e) => setF({ ...f, wrongPenalty: { ...f.wrongPenalty, enabled: e.target.checked } })} />
              {t("builder.penaltyToggle")}
            </label>
            <label className="flex items-center gap-2">
              <Input
                type="number"
                className="w-20"
                min={2}
                max={10}
                disabled={!f.wrongPenalty.enabled}
                aria-label={t("builder.penaltyRatio")}
                value={f.wrongPenalty.ratio}
                onChange={(e) => setF({ ...f, wrongPenalty: { ...f.wrongPenalty, ratio: Number(e.target.value) } })}
              />
              <span>{t("builder.penaltyRatioSuffix")}</span>
            </label>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("builder.penaltyHelp", { ratio: f.wrongPenalty.ratio || DEFAULT_WRONG_PENALTY.ratio })}</p>
        </Panel>
      )}
      <div className="flex justify-end"><Button disabled={busy} onClick={() => void save()}>{t("common.saveAndContinue")}</Button></div>
    </div>
  );
}

function PublishStep({ a }: { a: Detail }) {
  const preview = trpc.teacher.assessments.preview.useQuery({ id: a.id });
  const invalidate = useInvalidateDetail(a.id);
  const shareFunnelQ = trpc.teacher.assessments.shareFunnel.useQuery({ id: a.id }, { enabled: Boolean(a.currentVersionId) });
  const [mode, setMode] = useState<"student" | "key">("student");
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const publish = trpc.teacher.assessments.publish.useMutation({
    onSuccess: (v) => { toast.success(v.created ? t("assessment.publishedToast", { n: v.versionNo }) : t("assessment.noChanges")); setOpen(false); void invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });
  useEffect(() => setAnswers({}), [preview.data]);
  const canPublish = a.status !== "CLOSED" && (a.hasDraftChanges || !a.currentVersionId);
  const totalPoints = a.questions.reduce((s, q) => s + q.points, 0);

  return (
    <div className="space-y-4">
      <Panel title={t("builder.summary")}>
        <dl className="grid gap-x-3 gap-y-2 text-sm sm:grid-cols-4">
          <dt className="text-muted-foreground">{t("common.questions")}</dt><dd>{t("builder.summaryQuestions", { count: a.questions.length, points: totalPoints })}</dd>
          <dt className="text-muted-foreground">{t("common.duration")}</dt><dd>{fmtDuration(a.settings.durationSeconds)}</dd>
          <dt className="text-muted-foreground">{t("builder.assignedTo")}</dt>
          <dd className="break-words">{a.assignments.length ? a.assignments.map((x) => x.label).join(", ") : <span className="text-warning">{t("builder.nobodyAssigned")}</span>}</dd>
          <dt className="text-muted-foreground">{t("common.result")}</dt>
          <dd>
            {releaseLabel(a.settings.releaseMode)} · {reviewLabel(a.settings.reviewMode)}
            {a.settings.wrongPenalty?.enabled && <span className="block">{t("result.penaltyRule", { ratio: a.settings.wrongPenalty.ratio })}</span>}
            {a.settings.emailResults && <span className="block">{t("builder.emailResultsOn")}</span>}
          </dd>
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {canPublish ? (
            <Button disabled={!a.questions.length} onClick={() => setOpen(true)}>{a.currentVersionId ? t("assessment.publishNew") : t("assessment.publish")}</Button>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-sm text-success"><Check className="h-4 w-4" aria-hidden />{t("builder.upToDate")}</span>
          )}
        </div>
      </Panel>

      {a.currentVersionId && (
        <Panel title={t("assessment.sharing")}>
          <ShareBox
            path={`/exam/${a.shareCode}`}
            fileName={`resulio-${a.shareCode}`}
            tracking={{ targetType: "EXAM", targetId: a.shareCode, campaign: "exam_share" }}
            onTracked={() => void shareFunnelQ.refetch()}
          />
          <ShareFunnelSummary data={shareFunnelQ.data} />
        </Panel>
      )}

      <Panel
        title={t("builder.preview")}
        action={
          <div role="group" aria-label={t("builder.previewMode")} className="flex gap-1 rounded-lg bg-muted p-1 text-sm">
            {(["student", "key"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1 ${mode === m ? "bg-card font-medium text-foreground shadow-card" : "text-foreground-secondary"}`}
              >
                {m === "student" ? t("builder.studentView") : t("builder.answerKeyView")}
              </button>
            ))}
          </div>
        }
      >
        {mode === "student" ? (
          <div className="space-y-4">
            {preview.data?.instructions && <div className="whitespace-pre-wrap rounded-xl bg-muted p-3 text-sm">{preview.data.instructions}</div>}
            {(preview.data?.questions ?? []).map((q) => (
              <div key={q.id} className="rounded-xl border p-4">
                <div className="mb-2 text-xs text-muted-foreground">{t("builder.previewQuestion", { n: q.position, points: q.points })}</div>
                <QuestionRenderer q={q} value={answers[q.id] as never} onChange={(v) => setAnswers({ ...answers, [q.id]: v })} />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">{t("builder.previewNote")}</p>
          </div>
        ) : (
          <ol className="space-y-3">
            {a.questions.map((q, i) => (
              <li key={q.id} className="rounded-xl border p-3 text-sm">
                <div className="text-xs text-muted-foreground">{i + 1}. {questionTypeLabel(q.type)} · {t("common.points", { count: q.points })}</div>
                <div className="mt-1 whitespace-pre-wrap break-words">{q.text}</div>
                <pre className="mt-2 overflow-x-auto rounded-lg border border-success/40 bg-success-surface p-2 text-xs text-foreground">{JSON.stringify(q.answerKey, null, 1)}</pre>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <PublishDialog open={open} onOpenChange={setOpen} republish={Boolean(a.currentVersionId)} busy={publish.isPending} onConfirm={(moveAssignments) => publish.mutate({ id: a.id, moveAssignments })} />
    </div>
  );
}
