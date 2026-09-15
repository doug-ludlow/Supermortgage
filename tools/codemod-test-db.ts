#!/usr/bin/env node --experimental-strip-types
/**
 * One-shot codemod: moves a database-backed `node:test` file from the copied boilerplate (read TEST_DATABASE_URL,
 * probe, skip-or-throw, drop/create, db/migrate.sh, journey lock) onto `testDatabase(import.meta.url)` from
 * src/infra/db/test-db.ts. Kept in tools/ as the record of what was rewritten; re-running on a converted file is a no-op.
 *
 *   node --experimental-strip-types tools/codemod-test-db.ts [--dry] <file.ts>...
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const files = args.filter((a) => !a.startsWith("--")).map((f) => resolve(f));
const HARNESS = resolve("src/infra/db/test-db.ts");

const HEADER = [
  /^const BASE_URL = process\.env\["[A-Z_]*TEST_DATABASE_URL"\] \?\? "postgresql:\/\/[^"]+";\s*$/,
  /^const DB_URL = process\.env\["[A-Z_]*TEST_DATABASE_URL"\] \?\? "postgresql:\/\/[^"]+";\s*$/,
  /^const DB_URL = \(\(\)(: string)? => \{ const u = new URL\(BASE_URL\); u\.pathname = `\$\{u\.pathname\}_[a-z0-9_]+`; return u\.toString\(\); \}\)\(\);\s*$/,
  /^const ADMIN_URL = \(\(\)(: string)? => \{ const u = new URL\(DB_URL\); u\.pathname = "\/postgres"; return u\.toString\(\); \}\)\(\);.*$/,
  /^const up = await reachable\((DB_URL|ADMIN_URL|\(\(\) => \{ const u = new URL\(DB_URL\); u\.pathname = "\/postgres"; return u\.toString\(\); \}\)\(\))\);.*$/,
  /^if \(!up && process\.env\["REQUIRE_DB"\]\) throw new Error\(`REQUIRE_DB set but \$\{(DB_URL|ADMIN_URL)\} is not reachable`\);\s*$/,
  /^const (skip|skipDb) = up \? false : `no Postgres at \$\{(DB_URL|ADMIN_URL)\}`;.*$/,
  /^\/\*\* The server is what has to be reachable: .*\*\/\s*$/,
];
const BEFORE = [
  /^\s*const name = new URL\(DB_URL\)\.pathname\.slice\(1\);( const admin = new URL\(DB_URL\); admin\.pathname = "\/postgres";)?\s*$/,
  /^\s*const a = connect\((ADMIN_URL|admin\.toString\(\))\); await a\.query\(`DROP DATABASE IF EXISTS \$\{name\}`\); await a\.query\(`CREATE DATABASE \$\{name\}`\); await a\.end\(\);\s*$/,
  /^\s*execFileSync\(fileURLToPath\(new URL\("(\.\.\/)+db\/migrate\.sh", import\.meta\.url\)\), \{ env: \{ \.\.\.process\.env, DATABASE_URL: DB_URL \}, stdio: "pipe" \}\);\s*$/,
  /^\s*journeyLock = await acquireJourneyLock\(DB_URL\);.*$/,
  /^let journeyLock: TestLock \| undefined;\s*$/,
  /^import \{ acquireJourneyLock, type TestLock \} from "[^"]*test-lock\.ts";\s*$/,
];
const PRUNABLE = ["execFileSync", "fileURLToPath", "reachable", "connect"];

function convert(file: string): string | null {
  const src = readFileSync(file, "utf8");
  if (src.includes("test-db.ts")) return null;
  const lines = src.split("\n");
  const headerIdx = lines.map((l, i) => (HEADER.some((re) => re.test(l)) ? i : -1)).filter((i) => i >= 0);
  if (headerIdx.length < 3) throw new Error(`${file}: no boilerplate header found`);
  const skipName = lines.some((l) => /^const skipDb = up/.test(l)) ? "skipDb" : "skip";
  const first = headerIdx[0]!;
  const replacement = `const { url: DB_URL, ${skipName === "skip" ? "skip" : `skip: ${skipName}`} } = await testDatabase(import.meta.url);`;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (i === first) { out.push(replacement); continue; }
    if (headerIdx.includes(i)) continue;
    if (BEFORE.some((re) => re.test(l))) continue;
    out.push(l.replace(/ await journeyLock\?\.release\(\);/, ""));
  }
  // the harness import, right after the client.ts import
  let rel = relative(dirname(file), HARNESS).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  const clientIdx = out.findIndex((l) => /^import .* from "[^"]*(\/infra\/db\/|^\.\/)(client|index)\.ts";/.test(l) || /^import .* from "\.\/(client|index)\.ts";/.test(l));
  if (clientIdx < 0) throw new Error(`${file}: no client.ts import to anchor on`);
  out.splice(clientIdx + 1, 0, `import { testDatabase } from "${rel}";`);
  // prune imports the boilerplate alone used (a use in a comment does not count)
  const DEL = "\u0000DEL";
  let text = out.join("\n");
  const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const id of PRUNABLE) {
    const importRe = /^import \{([^}]*)\} from "([^"]+)";[ \t]*$/gm;
    text = text.replace(importRe, (whole, specs: string, from: string) => {
      const list = specs.split(",").map((s) => s.trim()).filter(Boolean);
      if (!list.includes(id)) return whole;
      if (new RegExp(`\\b${id}\\b`).test(code(text.replace(whole, "")))) return whole;
      const kept = list.filter((s) => s !== id);
      return kept.length ? `import { ${kept.join(", ")} } from "${from}";` : DEL;
    });
  }
  text = text.split("\n").filter((l) => l !== DEL).join("\n");
  return text === src ? null : text;
}

for (const f of files) {
  const next = convert(f);
  if (!next) { console.log(`unchanged ${f}`); continue; }
  if (dry) console.log(`would rewrite ${f}`); else { writeFileSync(f, next); console.log(`rewrote ${f}`); }
}
