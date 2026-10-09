import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { isMessageKey, t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { formatFileSize, uploadFile, UploadError, type UploadedFile } from "@/lib/uploadFile";
import { SYLLABUS_IMPORT_FILE_EXTENSIONS, SYLLABUS_IMPORT_MAX_TEXT, SYLLABUS_IMPORT_MIN_TEXT, SYLLABUS_IMPORT_TEXT_EXTENSIONS } from "@shared/syllabusImport";
import { FileUp, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { toastError } from "./shared";

const ACCEPT = [...SYLLABUS_IMPORT_FILE_EXTENSIONS, ...SYLLABUS_IMPORT_TEXT_EXTENSIONS].join(",");
const isTextFile = (name: string) => SYLLABUS_IMPORT_TEXT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

export const importPath = (jobId: string) => `/teacher/syllabus/import/${jobId}`;

/** Why an import failed, in the teacher's words (unknown codes read as a generic error). */
export const importFailureText = (code: string | null) => {
  const key = `simport.failed.${code ?? ""}`;
  return isMessageKey(key) ? t(key) : t("simport.failed.INTERNAL");
};

/**
 * "Create from a file or text (AI)": paste the syllabus or pick a file. Text files are read here and
 * shown in the text box; PDF, Word and images are uploaded and read on the server.
 */
export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [, nav] = useLocation();
  const availability = trpc.teacher.syllabus.aiImport.availability.useQuery(undefined, { enabled: open, retry: false });
  const [tab, setTab] = useState<"text" | "file">("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const start = trpc.teacher.syllabus.aiImport.start.useMutation({
    onSuccess: (job) => {
      onOpenChange(false);
      setText("");
      setFile(null);
      nav(importPath(job.id));
    },
    onError: toastError,
  });

  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    try {
      if (isTextFile(picked.name)) {
        setText((await picked.text()).slice(0, SYLLABUS_IMPORT_MAX_TEXT));
        setTab("text");
        toast.success(t("simport.textFileRead", { name: picked.name }));
        return;
      }
      setUploading(true);
      setFile(await uploadFile(picked, "syllabus"));
    } catch (e) {
      const code = e instanceof UploadError ? e.code : "";
      toast.error(code === "FILE_TOO_LARGE" ? t("files.tooLarge") : code === "FILE_TYPE_NOT_ALLOWED" ? t("error.SYLLABUS_IMPORT_FILE_TYPE") : t("files.uploadFailed"));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };

  const a = availability.data;
  const trimmed = text.trim().length;
  // The server checks the limit again; an availability that is loading or failed must not block the start.
  const limitReached = !!a?.enabled && a.remainingToday <= 0;
  const canStart = !(a && !a.enabled) && !limitReached && !start.isPending && (tab === "text" ? trimmed >= SYLLABUS_IMPORT_MIN_TEXT : !!file);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t("simport.title")}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("simport.intro")}</p>
          {a && !a.enabled ? (
            <p role="status" className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm">{t("simport.unavailable")}</p>
          ) : (
            <Tabs value={tab} onValueChange={(v) => setTab(v as "text" | "file")}>
              <TabsList>
                <TabsTrigger value="text">{t("simport.tab.text")}</TabsTrigger>
                <TabsTrigger value="file">{t("simport.tab.file")}</TabsTrigger>
              </TabsList>
              <TabsContent value="text" className="space-y-1.5">
                <Textarea
                  rows={12}
                  maxLength={SYLLABUS_IMPORT_MAX_TEXT}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={t("simport.textPlaceholder")}
                  aria-label={t("simport.tab.text")}
                />
                <p className="text-xs text-muted-foreground">{t("simport.textCount", { count: trimmed, max: SYLLABUS_IMPORT_MAX_TEXT })}</p>
              </TabsContent>
              <TabsContent value="file" className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input ref={input} type="file" accept={ACCEPT} className="sr-only" aria-label={t("simport.chooseFile")} disabled={uploading} onChange={(e) => void pick(e.target.files?.[0])} />
                  <Button type="button" variant="outline" disabled={uploading} onClick={() => input.current?.click()}>
                    <FileUp className="mr-1 h-4 w-4" aria-hidden />
                    {uploading ? t("simport.uploading") : file ? t("files.replace") : t("simport.chooseFile")}
                  </Button>
                  {file && (
                    <span className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-sm">
                      <span className="min-w-0 truncate">{file.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">({formatFileSize(file.size)})</span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{t("simport.fileTypes")}</p>
              </TabsContent>
            </Tabs>
          )}
          {a?.enabled && <p className="text-xs text-muted-foreground">{t("simport.limits", { size: formatFileSize(a.maxBytes), pages: a.maxPages, left: a.remainingToday })}</p>}
          {limitReached && <p role="status" className="text-sm text-destructive">{t("simport.limitReached", { limit: a.dailyLimit })}</p>}
          {availability.isError && <p role="status" className="text-xs text-muted-foreground">{t("simport.availabilityError")}</p>}
          <p className="text-xs text-muted-foreground">{t("simport.reviewNote")}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={!canStart} onClick={() => start.mutate(tab === "text" ? { text } : { fileId: file!.fileId })}>
            <Sparkles className="mr-1 h-4 w-4" aria-hidden />
            {start.isPending ? t("simport.starting") : t("simport.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
