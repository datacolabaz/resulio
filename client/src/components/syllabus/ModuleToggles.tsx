import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { openModulesKey, readOpenModules, writeOpenModules } from "@/lib/syllabusModuleOpen";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Open/closed modules of one syllabus page. Starts from what this tab remembered for the syllabus,
 * else from `initial`; only the reader's own changes are remembered. With `openAdded`, a module that
 * appears later (just created in the builder) opens so its lessons can be added right away.
 */
export function useOpenModules(opts: { view: string; syllabusId: string; moduleIds: readonly string[]; initial: () => readonly string[]; openAdded?: boolean }) {
  const key = openModulesKey(opts.view, opts.syllabusId);
  const [open, setOpen] = useState<Set<string>>(() => new Set(readOpenModules(sessionStore(), key, opts.moduleIds) ?? opts.initial()));
  const seen = useRef(new Set(opts.moduleIds));
  const idsKey = opts.moduleIds.join("|");

  useEffect(() => {
    const added = opts.moduleIds.filter((id) => !seen.current.has(id));
    for (const id of added) seen.current.add(id);
    if (opts.openAdded && added.length) setOpen((prev) => new Set([...prev, ...added]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const change = (next: Set<string>) => {
    setOpen(next);
    writeOpenModules(sessionStore(), key, next);
  };
  return useMemo(() => {
    const count = opts.moduleIds.filter((id) => open.has(id)).length;
    return {
      open,
      isOpen: (id: string) => open.has(id),
      toggle: (id: string) => {
        const next = new Set(open);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        change(next);
      },
      openAll: () => change(new Set(opts.moduleIds)),
      closeAll: () => change(new Set()),
      allOpen: opts.moduleIds.length > 0 && count === opts.moduleIds.length,
      noneOpen: count === 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idsKey, key]);
}

/** "Expand all / Collapse all" above a module list. */
export function ModuleToggleAll({ allOpen, noneOpen, onOpenAll, onCloseAll, className = "" }: { allOpen: boolean; noneOpen: boolean; onOpenAll: () => void; onCloseAll: () => void; className?: string }) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`} role="group" aria-label={t("syllabus.modules.toggleAll")}>
      <Button type="button" size="sm" variant="outline" disabled={allOpen} onClick={onOpenAll}>
        <ChevronsUpDown className="mr-1 h-4 w-4" aria-hidden />
        {t("syllabus.modules.expandAll")}
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={noneOpen} onClick={onCloseAll}>
        <ChevronsDownUp className="mr-1 h-4 w-4" aria-hidden />
        {t("syllabus.modules.collapseAll")}
      </Button>
    </div>
  );
}
