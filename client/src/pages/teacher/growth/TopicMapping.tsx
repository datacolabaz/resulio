import { Loading, Panel, StatCard } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

const selectClass = "w-full min-w-40 rounded-lg border border-input bg-card px-2 py-1.5 text-sm text-foreground";

/** Data quality of topics in results, and the free-text → bank section mapping. */
export function TopicMappingTab() {
  const health = trpc.teacher.growth.topicHealth.useQuery();
  if (!health.data) return <Loading />;
  const h = health.data;
  if (!h.totalQuestions) return <Panel><p className="text-sm text-muted-foreground">{t("growth.topics.noData")}</p></Panel>;
  const free = h.textTopics.reduce((s, x) => s + x.questionCount, 0);
  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-muted-foreground">{t("growth.topics.intro")}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t("growth.topics.onSections")} value={h.sectionQuestions} />
        <StatCard label={t("growth.topics.free")} value={free} />
        <StatCard label={t("growth.topics.untagged")} value={h.untaggedQuestions} hint={h.untaggedQuestions ? t("growth.topics.untaggedHint") : undefined} />
      </div>
      <Panel title={t("growth.topics.free")}>
        {!h.textTopics.length ? (
          <p className="text-sm text-muted-foreground">{t("growth.topics.empty")}</p>
        ) : (
          <ul className="divide-y">
            {h.textTopics.map((row) => (
              <AliasRow key={row.aliasKey} row={row} alias={h.aliases.find((a) => a.aliasKey === row.aliasKey) ?? null} sections={h.sections} />
            ))}
          </ul>
        )}
      </Panel>
      {h.aliases.length > 0 && <SavedAliases aliases={h.aliases} />}
    </div>
  );
}

function SavedAliases({ aliases }: { aliases: { aliasKey: string; label: string; sectionLabel: string | null }[] }) {
  const utils = trpc.useUtils();
  const remove = trpc.teacher.growth.removeAlias.useMutation({
    onSuccess: () => {
      toast.success(t("growth.topics.saved"));
      void utils.teacher.growth.topicHealth.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <Panel title={t("growth.topics.aliases")}>
      <ul className="divide-y">
        {aliases.map((a) => (
          <li key={a.aliasKey} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span className="min-w-0 break-words">
              {a.label} <span className="text-muted-foreground">→ {a.sectionLabel ?? t("growth.topics.noSection")}</span>
            </span>
            <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate({ aliasKey: a.aliasKey })}>
              {t("growth.topics.remove")}
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function AliasRow({
  row,
  alias,
  sections,
}: {
  row: { aliasKey: string; label: string; questionCount: number; studentCount: number; mapped: boolean };
  alias: { label: string; questionTopicId: string | null } | null;
  sections: { id: string; label: string }[];
}) {
  const utils = trpc.useUtils();
  const [sectionId, setSectionId] = useState(alias?.questionTopicId ?? "");
  const [label, setLabel] = useState(alias?.label ?? row.label);
  const onDone = () => {
    toast.success(t("growth.topics.saved"));
    void utils.teacher.growth.topicHealth.invalidate();
  };
  const save = trpc.teacher.growth.mapAlias.useMutation({ onSuccess: onDone, onError: (e) => toast.error(errorText(e)) });
  const remove = trpc.teacher.growth.removeAlias.useMutation({ onSuccess: onDone, onError: (e) => toast.error(errorText(e)) });
  return (
    <li className="grid gap-2 py-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
      <div className="min-w-0">
        <div className="break-words text-sm font-medium">{row.label}</div>
        <div className="text-xs text-muted-foreground">
          {t("growth.topics.colAnswers")}: {row.questionCount} · {t("growth.topics.colStudents")}: {row.studentCount}
        </div>
        {row.mapped && <StatusBadge tone="success" className="mt-1">{t("growth.topics.mapped")}</StatusBadge>}
      </div>
      <label className="text-xs text-muted-foreground">
        {t("growth.topics.colSection")}
        <select className={`${selectClass} mt-1`} value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
          <option value="">{t("growth.topics.noSection")}</option>
          {sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <label className="text-xs text-muted-foreground">
        {t("growth.topics.colLabel")}
        <Input className="mt-1" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ aliasKey: row.aliasKey, label, questionTopicId: sectionId || null })}>
          {t("growth.topics.save")}
        </Button>
        {row.mapped && (
          <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate({ aliasKey: row.aliasKey })}>
            {t("growth.topics.remove")}
          </Button>
        )}
      </div>
    </li>
  );
}
