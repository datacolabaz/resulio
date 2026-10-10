import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import {
  emptySelection,
  isChecked,
  membersOf,
  noAccess,
  planSelection,
  searchStudents,
  selectionFromTargets,
  setStudentChecked,
  toggleGroup,
  type Access,
  type PickStudent,
  type Selection,
} from "@/lib/groupStudentSelection";
import { trpc } from "@/lib/trpc";
import { Search, X } from "lucide-react";
import { useState } from "react";

export interface PickerGroup {
  id: string;
  name: string;
}

export interface PickerStudent extends PickStudent {
  groups: string[];
}

/**
 * The teacher's groups and students plus a selection rebuilt from saved targets once both have
 * loaded. Until `ready`, a form must not save: it would overwrite the saved recipients.
 */
export function useGroupStudentTargets(initial: { groupIds: string[]; studentIds: number[] } | undefined) {
  const groups = trpc.teacher.groups.list.useQuery();
  const students = trpc.teacher.students.useQuery();
  const [state, setState] = useState<ReturnType<typeof selectionFromTargets> | null>(null);
  const ready = !!groups.data && !!students.data;
  if (ready && !state) setState(selectionFromTargets(initial ?? { groupIds: [], studentIds: [] }, groups.data!, students.data!));
  return {
    ready,
    groups: groups.data ?? [],
    students: students.data ?? [],
    selection: state?.selection ?? emptySelection(),
    kept: state?.kept ?? [],
    setSelection: (selection: Selection) => setState((cur) => ({ selection, kept: cur?.kept ?? [] })),
  };
}

const legend = "mb-1 text-sm text-foreground-secondary";
const studentName = (s: Pick<PickStudent, "name" | "email">) => s.name ?? s.email ?? "—";
const byName = (a: PickStudent, b: PickStudent) => studentName(a).localeCompare(studentName(b), "az");

function StudentRow({ student, checked, locked, sub, onChange }: { student: PickStudent; checked: boolean; locked: boolean; sub?: string; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 py-0.5 text-sm">
      <input type="checkbox" className="mt-0.5 accent-link" checked={checked} disabled={locked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 flex-1 break-words">
        {studentName(student)}
        {sub && <span className="block text-xs text-muted-foreground">{sub}</span>}
      </span>
      {locked && <span className="shrink-0 text-xs text-muted-foreground">{t("picker.hasAccess")}</span>}
    </label>
  );
}

/**
 * Groups on the left; on the right the students of the selected groups (all checked by default),
 * or, with no group selected, a search for individual students. `access`: already granted, shown
 * locked. `groupsOnly`: the target takes whole groups only, so members are listed read-only.
 */
export function GroupStudentPicker({
  groups,
  students,
  value,
  onChange,
  hints,
  access = noAccess,
  groupsOnly = false,
  keptCount = 0,
  summary = false,
}: {
  groups: readonly PickerGroup[];
  students: readonly PickerStudent[];
  value: Selection;
  onChange: (next: Selection) => void;
  /** Under a selected group: saved as the whole group / as its checked students only. */
  hints: { whole: string; partial: string };
  access?: Access;
  groupsOnly?: boolean;
  /** Recipients the list cannot show (joined via share link); they are kept on save. */
  keptCount?: number;
  summary?: boolean;
}) {
  const [query, setQuery] = useState("");
  const plan = planSelection(value, students, access);
  const selectedGroups = groups.filter((g) => value.groupIds.includes(g.id));
  const picked = groupsOnly ? [] : value.extra.flatMap((id) => students.filter((s) => s.id === id && !s.groupIds.some((g) => value.groupIds.includes(g))));
  const results = groupsOnly ? [] : searchStudents(students, query);
  const searching = !groupsOnly && !!query.trim();
  const check = (s: PickStudent, v: boolean) => onChange(setStudentChecked(value, s, v));
  const groupsOnlyCount = new Set(students.filter((s) => s.groupIds.some((g) => value.groupIds.includes(g))).map((s) => s.id)).size;
  const counts = groupsOnly
    ? { groups: value.groupIds.length, students: groupsOnlyCount }
    : { groups: plan.groupIds.length, students: plan.studentCount };

  return (
    <div className="grid min-w-0 gap-2">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <fieldset className="min-w-0">
          <legend className={legend}>{t("common.groups")}</legend>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2 sm:max-h-72">
            {groups.map((g) => {
              const has = access.groups.has(g.id);
              return (
                <label key={g.id} className="flex items-start gap-2 py-0.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-link"
                    checked={has || value.groupIds.includes(g.id)}
                    disabled={has}
                    onChange={() => onChange(toggleGroup(value, g.id, students))}
                  />
                  <span className="min-w-0 flex-1 break-words">
                    {g.name}
                    <span className="block text-xs text-muted-foreground">{has ? t("picker.hasAccess") : t("common.studentsCount", { count: membersOf(g.id, students).length })}</span>
                  </span>
                </label>
              );
            })}
            {!groups.length && <div className="text-xs text-muted-foreground">{t("modules.noGroups")}</div>}
          </div>
        </fieldset>

        <fieldset className="min-w-0">
          <legend className={legend}>{t("common.students")}</legend>
          {!groupsOnly && (
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={selectedGroups.length ? t("picker.addOther") : t("picker.search")}
                aria-label={t("picker.search")}
              />
            </div>
          )}
          <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border p-2">
            {searching && (
              <div>
                {results.map((s) => (
                  <StudentRow key={s.id} student={s} checked={isChecked(value, s, access)} locked={access.students.has(s.id)} sub={s.groups.join(", ")} onChange={(v) => check(s, v)} />
                ))}
                {!results.length && <p className="text-xs text-muted-foreground">{t("picker.noMatches")}</p>}
              </div>
            )}

            {!searching && !selectedGroups.length && !picked.length && (
              <p className="py-4 text-center text-sm text-muted-foreground">{t(groupsOnly ? "picker.pickGroup" : "picker.pickHint")}</p>
            )}

            {!searching &&
              selectedGroups.map((g) => {
                const members = membersOf(g.id, students).sort(byName);
                const partial = plan.partialGroupIds.includes(g.id);
                return (
                  <section key={g.id} aria-label={g.name}>
                    <h3 className="mb-1 break-words text-sm font-semibold text-foreground-secondary">{g.name}</h3>
                    {groupsOnly ? (
                      <ul className="space-y-0.5 text-sm">
                        {members.map((s) => <li key={s.id} className="break-words">{studentName(s)}</li>)}
                      </ul>
                    ) : (
                      members.map((s) => (
                        <StudentRow key={s.id} student={s} checked={isChecked(value, s, access)} locked={access.students.has(s.id)} onChange={(v) => check(s, v)} />
                      ))
                    )}
                    {!members.length && <p className="text-xs text-muted-foreground">{t("picker.groupEmpty")}</p>}
                    {partial && !groupsOnly ? (
                      <p className="mt-1 rounded-md border border-warning/40 bg-warning-surface px-2 py-1 text-xs text-warning">{hints.partial}</p>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">{hints.whole}</p>
                    )}
                  </section>
                );
              })}

            {!searching && picked.length > 0 && (
              <section aria-label={t("picker.picked")}>
                <h3 className="mb-1 text-sm font-semibold text-foreground-secondary">{t("picker.picked")}</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {picked.map((s) => (
                    <li key={s.id} className="flex max-w-full items-center gap-1 rounded-full border bg-muted py-0.5 pl-2.5 pr-1 text-xs">
                      <span className="min-w-0 truncate">{studentName(s)}</span>
                      <button type="button" className="rounded-full p-0.5 hover:bg-background" aria-label={t("picker.unpick", { name: studentName(s) })} onClick={() => check(s, false)}>
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </fieldset>
      </div>
      {keptCount > 0 && !groupsOnly && <p className="text-xs text-muted-foreground">{t("picker.kept", { count: keptCount })}</p>}
      {summary && (
        <p className="text-xs font-medium text-foreground-secondary" aria-live="polite">
          {counts.groups
            ? t("picker.summary", counts)
            : counts.students
              ? t("picker.summaryStudents", counts)
              : t("picker.summaryNone")}
        </p>
      )}
    </div>
  );
}
