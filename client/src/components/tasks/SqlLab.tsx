import { Loading } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { SingleFileUpload } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { type UploadedFile } from "@/lib/uploadFile";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const fieldLabel = "text-foreground-secondary";
const selectClass =
  "mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-foreground";

/** Mirrors drizzle/schema.ts's SQL_LAB_GRADE_MODES -- kept as a local literal union the same way
 *  this codebase's other client code mirrors server-side enums (see TeacherModules.tsx's own local
 *  `TaskAccessMode` type) rather than importing the drizzle schema module into the client bundle. */
const SQL_LAB_GRADE_MODES = [
  "EXACT_ORDERED",
  "EXACT_UNORDERED",
  "ROW_COUNT_ONLY",
] as const;
type SqlLabGradeMode = (typeof SQL_LAB_GRADE_MODES)[number];

function gradeModeLabel(mode: SqlLabGradeMode) {
  return t(`modules.sqlLab.gradeMode.${mode}` as const);
}

/**
 * A task's optional SQL Practice Lab: attach a CSV dataset + a reference query. Saving actually
 * runs the reference query against the dataset in the server's sandbox (same one a student's
 * submission is graded in -- see server/modules/sqlLab.ts), so a broken query or an empty/malformed
 * CSV is caught right here, not discovered later from a student's failed submission.
 */
export function SqlLabConfigSection({ taskId }: { taskId: string }) {
  const utils = trpc.useUtils();
  const config = trpc.teacher.tasks.sqlLabConfig.useQuery({ id: taskId });
  const [dataset, setDataset] = useState<UploadedFile | null>(null);
  const [referenceQuery, setReferenceQuery] = useState("");
  const [gradeMode, setGradeMode] =
    useState<SqlLabGradeMode>("EXACT_UNORDERED");

  useEffect(() => {
    if (!config.data) return;
    setDataset({
      fileId: config.data.datasetFileId,
      name: "",
      size: 0,
      mimeType: "text/csv",
    });
    setReferenceQuery(config.data.referenceQuery);
    setGradeMode(config.data.gradeMode);
  }, [config.data]);

  const invalidate = () =>
    void utils.teacher.tasks.sqlLabConfig.invalidate({ id: taskId });
  const save = trpc.teacher.tasks.sqlLabSaveConfig.useMutation({
    onSuccess: invalidate,
    onError: e => toast.error(errorText(e)),
  });
  const remove = trpc.teacher.tasks.sqlLabRemoveConfig.useMutation({
    onSuccess: () => {
      setDataset(null);
      setReferenceQuery("");
      invalidate();
    },
    onError: e => toast.error(errorText(e)),
  });

  if (config.isLoading) return <Loading />;

  const canSave = !!dataset && referenceQuery.trim().length > 0;

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{t("modules.sqlLab.title")}</h3>
        {config.data && (
          <StatusBadge tone="success">
            {t("modules.sqlLab.configured")}
          </StatusBadge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("modules.sqlLab.hint")}
      </p>

      <div>
        <p className={`mb-1 text-sm ${fieldLabel}`}>
          {t("modules.sqlLab.dataset")}
        </p>
        <SingleFileUpload
          context="task-attachment"
          taskId={taskId}
          value={dataset}
          onChange={setDataset}
        />
      </div>

      <label className="block text-sm">
        <span className={fieldLabel}>{t("modules.sqlLab.referenceQuery")}</span>
        <Textarea
          className="mt-1 font-mono text-sm"
          rows={5}
          value={referenceQuery}
          onChange={e => setReferenceQuery(e.target.value)}
          placeholder={t("modules.sqlLab.referenceQueryPlaceholder")}
        />
      </label>

      <label className="block text-sm">
        <span className={fieldLabel}>{t("modules.sqlLab.gradeModeLabel")}</span>
        <select
          className={selectClass}
          value={gradeMode}
          onChange={e => setGradeMode(e.target.value as SqlLabGradeMode)}
        >
          {SQL_LAB_GRADE_MODES.map(m => (
            <option key={m} value={m}>
              {gradeModeLabel(m)}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-muted-foreground">
          {t(`modules.sqlLab.gradeModeHint.${gradeMode}` as const)}
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!canSave || save.isPending}
          onClick={() =>
            dataset &&
            save.mutate({
              id: taskId,
              datasetFileId: dataset.fileId,
              referenceQuery: referenceQuery.trim(),
              gradeMode,
            })
          }
        >
          {save.isPending ? t("modules.sqlLab.saving") : t("common.save")}
        </Button>
        {config.data && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ id: taskId })}
          >
            <Trash2 className="h-4 w-4" aria-hidden /> {t("common.remove")}
          </Button>
        )}
      </div>
    </div>
  );
}
