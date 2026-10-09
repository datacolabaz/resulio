// Copies uploaded files from MySQL (files.dataBase64) to Cloudflare R2, checks the copies and,
// separately, empties the MySQL copies. Dry run unless --apply. Safe to re-run: files already
// copied are skipped. The admin page (Fayl yaddaşı → Faylları R2-yə köçür) runs the same copy and
// verify code as a background job; the purge is only here, on purpose.
//
// Usage (R2_* variables as in docs/FILE-STORAGE.md):
//   DATABASE_URL=... R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... pnpm files:to-r2            # plan
//   ... pnpm files:to-r2 --apply                  # copy; downloads keep reading MySQL until the purge
//   ... pnpm files:to-r2 --verify --apply         # re-check every copied object (size + MD5)
//   ... pnpm files:to-r2 --purge-db               # plan the purge (only files whose object is verified)
//   ... pnpm files:to-r2 --purge-db --apply       # empty dataBase64 for verified files (take a DB backup first)
// Options: --limit N (files this run), --batch N (default 50), --concurrency N (default 4).
import { parseArgs } from "node:util";
import { migrateFiles, migrationPlan, type MigrateMode } from "../server/fileStorage/migrate";
import { objectStore, r2MissingEnv } from "../server/fileStorage/r2";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      "purge-db": { type: "boolean", default: false },
      limit: { type: "string" },
      batch: { type: "string" },
      concurrency: { type: "string" },
    },
  });
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is required");
  const store = objectStore();
  if (!store) fail(`R2 is not configured: missing ${r2MissingEnv().join(", ")}`);
  if (values.verify && values["purge-db"]) fail("--verify and --purge-db are separate runs");
  const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
  const batchSize = values.batch ? Number.parseInt(values.batch, 10) : 50;
  const concurrency = values.concurrency ? Number.parseInt(values.concurrency, 10) : 4;
  if ((limit !== undefined && !(limit > 0)) || !(batchSize > 0) || !(concurrency > 0)) fail("--limit, --batch and --concurrency must be positive numbers");

  const plan = await migrationPlan(store);
  console.log(
    `Bucket ${plan.bucket}: ${plan.toCopy.count} file(s) only in MySQL (${mb(plan.toCopy.bytes)}), ${plan.inBucket.count} already in R2 (${mb(plan.inBucket.bytes)}).` +
      (plan.missingData ? ` ${plan.missingData} file(s) have no bytes anywhere.` : "") +
      (plan.inOtherBucket ? ` ${plan.inOtherBucket} recorded in another bucket.` : ""),
  );
  if (!plan.connection.ok) fail(`Cannot reach the bucket: ${plan.connection.error}`);

  const mode: MigrateMode = values["purge-db"] ? "purge" : values.verify ? "verify" : "copy";
  const report = await migrateFiles({ store, mode, apply: values.apply, batchSize, concurrency, limit });
  console.log(
    `${report.apply ? "Done" : "Dry run"} (${mode}): ${report.candidates} file(s), ${mb(report.bytes)}` +
      (report.apply ? `, ${report.done} ok${report.skipped ? ` (${report.skipped} already in R2)` : ""}, ${report.failed.length} failed` : ". Re-run with --apply to do it."),
  );
  process.exit(report.failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
