/**
 * After `next build` with output: 'standalone', copy the static assets next to the standalone server so
 * `npm start` (node .next/standalone/server.js) serves them — the layout apps/borrower's stage script produces.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = process.env.NEXT_DIST_DIR || ".next";
const standalone = path.join(root, dist, "standalone");
if (!existsSync(standalone)) {
  console.log(`stage-standalone: no ${dist}/standalone (not a standalone build) — skipped`);
  process.exit(0);
}
mkdirSync(path.join(standalone, dist), { recursive: true });
cpSync(path.join(root, dist, "static"), path.join(standalone, dist, "static"), { recursive: true });
if (existsSync(path.join(root, "public"))) cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
console.log(`stage-standalone: copied ${dist}/static (and public/) into ${dist}/standalone`);
