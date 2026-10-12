import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { ResponsiveTable } from "@/components/ResponsiveTable";
import { Button } from "@/components/ui/button";
import { isMessageKey, t } from "@/i18n/messages";
import { errorText, fmtDay } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Check, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { CoachShell } from "./CoachShell";
import { MasteryBadge } from "./materialUi";

const causeLabel = (cause: string) => {
  const key = `coach.cause.${cause}`;
  return isMessageKey(key) ? t(key) : cause;
};

/** Library: topics due for review today and the open-mistakes link. */
export function ReviewCard() {
  const queue = trpc.student.coach.review.queue.useQuery();
  const mistakes = trpc.student.coach.review.mistakes.useQuery({ includeFixed: false });
  if (!queue.data?.length && !mistakes.data?.length) return null;
  return (
    <Panel
      title={t("coach.review.title")}
      action={
        mistakes.data?.length ? (
          <Link href="/student/coach/mistakes" className="text-sm text-link hover:underline">
            {t("coach.review.mistakesLink", { count: mistakes.data.length })}
          </Link>
        ) : undefined
      }
    >
      {!queue.data?.length ? (
        <p className="text-sm text-muted-foreground">{t("coach.review.nothingDue")}</p>
      ) : (
        <ul className="space-y-2">
          {queue.data.map((r) => (
            <li key={r.topicId}>
              <Link href={`/student/coach/t/${r.topicId}?tab=practice`} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 hover:border-link">
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-medium">{r.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {r.materialTitle}
                    {r.overdueDays > 0 && ` · ${t("coach.review.overdue", { count: r.overdueDays })}`}
                    {r.openMistakes > 0 && ` · ${t("coach.home.mistakes", { count: r.openMistakes })}`}
                  </span>
                </span>
                <MasteryBadge mastery={r.mastery} status={r.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** "/student/coach/mistakes": wrong answers to work through, grouped by topic. */
export function CoachMistakesPage() {
  return (
    <CoachShell title={t("coach.mistakes.title")} back="/student/coach">
      {() => <MistakesBody />}
    </CoachShell>
  );
}

type Mistake = RouterOutputs["student"]["coach"]["review"]["mistakes"][number];

function MistakesBody() {
  const [includeFixed, setIncludeFixed] = useState(false);
  const utils = trpc.useUtils();
  const q = trpc.student.coach.review.mistakes.useQuery({ includeFixed });
  const fix = trpc.student.coach.review.fixMistake.useMutation({
    onSuccess: () => void utils.student.coach.review.invalidate(),
    onError: (e) => toast.error(errorText(e)),
  });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const groups = new Map<string, Mistake[]>();
  for (const m of q.data) {
    const key = m.topicId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return (
    <>
      <Panel>
        <p className="text-sm text-muted-foreground">{t("coach.mistakes.intro")}</p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={includeFixed} onChange={(e) => setIncludeFixed(e.target.checked)} />
          {t("coach.mistakes.showFixed")}
        </label>
      </Panel>
      {!q.data.length ? (
        <Panel>
          <p className="text-sm text-muted-foreground">{t("coach.mistakes.empty")}</p>
        </Panel>
      ) : (
        [...groups.entries()].map(([topicId, rows]) => (
          <Panel key={topicId || "none"} title={rows[0].topicTitle ?? t("coach.mistakes.noTopic")}>
            {rows[0].materialTitle && <p className="-mt-2 mb-3 text-xs text-muted-foreground">{rows[0].materialTitle}</p>}
            <ul className="space-y-2">
              {rows.map((m) => (
                <li key={m.id} className={`rounded-lg border p-3 text-sm ${m.fixedAt ? "border-border opacity-70" : "border-destructive/30"}`}>
                  <p className="break-words">{m.question}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-full bg-muted px-2 py-0.5">{causeLabel(m.cause)}</span>
                    <span>{fmtDay(m.createdAt)}</span>
                    {m.fixedAt && <span className="text-success">{t("coach.mistakes.fixedOn", { date: fmtDay(m.fixedAt) })}</span>}
                    {!m.fixedAt && (
                      <Button size="sm" variant="ghost" className="ml-auto" disabled={fix.isPending} onClick={() => fix.mutate({ id: m.id })}>
                        <Check className="mr-1 h-4 w-4" aria-hidden />
                        {t("coach.mistakes.markFixed")}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {topicId && (
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                <Link href={`/student/coach/t/${topicId}?tab=learn`} className="text-link hover:underline">{t("coach.mistakes.reread")}</Link>
                <Link href={`/student/coach/t/${topicId}?tab=practice`} className="text-link hover:underline">{t("coach.mistakes.practise")}</Link>
              </div>
            )}
          </Panel>
        ))
      )}
    </>
  );
}

type Memory = RouterOutputs["student"]["coach"]["memory"]["list"];

/** Settings → "AI yaddaşı": what the coach remembers, deletable one by one or all at once. */
export function MemorySection() {
  const utils = trpc.useUtils();
  const q = trpc.student.coach.memory.list.useQuery();
  const done = () => {
    void utils.student.coach.memory.invalidate();
    void utils.student.coach.review.invalidate();
    void utils.student.coach.practice.progress.invalidate();
  };
  const onError = (e: unknown) => toast.error(errorText(e));
  const forgetTopic = trpc.student.coach.memory.forgetTopic.useMutation({ onSuccess: done, onError });
  const forgetMistake = trpc.student.coach.memory.forgetMistake.useMutation({ onSuccess: done, onError });
  const forgetAll = trpc.student.coach.memory.forgetAll.useMutation({
    onSuccess: () => {
      done();
      toast.success(t("coach.memory.cleared"));
    },
    onError,
  });
  const busy = forgetTopic.isPending || forgetMistake.isPending || forgetAll.isPending;
  const data: Memory | undefined = q.data;
  const empty = !!data && !data.topics.length && !data.mistakes.length;
  return (
    <Panel
      title={t("coach.memory.title")}
      action={
        data && !empty ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => window.confirm(t("coach.memory.clearConfirm")) && forgetAll.mutate()}>
            {t("coach.memory.clearAll")}
          </Button>
        ) : undefined
      }
    >
      <p className="mb-3 text-sm text-muted-foreground">{t("coach.memory.intro")}</p>
      {q.error ? (
        <ErrorNote error={q.error} />
      ) : !data ? (
        <Loading />
      ) : empty ? (
        <p className="text-sm text-muted-foreground">{t("coach.memory.empty")}</p>
      ) : (
        <div className="space-y-5">
          {!!data.topics.length && (
            <section>
              <h3 className="mb-2 text-sm font-medium">{t("coach.memory.topics")}</h3>
              <ResponsiveTable
                rows={data.topics}
                rowKey={(r) => r.topicId}
                columns={[
                  { key: "title", header: t("coach.memory.topic"), card: "title", cell: (r) => <span className="break-words">{r.title ?? "—"}</span> },
                  { key: "mastery", header: t("coach.mastery.title"), card: "aside", cell: (r) => <MasteryBadge mastery={r.mastery} status={r.status} /> },
                  { key: "material", header: t("coach.memory.material"), cell: (r) => <span className="break-words text-muted-foreground">{r.materialTitle ?? "—"}</span> },
                  { key: "attempts", header: t("coach.memory.attempts"), cell: (r) => r.attempts },
                  { key: "last", header: t("coach.memory.lastPractised"), cell: (r) => (r.lastPracticedAt ? fmtDay(r.lastPracticedAt) : "—") },
                  {
                    key: "action",
                    header: t("coach.memory.forget"),
                    srOnlyHeader: true,
                    card: "action",
                    cell: (r) => (
                      <Button size="sm" variant="ghost" disabled={busy} aria-label={t("coach.memory.forgetTopic", { title: r.title ?? "" })} onClick={() => forgetTopic.mutate({ topicId: r.topicId })}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    ),
                  },
                ]}
              />
            </section>
          )}
          {!!data.mistakes.length && (
            <section>
              <h3 className="mb-2 text-sm font-medium">{t("coach.memory.mistakes")}</h3>
              <ResponsiveTable
                rows={data.mistakes}
                rowKey={(r) => r.id}
                columns={[
                  { key: "question", header: t("coach.memory.question"), card: "title", cell: (r) => <span className="line-clamp-2 break-words">{r.question}</span> },
                  { key: "cause", header: t("coach.memory.cause"), card: "aside", cell: (r) => <span className="text-xs">{causeLabel(r.cause)}</span> },
                  { key: "topic", header: t("coach.memory.topic"), cell: (r) => <span className="break-words text-muted-foreground">{r.topicTitle ?? "—"}</span> },
                  { key: "state", header: t("coach.memory.state"), cell: (r) => (r.fixedAt ? t("coach.memory.fixed") : t("coach.memory.open")) },
                  {
                    key: "action",
                    header: t("coach.memory.forget"),
                    srOnlyHeader: true,
                    card: "action",
                    cell: (r) => (
                      <Button size="sm" variant="ghost" disabled={busy} aria-label={t("coach.memory.forgetMistake")} onClick={() => forgetMistake.mutate({ id: r.id })}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    ),
                  },
                ]}
              />
            </section>
          )}
        </div>
      )}
    </Panel>
  );
}
