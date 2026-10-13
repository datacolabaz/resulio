import { Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { errorText, fmtDay, fmtRelative } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { claudeInstallUrl, type McpEntitlementState } from "@shared/mcpConnector";
import { ExternalLink, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** The "Yeniliklər" card links here (`/settings#claude-connector`). */
const PANEL_ID = "claude-connector";

function statusText(e: McpEntitlementState) {
  if (e.status === "ACTIVE") return e.expiresAt ? t("connector.statusActiveUntil", { date: fmtDay(e.expiresAt) }) : t("connector.statusActiveForever");
  return e.status === "EXPIRED" ? t("connector.statusExpired") : t("connector.statusInactive");
}

/**
 * Settings → Claude integration. The connector URL is never shown: the button copies it and opens
 * Claude's "Add custom connector" dialog with it prefilled. Access is protected by OAuth and the
 * server-side subscription check, not by keeping the URL secret.
 */
export function ClaudeConnectorPanel() {
  const utils = trpc.useUtils();
  const status = trpc.mcpConnector.status.useQuery();
  const [guide, setGuide] = useState(false);
  const revoke = trpc.mcpConnector.revoke.useMutation({
    onSuccess: () => {
      toast.success(t("connector.disconnected"));
      void utils.mcpConnector.status.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const upgrade = trpc.mcpConnector.requestUpgrade.useMutation({
    onSuccess: (r) => {
      if (r.outcome !== "ALREADY_ACTIVE") toast.success(t("connector.requestSent"));
      void utils.mcpConnector.status.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const loaded = !!status.data?.isTeacher;
  useEffect(() => {
    if (!loaded || window.location.hash !== `#${PANEL_ID}`) return;
    // After the page's own scroll-to-top on navigation.
    const timer = window.setTimeout(() => document.getElementById(PANEL_ID)?.scrollIntoView({ block: "start" }), 50);
    return () => window.clearTimeout(timer);
  }, [loaded]);
  if (!status.data?.isTeacher) return null;
  const { entitlement, connectorUrl, clients, upgradeRequested } = status.data;

  if (entitlement.status !== "ACTIVE" || !connectorUrl) {
    return (
      <Panel id={PANEL_ID} title={t("connector.premiumTitle")} className="scroll-mt-20">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-link" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{statusText(entitlement)}</p>
            <p className="text-sm text-muted-foreground">{t("connector.premiumNote")}</p>
          </div>
        </div>
        {upgradeRequested || upgrade.isSuccess ? (
          <p role="status" className="mt-4 text-sm text-success">{t("connector.requestSent")}</p>
        ) : (
          <Button className="mt-4 w-full sm:w-auto" disabled={upgrade.isPending} onClick={() => upgrade.mutate()}>
            {t("connector.subscribe")}
          </Button>
        )}
      </Panel>
    );
  }

  const connect = async () => {
    // Started before window.open: the clipboard needs this page focused and the click's activation.
    const copied = navigator.clipboard?.writeText(connectorUrl) ?? Promise.reject(new Error("no clipboard"));
    window.open(claudeInstallUrl(connectorUrl), "_blank", "noopener,noreferrer");
    setGuide(true);
    try {
      await copied;
      toast.success(t("connector.copied"));
    } catch {
      toast(t("connector.copyFailed"));
    }
  };

  return (
    <Panel id={PANEL_ID} title={t("connector.title")} className="scroll-mt-20">
      <p className="text-sm font-medium">{statusText(entitlement)}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t("connector.description")}</p>
      <Button className="mt-4 w-full sm:w-auto" onClick={() => void connect()}>
        <ExternalLink className="h-4 w-4" aria-hidden />
        {t("connector.connect")}
      </Button>
      {guide && (
        <div className="mt-4 rounded-xl bg-muted p-3 text-sm">
          <div className="font-medium">{t("connector.guideTitle")}</div>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>{t("connector.step1")}</li>
            <li>{t("connector.step2")}</li>
            <li>{t("connector.step3")}</li>
          </ol>
        </div>
      )}
      <h3 className="mt-5 text-sm font-medium">{t("connector.clients")}</h3>
      {clients.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">{t("connector.noClients")}</p>
      ) : (
        <ul className="mt-1 divide-y text-sm">
          {clients.map((c) => (
            <li key={c.clientId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="break-words font-medium">{c.clientName}</div>
                <div className="text-xs text-muted-foreground">{c.lastUsedAt ? t("connector.lastUsed", { time: fmtRelative(c.lastUsedAt) }) : t("connector.neverUsed")}</div>
              </div>
              <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate({ clientId: c.clientId })}>
                {t("connector.disconnect")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
