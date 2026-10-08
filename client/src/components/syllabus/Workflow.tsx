import { Button } from "@/components/ui/button";
import { t, type MessageKey } from "@/i18n/messages";
import { OPTIONAL_STEPS, STUDENT_STEPS, TEACHER_STEPS, type StepState, type TeacherStep } from "@/lib/syllabusWorkflow";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Circle, CircleDot, MinusCircle, X } from "lucide-react";
import { useState } from "react";

const STATE_ICON = { done: CheckCircle2, current: CircleDot, todo: Circle, skipped: MinusCircle } as const;
const STATE_CLASS: Record<StepState, string> = {
  done: "border-success/40 bg-success-surface text-success",
  current: "border-link bg-info-surface text-foreground",
  todo: "border-border bg-card text-foreground-secondary",
  skipped: "border-dashed border-border bg-card text-foreground-secondary",
};

const stepHint = (step: TeacherStep, state: StepState) => t(`ux.thint.${state === "skipped" ? `${step}Skipped` : step}` as MessageKey);

/** "Next step: Open to students" — sends the teacher on from an empty tab. */
export function NextStepButton({ step, onSelect }: { step: TeacherStep; onSelect: (step: TeacherStep) => void }) {
  return (
    <Button variant="outline" onClick={() => onSelect(step)}>
      {t("ux.teacherSteps.next", { step: t(`ux.tstep.${step}` as MessageKey) })}
      <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
    </Button>
  );
}

const OPEN_KEY = "syllabus.teacherSteps.open";

function readFlag(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Private mode: remember for this visit only.
  }
}

/**
 * Create → Organize → Teach → Assign → (optional) Assess → Track. Each step says its state in text
 * (not only colour) and, when `onSelect` is given, opens the builder tab where that step is done.
 * `collapsible` starts as a one-line "next step" hint; the teacher's choice is remembered.
 */
export function TeacherWorkflow({
  steps,
  onSelect,
  collapsible = false,
}: {
  steps: ReadonlyArray<{ step: TeacherStep; state: StepState; count?: number }>;
  onSelect?: (step: TeacherStep) => void;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(() => !collapsible || readFlag(OPEN_KEY));
  const setOpen = (on: boolean) => {
    writeFlag(OPEN_KEY, on);
    setExpanded(on);
  };
  const current = steps.find((s) => s.state === "current");
  if (!expanded && current) {
    const label = t("ux.teacherSteps.next", { step: t(`ux.tstep.${current.step}` as MessageKey) });
    return (
      <nav aria-label={t("ux.teacherSteps.label")} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card px-3 py-2 text-sm">
        <CircleDot className="h-4 w-4 shrink-0 text-link" aria-hidden />
        {onSelect ? (
          <button type="button" className="cursor-pointer text-left font-medium hover:underline" onClick={() => onSelect(current.step)}>{label}</button>
        ) : (
          <span className="font-medium">{label}</span>
        )}
        <span className="text-foreground-secondary">{stepHint(current.step, current.state)}</span>
        <button type="button" className="ml-auto inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-link hover:underline" aria-expanded={false} onClick={() => setOpen(true)}>
          {t("ux.teacherSteps.show")}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </button>
      </nav>
    );
  }
  return (
    <nav aria-label={t("ux.teacherSteps.label")} className="space-y-1">
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {steps.map(({ step, state, count }) => {
          const Icon = STATE_ICON[state];
          const hint = stepHint(step, state);
          const body = (
            <>
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 text-left">
                <span className="flex flex-wrap items-center gap-x-1 text-sm font-medium">
                  {t(`ux.tstep.${step}` as MessageKey)}
                  {!!count && <span className="rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">{count}</span>}
                  {OPTIONAL_STEPS.has(step) && state === "todo" && <span className="text-xs font-normal text-foreground-secondary">({t("ux.state.optional")})</span>}
                </span>
                <span className="block text-xs font-normal text-foreground-secondary">{hint}</span>
              </span>
              <span className="sr-only">({t(`ux.state.${state}` as MessageKey)})</span>
            </>
          );
          const cls = `flex h-full min-h-11 w-full items-start gap-2 rounded-xl border px-3 py-2 ${STATE_CLASS[state]}`;
          return (
            <li key={step} className="flex" aria-current={state === "current" ? "step" : undefined}>
              {onSelect ? (
                <button type="button" className={`${cls} cursor-pointer hover:border-link`} title={hint} onClick={() => onSelect(step)}>
                  {body}
                </button>
              ) : (
                <span className={cls} title={hint}>{body}</span>
              )}
            </li>
          );
        })}
      </ol>
      {collapsible && (
        <button type="button" className="inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-link hover:underline" aria-expanded onClick={() => setOpen(false)}>
          {t("ux.teacherSteps.hide")}
          <ChevronUp className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
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
