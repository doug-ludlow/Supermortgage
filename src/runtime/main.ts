/**
 * Container entrypoint: `node --experimental-strip-types src/runtime/main.ts <mode>`
 *   serve    HTTP API + ops console on $HOST:$PORT (the Cloud Run service)
 *   sweep    one pass over due timers and the outbox backlog, then exit (the Cloud Run job Cloud Scheduler runs every minute)
 *   migrate  apply db/migrations through db/migrate.sh, then exit (the Cloud Run job the deploy runs first)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect } from "../infra/db/client.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { Runtime } from "./app.ts";
import { createApiServer, listen } from "./server.ts";

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

if (mode !== "serve") { logger.error(`unknown mode ${mode}; use serve | sweep | migrate`); process.exit(2); }
if (!config.apiToken) logger.warn("API_TOKEN is empty: every route is open (ALLOW_INSECURE_NO_TOKEN=1)");
const server = createApiServer({ runtime, apiToken: config.apiToken, logger });
const port = await listen(server, config.port, config.host);
logger.info("serving", { host: config.host, port, environment: config.environment, integrations: config.integrations, tools: runtime.listTools().length, node: process.version });
const shutdown = (signal: string): void => {
  logger.info("shutting down", { signal });
  server.close(() => { db.end().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(0), 8_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
