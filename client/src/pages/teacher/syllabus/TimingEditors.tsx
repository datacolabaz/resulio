import { Panel } from "@/components/AppShell";
import { DurationFields, durationText, parseCount } from "@/components/syllabus/Timing";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { checkModuleDurations, lessonMinutes, MAX_LESSONS_PER_WEEK, suggestedLessonCount, type Duration } from "@shared/syllabusTiming";
import { AlertTriangle, Check, Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Tree } from "./SyllabusDetail";
import { fieldLabel, toastError, useSyllabusRefresh } from "./shared";

type ModuleNode = Tree["modules"][number];
type LessonNode = ModuleNode["lessons"][number];

/** Saves `value` a moment after the last change when it differs from what is stored; `undefined` = invalid, not saved. */
function useAutoSave<T>(value: T | undefined, saved: T, save: (v: T) => void, delay = 700) {
  const valueKey = JSON.stringify(value ?? null);
  const savedKey = JSON.stringify(saved);
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    if (value === undefined || valueKey === savedKey) return;
    const handle = setTimeout(() => latest.current(value), delay);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey, savedKey]);
  return value !== undefined && valueKey === savedKey;
}

export function minutesText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return t("syllabus.minutes", { count: m });
  return m ? t("timing.hoursMinutes", { h, m }) : t("timing.hours", { h });
}

/** Course total and cadence, with the module durations summed against the total (a warning, never a block). */
export function CourseTimingPanel({ tree }: { tree: Tree }) {
  const id = tree.syllabus.id;
  const refresh = useSyllabusRefresh(id);
  const saved = tree.timing.course;
  const [duration, setDuration] = useState<Duration | null>(saved.duration);
  const [perWeek, setPerWeek] = useState(saved.lessonsPerWeek ? String(saved.lessonsPerWeek) : "");
  const save = trpc.teacher.syllabus.updateCourseTiming.useMutation({ onSuccess: refresh, onError: toastError });
  const lessonsPerWeek = parseCount(perWeek, MAX_LESSONS_PER_WEEK);
  const next = lessonsPerWeek === undefined ? undefined : { duration, lessonsPerWeek };
  const inSync = useAutoSave(next, saved, (course) => save.mutate({ id, course }));

  const check = checkModuleDurations(saved.duration, tree.modules.map((m) => tree.timing.modules[m.id] ?? null));
  const all = lessonMinutes(tree.modules.flatMap((m) => m.lessons));
  const lessonCount = tree.modules.reduce((n, m) => n + m.lessons.length, 0);
  const suggested = suggestedLessonCount(saved.lessonsPerWeek, saved.duration);
  return (
    <Panel title={t("timing.title")}>
      <p className="mb-3 text-sm text-muted-foreground">{t("timing.intro")}</p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="text-sm">
          <span className={`mb-1 block ${fieldLabel}`}>{t("timing.courseTotal")}</span>
          <DurationFields idPrefix="course-duration" label={t("timing.courseTotal")} value={duration} onChange={setDuration} />
        </div>
        <label className="text-sm">
          <span className={`mb-1 block ${fieldLabel}`}>{t("timing.lessonsPerWeek")}</span>
          <Input type="number" min={1} max={MAX_LESSONS_PER_WEEK} className="h-9 w-24" value={perWeek} onChange={(e) => setPerWeek(e.target.value)} aria-invalid={lessonsPerWeek === undefined} />
        </label>
        {inSync && (saved.duration || saved.lessonsPerWeek) ? (
          <span className="inline-flex items-center gap-1 pb-2 text-xs text-muted-foreground" role="status">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {t("timing.saved")}
          </span>
        ) : null}
      </div>
      <ul className="mt-3 space-y-1 text-sm text-foreground-secondary">
        <li>
          {check.sum ? t("timing.modulesSum", { sum: durationText(check.sum) }) : t("timing.modulesSumNone")}
          {check.missing > 0 && check.sum ? ` · ${t("timing.modulesMissing", { count: check.missing })}` : ""}
        </li>
        <li>
          {t("timing.lessonsTotal", { count: lessonCount })}
          {all.minutes > 0 ? ` · ${t("timing.minutesTotal", { time: minutesText(all.minutes) })}` : ""}
          {all.missing > 0 && all.minutes > 0 ? ` · ${t("timing.lessonsWithoutMinutes", { count: all.missing })}` : ""}
        </li>
      </ul>
      {suggested !== null && saved.duration && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {t("timing.suggestedCourse", { count: suggested, duration: durationText(saved.duration), perWeek: saved.lessonsPerWeek ?? 0 })}
            {lessonCount > suggested ? ` ${t("timing.suggestedMore", { lessons: lessonCount })}` : ""}
          </span>
        </p>
      )}
      {check.mismatch && check.sum && saved.duration && (
        <p className="mt-3 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning" role="note">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t("timing.mismatch", { sum: durationText(check.sum), total: durationText(saved.duration) })}
        </p>
      )}
    </Panel>
  );
}

/** Module duration (auto-saved) and what its lessons add up to. */
export function ModuleTiming({ tree, module }: { tree: Tree; module: ModuleNode }) {
  const refresh = useSyllabusRefresh(tree.syllabus.id);
  const saved = tree.timing.modules[module.id] ?? null;
  const [duration, setDuration] = useState<Duration | null>(saved);
  const save = trpc.teacher.syllabus.updateModuleDuration.useMutation({ onSuccess: refresh, onError: toastError });
  useAutoSave(duration, saved, (d) => save.mutate({ moduleId: module.id, duration: d }));
  const sum = lessonMinutes(module.lessons);
  const suggested = suggestedLessonCount(tree.timing.course.lessonsPerWeek, saved);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-muted/50 px-3 py-2 text-sm">
      <span className="inline-flex items-center gap-2">
        <span className="text-foreground-secondary">{t("timing.moduleDuration")}</span>
        <DurationFields idPrefix={`module-${module.id}-duration`} label={t("timing.moduleDurationOf", { title: module.title })} value={duration} onChange={setDuration} />
      </span>
      <span className="text-xs text-muted-foreground">
        {sum.minutes > 0 ? t("timing.minutesTotal", { time: minutesText(sum.minutes) }) : t("timing.noMinutes")}
        {suggested !== null ? ` · ${t("timing.suggestedModule", { count: suggested, perWeek: tree.timing.course.lessonsPerWeek ?? 0 })}` : ""}
      </span>
    </div>
  );
}

/** Lesson minutes edited in place in the module's lesson list (auto-saved). */
export function LessonMinutes({ tree, lesson }: { tree: Tree; lesson: LessonNode }) {
  const refresh = useSyllabusRefresh(tree.syllabus.id);
  const [text, setText] = useState(lesson.estimatedMinutes ? String(lesson.estimatedMinutes) : "");
  const save = trpc.teacher.syllabus.updateLesson.useMutation({ onSuccess: refresh, onError: toastError });
  useAutoSave(parseCount(text, 10_000), lesson.estimatedMinutes ?? null, (estimatedMinutes) => save.mutate({ lessonId: lesson.id, patch: { estimatedMinutes } }));
  return (
    <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Input
        type="number"
        min={1}
        max={10_000}
        className="h-8 w-16 px-2 text-xs"
        value={text}
        placeholder="—"
        onChange={(e) => setText(e.target.value)}
        aria-label={t("timing.lessonMinutesOf", { title: lesson.title })}
      />
      {t("timing.min")}
    </label>
  );
}
