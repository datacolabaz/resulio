import { t } from "@/i18n/messages";

export function BrandMark({ size = 36, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex overflow-hidden ${className}`} style={{ width: size, height: size }}>
      <img
        src="/brand/resulio-icon.png"
        alt="Resulio"
        width={size}
        height={size}
        className="h-full w-full object-cover"
      />
    </span>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <BrandMark size={compact ? 28 : 36} className="rounded-lg" />
      <div className="min-w-0">
        <div className="font-[family-name:var(--font-display)] text-lg leading-none tracking-tight">Resulio</div>
        {!compact && <div className="text-[11px] text-sidebar-primary tracking-wide">{t("brand.tagline")}</div>}
      </div>
    </div>
  );
}
