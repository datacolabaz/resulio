import { useAuth } from "@/_core/hooks/useAuth";
import { AppShell, LanguageSwitch, Loading, Panel, Pill, THEME_OPTIONS } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { themeLabel, useTheme } from "@/contexts/ThemeContext";
import { useI18n } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { availableContexts, canEnter, CONTEXT_HOME, contextLabel } from "@/lib/contexts";
import { errorText, partnerStatusLabel, providerLabel, subscriptionLabel } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { Check } from "lucide-react";
import { Link, Redirect } from "wouter";

const linkClass = "font-medium text-link underline underline-offset-4";

export default function SettingsPage() {
  const { user, loading, logout } = useAuth();
  const { locale } = useI18n();
  const { preference, theme, setPreference } = useTheme();
  const utils = trpc.useUtils();
  const apply = trpc.partner.requestProfile.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  if (loading) return <Loading />;
  if (!user) return <Redirect to="/?returnTo=/settings" />;
  const area = user.lastActiveContext && canEnter(user, user.lastActiveContext) ? user.lastActiveContext : undefined;
  const contexts = availableContexts(user);
  return (
    <AppShell area={area} title={t("nav.settings")}>
      <div className="grid max-w-3xl gap-5">
        <Panel title={t("settings.profile")}>
          <div className="flex items-center gap-4">
            {user.avatarUrl && <img src={user.avatarUrl} alt="" className="h-14 w-14 rounded-full" referrerPolicy="no-referrer" />}
            <div className="min-w-0">
              <div className="break-words font-semibold">{user.name}</div>
              <div className="break-all text-sm text-muted-foreground">{user.email}</div>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t("settings.profileNote")}</p>
        </Panel>

        <Panel title={t("settings.mySpaces")}>
          {contexts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.noSpaces")} <Link href="/welcome" className={linkClass}>{t("settings.getStarted")}</Link></p>
          ) : (
            <ul className="divide-y text-sm">
              {contexts.map((c) => (
                <li key={c} className="flex items-center justify-between py-2">
                  <span>{contextLabel(c)}</span>
                  <Link href={CONTEXT_HOME[c]} className={linkClass}>{t("common.open")}</Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={t("settings.workspaces")} action={<Link href="/welcome" className={`text-sm ${linkClass}`}>{t("common.new")}</Link>}>
          {user.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.noWorkspaces")}</p>
          ) : (
            <ul className="divide-y text-sm">
              {user.workspaces.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="break-words font-medium">{w.title}</div>
                    <div className="text-xs text-muted-foreground">{providerLabel(w.providerType)}{w.publicDisplayName ? ` · ${w.publicDisplayName}` : ""}</div>
                  </div>
                  <Pill className="shrink-0">{subscriptionLabel(w.subscriptionStatus)}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={t("settings.partner")}>
          {user.partnerStatus ? (
            <p className="text-sm">
              {t("settings.partnerStatus", { status: partnerStatusLabel(user.partnerStatus) })}
              {user.partnerStatus === "APPROVED" && <> · <Link href="/partner" className={linkClass}>{t("settings.partnerPanel")}</Link></>}
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t("settings.partnerPitch")}</p>
              <Button variant="outline" disabled={apply.isPending} onClick={() => apply.mutate()}>{t("settings.partnerApply")}</Button>
              {apply.error && <p role="alert" className="text-sm text-destructive">{errorText(apply.error)}</p>}
            </div>
          )}
        </Panel>

        <Panel title={t("theme.heading")}>
          <fieldset>
            <legend className="sr-only">{t("theme.heading")}</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {THEME_OPTIONS.map(({ value, icon: Icon }) => {
                const selected = preference === value;
                return (
                  <label
                    key={value}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${selected ? "border-link bg-info-surface font-semibold text-foreground ring-1 ring-link" : "border-input bg-card text-foreground hover:bg-muted"}`}
                  >
                    <input type="radio" name="theme-preference" value={value} checked={selected} onChange={() => setPreference(value)} className="sr-only" />
                    <Icon className={`h-5 w-5 shrink-0 ${selected ? "text-link" : "text-muted-foreground"}`} aria-hidden />
                    <span className="flex-1">{themeLabel(value)}</span>
                    {selected && <Check className="h-4 w-4 text-link" aria-hidden />}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
            {preference === "system"
              ? t("settings.themeSystemActive", { mode: themeLabel(theme).toLocaleLowerCase(locale) })
              : t("settings.themeSaved")}
          </p>
        </Panel>

        <Panel title={t("language.heading")}>
          <LanguageSwitch />
        </Panel>
        <Panel title={t("settings.session")}>
          <Button variant="outline" onClick={() => void logout()}>{t("common.logout")}</Button>
        </Panel>
      </div>
    </AppShell>
  );
}
