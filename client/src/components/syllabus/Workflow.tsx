import { t, type MessageKey } from "@/i18n/messages";
import { STUDENT_STEPS, TEACHER_STEPS, type StepState, type TeacherStep } from "@/lib/syllabusWorkflow";
import { CheckCircle2, ChevronRight, Circle, CircleDot, X } from "lucide-react";
import { useState } from "react";

const STATE_ICON = { done: CheckCircle2, current: CircleDot, todo: Circle } as const;
const STATE_CLASS: Record<StepState, string> = {
  done: "border-success/40 bg-success-surface text-success",
  current: "border-link bg-info-surface text-foreground",
  todo: "border-border bg-card text-foreground-secondary",
};

/**
 * Create → Organize → Teach → Assign → Assess → Track. Each step says its state in text (not only
 * colour) and, when `onSelect` is given, opens the builder tab where that step is done.
 */
export function TeacherWorkflow({ steps, onSelect }: { steps: ReadonlyArray<{ step: TeacherStep; state: StepState }>; onSelect?: (step: TeacherStep) => void }) {
  return (
    <nav aria-label={t("ux.teacherSteps.label")}>
      <ol className="flex flex-wrap items-stretch gap-1.5">
        {steps.map(({ step, state }, i) => {
          const Icon = STATE_ICON[state];
          const body = (
            <>
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 text-left">
                <span className="block text-sm font-medium">{t(`ux.tstep.${step}` as MessageKey)}</span>
                {state === "current" && <span className="block text-xs text-foreground-secondary">{t(`ux.thint.${step}` as MessageKey)}</span>}
              </span>
              <span className="sr-only">({t(`ux.state.${state}` as MessageKey)})</span>
            </>
          );
          const cls = `flex min-h-11 items-center gap-2 rounded-xl border px-3 py-1.5 ${STATE_CLASS[state]}`;
          return (
            <li key={step} className="flex items-center gap-1.5" aria-current={state === "current" ? "step" : undefined}>
              {onSelect ? (
                <button type="button" className={`${cls} cursor-pointer hover:border-link`} title={t(`ux.thint.${step}` as MessageKey)} onClick={() => onSelect(step)}>
                  {body}
                </button>
              ) : (
                <span className={cls} title={t(`ux.thint.${step}` as MessageKey)}>{body}</span>
              )}
              {i < steps.length - 1 && <ChevronRight className="hidden h-4 w-4 text-muted-foreground sm:block" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The workflow without progress, for empty states. */
export function TeacherWorkflowOverview() {
  return <TeacherWorkflow steps={TEACHER_STEPS.map((step) => ({ step, state: "todo" as const }))} />;
}

const DISMISS_KEY = "syllabus.studentSteps.hidden";

function readHidden() {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Learn → Practice → Submit → Pass → Unlock → Progress, explained once; the student can hide it. */
export function StudentWorkflow({ dismissible = true }: { dismissible?: boolean }) {
  const [hidden, setHidden] = useState(() => dismissible && readHidden());
  if (hidden) return null;
  const hide = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Private mode: hide for this visit only.
    }
    setHidden(true);
  };
  return (
    <section className="rounded-2xl border border-border bg-card p-4" aria-labelledby="student-steps-title">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="student-steps-title" className="text-sm font-semibold">{t("ux.studentSteps.title")}</h2>
        {dismissible && (
          <button type="button" onClick={hide} className="inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-link hover:underline">
            <X className="h-3.5 w-3.5" aria-hidden />
            {t("ux.studentSteps.hide")}
          </button>
        )}
      </div>
      <ol aria-label={t("ux.studentSteps.label")} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {STUDENT_STEPS.map((step, i) => (
          <li key={step} className="flex min-w-0 gap-2 rounded-xl bg-muted/60 p-2.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-hidden>{i + 1}</span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t(`ux.sstep.${step}` as MessageKey)}</span>
              <span className="block text-xs text-foreground-secondary">{t(`ux.shint.${step}` as MessageKey)}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
