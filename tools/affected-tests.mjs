#!/usr/bin/env node
/**
 * Re-run only the suites a change can reach, then the two gates that always run (typecheck and the spec
 * audit ratchet). This is the commit gate (CLAUDE.md, owner's call 2026-09-16); CI runs the whole suite on every push,
 * and the full local `npm test` is for landing a branch.
 *
 *   npm run test:affected                    # changed files: git diff HEAD~1 + the working tree
 *   npm run test:affected -- --base main     # changed files: git diff main...HEAD + the working tree
 *   npm run test:affected -- --list          # decide and print, run nothing
 *   npm run test:affected -- --files a b c   # decide from an explicit list instead of git (also for testing this script)
 *
 * The rules, in the order they are tried; the first that matches a file decides it:
 *   src/**\/*.test.ts                              → that file
 *   src/infra/db/**, db/migrations/**, db/migrate.sh, spec/registry/**, src/kernel/**, src/app/tools.ts,
 *   package.json, package-lock.json                → everything (the storage layer and migrate.sh — the test
 *                                                     template's hash — the timer registry the tools run on,
 *                                                     the kernel, the tool bus and the dependency set reach
 *                                                     every suite)
 *   src/domain/<dir>/**                            → src/domain/<dir>/**\/*.test.ts
 *   src/app/tools/section<N>.ts, section<N>-<M>.ts → src/domain/<d>/**\/*.test.ts for every d in
 *                                                     SECTION_DIR[N] (parsed from tools/audit.py, the one
 *                                                     definition of which directories build section N),
 *                                                     plus src/app/*.test.ts (the bus registration tests)
 *   src/runtime/**, src/console/**,
 *   spec/sections/**, docs/ux/12-message-copy-library.md
 *                                                  → src/runtime/**\/*.test.ts + src/console/*.test.ts (the
 *                                                     agent turn reads the step's rules from spec/sections,
 *                                                     channels.ts renders copy from docs/ux/12)
 *   apps/borrower/**                               → the three suites that build the app and drive it under
 *                                                     Chromium: src/domain/borrower/32-13, 32-16.rail, 32-17
 *   other spec/**, docs/**, *.md                   → nothing
 *   anything else under src/** or tools/**\/*.ts   → everything (unknown reach is treated as total reach)
 *   anything else                                  → nothing
 * Every run appends `npm run typecheck` and `python3 tools/audit.py --check`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? null); };
const listOnly = argv.includes("--list");
const base = flag("--base") ?? "HEAD~1";

// --- changed files ---------------------------------------------------------------------------------------
function git(...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean); }
let changed;
const explicit = argv.indexOf("--files");
if (explicit !== -1) {
  changed = argv.slice(explicit + 1).filter((a) => !a.startsWith("--"));
} else {
  const committed = flag("--base") ? git("diff", "--name-only", `${base}...HEAD`) : git("diff", "--name-only", base);
  const workingTree = git("diff", "--name-only", "HEAD");
  const untracked = git("ls-files", "--others", "--exclude-standard");
  changed = [...new Set([...committed, ...workingTree, ...untracked])];
}
changed = changed.map((f) => f.replace(/^\.\//, "")).sort();

// --- SECTION_DIR from tools/audit.py (never duplicated here) ---------------------------------------------
const auditSrc = readFileSync(new URL("../tools/audit.py", import.meta.url), "utf8");
const block = auditSrc.match(/SECTION_DIR\s*=\s*\{([\s\S]*?)\}/);
if (!block) throw new Error("tools/audit.py: SECTION_DIR map not found");
const SECTION_DIR = new Map();
for (const m of block[1].matchAll(/(\d+)\s*:\s*\[([^\]]*)\]/g)) {
  SECTION_DIR.set(Number(m[1]), [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

// --- decide ----------------------------------------------------------------------------------------------
const EVERYTHING = "src/**/*.test.ts";
const RUNTIME_SUITES = ["src/runtime/**/*.test.ts", "src/console/*.test.ts"];
const CHROMIUM_SUITES = ["src/domain/borrower/32-13.spec.test.ts", "src/domain/borrower/32-16.rail.spec.test.ts", "src/domain/borrower/32-17.spec.test.ts"];
const decisions = []; // { file, reason, suites: string[] | "everything" | [] }
for (const file of changed) {
  let d;
  let m;
  if (/^src\/.*\.test\.ts$/.test(file)) d = { reason: "a suite changed: run it", suites: [file] };
  else if (/^(src\/infra\/db\/|db\/migrations\/|spec\/registry\/|src\/kernel\/)/.test(file) || ["db/migrate.sh", "src/app/tools.ts", "package.json", "package-lock.json"].includes(file))
    d = { reason: "storage, migrate.sh (the template hash), the timer registry, kernel, tool bus or dependencies: reaches every suite", suites: "everything" };
  else if ((m = file.match(/^src\/domain\/([^/]+)\//))) d = { reason: `domain ${m[1]}`, suites: [`src/domain/${m[1]}/**/*.test.ts`] };
  else if ((m = file.match(/^src\/app\/tools\/section0*(\d+)(?:-(\d+))?\.ts$/))) {
    const dirs = SECTION_DIR.get(Number(m[1]));
    if (!dirs) d = { reason: `section ${m[1]} has no SECTION_DIR entry in tools/audit.py: reaches every suite`, suites: "everything" };
    else d = { reason: `section ${m[1]} tools → domain dirs ${dirs.join(", ")} (tools/audit.py SECTION_DIR) + the bus tests`, suites: [...dirs.map((x) => `src/domain/${x}/**/*.test.ts`), "src/app/*.test.ts"] };
  }
  else if (/^src\/(runtime|console)\//.test(file)) d = { reason: "runtime/console", suites: RUNTIME_SUITES };
  else if (/^spec\/sections\//.test(file)) d = { reason: "a process file: the agent turn reads its rules (src/runtime/borrower/agent/rules.ts)", suites: RUNTIME_SUITES };
  else if (file === "docs/ux/12-message-copy-library.md") d = { reason: "the copy library channels.ts renders from", suites: RUNTIME_SUITES };
  else if (/^apps\/borrower\//.test(file)) d = { reason: "borrower app: the suites that build it and drive it under Chromium", suites: CHROMIUM_SUITES };
  else if (/^(spec|docs)\//.test(file) || /\.md$/.test(file)) d = { reason: "spec/docs/markdown the runtime does not read: no suite", suites: [] };
  else if (/^src\//.test(file) || /^tools\/.*\.ts$/.test(file)) d = { reason: "unknown reach under src/ or tools/: reaches every suite", suites: "everything" };
  else d = { reason: "outside the test surface: no suite", suites: [] };
  decisions.push({ file, ...d });
}

const everything = decisions.some((d) => d.suites === "everything");
const patterns = everything ? [EVERYTHING] : [...new Set(decisions.flatMap((d) => d.suites))].sort();
const suites = [...new Set(patterns.flatMap((p) => globSync(p, { cwd: root })))].sort();

// --- report ----------------------------------------------------------------------------------------------
console.log(`affected-tests: ${changed.length} changed file(s) (${explicit !== -1 ? "from --files" : `git diff ${base} + working tree`})`);
for (const d of decisions) console.log(`  ${d.file}\n      → ${d.suites === "everything" ? "EVERYTHING" : d.suites.length ? d.suites.join(", ") : "nothing"}  (${d.reason})`);
if (everything) console.log(`decision: run every suite (${suites.length} files)`);
else if (suites.length) console.log(`decision: run ${suites.length} suite(s):\n  ${suites.join("\n  ")}`);
else console.log("decision: no suite reached; typecheck and the audit ratchet still run");
console.log("always: npm run typecheck; python3 tools/audit.py --check");
if (listOnly) process.exit(0);

// --- run -------------------------------------------------------------------------------------------------
function run(cmd, args) {
  console.log(`\n$ ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: process.env });
  if (r.status !== 0) { console.error(`affected-tests: ${cmd} exited ${r.status}`); process.exit(r.status ?? 1); }
}
if (suites.length) run("node", ["--test", "--experimental-strip-types", ...(everything ? [EVERYTHING] : suites)]);
run("npm", ["run", "typecheck"]);
run("python3", ["tools/audit.py", "--check"]);
console.log("\naffected-tests: all gates passed");
