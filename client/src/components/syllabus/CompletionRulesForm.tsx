import { Input } from "@/components/ui/input";
import { t, type MessageKey } from "@/i18n/messages";
import { isOverridden, ruleValue, withOverride, withoutOverride, type RuleField } from "@/lib/syllabus";
import {
  ASSESSMENT_RULES,
  MAX_ATTEMPTS_LIMIT,
  resolveRules,
  SCORE_POLICIES,
  STUDENT_PRACTICE_RULES,
  TEACHER_PRACTICE_RULES,
  THEORY_RULES,
  type CompletionRules,
  type CompletionRulesPatch,
} from "@shared/syllabus";

export type RulesLevel = "syllabus" | "module" | "lesson";

const selectCls = "w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground disabled:opacity-60";

type Control =
  | { kind: "bool" }
  | { kind: "enum"; values: readonly string[]; prefix: string }
  | { kind: "pct" }
  | { kind: "attempts" }
  | { kind: "minutes" };

const FIELDS: { field: RuleField; control: Control; levels: RulesLevel[] }[] = [
  { field: "sequentialModules", control: { kind: "bool" }, levels: ["syllabus"] },
  { field: "sequentialLessons", control: { kind: "bool" }, levels: ["syllabus", "module"] },
  { field: "moduleRequiresAllLessons", control: { kind: "bool" }, levels: ["syllabus", "module"] },
  { field: "theory", control: { kind: "enum", values: THEORY_RULES, prefix: "theory" }, levels: ["syllabus", "module", "lesson"] },
  { field: "teacherPractice", control: { kind: "enum", values: TEACHER_PRACTICE_RULES, prefix: "teacherPractice" }, levels: ["syllabus", "module", "lesson"] },
  { field: "studentPractice", control: { kind: "enum", values: STUDENT_PRACTICE_RULES, prefix: "studentPractice" }, levels: ["syllabus", "module", "lesson"] },
  { field: "practicePassPct", control: { kind: "pct" }, levels: ["syllabus", "module", "lesson"] },
  { field: "assessment", control: { kind: "enum", values: ASSESSMENT_RULES, prefix: "assessment" }, levels: ["syllabus", "module", "lesson"] },
  { field: "assessmentPassPct", control: { kind: "pct" }, levels: ["syllabus", "module", "lesson"] },
  { field: "retry.maxAttempts", control: { kind: "attempts" }, levels: ["syllabus", "module", "lesson"] },
  { field: "retry.cooldownMinutes", control: { kind: "minutes" }, levels: ["syllabus", "module", "lesson"] },
  { field: "retry.scorePolicy", control: { kind: "enum", values: SCORE_POLICIES, prefix: "scorePolicy" }, levels: ["syllabus", "module", "lesson"] },
  { field: "teacherApproval", control: { kind: "bool" }, levels: ["syllabus", "module", "lesson"] },
];

export const ruleFieldLabel = (field: RuleField) => t(`syllabus.rules.field.${field.replace("retry.", "retry_")}` as MessageKey);
export const ruleValueLabel = (prefix: string, value: string) => t(`syllabus.rules.${prefix}.${value}` as MessageKey);

const fieldSlug = (field: RuleField) => field.replace(".", "-");

/**
 * Completion rules for one level. Each rule is either inherited (shown read-only with where it
 * comes from) or overridden at this level via its checkbox.
 */
export function CompletionRulesForm({
  level,
  patch,
  inherited,
  onChange,
  idPrefix,
}: {
  level: RulesLevel;
  patch: CompletionRulesPatch | null;
  /** Rules this level inherits (parent's effective rules; the defaults at syllabus level). */
  inherited: CompletionRules;
  onChange: (patch: CompletionRulesPatch) => void;
  idPrefix: string;
}) {
  const effective = resolveRules(inherited, patch);
  const sourceLabel = level === "syllabus" ? t("syllabus.rules.fromDefault") : level === "module" ? t("syllabus.rules.fromSyllabus") : t("syllabus.rules.fromModule");
  return (
    <div className="divide-y divide-border rounded-xl border border-border">
      {FIELDS.filter((f) => f.levels.includes(level)).map(({ field, control }) => {
        const own = isOverridden(patch, field);
        const value = ruleValue(own ? effective : inherited, field);
        const id = `${idPrefix}-${fieldSlug(field)}`;
        const set = (v: unknown) => onChange(withOverride(patch, field, v));
        let input: React.ReactNode;
        if (control.kind === "bool") {
          input = (
            <label className="flex items-center gap-2 text-sm">
              <input id={id} type="checkbox" className="accent-link" disabled={!own} checked={value === true} onChange={(e) => set(e.target.checked)} />
              {value === true ? t("common.yes") : t("common.no")}
            </label>
          );
        } else if (control.kind === "enum") {
          input = (
            <select id={id} className={selectCls} disabled={!own} value={String(value)} onChange={(e) => set(e.target.value)} aria-label={ruleFieldLabel(field)}>
              {control.values.map((v) => <option key={v} value={v}>{ruleValueLabel(control.prefix, v)}</option>)}
            </select>
          );
        } else if (control.kind === "attempts") {
          input = (
            <select id={id} className={selectCls} disabled={!own} value={value === null ? "" : String(value)} onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))} aria-label={ruleFieldLabel(field)}>
              <option value="">{t("syllabus.rules.unlimited")}</option>
              {Array.from({ length: MAX_ATTEMPTS_LIMIT }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          );
        } else {
          const max = control.kind === "pct" ? 100 : 60 * 24 * 7;
          input = (
            <Input
              id={id}
              type="number"
              min={0}
              max={max}
              disabled={!own}
              value={Number(value)}
              onChange={(e) => set(Math.min(max, Math.max(0, Math.round(Number(e.target.value) || 0))))}
              aria-label={ruleFieldLabel(field)}
              className="w-28"
            />
          );
        }
        return (
          <div key={field} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] sm:items-center">
            <div className="min-w-0">
              <div className="text-sm font-medium">{ruleFieldLabel(field)}</div>
              <label className="mt-1 flex items-center gap-2 text-xs text-foreground-secondary">
                <input
                  type="checkbox"
                  className="accent-link"
                  checked={own}
                  onChange={(e) => onChange(e.target.checked ? withOverride(patch, field, ruleValue(inherited, field)) : withoutOverride(patch, field))}
                />
                {level === "syllabus" ? t("syllabus.rules.customize") : t("syllabus.rules.override")}
                {!own && <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{sourceLabel}</span>}
              </label>
            </div>
            <div>{input}</div>
          </div>
        );
      })}
    </div>
  );
}
