import { Loading, Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n/messages";
import { errorText, fmtDayKeyShort } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { PlanItemKind, PlanTargetSource } from "@shared/growth";
import { CheckCircle2, Flame, Link2 } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";

/** Personal XP (level, streak; no leaderboard) and the review plan with its daily steps. */
export function StudentPlan({ groupId }: { groupId: string }) {
  const q = trpc.student.growth.plan.useQuery({ groupId });
  if (!q.data) return <Loading />;
  return (
    <>
      <XpCard xp={q.data.xp} />
      <PlanPanel groupId={groupId} data={q.data} />
    </>
  );
}

type PlanData = RouterOutputs["student"]["growth"]["plan"];

function XpCard({ xp }: { xp: PlanData["xp"] }) {
  return (
    <Panel title={t("xp.title")}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-sm text-muted-foreground">{t("xp.level", { level: xp.level })}</div>
          <div className="font-[family-name:var(--font-display)] text-3xl tabular-nums">{t("xp.points", { xp: xp.xp })}</div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Flame className={`h-5 w-5 ${xp.activeToday ? "text-warning" : "text-muted-foreground"}`} aria-hidden />
          <span>{t("xp.streak", { count: xp.streak })}</span>
          <span className="text-xs text-muted-foreground">· {t("xp.longest", { count: xp.longestStreak })}</span>
        </div>
      </div>
      <Progress value={xp.pct} className="mt-3" aria-label={t("xp.next", { left: xp.to - xp.xp })} />
      <div className="mt-1 text-xs text-muted-foreground">{t("xp.next", { left: xp.to - xp.xp })}</div>
      {xp.recent.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2 text-xs">
          {xp.recent.slice(0, 6).map((e, i) => (
            <li key={i} className="rounded-full border border-border px-2 py-0.5">{t(`xp.type.${e.type}`)} +{e.points}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t("xp.personal")}</p>
    </Panel>
  );
}

function PlanPanel({ groupId, data }: { groupId: string; data: PlanData }) {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const [minutes, setMinutes] = useState(data.settings.dailyMinutes);
  const refresh = () => {
    void utils.student.growth.plan.invalidate({ groupId });
  };
  const create = trpc.student.growth.createPlan.useMutation({
    onSuccess: (r) => {
      toast.success(r.items ? t("plan.created", { count: r.items }) : t("plan.emptyTopics"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const done = trpc.student.growth.completeItem.useMutation({ onSuccess: refresh, onError: (e) => toast.error(errorText(e)) });
  const save = trpc.student.growth.saveSettings.useMutation({ onSuccess: refresh, onError: (e) => toast.error(errorText(e)) });
  const finish = trpc.student.growth.completePlan.useMutation({
    onSuccess: () => {
      toast.success(t("plan.completed"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const practice = trpc.student.growth.startPractice.useMutation({
    onSuccess: (r) => {
      toast.success(t("practice.started", { count: r.questionCount }));
      navigate(`/student/assessments/${r.assessmentId}`);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const { plan, items } = data;
  const today = items.length ? todayKey() : "";
  const days = [...new Set(items.map((i) => i.dayKey))];
  const visible = items.filter((i) => i.status === "TODO" || i.dayKey >= today);
  return (
    <Panel title={t("plan.title")}>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t("plan.intro")}</p>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">
          {t("plan.minutes")}
          <Input type="number" min={10} max={180} step={5} className="mt-1 w-28" value={minutes} onChange={(e) => setMinutes(Math.max(10, Math.min(180, Number(e.target.value) || 10)))} />
        </label>
        <Button size="sm" disabled={create.isPending} onClick={() => create.mutate({ groupId, dailyMinutes: minutes })}>{plan ? t("plan.rebuild") : t("plan.create")}</Button>
        {plan && <Button size="sm" variant="outline" disabled={finish.isPending} onClick={() => finish.mutate({ planId: plan.id })}>{t("plan.completePlan")}</Button>}
        <label className="ml-auto flex items-center gap-2 text-sm">
          <Switch checked={data.settings.reminders} disabled={save.isPending} onCheckedChange={(reminders) => save.mutate({ groupId, reminders })} />
          {t("plan.reminders")}
        </label>
      </div>
      {!plan ? (
        <p className="text-sm text-muted-foreground">{t("plan.none")}</p>
      ) : (
        <>
          <p className="mb-3 text-sm">{t(`plan.target.${plan.targetSource as PlanTargetSource}`, { date: fmtDayKeyShort(plan.targetDay) })}</p>
          {!items.length && <p className="text-sm text-muted-foreground">{t("plan.emptyTopics")}</p>}
          <ol className="space-y-4">
            {days
              .filter((d) => visible.some((i) => i.dayKey === d))
              .map((d) => {
                const dayItems = visible.filter((i) => i.dayKey === d);
                return (
                  <li key={d}>
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-sm font-medium">
                      <span>{d === today ? t("plan.today") : d < today ? t("plan.overdue") : fmtDayKeyShort(d)}</span>
                      <span className="text-xs text-muted-foreground">{t("plan.dayTotal", { minutes: dayItems.reduce((s, i) => s + i.minutes, 0) })}</span>
                    </div>
                    <ul className="divide-y rounded-xl border border-border">
                      {dayItems.map((item) => (
                        <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className={`min-w-0 break-words ${item.status !== "TODO" ? "text-muted-foreground line-through" : ""}`}>
                            {t(`plan.kind.${item.kind as PlanItemKind}`, { topic: item.label })}
                            {item.rolloverCount > 0 && <span className="ml-2 text-xs text-muted-foreground no-underline">({t("plan.rolled", { count: item.rolloverCount })})</span>}
                          </span>
                          {item.status === "DONE" ? (
                            <span className="inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-4 w-4" aria-hidden />{t("plan.doneLabel")}</span>
                          ) : item.status === "SKIPPED" ? (
                            <span className="text-xs text-muted-foreground">{t("plan.skipped")}</span>
                          ) : (
                            <span className="flex flex-wrap gap-2">
                              {item.kind === "MATERIAL" && (
                                <Button size="sm" variant="ghost" asChild>
                                  <Link href="/student/materials"><Link2 className="mr-1 h-4 w-4" aria-hidden />{t("plan.openMaterials")}</Link>
                                </Button>
                              )}
                              {item.kind === "PRACTICE" && data.selfPractice && (
                                <Button size="sm" variant="outline" disabled={practice.isPending} onClick={() => practice.mutate({ groupId, topicKey: item.topicKey, itemId: item.id })}>
                                  {t("plan.startPractice")}
                                </Button>
                              )}
                              <Button size="sm" disabled={done.isPending} onClick={() => done.mutate({ itemId: item.id })}>{t("plan.done")}</Button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
          </ol>
        </>
      )}
    </Panel>
  );
}

/** Today's day key in Baku, matching the server's plan days. */
function todayKey() {
  return new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
}
