import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { acceptFor, maxBytesFor, uploadMaterialFile, type UploadConfig } from "@/lib/materialUpload";
import { trpc } from "@/lib/trpc";
import { formatFileSize, UploadError, type UploadedFile } from "@/lib/uploadFile";
import { linkHost, parseWebUrl, type MaterialKind } from "@shared/materialTemplates";
import { ExternalLink, FileUp, Link2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

export type SourceMode = "FILE" | "LINK";

type Upload = { file: File; percent: number; controller: AbortController } | null;

function uploadErrorText(code: string, file: File, kind: MaterialKind, config: UploadConfig) {
  if (code === "FILE_TOO_LARGE") return `${t("material.form.uploadFailed", { name: file.name })} ${t("material.form.fileLimit", { size: formatFileSize(maxBytesFor(kind, config)) })}`;
  if (code === "FILE_TYPE_NOT_ALLOWED") return `${t("material.form.uploadFailed", { name: file.name })} ${t("files.typeNotAllowed")}`;
  return `${t("material.form.uploadFailed", { name: file.name })} ${errorText(new Error(code))}`;
}

/** A material's source: one file (any size the kind allows) or one link. */
export function MaterialSourceInput({
  kind,
  mode,
  onMode,
  file,
  onFile,
  url,
  onUrl,
  onBusy,
}: {
  kind: MaterialKind;
  mode: SourceMode;
  onMode: (m: SourceMode) => void;
  file: UploadedFile | null;
  onFile: (f: UploadedFile | null) => void;
  url: string;
  onUrl: (u: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const config = trpc.teacher.tasks.uploadConfig.useQuery(undefined, { staleTime: 60_000 });
  const inputRef = useRef<HTMLInputElement>(null);
  const linkId = useId();
  const [upload, setUpload] = useState<Upload>(null);
  const [failed, setFailed] = useState<File | null>(null);
  const busy = !!upload;
  useEffect(() => onBusy(busy), [busy, onBusy]);
  const running = useRef<AbortController | null>(null);
  running.current = upload?.controller ?? null;
  useEffect(() => () => running.current?.abort(), []);

  const linkOnly = kind === "LINK";
  const effectiveMode: SourceMode = linkOnly ? "LINK" : mode;
  const cfg = config.data;
  const linkValid = !url.trim() || parseWebUrl(url) !== null;

  const start = async (picked: File) => {
    if (!cfg) return;
    const controller = new AbortController();
    setFailed(null);
    setUpload({ file: picked, percent: 0, controller });
    try {
      const saved = await uploadMaterialFile(
        picked,
        kind,
        cfg,
        {
          start: (i) => utils.client.teacher.tasks.startUpload.mutate(i),
          partUrls: (i) => utils.client.teacher.tasks.uploadPartUrls.mutate(i),
          complete: (i) => utils.client.teacher.tasks.completeUpload.mutate(i),
          abort: (i) => utils.client.teacher.tasks.abortUpload.mutate(i),
        },
        { signal: controller.signal, onProgress: (f) => setUpload((u) => (u && u.controller === controller ? { ...u, percent: Math.round(f * 100) } : u)) },
      );
      onFile(saved);
      void utils.teacher.tasks.uploadConfig.invalidate();
    } catch (e) {
      const code = e instanceof UploadError ? e.code : "UPLOAD_FAILED";
      if (code === "UPLOAD_CANCELLED") toast(t("material.form.uploadCancelled"));
      else {
        toast.error(uploadErrorText(code, picked, kind, cfg));
        if (code !== "FILE_TOO_LARGE" && code !== "FILE_TYPE_NOT_ALLOWED" && code !== "STORAGE_QUOTA_EXCEEDED") setFailed(picked);
      }
    } finally {
      setUpload((u) => (u?.controller === controller ? null : u));
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="grid gap-2">
      {!linkOnly && (
        <div role="tablist" aria-label={t("material.form.source")} className="inline-flex w-fit rounded-lg border border-border p-0.5 text-sm">
          {(["FILE", "LINK"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={effectiveMode === m}
              disabled={!!upload}
              onClick={() => onMode(m)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 ${effectiveMode === m ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {m === "FILE" ? <FileUp className="size-4" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
              {m === "FILE" ? t("material.form.tabFile") : t("material.form.tabLink")}
            </button>
          ))}
        </div>
      )}

      {effectiveMode === "LINK" ? (
        <div>
          <label htmlFor={linkId} className="sr-only">{t("material.form.linkLabel")}</label>
          <Input
            id={linkId}
            type="url"
            inputMode="url"
            placeholder={t("syllabus.urlPlaceholder")}
            maxLength={2048}
            value={url}
            aria-invalid={!linkValid}
            aria-describedby={url.trim() ? `${linkId}-hint` : undefined}
            onChange={(e) => onUrl(e.target.value)}
          />
          {url.trim() && (
            <p id={`${linkId}-hint`} className={`mt-1 text-xs ${linkValid ? "text-muted-foreground" : "text-destructive"}`}>
              {linkValid ? (
                <span className="inline-flex items-center gap-1"><ExternalLink className="size-3" aria-hidden />{t("material.form.linkOpensAt", { host: linkHost(url) })}</span>
              ) : t("material.form.linkInvalid")}
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-1.5">
          <input
            ref={inputRef}
            type="file"
            accept={acceptFor(kind)}
            className="sr-only"
            aria-label={t("files.choose")}
            disabled={!!upload || !cfg}
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void start(picked);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!!upload || !cfg} onClick={() => inputRef.current?.click()}>
              {file ? t("files.replace") : t("files.choose")}
            </Button>
            {file && !upload && (
              <span className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-sm">
                <span className="min-w-0 break-all">{file.name}</span>
                {file.size > 0 && <span className="shrink-0 text-xs text-muted-foreground">({formatFileSize(file.size)})</span>}
                <button type="button" onClick={() => onFile(null)} className="shrink-0 text-xs font-medium text-destructive hover:underline">{t("common.remove")}</button>
              </span>
            )}
            {!file && !upload && !failed && <span className="text-xs text-muted-foreground">{t("files.noFile")}</span>}
            {failed && !upload && (
              <Button type="button" size="sm" variant="ghost" onClick={() => void start(failed)}>{t("material.form.retryUpload")}</Button>
            )}
          </div>
          {upload && (
            <div className="grid gap-1 rounded-lg border border-border p-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 break-all">{upload.file.name} · {formatFileSize(upload.file.size)}</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => upload.controller.abort()}>{t("material.form.cancelUpload")}</Button>
              </div>
              <Progress value={upload.percent} aria-label={t("material.form.uploadProgress", { percent: upload.percent })} />
              <span className="text-xs text-muted-foreground" aria-live="polite">{t("material.form.uploadProgress", { percent: upload.percent })}</span>
            </div>
          )}
          {cfg && (
            <p className="text-xs text-muted-foreground">
              {t("material.form.fileLimit", { size: formatFileSize(maxBytesFor(kind, cfg)) })}
              {cfg.quota ? ` · ${t("material.form.quota", { used: formatFileSize(cfg.quota.usedBytes), limit: formatFileSize(cfg.quota.limitBytes) })}` : ""}
              {!cfg.direct ? ` · ${t("material.form.serverOnly")}` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
