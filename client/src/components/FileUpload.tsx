import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { formatFileSize, uploadFile, UploadError, type UploadContext, type UploadedFile } from "@/lib/uploadFile";
import { useRef, useState } from "react";
import { toast } from "sonner";

/** Extensions accepted by server/modules/files.ts's ALLOWED_FILE_TYPES, kept in sync by hand since
 *  that map lives server-side and the client only needs the extension list for the file picker. */
const ACCEPT = ".xlsx,.xls,.csv,.pdf,.pptx,.ppt,.docx,.doc,.txt,.png,.jpg,.jpeg";

function uploadErrorText(code: string) {
  if (code === "FILE_TOO_LARGE") return t("files.tooLarge");
  if (code === "FILE_TYPE_NOT_ALLOWED") return t("files.typeNotAllowed");
  return t("files.uploadFailed");
}

function FileChip({ file, onRemove }: { file: UploadedFile; onRemove: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-sm">
      <span className="min-w-0 truncate">{file.name}</span>
      {file.size > 0 && <span className="shrink-0 text-xs text-muted-foreground">({formatFileSize(file.size)})</span>}
      <button type="button" onClick={onRemove} className="shrink-0 text-xs font-medium text-destructive hover:underline">
        {t("common.remove")}
      </button>
    </span>
  );
}

/** A single-file picker (material file, one submission file). */
export function SingleFileUpload({
  value,
  onChange,
  context,
  taskId,
}: {
  value: UploadedFile | null;
  onChange: (v: UploadedFile | null) => void;
  context: UploadContext;
  taskId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      onChange(await uploadFile(file, context, { taskId }));
    } catch (e) {
      toast.error(e instanceof UploadError ? uploadErrorText(e.code) : t("files.uploadFailed"));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          aria-label={t("files.choose")}
          disabled={busy}
          onChange={(e) => void handle(e.target.files?.[0])}
        />
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? t("files.uploading") : value ? t("files.replace") : t("files.choose")}
        </Button>
        {value ? <FileChip file={value} onRemove={() => onChange(null)} /> : <span className="text-xs text-muted-foreground">{t("files.noFile")}</span>}
      </div>
      <p className="text-xs text-muted-foreground">{t("files.allowedTypes")}</p>
    </div>
  );
}

/** A multi-file picker (task attachments). */
export function MultiFileUpload({
  value,
  onChange,
  context,
  taskId,
  max = 20,
}: {
  value: UploadedFile[];
  onChange: (v: UploadedFile[]) => void;
  context: UploadContext;
  taskId?: string;
  max?: number;
}) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const atLimit = value.length >= max;

  const handle = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const picked = Array.from(fileList).slice(0, Math.max(max - value.length, 0));
    setBusy(true);
    try {
      const uploaded: UploadedFile[] = [];
      for (const file of picked) uploaded.push(await uploadFile(file, context, { taskId }));
      onChange([...value, ...uploaded]);
    } catch (e) {
      toast.error(e instanceof UploadError ? uploadErrorText(e.code) : t("files.uploadFailed"));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-1.5">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        aria-label={t("files.addFiles")}
        disabled={busy || atLimit}
        onChange={(e) => void handle(e.target.files)}
      />
      <Button type="button" variant="outline" size="sm" disabled={busy || atLimit} onClick={() => inputRef.current?.click()}>
        {busy ? t("files.uploading") : t("files.addFiles")}
      </Button>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((f) => (
            <FileChip key={f.fileId} file={f} onRemove={() => onChange(value.filter((x) => x.fileId !== f.fileId))} />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("files.allowedTypes")}</p>
    </div>
  );
}
