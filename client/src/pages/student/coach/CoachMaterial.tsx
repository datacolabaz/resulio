import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fileDownloadUrl, formatFileSize } from "@/lib/uploadFile";
import { Download, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams } from "wouter";
import { CoachShell, type CoachStatus } from "./CoachShell";
import { inProgress, MasteryBadge, StageBadge, StageSteps } from "./materialUi";
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
  const q = trpc.student.coach.materials.get.useQuery({ id }, { refetchInterval: (s) => (s.state.data && inProgress(s.state.data.stage) ? 2500 : false) });
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

function TextNotices({ m, limits }: { m: CoachMaterialDetail; limits: UploadLimits }) {
  return (
    <>
      {m.needsReview && (
        <div role="status" className="space-y-2 rounded-2xl border border-warning/40 bg-warning-surface p-4 text-sm">
          <p className="text-warning">{t("coach.ocr.lowQuality")}</p>
          <Link href={`/student/coach/m/${m.id}/text`} className="font-medium text-link hover:underline">
            {t("coach.text.open")}
          </Link>
        </div>
      )}
      {(m.errorCode === "OCR_LIMIT" || m.errorCode === "OCR_PARTIAL") && (
        <p role="status" className="rounded-2xl border border-warning/40 bg-warning-surface p-4 text-sm text-warning">
          {m.errorCode === "OCR_PARTIAL" ? t("coach.ocr.partial") : t("coach.ocr.skipped", limitValues(limits))}
        </p>
      )}
    </>
  );
}

function MaterialReady({ m, limits }: { m: CoachMaterialDetail; limits: UploadLimits }) {
  const mastery = trpc.student.coach.review.materialProgress.useQuery({ id: m.id });
  const progress = new Map((mastery.data ?? []).map((r) => [r.topicId, r]));
  return (
    <>
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
