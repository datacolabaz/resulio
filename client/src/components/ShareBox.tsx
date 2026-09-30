import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** Share link plus a QR code rendered locally (no third-party QR service). */
export function ShareBox({ path, fileName = "resulio-qr" }: { path: string; fileName?: string }) {
  const url = `${window.location.origin}${path}`;
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { width: 480, margin: 1, errorCorrectionLevel: "M" })
      .then((data) => alive && setQr(data))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("share.copied"));
    } catch {
      toast.error(t("share.copyFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      {qr && <img src={qr} alt={t("share.qrAlt")} className="h-36 w-36 rounded-xl border bg-card p-1" />}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="break-all rounded-lg border bg-muted px-3 py-2 font-mono text-xs">{url}</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void copy()}>{t("common.copyLink")}</Button>
          <Button asChild size="sm" variant="outline">
            <a href={`https://wa.me/?text=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer">{t("share.whatsapp")}</a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`https://t.me/share/url?url=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer">{t("share.telegram")}</a>
          </Button>
          {qr && (
            <Button asChild size="sm" variant="outline">
              <a href={qr} download={`${fileName}.png`}>{t("share.downloadQr")}</a>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
