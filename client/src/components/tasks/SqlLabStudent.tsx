import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { type BrowserQueryResult, runBrowserPreview } from "@/lib/sqlLabDuckdb";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fileDownloadUrl } from "@/lib/uploadFile";
import { useRef, useState } from "react";
import { toast } from "sonner";

type StudentTask = RouterOutputs["student"]["tasks"][number];
export type StudentSqlLab = NonNullable<StudentTask["sqlLab"]>;
export type StudentSqlLabSubmission = NonNullable<
  StudentTask["sqlLabSubmission"]
>;

function ResultTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: unknown[][];
}) {
  if (!rows.length)
    return (
      <p className="text-xs text-muted-foreground">
        {t("student.sqlLab.noRows")}
      </p>
    );
  return (
    <div className="max-h-56 overflow-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted">
          <tr>
            {columns.map(c => (
              <th key={c} className="px-2 py-1 text-left font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border">
              {row.map((v, j) => (
                <td key={j} className="px-2 py-1">
                  {v === null ? (
                    <span className="text-muted-foreground">
                      {t("student.sqlLab.null")}
                    </span>
                  ) : (
                    String(v)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function submissionBadge(status: StudentSqlLabSubmission["status"]) {
  if (status === "CORRECT")
    return (
      <StatusBadge tone="success">{t("student.sqlLab.correct")}</StatusBadge>
    );
  if (status === "WRONG")
    return (
      <StatusBadge tone="warning">{t("student.sqlLab.wrong")}</StatusBadge>
    );
  if (status === "ERROR")
    return <StatusBadge tone="danger">{t("student.sqlLab.error")}</StatusBadge>;
  return (
    <StatusBadge tone="info">{t("student.sqlLab.pendingReview")}</StatusBadge>
  );
}

/**
 * A task's SQL Practice Lab, student side. "İşlət" runs entirely in the browser (DuckDB-Wasm, see
 * lib/sqlLabDuckdb.ts) against the dataset CSV for an instant look at the result -- this is a
 * preview only. "Göndər" sends just the query text to the server, which re-runs it independently in
 * its own sandbox and grades THAT result; the browser's own preview is never trusted for grading.
 */
export function SqlLabStudentPanel({
  taskId,
  sqlLab,
  submission,
}: {
  taskId: string;
  sqlLab: StudentSqlLab;
  submission: StudentSqlLabSubmission | null;
}) {
  const utils = trpc.useUtils();
  const [queryText, setQueryText] = useState(submission?.queryText ?? "");
  const [preview, setPreview] = useState<BrowserQueryResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const csvRef = useRef<string | null>(null);

  const submit = trpc.student.submitSqlLabQuery.useMutation({
    onSuccess: () => {
      toast.success(t("student.sqlLab.submitted"));
      void utils.student.tasks.invalidate();
    },
    onError: e => toast.error(errorText(e)),
  });

  async function loadCsv(): Promise<string> {
    if (csvRef.current !== null) return csvRef.current;
    const res = await fetch(fileDownloadUrl(sqlLab.datasetFileId), {
      credentials: "include",
    });
    if (!res.ok) throw new Error(t("student.sqlLab.datasetLoadFailed"));
    const text = await res.text();
    csvRef.current = text;
    return text;
  }

  async function run() {
    if (!queryText.trim()) return;
    setRunning(true);
    setPreviewError(null);
    try {
      const csv = await loadCsv();
      setPreview(await runBrowserPreview(csv, queryText));
    } catch (e) {
      setPreview(null);
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground-secondary">
          {t("student.sqlLab.title")}
        </p>
        {submission && submissionBadge(submission.status)}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("student.sqlLab.datasetColumns", {
          columns: sqlLab.datasetColumns.join(", "),
        })}
      </p>
      <Textarea
        className="font-mono text-sm"
        rows={4}
        value={queryText}
        onChange={e => setQueryText(e.target.value)}
        placeholder={t("student.sqlLab.queryPlaceholder")}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={running || !queryText.trim()}
          onClick={() => void run()}
        >
          {running ? t("student.sqlLab.running") : t("student.sqlLab.run")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={submit.isPending || !queryText.trim()}
          onClick={() => submit.mutate({ taskId, queryText })}
        >
          {submit.isPending ? t("student.sqlLab.submitting") : t("common.send")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t("student.sqlLab.previewDisclaimer")}
      </p>
      {previewError && (
        <p className="text-xs text-destructive">{previewError}</p>
      )}
      {preview && <ResultTable columns={preview.columns} rows={preview.rows} />}
      {submission?.status === "ERROR" && submission.errorMessage && (
        <p className="text-xs text-destructive">{submission.errorMessage}</p>
      )}
      {submission?.resultColumns && submission.resultRowsPreview && (
        <div>
          <p className="text-xs font-medium text-foreground-secondary">
            {t("student.sqlLab.serverResultLabel")}
          </p>
          <ResultTable
            columns={submission.resultColumns}
            rows={submission.resultRowsPreview as unknown[][]}
          />
        </div>
      )}
    </div>
  );
}
