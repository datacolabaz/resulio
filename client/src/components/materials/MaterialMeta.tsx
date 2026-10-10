import { Pill } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { t } from "@/i18n/messages";
import { fmtDateTime } from "@/lib/format";
import { linkHost, TEMPLATES, type FieldValue, type MaterialKind, type MaterialTemplate, type MaterialValues } from "@shared/materialTemplates";
import { ExternalLink } from "lucide-react";
import { kindLabel, optionLabel, templateLabel } from "./labels";

export interface MaterialMetaView {
  template: MaterialTemplate;
  kind: MaterialKind;
  dueAt: Date | string | null;
  values: MaterialValues;
  url: string | null;
  status?: "DRAFT" | "PUBLISHED";
  publishAt?: Date | string | null;
  visibility?: "LINK" | "RECIPIENTS";
}

const text = (v: FieldValue | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The select values worth a chip on a card (level, skill, exam type…), as labels. */
function keyChips(meta: MaterialMetaView): string[] {
  const out: string[] = [];
  for (const def of TEMPLATES[meta.template].fields) {
    if (def.type !== "select" || def.key === "purpose" || def.key === "feedbackFormat" || def.key === "submissionFormat") continue;
    const v = text(meta.values[def.key]);
    if (v && def.optionSet) out.push(optionLabel(def.optionSet, v));
  }
  const grade = text(meta.values.grade);
  if (grade) out.push(grade);
  return out.slice(0, 4);
}

/**
 * Kind, template, status (teacher only), due date, key fields and tags of a material card.
 * Everything is plain text: tags and typed values are never rendered as HTML.
 */
export function MaterialMeta({ meta, now = Date.now() }: { meta: MaterialMetaView; now?: number }) {
  const tags = [...(Array.isArray(meta.values.topics) ? meta.values.topics : []), ...(Array.isArray(meta.values.technologies) ? meta.values.technologies : [])];
  const scheduled = meta.status === "PUBLISHED" && meta.publishAt && new Date(meta.publishAt).getTime() > now;
  const minutes = typeof meta.values.estimatedMinutes === "number" ? meta.values.estimatedMinutes : null;
  return (
    <div className="mt-2 grid gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill>{kindLabel(meta.kind)}</Pill>
        {meta.template !== "GENERAL" && <Pill>{templateLabel(meta.template)}</Pill>}
        {meta.status === "DRAFT" && <StatusBadge tone="neutral">{t("material.card.draft")}</StatusBadge>}
        {scheduled && <StatusBadge tone="info">{t("material.card.scheduled", { date: fmtDateTime(meta.publishAt!) })}</StatusBadge>}
        {meta.visibility === "RECIPIENTS" && <Pill>{t("material.card.recipientsOnly")}</Pill>}
        {meta.dueAt && <StatusBadge tone="warning">{t("material.card.due", { date: fmtDateTime(meta.dueAt) })}</StatusBadge>}
        {minutes && <span className="text-xs text-muted-foreground">{t("material.card.minutes", { count: minutes })}</span>}
      </div>
      {(keyChips(meta).length > 0 || tags.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {keyChips(meta).map((c) => (
            <span key={`k-${c}`} className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground-secondary">{c}</span>
          ))}
          {tags.slice(0, 8).map((tag) => (
            <span key={`t-${tag}`} className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">#{tag}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Aç: youtube.com" for a link material; opens in a new tab without the app as referrer. */
export function MaterialLinkButton({ url, onOpen }: { url: string; onOpen?: () => void }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={onOpen}
      className="mt-2 inline-flex max-w-full items-center gap-1 break-all rounded-lg border border-border bg-muted px-2 py-1 text-xs text-link underline-offset-2 hover:underline"
    >
      <ExternalLink className="size-3 shrink-0" aria-hidden />
      {t("material.card.open")}: {linkHost(url)}
    </a>
  );
}
