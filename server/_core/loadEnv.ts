import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/**
 * Load `.env` then `.env.local` from the repo root (directory that contains
 * `package.json` + `server/`), not from `process.cwd()`.
 *
 * This matters when the process is started from a nested folder (for example
 * an empty Cursor workspace inside the project).
 */
export function loadEnvFiles(fromDir = dirname(fileURLToPath(import.meta.url))) {
  const root = findProjectRoot(fromDir);
  // Never override: Railway / Docker runtime env must win over empty files.
  config({ path: join(root, ".env"), override: false });
  if (existsSync(join(root, ".env.local"))) {
    config({ path: join(root, ".env.local"), override: false });
  }
  return root;
}

export function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "server"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

loadEnvFiles();
