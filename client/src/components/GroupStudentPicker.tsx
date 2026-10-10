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
  shareSummary,
  toggleGroup,
  uncheckedCount,
  type Access,
  type PickStudent,
  type Selection,
} from "@/lib/groupStudentSelection";
import { trpc } from "@/lib/trpc";
import { ChevronDown, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

function Chip({ label, removeLabel, onRemove }: { label: string; removeLabel: string; onRemove: () => void }) {
  return (
    <li className="flex max-w-full items-center gap-1 rounded-full border bg-muted py-0.5 pl-2.5 pr-1 text-xs">
      <span className="min-w-0 truncate">{label}</span>
      <button type="button" className="rounded-full p-0.5 hover:bg-background" aria-label={removeLabel} onClick={onRemove}>
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </li>
  );
}

/** "Paylaşım: …" line under the compact picker. */
export function ShareSummaryLine({ groups, students, value, keptCount = 0 }: { groups: readonly PickerGroup[]; students: readonly PickerStudent[]; value: Selection; keptCount?: number }) {
  const s = shareSummary(planSelection(value, students), groups);
  const individual = s.students + keptCount;
  let text: string;
  if (s.groupNames.length) {
    const key = s.groupNames.length === 1 ? "picker.shareGroupOne" : "picker.shareGroupMany";
    text = t(key, { groups: s.groupNames.join(", "), count: s.groupStudents });
    if (individual) text = `${text} ${t("picker.shareAndStudents", { count: individual })}`;
  } else {
    text = individual ? t("picker.shareOnlyStudents", { count: individual }) : t("picker.shareNobody");
  }
  return (
    <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground-secondary" aria-live="polite" data-testid="share-summary">
      <span className="font-medium text-foreground">{t("picker.shareLabel")}</span> {text}
    </p>
  );
}

/**
 * The material form's picker: groups as a searchable multi-select with chips; their students stay
 * folded (the whole groups get it) until the teacher opens them to leave someone out. Students are
 * never listed before a group is chosen, except through "Qrupsuz tələbə axtar".
 */
export function CompactGroupStudentPicker({
  groups,
  students,
  value,
  onChange,
  hints,
  keptCount = 0,
}: {
  groups: readonly PickerGroup[];
  students: readonly PickerStudent[];
  value: Selection;
  onChange: (next: Selection) => void;
  hints: { whole: string; partial: string };
  keptCount?: number;
}) {
  const [groupQuery, setGroupQuery] = useState("");
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [studentQuery, setStudentQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const unchecked = uncheckedCount(value, students);
  const [studentsOpen, setStudentsOpen] = useState(() => unchecked > 0);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!groupsOpen) return;
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setGroupsOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [groupsOpen]);

  const plan = planSelection(value, students);
  const selectedGroups = groups.filter((g) => value.groupIds.includes(g.id));
  const q = groupQuery.trim().toLocaleLowerCase("az");
  const shownGroups = q ? groups.filter((g) => g.name.toLocaleLowerCase("az").includes(q)) : groups;
  const picked = value.extra.flatMap((id) => students.filter((s) => s.id === id && !s.groupIds.some((g) => value.groupIds.includes(g))));
  const results = searchStudents(students, studentQuery);
  const check = (s: PickStudent, v: boolean) => onChange(setStudentChecked(value, s, v));
  const showSearch = searchOpen || picked.length > 0;

  return (
    <div className="grid min-w-0 gap-3">
      <fieldset className="min-w-0">
        <legend className={legend}>{t("common.groups")}</legend>
        <div ref={boxRef} className="min-w-0">
          {selectedGroups.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-1.5" aria-label={t("picker.selectedGroups")}>
              {selectedGroups.map((g) => (
                <Chip key={g.id} label={g.name} removeLabel={t("picker.unpick", { name: g.name })} onRemove={() => onChange(toggleGroup(value, g.id, students))} />
              ))}
            </ul>
          )}
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 py-2 text-left text-sm text-muted-foreground"
            aria-expanded={groupsOpen}
            onClick={() => setGroupsOpen((v) => !v)}
          >
            <span className="min-w-0 truncate">{selectedGroups.length ? t("picker.addGroup") : t("picker.chooseGroups")}</span>
            <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${groupsOpen ? "rotate-180" : ""}`} aria-hidden />
          </button>
          {groupsOpen && (
            <div
              className="mt-1 rounded-lg border bg-card p-2 shadow-sm"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setGroupsOpen(false);
                }
              }}
            >
              {groups.length > 6 && (
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    type="search"
                    className="pl-8"
                    value={groupQuery}
                    onChange={(e) => setGroupQuery(e.target.value)}
                    placeholder={t("picker.searchGroups")}
                    aria-label={t("picker.searchGroups")}
                  />
                </div>
              )}
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {shownGroups.map((g) => (
                  <label key={g.id} className="flex items-start gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted">
                    <input type="checkbox" className="mt-0.5 accent-link" checked={value.groupIds.includes(g.id)} onChange={() => onChange(toggleGroup(value, g.id, students))} />
                    <span className="min-w-0 flex-1 break-words">
                      {g.name}
                      <span className="block text-xs text-muted-foreground">{t("common.studentsCount", { count: membersOf(g.id, students).length })}</span>
                    </span>
                  </label>
                ))}
                {!groups.length && <div className="text-xs text-muted-foreground">{t("modules.noGroups")}</div>}
                {groups.length > 0 && !shownGroups.length && <div className="text-xs text-muted-foreground">{t("picker.noGroupMatches")}</div>}
              </div>
            </div>
          )}
        </div>
      </fieldset>

      <fieldset className="min-w-0">
        <legend className={legend}>{t("common.students")}</legend>
        {!selectedGroups.length && !showSearch && <p className="text-sm text-muted-foreground">{t("picker.groupFirst")}</p>}

        {selectedGroups.length > 0 && (
          <div className="rounded-lg border">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
              aria-expanded={studentsOpen}
              onClick={() => setStudentsOpen((v) => !v)}
            >
              <span className="min-w-0">
                <span className="block font-medium">{t("picker.someStudentsOnly")}</span>
                <span className="block text-xs text-muted-foreground">
                  {unchecked ? t("picker.uncheckedCount", { count: unchecked }) : t("picker.allChecked")}
                </span>
              </span>
              <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${studentsOpen ? "rotate-180" : ""}`} aria-hidden />
            </button>
            {studentsOpen && (
              <div className="max-h-72 space-y-3 overflow-y-auto border-t p-2">
                {selectedGroups.map((g) => {
                  const members = membersOf(g.id, students).sort(byName);
                  const partial = plan.partialGroupIds.includes(g.id);
                  return (
                    <section key={g.id} aria-label={g.name}>
                      <h3 className="mb-1 break-words text-sm font-semibold text-foreground-secondary">{g.name}</h3>
                      {members.map((s) => (
                        <StudentRow key={s.id} student={s} checked={isChecked(value, s)} locked={false} onChange={(v) => check(s, v)} />
                      ))}
                      {!members.length && <p className="text-xs text-muted-foreground">{t("picker.groupEmpty")}</p>}
                      {partial ? (
                        <p className="mt-1 rounded-md border border-warning/40 bg-warning-surface px-2 py-1 text-xs text-warning">{hints.partial}</p>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">{hints.whole}</p>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {picked.length > 0 && (
          <div className="mt-2">
            <p className="mb-1 text-xs font-medium text-foreground-secondary">{t("picker.picked")}</p>
            <ul className="flex flex-wrap gap-1.5">
              {picked.map((s) => (
                <Chip key={s.id} label={studentName(s)} removeLabel={t("picker.unpick", { name: studentName(s) })} onRemove={() => check(s, false)} />
              ))}
            </ul>
          </div>
        )}

        {showSearch ? (
          <div className="mt-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                className="pl-8"
                value={studentQuery}
                autoFocus={searchOpen && !picked.length}
                onChange={(e) => setStudentQuery(e.target.value)}
                placeholder={t("picker.search")}
                aria-label={t("picker.search")}
              />
            </div>
            {!!studentQuery.trim() && (
              <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border p-2">
                {results.map((s) => (
                  <StudentRow key={s.id} student={s} checked={isChecked(value, s)} locked={false} sub={s.groups.join(", ")} onChange={(v) => check(s, v)} />
                ))}
                {!results.length && <p className="text-xs text-muted-foreground">{t("picker.noMatches")}</p>}
              </div>
            )}
          </div>
        ) : (
          <button type="button" className="mt-2 text-sm text-link underline-offset-2 hover:underline" onClick={() => setSearchOpen(true)}>
            {selectedGroups.length ? t("picker.addOther") : t("picker.searchUngrouped")}
          </button>
        )}
      </fieldset>
      {keptCount > 0 && <p className="text-xs text-muted-foreground">{t("picker.kept", { count: keptCount })}</p>}
      <ShareSummaryLine groups={groups} students={students} value={value} keptCount={keptCount} />
    </div>
  );
}
