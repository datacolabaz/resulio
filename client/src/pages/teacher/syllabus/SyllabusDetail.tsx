import { EmptyState, ErrorNote, Loading, Panel, Pill } from "@/components/AppShell";
import { CompletionRulesForm } from "@/components/syllabus/CompletionRulesForm";
import { ModuleToggleAll, useOpenModules } from "@/components/syllabus/ModuleToggles";
import { SortableList } from "@/components/syllabus/SortableList";
import { TeacherWorkflow } from "@/components/syllabus/Workflow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { overrideCount } from "@/lib/syllabus";
import { liveGrants, publishState } from "@/lib/syllabusPublishState";
import { BUILDER_TABS, gradable, nextStepOtherThan, STEP_TAB, teacherSteps, type BuilderTab, type TeacherStep } from "@/lib/syllabusWorkflow";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { CompletionRulesPatch, SyllabusItemKind } from "@shared/syllabus";
import { ArrowLeft, ChevronDown, ChevronRight, Copy, Eye, Pencil, Plus, Rocket, Send, Trash2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { AnalyticsTab } from "./AnalyticsTab";
import { GradingTab } from "./GradingTab";
import { ItemCard, useCreateItem } from "./ItemCard";
import { durationText } from "@/components/syllabus/Timing";
import { ModuleBlocksEditor } from "./ModuleBlocksEditor";
import { CourseTimingPanel, LessonMinutes, ModuleTiming } from "./TimingEditors";
import { StudentsTab } from "./StudentsTab";
import { PublishDialog } from "./PublishDialog";
import { GrantDialog } from "./GrantDialog";
import { AccessTab, SettingsTab, VersionsTab } from "./SyllabusTabs";
import { CopyShareLinkButton, RequestsTab, usePendingJoinRequests } from "./ShareAndRequests";
import { fieldLabel, KIND_ICON, kindLabel, NodeStatusBadge, SyllabusShell, SyllabusVisibilityBadges, toastError, useSyllabusRefresh } from "./shared";

export type Tree = RouterOutputs["teacher"]["syllabus"]["get"];
type ModuleNode = Tree["modules"][number];
type LessonNode = ModuleNode["lessons"][number];

// ---------------------------------------------------------------------------
// Module create/edit dialog (fields, module assessments, completion rules)
// ---------------------------------------------------------------------------

function ModuleDialog({ tree, module, open, onOpenChange }: { tree: Tree; module: ModuleNode | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const syllabusId = tree.syllabus.id;
  const refresh = useSyllabusRefresh(syllabusId);
  const init = () => ({
    title: module?.title ?? "",
    description: module?.description ?? "",
    estimatedMinutes: module?.estimatedMinutes == null ? "" : String(module.estimatedMinutes),
    ready: (module?.status ?? "READY") === "READY",
    rules: (module?.completionRules ?? null) as CompletionRulesPatch | null,
  });
  const [f, setF] = useState(init);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const key = `${open}-${module?.id ?? "new"}`;
  if (key !== lastKey) {
    setLastKey(key);
    if (open) setF(init());
  }
  const done = () => {
    refresh();
    onOpenChange(false);
  };
  const create = trpc.teacher.syllabus.createModule.useMutation({ onSuccess: done, onError: toastError });
  const update = trpc.teacher.syllabus.updateModule.useMutation({ onSuccess: done, onError: toastError });
  const minutes = f.estimatedMinutes.trim() === "" ? null : Math.max(0, Math.round(Number(f.estimatedMinutes) || 0));
  const data = {
    title: f.title.trim(),
    description: f.description,
    estimatedMinutes: minutes,
    status: f.ready ? ("READY" as const) : ("DRAFT" as const),
    completionRules: f.rules && Object.keys(f.rules).length ? f.rules : null,
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{module ? t("syllabus.module.edit") : t("syllabus.module.new")}</DialogTitle></DialogHeader>
        <DialogBody className="grid content-start gap-3">
          <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("syllabus.module.title") })}</span><Input maxLength={255} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={3} maxLength={20_000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm"><span className={fieldLabel}>{t("syllabus.estimatedMinutes")}</span><Input type="number" min={0} value={f.estimatedMinutes} onChange={(e) => setF({ ...f, estimatedMinutes: e.target.value })} /></label>
            <label className="flex items-center gap-2 text-sm sm:pt-5">
              <input type="checkbox" className="accent-link" checked={f.ready} onChange={(e) => setF({ ...f, ready: e.target.checked })} />
              {t("syllabus.node.readyLabel")}
            </label>
          </div>
          <p className="text-sm text-muted-foreground">{t("syllabus.module.detailsMoved")}</p>
          <details className="rounded-xl border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">{t("syllabus.rules.title")} {overrideCount(f.rules) > 0 && <Pill>{t("syllabus.rules.overrides", { count: overrideCount(f.rules) })}</Pill>}</summary>
            <div className="mt-3">
              <CompletionRulesForm idPrefix={`mod-${module?.id ?? "new"}`} level="module" patch={f.rules} inherited={tree.syllabus.effectiveRules} onChange={(rules) => setF({ ...f, rules })} />
            </div>
          </details>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            disabled={!data.title || create.isPending || update.isPending}
            onClick={() => (module ? update.mutate({ moduleId: module.id, patch: data }) : create.mutate({ syllabusId, data }))}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Structure tab
// ---------------------------------------------------------------------------

const LESSON_KINDS: SyllabusItemKind[] = ["THEORY", "TEACHER_PRACTICE", "STUDENT_PRACTICE", "ASSESSMENT", "RESOURCE"];

function LessonRow({ tree, module, lesson, handle }: { tree: Tree; module: ModuleNode; lesson: LessonNode; handle: React.ReactNode }) {
  const syllabusId = tree.syllabus.id;
  const refresh = useSyllabusRefresh(syllabusId);
  const duplicate = trpc.teacher.syllabus.duplicateLesson.useMutation({ onSuccess: refresh, onError: toastError });
  const remove = trpc.teacher.syllabus.deleteLesson.useMutation({ onSuccess: refresh, onError: toastError });
  const move = trpc.teacher.syllabus.moveLesson.useMutation({ onSuccess: refresh, onError: toastError });
  const counts = LESSON_KINDS.map((k) => ({ kind: k, n: lesson.items.filter((it) => it.kind === k).length })).filter((c) => c.n > 0);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background p-2.5">
      {handle}
      <Link href={`/teacher/syllabus/${syllabusId}/lessons/${lesson.id}`} className="min-w-0 flex-1 rounded-md hover:underline focus-visible:outline-2 focus-visible:outline-link">
        <span className="block break-words text-sm font-medium">{lesson.title}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {counts.length === 0 && <span>{t("syllabus.lesson.noItems")}</span>}
          {counts.map(({ kind, n }) => {
            const Icon = KIND_ICON[kind];
            return (
              <span key={kind} className="inline-flex items-center gap-1" title={kindLabel(kind)}>
                <Icon className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">{kindLabel(kind)}</span>
                {n}
              </span>
            );
          })}
        </span>
      </Link>
      <LessonMinutes tree={tree} lesson={lesson} />
      <NodeStatusBadge status={lesson.status} />
      <div className="flex items-center gap-1">
        {tree.modules.length > 1 && (
          <select
            className="max-w-36 rounded-md border border-input bg-card px-2 py-1 text-xs"
            value={module.id}
            onChange={(e) => move.mutate({ lessonId: lesson.id, targetModuleId: e.target.value })}
            aria-label={t("syllabus.lesson.moveTo", { title: lesson.title })}
          >
            {tree.modules.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        )}
        <Link href={`/teacher/syllabus/${syllabusId}/lessons/${lesson.id}`} className="rounded p-1.5 hover:bg-muted" aria-label={t("syllabus.lesson.edit", { title: lesson.title })}>
          <Pencil className="h-4 w-4" aria-hidden />
        </Link>
        <button type="button" className="rounded p-1.5 hover:bg-muted" disabled={duplicate.isPending} onClick={() => duplicate.mutate({ lessonId: lesson.id })} aria-label={t("syllabus.lesson.duplicate", { title: lesson.title })}>
          <Copy className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-destructive hover:bg-danger-surface"
          onClick={() => confirm(t("syllabus.lesson.deleteConfirm", { title: lesson.title })) && remove.mutate({ lessonId: lesson.id })}
          aria-label={t("syllabus.lesson.delete", { title: lesson.title })}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

function AddInline({ label, placeholder, onAdd, pending }: { label: string; placeholder: string; onAdd: (title: string) => void; pending: boolean }) {
  const [value, setValue] = useState("");
  const submit = () => {
    if (!value.trim()) return;
    onAdd(value.trim());
    setValue("");
  };
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input maxLength={255} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="h-9" />
      <Button type="submit" size="sm" variant="outline" disabled={!value.trim() || pending}>
        <Plus className="mr-1 h-4 w-4" aria-hidden />
        {label}
      </Button>
    </form>
  );
}

function AssessmentList({
  tree,
  items,
  placement,
  emptyText,
  addLabel = t("syllabus.as.add"),
}: {
  tree: Tree;
  items: Tree["finalItems"];
  placement: { scope: "MODULE" | "SYLLABUS"; moduleId?: string };
  emptyText: string;
  addLabel?: string;
}) {
  const syllabusId = tree.syllabus.id;
  const refresh = useSyllabusRefresh(syllabusId);
  const [openId, setOpenId] = useState<string | null>(null);
  const create = useCreateItem(syllabusId, setOpenId);
  const reorder = trpc.teacher.syllabus.reorderItems.useMutation({ onSuccess: refresh, onError: toastError });
  return (
    <div className="space-y-2">
      {items.length === 0 && <p className="text-xs text-muted-foreground">{emptyText}</p>}
      <SortableList items={items} getKey={(i) => i.id} getLabel={(i) => i.title} onReorder={(next) => reorder.mutate({ syllabusId, placement, orderedIds: next.map((i) => i.id) })}>
        {(item, { handle }) => <ItemCard key={item.id} syllabusId={syllabusId} item={item} handle={handle} defaultOpen={item.id === openId} />}
      </SortableList>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={create.isPending}
        onClick={() => create.mutate({ syllabusId, placement, data: { kind: "ASSESSMENT", title: placement.scope === "MODULE" ? t("syllabus.module.assessmentDefault") : t("syllabus.final.default") } })}
      >
        <Plus className="mr-1 h-4 w-4" aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}

function ModuleCard({ tree, module, handle, onEdit, open, onToggle }: { tree: Tree; module: ModuleNode; handle: React.ReactNode; onEdit: () => void; open: boolean; onToggle: () => void }) {
  const syllabusId = tree.syllabus.id;
  const refresh = useSyllabusRefresh(syllabusId);
  const panelId = `builder-module-${module.id}`;
  const duplicate = trpc.teacher.syllabus.duplicateModule.useMutation({ onSuccess: refresh, onError: toastError });
  const remove = trpc.teacher.syllabus.deleteModule.useMutation({ onSuccess: refresh, onError: toastError });
  const reorderLessons = trpc.teacher.syllabus.reorderLessons.useMutation({ onSuccess: refresh, onError: toastError });
  const createLesson = trpc.teacher.syllabus.createLesson.useMutation({ onSuccess: refresh, onError: toastError });
  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 p-3">
        {handle}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
        >
          {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
          <span className="min-w-0">
            <span className="block break-words font-semibold">{module.title}</span>
            <span className="text-xs text-muted-foreground">
              {t("syllabus.count.lessons", { count: module.lessons.length })}
              {tree.timing.modules[module.id] ? ` · ${durationText(tree.timing.modules[module.id])}` : ""}
              {module.estimatedMinutes ? ` · ${t("syllabus.minutes", { count: module.estimatedMinutes })}` : ""}
            </span>
          </span>
        </button>
        <NodeStatusBadge status={module.status} />
        {overrideCount(module.completionRules) > 0 && <Pill>{t("syllabus.rules.overrides", { count: overrideCount(module.completionRules) })}</Pill>}
        <div className="flex items-center gap-1">
          <button type="button" className="rounded p-1.5 hover:bg-muted" onClick={onEdit} aria-label={t("syllabus.module.editNamed", { title: module.title })}>
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" className="rounded p-1.5 hover:bg-muted" disabled={duplicate.isPending} onClick={() => duplicate.mutate({ moduleId: module.id })} aria-label={t("syllabus.module.duplicate", { title: module.title })}>
            <Copy className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            className="rounded p-1.5 text-destructive hover:bg-danger-surface"
            onClick={() => confirm(t("syllabus.module.deleteConfirm", { title: module.title })) && remove.mutate({ moduleId: module.id })}
            aria-label={t("syllabus.module.delete", { title: module.title })}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      {open && (
        <div id={panelId} className="space-y-3 border-t border-border p-3">
          <ModuleTiming tree={tree} module={module} />
          {module.lessons.length === 0 && <p className="text-sm text-muted-foreground">{t("syllabus.module.noLessons")}</p>}
          <SortableList
            items={module.lessons}
            getKey={(l) => l.id}
            getLabel={(l) => l.title}
            onReorder={(next) => reorderLessons.mutate({ moduleId: module.id, orderedIds: next.map((l) => l.id) })}
          >
            {(lesson, { handle: lessonHandle }) => <LessonRow tree={tree} module={module} lesson={lesson} handle={lessonHandle} />}
          </SortableList>
          <AddInline label={t("syllabus.lesson.add")} placeholder={t("syllabus.lesson.newPlaceholder")} pending={createLesson.isPending} onAdd={(title) => createLesson.mutate({ moduleId: module.id, data: { title } })} />
          <ModuleBlocksEditor syllabusId={syllabusId} moduleId={module.id} title={module.title} details={module.details} />
          <div className="rounded-xl bg-muted/50 p-3">
            <h4 className="mb-2 text-sm font-medium">{t("syllabus.module.assessments")}</h4>
            <AssessmentList tree={tree} items={module.items} placement={{ scope: "MODULE", moduleId: module.id }} emptyText={t("syllabus.module.noAssessments")} addLabel={t("syllabus.module.addTest")} />
          </div>
        </div>
      )}
    </section>
  );
}

function StructureTab({ tree }: { tree: Tree }) {
  const syllabusId = tree.syllabus.id;
  const refresh = useSyllabusRefresh(syllabusId);
  const [editing, setEditing] = useState<ModuleNode | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const reorder = trpc.teacher.syllabus.reorderModules.useMutation({ onSuccess: refresh, onError: toastError });
  const modules = useOpenModules({ view: "builder", syllabusId, moduleIds: tree.modules.map((m) => m.id), initial: () => (tree.modules.length === 1 ? [tree.modules[0].id] : []), openAdded: true });
  return (
    <div className="space-y-4">
      {tree.modules.length > 0 && <CourseTimingPanel tree={tree} />}
      {tree.modules.length > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground-secondary">{t("syllabus.modules.title")}</h2>
          <ModuleToggleAll allOpen={modules.allOpen} noneOpen={modules.noneOpen} onOpenAll={modules.openAll} onCloseAll={modules.closeAll} />
        </div>
      )}
      {tree.modules.length === 0 ? (
        <EmptyState
          title={t("syllabus.structure.emptyTitle")}
          body={t("syllabus.structure.emptyBody")}
          action={<Button onClick={() => { setEditing(null); setDialogOpen(true); }}>{t("syllabus.module.new")}</Button>}
        />
      ) : (
        <SortableList
          className="space-y-3"
          items={tree.modules}
          getKey={(m) => m.id}
          getLabel={(m) => m.title}
          onReorder={(next) => reorder.mutate({ syllabusId, orderedIds: next.map((m) => m.id) })}
        >
          {(module, { handle }) => (
            <ModuleCard
              tree={tree}
              module={module}
              handle={handle}
              open={modules.isOpen(module.id)}
              onToggle={() => modules.toggle(module.id)}
              onEdit={() => { setEditing(module); setDialogOpen(true); }}
            />
          )}
        </SortableList>
      )}
      {tree.modules.length > 0 && (
        <Button variant="outline" onClick={() => { setEditing(null); setDialogOpen(true); }}>
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          {t("syllabus.module.new")}
        </Button>
      )}
      <Panel title={t("syllabus.final.title")}>
        <AssessmentList tree={tree} items={tree.finalItems} placement={{ scope: "SYLLABUS" }} emptyText={t("syllabus.final.empty")} />
      </Panel>
      <ModuleDialog tree={tree} module={editing} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const TABS = BUILDER_TABS;
type Tab = BuilderTab;

function DetailBody({ id }: { id: string }) {
  const tree = trpc.teacher.syllabus.get.useQuery({ id });
  const grants = trpc.teacher.syllabus.grants.useQuery({ id });
  const canGrade = !!tree.data?.syllabus.currentVersionId && gradable(tree.data).any;
  const practice = trpc.teacher.syllabus.practiceSubmissions.useQuery({ id }, { enabled: canGrade });
  const approvals = trpc.teacher.syllabus.approvals.useQuery({ id }, { enabled: canGrade });
  const openRequests = usePendingJoinRequests()(id);
  const urlTab = new URLSearchParams(useSearch()).get("tab");
  const [tab, setTabState] = useState<Tab>(TABS.includes(urlTab as Tab) ? (urlTab as Tab) : "structure");
  const [lastUrlTab, setLastUrlTab] = useState(urlTab);
  // A link to this page with another ?tab= (e.g. a notification) switches the tab without a remount.
  if (urlTab !== lastUrlTab) {
    setLastUrlTab(urlTab);
    if (TABS.includes(urlTab as Tab)) setTabState(urlTab as Tab);
  }
  const [publishOpen, setPublishOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const loaded = !!tree.data;
  useEffect(() => {
    if (!loaded || urlTab !== "requests") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    tabsRef.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [loaded, urlTab]);
  const setTab = (next: Tab) => {
    setTabState(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  };
  const openStep = (step: TeacherStep) => {
    setTab(STEP_TAB[step]);
    requestAnimationFrame(() => {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      tabsRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      tabsRef.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.focus({ preventScroll: true });
    });
  };
  if (tree.isLoading) return <Loading />;
  if (tree.error || !tree.data) return <ErrorNote error={tree.error} />;
  const s = tree.data.syllabus;
  const archived = !!s.archivedAt;
  const waiting = canGrade ? (practice.data?.waiting ?? 0) + (approvals.data?.length ?? 0) : 0;
  const steps = teacherSteps(tree.data, (grants.data ?? []).map((g) => g.state), waiting);
  const activeGrants = liveGrants(grants.data)?.length ?? null;
  const { action } = publishState(s, activeGrants);
  return (
    <div className="space-y-5">
      <Link href="/teacher/syllabus" className="inline-flex items-center gap-1 text-sm text-link hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t("syllabus.back")}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-2xl font-semibold">{s.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <SyllabusVisibilityBadges syllabus={s} activeGrants={activeGrants} />
            {(s.subject || s.level) && <span className="text-sm text-muted-foreground">{[s.subject, s.level].filter(Boolean).join(" · ")}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/teacher/syllabus/${id}/preview`} className="inline-flex h-9 items-center gap-1 rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-muted">
            <Eye className="h-4 w-4" aria-hidden />
            {t("syllabus.preview.open")}
          </Link>
          <CopyShareLinkButton syllabus={s} />
          {action === "PUBLISH" && (
            <Button onClick={() => setPublishOpen(true)}>
              <Rocket className="mr-1 h-4 w-4" aria-hidden />
              {t("syllabus.publish.open")}
            </Button>
          )}
          {action === "SEND_CHANGES" && (
            <Button onClick={() => setPublishOpen(true)}>
              <Send className="mr-1 h-4 w-4" aria-hidden />
              {t("syllabus.action.sendChanges")}
            </Button>
          )}
          {action === "GRANT" && (
            <Button onClick={() => setGrantOpen(true)}>
              <Users className="mr-1 h-4 w-4" aria-hidden />
              {t("syllabus.action.openToGroup")}
            </Button>
          )}
        </div>
      </div>
      {archived && <p className="rounded-xl border border-border bg-muted p-3 text-sm">{t("syllabus.archivedNote")}</p>}
      {!archived && <TeacherWorkflow steps={steps} onSelect={openStep} collapsible />}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <div ref={tabsRef} className="scroll-mt-4">
          <TabsList className="h-auto w-full flex-wrap justify-start sm:w-fit">
            {TABS.map((k) => (
              <TabsTrigger key={k} value={k}>
                {t(`syllabus.tab.${k}`)}
                {k === "grading" && waiting > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">{waiting}</span>}
                {k === "requests" && openRequests > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">{openRequests}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="structure"><StructureTab tree={tree.data} /></TabsContent>
        <TabsContent value="settings"><SettingsTab tree={tree.data} /></TabsContent>
        <TabsContent value="versions"><VersionsTab tree={tree.data} /></TabsContent>
        <TabsContent value="access"><AccessTab tree={tree.data} /></TabsContent>
        <TabsContent value="students"><StudentsTab tree={tree.data} /></TabsContent>
        <TabsContent value="requests"><RequestsTab tree={tree.data} /></TabsContent>
        <TabsContent value="grading"><GradingTab tree={tree.data} next={nextStepOtherThan(steps, "assess")} onStep={openStep} /></TabsContent>
        <TabsContent value="analytics"><AnalyticsTab tree={tree.data} next={nextStepOtherThan(steps, "track")} onStep={openStep} /></TabsContent>
      </Tabs>
      <PublishDialog tree={tree.data} open={publishOpen} onOpenChange={setPublishOpen} />
      <GrantDialog syllabusId={id} open={grantOpen} onOpenChange={setGrantOpen} preset={null} />
    </div>
  );
}

export function SyllabusDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <SyllabusShell>
      <DetailBody id={id} />
    </SyllabusShell>
  );
}