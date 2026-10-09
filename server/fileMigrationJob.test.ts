import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrateOptions, MigrateReport } from "./fileStorage/migrate";
import type { ObjectStore } from "./fileStorage/r2";
import type { AdminContext } from "./modules/admin/authz";

vi.mock("./db", () => ({
  requireDb: () => {
    throw new Error("no database in unit tests");
  },
  getDb: async () => null,
}));

const job = await import("./fileStorage/job");
const { cancelFileMigration, isStale, JOB_MAX_ERRORS, JOB_SAVE_MS, JOB_STALE_MS, jobView, resumeInterruptedFileMigration, runFileMigration, startFileMigration } = job;
type FileMigrationJob = import("./fileStorage/job").FileMigrationJob;
type Deps = import("./fileStorage/job").FileMigrationDeps;

const ADMIN: AdminContext = {
  userId: 1,
  roles: ["SUPER_ADMIN"],
  permissions: ["storage.migrate"],
  primaryRole: "SUPER_ADMIN",
  meta: { requestId: "req-1", ipHash: "ip", userAgentSummary: "test" },
};

/** platform_settings row stand-in: updates run one at a time, like the row lock. */
function memoryJobs(initial: FileMigrationJob | null = null) {
  let state = initial;
  let lock: Promise<unknown> = Promise.resolve();
  const writes: FileMigrationJob[] = [];
  return {
    writes,
    get state() {
      return state;
    },
    set state(next: FileMigrationJob | null) {
      state = next;
    },
    async read() {
      return state && structuredClone(state);
    },
    update<T>(fn: (current: FileMigrationJob | null, tx: never) => Promise<{ next?: FileMigrationJob; result: T }>) {
      const run = lock.then(async () => {
        const { next, result } = await fn(state && structuredClone(state), {} as never);
        if (next) {
          state = structuredClone(next);
          writes.push(state);
        }
        return result;
      });
      lock = run.catch(() => undefined);
      return run;
    },
  };
}

const store = { backend: "r2", bucket: "resulio-files" } as ObjectStore;

/** A fake engine that reports `count` files, optionally waiting on a gate before each one. */
function fakeEngine(count: number, opts: { gate?: () => Promise<void>; fail?: (i: number) => string | null } = {}) {
  const calls: MigrateOptions[] = [];
  const migrate = vi.fn(async (o: MigrateOptions): Promise<MigrateReport> => {
    calls.push(o);
    const report: MigrateReport = { mode: o.mode, apply: o.apply, candidates: 0, bytes: 0, done: 0, skipped: 0, failed: [], stopped: false, cursor: "" };
    for (let i = 0; i < count; i++) {
      if (opts.gate) await opts.gate();
      if (o.shouldStop?.()) {
        report.stopped = true;
        break;
      }
      const error = opts.fail?.(i) ?? null;
      report.candidates++;
      if (error) {
        report.failed.push({ id: `f${i}`, fileName: `file${i}.pdf`, error });
        o.onFile?.({ id: `f${i}`, fileName: `file${i}.pdf`, bytes: 10, status: "failed", error });
      } else {
        report.done++;
        o.onFile?.({ id: `f${i}`, fileName: `file${i}.pdf`, bytes: 10, status: i === 0 ? "skipped" : o.mode === "verify" ? "verified" : "copied" });
      }
    }
    return report;
  });
  return { migrate, calls };
}

let clock = Date.parse("2026-10-09T10:00:00Z");
function deps(overrides: Partial<Deps> & { jobs: ReturnType<typeof memoryJobs> }) {
  const runs: Promise<void>[] = [];
  const audit = vi.fn(async () => undefined);
  const d: Deps = {
    store: () => store,
    migrate: fakeEngine(3).migrate,
    totals: async () => ({ count: 3, bytes: 30 }),
    audit,
    now: () => clock,
    spawn: (run) => void runs.push(run()),
    ...overrides,
  };
  return { d, runs, audit, settle: () => Promise.all(runs) };
}
const actions = (audit: ReturnType<typeof vi.fn>) => audit.mock.calls.map((c) => (c[2] as { action: string }).action);

beforeEach(() => {
  clock = Date.parse("2026-10-09T10:00:00Z");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("file migration job", () => {
  it("runs a copy in the background and records start and finish in the audit log", async () => {
    const jobs = memoryJobs();
    const engine = fakeEngine(3);
    const { d, audit, settle } = deps({ jobs, migrate: engine.migrate });
    const view = await startFileMigration(ADMIN, "copy", d);
    expect(view).toMatchObject({ kind: "copy", status: "running", total: 3, totalBytes: 30, startedBy: 1, interrupted: false });
    expect(view).not.toHaveProperty("owner");
    await settle();
    expect(jobs.state).toMatchObject({ status: "done", processed: 3, ok: 2, skipped: 1, failed: 0, bytesDone: 30 });
    expect(engine.calls[0]).toMatchObject({ mode: "copy", apply: true });
    expect(actions(audit)).toEqual(["FILE_MIGRATION_STARTED", "FILE_MIGRATION_FINISHED"]);
    expect(audit.mock.calls[0][1]).toBe(ADMIN);
    expect(audit.mock.calls[1][1]).toBeNull();
  });

  it("never asks the engine to purge, and copy/verify are the only kinds", async () => {
    expect(job.FILE_MIGRATION_KINDS).toEqual(["copy", "verify"]);
    for (const kind of job.FILE_MIGRATION_KINDS) {
      const engine = fakeEngine(1);
      const { d, settle } = deps({ jobs: memoryJobs(), migrate: engine.migrate });
      await startFileMigration(ADMIN, kind, d);
      await settle();
      expect(engine.calls.map((c) => c.mode)).toEqual([kind]);
    }
  });

  it("allows only one job at a time", async () => {
    const jobs = memoryJobs();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d, settle } = deps({ jobs, migrate: fakeEngine(1, { gate: () => gate }).migrate });
    await startFileMigration(ADMIN, "copy", d);
    await expect(startFileMigration(ADMIN, "verify", d)).rejects.toThrow("FILE_MIGRATION_RUNNING");
    release();
    await settle();
    await expect(startFileMigration(ADMIN, "verify", d)).resolves.toMatchObject({ kind: "verify" });
  });

  it("refuses to start without R2", async () => {
    const { d } = deps({ jobs: memoryJobs(), store: () => null });
    await expect(startFileMigration(ADMIN, "copy", d)).rejects.toThrow("R2_NOT_CONFIGURED");
  });

  it("cancels a running job: the runner sees the flag on its next save and stops before the next file", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const jobs = memoryJobs();
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const engine = fakeEngine(5, {
      gate: async () => {
        await gate;
      },
    });
    const { d, audit, settle } = deps({ jobs, migrate: engine.migrate });
    await startFileMigration(ADMIN, "copy", d);
    release();
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    gate = new Promise<void>((r) => (release = r));
    const cancelled = await cancelFileMigration(ADMIN, d);
    expect(cancelled).toMatchObject({ status: "running", cancelRequested: true });
    await vi.advanceTimersByTimeAsync(JOB_SAVE_MS);
    release();
    await settle();
    expect(jobs.state).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(jobs.state!.processed).toBeLessThan(5);
    expect(actions(audit)).toEqual(["FILE_MIGRATION_STARTED", "FILE_MIGRATION_CANCELLED", "FILE_MIGRATION_FINISHED"]);
  });

  it("saves progress and a heartbeat while running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const jobs = memoryJobs();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const engine = fakeEngine(4, { gate: async () => (n++ >= 2 ? gate : undefined) });
    const { d, settle } = deps({ jobs, migrate: engine.migrate });
    await startFileMigration(ADMIN, "copy", d);
    clock += 5_000;
    await vi.advanceTimersByTimeAsync(JOB_SAVE_MS);
    expect(jobs.state).toMatchObject({ status: "running", processed: 2, heartbeatAt: new Date(clock).toISOString() });
    release();
    await settle();
    expect(jobs.state).toMatchObject({ status: "done", processed: 4 });
  });

  it("cannot be cancelled when nothing runs", async () => {
    const { d } = deps({ jobs: memoryJobs() });
    await expect(cancelFileMigration(ADMIN, d)).rejects.toThrow("FILE_MIGRATION_NOT_RUNNING");
  });

  it("treats a job without a recent heartbeat as interrupted; cancel then closes it at once", async () => {
    const jobs = memoryJobs();
    const { d } = deps({ jobs });
    await startFileMigration(ADMIN, "copy", { ...d, spawn: () => undefined });
    clock += JOB_STALE_MS + 1;
    expect(jobView(jobs.state, clock)?.interrupted).toBe(true);
    expect(await cancelFileMigration(ADMIN, d)).toMatchObject({ status: "cancelled", interrupted: false });
  });

  it("lets a new run take over an interrupted one (resume), and the old runner cannot overwrite it", async () => {
    const jobs = memoryJobs();
    const { d, audit, settle } = deps({ jobs });
    await startFileMigration(ADMIN, "copy", { ...d, spawn: () => undefined });
    const stale = structuredClone(jobs.state!);
    clock += JOB_STALE_MS + 1;
    const view = await startFileMigration(ADMIN, "copy", d);
    expect(view).toMatchObject({ resumed: true, status: "running" });
    expect(audit.mock.calls[1][2]).toMatchObject({ action: "FILE_MIGRATION_STARTED", after: expect.objectContaining({ resumedFrom: stale.id }) });
    await settle();
    const finished = structuredClone(jobs.state!);
    await runFileMigration({ ...stale, owner: "dead-process" }, d);
    expect(jobs.state).toEqual(finished);
  });

  it("resumes an interrupted run after a restart as the system, keeping who started it", async () => {
    const jobs = memoryJobs();
    const { d, audit, settle } = deps({ jobs });
    await startFileMigration(ADMIN, "copy", { ...d, spawn: () => undefined });
    expect(await resumeInterruptedFileMigration(d)).toBeNull();
    clock += JOB_STALE_MS + 1;
    const resumed = await resumeInterruptedFileMigration(d);
    expect(resumed).toMatchObject({ kind: "copy", resumed: true, startedBy: 1 });
    expect(audit.mock.calls[1][1]).toBeNull();
    await settle();
    expect(jobs.state?.status).toBe("done");
  });

  it("does not resume a run someone asked to cancel, or a finished one", async () => {
    const jobs = memoryJobs();
    const { d } = deps({ jobs });
    await startFileMigration(ADMIN, "copy", { ...d, spawn: () => undefined });
    jobs.state = { ...jobs.state!, cancelRequested: true };
    clock += JOB_STALE_MS + 1;
    expect(await resumeInterruptedFileMigration(d)).toBeNull();
    jobs.state = { ...jobs.state!, status: "done", cancelRequested: false };
    expect(await resumeInterruptedFileMigration(d)).toBeNull();
  });

  it("lists failed files (capped) and keeps counting", async () => {
    const jobs = memoryJobs();
    const total = JOB_MAX_ERRORS + 10;
    const { d, settle } = deps({ jobs, migrate: fakeEngine(total, { fail: (i) => (i === 0 ? null : `boom ${i}`) }).migrate });
    await startFileMigration(ADMIN, "copy", d);
    await settle();
    expect(jobs.state).toMatchObject({ status: "done", processed: total, failed: total - 1 });
    expect(jobs.state!.errors).toHaveLength(JOB_MAX_ERRORS);
    expect(jobs.state!.errors[0]).toEqual({ fileId: "f1", fileName: "file1.pdf", error: "boom 1" });
  });

  it("marks the job failed with a redacted message when the engine throws", async () => {
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "very-secret-key");
    const jobs = memoryJobs();
    const { d, settle } = deps({
      jobs,
      migrate: async () => {
        throw new Error("signature mismatch for very-secret-key");
      },
    });
    await startFileMigration(ADMIN, "copy", d);
    await settle();
    expect(jobs.state).toMatchObject({ status: "failed" });
    expect(jobs.state!.message).not.toContain("very-secret-key");
    expect(JSON.stringify(jobs.writes)).not.toContain("very-secret-key");
  });

  it("fails cleanly if R2 disappears or the bucket changes mid-run", async () => {
    const jobs = memoryJobs();
    let current: ObjectStore | null = store;
    const { d, settle } = deps({ jobs, store: () => current });
    await startFileMigration(ADMIN, "copy", { ...d, spawn: () => undefined });
    current = { ...store, bucket: "other" } as ObjectStore;
    await runFileMigration(structuredClone(jobs.state!) as FileMigrationJob & { owner: string }, d);
    await settle();
    expect(jobs.state).toMatchObject({ status: "failed", message: expect.stringContaining("resulio-files") });
  });

  it("is stale only while running and past the heartbeat window", () => {
    const base = { status: "running", heartbeatAt: new Date(clock).toISOString() } as FileMigrationJob;
    expect(isStale(base, clock + JOB_STALE_MS)).toBe(false);
    expect(isStale(base, clock + JOB_STALE_MS + 1)).toBe(true);
    expect(isStale({ ...base, status: "done" }, clock + JOB_STALE_MS * 10)).toBe(false);
  });
});
