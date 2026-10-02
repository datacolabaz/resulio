import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { shareChannelLabel } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { SHARE_CHANNELS, type ShareCampaign, type ShareChannel, type ShareFunnel, type ShareTargetType } from "@shared/shareTracking";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** Appends ?source=<channel> (and &campaign=<campaign>, when given) so the receiving page can attribute an open/join to the right button. */
function tagged(url: string, channel: ShareChannel, campaign?: ShareCampaign) {
  const u = new URL(url);
  u.searchParams.set("source", channel.toLowerCase());
  if (campaign) u.searchParams.set("campaign", campaign);
  return u.toString();
}

/**
 * Share link plus a QR code rendered locally (no third-party QR service). When `tracking` is
 * given, each channel's link is tagged with its own source/campaign and a best-effort
 * `share_clicked` event is logged on click -- silently, never blocking the share action itself.
 */
export function ShareBox({
  path,
  fileName = "resulio-qr",
  tracking,
  onAction,
}: {
  path: string;
  fileName?: string;
  tracking?: { targetType: ShareTargetType; targetId: string; campaign?: ShareCampaign };
  /** Fires on any share action (a channel button, or copying the link) -- e.g. to dismiss a one-time onboarding card once the person has actually done something with it. */
  onAction?: () => void;
}) {
  const url = `${window.location.origin}${path}`;
  const [qr, setQr] = useState<string | null>(null);
  const logClick = trpc.public.shareEvent.useMutation();

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { width: 480, margin: 1, errorCorrectionLevel: "M" })
      .then((data) => alive && setQr(data))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [url]);

  const track = (channel: ShareChannel) => {
    onAction?.();
    if (!tracking) return;
    logClick.mutate({ targetType: tracking.targetType, targetId: tracking.targetId, channel, eventType: "CLICKED", campaign: tracking.campaign });
  };

  const whatsappUrl = tracking ? tagged(url, "WHATSAPP", tracking.campaign) : url;
  const telegramUrl = tracking ? tagged(url, "TELEGRAM", tracking.campaign) : url;
  const copyUrl = tracking ? tagged(url, "COPY_LINK", tracking.campaign) : url;
  const qrTargetUrl = tracking ? tagged(url, "QR", tracking.campaign) : url;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyUrl);
      toast.success(t("share.copied"));
      track("COPY_LINK");
    } catch {
      toast.error(t("share.copyFailed"));
    }
  };

  const [qrForDownload, setQrForDownload] = useState<string | null>(null);
  useEffect(() => {
    if (!tracking) return;
    let alive = true;
    QRCode.toDataURL(qrTargetUrl, { width: 480, margin: 1, errorCorrectionLevel: "M" })
      .then((data) => alive && setQrForDownload(data))
      .catch(() => alive && setQrForDownload(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrTargetUrl]);

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      {qr && <img src={qr} alt={t("share.qrAlt")} className="h-36 w-36 rounded-xl border bg-card p-1" />}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="break-all rounded-lg border bg-muted px-3 py-2 font-mono text-xs">{url}</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void copy()}>{t("common.copyLink")}</Button>
          <Button asChild size="sm" variant="outline">
            <a href={`https://wa.me/?text=${encodeURIComponent(whatsappUrl)}`} target="_blank" rel="noopener noreferrer" onClick={() => track("WHATSAPP")}>
              {t("share.whatsapp")}
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`https://t.me/share/url?url=${encodeURIComponent(telegramUrl)}`} target="_blank" rel="noopener noreferrer" onClick={() => track("TELEGRAM")}>
              {t("share.telegram")}
            </a>
          </Button>
          {qr && (
            <Button asChild size="sm" variant="outline">
              <a href={tracking ? qrForDownload ?? qr : qr} download={`${fileName}.png`} onClick={() => track("QR")}>
                {t("share.downloadQr")}
              </a>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Small, honest channel breakdown for one share link: clicks (the button was pressed), opens
 * (the destination page actually loaded), joins (the student went through with it). No funnel
 * stage beyond that is shown, because this app doesn't track anything past it.
 */
export function ShareFunnelSummary({ data }: { data: ShareFunnel | undefined }) {
  if (!data) return null;
  const rows = SHARE_CHANNELS.filter((c) => c !== "DIRECT").map((c) => ({ channel: c, ...data.byChannel[c] }));
  const hasAny = data.totals.clicked > 0 || data.totals.opened > 0 || data.totals.joined > 0;
  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-3">
      <h4 className="text-xs font-medium text-foreground-secondary">{t("share.funnelTitle")}</h4>
      {!hasAny ? (
        <p className="mt-1 text-xs text-muted-foreground">{t("share.funnelEmpty")}</p>
      ) : (
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-normal">{t("share.funnelChannel")}</th>
              <th className="py-1 font-normal">{t("share.funnelClicked")}</th>
              <th className="py-1 font-normal">{t("share.funnelOpened")}</th>
              <th className="py-1 font-normal">{t("share.funnelJoined")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.channel} className="border-t border-border/60">
                <td className="py-1">{shareChannelLabel(r.channel)}</td>
                <td className="py-1">{r.clicked}</td>
                <td className="py-1">{r.opened}</td>
                <td className="py-1">{r.joined}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
