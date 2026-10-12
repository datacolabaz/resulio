import { Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { SUMMARY_FORMATS, type Cite, type SummaryFormat } from "@shared/coach";
import { Pencil, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Pack = NonNullable<RouterOutputs["student"]["coach"]["learn"]["pack"]>;

/** "Öyrən": the topic's summary in the student's app language, with checked source quotes. */
export function LearnTab({ topicId }: { topicId: string }) {
  const { locale } = useI18n();
  const [format, setFormat] = useState<SummaryFormat>("SHORT");
  const utils = trpc.useUtils();
  const input = { topicId, format, locale };
  const pack = trpc.student.coach.learn.pack.useQuery(input);
  const generate = trpc.student.coach.learn.generate.useMutation({
    onSuccess: (data) => utils.student.coach.learn.pack.setData(input, data),
    onError: (e) => toast.error(errorText(e)),
  });
  const asked = useRef(new Set<string>());
  const key = `${topicId}:${format}:${locale}`;
  // A pack that does not exist yet in this language is prepared once, automatically.
  useEffect(() => {
    if (pack.data === null && !generate.isPending && !asked.current.has(key)) {
      asked.current.add(key);
      generate.mutate(input);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack.data, key]);

  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-border p-0.5" role="radiogroup" aria-label={t("coach.learn.format")}>
          {SUMMARY_FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={format === f}
              onClick={() => setFormat(f)}
              className={`rounded-md px-3 py-1.5 text-sm ${format === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {t(`coach.learn.format.${f}`)}
            </button>
          ))}
        </div>
        {pack.data && (
          <Button
            size="sm"
            variant="ghost"
            disabled={generate.isPending}
            onClick={() => (!pack.data?.edited || window.confirm(t("coach.learn.regenerateConfirm"))) && generate.mutate(input)}
          >
            <RefreshCw className="mr-1 h-4 w-4" aria-hidden />
            {t("coach.learn.regenerate")}
          </Button>
        )}
      </div>
      {generate.isPending || pack.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">{t("coach.learn.preparing")}</p>
      ) : pack.data ? (
        <PackView pack={pack.data} />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t("coach.learn.none")}</p>
          <Button size="sm" onClick={() => generate.mutate(input)}>{t("coach.learn.prepare")}</Button>
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">{t("coach.learn.aiNote")}</p>
    </Panel>
  );
}

function PackView({ pack }: { pack: Pack }) {
  const { content } = pack;
  return (
    <article className="space-y-5">
      {pack.stale && <p role="status" className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning">{t("coach.learn.stale")}</p>}
      <h3 className="text-lg font-semibold">{content.title}</h3>
      {content.sections.map((s, si) => (
        <section key={si} className="space-y-2">
          {s.heading && <h4 className="font-medium">{s.heading}</h4>}
          <ul className="space-y-2">
            {s.points.map((p, pi) => (
              <li key={pi} className="rounded-lg border border-border p-3">
                <EditableText artifactId={pack.id} at={{ section: si, point: pi }} text={p.text} />
                <Sources cites={p.cites} general={p.grounding === "GENERAL"} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!!content.concepts?.length && (
        <section className="space-y-2">
          <h4 className="font-medium">{t("coach.learn.concepts")}</h4>
          <dl className="grid gap-2 sm:grid-cols-2">
            {content.concepts.map((c, ci) => (
              <div key={ci} className="rounded-lg border border-border p-3">
                <dt className="font-medium">{c.term}</dt>
                <dd className="mt-1 text-sm">
                  <EditableText artifactId={pack.id} at={{ concept: ci }} text={c.definition} />
                  <Sources cites={c.cites} general={c.grounding === "GENERAL"} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {!!content.questions?.length && (
        <section className="space-y-2">
          <h4 className="font-medium">{t("coach.learn.questions")}</h4>
          <ol className="list-decimal space-y-1 pl-5 text-sm">{content.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
        </section>
      )}
      {!!content.pitfalls?.length && (
        <section className="space-y-2">
          <h4 className="font-medium">{t("coach.learn.pitfalls")}</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm">{content.pitfalls.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </section>
      )}
      <p className="text-xs text-muted-foreground">
        {pack.edited ? t("coach.learn.editedAt", { date: fmtDateTime(pack.updatedAt) }) : t("coach.learn.updatedAt", { date: fmtDateTime(pack.updatedAt) })}
      </p>
    </article>
  );
}

function Sources({ cites, general }: { cites: Cite[]; general: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  if (general) return <p className="mt-1 text-xs text-muted-foreground">{t("coach.learn.general")}</p>;
  return (
    <div className="mt-2 space-y-1">
      <div className="flex flex-wrap gap-1">
        {cites.map((c, i) => (
          <button
            key={i}
            type="button"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? null : i)}
            className="rounded-full border border-border px-2 py-0.5 text-xs text-link hover:bg-muted"
          >
            {t("coach.page", { page: c.page })}
          </button>
        ))}
      </div>
      {open !== null && cites[open] && <blockquote className="border-l-2 border-border pl-3 text-xs italic text-muted-foreground">{cites[open].quote}</blockquote>}
    </div>
  );
}

function EditableText({ artifactId, at, text }: { artifactId: string; at: { section?: number; point?: number; concept?: number }; text: string }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const edit = trpc.student.coach.learn.edit.useMutation({
    onSuccess: () => {
      setEditing(false);
      void utils.student.coach.learn.pack.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!editing) {
    return (
      <div className="group flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm leading-relaxed">{text}</p>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100"
          aria-label={t("coach.learn.edit")}
          title={t("coach.learn.edit")}
          onClick={() => {
            setValue(text);
            setEditing(true);
          }}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) edit.mutate({ artifactId, ...at, text: value.trim() });
      }}
    >
      <textarea className="min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" value={value} maxLength={800} aria-label={t("coach.learn.edit")} onChange={(e) => setValue(e.target.value)} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
        <Button type="submit" size="sm" disabled={edit.isPending || !value.trim()}>{t("common.save")}</Button>
      </div>
    </form>
  );
}
