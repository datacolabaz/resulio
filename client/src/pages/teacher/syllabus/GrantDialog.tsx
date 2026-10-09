import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { fromLocalInput } from "@/lib/format";
import {
  dateRangeError,
  existingAccess,
  isChecked,
  membersOf,
  planGrant,
  searchStudents,
  selectionFromPreset,
  setStudentChecked,
  toggleGroup,
  type PickStudent,
} from "@/lib/grantSelection";
import { trpc } from "@/lib/trpc";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { fieldLabel, toastError } from "./shared";

type Preset = { groupIds: string[]; studentIds: number[] } | null;

const studentName = (s: Pick<PickStudent, "name" | "email">) => s.name ?? s.email ?? "—";

function StudentRow({ student, checked, locked, sub, onChange }: { student: PickStudent; checked: boolean; locked: boolean; sub?: string; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 py-0.5 text-sm">
      <input type="checkbox" className="mt-0.5 accent-link" checked={checked} disabled={locked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 flex-1 break-words">
        {studentName(student)}
        {sub && <span className="block text-xs text-muted-foreground">{sub}</span>}
      </span>
      {locked && <span className="shrink-0 text-xs text-muted-foreground">{t("syllabus.access.hasAccess")}</span>}
    </label>
  );
}

export function GrantDialog({ syllabusId, open, onOpenChange, preset }: { syllabusId: string; open: boolean; onOpenChange: (v: boolean) => void; preset: Preset }) {
  const utils = trpc.useUtils();
  const groups = trpc.teacher.groups.list.useQuery(undefined, { enabled: open });
  const students = trpc.teacher.students.useQuery(undefined, { enabled: open });
  const grants = trpc.teacher.syllabus.grants.useQuery({ id: syllabusId }, { enabled: open });
  const [sel, setSel] = useState(() => selectionFromPreset(preset));
  const [query, setQuery] = useState("");
  const [dates, setDates] = useState({ open: false, startsAt: "", endsAt: "" });
  const [note, setNote] = useState("");
  const [lastKey, setLastKey] = useState("");
  const key = `${open}-${JSON.stringify(preset)}`;
  if (key !== lastKey) {
    setLastKey(key);
    if (open) {
      setSel(selectionFromPreset(preset));
      setQuery("");
      setDates({ open: false, startsAt: "", endsAt: "" });
      setNote("");
    }
  }
  const grant = trpc.teacher.syllabus.grant.useMutation({
    onSuccess: () => {
      void utils.teacher.syllabus.grants.invalidate({ id: syllabusId });
      void utils.teacher.syllabus.list.invalidate();
      toast.success(t("syllabus.access.granted"));
      onOpenChange(false);
    },
    onError: toastError,
  });

  const all = useMemo(() => students.data ?? [], [students.data]);
  const access = useMemo(() => existingAccess(grants.data ?? [], all), [grants.data, all]);
  const plan = planGrant(sel, all, access);
  const selectedGroups = (groups.data ?? []).filter((g) => sel.groupIds.includes(g.id));
  const picked = sel.extra.flatMap((id) => all.filter((s) => s.id === id && !s.groupIds.some((g) => sel.groupIds.includes(g))));
  const results = searchStudents(all, query);
  const startsAt = dates.open ? fromLocalInput(dates.startsAt) : null;
  const endsAt = dates.open ? fromLocalInput(dates.endsAt) : null;
  const dateError = dateRangeError(startsAt, endsAt);
  const nothing = !plan.groupIds.length && !plan.studentIds.length;
  const label = plan.groupIds.length
    ? t("syllabus.access.grantCount", { groups: plan.groupIds.length, students: plan.studentCount })
    : plan.studentIds.length
      ? t("syllabus.access.grantStudents", { students: plan.studentCount })
      : t("syllabus.access.grantTitle");
  const check = (s: PickStudent, v: boolean) => setSel((cur) => setStudentChecked(cur, s, v));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t("syllabus.access.grantTitle")}</DialogTitle></DialogHeader>
        <DialogBody className="grid content-start gap-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <fieldset className="min-w-0">
              <legend className={`mb-1 text-sm ${fieldLabel}`}>{t("common.groups")}</legend>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2 sm:max-h-72">
                {(groups.data ?? []).map((g) => {
                  const has = access.groups.has(g.id);
                  return (
                    <label key={g.id} className="flex items-start gap-2 py-0.5 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-link"
                        checked={has || sel.groupIds.includes(g.id)}
                        disabled={has}
                        onChange={() => setSel((cur) => toggleGroup(cur, g.id, all))}
                      />
                      <span className="min-w-0 flex-1 break-words">
                        {g.name}
                        <span className="block text-xs text-muted-foreground">{has ? t("syllabus.access.hasAccess") : t("common.studentsCount", { count: membersOf(g.id, all).length })}</span>
                      </span>
                    </label>
                  );
                })}
                {!groups.data?.length && <div className="text-xs text-muted-foreground">{t("modules.noGroups")}</div>}
              </div>
            </fieldset>

            <fieldset className="min-w-0">
              <legend className={`mb-1 text-sm ${fieldLabel}`}>{t("common.students")}</legend>
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  type="search"
                  className="pl-8"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={selectedGroups.length ? t("syllabus.access.addOther") : t("syllabus.access.search")}
                  aria-label={t("syllabus.access.search")}
                />
              </div>
              <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border p-2">
                {query.trim() ? (
                  <div>
                    {results.map((s) => (
                      <StudentRow
                        key={s.id}
                        student={s}
                        checked={isChecked(sel, s, access)}
                        locked={access.students.has(s.id)}
                        sub={s.groups.join(", ")}
                        onChange={(v) => check(s, v)}
                      />
                    ))}
                    {!results.length && <p className="text-xs text-muted-foreground">{t("syllabus.access.noMatches")}</p>}
                  </div>
                ) : null}

                {!query.trim() && !selectedGroups.length && !picked.length && (
                  <p className="py-4 text-center text-sm text-muted-foreground">{t("syllabus.access.pickHint")}</p>
                )}

                {!query.trim() &&
                  selectedGroups.map((g) => {
                    const members = membersOf(g.id, all).sort((a, b) => studentName(a).localeCompare(studentName(b), "az"));
                    const partial = plan.partialGroupIds.includes(g.id);
                    return (
                      <section key={g.id} aria-label={g.name}>
                        <h3 className="mb-1 break-words text-sm font-semibold text-foreground-secondary">{g.name}</h3>
                        {members.map((s) => (
                          <StudentRow key={s.id} student={s} checked={isChecked(sel, s, access)} locked={access.students.has(s.id)} onChange={(v) => check(s, v)} />
                        ))}
                        {!members.length && <p className="text-xs text-muted-foreground">{t("syllabus.access.groupEmpty")}</p>}
                        {partial ? (
                          <p className="mt-1 rounded-md border border-warning/40 bg-warning-surface px-2 py-1 text-xs text-warning">{t("syllabus.access.groupPartial")}</p>
                        ) : (
                          <p className="mt-1 text-xs text-muted-foreground">{t("syllabus.access.groupWhole")}</p>
                        )}
                      </section>
                    );
                  })}

                {!query.trim() && picked.length > 0 && (
                  <section aria-label={t("syllabus.access.picked")}>
                    <h3 className="mb-1 text-sm font-semibold text-foreground-secondary">{t("syllabus.access.picked")}</h3>
                    <ul className="flex flex-wrap gap-1.5">
                      {picked.map((s) => (
                        <li key={s.id} className="flex max-w-full items-center gap-1 rounded-full border bg-muted py-0.5 pl-2.5 pr-1 text-xs">
                          <span className="min-w-0 truncate">{studentName(s)}</span>
                          <button type="button" className="rounded-full p-0.5 hover:bg-background" aria-label={t("syllabus.access.unpick", { name: studentName(s) })} onClick={() => check(s, false)}>
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

          <div className="rounded-lg border p-2">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-left text-sm font-medium"
              aria-expanded={dates.open}
              onClick={() => setDates((d) => ({ ...d, open: !d.open }))}
            >
              {dates.open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
              {t("syllabus.access.datesToggle")}
            </button>
            {!dates.open && <p className="mt-1 pl-5.5 text-xs text-muted-foreground">{t("syllabus.access.datesDefault")}</p>}
            {dates.open && (
              <div className="mt-2 grid gap-2">
                <p className="text-xs text-muted-foreground">{t("syllabus.access.datesExplain")}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="min-w-0 text-sm"><span className={fieldLabel}>{t("syllabus.access.startsAt")}</span><Input type="datetime-local" value={dates.startsAt} onChange={(e) => setDates({ ...dates, startsAt: e.target.value })} /></label>
                  <label className="min-w-0 text-sm"><span className={fieldLabel}>{t("syllabus.access.endsAt")}</span><Input type="datetime-local" value={dates.endsAt} onChange={(e) => setDates({ ...dates, endsAt: e.target.value })} /></label>
                </div>
                {dateError && <p role="alert" className="text-xs text-destructive">{t(`syllabus.access.${dateError}`)}</p>}
              </div>
            )}
          </div>

          <label className="text-sm"><span className={fieldLabel}>{t("syllabus.access.note")}</span><Input maxLength={255} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            disabled={nothing || !!dateError || grant.isPending}
            onClick={() => grant.mutate({ id: syllabusId, groupIds: plan.groupIds, studentIds: plan.studentIds, startsAt, endsAt, note: note || undefined })}
          >
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
