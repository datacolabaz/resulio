import * as React from "react";

import { cn } from "@/lib/utils";
import { Switch } from "./switch";

/**
 * Label + hint + switch settings row. `min-h-fit` is required: the global `.flex { min-height: 0 }`
 * rule would otherwise let the row collapse below its content when it is a grid/flex item of a
 * height-constrained container (e.g. a scrolling DialogBody), spilling the text outside the border.
 */
function SettingToggle({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
  variant = "card",
  className,
}: {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** `card` draws its own bordered box; `plain` is for rows already inside a box. */
  variant?: "card" | "plain";
  className?: string;
}) {
  return (
    <div
      data-slot="setting-toggle"
      className={cn(
        "flex h-auto min-h-fit shrink-0 items-center justify-between gap-3",
        variant === "card" && "rounded-xl border px-3 py-3",
        className
      )}
    >
      <label htmlFor={id} className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
        <span className="block font-medium leading-snug">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export { SettingToggle };
