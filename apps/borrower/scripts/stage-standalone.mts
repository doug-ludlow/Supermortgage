/**
 * After `next build` with output: 'standalone', copy the static assets next to the
 * standalone server so `npm start` (node .next/standalone/server.js) serves them —
 * the same layout Dockerfile.borrower produces.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");
if (!existsSync(standalone)) {
  console.log("stage-standalone: no .next/standalone (not a standalone build) — skipped");
  process.exit(0);
}
mkdirSync(path.join(standalone, ".next"), { recursive: true });
cpSync(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true });
if (existsSync(path.join(root, "public"))) cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
console.log("stage-standalone: copied .next/static (and public/) into .next/standalone");
