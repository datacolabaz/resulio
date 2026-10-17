import { CompactGroupStudentPicker, useGroupStudentTargets } from "@/components/GroupStudentPicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { errorText, fromLocalInput, toLocalInput } from "@/lib/format";
import { recipientsPayload } from "@/lib/groupStudentSelection";
import { trpc } from "@/lib/trpc";
import { DEFAULT_JOIN_WINDOW_AFTER_MIN, DEFAULT_JOIN_WINDOW_BEFORE_MIN, LESSON_RECURRENCES, MEETING_PROVIDERS, recurrenceNeedsUntil, type LessonRecurrence, type MeetingProvider } from "@shared/lessonIntegration";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

/** The subset of a lesson occurrence the dialog needs to pre-fill when editing one. */
export type EditableLesson = { id: string; title: string; platform: MeetingProvider; startsAt: Date | string; endsAt: Date | string };

const labelText = "text-sm text-foreground-secondary";
const selectClass = "mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground";

function recurrenceLabel(r: LessonRecurrence): string {
  return r === "ONCE" ? t("lessons.form.once") : r === "WEEKLY" ? t("lessons.form.weekly") : t("lessons.form.biweekly");
}

function providerLabel(p: MeetingProvider): string {
  return p === "GOOGLE_MEET" ? t("lessons.provider.googleMeet") : t("lessons.provider.zoom");
}

/**
 * "Yeni dərs" / "Dərsi redaktə et": platform/recurrence choice, group+student recipients, and the
 * meeting's time window. Passing `lesson` switches the dialog into edit mode for that one
 * occurrence -- recurrence and recipients are series-level and stay fixed, so those fields are
 * hidden and only title/platform/time are editable.
 */
export function LessonFormDialog({
  open,
  onOpenChange,
  connectedProviders,
  lesson,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectedProviders: MeetingProvider[];
  lesson?: EditableLesson | null;
}) {
  const ids = useId();
  const utils = trpc.useUtils();
  const isEdit = !!lesson;
  const targets = useGroupStudentTargets(undefined);
  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState<MeetingProvider>(connectedProviders[0] ?? "GOOGLE_MEET");
  const [recurrence, setRecurrence] = useState<LessonRecurrence>("ONCE");
  const [startsAt, setStartsAt] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(45);
  const [recurrenceUntil, setRecurrenceUntil] = useState("");

  // Re-seed the form from the lesson being edited (or reset to blank for a new one) each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (lesson) {
      setTitle(lesson.title);
      setPlatform(lesson.platform);
      setStartsAt(toLocalInput(lesson.startsAt));
      const ms = new Date(lesson.endsAt).getTime() - new Date(lesson.startsAt).getTime();
      setDurationMinutes(Math.max(5, Math.round(ms / 60_000)));
    } else {
      setTitle("");
      setPlatform(connectedProviders[0] ?? "GOOGLE_MEET");
      setRecurrence("ONCE");
      setStartsAt("");
      setDurationMinutes(45);
      setRecurrenceUntil("");
    }
    // Only re-seed on open/lesson-identity change, not on every keystroke into the fields below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lesson?.id]);

  const create = trpc.teacher.lessons.create.useMutation({
    onSuccess: () => {
      toast.success(t("lessons.form.created"));
      void utils.teacher.lessons.list.invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const update = trpc.teacher.lessons.update.useMutation({
    onSuccess: () => {
      toast.success(t("lessons.form.updated"));
      void utils.teacher.lessons.list.invalidate();
      void utils.teacher.lessons.get.invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const saving = create.isPending || update.isPending;

  const startsAtDate = fromLocalInput(startsAt);
  const untilDate = recurrenceNeedsUntil(recurrence) ? fromLocalInput(recurrenceUntil) : null;
  const missingRecipients = !isEdit && !targets.selection.groupIds.length && !targets.selection.extra.length;
  const canSave =
    !!title.trim() && !!startsAtDate && !missingRecipients && (isEdit || !recurrenceNeedsUntil(recurrence) || !!untilDate) && (isEdit || targets.ready);

  const save = () => {
    if (!canSave || !startsAtDate) return;
    if (isEdit && lesson) {
      update.mutate({ lessonId: lesson.id, title: title.trim(), platform, startsAt: startsAtDate, durationMinutes });
      return;
    }
    create.mutate({
      title: title.trim(),
      platform,
      recurrence,
      startsAt: startsAtDate,
      durationMinutes,
      recurrenceUntil: untilDate,
      timezone: "Asia/Baku",
      joinWindowBeforeMin: DEFAULT_JOIN_WINDOW_BEFORE_MIN,
      joinWindowAfterMin: DEFAULT_JOIN_WINDOW_AFTER_MIN,
      ...recipientsPayload(targets.selection, targets.students),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("lessons.form.editTitle") : t("lessons.form.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          <label className="block">
            <span className={labelText}>{t("lessons.form.lessonTitle")}</span>
            <Input className="mt-1" maxLength={255} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("lessons.form.lessonTitlePlaceholder")} />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelText}>{t("lessons.form.platform")}</span>
              <select id={`${ids}-platform`} className={selectClass} value={platform} onChange={(e) => setPlatform(e.target.value as MeetingProvider)}>
                {MEETING_PROVIDERS.map((p) => (
                  <option key={p} value={p} disabled={!connectedProviders.includes(p)}>
                    {providerLabel(p)}
                    {!connectedProviders.includes(p) ? ` (${t("lessons.form.notConnectedOption")})` : ""}
                  </option>
                ))}
              </select>
            </label>
            {!isEdit && (
              <label className="block">
                <span className={labelText}>{t("lessons.form.recurrence")}</span>
                <select id={`${ids}-recurrence`} className={selectClass} value={recurrence} onChange={(e) => setRecurrence(e.target.value as LessonRecurrence)}>
                  {LESSON_RECURRENCES.map((r) => (
                    <option key={r} value={r}>{recurrenceLabel(r)}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelText}>{t("lessons.form.startsAt")}</span>
              <Input className="mt-1" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </label>
            <label className="block">
              <span className={labelText}>{t("lessons.form.durationMinutes")}</span>
              <Input className="mt-1" type="number" min={5} max={480} value={durationMinutes} onChange={(e) => setDurationMinutes(Math.max(5, Number(e.target.value) || 45))} />
            </label>
          </div>

          {!isEdit && recurrenceNeedsUntil(recurrence) && (
            <label className="block">
              <span className={labelText}>{t("lessons.form.recurrenceUntil")}</span>
              <Input className="mt-1" type="datetime-local" value={recurrenceUntil} onChange={(e) => setRecurrenceUntil(e.target.value)} />
            </label>
          )}

          {!connectedProviders.includes(platform) && (
            <p role="status" className="rounded-lg bg-warning-surface px-3 py-2 text-sm text-warning">{t("lessons.form.willNeedConnection")}</p>
          )}

          {!isEdit && (
            <section className="grid gap-2 border-t pt-3">
              <h3 className="text-sm font-semibold">{t("lessons.form.recipients")}</h3>
              <CompactGroupStudentPicker
                groups={targets.groups}
                students={targets.students}
                value={targets.selection}
                onChange={targets.setSelection}
                hints={{ whole: t("lessons.form.groupWhole"), partial: t("lessons.form.groupPartial") }}
              />
              {missingRecipients && <p role="alert" className="text-xs text-destructive">{t("lessons.form.recipientsRequired")}</p>}
            </section>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={!canSave || saving} onClick={save}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
