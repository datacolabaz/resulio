import { Pill } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { DURATION_UNITS, MAX_DURATION_VALUE, type CourseTiming, type Duration, type DurationUnit } from "@shared/syllabusTiming";
import { CalendarDays, Clock } from "lucide-react";
import { useEffect, useState } from "react";

/** "9 ay", "4 weeks", "1 месяц". */
export function durationText(d: Duration): string {
  return t(d.unit === "MONTHS" ? "timing.months" : "timing.weeks", { count: d.value });
}

/** Course duration and cadence as pills (student overview, preview). */
export function CourseTimingPills({ timing }: { timing: CourseTiming | null | undefined }) {
  if (!timing) return null;
  return (
    <>
      {timing.duration && (
        <Pill>
          <CalendarDays className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          {t("timing.courseDuration", { duration: durationText(timing.duration) })}
        </Pill>
      )}
      {timing.lessonsPerWeek && (
        <Pill>
          <Clock className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          {t("timing.perWeek", { count: timing.lessonsPerWeek })}
        </Pill>
      )}
    </>
  );
}

const unitClass = "h-9 rounded-md border border-input bg-card px-2 text-sm";

/** Value + unit; an empty value means "not set". Reports every complete change. */
export function DurationFields({
  value,
  onChange,
  idPrefix,
  label,
  disabled,
}: {
  value: Duration | null;
  onChange: (d: Duration | null) => void;
  idPrefix: string;
  label: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value ? String(value.value) : "");
  const [unit, setUnit] = useState<DurationUnit>(value?.unit ?? "MONTHS");
  const external = value ? `${value.value}|${value.unit}` : "";
  useEffect(() => {
    setText(value ? String(value.value) : "");
    if (value) setUnit(value.unit);
    // Only resync when the stored value changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external]);
  const emit = (nextText: string, nextUnit: DurationUnit) => {
    const n = Number(nextText.replace(",", "."));
    if (!nextText.trim()) onChange(null);
    else if (Number.isFinite(n) && n > 0 && n <= MAX_DURATION_VALUE) onChange({ value: Math.round(n * 10) / 10, unit: nextUnit });
  };
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={label}>
      <Input
        id={`${idPrefix}-value`}
        type="number"
        min={0.5}
        step={0.5}
        max={MAX_DURATION_VALUE}
        className="h-9 w-20"
        value={text}
        disabled={disabled}
        aria-label={t("timing.value", { label })}
        onChange={(e) => {
          setText(e.target.value);
          emit(e.target.value, unit);
        }}
      />
      <select
        id={`${idPrefix}-unit`}
        className={unitClass}
        value={unit}
        disabled={disabled}
        aria-label={t("timing.unit", { label })}
        onChange={(e) => {
          const u = e.target.value as DurationUnit;
          setUnit(u);
          emit(text, u);
        }}
      >
        {DURATION_UNITS.map((u) => (
          <option key={u} value={u}>{t(u === "MONTHS" ? "timing.unit.MONTHS" : "timing.unit.WEEKS")}</option>
        ))}
      </select>
    </div>
  );
}

/** Whole positive number or empty (= not set). */
export function parseCount(text: string, max: number): number | null | undefined {
  if (!text.trim()) return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : undefined;
}
