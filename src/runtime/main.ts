/**
 * Container entrypoint: `node --experimental-strip-types src/runtime/main.ts <mode>`
 *   serve    HTTP API + ops console on $HOST:$PORT (the Cloud Run service)
 *   sweep    one pass over due timers and the outbox backlog, then exit (the Cloud Run job Cloud Scheduler runs every minute)
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
const runtime = new Runtime({ db, registry: loadOverriddenRegistry() });

if (mode === "sweep") {
  try {
    const report = await runtime.sweep();
    logger.info("sweep", { due: report.due, breaches: report.breaches.length, outbox: report.outbox, at: report.at });
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
const server = createApiServer({ runtime, apiToken: config.apiToken, logger, borrower: { environment: config.environment, defaultPartnerId: config.borrowerDefaultPartnerId, talk: { apiKey: config.talk.apiKey, model: config.talk.model, effort: config.talk.effort } } });
const copyFile = copyLibraryFile(); if (!copyFile) logger.error("copy library missing: docs/ux/12-message-copy-library.md is not in the image — SMS, voice and talk lines render as {{copy:key}} tokens");
const port = await listen(server, config.port, config.host);
logger.info("serving", { host: config.host, port, copy_library: copyFile, environment: config.environment, integrations: config.integrations, tools: runtime.listTools().length, node: process.version, default_partner_id: config.borrowerDefaultPartnerId || null, google_oauth: config.googleOauth.clientId ? "configured" : "FAKE", talk: config.talk.apiKey ? `claude:${config.talk.model}` : "not configured" });
const shutdown = (signal: string): void => {
  logger.info("shutting down", { signal });
  server.close(() => { db.end().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(0), 8_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
