import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { StatusBadge, toneSurface, type Tone } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime, fmtNumber } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { formatFileSize } from "@/lib/uploadFile";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAdmin } from "./adminShared";

type Status = RouterOutputs["admin"]["storage"]["r2"]["status"];
type Job = NonNullable<Status["job"]>;
type Plan = RouterOutputs["admin"]["storage"]["r2"]["plan"];

const POLL_MS = 2000;
const isLive = (job: Job | null | undefined) => job?.status === "running" && !job.interrupted;

function statusOf(job: Job): { tone: Tone; label: string } {
  if (job.interrupted) return { tone: "warning", label: t("admin.r2.status.interrupted") };
  if (job.status === "running") return job.cancelRequested ? { tone: "warning", label: t("admin.r2.status.cancelling") } : { tone: "info", label: t("admin.r2.status.running") };
  if (job.status === "done") return job.failed ? { tone: "warning", label: t("admin.r2.status.done") } : { tone: "success", label: t("admin.r2.status.done") };
  if (job.status === "cancelled") return { tone: "neutral", label: t("admin.r2.status.cancelled") };
  return { tone: "danger", label: t("admin.r2.status.failed") };
}

function ProgressBar({ ratio }: { ratio: number }) {
  const percent = Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
  return (
    <div role="progressbar" aria-label={t("admin.r2.progressLabel")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
    </div>
  );
}

function PlanResult({ plan }: { plan: Plan }) {
  const problems: string[] = [];
  if (!plan.connection.ok) problems.push(t("admin.r2.plan.connection", { error: plan.connection.error }));
  if (plan.missingData) problems.push(t("admin.r2.plan.missingData", { count: fmtNumber(plan.missingData) }));
  if (plan.inOtherBucket) problems.push(t("admin.r2.plan.otherBucket", { count: fmtNumber(plan.inOtherBucket) }));
  return (
    <div className="mt-3 space-y-3">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border p-3">
          <dt className="text-xs uppercase text-muted-foreground">{t("admin.r2.plan.toCopy")}</dt>
          <dd className="mt-1 text-base font-semibold tabular-nums">{t("admin.r2.plan.files", { count: fmtNumber(plan.toCopy.count), size: formatFileSize(plan.toCopy.bytes) })}</dd>
          {plan.toCopy.count > 0 && <dd className="text-xs text-muted-foreground">{t("admin.r2.plan.largest", { size: formatFileSize(plan.toCopy.largestBytes) })}</dd>}
        </div>
        <div className="rounded-lg border p-3">
          <dt className="text-xs uppercase text-muted-foreground">{t("admin.r2.plan.inBucket")}</dt>
          <dd className="mt-1 text-base font-semibold tabular-nums">{t("admin.r2.plan.files", { count: fmtNumber(plan.inBucket.count), size: formatFileSize(plan.inBucket.bytes) })}</dd>
        </div>
      </dl>
      {problems.length ? (
        <ul className={`space-y-1 rounded-lg border p-3 text-sm ${toneSurface(plan.connection.ok ? "warning" : "danger")}`}>
          {problems.map((p) => (
            <li key={p} className="break-words">{p}</li>
          ))}
        </ul>
      ) : (
        <StatusBadge tone="success">{plan.toCopy.count ? t("admin.r2.plan.ok") : t("admin.r2.plan.nothing")}</StatusBadge>
      )}
    </div>
  );
}

function JobCard({ job, canRun, onCancel, onResume, pending }: { job: Job; canRun: boolean; onCancel: () => void; onResume: () => void; pending: boolean }) {
  const { tone, label } = statusOf(job);
  const ratio = job.total ? job.processed / job.total : job.status === "running" ? 0 : 1;
  const live = isLive(job);
  return (
    <section aria-live="polite" className="mt-5 space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{job.kind === "copy" ? t("admin.r2.job.copy") : t("admin.r2.job.verify")}</h3>
        <StatusBadge tone={tone}>{label}</StatusBadge>
      </div>
      <ProgressBar ratio={ratio} />
      <p className="text-sm tabular-nums">
        {t("admin.r2.progress", {
          done: fmtNumber(job.processed),
          total: fmtNumber(job.total),
          bytes: formatFileSize(job.bytesDone),
          totalBytes: formatFileSize(job.totalBytes),
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {job.kind === "copy"
          ? t("admin.r2.copyCounts", { ok: fmtNumber(job.ok), skipped: fmtNumber(job.skipped), failed: fmtNumber(job.failed) })
          : t("admin.r2.verifyCounts", { ok: fmtNumber(job.ok + job.skipped), failed: fmtNumber(job.failed) })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("admin.r2.startedAt", { date: fmtDateTime(job.startedAt) })}
        {job.finishedAt && ` · ${t("admin.r2.finishedAt", { date: fmtDateTime(job.finishedAt) })}`}
      </p>
      {job.message && <p className={`rounded-lg border p-3 text-sm ${toneSurface("danger")}`}>{t("admin.r2.failedWith", { error: job.message })}</p>}
      {job.interrupted && <p className={`rounded-lg border p-3 text-sm ${toneSurface("warning")}`}>{t("admin.r2.interruptedNote")}</p>}
      {canRun && (live || job.interrupted) && (
        <div className="flex flex-wrap gap-2">
          {job.interrupted && (
            <Button onClick={onResume} disabled={pending}>
              {t("admin.r2.resume")}
            </Button>
          )}
          <Button variant="outline" onClick={onCancel} disabled={pending || job.cancelRequested}>
            {t("admin.r2.cancel")}
          </Button>
        </div>
      )}
      {job.errors.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">{t("admin.r2.errorsTitle")}</h4>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border text-sm">
            {job.errors.map((e) => (
              <li key={e.fileId} className="px-3 py-2">
                <div className="break-all font-medium">{e.fileName}</div>
                <div className="break-words text-xs text-muted-foreground">{e.error}</div>
              </li>
            ))}
          </ul>
          {job.failed > job.errors.length && <p className="text-xs text-muted-foreground">{t("admin.r2.moreErrors", { count: fmtNumber(job.failed - job.errors.length) })}</p>}
          {job.kind === "copy" && !live && <p className="text-xs text-muted-foreground">{t("admin.r2.retryHint")}</p>}
        </div>
      )}
    </section>
  );
}

function Step({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h3 className="font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * "Faylları R2-yə köçür": dry run, background copy with progress / cancel, then a verification
 * pass. All work happens server-side; this only starts it and polls. Purging the MySQL copies is
 * deliberately not here (CLI only, after a backup).
 */
export function R2MigrationPanel() {
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const canRun = can("storage.migrate");
  const [confirming, setConfirming] = useState(false);
  const status = trpc.admin.storage.r2.status.useQuery(undefined, {
    refetchInterval: (query) => (isLive(query.state.data?.job) ? POLL_MS : false),
  });
  const plan = trpc.admin.storage.r2.plan.useMutation({ onError: (e) => toast.error(errorText(e)) });
  const refresh = () => void utils.admin.storage.r2.status.invalidate();
  const start = trpc.admin.storage.r2.start.useMutation({
    onSuccess: (job) => {
      toast.success(job.kind === "copy" ? t("admin.r2.copyStarted") : t("admin.r2.verifyStarted"));
      setConfirming(false);
      refresh();
    },
    onError: (e) => {
      toast.error(errorText(e));
      refresh();
    },
  });
  const cancel = trpc.admin.storage.r2.cancel.useMutation({
    onSuccess: () => {
      toast.success(t("admin.r2.cancelRequested"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const job = status.data?.job ?? null;
  const live = isLive(job);
  const wasLive = useRef(live);
  const resetPlan = plan.reset;
  useEffect(() => {
    if (wasLive.current && !live) {
      resetPlan();
      void utils.admin.storage.summary.invalidate();
    }
    wasLive.current = live;
  }, [live, resetPlan, utils]);

  if (status.error) return <ErrorNote error={status.error} />;
  if (!status.data) return <Loading />;
  const s = status.data;

  if (!s.configured) {
    return (
      <Panel id="r2-migration" title={t("admin.r2.title")}>
        <p className="text-sm">{t("admin.r2.off")}</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {s.missingEnv.map((name) => (
            <li key={name}>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{name}</code>
            </li>
          ))}
        </ul>
      </Panel>
    );
  }

  const ready = !!plan.data && plan.data.connection.ok && plan.data.toCopy.count > 0;
  const busy = live || start.isPending;
  return (
    <Panel id="r2-migration" title={t("admin.r2.title")}>
      <p className="text-sm text-muted-foreground">{t("admin.r2.intro", { bucket: s.bucket ?? "" })}</p>
      <p className={`mt-3 rounded-lg border p-3 text-sm ${toneSurface("info")}`}>{t("admin.r2.keepNote")}</p>

      {canRun ? (
        <div className="mt-5 space-y-4">
          <Step title={t("admin.r2.step1")} hint={t("admin.r2.step1Hint")}>
            <Button variant="outline" onClick={() => plan.mutate()} disabled={plan.isPending || busy}>
              {plan.isPending ? t("common.loading") : t("admin.r2.step1")}
            </Button>
          </Step>
          {plan.data && <PlanResult plan={plan.data} />}
          <Step title={t("admin.r2.step2")} hint={t("admin.r2.step2Hint")}>
            <Button onClick={() => setConfirming(true)} disabled={!ready || busy}>
              {t("admin.r2.step2")}
            </Button>
          </Step>
          <Step title={t("admin.r2.step3")} hint={t("admin.r2.step3Hint")}>
            <Button variant="outline" onClick={() => start.mutate({ kind: "verify" })} disabled={busy}>
              {t("admin.r2.step3")}
            </Button>
          </Step>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">{t("admin.r2.noPermission")}</p>
      )}

      {job && (
        <JobCard
          job={job}
          canRun={canRun}
          pending={start.isPending || cancel.isPending}
          onCancel={() => cancel.mutate()}
          onResume={() => start.mutate({ kind: job.kind })}
        />
      )}

      <Dialog open={confirming} onOpenChange={(open) => !start.isPending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.r2.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("admin.r2.confirmBody", { count: fmtNumber(plan.data?.toCopy.count ?? 0), size: formatFileSize(plan.data?.toCopy.bytes ?? 0) })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={start.isPending}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => start.mutate({ kind: "copy" })} disabled={start.isPending}>
              {t("admin.r2.start")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
