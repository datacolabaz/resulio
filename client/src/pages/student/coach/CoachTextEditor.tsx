import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { OCR_LOW_QUALITY } from "@shared/coach";
import { CheckCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useParams } from "wouter";
import { CoachShell } from "./CoachShell";

type Chunk = RouterOutputs["student"]["coach"]["materials"]["chunks"]["chunks"][number];

const isLow = (c: Pick<Chunk, "method" | "quality">) => c.method === "OCR" && c.quality !== null && c.quality < OCR_LOW_QUALITY;

/** "/student/coach/m/:id/text": the recognised text page by page, editable by the student. */
export function CoachTextEditorPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <CoachShell title={t("coach.text.title")} intro={t("coach.text.intro")} back={`/student/coach/m/${id}`}>
      {() => <Editor id={id} />}
    </CoachShell>
  );
}

function Editor({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const q = trpc.student.coach.materials.chunks.useQuery({ id });
  const [onlyLow, setOnlyLow] = useState(false);
  const reviewed = trpc.student.coach.materials.markReviewed.useMutation({
    onSuccess: () => {
      toast.success(t("coach.text.reviewedDone"));
      void utils.student.coach.materials.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const { material, chunks } = q.data;
  const hasOcr = chunks.some((c) => c.method === "OCR");
  const lowCount = chunks.filter(isLow).length;
  const shown = onlyLow ? chunks.filter(isLow) : chunks;
  return (
    <>
      {hasOcr && (
        <Panel>
          <div className="space-y-3">
            {material.needsReview && (
              <p role="status" className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning">{t("coach.ocr.lowQuality")}</p>
            )}
            <p className="text-xs text-muted-foreground">{t("coach.ocr.disclaimer")}</p>
            <div className="flex flex-wrap items-center justify-between gap-3">
              {lowCount > 0 ? (
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={onlyLow} onCheckedChange={setOnlyLow} />
                  {t("coach.text.onlyLow", { count: lowCount })}
                </label>
              ) : (
                <span />
              )}
              {material.needsReview && (
                <Button size="sm" variant="outline" disabled={reviewed.isPending} onClick={() => reviewed.mutate({ id })}>
                  <CheckCheck className="mr-1 h-4 w-4" aria-hidden />
                  {t("coach.text.reviewed")}
                </Button>
              )}
            </div>
          </div>
        </Panel>
      )}
      <ol className="space-y-3">
        {shown.map((c) => (
          <li key={c.id}>
            <ChunkEditor materialId={id} chunk={c} />
          </li>
        ))}
      </ol>
    </>
  );
}

function ChunkEditor({ materialId, chunk }: { materialId: string; chunk: Chunk }) {
  const utils = trpc.useUtils();
  const [text, setText] = useState(chunk.text);
  const save = trpc.student.coach.materials.updateChunk.useMutation({
    onSuccess: (r) => {
      if (r.changed) toast.success(t("coach.text.saved"));
      void utils.student.coach.materials.chunks.invalidate({ id: materialId });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const pages = chunk.pageFrom === chunk.pageTo ? t("coach.page", { page: chunk.pageFrom }) : t("coach.pages", { from: chunk.pageFrom, to: chunk.pageTo });
  const dirty = text.trim() !== chunk.text.trim();
  return (
    <section className={`rounded-2xl border bg-card p-4 ${isLow(chunk) ? "border-warning/60" : "border-border"}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{pages}</span>
        {chunk.heading && <span className="min-w-0 truncate">{chunk.heading}</span>}
        {chunk.method === "OCR" && (
          <span className={`rounded-full px-2 py-0.5 ${isLow(chunk) ? "bg-warning-surface text-warning" : "bg-muted"}`}>
            {isLow(chunk) ? t("coach.text.lowBadge") : t("coach.text.ocrBadge")}
          </span>
        )}
        {chunk.edited && <span className="rounded-full bg-info-surface px-2 py-0.5 text-info">{t("coach.text.editedBadge")}</span>}
      </div>
      <textarea
        className="min-h-40 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed"
        value={text}
        aria-label={pages}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => setText(chunk.text)}>
            {t("common.cancel")}
          </Button>
        )}
        <Button size="sm" disabled={!dirty || !text.trim() || save.isPending} onClick={() => save.mutate({ id: materialId, chunkId: chunk.id, text })}>
          {t("common.save")}
        </Button>
      </div>
    </section>
  );
}
