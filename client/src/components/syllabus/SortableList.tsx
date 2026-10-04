import { t } from "@/i18n/messages";
import { moveItem } from "@/lib/syllabus";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

export interface SortControls {
  /** Drag grip plus move up/down buttons; place it at the start of the row. */
  handle: ReactNode;
  index: number;
}

/**
 * Reorderable list without a drag-and-drop library: the grip starts an HTML5 drag (mouse), and
 * the up/down buttons (or Arrow/Home/End keys on the grip) do the same from the keyboard and on touch.
 * Nested lists are independent: a list ignores drags that did not start in it.
 */
export function SortableList<T>({
  items,
  getKey,
  getLabel,
  onReorder,
  disabled = false,
  className = "space-y-2",
  children,
}: {
  items: readonly T[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  onReorder: (next: T[]) => void;
  disabled?: boolean;
  className?: string;
  children: (item: T, controls: SortControls) => ReactNode;
}) {
  const from = useRef<number | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");

  const move = (index: number, to: number) => {
    if (to < 0 || to >= items.length || to === index) return;
    onReorder(moveItem(items, index, to));
    setAnnounce(t("syllabus.sort.moved", { title: getLabel(items[index]), position: to + 1, total: items.length }));
  };

  return (
    <>
      <ul className={className}>
        {items.map((item, index) => {
          const key = getKey(item);
          const label = getLabel(item);
          const handle = (
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                disabled={disabled}
                className="flex h-8 w-8 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 active:cursor-grabbing"
                aria-label={t("syllabus.sort.handle", { title: label })}
                onPointerDown={() => setArmed(key)}
                onPointerUp={() => setArmed(null)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    move(index, index - 1);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    move(index, index + 1);
                  } else if (e.key === "Home") {
                    e.preventDefault();
                    move(index, 0);
                  } else if (e.key === "End") {
                    e.preventDefault();
                    move(index, items.length - 1);
                  }
                }}
              >
                <GripVertical className="h-4 w-4" aria-hidden />
              </button>
              <span className="flex flex-col">
                <button
                  type="button"
                  disabled={disabled || index === 0}
                  onClick={() => move(index, index - 1)}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                  aria-label={t("syllabus.sort.up", { title: label })}
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  disabled={disabled || index === items.length - 1}
                  onClick={() => move(index, index + 1)}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                  aria-label={t("syllabus.sort.down", { title: label })}
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
            </span>
          );
          return (
            <li
              key={key}
              draggable={!disabled && armed === key}
              onDragStart={(e) => {
                e.stopPropagation();
                from.current = index;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", key);
              }}
              onDragOver={(e) => {
                if (from.current === null) return;
                e.preventDefault();
                e.stopPropagation();
                if (over !== index) setOver(index);
              }}
              onDrop={(e) => {
                if (from.current === null) return;
                e.preventDefault();
                e.stopPropagation();
                move(from.current, index);
                from.current = null;
                setOver(null);
                setArmed(null);
              }}
              onDragEnd={() => {
                from.current = null;
                setOver(null);
                setArmed(null);
              }}
              className={`rounded-xl transition-shadow ${over === index && from.current !== null && from.current !== index ? "ring-2 ring-link" : ""}`}
            >
              {children(item, { handle, index })}
            </li>
          );
        })}
      </ul>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </>
  );
}
