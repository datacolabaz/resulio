import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Archive, CheckCircle2, Clock, Info } from "lucide-react";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  success: "border-success/40 bg-success-surface text-success",
  warning: "border-warning/40 bg-warning-surface text-warning",
  danger: "border-destructive/40 bg-danger-surface text-destructive",
  info: "border-info/40 bg-info-surface text-info",
  neutral: "border-border bg-neutral-surface text-neutral",
};

const TONE_ICON: Record<Tone, LucideIcon> = {
  success: CheckCircle2,
  warning: Clock,
  danger: AlertTriangle,
  info: Info,
  neutral: Archive,
};

/** Surface + border classes for a status-tinted block (callouts, review cards). */
export const toneSurface = (tone: Tone) => TONE_CLASS[tone];

/**
 * Status label that never relies on colour alone: tinted surface, matching foreground,
 * an icon, and the text label.
 */
export function StatusBadge({
  tone,
  icon,
  children,
  className = "",
}: {
  tone: Tone;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]} ${className}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {children}
    </span>
  );
}
