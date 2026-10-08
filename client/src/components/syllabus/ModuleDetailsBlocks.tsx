import { t } from "@/i18n/messages";
import { hasAssessmentDetails, hasModuleDetails, type ModuleDetails } from "@shared/syllabusModuleDetails";

type Heading = "h3" | "h4";

function Block({ emoji, title, as: H, wide, children }: { emoji: string; title: string; as: Heading; wide?: boolean; children: React.ReactNode }) {
  return (
    <section className={`min-w-0 rounded-xl border border-border bg-muted/40 p-3 sm:p-4 ${wide ? "md:col-span-2" : ""}`}>
      <H className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
        <span aria-hidden className="text-base leading-none">{emoji}</span>
        {title}
      </H>
      {children}
    </section>
  );
}

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="ml-5 list-disc space-y-1 text-sm text-foreground-secondary marker:text-muted-foreground">
      {items.map((item, i) => (
        <li key={i} className="break-words">{item}</li>
      ))}
    </ul>
  );
}

/** Objectives, prerequisites and module assessment at the end of a module; nothing when the module has none. */
export function ModuleDetailsBlocks({ details, as = "h3", className = "" }: { details: ModuleDetails | null | undefined; as?: Heading; className?: string }) {
  if (!hasModuleDetails(details)) return null;
  const { objectives, prerequisites, assessment: a } = details;
  const pair = objectives.length > 0 && prerequisites.length > 0;
  return (
    <div className={`grid gap-3 md:grid-cols-2 ${className}`}>
      {objectives.length > 0 && (
        <Block emoji="🎯" title={t("moduleDetails.objectives")} as={as} wide={!pair}>
          <Bullets items={objectives} />
        </Block>
      )}
      {prerequisites.length > 0 && (
        <Block emoji="📋" title={t("moduleDetails.prerequisites")} as={as} wide={!pair}>
          <Bullets items={prerequisites} />
        </Block>
      )}
      {hasAssessmentDetails(a) && (
        <Block emoji="📝" title={t("moduleDetails.assessment")} as={as} wide>
          <div className="space-y-2">
            {a.heading && <p className="break-words text-sm font-semibold text-foreground">{a.heading}</p>}
            {a.intro && <p className="break-words text-sm text-foreground-secondary">{a.intro}</p>}
            {a.pipeline && <p className="break-words rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium leading-relaxed text-foreground">{a.pipeline}</p>}
            {a.listIntro && <p className="break-words text-sm text-foreground-secondary">{a.listIntro}</p>}
            {a.items.length > 0 && <Bullets items={a.items} />}
          </div>
        </Block>
      )}
    </div>
  );
}
