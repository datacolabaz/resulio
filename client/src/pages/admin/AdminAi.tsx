import { ErrorNote, Loading, Panel, StatCard } from "@/components/AppShell";
import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { errorText, fmtCompact, fmtDateTime, fmtDay, fmtNumber, fmtUsd } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { AI_CALL_STATUSES, AI_FEATURES, AI_PRICE_FALLBACK_MODEL, BAKU_OFFSET_MS, periodStart, type AiCallStatus, type AiFeature } from "@shared/aiUsage";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { NoAccess, parseOptionalNumber, SettingsLink, UsageBar, useAdmin } from "./adminShared";

const fieldLabel = "text-sm text-foreground-secondary";
const selectClass = "h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground sm:w-auto";
const STATUS_TONE: Record<AiCallStatus, Tone> = { OK: "success", ERROR: "danger", RATE_LIMITED: "warning" };

const featureLabel = (f: string) => ((AI_FEATURES as readonly string[]).includes(f) ? t(`admin.ai.feature.${f as AiFeature}`) : f);
const percent = (ratio: number | null | undefined) => fmtNumber((ratio ?? 0) * 100);

/** The last 30 Baku calendar days, oldest first, so days without requests still get a (zero) bar. */
function last30Days(now = new Date()) {
  const today = periodStart("day", now).getTime();
  return Array.from({ length: 30 }, (_, i) => new Date(today - (29 - i) * 86_400_000 + BAKU_OFFSET_MS).toISOString().slice(0, 10));
}
const dayDate = (day: string) => new Date(`${day}T12:00:00Z`);

type Totals = { requests: number; tokens: number; costUsd: number };

function BreakdownTable({ title, rows, label }: { title: string; rows: Array<Totals & { key: string }>; label: (key: string) => string }) {
  const max = Math.max(...rows.map((r) => r.costUsd || r.tokens), 0);
  return (
    <Panel title={title}>
      {!rows.length ? (
        <p className="text-sm text-muted-foreground">{t("admin.ai.noData")}</p>
      ) : (
        <ul className="space-y-3 text-sm">
          {rows.map((r) => (
            <li key={r.key} className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 break-words font-medium">{label(r.key)}</span>
                <span className="tabular-nums">{fmtUsd(r.costUsd)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${max ? ((r.costUsd || r.tokens) / max) * 100 : 0}%` }} />
              </div>
              <div className="text-xs text-muted-foreground">{t("admin.dash.aiTotals", { tokens: fmtCompact(r.tokens), requests: fmtNumber(r.requests) })}</div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function DailyChart({ daily }: { daily: Array<Totals & { day: string }> }) {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const days = last30Days();
  const values = days.map((day) => byDay.get(day) ?? { day, requests: 0, tokens: 0, costUsd: 0 });
  const useCost = values.some((v) => v.costUsd > 0);
  const max = Math.max(...values.map((v) => (useCost ? v.costUsd : v.tokens)), 0);
  return (
    <Panel title={t("admin.ai.daily")}>
      <div className="flex h-36 items-end gap-0.5 sm:gap-1" role="img" aria-label={t("admin.ai.daily")}>
        {values.map((v) => {
          const value = useCost ? v.costUsd : v.tokens;
          const height = max ? Math.max((value / max) * 100, value > 0 ? 3 : 0) : 0;
          return (
            <div
              key={v.day}
              className="flex h-full min-w-0 flex-1 items-end rounded-sm bg-muted/50"
              title={`${fmtDay(dayDate(v.day))}: ${fmtUsd(v.costUsd)} · ${fmtCompact(v.tokens)}`}
            >
              <div className="w-full rounded-sm bg-primary" style={{ height: `${height}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>{fmtDay(dayDate(days[0]))}</span>
        <span>{fmtDay(dayDate(days[days.length - 1]))}</span>
      </div>
    </Panel>
  );
}

export function AiAnalyticsPage() {
  const { can } = useAdmin();
  const data = trpc.admin.ai.analytics.useQuery(undefined, { enabled: can("ai.view") });
  if (!can("ai.view")) return <NoAccess />;
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <Loading />;
  const d = data.data;
  const b = d.budget;
  const over = b.ratio !== null && b.ratio >= 1;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">{t("admin.nav.aiUsage")}</h1>
      {!d.provider.configured && <p className="rounded-xl bg-warning-surface p-3 text-sm text-warning">{t("admin.ai.notConfigured")}</p>}
      <Panel title={t("admin.ai.spendTitle")}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-3xl font-semibold tabular-nums">{fmtUsd(b.spentUsd)}</div>
            <div className="mt-1 text-sm text-muted-foreground">
              {t("admin.ai.projected", { amount: fmtUsd(b.projectedUsd) })} · {t("admin.ai.previousMonth", { amount: fmtUsd(d.previousMonthCostUsd) })}
            </div>
          </div>
          {over && <StatusBadge tone="danger">{t("admin.ai.overBudget")}</StatusBadge>}
        </div>
        {b.budgetUsd ? (
          <div className="mt-4 space-y-1.5">
            <UsageBar ratio={b.ratio} label={t("admin.ai.budgetUsed", { percent: percent(b.ratio) })} />
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>{t("admin.dash.ofLimit", { used: fmtUsd(b.spentUsd), limit: fmtUsd(b.budgetUsd) })} · {t("admin.ai.budgetUsed", { percent: percent(b.ratio) })}</span>
              <span>{t("admin.ai.resets", { date: fmtDay(b.resetsAt) })}</span>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">{t("admin.dash.noBudget")}</p>
        )}
        <p className="mt-4 text-xs text-muted-foreground">{t("admin.ai.noBalanceNote")}</p>
        {can("ai.manage") && (
          <div className="mt-4 border-t pt-4">
            <SettingsLink />
          </div>
        )}
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t("admin.common.requests")} value={fmtNumber(d.month.requests)} />
        <StatCard
          label={t("admin.common.tokens")}
          value={fmtCompact(d.month.tokens)}
          hint={t("admin.ai.inputOutput", { input: fmtCompact(d.month.promptTokens), output: fmtCompact(d.month.tokens - d.month.promptTokens) })}
        />
        <StatCard label={t("admin.ai.errors")} value={fmtNumber(d.month.errors)} hint={`${t("admin.ai.rateLimited")}: ${fmtNumber(d.month.rateLimited)}`} />
        <StatCard label={t("admin.ai.avgLatency")} value={`${fmtNumber(d.month.avgLatencyMs / 1000, 1)} s`} />
      </div>
      {d.month.estimated > 0 && <p className="text-xs text-muted-foreground">{t("admin.ai.estimatedRows", { count: fmtNumber(d.month.estimated) })}</p>}

      <DailyChart daily={d.daily} />

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownTable title={t("admin.ai.byFeature")} rows={d.byFeature.map((r) => ({ ...r, key: r.feature }))} label={featureLabel} />
        <BreakdownTable title={t("admin.ai.byModel")} rows={d.byModel.map((r) => ({ ...r, key: r.model }))} label={(m) => m} />
      </div>

      <Panel title={t("admin.ai.topUsers")}>
        {!d.topUsers.length ? (
          <p className="text-sm text-muted-foreground">{t("admin.ai.noData")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-3">{t("admin.ai.col.user")}</th>
                  <th scope="col" className="pr-3 text-right">{t("admin.common.requests")}</th>
                  <th scope="col" className="pr-3 text-right">{t("admin.common.tokens")}</th>
                  <th scope="col" className="text-right">{t("admin.ai.col.cost")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {d.topUsers.map((u) => (
                  <tr key={u.userId ?? "system"}>
                    <td className="py-2 pr-3">
                      <span className="block break-words font-medium">{u.name ?? (u.userId ? `#${u.userId}` : t("admin.common.system"))}</span>
                      {u.email && <span className="block break-all text-xs text-muted-foreground">{u.email}</span>}
                    </td>
                    <td className="pr-3 text-right tabular-nums">{fmtNumber(u.requests)}</td>
                    <td className="pr-3 text-right tabular-nums">{fmtCompact(u.tokens)}</td>
                    <td className="text-right tabular-nums">{fmtUsd(u.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {d.provider.models.length > 0 && <p className="break-words text-xs text-muted-foreground">{t("admin.ai.models", { models: d.provider.models.join(", ") })}</p>}
    </div>
  );
}

const PAGE_SIZE = 50;

function LogPage({ before, feature, status, last, onMore }: { before?: number; feature?: AiFeature; status?: AiCallStatus; last: boolean; onMore: (cursor: number) => void }) {
  const page = trpc.admin.ai.logs.useQuery({ before, limit: PAGE_SIZE, feature, status });
  if (page.error) return <tbody><tr><td colSpan={7} className="py-3"><ErrorNote error={page.error} /></td></tr></tbody>;
  if (!page.data) return <tbody><tr><td colSpan={7}><Loading /></td></tr></tbody>;
  const rows = page.data;
  return (
    <tbody className="divide-y border-b">
      {rows.map((r) => (
        <tr key={r.id} className="align-top">
          <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{fmtDateTime(r.createdAt)}</td>
          <td className="max-w-[14rem] pr-3">
            <span className="block truncate" title={r.userEmail ?? undefined}>{r.userName ?? (r.userId ? `#${r.userId}` : t("admin.common.system"))}</span>
          </td>
          <td className="pr-3">{featureLabel(r.feature)}</td>
          <td className="max-w-[12rem] truncate pr-3 text-muted-foreground" title={r.model}>{r.model}</td>
          <td className="whitespace-nowrap pr-3 text-right tabular-nums">
            {fmtNumber(r.totalTokens)}
            {r.tokensEstimated && <span className="ml-1 text-xs text-muted-foreground">({t("admin.common.estimated")})</span>}
          </td>
          <td className="pr-3 text-right tabular-nums">{fmtUsd(r.costUsd)}</td>
          <td className="whitespace-nowrap">
            <StatusBadge tone={STATUS_TONE[r.status as AiCallStatus] ?? "neutral"}>{t(`admin.ai.status.${r.status as AiCallStatus}`)}</StatusBadge>
            <span className="ml-2 text-xs text-muted-foreground">{fmtNumber(r.latencyMs / 1000, 1)} s</span>
          </td>
        </tr>
      ))}
      {!rows.length && before === undefined && (
        <tr><td colSpan={7} className="py-3 text-muted-foreground">{t("admin.ai.logs.empty")}</td></tr>
      )}
      {last && rows.length === PAGE_SIZE && (
        <tr>
          <td colSpan={7} className="py-3 text-center">
            <Button variant="outline" size="sm" onClick={() => onMore(rows[rows.length - 1].id)}>{t("admin.common.loadMore")}</Button>
          </td>
        </tr>
      )}
    </tbody>
  );
}

export function AiLogsPage() {
  const { can } = useAdmin();
  const [feature, setFeature] = useState<AiFeature | "">("");
  const [status, setStatus] = useState<AiCallStatus | "">("");
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  if (!can("ai.view")) return <NoAccess />;
  const filters = { feature: feature || undefined, status: status || undefined };

  return (
    <Panel title={t("admin.nav.aiLogs")}>
      <p className="mb-3 text-xs text-muted-foreground">{t("admin.ai.logs.retention")}</p>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <select
          aria-label={t("admin.ai.col.feature")}
          className={selectClass}
          value={feature}
          onChange={(e) => { setFeature(e.target.value as AiFeature | ""); setCursors([undefined]); }}
        >
          <option value="">{t("admin.ai.logs.allFeatures")}</option>
          {AI_FEATURES.map((f) => <option key={f} value={f}>{featureLabel(f)}</option>)}
        </select>
        <select
          aria-label={t("admin.ai.col.status")}
          className={selectClass}
          value={status}
          onChange={(e) => { setStatus(e.target.value as AiCallStatus | ""); setCursors([undefined]); }}
        >
          <option value="">{t("admin.ai.logs.allStatuses")}</option>
          {AI_CALL_STATUSES.map((s) => <option key={s} value={s}>{t(`admin.ai.status.${s}`)}</option>)}
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-3">{t("admin.ai.col.when")}</th>
              <th scope="col" className="pr-3">{t("admin.ai.col.user")}</th>
              <th scope="col" className="pr-3">{t("admin.ai.col.feature")}</th>
              <th scope="col" className="pr-3">{t("admin.ai.col.model")}</th>
              <th scope="col" className="pr-3 text-right">{t("admin.ai.col.tokens")}</th>
              <th scope="col" className="pr-3 text-right">{t("admin.ai.col.cost")}</th>
              <th scope="col">{t("admin.ai.col.status")}</th>
            </tr>
          </thead>
          {cursors.map((before, i) => (
            <LogPage
              key={`${feature}:${status}:${before ?? "first"}`}
              before={before}
              {...filters}
              last={i === cursors.length - 1}
              onMore={(cursor) => setCursors((c) => [...c, cursor])}
            />
          ))}
        </table>
      </div>
    </Panel>
  );
}

type PriceDraft = { model: string; input: string; output: string; note: string; existing: boolean };

function PriceDialog({ draft, onClose }: { draft: PriceDraft | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<PriceDraft | null>(draft);
  useEffect(() => setForm(draft), [draft]);
  const save = trpc.admin.ai.setPrice.useMutation({
    onSuccess: () => {
      toast.success(t("admin.common.saved"));
      void utils.admin.ai.prices.invalidate();
      onClose();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const input = form ? parseOptionalNumber(form.input) : null;
  const output = form ? parseOptionalNumber(form.output) : null;
  const valid = !!form && form.model.trim().length > 0 && typeof input === "number" && Number.isFinite(input) && typeof output === "number" && Number.isFinite(output);
  const set = (patch: Partial<PriceDraft>) => setForm((f) => (f ? { ...f, ...patch } : f));
  return (
    <Dialog open={draft !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{draft?.existing ? draft.model : t("admin.pricing.add")}</DialogTitle>
          <DialogDescription>{t("admin.pricing.outputHint")}</DialogDescription>
        </DialogHeader>
        {form && (
          <form
            id="price-form"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) save.mutate({ model: form.model.trim(), inputUsdPerMillion: input as number, outputUsdPerMillion: output as number, note: form.note });
            }}
          >
            {!form.existing && (
              <label className="block">
                <span className={fieldLabel}>{t("admin.pricing.model")}</span>
                <Input className="mt-1" value={form.model} maxLength={120} onChange={(e) => set({ model: e.target.value })} />
              </label>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={fieldLabel}>{t("admin.pricing.input")}</span>
                <Input className="mt-1" inputMode="decimal" value={form.input} onChange={(e) => set({ input: e.target.value })} />
              </label>
              <label className="block">
                <span className={fieldLabel}>{t("admin.pricing.output")}</span>
                <Input className="mt-1" inputMode="decimal" value={form.output} onChange={(e) => set({ output: e.target.value })} />
              </label>
            </div>
            <label className="block">
              <span className={fieldLabel}>{t("admin.pricing.noteLabel")}</span>
              <Input className="mt-1" value={form.note} maxLength={255} onChange={(e) => set({ note: e.target.value })} />
            </label>
          </form>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" form="price-form" disabled={!valid || save.isPending}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AiPricingPage() {
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const data = trpc.admin.ai.prices.useQuery(undefined, { enabled: can("ai.view") });
  const [draft, setDraft] = useState<PriceDraft | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = trpc.admin.ai.deletePrice.useMutation({
    onSuccess: () => {
      toast.success(t("admin.pricing.deleted"));
      void utils.admin.ai.prices.invalidate();
      setDeleting(null);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!can("ai.view")) return <NoAccess />;
  const manage = can("ai.manage");
  const configured = new Set((data.data?.configuredModels ?? []).map((m) => m.toLowerCase()));

  return (
    <div className="space-y-5">
      <Panel
        title={t("admin.nav.aiPricing")}
        action={manage && (
          <Button size="sm" onClick={() => setDraft({ model: "", input: "", output: "", note: "", existing: false })}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("admin.pricing.add")}
          </Button>
        )}
      >
        <p className="mb-4 text-sm text-muted-foreground">{t("admin.pricing.note")}</p>
        {data.error ? <ErrorNote error={data.error} /> : !data.data ? <Loading /> : (
          <>
            {data.data.unpricedModels.length > 0 && (
              <p className="mb-4 rounded-xl bg-warning-surface p-3 text-sm text-warning">{t("admin.pricing.unpriced", { models: data.data.unpricedModels.join(", ") })}</p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-2 pr-3">{t("admin.pricing.model")}</th>
                    <th scope="col" className="pr-3 text-right">{t("admin.pricing.input")}</th>
                    <th scope="col" className="pr-3 text-right">{t("admin.pricing.output")}</th>
                    <th scope="col" className="pr-3">{t("admin.pricing.noteLabel")}</th>
                    {manage && <th scope="col"><span className="sr-only">{t("common.edit")}</span></th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.data.prices.map((p) => (
                    <tr key={p.model} className="align-top">
                      <td className="py-2 pr-3">
                        <span className="block break-all font-medium">{p.model}</span>
                        {p.model === AI_PRICE_FALLBACK_MODEL && <span className="block text-xs text-muted-foreground">{t("admin.pricing.fallback")}</span>}
                        {configured.has(p.model) && <StatusBadge tone="info" className="mt-1">{t("admin.pricing.inUse")}</StatusBadge>}
                      </td>
                      <td className="pr-3 text-right tabular-nums">{fmtUsd(p.inputUsdPerMillion)}</td>
                      <td className="pr-3 text-right tabular-nums">{fmtUsd(p.outputUsdPerMillion)}</td>
                      <td className="max-w-xs break-words pr-3 text-xs text-muted-foreground">{p.note || "—"}</td>
                      {manage && (
                        <td className="whitespace-nowrap text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`${t("common.edit")}: ${p.model}`}
                            onClick={() => setDraft({ model: p.model, input: String(p.inputUsdPerMillion), output: String(p.outputUsdPerMillion), note: p.note, existing: true })}
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                          </Button>
                          {p.model !== AI_PRICE_FALLBACK_MODEL && (
                            <Button variant="ghost" size="sm" className="text-destructive" aria-label={`${t("common.delete")}: ${p.model}`} onClick={() => setDeleting(p.model)}>
                              <Trash2 className="h-4 w-4" aria-hidden />
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
      <PriceDialog draft={draft} onClose={() => setDraft(null)} />
      <Dialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{`${t("common.delete")}: ${deleting ?? ""}`}</DialogTitle>
            <DialogDescription>{t("admin.pricing.fallback")}: {AI_PRICE_FALLBACK_MODEL}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate({ model: deleting })}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
