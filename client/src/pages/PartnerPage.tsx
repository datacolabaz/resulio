import { AppShell, Loading, Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { fmtDateTime } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

export default function PartnerPage() {
  const dash = trpc.partner.dashboard.useQuery();
  const [copied, setCopied] = useState(false);
  const link = dash.data ? `${window.location.origin}/?ref=${dash.data.referralCode}` : "";
  return (
    <AppShell area="partner" title={t("context.partner")}>
      {dash.isLoading ? (
        <Loading />
      ) : dash.data ? (
        <div className="grid max-w-3xl gap-5">
          <Panel title={t("partner.referralCode")}>
            <div className="break-all font-mono text-2xl tracking-widest">{dash.data.referralCode}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t("partner.approvedAt", { date: fmtDateTime(dash.data.approvedAt) })}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all rounded-md border bg-muted px-2 py-1 text-sm">{link}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}
              >
                {copied ? t("common.copied") : t("common.copyLink")}
              </Button>
              <span className="sr-only" aria-live="polite">{copied ? t("share.copied") : ""}</span>
            </div>
          </Panel>
          <Panel title={t("partner.stats")}>
            <p className="text-sm text-muted-foreground">{t("partner.statsLater")}</p>
          </Panel>
        </div>
      ) : null}
    </AppShell>
  );
}
