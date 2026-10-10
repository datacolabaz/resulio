import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import type { LimitValue } from "@shared/aiUsage";
import { DEFAULT_UPLOAD_LIMITS_MB, MAX_UPLOAD_LIMIT_MB, SIZE_CLASSES, type SizeClass } from "@shared/materialTemplates";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { GIB, isValidOptional, NoAccess, parseOptionalNumber, useAdmin } from "./adminShared";

const fieldLabel = "text-sm text-foreground-secondary";
const isWholeOrNull = (v: number | null) => isValidOptional(v) && (v === null || Number.isInteger(v));

function useSettingsSaved() {
  const utils = trpc.useUtils();
  return () => {
    toast.success(t("admin.common.saved"));
    void utils.admin.ai.settings.invalidate();
    void utils.admin.ai.analytics.invalidate();
    void utils.admin.ai.teachers.invalidate();
    void utils.admin.storage.summary.invalidate();
    void utils.admin.dashboard.invalidate();
  };
}

function BudgetEditor({ current, readOnly }: { current: number | null; readOnly: boolean }) {
  const id = useId();
  const saved = useSettingsSaved();
  const [text, setText] = useState(current === null ? "" : String(current));
  useEffect(() => setText(current === null ? "" : String(current)), [current]);
  const value = parseOptionalNumber(text);
  const save = trpc.admin.ai.setSettings.useMutation({ onSuccess: saved, onError: (e) => toast.error(errorText(e)) });
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (isValidOptional(value)) save.mutate({ monthlyBudgetUsd: value });
      }}
    >
      <label htmlFor={id} className="w-full sm:w-auto">
        <span className={fieldLabel}>{t("admin.ai.budget")}</span>
        <Input id={id} inputMode="decimal" value={text} disabled={readOnly} onChange={(e) => setText(e.target.value)} placeholder={t("admin.settings.notSet")} className="mt-1 w-full sm:w-40" />
      </label>
      {!readOnly && <Button type="submit" disabled={!isValidOptional(value) || value === current || save.isPending}>{t("common.save")}</Button>}
      <p className="w-full text-xs text-muted-foreground">{t("admin.ai.budgetHint")}</p>
    </form>
  );
}

function DefaultsEditor({ defaults, readOnly }: { defaults: { monthlyTokenQuota: LimitValue; dailyRequestCap: LimitValue }; readOnly: boolean }) {
  const monthId = useId();
  const dayId = useId();
  const saved = useSettingsSaved();
  const show = (v: LimitValue) => (v ? String(v) : "");
  const [month, setMonth] = useState(show(defaults.monthlyTokenQuota));
  const [day, setDay] = useState(show(defaults.dailyRequestCap));
  useEffect(() => {
    setMonth(show(defaults.monthlyTokenQuota));
    setDay(show(defaults.dailyRequestCap));
  }, [defaults.monthlyTokenQuota, defaults.dailyRequestCap]);
  const monthValue = parseOptionalNumber(month);
  const dayValue = parseOptionalNumber(day);
  const valid = isWholeOrNull(monthValue) && isWholeOrNull(dayValue);
  const save = trpc.admin.ai.setSettings.useMutation({ onSuccess: saved, onError: (e) => toast.error(errorText(e)) });
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate({ defaultMonthlyTokenQuota: monthValue, defaultDailyRequestCap: dayValue });
      }}
    >
      <label htmlFor={monthId}>
        <span className={fieldLabel}>{t("admin.limits.monthlyTokens")}</span>
        <Input id={monthId} inputMode="numeric" value={month} disabled={readOnly} onChange={(e) => setMonth(e.target.value)} placeholder={t("admin.limits.emptyUnlimited")} className="mt-1" />
      </label>
      <label htmlFor={dayId}>
        <span className={fieldLabel}>{t("admin.limits.dailyActions")}</span>
        <Input id={dayId} inputMode="numeric" value={day} disabled={readOnly} onChange={(e) => setDay(e.target.value)} placeholder={t("admin.limits.emptyUnlimited")} className="mt-1" />
      </label>
      {!readOnly && <Button type="submit" disabled={!valid || save.isPending}>{t("common.save")}</Button>}
    </form>
  );
}

function SoftQuotaEditor({ current, readOnly }: { current: number | null; readOnly: boolean }) {
  const id = useId();
  const saved = useSettingsSaved();
  const show = (bytes: number | null) => (bytes ? String(Math.round((bytes / GIB) * 100) / 100) : "");
  const [text, setText] = useState(show(current));
  useEffect(() => setText(show(current)), [current]);
  const gb = parseOptionalNumber(text);
  const bytes = gb === null || !Number.isFinite(gb) ? gb : Math.round(gb * GIB);
  const save = trpc.admin.storage.setSoftQuota.useMutation({ onSuccess: saved, onError: (e) => toast.error(errorText(e)) });
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (isValidOptional(bytes)) save.mutate({ softQuotaBytes: bytes || null });
      }}
    >
      <label htmlFor={id} className="w-full sm:w-auto">
        <span className={fieldLabel}>{t("admin.storage.softQuota")}</span>
        <Input id={id} inputMode="decimal" value={text} disabled={readOnly} onChange={(e) => setText(e.target.value)} placeholder={t("admin.settings.notSet")} className="mt-1 w-full sm:w-40" />
      </label>
      {!readOnly && <Button type="submit" disabled={!isValidOptional(bytes) || save.isPending}>{t("common.save")}</Button>}
      <p className="w-full text-xs text-muted-foreground">{t("admin.storage.softQuotaHint")}</p>
    </form>
  );
}

type UploadLimits = Partial<Record<SizeClass, number>> | null;

function UploadLimitsEditor({ limits, quotaBytes, readOnly }: { limits: UploadLimits; quotaBytes: number | null; readOnly: boolean }) {
  const quotaId = useId();
  const saved = useSettingsSaved();
  const showLimits = (l: UploadLimits) => Object.fromEntries(SIZE_CLASSES.map((c) => [c, l?.[c] ? String(l[c]) : ""])) as Record<SizeClass, string>;
  const showGb = (bytes: number | null) => (bytes ? String(Math.round((bytes / GIB) * 100) / 100) : "");
  const [mb, setMb] = useState(showLimits(limits));
  const [quota, setQuota] = useState(showGb(quotaBytes));
  useEffect(() => setMb(showLimits(limits)), [limits]);
  useEffect(() => setQuota(showGb(quotaBytes)), [quotaBytes]);
  const values = SIZE_CLASSES.map((c) => [c, parseOptionalNumber(mb[c])] as const);
  const validMb = (v: number | null) => v === null || (Number.isInteger(v) && v >= 1 && v <= MAX_UPLOAD_LIMIT_MB);
  const limitsValid = values.every(([, v]) => validMb(v));
  const gb = parseOptionalNumber(quota);
  const bytes = gb === null || !Number.isFinite(gb) ? gb : Math.round(gb * GIB);
  const set = values.filter(([, v]) => v !== null);
  const save = trpc.admin.storage.setUploadLimits.useMutation({ onSuccess: saved, onError: (e) => toast.error(errorText(e)) });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (limitsValid && isValidOptional(bytes)) save.mutate({ materialUploadLimitsMb: set.length ? Object.fromEntries(set) : null, workspaceQuotaBytes: bytes || null });
      }}
    >
      <p className="text-sm text-muted-foreground">{t("admin.uploads.limitsIntro")}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {values.map(([c, v]) => (
          <label key={c} className="block">
            <span className={fieldLabel}>{t(`admin.uploads.class.${c}`)}</span>
            <Input
              inputMode="numeric"
              value={mb[c]}
              disabled={readOnly}
              onChange={(e) => setMb((prev) => ({ ...prev, [c]: e.target.value }))}
              placeholder={String(DEFAULT_UPLOAD_LIMITS_MB[c])}
              aria-invalid={!validMb(v)}
              className="mt-1"
            />
          </label>
        ))}
      </div>
      <label htmlFor={quotaId} className="block sm:w-64">
        <span className={fieldLabel}>{t("admin.uploads.quota")}</span>
        <Input id={quotaId} inputMode="decimal" value={quota} disabled={readOnly} onChange={(e) => setQuota(e.target.value)} placeholder={t("admin.settings.notSet")} className="mt-1" />
      </label>
      <p className="text-xs text-muted-foreground">{t("admin.uploads.quotaHint")}</p>
      {!readOnly && <Button type="submit" disabled={!limitsValid || !isValidOptional(bytes) || save.isPending}>{t("common.save")}</Button>}
    </form>
  );
}

/** Platform-wide values kept in `platform_settings`. Secrets never live here — only in the environment. */
export default function AdminSettingsPage() {
  const { can } = useAdmin();
  const aiView = can("ai.view");
  const storageView = can("storage.view");
  const settings = trpc.admin.ai.settings.useQuery(undefined, { enabled: aiView });
  const storage = trpc.admin.storage.summary.useQuery(undefined, { enabled: storageView && !aiView });
  if (!aiView && !storageView) return <NoAccess />;
  const error = settings.error ?? storage.error;
  if (error) return <ErrorNote error={error} />;
  const s = settings.data;
  if (aiView ? !s : !storage.data) return <Loading />;
  const softQuota = s ? s["storage.softQuotaBytes"] : (storage.data?.softQuotaBytes ?? null);
  const uploadLimits = s ? s["storage.materialUploadLimitsMb"] : (storage.data?.materialUploadLimitsMb ?? null);
  const workspaceQuota = s ? s["storage.workspaceQuotaBytes"] : (storage.data?.workspaceQuotaBytes ?? null);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("admin.nav.settings")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t("admin.settings.intro")}</p>
      </div>
      {s && (
        <>
          <Panel title={t("admin.settings.budgetTitle")}>
            <BudgetEditor current={s["ai.monthlyBudgetUsd"]} readOnly={!can("ai.manage")} />
            <p className="mt-3 text-xs text-muted-foreground">{t("admin.ai.noBalanceNote")}</p>
          </Panel>
          <Panel title={t("admin.limits.defaults")}>
            <p className="mb-4 text-sm text-muted-foreground">{t("admin.limits.semantics")}</p>
            <DefaultsEditor
              defaults={{ monthlyTokenQuota: s["ai.defaultMonthlyTokenQuota"], dailyRequestCap: s["ai.defaultDailyRequestCap"] }}
              readOnly={!can("ai.manage")}
            />
          </Panel>
        </>
      )}
      {storageView && (
        <Panel title={t("admin.settings.storageTitle")}>
          <SoftQuotaEditor current={softQuota} readOnly={!can("storage.manage")} />
        </Panel>
      )}
      {storageView && (
        <Panel title={t("admin.settings.uploadsTitle")}>
          <UploadLimitsEditor limits={uploadLimits} quotaBytes={workspaceQuota} readOnly={!can("storage.manage")} />
        </Panel>
      )}
    </div>
  );
}
