import { Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { errorText, fmtDay } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { formatFileSize, uploadFile, UploadError } from "@/lib/uploadFile";
import { COACH_UPLOAD_EXTENSIONS, MATERIAL_GOALS, type MaterialGoal } from "@shared/coach";
import { FileText, FileUp, Type } from "lucide-react";
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
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const done = (m: { id: string }) => {
    void utils.student.coach.materials.list.invalidate();
    setTitle("");
    setText("");
    nav(`/student/coach/m/${m.id}`);
  };
  const fromFile = trpc.student.coach.materials.createFromFile.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  const fromText = trpc.student.coach.materials.createFromText.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });

  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    setUploading(true);
    try {
      const file = await uploadFile(picked, "coach");
      fromFile.mutate({ fileId: file.fileId, title: title.trim() || undefined, goal, locale });
    } catch (e) {
      const code = e instanceof UploadError ? e.code : "";
      toast.error(code && code !== "UPLOAD_FAILED" ? errorText(new Error(code)) : t("files.uploadFailed"));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };
  const busy = uploading || fromFile.isPending || fromText.isPending;

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
          <div className="space-y-2">
            <input ref={input} type="file" accept={ACCEPT} className="sr-only" aria-label={t("coach.add.chooseFile")} disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} />
            <Button type="button" disabled={busy} onClick={() => input.current?.click()}>
              <FileUp className="mr-1 h-4 w-4" aria-hidden />
              {busy ? t("coach.stage.CHECKING") : t("coach.add.chooseFile")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("coach.add.limits", { size: formatFileSize(8 * 1024 * 1024), pages: 150 })}</p>
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
