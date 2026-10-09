import { useAuth } from "@/_core/hooks/useAuth";
import { Panel } from "@/components/AppShell";
import { t } from "@/i18n/messages";
import type { AdminPermission } from "@shared/adminPermissions";
import { Settings } from "lucide-react";
import { Link } from "wouter";

export { UsageBar } from "@/components/UsageBar";

/** UI-side permission check; the server (adminProcedure) is the only real authority. */
export function useAdmin() {
  const { user, loading } = useAuth();
  const can = (p: AdminPermission) => !!user?.admin?.permissions.includes(p);
  return { user, loading, can };
}

export function NoAccess() {
  return <Panel><p className="text-sm text-muted-foreground">{t("admin.noAccess")}</p></Panel>;
}

/** Points editors at the Settings page, where platform-wide values are changed. */
export function SettingsLink() {
  return (
    <Link href="/admin/settings" className="inline-flex items-center gap-1.5 text-sm text-link underline-offset-4 hover:underline">
      <Settings className="h-4 w-4" aria-hidden />
      {t("admin.settings.editLink")}
    </Link>
  );
}

/** "" → null; anything else a non-negative number (NaN stays NaN so callers can disable Save). */
export function parseOptionalNumber(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

export const isValidOptional = (value: number | null) => value === null || Number.isFinite(value);

export const GIB = 1024 ** 3;
