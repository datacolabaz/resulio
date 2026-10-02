import { useAuth } from "@/_core/hooks/useAuth";
import { AppShell, Loading, Panel } from "@/components/AppShell";
import { ShareBox, ShareFunnelSummary } from "@/components/ShareBox";
import { t } from "@/i18n/messages";
import { canEnter } from "@/lib/contexts";
import { fmtDateTime, shareChannelLabel } from "@/lib/format";
import { trpc } from "@/lib/trpc";

export default function PartnerPage() {
  const { user } = useAuth();
  const dash = trpc.partner.dashboard.useQuery();
  const stats = trpc.partner.referralStats.useQuery();
  // Partner isn't its own "space" to switch into -- it's one more item inside whichever sidebar
  // (teaching or learning) the user is already in, exactly like Settings. Only a user with
  // neither (no groups, no workspace) falls back to the bare context-switcher nav, same as
  // SettingsPage.
  const area = user?.lastActiveContext && canEnter(user, user.lastActiveContext) ? user.lastActiveContext : undefined;
  return (
    <AppShell area={area} title={t("context.partner")}>
      {dash.isLoading ? (
        <Loading />
      ) : dash.data ? (
        <div className="grid max-w-3xl gap-5">
          <Panel title={t("partner.referralCode")}>
            <div className="break-all font-mono text-2xl tracking-widest">{dash.data.referralCode}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t("partner.approvedAt", { date: fmtDateTime(dash.data.approvedAt) })}</p>
            <div className="mt-4">
              <ShareBox
                path={`/?ref=${dash.data.referralCode}`}
                fileName={`resulio-referral-${dash.data.referralCode}`}
                tracking={{ targetType: "REFERRAL", targetId: dash.data.referralCode, campaign: "profile_referral" }}
              />
            </div>
          </Panel>
          <Panel title={t("partner.stats")}>
            <ShareFunnelSummary data={stats.data?.funnel} />
            <p className="mt-3 text-sm">{t("partner.signups")}: <span className="font-semibold">{stats.data?.signupCount ?? 0}</span></p>
            <div className="mt-3">
              <h4 className="text-xs font-medium text-foreground-secondary">{t("partner.referredList")}</h4>
              {!stats.data?.referred.length ? (
                <p className="mt-1 text-xs text-muted-foreground">{t("partner.referredEmpty")}</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm">
                  {stats.data.referred.map((r, i) => (
                    <li key={i} className="text-muted-foreground">
                      {t("partner.referredRow", { name: r.maskedName, channel: shareChannelLabel(r.channel), date: fmtDateTime(r.joinedAt) })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">{t("partner.commissionNote")}</p>
          </Panel>
        </div>
      ) : null}
    </AppShell>
  );
}
