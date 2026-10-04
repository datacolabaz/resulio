import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// `max-h-dialog` is a custom utility (index.css); registering it lets `max-h-*` overrides replace it.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "max-h": ["max-h-dialog"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
