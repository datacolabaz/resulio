import { Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { errorText, fmtDay } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { uploadCoachFile } from "@/lib/materialUpload";
import { formatFileSize, UploadError } from "@/lib/uploadFile";
import { COACH_DB_MAX_UPLOAD_MB, COACH_UPLOAD_EXTENSIONS, coachFileProblem, MATERIAL_GOALS, type MaterialGoal } from "@shared/coach";
import { FileText, FileUp, Info, Type } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { QuotaLine, type CoachStatus } from "./CoachShell";
import { StageBadge, inProgress } from "./materialUi";
import { ReviewCard } from "./CoachReview";

const inputClass = "mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-foreground";
const ACCEPT = COACH_UPLOAD_EXTENSIONS.join(",");

export function CoachLibrary({ status }: { status: CoachStatus }) {
  const list = trpc.student.coach.materials.list.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.some((m) => inProgress(m.stage)) ? 3000 : false),
  });
  return (
    <>
      <ReviewCard />
      <AddMaterial status={status} />
      <Panel title={t("coach.library.title")}>
        {!list.data ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : !list.data.length ? (
          <p className="text-sm text-muted-foreground">{t("coach.library.empty")}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {list.data.map((m) => (
              <li key={m.id}>
                <Link href={`/student/coach/m/${m.id}`} className="flex h-full flex-col gap-2 rounded-xl border border-border bg-background p-4 hover:border-link">
                  <div className="flex items-start gap-2">
                    {m.source === "TEXT" ? <Type className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /> : <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                    <span className="min-w-0 flex-1 break-words font-medium">{m.title}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <StageBadge stage={m.stage} />
                    {m.needsReview && <span className="rounded-full bg-warning-surface px-2 py-0.5 text-warning">{t("coach.ocr.checkBadge")}</span>}
                    {m.stage === "READY" && <span>{t("coach.library.topics", { count: m.topicCount })}</span>}
                    {m.pageCount > 0 && <span>{t("coach.library.pages", { count: m.pageCount })}</span>}
                    <span>{fmtDay(m.createdAt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function AddMaterial({ status }: { status: CoachStatus }) {
  const { locale } = useI18n();
  const [, nav] = useLocation();
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<"file" | "text">("file");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState<MaterialGoal>("LEARN_ALL");
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState<{ pct: number; abort: AbortController } | null>(null);
  const [fileError, setFileError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const done = (m: { id: string }) => {
    void utils.student.coach.materials.list.invalidate();
    setTitle("");
    setText("");
    nav(`/student/coach/m/${m.id}`);
  };
  const fromFile = trpc.student.coach.materials.createFromFile.useMutation({ onSuccess: done, onError: (e) => setFileError(errorText(e)) });
  const fromText = trpc.student.coach.materials.createFromText.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  const limits = status.upload;
  const maxSize = formatFileSize(limits.maxBytes);

  const pick = async (picked: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!picked) return;
    setFileError("");
    const problem = coachFileProblem(picked, limits.maxBytes);
    if (problem) {
      setFileError(problem === "TYPE" ? t("coach.add.badType") : t("coach.add.tooLarge", { name: picked.name, size: formatFileSize(picked.size), max: maxSize }));
      return;
    }
    const abort = new AbortController();
    setUploading({ pct: 0, abort });
    try {
      const file = await uploadCoachFile(
        picked,
        { direct: limits.direct, serverMaxBytes: COACH_DB_MAX_UPLOAD_MB * 1024 * 1024 },
        {
          start: (i) => utils.client.student.coach.uploads.start.mutate(i),
          partUrls: (i) => utils.client.student.coach.uploads.partUrls.mutate(i),
          complete: (i) => utils.client.student.coach.uploads.complete.mutate(i),
          abort: (i) => utils.client.student.coach.uploads.abort.mutate(i),
        },
        { signal: abort.signal, onProgress: (f) => setUploading({ pct: Math.round(f * 100), abort }) },
      );
      fromFile.mutate({ fileId: file.fileId, title: title.trim() || undefined, goal, locale });
    } catch (e) {
      const code = e instanceof UploadError ? e.code : "";
      if (code === "UPLOAD_CANCELLED") return;
      if (code === "FILE_TOO_LARGE") setFileError(t("coach.add.tooLarge", { name: picked.name, size: formatFileSize(picked.size), max: maxSize }));
      else setFileError(code && code !== "UPLOAD_FAILED" ? errorText(new Error(code)) : t("files.uploadFailed"));
    } finally {
      setUploading(null);
    }
  };
  const busy = !!uploading || fromFile.isPending || fromText.isPending;

  return (
    <Panel title={t("coach.add.title")}>
      <div className="space-y-4">
        <div role="tablist" aria-label={t("coach.add.title")} className="inline-flex rounded-lg border border-border p-0.5">
          {(["file", "text"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 text-sm ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {m === "file" ? t("coach.add.file") : t("coach.add.text")}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            {t("coach.add.titleLabel")}
            <input className={inputClass} value={title} maxLength={200} placeholder={t("coach.add.titlePlaceholder")} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block text-sm font-medium">
            {t("coach.add.goal")}
            <select className={inputClass} value={goal} onChange={(e) => setGoal(e.target.value as MaterialGoal)}>
              {MATERIAL_GOALS.map((g) => <option key={g} value={g}>{t(`coach.goal.${g}`)}</option>)}
            </select>
          </label>
        </div>
        {mode === "file" ? (
          <div className="space-y-3 rounded-xl border border-dashed border-border bg-background p-4">
            <input ref={input} type="file" accept={ACCEPT} className="sr-only" aria-label={t("coach.add.chooseFile")} disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={busy} onClick={() => input.current?.click()}>
                <FileUp className="mr-1 h-4 w-4" aria-hidden />
                {busy ? t("coach.stage.CHECKING") : t("coach.add.chooseFile")}
              </Button>
              {uploading && (
                <Button type="button" variant="ghost" size="sm" onClick={() => uploading.abort.abort()}>
                  {t("common.cancel")}
                </Button>
              )}
            </div>
            {uploading && (
              <div className="space-y-1" aria-live="polite">
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploading.pct} aria-label={t("coach.add.uploading", { pct: uploading.pct })}>
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${uploading.pct}%` }} />
                </div>
                <p className="text-sm text-muted-foreground">{t("coach.add.uploading", { pct: uploading.pct })}</p>
              </div>
            )}
            <div className="flex items-start gap-2 text-sm text-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 space-y-1">
                <p className="font-medium">{t("coach.add.limits", { size: maxSize, pages: limits.maxPages })}</p>
                {limits.ocrPages > 0 && (
                  <p>{limits.ocrPagesPerMonth > 0 ? t("coach.add.ocrCap", { ocr: limits.ocrPages, month: limits.ocrPagesPerMonth }) : t("coach.add.ocrCapNoMonth", { ocr: limits.ocrPages })}</p>
                )}
                {limits.reducedByStorage && <p className="text-warning">{t("coach.add.storageNote", { size: maxSize })}</p>}
              </div>
            </div>
            {fileError && (
              <p role="alert" className="rounded-lg bg-danger-surface px-3 py-2 text-sm text-destructive">
                {fileError}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("coach.ocr.disclaimer")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block text-sm font-medium">
              {t("coach.add.textLabel")}
              <textarea className={`${inputClass} min-h-40`} value={text} maxLength={100_000} onChange={(e) => setText(e.target.value)} />
            </label>
            <Button type="button" disabled={busy || text.trim().length < 50} onClick={() => fromText.mutate({ text, title: title.trim() || undefined, goal, locale })}>
              {t("coach.add.textSubmit")}
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t("coach.add.private")}</p>
        <QuotaLine quota={status.quota} />
      </div>
    </Panel>
  );
}
