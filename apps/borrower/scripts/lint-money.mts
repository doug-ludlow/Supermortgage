/**
 * Money lint (13 §3 T-X-09): no float arithmetic on money or rates in the client.
 * Fails on `parseFloat(`, `Number(` and `parseInt(` applied to anything named
 * *cents*, *amount*, *rate*, *apr*, *balance* or *money* in app/, components/, lib/.
 * Also fails on `toFixed(` anywhere (a float-formatting smell).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const roots = ["app", "components", "lib"].map((d) => path.resolve(process.cwd(), d));
const moneyWord = /(cents|amount|rate|apr|balance|money|savings|payment|upb)/i;
const patterns: { re: RegExp; why: string }[] = [
  { re: /parseFloat\s*\(([^)]*)\)/g, why: "parseFloat on money/rate" },
  { re: /\bNumber\s*\(([^)]*)\)/g, why: "Number() on money/rate" },
  { re: /parseInt\s*\(([^)]*)\)/g, why: "parseInt on money/rate" },
];
const failures: string[] = [];

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name)) check(p);
  }
}

function check(file: string) {
  const src = readFileSync(file, "utf8");
  src.split("\n").forEach((line, i) => {
    if (/\/\/\s*money-lint:allow/.test(line)) return;
    for (const { re, why } of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        if (moneyWord.test(m[1] ?? "")) failures.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${why}: ${line.trim()}`);
      }
    }
    if (/\.toFixed\s*\(/.test(line)) failures.push(`${path.relative(process.cwd(), file)}:${i + 1}: toFixed(): ${line.trim()}`);
  });
}

for (const r of roots) {
  try {
    walk(r);
  } catch {
    /* missing dir */
  }
}

if (failures.length) {
  console.error("money-lint: float arithmetic on money/rates is forbidden (docs/ux/13 T-X-09):");
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("money-lint: ok");
