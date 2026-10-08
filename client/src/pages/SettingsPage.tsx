import { useAuth } from "@/_core/hooks/useAuth";
import { AppShell, LanguageSwitch, Loading, Panel, Pill, THEME_OPTIONS } from "@/components/AppShell";
import { authErrorText, PasswordField } from "@/components/EmailSignIn";
import { Button } from "@/components/ui/button";
import { startLogin } from "@/const";
import { themeLabel, useTheme } from "@/contexts/ThemeContext";
import { useI18n } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { availableContexts, canEnter, CONTEXT_HOME, contextLabel } from "@/lib/contexts";
import { errorText, partnerStatusLabel, providerLabel, subscriptionLabel } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { PASSWORD_MIN_LENGTH } from "@shared/auth";
import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link, Redirect } from "wouter";

const linkClass = "font-medium text-link underline underline-offset-4";

/** Adds a password to the account (so email + password works besides Google) or changes it. */
function PasswordPanel({ email, hasPassword }: { email: string; hasPassword: boolean }) {
  const utils = trpc.useUtils();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [saved, setSaved] = useState(false);
  const save = trpc.auth.setPassword.useMutation({
    onMutate: () => setSaved(false),
    onSuccess: async () => {
      setCurrent("");
      setNext("");
      setSaved(true);
      await utils.auth.me.invalidate();
    },
  });
  const needsReauth = save.error?.message === "REAUTH_REQUIRED";
  return (
    <Panel title={t("settings.password")}>
      <p className="break-words text-sm text-muted-foreground">
        {hasPassword ? t("settings.passwordSet", { email }) : t("settings.passwordNone", { email })}
      </p>
      <form
        className="mt-3 grid max-w-sm gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ currentPassword: hasPassword ? current : undefined, newPassword: next });
        }}
      >
        {hasPassword && <PasswordField label={t("settings.currentPassword")} value={current} onChange={setCurrent} autoComplete="current-password" />}
        <PasswordField
          label={t("settings.newPassword")}
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          hint={t("auth.passwordHint", { count: PASSWORD_MIN_LENGTH })}
        />
        {saved && <p role="status" className="text-sm text-success">{t("settings.passwordSaved")}</p>}
        {save.error && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">{authErrorText(save.error, t("auth.checkFields"))}</p>
            {needsReauth && (
              <Button type="button" variant="outline" onClick={() => startLogin("/settings")}>{t("common.signInGoogle")}</Button>
            )}
          </div>
        )}
        <Button type="submit" className="justify-self-start" disabled={save.isPending}>
          {hasPassword ? t("settings.changePassword") : t("settings.setPassword")}
        </Button>
      </form>
    </Panel>
  );
}

/** Read-only: AI pre-reviews used in the last 24 hours against the per-workspace daily cap. */
function AiUsagePanel() {
  const usage = trpc.workspaces.aiUsage.useQuery();
  if (!usage.data) return null;
  const { enabled, dailyLimit, workspaces } = usage.data;
  return (
    <Panel title={t("settings.aiUsage")}>
      {!enabled ? (
        <p className="text-sm text-muted-foreground">{t("settings.aiUsageDisabled")}</p>
      ) : (
        <>
          <ul className="divide-y text-sm">
            {workspaces.map((w) => (
              <li key={w.workspaceId} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 break-words">{w.title}</span>
                <Pill className={`shrink-0 ${w.usedToday >= dailyLimit ? "text-destructive" : ""}`}>
                  {t("settings.aiUsageValue", { used: w.usedToday, limit: dailyLimit })}
                </Pill>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">{t("settings.aiUsageNote")}</p>
        </>
      )}
    </Panel>
  );
}

const STUDENT_EVENTS = ["TASK_ASSIGNED", "TASK_UPDATED", "AI_GRADE_READY", "GRADE_RELEASED", "GRADE_UPDATED", "EXAM_RESULT_READY", "ANNOUNCEMENT"];
const SHOWN_CHANNELS = ["IN_APP", "EMAIL", "PUSH"] as const;

/** Which notifications reach this user in the app, by e-mail and as push (browser and mobile app alike). */
function NotificationPreferencesPanel({ teaching }: { teaching: boolean }) {
  const prefs = trpc.inbox.preferences.useQuery();
  const set = trpc.inbox.setPreference.useMutation({
    onSuccess: () => void prefs.refetch(),
    onError: (e) => toast.error(errorText(e)),
  });
  if (!prefs.data) return null;
  const rows = prefs.data.filter((p) => teaching || STUDENT_EVENTS.includes(p.event));
  return (
    <Panel title={t("settings.notifications")}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 font-normal" />
              {SHOWN_CHANNELS.map((c) => <th key={c} className="w-20 py-1 text-center font-normal">{t(`settings.channel.${c}`)}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((p) => (
              <tr key={p.event}>
                <td className="py-2 pr-3 break-words">{t(`settings.event.${p.event}`)}</td>
                {SHOWN_CHANNELS.map((c) => {
                  const pref = p.channels.find((x) => x.channel === c);
                  return (
                    <td key={c} className="py-2 text-center">
                      {pref ? (
                        <input
                          type="checkbox"
                          className="accent-link"
                          aria-label={`${t(`settings.event.${p.event}`)} · ${t(`settings.channel.${c}`)}`}
                          disabled={set.isPending}
                          checked={pref.enabled}
                          onChange={(e) => set.mutate({ event: p.event, channel: c, enabled: e.target.checked })}
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t("settings.pushNote")}</p>
    </Panel>
  );
}

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

        {user.email && <PasswordPanel email={user.email} hasPassword={user.hasPassword} />}

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

        {user.workspaces.length > 0 && <AiUsagePanel />}

        <NotificationPreferencesPanel teaching={user.workspaces.length > 0} />

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
