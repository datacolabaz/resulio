import { t } from "@/i18n/messages";

/**
 * The disclosure every product preview on the landing page must carry: this is a mockup built
 * from demo data, not a real account. Always rendered right under the preview it describes.
 */
export function DemoNote({ className = "" }: { className?: string }) {
  return <p className={`text-center text-xs text-muted-foreground ${className}`}>{t("landing.demo.note")}</p>;
}
