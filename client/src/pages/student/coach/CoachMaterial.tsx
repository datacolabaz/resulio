import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fileDownloadUrl, formatFileSize } from "@/lib/uploadFile";
import { COACH_MATERIAL_QUIZ_COUNT, pageList } from "@shared/coach";
import { ClipboardCheck, Download, FileText, MessageCircle, Pencil, Play, RotateCcw, Trash2, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams } from "wouter";
import { CoachShell, type CoachStatus } from "./CoachShell";
import { PackView } from "./LearnTab";
import { inProgress, MasteryBadge, StageBadge, StageSteps } from "./materialUi";
import { QuizRunner } from "./PracticeTab";
import { SharePanel } from "./SharePanel";

export type CoachMaterialDetail = RouterOutputs["student"]["coach"]["materials"]["get"];

/** "/student/coach/m/:id": one material — processing status, then its topics and study tools. */
export function CoachMaterialPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <CoachShell title={t("nav.coach")} back="/student/coach">
      {(status) => <MaterialBody id={id} limits={status.upload} />}
    </CoachShell>
  );
}

type UploadLimits = CoachStatus["upload"];

/** Values the limit-related messages need ({pages}, {size}, {ocr}). */
const limitValues = (limits: UploadLimits) => ({ pages: limits.maxPages, size: formatFileSize(limits.maxBytes), ocr: limits.ocrPages });

function MaterialBody({ id, limits }: { id: string; limits: UploadLimits }) {
  const q = trpc.student.coach.materials.get.useQuery(
    { id },
    { refetchInterval: (s) => (s.state.data && inProgress(s.state.data.stage) ? 2500 : s.state.data?.pages?.pending?.length ? 20_000 : false) },
  );
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const m = q.data;
  return (
    <>
      <MaterialHeader m={m} />
      {m.stage !== "READY" ? <MaterialProgress m={m} limits={limits} /> : <MaterialReady m={m} limits={limits} />}
    </>
  );
}

function MaterialHeader({ m }: { m: CoachMaterialDetail }) {
  const [, nav] = useLocation();
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(m.title);
  const rename = trpc.student.coach.materials.rename.useMutation({
    onSuccess: () => {
      setEditing(false);
      void utils.student.coach.materials.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const remove = trpc.student.coach.materials.remove.useMutation({
    onSuccess: () => {
      toast.success(t("coach.material.deleted"));
      void utils.student.coach.materials.list.invalidate();
      nav("/student/coach");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          {editing ? (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (title.trim()) rename.mutate({ id: m.id, title: title.trim() });
              }}
            >
              <input className="min-w-0 flex-1 rounded-lg border border-input bg-card px-3 py-2" value={title} maxLength={200} aria-label={t("coach.add.titleLabel")} onChange={(e) => setTitle(e.target.value)} />
              <Button type="submit" size="sm" disabled={rename.isPending}>{t("common.save")}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
            </form>
          ) : (
            <h2 className="break-words text-xl font-semibold">{m.title}</h2>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StageBadge stage={m.stage} />
            {m.pageCount > 0 && <span>{t("coach.library.pages", { count: m.pageCount })}</span>}
            {m.fileName && m.source === "UPLOAD" && <span className="min-w-0 truncate">{m.fileName}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {m.fileId && m.source === "UPLOAD" && (
            <Button asChild size="sm" variant="ghost">
              <a href={fileDownloadUrl(m.fileId)} aria-label={t("coach.material.download")} title={t("coach.material.download")}>
                <Download className="h-4 w-4" aria-hidden />
              </a>
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-label={t("coach.material.rename")} title={t("coach.material.rename")} onClick={() => { setTitle(m.title); setEditing(true); }}>
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("coach.material.delete")}
            title={t("coach.material.delete")}
            disabled={remove.isPending}
            onClick={() => window.confirm(t("coach.material.deleteConfirm")) && remove.mutate({ id: m.id })}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function MaterialProgress({ m, limits }: { m: CoachMaterialDetail; limits: UploadLimits }) {
  const { locale } = useI18n();
  const utils = trpc.useUtils();
  const retry = trpc.student.coach.materials.retry.useMutation({
    onSuccess: () => void utils.student.coach.materials.invalidate(),
    onError: (e) => toast.error(errorText(e)),
  });
  if (m.stage === "FAILED") {
    return (
      <Panel>
        <div role="alert" className="space-y-3">
          <p className="text-sm font-medium text-destructive">{t("coach.stage.FAILED")}</p>
          <p className="text-sm">{t(`coach.materialError.${m.errorCode ?? "INTERNAL"}`, limitValues(limits))}</p>
          <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate({ id: m.id, locale })}>
            <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
            {t("coach.material.retry")}
          </Button>
        </div>
      </Panel>
    );
  }
  const p = m.progress;
  const pct = p && p.step === "OCR" && p.total > 0 ? Math.round((p.done / p.total) * 100) : null;
  return (
    <Panel>
      <StageSteps stage={m.stage} />
      {p && (
        <div className="mt-4 space-y-2" aria-live="polite">
          <p className="text-sm font-medium">{t(`coach.progress.${p.step}`, { done: p.done, total: p.total })}</p>
          {pct !== null && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t(`coach.progress.${p.step}`, { done: p.done, total: p.total })}>
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}
      <p className="mt-3 text-sm text-muted-foreground">{t("coach.material.processingHint")}</p>
    </Panel>
  );
}

const warningBox = "rounded-2xl border border-warning/40 bg-warning-surface p-4 text-sm";

/** Reading notices that name the pages: poorly recognised (with a link to exactly those), failed, capped, picture pages. */
function TextNotices({ m, limits }: { m: CoachMaterialDetail; limits: UploadLimits }) {
  const r = m.pages;
  const utils = trpc.useUtils();
  const retryPages = trpc.student.coach.materials.retryPages.useMutation({
    onSuccess: (data) => {
      utils.student.coach.materials.get.setData({ id: m.id }, data);
      void utils.student.coach.materials.list.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const pending = r?.pending ?? [];
  return (
    <>
      {m.needsReview && (
        <div role="status" className={`space-y-2 ${warningBox}`}>
          <p className="text-warning">{r?.low.length ? t("coach.ocr.lowPages", { pages: pageList(r.low) }) : t("coach.ocr.lowQuality")}</p>
          <Link href={`/student/coach/m/${m.id}/text${r?.low.length ? `?pages=${r.low.join(",")}` : ""}`} className="font-medium text-link hover:underline">
            {r?.low.length ? t("coach.ocr.checkPages") : t("coach.text.open")}
          </Link>
        </div>
      )}
      {pending.length > 0 && (
        <p role="status" className="rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          {t("coach.ocr.pendingPages", { count: pending.length, pages: pageList(pending) })}
        </p>
      )}
      {r?.failed.length ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-4 text-sm">
          <p className="min-w-0 flex-1">{t("coach.ocr.failedPages", { pages: pageList(r.failed) })}</p>
          <Button size="sm" variant="outline" disabled={retryPages.isPending} onClick={() => retryPages.mutate({ id: m.id })}>
            <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
            {t("coach.material.retry")}
          </Button>
        </div>
      ) : (
        m.errorCode === "OCR_PARTIAL" && !pending.length && <p role="status" className={`${warningBox} text-warning`}>{t("coach.ocr.partial")}</p>
      )}
      {m.errorCode === "OCR_LIMIT" && (
        <p role="status" className={`${warningBox} text-warning`}>
          {r?.skipped.length ? t("coach.ocr.skippedPages", { ...limitValues(limits), pages: pageList(r.skipped) }) : t("coach.ocr.skipped", limitValues(limits))}
        </p>
      )}
      {!!r?.image.length && <p className="px-1 text-xs text-muted-foreground">{t("coach.ocr.imagePages", { pages: pageList(r.image) })}</p>}
    </>
  );
}

function StepButton({ icon: Icon, label, hint, primary, href, onClick, disabled }: { icon: LucideIcon; label: string; hint: string; primary?: boolean; href?: string; onClick?: () => void; disabled?: boolean }) {
  const className = `flex min-h-16 w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-60 ${
    primary ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-border bg-card hover:border-link"
  }`;
  const body: ReactNode = (
    <>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className={`block text-xs ${primary ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{hint}</span>
      </span>
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <button type="button" className={className} onClick={onClick} disabled={disabled}>
      {body}
    </button>
  );
}

type NextView = null | "summary" | { quizId: string };

/** The first thing a ready material shows: how many topics, and four ways to start. */
function NextSteps({ m }: { m: CoachMaterialDetail }) {
  const { locale } = useI18n();
  const [, nav] = useLocation();
  const utils = trpc.useUtils();
  const [view, setView] = useState<NextView>(null);
  const quiz = trpc.student.coach.practice.startMaterial.useMutation({
    onSuccess: (q) => {
      utils.student.coach.practice.get.setData({ quizId: q.id }, q);
      setView({ quizId: q.id });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const first = m.topics[0];
  if (!first) return null;
  if (view && view !== "summary") {
    return (
      <>
        <Panel title={t("coach.next.quizTitle")}>
          <p className="text-sm text-muted-foreground">{m.title}</p>
        </Panel>
        <QuizRunner quizId={view.quizId} onClose={() => setView(null)} onLearn={() => nav(`/student/coach/t/${first.id}`)} backLabel={t("coach.next.close")} />
      </>
    );
  }
  return (
    <>
      <Panel>
        <h3 className="text-lg font-semibold">{t("coach.next.title", { count: m.topics.length })}</h3>
        <p className="text-sm text-muted-foreground">{t("coach.next.intro")}</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <StepButton primary icon={Play} href={`/student/coach/t/${first.id}`} label={t("coach.next.start")} hint={t("coach.next.startHint")} />
          <StepButton icon={FileText} onClick={() => setView(view === "summary" ? null : "summary")} label={t("coach.next.summary")} hint={t("coach.next.summaryHint")} />
          <StepButton
            icon={ClipboardCheck}
            disabled={quiz.isPending}
            onClick={() => quiz.mutate({ materialId: m.id, locale })}
            label={quiz.isPending ? t("coach.practice.preparing") : t("coach.next.quiz", { count: COACH_MATERIAL_QUIZ_COUNT })}
            hint={t("coach.next.quizHint")}
          />
          <StepButton icon={MessageCircle} href={`/student/coach/t/${first.id}?tab=ask`} label={t("coach.next.ask")} hint={t("coach.next.askHint")} />
        </div>
      </Panel>
      {view === "summary" && <MaterialSummary materialId={m.id} onClose={() => setView(null)} />}
    </>
  );
}

function MaterialSummary({ materialId, onClose }: { materialId: string; onClose: () => void }) {
  const { locale } = useI18n();
  const utils = trpc.useUtils();
  const input = { materialId, locale };
  const summary = trpc.student.coach.learn.materialSummary.useQuery(input);
  const generate = trpc.student.coach.learn.generateMaterialSummary.useMutation({
    onSuccess: (data) => utils.student.coach.learn.materialSummary.setData(input, data),
    onError: (e) => toast.error(errorText(e)),
  });
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (summary.data === null && !generate.isPending && !asked.current.has(locale)) {
      asked.current.add(locale);
      generate.mutate(input);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.data, locale]);
  return (
    <Panel
      title={t("coach.next.summaryTitle")}
      action={
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("coach.next.close")}
        </Button>
      }
    >
      {generate.isPending || summary.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">{t("coach.learn.preparing")}</p>
      ) : summary.data ? (
        <PackView pack={summary.data} />
      ) : (
        <Button size="sm" onClick={() => generate.mutate(input)}>{t("coach.learn.prepare")}</Button>
      )}
      <p className="mt-4 text-xs text-muted-foreground">{t("coach.learn.aiNote")}</p>
    </Panel>
  );
}

function MaterialReady({ m, limits }: { m: CoachMaterialDetail; limits: UploadLimits }) {
  const mastery = trpc.student.coach.review.materialProgress.useQuery({ id: m.id });
  const progress = new Map((mastery.data ?? []).map((r) => [r.topicId, r]));
  return (
    <>
      <NextSteps m={m} />
      <TextNotices m={m} limits={limits} />
      <Panel
        title={t("coach.material.topics")}
        action={
          <Link href={`/student/coach/m/${m.id}/text`} className="text-sm text-link hover:underline">
            {t("coach.text.link")}
          </Link>
        }
      >
        <ol className="space-y-2">
          {m.topics.map((topic) => (
            <li key={topic.id}>
              <Link href={`/student/coach/t/${topic.id}`} className="flex items-baseline gap-3 rounded-lg border border-border px-3 py-2 hover:border-link">
                <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">{topic.ord + 1}</span>
                <span className="min-w-0 flex-1 break-words">{topic.title}</span>
                {progress.get(topic.id) && <MasteryBadge mastery={progress.get(topic.id)!.mastery} status={progress.get(topic.id)!.status} />}
                <span className="shrink-0 text-xs text-muted-foreground">{pagesLabel(topic.pageFrom, topic.pageTo)}</span>
              </Link>
            </li>
          ))}
        </ol>
      </Panel>
      <SharePanel materialId={m.id} />
    </>
  );
}

export const pagesLabel = (from: number, to: number) => (from === to ? t("coach.page", { page: from }) : t("coach.pages", { from, to }));
