import { Loading } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Check, FolderTree, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { bankRef } from "@shared/questionImport";

export type TopicRow = RouterOutputs["teacher"]["questionTopics"]["list"][number];

export const topicSelectClass = "rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground";

/** Subjects and sections of the current workspace (each subject followed by its sections). */
export function useTopics(enabled = true) {
  return trpc.teacher.questionTopics.list.useQuery(undefined, { enabled, staleTime: 30_000, retry: false });
}

export const subjectsOf = (topics: TopicRow[]) => topics.filter((x) => x.kind === "SUBJECT");
export const sectionsOf = (topics: TopicRow[], subjectId: string) => topics.filter((x) => x.parentId === subjectId);

/** "Subject / Section / #12", or the section path alone while the question has no number. */
export function bankLabel(topics: TopicRow[], q: { sectionId: string | null; bankNumber: number | null }) {
  const section = q.sectionId ? topics.find((x) => x.id === q.sectionId) : undefined;
  return section ? bankRef(section.path, q.bankNumber) : null;
}

function useRefreshTopics() {
  const utils = trpc.useUtils();
  return () => {
    void utils.teacher.questionTopics.list.invalidate();
    void utils.teacher.questions.bank.invalidate();
  };
}

/** Browse filter: a whole subject or one of its sections. */
export function TopicSelect({
  topics,
  value,
  onChange,
  emptyLabel,
  ariaLabel,
  className = topicSelectClass,
}: {
  topics: TopicRow[];
  value: string;
  onChange: (id: string) => void;
  emptyLabel: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <select className={className} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {topics.map((x) => (
        <option key={x.id} value={x.id}>
          {x.kind === "SUBJECT" ? t("qbank.subjectAll", { name: x.name }) : x.path}
        </option>
      ))}
    </select>
  );
}

/** One section, grouped by subject. */
export function SectionSelect({
  topics,
  value,
  onChange,
  emptyLabel,
  ariaLabel,
  className = topicSelectClass,
  disabled,
}: {
  topics: TopicRow[];
  value: string;
  onChange: (id: string) => void;
  emptyLabel: string;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select className={className} aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {subjectsOf(topics).map((s) => (
        <optgroup key={s.id} label={s.name}>
          {sectionsOf(topics, s.id).map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

const NEW = "__new";

/** A name field with create/cancel buttons; not a <form>, so it can sit inside other forms. */
function InlineCreate({
  label,
  placeholder,
  pending,
  onCreate,
  onCancel,
}: {
  label: string;
  placeholder?: string;
  pending: boolean;
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const submit = () => name.trim() && onCreate(name.trim());
  return (
    <div className="flex items-center gap-2">
      <Input
        autoFocus
        maxLength={120}
        aria-label={label}
        placeholder={placeholder ?? label}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button type="button" size="icon" variant="outline" className="h-9 w-9 shrink-0" aria-label={t("qbank.create")} disabled={pending || !name.trim()} onClick={submit}>
        <Check className="h-4 w-4" aria-hidden />
      </Button>
      <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={t("common.cancel")} onClick={onCancel}>
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

/**
 * Where a question goes: first the subject, then one of its sections. Either can be created on the
 * spot. `value` is the section id ("" while none is chosen).
 */
export function SectionPicker({ value, onChange, className = "" }: { value: string; onChange: (sectionId: string) => void; className?: string }) {
  const topics = useTopics();
  const refresh = useRefreshTopics();
  const list = topics.data ?? [];
  const parentOf = (id: string) => list.find((x) => x.id === id)?.parentId ?? "";
  const [subjectId, setSubjectId] = useState(() => parentOf(value));
  const [creating, setCreating] = useState<"SUBJECT" | "SECTION" | null>(null);
  useEffect(() => {
    const parent = parentOf(value);
    if (parent) setSubjectId(parent);
  }, [value, topics.data]);
  const create = trpc.teacher.questionTopics.create.useMutation({
    onSuccess: (row) => {
      setCreating(null);
      refresh();
      if (row.parentId) {
        setSubjectId(row.parentId);
        onChange(row.id);
      } else {
        setSubjectId(row.id);
        onChange("");
      }
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (topics.isLoading) return <Loading />;
  if (topics.error) return <p role="alert" className="text-sm text-destructive">{errorText(topics.error)}</p>;
  const sections = subjectId ? sectionsOf(list, subjectId) : [];
  return (
    <div className={`grid gap-2 sm:grid-cols-2 ${className}`}>
      <label className="text-sm">
        <span className="text-foreground-secondary">{t("qbank.subject")}</span>
        {creating === "SUBJECT" ? (
          <InlineCreate
            label={t("qbank.newSubjectName")}
            placeholder={t("qbank.subjectPlaceholder")}
            pending={create.isPending}
            onCreate={(name) => create.mutate({ name })}
            onCancel={() => setCreating(null)}
          />
        ) : (
          <select
            className={`mt-1 w-full ${topicSelectClass}`}
            value={subjectId}
            onChange={(e) => {
              if (e.target.value === NEW) return setCreating("SUBJECT");
              setSubjectId(e.target.value);
              onChange("");
            }}
          >
            <option value="">{t("qbank.pickSubject")}</option>
            {subjectsOf(list).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value={NEW}>{t("qbank.newSubject")}</option>
          </select>
        )}
      </label>
      <label className="text-sm">
        <span className="text-foreground-secondary">{t("qbank.section")}</span>
        {creating === "SECTION" ? (
          <InlineCreate label={t("qbank.newSectionName")} pending={create.isPending} onCreate={(name) => create.mutate({ name, parentId: subjectId })} onCancel={() => setCreating(null)} />
        ) : (
          <select
            className={`mt-1 w-full ${topicSelectClass}`}
            value={value}
            disabled={!subjectId}
            onChange={(e) => (e.target.value === NEW ? setCreating("SECTION") : onChange(e.target.value))}
          >
            <option value="">{t("qbank.pickSection")}</option>
            {sections.map((x) => (
              <option key={x.id} value={x.id}>
                {t("qbank.sectionOption", { name: x.name, count: x.questionCount })}
              </option>
            ))}
            <option value={NEW}>{t("qbank.newSection")}</option>
          </select>
        )}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

type Outline = RouterOutputs["teacher"]["questionTopics"]["syllabusOutline"];

function RenameForm({ name, onSave, onCancel, pending }: { name: string; onSave: (name: string) => void; onCancel: () => void; pending: boolean }) {
  const [value, setValue] = useState(name);
  return (
    <form
      className="flex flex-1 items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSave(value.trim());
      }}
    >
      <Input autoFocus maxLength={120} aria-label={t("qbank.topics.renameLabel", { name })} value={value} onChange={(e) => setValue(e.target.value)} />
      <Button type="submit" size="icon" variant="outline" className="h-9 w-9 shrink-0" aria-label={t("common.save")} disabled={pending || !value.trim()}>
        <Check className="h-4 w-4" aria-hidden />
      </Button>
      <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={t("common.cancel")} onClick={onCancel}>
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </form>
  );
}

function useTopicMutations(onSaved?: () => void) {
  const refresh = useRefreshTopics();
  const update = trpc.teacher.questionTopics.update.useMutation({
    onSuccess: () => {
      onSaved?.();
      toast.success(t("qbank.topics.saved"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const remove = trpc.teacher.questionTopics.remove.useMutation({
    onSuccess: () => {
      toast.success(t("qbank.topics.deleted"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return { update, remove };
}

const smallSelect = "max-w-[12rem] rounded-lg border border-input bg-card px-2 py-1 text-xs text-foreground";

function TopicActions({ topic, onRename, remove }: { topic: TopicRow; onRename: () => void; remove: ReturnType<typeof useTopicMutations>["remove"] }) {
  const empty = topic.questionCount === 0;
  return (
    <>
      <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("qbank.topics.editLabel", { name: topic.name })} onClick={onRename}>
        <Pencil className="h-4 w-4" aria-hidden />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-destructive"
        aria-label={t("qbank.topics.deleteLabel", { name: topic.name })}
        title={empty ? undefined : t("qbank.topics.notEmpty")}
        disabled={remove.isPending || !empty}
        onClick={() => confirm(t(topic.kind === "SUBJECT" ? "qbank.topics.deleteSubjectConfirm" : "qbank.topics.deleteSectionConfirm", { name: topic.name })) && remove.mutate({ id: topic.id })}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </>
  );
}

function SectionLine({ section, topics, outline }: { section: TopicRow; topics: TopicRow[]; outline: Outline }) {
  const [renaming, setRenaming] = useState(false);
  const { update, remove } = useTopicMutations(() => setRenaming(false));
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 ps-5">
      {renaming ? (
        <RenameForm name={section.name} pending={update.isPending} onCancel={() => setRenaming(false)} onSave={(name) => update.mutate({ id: section.id, patch: { name } })} />
      ) : (
        <>
          <span className="min-w-0 flex-1 break-words text-sm">{section.name}</span>
          <span className="text-xs text-muted-foreground">{t("qbank.topics.count", { count: section.questionCount })}</span>
          <select
            className={smallSelect}
            aria-label={t("qbank.topics.moveSection", { name: section.name })}
            value={section.parentId ?? ""}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ id: section.id, patch: { parentId: e.target.value } })}
          >
            {subjectsOf(topics).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            className={smallSelect}
            aria-label={t("qbank.topics.linkModuleLabel", { name: section.name })}
            value={section.syllabusModuleId ?? ""}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ id: section.id, patch: { syllabusModuleId: e.target.value || null } })}
          >
            <option value="">{t("qbank.topics.noLink")}</option>
            {outline.map((s) => (
              <optgroup key={s.id} label={s.title}>
                {s.modules.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <TopicActions topic={section} remove={remove} onRename={() => setRenaming(true)} />
        </>
      )}
    </li>
  );
}

function SubjectBlock({ subject, topics, outline }: { subject: TopicRow; topics: TopicRow[]; outline: Outline }) {
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const refresh = useRefreshTopics();
  const { update, remove } = useTopicMutations(() => setRenaming(false));
  const create = trpc.teacher.questionTopics.create.useMutation({
    onSuccess: () => {
      setAdding(false);
      toast.success(t("qbank.topics.saved"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const sections = sectionsOf(topics, subject.id);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <RenameForm name={subject.name} pending={update.isPending} onCancel={() => setRenaming(false)} onSave={(name) => update.mutate({ id: subject.id, patch: { name } })} />
        ) : (
          <>
            <span className="min-w-0 flex-1 break-words text-sm font-semibold">{subject.name}</span>
            <span className="text-xs text-muted-foreground">{t("qbank.topics.count", { count: subject.questionCount })}</span>
            <select
              className={smallSelect}
              aria-label={t("qbank.topics.linkSyllabusLabel", { name: subject.name })}
              value={subject.syllabusId ?? ""}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ id: subject.id, patch: { syllabusId: e.target.value || null } })}
            >
              <option value="">{t("qbank.topics.noLink")}</option>
              {outline.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <TopicActions topic={subject} remove={remove} onRename={() => setRenaming(true)} />
          </>
        )}
      </div>
      <ul className="divide-y">
        {sections.map((x) => (
          <SectionLine key={x.id} section={x} topics={topics} outline={outline} />
        ))}
      </ul>
      <div className="ps-5 pt-1">
        {adding ? (
          <InlineCreate label={t("qbank.newSectionName")} pending={create.isPending} onCreate={(name) => create.mutate({ name, parentId: subject.id })} onCancel={() => setAdding(false)} />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("qbank.topics.addSection")}
          </Button>
        )}
      </div>
    </li>
  );
}

function NewSubjectForm({ outline }: { outline: Outline }) {
  const refresh = useRefreshTopics();
  const [name, setName] = useState("");
  const [syllabusId, setSyllabusId] = useState("");
  const create = trpc.teacher.questionTopics.create.useMutation({
    onSuccess: () => {
      setName("");
      setSyllabusId("");
      toast.success(t("qbank.topics.saved"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <form
      className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate({ name: name.trim(), syllabusId: syllabusId || null });
      }}
    >
      <label className="text-sm">
        <span className="text-foreground-secondary">{t("qbank.newSubjectName")}</span>
        <Input maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("qbank.subjectPlaceholder")} />
      </label>
      <label className="text-sm">
        <span className="text-foreground-secondary">{t("qbank.topics.link")}</span>
        <select className={`mt-1 w-full ${topicSelectClass}`} value={syllabusId} onChange={(e) => setSyllabusId(e.target.value)}>
          <option value="">{t("qbank.topics.noLink")}</option>
          {outline.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" disabled={create.isPending || !name.trim()}>
        {t("qbank.topics.newSubject")}
      </Button>
    </form>
  );
}

function FromSyllabus({ outline }: { outline: Outline }) {
  const refresh = useRefreshTopics();
  const [syllabusId, setSyllabusId] = useState("");
  const build = trpc.teacher.questionTopics.fromSyllabus.useMutation({
    onSuccess: (r) => {
      toast.success(t("qbank.topics.built", { count: r.count }));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!outline.length) return null;
  return (
    <div className="space-y-2 rounded-xl border border-border bg-muted p-3">
      <div className="text-sm font-medium">{t("qbank.topics.fromSyllabus")}</div>
      <p className="text-xs text-muted-foreground">{t("qbank.topics.fromSyllabusHelp")}</p>
      <div className="flex flex-wrap gap-2">
        <select className={topicSelectClass} aria-label={t("qbank.topics.pickSyllabus")} value={syllabusId} onChange={(e) => setSyllabusId(e.target.value)}>
          <option value="">{t("qbank.topics.pickSyllabus")}</option>
          {outline.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <Button variant="outline" disabled={!syllabusId || build.isPending} onClick={() => build.mutate({ syllabusId })}>
          {t("qbank.topics.build")}
        </Button>
      </div>
    </div>
  );
}

/** Subjects and their sections: create, rename, move a section, link to a syllabus, delete when empty. */
export function TopicManagerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const topics = useTopics(open);
  const outlineQuery = trpc.teacher.questionTopics.syllabusOutline.useQuery(undefined, { enabled: open, retry: false });
  const list = topics.data ?? [];
  const outline = outlineQuery.data ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderTree className="h-5 w-5" aria-hidden />
            {t("qbank.topics.title")}
          </DialogTitle>
          <DialogDescription>{t("qbank.topics.help")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid content-start gap-4">
          <NewSubjectForm outline={outline} />
          <FromSyllabus outline={outline} />
          {topics.isLoading ? (
            <Loading />
          ) : topics.error ? (
            <p role="alert" className="text-sm text-destructive">{errorText(topics.error)}</p>
          ) : !list.length ? (
            <p className="text-sm text-muted-foreground">{t("qbank.topics.empty")}</p>
          ) : (
            <ul className="divide-y">
              {subjectsOf(list).map((s) => (
                <SubjectBlock key={s.id} subject={s} topics={list} outline={outline} />
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
