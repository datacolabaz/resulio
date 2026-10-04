import { ErrorNote, Loading, Panel, Pill } from "@/components/AppShell";
import { CompletionRulesForm } from "@/components/syllabus/CompletionRulesForm";
import { SortableList } from "@/components/syllabus/SortableList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { t, type MessageKey } from "@/i18n/messages";
import { mergeSubsetOrder, overrideCount } from "@/lib/syllabus";
import { trpc } from "@/lib/trpc";
import type { CompletionRulesPatch, SyllabusItemKind } from "@shared/syllabus";
import { ArrowLeft, Eye, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link, useParams } from "wouter";
import { ItemCard, useCreateItem } from "./ItemCard";
import type { Tree } from "./SyllabusDetail";
import { fieldLabel, KIND_ICON, kindLabel, linesToList, SyllabusShell, toastError, useSyllabusRefresh } from "./shared";

type ModuleNode = Tree["modules"][number];
type LessonNode = ModuleNode["lessons"][number];

const KINDS: SyllabusItemKind[] = ["THEORY", "TEACHER_PRACTICE", "STUDENT_PRACTICE", "ASSESSMENT", "RESOURCE"];

function LessonFields({ tree, module, lesson }: { tree: Tree; module: ModuleNode; lesson: LessonNode }) {
  const refresh = useSyllabusRefresh(tree.syllabus.id);
  const init = () => ({
    title: lesson.title,
    description: lesson.description ?? "",
    estimatedMinutes: lesson.estimatedMinutes == null ? "" : String(lesson.estimatedMinutes),
    objectives: lesson.objectives.join("\n"),
    ready: lesson.status === "READY",
    rules: (lesson.completionRules ?? null) as CompletionRulesPatch | null,
  });
  const [f, setF] = useState(init);
  const [dirty, setDirty] = useState(false);
  const stamp = String(lesson.updatedAt);
  useEffect(() => {
    if (!dirty) setF(init());
  }, [stamp, lesson.id]);
  const edit = (patch: Partial<ReturnType<typeof init>>) => {
    setF({ ...f, ...patch });
    setDirty(true);
  };
  const update = trpc.teacher.syllabus.updateLesson.useMutation({
    onSuccess: () => {
      setDirty(false);
      refresh();
      toast.success(t("syllabus.saved"));
    },
    onError: toastError,
  });
  const save = () =>
    update.mutate({
      lessonId: lesson.id,
      patch: {
        title: f.title.trim(),
        description: f.description,
        estimatedMinutes: f.estimatedMinutes.trim() === "" ? null : Math.max(0, Math.round(Number(f.estimatedMinutes) || 0)),
        objectives: linesToList(f.objectives).map((o) => o.slice(0, 300)),
        status: f.ready ? "READY" : "DRAFT",
        completionRules: f.rules && Object.keys(f.rules).length ? f.rules : null,
      },
    });
  return (
    <Panel>
      <div className="grid gap-3">
        <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("syllabus.lesson.title") })}</span><Input maxLength={255} value={f.title} onChange={(e) => edit({ title: e.target.value })} /></label>
        <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={2} maxLength={20_000} value={f.description} onChange={(e) => edit({ description: e.target.value })} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm"><span className={fieldLabel}>{t("syllabus.objectives")}</span><Textarea rows={3} value={f.objectives} onChange={(e) => edit({ objectives: e.target.value })} placeholder={t("syllabus.objectivesPlaceholder")} /></label>
          <div className="grid content-start gap-3">
            <label className="text-sm"><span className={fieldLabel}>{t("syllabus.estimatedMinutes")}</span><Input type="number" min={0} value={f.estimatedMinutes} onChange={(e) => edit({ estimatedMinutes: e.target.value })} /></label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-link" checked={f.ready} onChange={(e) => edit({ ready: e.target.checked })} />
              {t("syllabus.node.readyLabel")}
            </label>
          </div>
        </div>
        <details className="rounded-xl border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t("syllabus.rules.title")} {overrideCount(f.rules) > 0 && <Pill>{t("syllabus.rules.overrides", { count: overrideCount(f.rules) })}</Pill>}
          </summary>
          <div className="mt-3">
            <CompletionRulesForm idPrefix={`lesson-${lesson.id}`} level="lesson" patch={f.rules} inherited={module.effectiveRules} onChange={(rules) => edit({ rules })} />
          </div>
        </details>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && <span className="mr-auto text-sm text-warning">{t("syllabus.unsaved")}</span>}
          <Button disabled={!dirty || !f.title.trim() || update.isPending} onClick={save}>{update.isPending ? t("syllabus.saving") : t("common.save")}</Button>
        </div>
      </div>
    </Panel>
  );
}

function KindTab({ tree, lesson, kind }: { tree: Tree; lesson: LessonNode; kind: SyllabusItemKind }) {
  const syllabusId = tree.syllabus.id;
  const refresh = useSyllabusRefresh(syllabusId);
  const [openId, setOpenId] = useState<string | null>(null);
  const create = useCreateItem(syllabusId, setOpenId);
  const reorder = trpc.teacher.syllabus.reorderItems.useMutation({ onSuccess: refresh, onError: toastError });
  const items = lesson.items.filter((it) => it.kind === kind);
  const placement = { scope: "LESSON" as const, lessonId: lesson.id };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t(`syllabus.kindHelp.${kind}` as MessageKey)}</p>
      {items.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("syllabus.lesson.kindEmpty")}</p>}
      <SortableList
        items={items}
        getKey={(i) => i.id}
        getLabel={(i) => i.title}
        onReorder={(next) =>
          reorder.mutate({ syllabusId, placement, orderedIds: mergeSubsetOrder(lesson.items.map((i) => i.id), next.map((i) => i.id)) })
        }
      >
        {(item, { handle }) => <ItemCard syllabusId={syllabusId} item={item} handle={handle} defaultOpen={item.id === openId || items.length === 1} />}
      </SortableList>
      <Button variant="outline" disabled={create.isPending} onClick={() => create.mutate({ syllabusId, placement, data: { kind, title: kindLabel(kind) } })}>
        <Plus className="mr-1 h-4 w-4" aria-hidden />
        {t("syllabus.lesson.addKind", { kind: kindLabel(kind) })}
      </Button>
    </div>
  );
}

function LessonBody({ id, lessonId }: { id: string; lessonId: string }) {
  const tree = trpc.teacher.syllabus.get.useQuery({ id });
  const [tab, setTab] = useState<SyllabusItemKind>("THEORY");
  if (tree.isLoading) return <Loading />;
  if (tree.error || !tree.data) return <ErrorNote error={tree.error} />;
  const module = tree.data.modules.find((m) => m.lessons.some((l) => l.id === lessonId));
  const lesson = module?.lessons.find((l) => l.id === lessonId);
  if (!module || !lesson) return <ErrorNote error={new Error("NOT_FOUND")} />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/teacher/syllabus/${id}`} className="inline-flex items-center gap-1 text-sm text-link hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {tree.data.syllabus.title}
        </Link>
        <Link href={`/teacher/syllabus/${id}/preview?lesson=${lesson.id}`} className="inline-flex h-9 items-center gap-1 rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-muted">
          <Eye className="h-4 w-4" aria-hidden />
          {t("syllabus.preview.open")}
        </Link>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{module.title}</p>
        <h2 className="break-words text-2xl font-semibold">{lesson.title}</h2>
      </div>
      <LessonFields tree={tree.data} module={module} lesson={lesson} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as SyllabusItemKind)}>
        <TabsList className="h-auto w-full flex-wrap justify-start">
          {KINDS.map((k) => {
            const Icon = KIND_ICON[k];
            const n = lesson.items.filter((it) => it.kind === k).length;
            return (
              <TabsTrigger key={k} value={k} className="gap-1.5">
                <Icon className="h-4 w-4" aria-hidden />
                {t(`syllabus.tabKind.${k}` as MessageKey)}
                {n > 0 && <span className="rounded-full bg-background px-1.5 text-xs">{n}</span>}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {KINDS.map((k) => (
          <TabsContent key={k} value={k} className="pt-2">
            <KindTab tree={tree.data} lesson={lesson} kind={k} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

export function LessonEditorPage() {
  const { id, lessonId } = useParams<{ id: string; lessonId: string }>();
  return (
    <SyllabusShell>
      <LessonBody id={id} lessonId={lessonId} />
    </SyllabusShell>
  );
}
