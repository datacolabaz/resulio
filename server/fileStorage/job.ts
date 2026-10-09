import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { platformSettings } from "../../drizzle/schema";
import { ADMIN_ROLES } from "../../shared/adminPermissions";
import type { RequestMeta } from "../_core/requestMeta";
import { requireDb, type DbOrTx } from "../db";
import { appendAudit, type AuditActor } from "../modules/admin/audit";
import type { AdminContext } from "../modules/admin/authz";
import { AppError } from "../modules/errors";
import { migrateFiles, migrationPlan, migrationTotals, type MigrateOptions, type MigrateReport } from "./migrate";
import { objectStore, r2DownloadMode, r2MissingEnv, redactR2Secrets, uploadBackend, type ObjectStore } from "./r2";

/**
 * The admin "copy files to R2" button runs here: a background job (never inside the HTTP request)
 * over the shared engine in ./migrate. Its state is one JSON row in platform_settings, written
 * under a row lock, so there is at most one job at a time across instances:
 * - the running process refreshes a heartbeat every few seconds; a "running" job whose heartbeat
 *   is older than JOB_STALE_MS was interrupted (deploy, crash) and may be taken over;
 * - cancel sets a flag the runner picks up on its next save;
 * - copy and verify only add file_objects rows / read; MySQL bytes are never touched (the purge
 *   stays in the CLI script).
 */

export const FILE_MIGRATION_JOB_KEY = "job.r2Migration";
export const JOB_STALE_MS = 90_000;
export const JOB_SAVE_MS = 3_000;
export const JOB_MAX_ERRORS = 50;
const BATCH_SIZE = 25;
const CONCURRENCY = 4;
const INSTANCE = randomUUID();
const SYSTEM_META: RequestMeta = { requestId: null, ipHash: null, userAgentSummary: null };

export const FILE_MIGRATION_KINDS = ["copy", "verify"] as const;
export type FileMigrationKind = (typeof FILE_MIGRATION_KINDS)[number];

const jobSchema = z.object({
  id: z.string(),
  kind: z.enum(FILE_MIGRATION_KINDS),
  status: z.enum(["running", "done", "failed", "cancelled"]),
  bucket: z.string(),
  owner: z.string(),
  startedBy: z.number().nullable(),
  startedByRole: z.enum(ADMIN_ROLES).nullable(),
  startedAt: z.string(),
  heartbeatAt: z.string(),
  finishedAt: z.string().nullable(),
  cancelRequested: z.boolean(),
  /** Taken over from an interrupted run. */
  resumed: z.boolean(),
  total: z.number(),
  totalBytes: z.number(),
  processed: z.number(),
  ok: z.number(),
  skipped: z.number(),
  failed: z.number(),
  bytesDone: z.number(),
  errors: z.array(z.object({ fileId: z.string(), fileName: z.string(), error: z.string() })),
  message: z.string().nullable(),
});
export type FileMigrationJob = z.infer<typeof jobSchema>;

export interface JobStateStore {
  read(): Promise<FileMigrationJob | null>;
  /** Runs `fn` on the current state under a lock and saves `next` when given. */
  update<T>(fn: (current: FileMigrationJob | null, tx: DbOrTx) => Promise<{ next?: FileMigrationJob; result: T }>): Promise<T>;
}

export interface FileMigrationDeps {
  jobs: JobStateStore;
  store: () => ObjectStore | null;
  migrate: (opts: MigrateOptions) => Promise<MigrateReport>;
  totals: (kind: FileMigrationKind, bucket: string) => Promise<{ count: number; bytes: number }>;
  audit: typeof appendAudit;
  now: () => number;
  /** Runs the job in the background. */
  spawn: (run: () => Promise<void>) => void;
}

function parseJob(value: unknown): FileMigrationJob | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = jobSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const dbJobStore: JobStateStore = {
  async read() {
    const [row] = await requireDb().select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, FILE_MIGRATION_JOB_KEY)).limit(1);
    return parseJob(row?.value);
  },
  async update(fn) {
    const db = requireDb();
    await db.insert(platformSettings).ignore().values({ key: FILE_MIGRATION_JOB_KEY, value: null });
    return db.transaction(async (tx) => {
      const [row] = await tx.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, FILE_MIGRATION_JOB_KEY)).for("update");
      const { next, result } = await fn(parseJob(row?.value), tx);
      if (next) await tx.update(platformSettings).set({ value: next, updatedBy: next.startedBy }).where(eq(platformSettings.key, FILE_MIGRATION_JOB_KEY));
      return result;
    });
  },
};

export const defaultFileMigrationDeps = (): FileMigrationDeps => ({
  jobs: dbJobStore,
  store: () => objectStore(),
  migrate: migrateFiles,
  totals: migrationTotals,
  audit: appendAudit,
  now: () => Date.now(),
  spawn: (run) => void run().catch((error) => console.error("[storage] file migration job crashed", error)),
});

const iso = (ms: number) => new Date(ms).toISOString();
export const isStale = (job: FileMigrationJob, now: number) => job.status === "running" && now - Date.parse(job.heartbeatAt) > JOB_STALE_MS;

/** What the admin page sees: no lease owner, plus whether a "running" job was interrupted. */
export function jobView(job: FileMigrationJob | null, now: number) {
  if (!job) return null;
  const { owner: _owner, ...rest } = job;
  return { ...rest, interrupted: isStale(job, now) };
}
export type FileMigrationJobView = NonNullable<ReturnType<typeof jobView>>;

const actorOf = (job: FileMigrationJob): AuditActor => (job.startedBy === null ? null : { userId: job.startedBy, primaryRole: job.startedByRole });

/** Starts a copy or verify run; `admin` null = the system resuming an interrupted run. */
export async function startFileMigration(admin: AdminContext | null, kind: FileMigrationKind, deps: FileMigrationDeps = defaultFileMigrationDeps()) {
  const store = deps.store();
  if (!store) throw new AppError("R2_NOT_CONFIGURED");
  const totals = await deps.totals(kind, store.bucket);
  const job = await deps.jobs.update(async (current, tx) => {
    const now = deps.now();
    if (current?.status === "running" && !isStale(current, now)) throw new AppError("FILE_MIGRATION_RUNNING");
    const resumed = current?.status === "running";
    const next: FileMigrationJob = {
      id: randomUUID(),
      kind,
      status: "running",
      bucket: store.bucket,
      owner: INSTANCE,
      startedBy: admin?.userId ?? current?.startedBy ?? null,
      startedByRole: admin?.primaryRole ?? current?.startedByRole ?? null,
      startedAt: iso(now),
      heartbeatAt: iso(now),
      finishedAt: null,
      cancelRequested: false,
      resumed,
      total: totals.count,
      totalBytes: totals.bytes,
      processed: 0,
      ok: 0,
      skipped: 0,
      failed: 0,
      bytesDone: 0,
      errors: [],
      message: null,
    };
    await deps.audit(
      tx,
      admin ?? null,
      {
        action: "FILE_MIGRATION_STARTED",
        targetType: "FILE_MIGRATION",
        targetId: next.id,
        userId: next.startedBy,
        after: { kind, bucket: store.bucket, files: totals.count, bytes: totals.bytes, resumedFrom: resumed ? current?.id ?? null : null },
      },
      admin?.meta ?? SYSTEM_META,
    );
    return { next, result: next };
  });
  deps.spawn(() => runFileMigration(job, deps));
  return jobView(job, deps.now())!;
}

/** The job loop: runs the engine, saving progress + heartbeat every JOB_SAVE_MS and at the end. */
export async function runFileMigration(initial: FileMigrationJob, deps: FileMigrationDeps) {
  const job: FileMigrationJob = { ...initial, errors: [...initial.errors] };
  const flags: { stop: "cancel" | "lost" | null } = { stop: null };
  let saving: Promise<void> = Promise.resolve();

  const save = (final?: Pick<FileMigrationJob, "status" | "finishedAt" | "message">) => {
    saving = saving.then(async () => {
      if (flags.stop === "lost") return;
      try {
        const outcome = await deps.jobs.update(async (current, tx) => {
          if (!current || current.id !== job.id || current.owner !== job.owner) return { result: "lost" as const };
          if (current.cancelRequested && !flags.stop) flags.stop = "cancel";
          Object.assign(job, { cancelRequested: current.cancelRequested, heartbeatAt: iso(deps.now()) }, final);
          if (final) {
            await deps.audit(
              tx,
              null,
              {
                action: "FILE_MIGRATION_FINISHED",
                targetType: "FILE_MIGRATION",
                targetId: job.id,
                userId: job.startedBy,
                after: { kind: job.kind, status: job.status, files: job.processed, ok: job.ok, skipped: job.skipped, failed: job.failed, bytes: job.bytesDone },
              },
              SYSTEM_META,
            );
          }
          return { next: { ...job, errors: [...job.errors] }, result: "ok" as const };
        });
        if (outcome === "lost") flags.stop = "lost";
      } catch (error) {
        console.error("[storage] could not save file migration progress", error);
      }
    });
    return saving;
  };

  const timer = setInterval(() => void save(), JOB_SAVE_MS);
  timer.unref?.();
  let final: Pick<FileMigrationJob, "status" | "finishedAt" | "message">;
  try {
    const store = deps.store();
    if (!store || store.bucket !== job.bucket) throw new Error(`R2 bucket ${job.bucket} is no longer configured`);
    const report = await deps.migrate({
      store,
      mode: job.kind,
      apply: true,
      batchSize: BATCH_SIZE,
      concurrency: CONCURRENCY,
      log: () => undefined,
      shouldStop: () => flags.stop !== null,
      onFile: (outcome) => {
        job.processed++;
        if (outcome.status === "failed") {
          job.failed++;
          if (job.errors.length < JOB_MAX_ERRORS) job.errors.push({ fileId: outcome.id, fileName: outcome.fileName, error: outcome.error });
          return;
        }
        job.bytesDone += outcome.bytes;
        if (outcome.status === "skipped") job.skipped++;
        else job.ok++;
      },
    });
    final = { status: report.stopped && flags.stop === "cancel" ? "cancelled" : "done", finishedAt: iso(deps.now()), message: null };
  } catch (error) {
    final = { status: "failed", finishedAt: iso(deps.now()), message: redactR2Secrets(error instanceof Error ? error.message : String(error)) };
  } finally {
    clearInterval(timer);
  }
  if (flags.stop === "lost") return;
  await save(final);
}

export async function cancelFileMigration(admin: AdminContext, deps: FileMigrationDeps = defaultFileMigrationDeps()) {
  return deps.jobs.update(async (current, tx) => {
    const now = deps.now();
    if (!current || current.status !== "running") throw new AppError("FILE_MIGRATION_NOT_RUNNING");
    const stale = isStale(current, now);
    const next: FileMigrationJob = stale ? { ...current, cancelRequested: true, status: "cancelled", finishedAt: iso(now) } : { ...current, cancelRequested: true };
    await deps.audit(
      tx,
      admin,
      {
        action: "FILE_MIGRATION_CANCELLED",
        targetType: "FILE_MIGRATION",
        targetId: current.id,
        userId: current.startedBy,
        after: { kind: current.kind, files: current.processed, total: current.total, interrupted: stale },
      },
      admin.meta,
    );
    return { next, result: jobView(next, now)! };
  });
}

/** Backend facts for the admin page; env var names only, never values. */
export async function fileMigrationStatus(deps: FileMigrationDeps = defaultFileMigrationDeps()) {
  const store = deps.store();
  return {
    configured: !!store,
    missingEnv: r2MissingEnv(),
    bucket: store?.bucket ?? null,
    uploadsTo: uploadBackend(),
    downloadMode: r2DownloadMode(),
    job: jobView(await deps.jobs.read(), deps.now()),
  };
}

/** The dry run behind the first button: counts plus a connection check, nothing written. */
export async function fileMigrationPlan(deps: FileMigrationDeps = defaultFileMigrationDeps()) {
  const store = deps.store();
  if (!store) throw new AppError("R2_NOT_CONFIGURED");
  return migrationPlan(store);
}

/** After a restart, continue a run whose process died (idempotent, so a fresh pass is safe). */
export async function resumeInterruptedFileMigration(deps: FileMigrationDeps = defaultFileMigrationDeps()) {
  const current = await deps.jobs.read();
  if (!current || !isStale(current, deps.now()) || current.cancelRequested || !deps.store()) return null;
  console.info(`[storage] resuming interrupted file ${current.kind} job ${current.id}`);
  return startFileMigration(null, current.kind, deps);
}

/** Checks once, after the previous process's heartbeat has had time to go stale. */
export function scheduleFileMigrationResume() {
  const timer = setTimeout(() => {
    resumeInterruptedFileMigration().catch((error) => console.error("[storage] could not resume the file migration", error));
  }, JOB_STALE_MS + 15_000);
  timer.unref?.();
}