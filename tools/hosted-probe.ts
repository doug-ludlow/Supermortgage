/**
 * §35.11 rule 10 — the hosted probe (`npm run test:hosted`): every ALL_TOOLS pair posted with `{}` over HTTP as its own agent under a
 * service principal, against the probe's own database (PROBE_DATABASE_URL, default postgresql://sm:sm@localhost/supermortgage_probe —
 * dropped, created and migrated to the newest file under db/migrations) or the deployed nonprod origin; the run's row in
 * `hosted_probe_runs`, `docs/audit/hosted.json` (AUDIT_DIR overrides the directory) and `audit.hosted.run_completed`.
 *
 *   PROBE_TARGET=probe (default) | deployed
 *   PROBE_DATABASE_URL          the probe database (target probe)
 *   PROBE_BASE_URL              the deployed API's origin — infra/terraform's api_hostname, read by the workflow, never hard-coded (target deployed)
 *   PROBE_LOAN_ID, PROBE_APPLICATION_ID   the environment's probe loan and application (seeded by seed-demo)
 *   PROBE_TOKEN | PROBE_TOKENS  one service principal token, or a JSON map {agent: token} (35.7 principals.issue{kind: service})
 *   PROBE_ENVIRONMENT           the target's environment — `production` refuses (PROBE_NEVER_PRODUCTION)
 * Exit 1 when the run failed or any result is `errored`; the not_wired findings are printed (rule 13).
 */
import { runHostedProbe, NOT_WIRED_SERVICE_KEYS } from "../src/domain/operations-runtime/measurement.ts";
import { createLogger } from "../src/runtime/log.ts";

const env = process.env;
const target = (env["PROBE_TARGET"] ?? "probe") === "deployed" ? "deployed" : "probe";
const logger = createLogger("json", (line) => { if (/error/i.test(line)) process.stderr.write(line + "\n"); });
const tokens = env["PROBE_TOKENS"] ? (JSON.parse(env["PROBE_TOKENS"]) as Record<string, string>) : env["PROBE_TOKEN"] ?? null;
const run = await runHostedProbe({ target, databaseUrl: env["PROBE_DATABASE_URL"] ?? null, baseUrl: env["PROBE_BASE_URL"] ?? null, loanId: env["PROBE_LOAN_ID"] ?? null, applicationId: env["PROBE_APPLICATION_ID"] ?? null, tokens, environment: env["PROBE_ENVIRONMENT"] ?? null, logger, auditDir: env["AUDIT_DIR"] ?? null });
const line = `hosted probe ${run.target} ${run.outcome}: ${run.executed} executed, ${run.refused_typed} refused_typed, ${run.not_wired} not_wired, ${run.errored} errored of ${run.tools_total} (migration ${run.migration_head}, git ${run.git_sha.slice(0, 12)}, ${run.database_name})`;
process.stdout.write(line + "\n");
if (run.failure) process.stdout.write(`  failure: ${run.failure}\n`);
if (run.not_wired) process.stdout.write(`  not_wired (rule 13's expected keys: ${NOT_WIRED_SERVICE_KEYS.join(", ")}): ${run.results.filter((r) => r.status === "not_wired").map((r) => `${r.process} ${r.name}`).join(", ")}\n`);
if (run.not_wired_unexpected.length) process.stdout.write(`  not_wired outside the expected keys: ${run.not_wired_unexpected.join(", ")}\n`);
for (const r of run.results.filter((x) => x.status === "errored")) process.stdout.write(`  errored: ${r.process} ${r.name} → ${r.http_status} ${r.code ?? ""}\n`);
process.exit(run.outcome === "completed" && run.errored === 0 ? 0 : 1);
