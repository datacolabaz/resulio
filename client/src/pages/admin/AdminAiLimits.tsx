import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { errorText, fmtCompact, fmtDateTime, fmtNumber, fmtUsd } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { formatFileSize } from "@/lib/uploadFile";
import { AI_LIMIT_WARN_RATIO, type LimitValue } from "@shared/aiUsage";
import { Pencil, RotateCcw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { NoAccess, parseOptionalNumber, SettingsLink, UsageBar, useAdmin } from "./adminShared";

type Mode = "default" | "unlimited" | "custom";
const modeOf = (v: LimitValue): Mode => (v === null ? "default" : v === 0 ? "unlimited" : "custom");

function LimitField({ label, mode, value, onMode, onValue, defaultText }: { label: string; mode: Mode; value: string; onMode: (m: Mode) => void; onValue: (v: string) => void; defaultText: string }) {
  const name = useId();
  const options: Array<[Mode, string]> = [
    ["default", `${t("admin.limits.mode.default")} (${defaultText})`],
    ["unlimited", t("admin.limits.mode.unlimited")],
    ["custom", t("admin.limits.mode.custom")],
  ];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      {options.map(([m, text]) => (
        <label key={m} className="flex items-center gap-2 text-sm">
          <input type="radio" name={name} checked={mode === m} onChange={() => onMode(m)} className="accent-primary" />
          <span className="min-w-0 break-words">{text}</span>
        </label>
      ))}
      {mode === "custom" && <Input inputMode="numeric" aria-label={label} value={value} onChange={(e) => onValue(e.target.value)} className="w-full sm:w-48" />}
    </fieldset>
  );
}

type TeacherRow = {
  id: number;
  name: string | null;
  email: string | null;
  override: { monthlyTokenQuota: LimitValue; dailyRequestCap: LimitValue; usageResetAt: Date | null } | null;
};

function EditLimitsDialog({ teacher, defaults, onClose }: { teacher: TeacherRow | null; defaults: { monthlyTokenQuota: LimitValue; dailyRequestCap: LimitValue }; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [monthMode, setMonthMode] = useState<Mode>("default");
  const [dayMode, setDayMode] = useState<Mode>("default");
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  useEffect(() => {
    const o = teacher?.override;
    setMonthMode(modeOf(o?.monthlyTokenQuota ?? null));
    setDayMode(modeOf(o?.dailyRequestCap ?? null));
    setMonth(o?.monthlyTokenQuota ? String(o.monthlyTokenQuota) : "");
    setDay(o?.dailyRequestCap ? String(o.dailyRequestCap) : "");
  }, [teacher]);
  const save = trpc.admin.ai.setTeacherLimit.useMutation({
    onSuccess: () => {
      toast.success(t("admin.limits.saved"));
      void utils.admin.ai.teachers.invalidate();
      onClose();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const resolve = (mode: Mode, text: string): number | null | "invalid" => {
    if (mode === "default") return null;
    if (mode === "unlimited") return 0;
    const v = parseOptionalNumber(text);
    return v !== null && Number.isInteger(v) && v > 0 ? v : "invalid";
  };
  const monthValue = resolve(monthMode, month);
  const dayValue = resolve(dayMode, day);
  const valid = monthValue !== "invalid" && dayValue !== "invalid";
  const defaultText = (v: LimitValue, unit: (n: string) => string) => (v ? unit(fmtNumber(v)) : t("admin.common.unlimited"));

  return (
    <Dialog open={teacher !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.limits.editTitle", { name: teacher?.name ?? teacher?.email ?? "" })}</DialogTitle>
          <DialogDescription className="break-all">{teacher?.email}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <LimitField
            label={t("admin.limits.monthlyTokens")}
            mode={monthMode}
            value={month}
            onMode={setMonthMode}
            onValue={setMonth}
            defaultText={defaultText(defaults.monthlyTokenQuota, (value) => t("admin.limits.perMonth", { value }))}
          />
          <LimitField
            label={t("admin.limits.dailyActions")}
            mode={dayMode}
            value={day}
            onMode={setDayMode}
            onValue={setDay}
            defaultText={defaultText(defaults.dailyRequestCap, (value) => t("admin.limits.perDay", { value }))}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            disabled={!valid || save.isPending}
            onClick={() => teacher && valid && save.mutate({ userId: teacher.id, monthlyTokenQuota: monthValue as number | null, dailyRequestCap: dayValue as number | null })}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AiLimitsPage() {
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<TeacherRow | null>(null);
  const [resetting, setResetting] = useState<TeacherRow | null>(null);
  const data = trpc.admin.ai.teachers.useQuery({ query: query.trim() || undefined }, { enabled: can("ai.view"), placeholderData: (prev) => prev });
  const reset = trpc.admin.ai.resetTeacherUsage.useMutation({
    onSuccess: () => {
      toast.success(t("admin.limits.resetDone"));
      void utils.admin.ai.teachers.invalidate();
      setResetting(null);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!can("ai.view")) return <NoAccess />;
  const manage = can("ai.manage");
  const defaults = data.data?.defaults ?? { monthlyTokenQuota: null, dailyRequestCap: null };

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">{t("admin.nav.teacherQuotas")}</h1>
      <Panel title={t("admin.limits.defaults")}>
        <p className="mb-3 text-sm text-muted-foreground">{t("admin.limits.semantics")}</p>
        <p className="text-sm">
          {t("admin.limits.monthlyTokens")}: {defaults.monthlyTokenQuota ? fmtNumber(defaults.monthlyTokenQuota) : t("admin.common.unlimited")} ·{" "}
          {t("admin.limits.dailyActions")}: {defaults.dailyRequestCap ? fmtNumber(defaults.dailyRequestCap) : t("admin.common.unlimited")}
        </p>
        {manage && (
          <div className="mt-3">
            <SettingsLink />
          </div>
        )}
      </Panel>

      <Panel title={t("admin.nav.teachers")}>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("admin.limits.search")} aria-label={t("admin.limits.search")} />
        {data.error ? <ErrorNote error={data.error} /> : !data.data ? <Loading /> : (
          <ul className="mt-3 divide-y text-sm">
            {data.data.teachers.map((row) => {
              const monthLimit = row.effective.monthlyTokenQuota;
              const dayLimit = row.effective.dailyRequestCap;
              const dayRatio = dayLimit ? row.todayOperations / dayLimit : null;
              const worst = Math.max(row.monthRatio ?? 0, dayRatio ?? 0);
              return (
                <li key={row.id} className="grid gap-3 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-words font-medium">{row.name ?? "—"}</span>
                      {worst >= 1 ? (
                        <StatusBadge tone="danger">{t("admin.limits.over")}</StatusBadge>
                      ) : worst >= AI_LIMIT_WARN_RATIO ? (
                        <StatusBadge tone="warning">{t("admin.limits.near")}</StatusBadge>
                      ) : null}
                    </div>
                    <div className="break-all text-xs text-muted-foreground">{row.email}</div>
                    <div className="text-xs text-muted-foreground">
                      {t("admin.ai.col.cost")}: {fmtUsd(row.costUsd)} · {t("admin.common.requests")}: {fmtNumber(row.requests)}
                    </div>
                    <div className="text-xs text-muted-foreground">{t("admin.limits.storage", { size: formatFileSize(row.storageBytes) })}</div>
                    {row.override?.usageResetAt && <div className="text-xs text-muted-foreground">{t("admin.limits.resetAt", { date: fmtDateTime(row.override.usageResetAt) })}</div>}
                  </div>
                  <div className="space-y-1">
                    <div className="flex flex-wrap justify-between gap-x-2 text-xs">
                      <span className="text-foreground-secondary">{t("admin.limits.usedMonth")}</span>
                      <span className="tabular-nums">
                        {monthLimit ? t("admin.dash.ofLimit", { used: fmtCompact(row.countedTokens), limit: fmtCompact(monthLimit) }) : `${fmtCompact(row.countedTokens)} · ${t("admin.common.unlimited")}`}
                      </span>
                    </div>
                    {monthLimit !== null && <UsageBar ratio={row.monthRatio} label={t("admin.limits.monthlyTokens")} />}
                    <div className="text-xs text-muted-foreground">
                      {row.override?.monthlyTokenQuota != null ? t("admin.limits.fromOverride") : t("admin.limits.fromDefault")}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex flex-wrap justify-between gap-x-2 text-xs">
                      <span className="text-foreground-secondary">{t("admin.limits.today")}</span>
                      <span className="tabular-nums">
                        {dayLimit ? t("admin.dash.ofLimit", { used: fmtNumber(row.todayOperations), limit: fmtNumber(dayLimit) }) : `${t("admin.limits.actionsToday", { count: fmtNumber(row.todayOperations) })} · ${t("admin.common.unlimited")}`}
                      </span>
                    </div>
                    {dayLimit !== null && <UsageBar ratio={dayRatio} label={t("admin.limits.dailyActions")} />}
                    <div className="text-xs text-muted-foreground">
                      {row.override?.dailyRequestCap != null ? t("admin.limits.fromOverride") : t("admin.limits.fromDefault")}
                    </div>
                  </div>
                  {manage && (
                    <div className="flex flex-wrap gap-2 md:justify-end">
                      <Button variant="outline" size="sm" onClick={() => setEditing(row)}>
                        <Pencil className="h-4 w-4" aria-hidden />
                        {t("admin.limits.edit")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setResetting(row)}>
                        <RotateCcw className="h-4 w-4" aria-hidden />
                        {t("admin.limits.reset")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
            {!data.data.teachers.length && <li className="py-3 text-muted-foreground">{t("admin.limits.empty")}</li>}
          </ul>
        )}
      </Panel>

      <EditLimitsDialog teacher={editing} defaults={defaults} onClose={() => setEditing(null)} />
      <Dialog open={resetting !== null} onOpenChange={(v) => !v && setResetting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.limits.reset")}</DialogTitle>
            <DialogDescription>{t("admin.limits.resetConfirm", { name: resetting?.name ?? resetting?.email ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetting(null)}>{t("common.cancel")}</Button>
            <Button disabled={reset.isPending} onClick={() => resetting && reset.mutate({ userId: resetting.id })}>{t("admin.limits.reset")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
