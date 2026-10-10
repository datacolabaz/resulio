import { GroupStudentPicker } from "@/components/GroupStudentPicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { fromLocalInput } from "@/lib/format";
import { dateRangeError, existingAccess, selectionFromPreset } from "@/lib/grantSelection";
import { planSelection } from "@/lib/groupStudentSelection";
import { trpc } from "@/lib/trpc";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { fieldLabel, toastError } from "./shared";

type Preset = { groupIds: string[]; studentIds: number[] } | null;

export function GrantDialog({ syllabusId, open, onOpenChange, preset }: { syllabusId: string; open: boolean; onOpenChange: (v: boolean) => void; preset: Preset }) {
  const utils = trpc.useUtils();
  const groups = trpc.teacher.groups.list.useQuery(undefined, { enabled: open });
  const students = trpc.teacher.students.useQuery(undefined, { enabled: open });
  const grants = trpc.teacher.syllabus.grants.useQuery({ id: syllabusId }, { enabled: open });
  const [sel, setSel] = useState(() => selectionFromPreset(preset));
  const [dates, setDates] = useState({ open: false, startsAt: "", endsAt: "" });
  const [note, setNote] = useState("");
  const [lastKey, setLastKey] = useState("");
  const key = `${open}-${JSON.stringify(preset)}`;
  if (key !== lastKey) {
    setLastKey(key);
    if (open) {
      setSel(selectionFromPreset(preset));
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
  const plan = planSelection(sel, all, access);
  const startsAt = dates.open ? fromLocalInput(dates.startsAt) : null;
  const endsAt = dates.open ? fromLocalInput(dates.endsAt) : null;
  const dateError = dateRangeError(startsAt, endsAt);
  const nothing = !plan.groupIds.length && !plan.studentIds.length;
  const label = plan.groupIds.length
    ? t("syllabus.access.grantCount", { groups: plan.groupIds.length, students: plan.studentCount })
    : plan.studentIds.length
      ? t("syllabus.access.grantStudents", { students: plan.studentCount })
      : t("syllabus.access.grantTitle");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t("syllabus.access.grantTitle")}</DialogTitle></DialogHeader>
        <DialogBody className="grid content-start gap-3">
          <GroupStudentPicker
            groups={groups.data ?? []}
            students={all}
            value={sel}
            onChange={setSel}
            access={access}
            hints={{ whole: t("syllabus.access.groupWhole"), partial: t("syllabus.access.groupPartial") }}
          />

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
