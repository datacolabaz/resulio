// Copies uploaded files from MySQL (files.dataBase64) to Cloudflare R2, then optionally empties the
// MySQL copies. Dry run unless --apply. Safe to re-run: files already copied are skipped.
//
// Usage (R2_* variables as in docs/FILE-STORAGE.md):
//   DATABASE_URL=... R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... pnpm files:to-r2            # plan
//   ... pnpm files:to-r2 --apply                  # copy; downloads keep reading MySQL until the purge
//   ... pnpm files:to-r2 --purge-db               # plan the purge (only files whose object is verified)
//   ... pnpm files:to-r2 --purge-db --apply       # empty dataBase64 for verified files
// Options: --limit N (files this run), --batch N (default 50).
import { parseArgs } from "node:util";
import { migrateFiles, migrationStatus } from "../server/fileStorage/migrate";
import { objectStore } from "../server/fileStorage/r2";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      "purge-db": { type: "boolean", default: false },
      limit: { type: "string" },
      batch: { type: "string" },
    },
  });
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is required");
  const store = objectStore();
  if (!store) fail("R2 is not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET");
  const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
  const batchSize = values.batch ? Number.parseInt(values.batch, 10) : 50;
  if ((limit !== undefined && !(limit > 0)) || !(batchSize > 0)) fail("--limit and --batch must be positive numbers");

  const before = await migrationStatus();
  console.log(`Bucket ${store.bucket}: ${before.onlyInDatabase} file(s) only in MySQL (${(before.onlyInDatabaseBytes / 1048576).toFixed(1)} MB), ${before.inObjectStore} already in R2.`);
  const mode = values["purge-db"] ? "purge" : "copy";
  const report = await migrateFiles({ store, mode, apply: values.apply, batchSize, limit });
  console.log(
    `${report.apply ? "Done" : "Dry run"} (${mode}): ${report.candidates} file(s), ${(report.bytes / 1048576).toFixed(1)} MB` +
      (report.apply ? `, ${report.done} ok, ${report.failed.length} failed` : ". Re-run with --apply to do it."),
  );
  process.exit(report.failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
