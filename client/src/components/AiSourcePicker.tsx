import { CameraCapture } from "@/components/CameraCapture";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { formatFileSize, uploadFile, UploadError, type UploadedFile } from "@/lib/uploadFile";
import { Camera, FileUp, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

/** Formats `sourceMaterialFromFile` (server/modules/ai.ts) can actually read as source material. */
export const AI_SOURCE_ACCEPT = ".pdf,.docx,.pptx,.csv,.xlsx,.txt,.png,.jpg,.jpeg";
/** Matches `aiSourceSchema.fileIds`'s cap in server/modules/ai.ts. */
export const AI_SOURCE_MAX_FILES = 15;

/**
 * The teacher's "ground this generation in material" input -- shared by ExamBuilder's `AiDialog`
 * and TaskQuiz's `TaskAiTextDialog`/`TaskQuizAiDialog`, which previously each had their own copy of
 * a single-file picker. Lets the teacher attach several files at once, by clicking, dragging-and-
 * dropping, or shooting photos with the in-app camera (`CameraCapture`, built for a phone in hand),
 * or fall back to pasted text when no files are attached (file and text are mutually exclusive, as
 * before -- attaching a file clears any pasted text). `files`/`onFilesChange` and
 * `text`/`onTextChange` are controlled so callers build the `{ fileIds }` / `{ text }` source object
 * exactly as before, just with `fileIds` now plural.
 */
export function AiSourcePicker({
  files,
  onFilesChange,
  text,
  onTextChange,
  max = AI_SOURCE_MAX_FILES,
}: {
  files: UploadedFile[];
  onFilesChange: (v: UploadedFile[]) => void;
  text: string;
  onTextChange: (v: string) => void;
  max?: number;
}) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const atLimit = files.length >= max;

  const addFiles = async (picked: File[]) => {
    if (!picked.length) return;
    const room = Math.max(max - files.length, 0);
    if (!room) {
      toast.error(t("builder.aiSourceMaxReached", { max }));
      return;
    }
    const slice = picked.slice(0, room);
    if (slice.length < picked.length) toast.error(t("builder.aiSourceMaxReached", { max }));
    setUploading(true);
    try {
      const uploaded: UploadedFile[] = [];
      for (const file of slice) uploaded.push(await uploadFile(file, "ai-source"));
      onFilesChange([...files, ...uploaded]);
      if (uploaded.length) onTextChange("");
    } catch (e) {
      const code = e instanceof UploadError ? e.code : "UPLOAD_FAILED";
      toast.error(code === "FILE_TOO_LARGE" ? t("files.tooLarge") : code === "FILE_TYPE_NOT_ALLOWED" ? t("error.AI_SOURCE_FILE_TYPE") : t("files.uploadFailed"));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-1.5">
      <span className="text-foreground-secondary text-sm">{t("builder.aiSourceLabel")}</span>
      <div
        className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-3 text-center transition-colors ${dragOver ? "border-link bg-muted" : "border-border"}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!atLimit && !uploading) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (atLimit || uploading) return;
          void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={AI_SOURCE_ACCEPT}
          multiple
          className="sr-only"
          aria-label={t("builder.aiSourceAttach")}
          disabled={uploading || atLimit}
          onChange={(e) => void addFiles(Array.from(e.target.files ?? []))}
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={uploading || atLimit} onClick={() => inputRef.current?.click()}>
            <FileUp className="mr-1 h-4 w-4" aria-hidden />
            {uploading ? t("builder.aiSourceUploading") : t("builder.aiSourceAttach")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={uploading || atLimit} onClick={() => setCameraOpen(true)}>
            <Camera className="mr-1 h-4 w-4" aria-hidden />
            {t("builder.aiSourceCamera")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("builder.aiSourceDropHint")}</p>
        {files.length > 0 && <p className="text-xs text-muted-foreground">{t("builder.aiSourceCount", { count: files.length, max })}</p>}
      </div>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span key={f.fileId} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-sm">
              <span className="min-w-0 truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">({formatFileSize(f.size)})</span>
              <button type="button" aria-label={t("builder.aiSourceRemove")} onClick={() => onFilesChange(files.filter((x) => x.fileId !== f.fileId))}>
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      {!files.length && (
        <>
          <div className="text-xs text-muted-foreground">{t("builder.aiSourceOr")}</div>
          <Textarea rows={3} value={text} onChange={(e) => onTextChange(e.target.value)} placeholder={t("builder.aiSourceTextPlaceholder")} />
        </>
      )}
      <p className="text-xs text-muted-foreground">{t("builder.aiSourceHint", { max })}</p>
      <CameraCapture open={cameraOpen} onOpenChange={setCameraOpen} onDone={(shots) => void addFiles(shots)} />
    </div>
  );
}
