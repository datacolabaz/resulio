import { ShareBox } from "@/components/ShareBox";
import { t } from "@/i18n/messages";

/**
 * Section 3 preview: the real ShareBox component (same one teachers use from the exam builder
 * and assignments pages) pointed at a fictional share code. It generates its QR code locally
 * and its copy/WhatsApp/Telegram actions never touch the backend, so this is the one preview on
 * the landing page that stays fully interactive rather than a static div/span mockup — there is
 * no real exam behind `/exam/DEMO1234`, so following the link just lands on the normal
 * "not found" page.
 */
export function SharePreview() {
  return (
    <div className="p-4 text-left sm:p-5">
      <p className="truncate text-sm font-semibold">{t("landing.preview.examTitle")}</p>
      <p className="text-xs text-muted-foreground">{t("landing.preview.groupName")}</p>
      <div className="mt-4">
        <ShareBox path="/exam/DEMO1234" fileName="resulio-demo-qr" />
      </div>
    </div>
  );
}
