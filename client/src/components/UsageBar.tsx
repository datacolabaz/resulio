import { AI_LIMIT_WARN_RATIO } from "@shared/aiUsage";

const BAR_TONE = { primary: "bg-primary", warning: "bg-warning", destructive: "bg-destructive" } as const;

export function usageTone(ratio: number | null | undefined): keyof typeof BAR_TONE {
  if (ratio == null) return "primary";
  if (ratio >= 1) return "destructive";
  return ratio >= AI_LIMIT_WARN_RATIO ? "warning" : "primary";
}

/** A thin progress bar that turns amber at 80% and red at 100%. */
export function UsageBar({ ratio, label, className = "" }: { ratio: number | null | undefined; label: string; className?: string }) {
  const value = Math.max(0, Math.min(1, ratio ?? 0));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className={`h-2 w-full overflow-hidden rounded-full bg-muted ${className}`}
    >
      <div className={`h-full rounded-full ${BAR_TONE[usageTone(ratio)]}`} style={{ width: `${value * 100}%` }} />
    </div>
  );
}
