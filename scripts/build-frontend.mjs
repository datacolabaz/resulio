// Bundles the static frontend server into one file so its runtime image needs no node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["server/frontend.ts"],
  outfile: "dist/frontend.js",
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  // Express is CommonJS and calls require() for Node built-ins, which an ESM bundle does not define.
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
