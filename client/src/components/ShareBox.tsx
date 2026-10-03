import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { shareChannelLabel } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import {
  DEFAULT_SHARE_CAMPAIGN,
  SHARE_CHANNELS,
  SHARE_SOURCE_PARAM,
  type ShareCampaign,
  type ShareChannel,
  type ShareChannelStats,
  type ShareFunnel,
  type ShareTargetType,
} from "@shared/shareTracking";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Appends ?src=<channel> (plus &campaign=, unless it's the one the target type already implies)
 * so the receiving page can attribute an open/download/join to the button that produced the link.
 */
function tagged(url: string, channel: ShareChannel, targetType: ShareTargetType, campaign?: ShareCampaign) {
  const u = new URL(url);
  u.searchParams.set("src", SHARE_SOURCE_PARAM[channel]);
  if (campaign && campaign !== DEFAULT_SHARE_CAMPAIGN[targetType]) u.searchParams.set("campaign", campaign);
  return u.toString();
}

/**
 * Share link plus a QR code rendered locally (no third-party QR service). When `tracking` is
 * given, every way the link leaves this box is tagged with its own channel -- including the link
 * text shown here (people copy it by hand) and the QR on screen (people scan it straight off the
 * screen) -- and a best-effort `CLICKED` event is logged on each button press, silently, never
 * blocking the share action itself.
 */
export function ShareBox({
  path,
  fileName = "resulio-qr",
  tracking,
  onAction,
  onTracked,
}: {
  path: string;
  fileName?: string;
  tracking?: { targetType: ShareTargetType; targetId: string; campaign?: ShareCampaign };
  /** Fires on any share action (a channel button, or copying the link) -- e.g. to dismiss a one-time onboarding card once the person has actually done something with it. */
  onAction?: () => void;
  /** Fires once a share action has been recorded, so a stats view next to this box can refresh. */
  onTracked?: () => void;
}) {
  const url = `${window.location.origin}${path}`;
  const [qr, setQr] = useState<string | null>(null);
  const logClick = trpc.public.shareEvent.useMutation({ onSuccess: () => onTracked?.() });

  const link = (channel: ShareChannel) => (tracking ? tagged(url, channel, tracking.targetType, tracking.campaign) : url);
  const whatsappUrl = link("WHATSAPP");
  const telegramUrl = link("TELEGRAM");
  const copyUrl = link("COPY_LINK");
  const qrTargetUrl = link("QR");

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(qrTargetUrl, { width: 480, margin: 1, errorCorrectionLevel: "M" })
      .then((data) => alive && setQr(data))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [qrTargetUrl]);

  const track = (channel: ShareChannel) => {
    onAction?.();
    if (!tracking) return;
    logClick.mutate({ targetType: tracking.targetType, targetId: tracking.targetId, channel, eventType: "CLICKED", campaign: tracking.campaign });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyUrl);
      toast.success(t("share.copied"));
      track("COPY_LINK");
    } catch {
      toast.error(t("share.copyFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      {qr && <img src={qr} alt={t("share.qrAlt")} className="h-36 w-36 rounded-xl border bg-card p-1" />}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="break-all rounded-lg border bg-muted px-3 py-2 font-mono text-xs">{copyUrl}</div>
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
              <a href={qr} download={`${fileName}.png`} onClick={() => track("QR")}>
                {t("share.downloadQr")}
              </a>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** One-line variant for long lists of links (e.g. a batch of single-use invites): no QR, same channel tagging and click logging. */
export function CompactShareLink({
  path,
  tracking,
}: {
  path: string;
  tracking?: { targetType: ShareTargetType; targetId: string; campaign?: ShareCampaign };
}) {
  const url = `${window.location.origin}${path}`;
  const logClick = trpc.public.shareEvent.useMutation();
  const link = (channel: ShareChannel) => (tracking ? tagged(url, channel, tracking.targetType, tracking.campaign) : url);
  const track = (channel: ShareChannel) => {
    if (tracking) logClick.mutate({ targetType: tracking.targetType, targetId: tracking.targetId, channel, eventType: "CLICKED", campaign: tracking.campaign });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link("COPY_LINK"));
      toast.success(t("share.copied"));
      track("COPY_LINK");
    } catch {
      toast.error(t("share.copyFailed"));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs" title={url}>{url}</code>
      <Button size="sm" onClick={() => void copy()}>{t("common.copyLink")}</Button>
      <Button asChild size="sm" variant="outline">
        <a href={`https://wa.me/?text=${encodeURIComponent(link("WHATSAPP"))}`} target="_blank" rel="noopener noreferrer" onClick={() => track("WHATSAPP")}>
          {t("share.whatsapp")}
        </a>
      </Button>
      <Button asChild size="sm" variant="outline">
        <a href={`https://t.me/share/url?url=${encodeURIComponent(link("TELEGRAM"))}`} target="_blank" rel="noopener noreferrer" onClick={() => track("TELEGRAM")}>
          {t("share.telegram")}
        </a>
      </Button>
    </div>
  );
}

/** "5 (3)": raw count, then how many distinct people that was, when it differs. */
function CountCell({ total, unique }: { total: number; unique: number }) {
  return (
    <td className="py-1">
      {total}
      {total > 0 && unique !== total && <span className="text-muted-foreground"> ({unique})</span>}
    </td>
  );
}

/**
 * Channel breakdown for one share link: how many times the sender shared it through each channel
 * ("Paylaşıldı" -- the sender's own button presses, not a recipient's click, which happens inside
 * WhatsApp/Telegram and is never observable here), how many times the page actually loaded for a
 * recipient ("Açılış"), how many times an attached file was downloaded from it ("Yükləndi"), how
 * many recipients joined/claimed it ("Qoşulma") and, for tasks, how many of them then submitted.
 * "Direct" collects visits through untagged links (typed by hand, or shared before tagging existed).
 */
export function ShareFunnelSummary({ data, showSubmitted = false }: { data: ShareFunnel | undefined; showSubmitted?: boolean }) {
  if (!data) return null;
  const rows = SHARE_CHANNELS.map((c) => ({ channel: c, ...data.byChannel[c] })).filter(
    (r) => r.channel !== "DIRECT" || r.opened > 0 || r.downloaded > 0 || r.joined > 0 || r.submitted > 0,
  );
  const hasAny = data.totals.clicked > 0 || data.totals.opened > 0 || data.totals.downloaded > 0 || data.totals.joined > 0;
  const cells = (r: ShareChannelStats, isDirect: boolean) => (
    <>
      <td className="py-1">{isDirect ? "—" : r.clicked}</td>
      <CountCell total={r.opened} unique={r.openedUnique} />
      <CountCell total={r.downloaded} unique={r.downloadedUnique} />
      <td className="py-1">{r.joined}</td>
      {showSubmitted && <td className="py-1">{r.submitted}</td>}
    </>
  );
  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-3">
      <h4 className="text-xs font-medium text-foreground-secondary">{t("share.funnelTitle")}</h4>
      {!hasAny ? (
        <p className="mt-1 text-xs text-muted-foreground">{t("share.funnelEmpty")}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-normal">{t("share.funnelChannel")}</th>
                  <th className="py-1 font-normal">{t("share.funnelClicked")}</th>
                  <th className="py-1 font-normal">{t("share.funnelOpened")}</th>
                  <th className="py-1 font-normal">{t("share.funnelDownloaded")}</th>
                  <th className="py-1 font-normal">{t("share.funnelJoined")}</th>
                  {showSubmitted && <th className="py-1 font-normal">{t("share.funnelSubmitted")}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.channel} className="border-t border-border/60">
                    <td className="py-1">{shareChannelLabel(r.channel)}</td>
                    {cells(r, r.channel === "DIRECT")}
                  </tr>
                ))}
                <tr className="border-t border-border font-medium">
                  <td className="py-1">{t("share.funnelTotal")}</td>
                  {cells(data.totals, false)}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("share.funnelNote")}</p>
        </>
      )}
    </div>
  );
}
