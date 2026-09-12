/**
 * The FAKE-model harness: the real runtime and borrower router on a dedicated database (drop / create / db/migrate.sh — the pattern
 * of src/runtime/borrower/talk.test.ts, so no other builder's test run is touched), the entry demo seeded, the scripted Messages API
 * client injected as `llm: { client, model }` on createBorrowerRouter (docs/ux/17 §3.6: no fake model — the same loop, scripted).
 * Shared by the e2e test (runner.test.ts) and `npm run eval:fake` (cli.ts).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connect, reachable, type Db } from "../../../infra/db/index.ts";
import { FixedClock } from "../../../kernel/events/index.ts";
import { loadOverriddenRegistry } from "../../timer-overrides.ts";
import { Runtime } from "../../../runtime/app.ts";
import { createApiServer, listen } from "../../../runtime/server.ts";
import { createLogger, type Logger } from "../../../runtime/log.ts";
import { seedEntryDemo } from "../../../runtime/entry-seed.ts";
import { createBorrowerRouter, type BorrowerRouter, type BorrowerRouterOptions } from "../../../runtime/borrower/routes.ts";
import { copyTemplates } from "../../../runtime/borrower/channels.ts";
import { SYSTEM_PROMPT } from "../../../runtime/borrower/agent/context.ts";
import { scriptedClient, type Scene, type ScriptedClient } from "./scripted-client.ts";
import type { RunnerDeps } from "./runner.ts";

export const DEFAULT_EVAL_DB_URL = "postgresql://sm:sm@localhost/supermortgage_eval";
export const FAKE_MODEL = "FAKE-scripted";
export const FAKE_PROMPT_VERSION = "32.16-p1";
/** sha256 of the prompt text the runtime sends the model (agent/context.ts): `ai_system_versions.prompt_hash` for the pair the harness evaluates. */
export const promptHashOf = (text: string = SYSTEM_PROMPT): string => createHash("sha256").update(text).digest("hex");
/** The harness DROPs and CREATEs the database it is pointed at, so it only accepts a name that says it is disposable: `…_eval` or `…_test` (`supermortgage` itself is refused). */
export const EVAL_DB_NAME = /_(eval|test)$/;
export function evalDbName(dbUrl: string): string {
  const name = new URL(dbUrl).pathname.slice(1);
  if (!name || !EVAL_DB_NAME.test(name)) throw new RangeError(`eval harness: refusing to drop and recreate database "${name || "(none)"}" — EVAL_DATABASE_URL must name a disposable database ending in _eval or _test (default ${DEFAULT_EVAL_DB_URL})`);
  return name;
}

export interface HarnessOptions { readonly dbUrl?: string; readonly now?: string; readonly scenes?: readonly Scene[]; readonly model?: string; readonly promptVersion?: string; readonly logger?: Logger; readonly states?: readonly string[] }
export interface EvalHarness {
  readonly db: Db; readonly runtime: Runtime; readonly router: BorrowerRouter; readonly base: string; readonly scripted: ScriptedClient; readonly partnerName: string;
  /** Null when createBorrowerRouter did not build an agent from the injected client (no `llm` option, or the turn runner refused it). */
  readonly agentConfigured: boolean;
  readonly deps: RunnerDeps;
  settle(): Promise<void>;
  close(): Promise<void>;
}

/** The database server behind the URL answers (probed on its `postgres` database — the harness's own database is dropped and created on open); the harness and the e2e test skip cleanly otherwise. */
export const evalDbReachable = (dbUrl = process.env["EVAL_DATABASE_URL"] ?? DEFAULT_EVAL_DB_URL): Promise<boolean> => { const admin = new URL(dbUrl); admin.pathname = "/postgres"; return reachable(admin.toString()); };

export async function openEvalHarness(o: HarnessOptions = {}): Promise<EvalHarness> {
  const dbUrl = o.dbUrl ?? process.env["EVAL_DATABASE_URL"] ?? DEFAULT_EVAL_DB_URL; const now = o.now ?? "2026-09-10T16:00:00.000Z";
  const name = evalDbName(dbUrl); const admin = new URL(dbUrl); admin.pathname = "/postgres";
  const a = connect(admin.toString()); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" });
  const db = connect(dbUrl);
  const runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock: new FixedClock(now) });
  const seeded = await seedEntryDemo(runtime, { states: [...(o.states ?? ["AZ", "CO"])], now });
  const logger = o.logger ?? createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /agent|eval|error|unhandled/i.test(line)) process.stderr.write(line + "\n"); });
  const scripted = scriptedClient(o.scenes ?? []);
  const model = o.model ?? FAKE_MODEL; const promptVersion = o.promptVersion ?? FAKE_PROMPT_VERSION;
  // `llm` is the turn builder's option (DELTA-23); the cast keeps this compiling against a routes.ts that does not carry it yet — `agentConfigured` says which
  const options = { runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "eval-secret", llm: { client: scripted.client, model, promptVersion } } as BorrowerRouterOptions;
  const router = createBorrowerRouter(options);
  const agent = (router as { agent?: unknown }).agent ?? null;
  const server = createApiServer({ runtime, apiToken: "ops-" + randomUUID(), logger, console: false, borrowerRouter: router });
  const base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  const settle = async (): Promise<void> => { await (agent as { settle?: () => Promise<void> } | null)?.settle?.(); await router.flows?.settle(); await (agent as { settle?: () => Promise<void> } | null)?.settle?.(); await router.flows?.settle(); };
  const deps: RunnerDeps = { base, db, settle, model, promptVersion, promptHash: promptHashOf(), templates: copyTemplates(), log: (line, extra) => logger.info(line, extra ?? {}), beforePersona: (p) => { scripted.use(p.scenes); } };
  const close = (): Promise<void> => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  return { db, runtime, router, base, scripted, partnerName: seeded.partner_name, agentConfigured: agent !== null && agent !== undefined, deps, settle, close };
}
