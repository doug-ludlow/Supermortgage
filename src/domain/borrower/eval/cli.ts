/**
 * `npm run eval:fake` — the FAKE-model suite of docs/ux/17 §6 (DELTA-28): every persona that starts from account creation, driven
 * through the real API on a dedicated database (EVAL_DATABASE_URL, default postgresql://sm:sm@localhost/supermortgage_eval) with the
 * scripted model, scored on the five checks, one `ai_evaluations{suite_code: "borrower-conversation-v1"}` row written. Exit 0 when
 * the suite passes, 1 when it fails, 2 when no database answers. The servicing persona runs when EVAL_SERVICING_ACCOUNT=email:password
 * names a seeded serviced borrower's account.
 */
import { FAKE_SUITE, SERVICING_PAYOFF } from "./personas.ts";
import { runSuite, type Account } from "./runner.ts";
import { evalDbReachable, openEvalHarness } from "./harness.ts";

async function main(): Promise<number> {
  if (!(await evalDbReachable())) { process.stderr.write(`eval:fake: no Postgres at ${process.env["EVAL_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_eval"} (service postgresql start)\n`); return 2; }
  const h = await openEvalHarness();
  try {
    if (!h.agentConfigured) { process.stderr.write("eval:fake: createBorrowerRouter built no agent from the scripted client (the llm option of DELTA-23 is not wired); nothing to evaluate\n"); return 1; }
    const servicing = process.env["EVAL_SERVICING_ACCOUNT"]; const accounts: Record<string, Account> = {};
    const personas = [...FAKE_SUITE];
    if (servicing && servicing.includes(":")) { const [email, ...rest] = servicing.split(":"); accounts[SERVICING_PAYOFF.id] = { email: email!, password: rest.join(":") }; personas.push(SERVICING_PAYOFF); }
    const suite = await runSuite(h.deps, personas, { accounts });   // deps.beforePersona puts each persona's scenes on the scripted model before its first turn
    const summary = { suite_code: suite.suite_code, pass: suite.pass, dataset_hash: suite.dataset_hash, evaluation: suite.evaluation, personas: suite.runs.map((r) => ({ id: r.persona_id, pass: r.pass, checks: r.checks.map((c) => `${c.name}:${c.pass ? "pass" : "FAIL"}`), violations: r.checks.flatMap((c) => c.violations).slice(0, 8), errors: r.errors })) };
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return suite.pass ? 0 : 1;
  } finally { await h.close(); }
}
main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`eval:fake failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exitCode = 1; });
