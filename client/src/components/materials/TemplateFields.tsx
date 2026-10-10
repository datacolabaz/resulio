import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { fromLocalInput, toLocalInput } from "@/lib/format";
import { fieldsFor, OPTION_SETS, TAG_FIELD, type FieldDef, type FieldKey, type FieldValue, type MaterialTemplate, type MaterialValues } from "@shared/materialTemplates";
import { useId } from "react";
import { fieldLabel, optionLabel } from "./labels";
import { TagInput } from "./TagInput";

const labelText = "text-sm text-foreground-secondary";
const selectClass = "mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground";

function SelectField({ def, value, onChange }: { def: FieldDef; value: FieldValue | undefined; onChange: (v: FieldValue | undefined) => void }) {
  const id = useId();
  const codes = def.optionSet ? (OPTION_SETS[def.optionSet] as readonly string[]) : [];
  const text = typeof value === "string" ? value : "";
  const typed = def.allowOther && text !== "" && !codes.includes(text);
  const selected = typed ? "OTHER" : text;
  return (
    <div>
      <label htmlFor={id} className={labelText}>{fieldLabel(def)}</label>
      <select id={id} className={selectClass} value={selected} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{t("material.form.selectPlaceholder")}</option>
        {codes.map((c) => (
          <option key={c} value={c}>{optionLabel(def.optionSet!, c)}</option>
        ))}
      </select>
      {def.allowOther && selected === "OTHER" && (
        <Input
          className="mt-1.5"
          aria-label={`${fieldLabel(def)}: ${t("material.form.otherPlaceholder")}`}
          placeholder={t("material.form.otherPlaceholder")}
          maxLength={64}
          value={typed ? text : ""}
          onChange={(e) => onChange(e.target.value.trim() ? e.target.value : "OTHER")}
        />
      )}
    </div>
  );
}

function Field({ def, value, onChange }: { def: FieldDef; value: FieldValue | undefined; onChange: (v: FieldValue | undefined) => void }) {
  const id = useId();
  const label = fieldLabel(def);
  switch (def.type) {
    case "select":
      return <SelectField def={def} value={value} onChange={onChange} />;
    case "tags":
      return (
        <div className="sm:col-span-2">
          <label htmlFor={id} className={labelText}>{label}</label>
          <div className="mt-1">
            <TagInput id={id} label={label} type={TAG_FIELD[def.key] ?? "TOPIC"} value={Array.isArray(value) ? value : []} onChange={(v) => onChange(v.length ? v : undefined)} />
          </div>
        </div>
      );
    case "number":
      return (
        <label className="block">
          <span className={labelText}>{label}</span>
          <Input
            className="mt-1"
            type="number"
            inputMode={def.step && def.step < 1 ? "decimal" : "numeric"}
            min={def.min}
            max={def.max}
            step={def.step ?? 1}
            value={typeof value === "number" ? String(value) : ""}
            onChange={(e) => {
              const n = e.target.value === "" ? undefined : Number(e.target.value);
              onChange(n === undefined || Number.isNaN(n) ? undefined : n);
            }}
          />
        </label>
      );
    case "date":
      return (
        <label className="block">
          <span className={labelText}>{label}</span>
          <Input className="mt-1" type="datetime-local" value={value instanceof Date ? toLocalInput(value) : ""} onChange={(e) => onChange(fromLocalInput(e.target.value) ?? undefined)} />
        </label>
      );
    case "url":
      return (
        <label className="block sm:col-span-2">
          <span className={labelText}>{label}</span>
          <Input className="mt-1" type="url" inputMode="url" placeholder={t("syllabus.urlPlaceholder")} maxLength={2048} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />
        </label>
      );
    case "textarea":
      return (
        <label className="block sm:col-span-2">
          <span className={labelText}>{label}</span>
          <Textarea className="mt-1" rows={3} maxLength={def.max} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />
        </label>
      );
    case "text":
      return (
        <label className="block">
          <span className={labelText}>{label}</span>
          <Input className="mt-1" maxLength={def.max} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />
        </label>
      );
  }
}

/** The fields this template adds to one part of the form, in the template's order. */
export function TemplateFields({
  template,
  section,
  values,
  onChange,
  promote,
}: {
  template: MaterialTemplate;
  section: "main" | "more";
  values: MaterialValues;
  onChange: (v: MaterialValues) => void;
  promote?: readonly FieldKey[];
}) {
  const defs = fieldsFor(template, section, values, promote);
  if (!defs.length) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {defs.map((def) => (
        <Field
          key={def.key}
          def={def}
          value={values[def.key]}
          onChange={(v) => {
            const next = { ...values };
            if (v === undefined) delete next[def.key];
            else next[def.key] = v;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}
