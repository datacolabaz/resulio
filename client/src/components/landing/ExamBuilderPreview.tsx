import { Pill } from "@/components/AppShell";
import { buttonVariants } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { questionTypeLabel } from "@/lib/format";
import { QUESTION_TYPES } from "@shared/assessment";
import { Eye, GripVertical } from "lucide-react";
import { DEMO } from "./demoData";

const STEPS = ["builder.step.basics", "builder.step.questions", "builder.step.participants", "builder.step.rules", "builder.step.publish"] as const;

/** Three representative rows out of the demo exam's 12 questions — enough to show the real list shape without padding the mockup. */
const SAMPLE_ROWS = [
  { type: "MULTIPLE_CHOICE" as const, n: 1, textKey: "landing.preview.sampleQuestion2" as const },
  { type: "FILL_BLANK" as const, n: 2, textKey: "landing.preview.sampleQuestion3" as const },
  { type: "NUMERIC" as const, n: 7, textKey: "landing.preview.sampleQuestion" as const },
];

/**
 * Section 1 preview: a cut-down version of the real exam builder (ExamBuilder.tsx), static and
 * non-operable (plain div/span, no real inputs or buttons) — see HeroDashboardPreview for why.
 */
export function ExamBuilderPreview() {
  return (
    <div role="img" aria-label={t("landing.preview.builderSummary")} className="p-4 text-left sm:p-5">
      <nav aria-hidden className="flex flex-wrap gap-2 border-b border-border pb-4">
        {STEPS.map((key, i) => (
          <span key={key} className={`rounded-full px-3 py-1 text-xs font-medium ${i === 1 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
            {t(key)}
          </span>
        ))}
      </nav>
      <div aria-hidden className="mt-4 space-y-4">
        <div>
          <p className="truncate text-sm font-semibold">{t("landing.preview.examTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("landing.preview.groupName")}</p>
        </div>

        <div>
          <p className="text-sm font-semibold">{t("builder.questionsTitle", { count: DEMO.builderQuestionCount, points: DEMO.builderPointsTotal })}</p>
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {SAMPLE_ROWS.map((row) => (
              <li key={row.n} className="flex items-center gap-3 px-3 py-2.5">
                <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Pill className="shrink-0">{questionTypeLabel(row.type)}</Pill>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {row.n}. {t(row.textKey)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground">{t("landing.section.builder.detail")}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUESTION_TYPES.map((qt) => (
              <Pill key={qt}>{questionTypeLabel(qt)}</Pill>
            ))}
          </div>
        </div>

        <span className={buttonVariants({ variant: "outline", size: "sm", className: "pointer-events-none" })}>
          <Eye className="h-3.5 w-3.5" /> {t("builder.step.publish")}
        </span>
      </div>
    </div>
  );
}
