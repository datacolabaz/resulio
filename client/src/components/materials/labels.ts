import { isMessageKey, t } from "@/i18n/messages";
import type { FieldDef, MaterialKind, MaterialTemplate, OptionSet } from "@shared/materialTemplates";

export const templateLabel = (template: MaterialTemplate) => t(`material.template.${template}`);
export const kindLabel = (kind: MaterialKind) => t(`material.kind.${kind}`);

export function fieldLabel(def: Pick<FieldDef, "key" | "label">): string {
  const key = `material.field.${def.label ?? def.key}`;
  return isMessageKey(key) ? t(key) : def.key;
}

/** A stored option code as text; anything typed under "Digər" is shown as typed. */
export function optionLabel(set: OptionSet, code: string): string {
  const key = `material.opt.${set}.${code}`;
  return isMessageKey(key) ? t(key) : code;
}
