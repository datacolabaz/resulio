import { CompactGroupStudentPicker, useGroupStudentTargets } from "@/components/GroupStudentPicker";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText, fromLocalInput, toLocalInput } from "@/lib/format";
import { recipientsPayload } from "@/lib/groupStudentSelection";
import { trpc } from "@/lib/trpc";
import type { UploadedFile } from "@/lib/uploadFile";
import {
  carryValues,
  compactValues,
  defaultTemplate,
  fieldsFor,
  LINK_FIRST_KINDS,
  MATERIAL_TEMPLATES,
  parseWebUrl,
  prefillFromGroups,
  savesAsTask,
  TEMPLATES,
  templateDefaults,
  type FieldKey,
  type MaterialKind,
  type MaterialTemplate,
  type MaterialValues,
  type MaterialVisibility,
} from "@shared/materialTemplates";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { fieldLabel, kindLabel, templateLabel } from "./labels";
import { MaterialSourceInput, type SourceMode } from "./MaterialSourceInput";
import { TemplateFields } from "./TemplateFields";

const labelText = "text-sm text-foreground-secondary";
const selectClass = "mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground";
const LAST_TEMPLATE_KEY = "resulio.material.lastTemplate";

function lastTemplate(): string | null {
  try {
    return localStorage.getItem(LAST_TEMPLATE_KEY);
  } catch {
    return null;
  }
}

export interface MaterialInitial {
  id: string;
  title: string;
  description: string;
  fileName: string;
  fileId: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  groupIds: string[];
  studentIds: number[];
  meta: {
    template: MaterialTemplate;
    kind: MaterialKind;
    status: "DRAFT" | "PUBLISHED";
    publishAt: Date | string | null;
    visibility: MaterialVisibility;
    notify: boolean;
    url: string | null;
    values: MaterialValues;
  };
}

type When = "NOW" | "SCHEDULE";

/** The template's kinds, plus the material's own kind when an older material has one the template does not list. */
function kindsFor(template: MaterialTemplate, current: MaterialKind | undefined): readonly MaterialKind[] {
  const kinds = TEMPLATES[template].kinds;
  return current && !kinds.includes(current) ? [...kinds, current] : kinds;
}

function RadioCard({ name, checked, onChange, label, hint }: { name: string; checked: boolean; onChange: () => void; label: string; hint?: string }) {
  return (
    <label className={`flex cursor-pointer gap-2 rounded-lg border p-2.5 text-sm ${checked ? "border-link bg-muted" : "border-border"}`}>
      <input type="radio" name={name} className="mt-0.5 accent-link" checked={checked} onChange={onChange} />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * New / edit material. The template decides the fields (shared/materialTemplates.ts); a material
 * that needs submissions (Layihə, Praktiki, kind Tapşırıq, or "Təhvil tələb olunur") is created
 * as a real task instead.
 */
export function MaterialFormDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (v: boolean) => void; initial?: MaterialInitial }) {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const ids = useId();
  const meta = initial?.meta;
  const workspace = trpc.teacher.workspace.useQuery(undefined, { enabled: !initial });
  const targets = useGroupStudentTargets(initial);
  const selectedGroups = targets.groups.filter((g) => targets.selection.groupIds.includes(g.id));

  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [templateChoice, setTemplateChoice] = useState<MaterialTemplate | null>(meta?.template ?? null);
  const template =
    templateChoice ?? defaultTemplate({ groupSubjects: selectedGroups.map((g) => g.subject), teachingCategory: workspace.data?.teachingCategory, lastUsed: lastTemplate() });
  const [kindChoice, setKindChoice] = useState<MaterialKind | null>(meta?.kind ?? null);
  const kinds = kindsFor(template, meta?.kind);
  const kind = kindChoice && kinds.includes(kindChoice) ? kindChoice : kinds[0];
  const [values, setValues] = useState<MaterialValues>(meta?.values ?? {});
  const [prefilled, setPrefilled] = useState<FieldKey[]>([]);

  const [modeChoice, setModeChoice] = useState<SourceMode | null>(meta ? (meta.url ? "LINK" : "FILE") : null);
  const mode: SourceMode = kind === "LINK" ? "LINK" : (modeChoice ?? (LINK_FIRST_KINDS.includes(kind) ? "LINK" : "FILE"));
  const [file, setFile] = useState<UploadedFile | null>(
    initial?.fileId ? { fileId: initial.fileId, name: initial.fileName, size: initial.sizeBytes ?? 0, mimeType: initial.mimeType ?? "" } : null,
  );
  const [url, setUrl] = useState(meta?.url ?? "");
  const [uploading, setUploading] = useState(false);
  const onBusy = useCallback((b: boolean) => setUploading(b), []);

  const scheduledNow = !!meta?.publishAt && new Date(meta.publishAt).getTime() > Date.now();
  const [when, setWhen] = useState<When>(scheduledNow ? "SCHEDULE" : "NOW");
  const [publishAt, setPublishAt] = useState(scheduledNow ? toLocalInput(meta!.publishAt) : "");
  const [visibility, setVisibility] = useState<MaterialVisibility>(meta?.visibility ?? "LINK");
  const [notify, setNotify] = useState(meta ? meta.notify : true);
  const [submission, setSubmission] = useState<boolean | null>(null);
  const submissionRequired = !initial && (submission ?? !!TEMPLATES[template].submissionByDefault);
  const asTask = !initial && savesAsTask(kind, submissionRequired);
  const promote: FieldKey[] = asTask ? ["dueAt"] : [];
  const moreFilled = !!meta && fieldsFor(meta.template, "more", meta.values).some((d) => meta.values[d.key] !== undefined);

  useEffect(() => {
    if (!initial) setValues((v) => ({ ...templateDefaults(template), ...v }));
  }, [template, initial]);

  const groupKey = targets.selection.groupIds.join(",");
  useEffect(() => {
    if (initial || !selectedGroups.length) return;
    const fill = prefillFromGroups(template, selectedGroups, values);
    const keys = Object.keys(fill) as FieldKey[];
    if (!keys.length) return;
    setValues((v) => ({ ...v, ...fill }));
    setPrefilled(keys);
    // Only when the groups or the template change; typed values are never overwritten.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey, template]);

  const changeTemplate = (to: MaterialTemplate) => {
    setTemplateChoice(to);
    setValues((v) => carryValues(to, v));
    setPrefilled([]);
  };

  const createMaterial = trpc.teacher.tasks.createMaterial.useMutation();
  const updateMaterial = trpc.teacher.tasks.updateMaterial.useMutation();
  const createTask = trpc.teacher.tasks.create.useMutation();
  const saveKey = trpc.teacher.tasks.saveAnswerKey.useMutation();
  const pending = createMaterial.isPending || updateMaterial.isPending || createTask.isPending || saveKey.isPending;

  const linkOk = parseWebUrl(url) !== null;
  // A task needs no file or link (its instructions may be enough); a material needs exactly one.
  const sourceOk = asTask ? mode === "FILE" || !url.trim() || linkOk : mode === "LINK" ? linkOk : !!file;
  const publishAtDate = fromLocalInput(publishAt);
  const scheduleOk = asTask || when === "NOW" || (!!publishAtDate && publishAtDate.getTime() > Date.now());
  const dueAt = values.dueAt instanceof Date ? values.dueAt : null;
  const taskOk = !asTask || !!dueAt;
  const canSave = title.trim().length >= 2 && sourceOk && scheduleOk && taskOk && targets.ready && !uploading && !pending;

  const remember = () => {
    try {
      localStorage.setItem(LAST_TEMPLATE_KEY, template);
    } catch {
      /* private mode */
    }
  };

  const saveAsTask = async () => {
    if (!dueAt) return;
    const { instructions, gradingCriteria, dueAt: _due, ...rest } = compactValues(template, values);
    const linkLine = mode === "LINK" && url.trim() ? t("material.form.linkInTask", { url: url.trim() }) : "";
    const task = await createTask.mutateAsync({
      title,
      description,
      instructions: [typeof instructions === "string" ? instructions : "", linkLine].filter(Boolean).join("\n\n"),
      deadline: dueAt,
      ...recipientsPayload(targets.selection, targets.students, { kept: targets.kept }),
      attachments: mode === "FILE" && file ? [{ fileId: file.fileId, name: file.name, size: file.size }] : [],
      notifyStudents: notify,
      meta: { template, kind, values: rest },
    });
    if (typeof gradingCriteria === "string" && gradingCriteria.trim()) {
      try {
        await saveKey.mutateAsync({ taskId: task.id, text: gradingCriteria });
      } catch {
        toast.error(t("modules.answerKeySaveFailed"));
      }
    }
    void utils.teacher.tasks.list.invalidate();
    toast.success(t("material.form.taskCreated"), { action: { label: t("material.form.openTasks"), onClick: () => navigate("/teacher/assignments") } });
  };

  const saveMaterial = async (asDraft: boolean) => {
    const details = { template, kind, values: compactValues(template, values) };
    const publishing = {
      status: asDraft ? ("DRAFT" as const) : ("PUBLISHED" as const),
      publishAt: !asDraft && when === "SCHEDULE" ? publishAtDate : null,
      visibility,
      notifyStudents: notify,
    };
    const base = { title, description, ...recipientsPayload(targets.selection, targets.students, { kept: targets.kept }) };
    const fileFields = mode === "FILE" && file ? { fileName: file.name, fileId: file.fileId, mimeType: file.mimeType || null, sizeBytes: file.size || null } : null;
    const linkUrl = mode === "LINK" ? url.trim() : "";
    if (initial) {
      // An unchanged file keeps its stored type and size.
      const fileChanged = fileFields && (fileFields.fileId !== initial.fileId || !!initial.meta.url);
      await updateMaterial.mutateAsync({ id: initial.id, patch: fileChanged ? { ...base, ...fileFields } : base, url: linkUrl, meta: details, ...publishing });
    } else {
      await createMaterial.mutateAsync({ ...base, ...(fileFields ?? { fileName: "" }), url: linkUrl || null, meta: details, ...publishing });
    }
    void utils.teacher.tasks.materials.invalidate();
  };

  const submit = async (asDraft = false) => {
    try {
      if (asTask) await saveAsTask();
      else await saveMaterial(asDraft);
    } catch (e) {
      toast.error(errorText(e));
      return;
    }
    remember();
    onOpenChange(false);
  };

  const wasDraft = meta?.status === "DRAFT";
  const showDraft = !asTask && (!initial || wasDraft || scheduledNow);
  const primaryLabel = asTask
    ? t("material.form.createTask")
    : when === "SCHEDULE"
      ? t("material.form.scheduleSave")
      : initial && !wasDraft && !scheduledNow
        ? t("common.save")
        : t("material.form.shareNow");
  const fieldNames = prefilled.map((k) => fieldLabel(TEMPLATES[template].fields.find((f) => f.key === k) ?? { key: k })).join(", ");

  return (
    <Dialog open={open} onOpenChange={(v) => !uploading && onOpenChange(v)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{initial ? t("modules.editMaterialTitle") : t("modules.newMaterialTitle")}</DialogTitle></DialogHeader>
        <DialogBody className="grid content-start gap-4">
          <label className="text-sm">
            <span className={labelText}>{t("common.required", { label: t("modules.materialName") })}</span>
            <Input required maxLength={255} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${ids}-template`} className={labelText}>{t("material.form.template")}</label>
              <select id={`${ids}-template`} className={selectClass} value={template} onChange={(e) => changeTemplate(e.target.value as MaterialTemplate)}>
                {MATERIAL_TEMPLATES.map((tpl) => (
                  <option key={tpl} value={tpl}>{templateLabel(tpl)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${ids}-kind`} className={labelText}>{t("material.form.kind")}</label>
              <select id={`${ids}-kind`} className={selectClass} value={kind} disabled={uploading} onChange={(e) => setKindChoice(e.target.value as MaterialKind)}>
                {kinds.map((k) => (
                  <option key={k} value={k}>{kindLabel(k)}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <p className={`mb-1 ${labelText}`}>
              {asTask ? t("material.form.source") : t("common.required", { label: kind === "LINK" ? t("material.form.tabLink") : t("material.form.source") })}
            </p>
            <MaterialSourceInput kind={kind} mode={mode} onMode={setModeChoice} file={file} onFile={setFile} url={url} onUrl={setUrl} onBusy={onBusy} />
          </div>

          <TemplateFields template={template} section="main" values={values} onChange={setValues} promote={promote} />
          {prefilled.length > 0 && <p className="-mt-2 text-xs text-muted-foreground">{t("material.form.prefilled", { fields: fieldNames })}</p>}

          {!initial && kind !== "TASK" && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 accent-link" checked={submissionRequired} onChange={(e) => setSubmission(e.target.checked)} />
              <span className="min-w-0">
                <span className="block">{t("material.form.submission")}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t("material.form.submissionHint")}</span>
              </span>
            </label>
          )}
          {asTask && (
            <div className="grid gap-1 rounded-lg border border-info/40 bg-info-surface p-2.5 text-xs text-info">
              <span>{t("material.form.taskPublishNote")}</span>
              {!dueAt && <span role="alert" className="font-medium">{t("material.form.dueRequired")}</span>}
            </div>
          )}

          <section aria-labelledby={`${ids}-sharing`} className="grid gap-2 border-t pt-3">
            <h3 id={`${ids}-sharing`} className="text-sm font-semibold">{t("modules.materialSharing")}</h3>
            <CompactGroupStudentPicker
              groups={targets.groups}
              students={targets.students}
              value={targets.selection}
              onChange={targets.setSelection}
              keptCount={targets.kept.length}
              hints={{ whole: t("modules.materialGroupWhole"), partial: t("modules.materialGroupPartial") }}
            />
          </section>

          <Accordion type="single" collapsible defaultValue={initial?.description || moreFilled || wasDraft || scheduledNow || meta?.visibility === "RECIPIENTS" ? "details" : undefined}>
            <AccordionItem value="details" className="rounded-lg border px-3 last:border-b">
              <AccordionTrigger className="py-3">
                <span className="min-w-0">
                  <span className="block">{t("modules.advancedOptions")}</span>
                  <span className="block text-xs font-normal text-muted-foreground">{t("modules.advancedOptionsHint")}</span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="grid gap-4">
                <TemplateFields template={template} section="more" values={values} onChange={setValues} promote={promote} />
                <label className="text-sm">
                  <span className={labelText}>{t("common.description")}</span>
                  <Textarea rows={3} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />
                </label>
                {!asTask && (
                  <>
                    <fieldset>
                      <legend className={`mb-1 ${labelText}`}>{t("material.form.visibility")}</legend>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {(["LINK", "RECIPIENTS"] as const).map((v) => (
                          <RadioCard
                            key={v}
                            name={`${ids}-visibility`}
                            checked={visibility === v}
                            onChange={() => setVisibility(v)}
                            label={t(`material.form.visibility${v}`)}
                            hint={t(`material.form.visibility${v}Hint`)}
                          />
                        ))}
                      </div>
                    </fieldset>
                    <fieldset>
                      <legend className={`mb-1 ${labelText}`}>{t("material.form.when")}</legend>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <RadioCard name={`${ids}-when`} checked={when === "NOW"} onChange={() => setWhen("NOW")} label={t("material.form.whenNOW")} />
                        <RadioCard name={`${ids}-when`} checked={when === "SCHEDULE"} onChange={() => setWhen("SCHEDULE")} label={t("material.form.whenSCHEDULE")} />
                      </div>
                      {when === "SCHEDULE" && (
                        <label className="mt-2 block text-sm">
                          <span className={labelText}>{t("material.form.publishAt")}</span>
                          <Input type="datetime-local" value={publishAt} aria-invalid={!scheduleOk} onChange={(e) => setPublishAt(e.target.value)} className="mt-1 sm:w-64" />
                          {!scheduleOk && <span role="alert" className="mt-1 block text-xs text-destructive">{t("material.form.publishAtFuture")}</span>}
                        </label>
                      )}
                      {showDraft && <p className="mt-1 text-xs text-muted-foreground">{t("material.form.draftHint")}</p>}
                    </fieldset>
                  </>
                )}
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 accent-link" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                  <span className="min-w-0">
                    <span className="block">{t("modules.notifyStudents")}</span>
                    {!asTask && when === "SCHEDULE" && <span className="mt-0.5 block text-xs text-muted-foreground">{t("material.form.notifyScheduled")}</span>}
                  </span>
                </label>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </DialogBody>
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" disabled={uploading} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          {showDraft && (
            <Button variant="outline" disabled={!canSave} onClick={() => void submit(true)}>{t("material.form.saveDraft")}</Button>
          )}
          <Button disabled={!canSave} onClick={() => void submit(false)}>{primaryLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
