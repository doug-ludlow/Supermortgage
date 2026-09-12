/**
 * Container entrypoint: `node --experimental-strip-types src/runtime/main.ts <mode>`
 *   serve    HTTP API + ops console on $HOST:$PORT (the Cloud Run service)
 *   sweep    one pass: the borrower flows' scheduled tick (the servicing / delinquency daily sweeps — what POST /v1/sweep runs),
 *            the daily refinance check (src/runtime/refi-daily.ts, once a day at/after 06:30 ET), the FAKE reviewers (DELTA-30),
 *            the due timers and the outbox backlog, then exit (the Cloud Run job Cloud Scheduler runs every minute)
 *   migrate  apply db/migrations through db/migrate.sh, then exit (the Cloud Run job the deploy runs first)
 *   seed-demo  board the built-in 100-loan demo transfer batch (fixtures/transfer-batch-demo), idempotent, then exit
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect } from "../infra/db/client.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { Runtime } from "./app.ts";
import { createApiServer, listen } from "./server.ts";
import { boardTransferBatch } from "./transfers.ts";
import { generateDemoBatch, DEMO_BATCH } from "../domain/boarding/demo-batch.ts";
import { encodeTransferBatch } from "../domain/boarding/tape-codec.ts";
import { seedEntryDemo } from "./entry-seed.ts";
import { copyLibraryFile } from "./borrower/channels.ts";
import { systemClock } from "../kernel/events/index.ts";
import { loadDemoClock } from "./demo-clock.ts";
import { rateFeedFromEnv } from "../infra/integrations/rates.ts";
import { fakeReviewersFromEnv } from "../infra/integrations/reviewers.ts";
import { BorrowerFlows } from "./borrower/flows/index.ts";
import { PgBorrowerUiRepository } from "../infra/db/borrower-ui.ts";

const mode = process.argv[2] ?? "serve";
const logger = createLogger(process.env["LOG_FORMAT"] === "text" ? "text" : "json");

if (mode === "migrate") {
  const script = fileURLToPath(new URL("../../db/migrate.sh", import.meta.url));
  if (!process.env["DATABASE_URL"]) { logger.error("DATABASE_URL is not set"); process.exit(2); }
  logger.info("migrate: applying db/migrations");
  const r = spawnSync("bash", [script], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}

const config = loadConfig();
const db = connect(config.databaseUrl);
// the daily rate source (FAKE unless RATE_FEED=fred) and the FAKE reviewers (unless FAKE_REVIEWERS=off) ride on the runtime so every sweep path — the job here, POST /v1/sweep in the service — runs them
const rateFeed = rateFeedFromEnv(process.env); const reviewers = fakeReviewersFromEnv(process.env, logger);
// the demo clock (docs/DEPLOY.md "The demo clock"; src/runtime/demo-clock.ts): outside production every mode — serve, sweep, seed-demo — runs on the system clock plus the persisted demo offset (the latest demo_clock row), so the API, the sweep job and the flows agree on the instant; production is the system clock, full stop
const demoClock = config.environment === "production" ? null : await loadDemoClock(db, { logger });
const clock = demoClock ?? systemClock;
const runtime = new Runtime({ db, registry: loadOverriddenRegistry(), rateFeed, reviewers, logger, clock });

if (mode === "sweep") {
  try {
    // the 32.x flows react to what this pass commits (the 20.1 offer → the MLO review request → the FAKE review → the OfferCard) and run their own scheduled tick first, as POST /v1/sweep does
    const flows = new BorrowerFlows({ runtime, ui: new PgBorrowerUiRepository(db), logger, defaultPartnerId: config.borrowerDefaultPartnerId || undefined }); flows.start();
    await flows.tick(runtime.clock.now());
    const report = await runtime.sweep();
    await flows.settle();
    logger.info("sweep", { due: report.due, breaches: report.breaches.length, outbox: report.outbox, at: report.at, rate_feed: rateFeed.vendorName, refi: report.refi?.line ?? "no rate feed", fake_reviewers: report.reviewers?.line ?? "off" });
    for (const b of report.breaches) logger.warn("timer breached", { ...b });
    await db.end();
    process.exit(0);
  } catch (e) { logger.error("sweep failed", { error: e }); await db.end().catch(() => undefined); process.exit(1); }
}

if (mode === "seed-demo") {
  try {
    const demo = generateDemoBatch();
    const r = await boardTransferBatch(runtime, { ...DEMO_BATCH }, encodeTransferBatch(demo, demo.coborrowers), { kind: "system", id: "seed-demo" });
    logger.info("seed-demo", { batch: r.batch_id, status: r.status, loans: r.loans, hard: r.hard, events: r.events, timers: r.timers, escalations: r.escalations });
    // 32.14: the entry experience needs open states, the partner's NMLSR ID and an active rate sheet (FAKE, idempotent — src/runtime/entry-seed.ts)
    const entry = await seedEntryDemo(runtime, {});
    logger.info("seed-demo entry", { partner_id: entry.partner_id, states: entry.states, written: entry.written.length, rate_sheet_id: entry.rate_sheet_id, rate_sheet_published: entry.rate_sheet_published });
    await db.end();
    process.exit(0);
  } catch (e) { logger.error("seed-demo failed", { error: e }); await db.end().catch(() => undefined); process.exit(1); }
}

if (mode !== "serve") { logger.error(`unknown mode ${mode}; use serve | sweep | migrate | seed-demo`); process.exit(2); }
if (!config.apiToken) logger.warn("API_TOKEN is empty: every route is open (ALLOW_INSECURE_NO_TOKEN=1)");
// 32.14: the Phase I partner from configuration (DELTA-15); Sign in with Google is the FAKE provider under INTEGRATIONS=fake (DELTA-12 — the real adapter is wired with the client secret when another INTEGRATIONS value exists)
const server = createApiServer({ runtime, apiToken: config.apiToken, logger, borrower: { environment: config.environment, defaultPartnerId: config.borrowerDefaultPartnerId, talk: { apiKey: config.talk.apiKey, model: config.talk.model, effort: config.talk.effort }, llm: { apiKey: config.llm.apiKey, model: config.llm.model, effort: config.llm.effort, promptVersion: config.llm.promptVersion } } });
if (!config.llm.apiKey) logger.warn("agent turn not configured: ANTHROPIC_API_KEY is unset — the borrower thread answers the copy library's placeholder (32.16 DELTA-23)");
const copyFile = copyLibraryFile(); if (!copyFile) logger.error("copy library missing: docs/ux/12-message-copy-library.md is not in the image — SMS, voice and talk lines render as {{copy:key}} tokens");
// the service runs 1..10 instances and only the one that took POST /v1/demo/advance stepped the clock: every instance follows the table (OffsetClock.follow — one indexed LIMIT 1 read a second) so they agree on the instant within that second
const following = demoClock?.follow(db, { logger }) ?? null;
const port = await listen(server, config.port, config.host);
logger.info("serving", { host: config.host, port, copy_library: copyFile, environment: config.environment, integrations: config.integrations, tools: runtime.listTools().length, node: process.version, default_partner_id: config.borrowerDefaultPartnerId || null, google_oauth: config.googleOauth.clientId ? "configured" : "FAKE", talk: config.talk.apiKey ? `claude:${config.talk.model}` : "not configured", agent_turn: config.llm.apiKey ? `claude:${config.llm.model}` : "not configured", rate_feed: rateFeed.vendorName, fake_reviewers: reviewers ? `on (delay ${reviewers.delaySeconds}s: ${reviewers.roles.join(",")})` : "off" });
const shutdown = (signal: string): void => {
  logger.info("shutting down", { signal });
  following?.stop();
  server.close(() => { db.end().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(0), 8_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
