import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * Where a column goes on the phone card: "title" (top line, left), "aside" (top line, right: a badge or a
 * score), "action" (bottom, right), "hidden" (table only). Default: a label/value line.
 */
export type CardSlot = "title" | "aside" | "action" | "hidden";

export type ResponsiveColumn<T> = {
  key: string;
  /** Table header; also the card label unless `label` is given. */
  header: ReactNode;
  /** Keeps the header for screen readers only (action columns). */
  srOnlyHeader?: boolean;
  /** Card label when it should differ from the header. */
  label?: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** Card content when it should differ from the table cell. */
  cardCell?: (row: T, index: number) => ReactNode;
  thClassName?: string;
  tdClassName?: string;
  card?: CardSlot;
};

/**
 * A data table from `md` up; below it every row becomes a card (title line, label/value lines, actions), so
 * narrow screens never squeeze columns together or scroll sideways. Both are rendered; CSS shows one.
 */
export function ResponsiveTable<T>({
  rows,
  columns,
  rowKey,
  className = "overflow-x-auto",
  tableClassName = "w-full text-sm",
  headClassName = "text-left text-xs uppercase text-muted-foreground",
  bodyClassName = "divide-y",
  rowClassName,
  cardClassName,
  onRowClick,
  cardsClassName = "divide-y",
  empty,
  emptyClassName = "py-3 text-muted-foreground",
}: {
  rows: readonly T[];
  columns: ResponsiveColumn<T>[];
  rowKey: (row: T, index: number) => string | number;
  /** Wrapper of the table (md and up). */
  className?: string;
  tableClassName?: string;
  headClassName?: string;
  bodyClassName?: string;
  rowClassName?: (row: T, index: number) => string | undefined;
  cardClassName?: (row: T, index: number) => string | undefined;
  onRowClick?: (row: T, index: number) => void;
  /** The card list (below md). */
  cardsClassName?: string;
  /** Shown under the header (table) or alone (cards) when there are no rows. */
  empty?: ReactNode;
  emptyClassName?: string;
}) {
  const slot = (s: CardSlot | undefined) => columns.filter((c) => c.card === s);
  const titles = slot("title");
  const asides = slot("aside");
  const fields = slot(undefined);
  const actions = slot("action");
  const cardCell = (c: ResponsiveColumn<T>, row: T, i: number) => (c.cardCell ?? c.cell)(row, i);

  return (
    <>
      <div className={cn("hidden md:block", className)}>
        <table className={tableClassName}>
          <thead className={headClassName}>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={c.thClassName}>
                  {c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={bodyClassName}>
            {rows.map((row, i) => (
              <tr key={rowKey(row, i)} className={rowClassName?.(row, i)} onClick={onRowClick ? () => onRowClick(row, i) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={c.tdClassName}>{c.cell(row, i)}</td>
                ))}
              </tr>
            ))}
            {!rows.length && empty && (
              <tr><td colSpan={columns.length} className={emptyClassName}>{empty}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {!rows.length && empty && <p className={cn("text-sm md:hidden", emptyClassName)}>{empty}</p>}
      <ul className={cn("md:hidden", cardsClassName)}>
        {rows.map((row, i) => (
          <li
            key={rowKey(row, i)}
            className={cn("min-w-0 space-y-2 py-3 text-sm", cardClassName?.(row, i))}
            onClick={onRowClick ? () => onRowClick(row, i) : undefined}
          >
            {(titles.length > 0 || asides.length > 0) && (
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 break-words font-medium">
                  {titles.map((c) => <div key={c.key} className="min-w-0">{cardCell(c, row, i)}</div>)}
                </div>
                {asides.length > 0 && (
                  <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                    {asides.map((c) => <div key={c.key}>{cardCell(c, row, i)}</div>)}
                  </div>
                )}
              </div>
            )}
            {fields.length > 0 && (
              <dl className="space-y-1">
                {fields.map((c) => (
                  <div key={c.key} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-xs text-muted-foreground">{c.label ?? c.header}</dt>
                    <dd className="min-w-0 break-words text-right">{cardCell(c, row, i)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {actions.length > 0 && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {actions.map((c) => <div key={c.key}>{cardCell(c, row, i)}</div>)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
