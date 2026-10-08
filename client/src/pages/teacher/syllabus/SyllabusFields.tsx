import { StoredFileUpload } from "@/components/syllabus/StoredFileUpload";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { groupLanguageLabel } from "@/lib/format";
import { fileDownloadUrl } from "@/lib/uploadFile";
import { fieldLabel, selectCls } from "./shared";

export interface SyllabusFieldValues {
  title: string;
  description: string;
  subject: string;
  level: string;
  language: string;
  estimatedDurationLabel: string;
  estimatedHours: string;
  coverFileId: string | null;
}

export const emptySyllabusFields: SyllabusFieldValues = {
  title: "",
  description: "",
  subject: "",
  level: "",
  language: "",
  estimatedDurationLabel: "",
  estimatedHours: "",
  coverFileId: null,
};

export function fieldsFromSyllabus(s: {
  title: string;
  description: string | null;
  subject: string;
  level: string;
  language: string;
  estimatedDurationLabel: string;
  estimatedHours: number | null;
  coverFileId: string | null;
}): SyllabusFieldValues {
  return {
    title: s.title,
    description: s.description ?? "",
    subject: s.subject,
    level: s.level,
    language: s.language,
    estimatedDurationLabel: s.estimatedDurationLabel,
    estimatedHours: s.estimatedHours === null ? "" : String(s.estimatedHours),
    coverFileId: s.coverFileId,
  };
}

export function fieldsPayload(f: SyllabusFieldValues) {
  const hours = f.estimatedHours.trim() === "" ? null : Math.max(0, Math.min(10_000, Math.round(Number(f.estimatedHours) || 0)));
  return {
    title: f.title.trim(),
    description: f.description,
    subject: f.subject.trim(),
    level: f.level.trim(),
    language: f.language.trim(),
    estimatedDurationLabel: f.estimatedDurationLabel.trim(),
    estimatedHours: hours,
    coverFileId: f.coverFileId,
  };
}

const LANGUAGES = ["az", "en", "ru"];
const LEVELS = ["beginner", "intermediate", "advanced"] as const;

export function SyllabusFieldsForm({ value, onChange, idPrefix }: { value: SyllabusFieldValues; onChange: (v: SyllabusFieldValues) => void; idPrefix: string }) {
  const set = (patch: Partial<SyllabusFieldValues>) => onChange({ ...value, ...patch });
  const languages = value.language && !LANGUAGES.includes(value.language) ? [...LANGUAGES, value.language] : LANGUAGES;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm sm:col-span-2">
        <span className={fieldLabel}>{t("common.required", { label: t("syllabus.field.title") })}</span>
        <Input required maxLength={255} value={value.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <label className="text-sm sm:col-span-2">
        <span className={fieldLabel}>{t("common.description")}</span>
        <Textarea rows={3} maxLength={20_000} value={value.description} onChange={(e) => set({ description: e.target.value })} />
      </label>
      <label className="text-sm">
        <span className={fieldLabel}>{t("syllabus.field.subject")}</span>
        <Input maxLength={120} value={value.subject} onChange={(e) => set({ subject: e.target.value })} placeholder={t("syllabus.field.subjectPlaceholder")} />
      </label>
      <label className="text-sm">
        <span className={fieldLabel}>{t("syllabus.field.level")}</span>
        <Input list={`${idPrefix}-levels`} maxLength={64} value={value.level} onChange={(e) => set({ level: e.target.value })} />
        <datalist id={`${idPrefix}-levels`}>
          {LEVELS.map((l) => <option key={l} value={t(`syllabus.level.${l}`)} />)}
        </datalist>
      </label>
      <label className="text-sm">
        <span className={fieldLabel}>{t("syllabus.field.language")}</span>
        <select className={selectCls} value={value.language} onChange={(e) => set({ language: e.target.value })}>
          <option value="">{t("syllabus.field.languageNone")}</option>
          {languages.map((l) => <option key={l} value={l}>{groupLanguageLabel(l)}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          <span className={fieldLabel}>{t("syllabus.field.duration")}</span>
          <Input maxLength={64} value={value.estimatedDurationLabel} onChange={(e) => set({ estimatedDurationLabel: e.target.value })} placeholder={t("syllabus.field.durationPlaceholder")} />
        </label>
        <label className="text-sm">
          <span className={fieldLabel}>{t("syllabus.field.hours")}</span>
          <Input type="number" min={0} max={10_000} value={value.estimatedHours} onChange={(e) => set({ estimatedHours: e.target.value })} />
        </label>
      </div>
      <div className="text-sm sm:col-span-2">
        <p className={`mb-1 ${fieldLabel}`}>{t("syllabus.field.cover")}</p>
        <div className="flex flex-wrap items-start gap-3">
          {value.coverFileId && <img src={fileDownloadUrl(value.coverFileId)} alt="" className="h-20 w-32 rounded-lg border border-border object-cover" />}
          <StoredFileUpload fileId={value.coverFileId ?? ""} name="" onChange={(f) => set({ coverFileId: f?.fileId ?? null })} />
        </div>
      </div>
    </div>
  );
}
