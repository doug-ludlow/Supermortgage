/**
 * Run the ops console: `npm run console` (Postgres, DATABASE_URL) or
 * `npm run console -- --demo` (in-memory scenario with seeded queues).
 *   PORT=8787 npm run console
 */
import { createConsoleServer, listen } from "../src/console/server.ts";
import { PgConsoleStore } from "../src/console/pg-store.ts";
import { connect } from "../src/infra/db/client.ts";
import { loadOverriddenRegistry } from "../src/domain/timer-overrides.ts";
import { AgentRegistry } from "../src/app/agents.ts";
import { demoStore } from "./console-demo.ts";

const demo = process.argv.includes("--demo");
const store = demo ? await demoStore() : new PgConsoleStore(connect(), loadOverriddenRegistry(), new AgentRegistry());
const port = await listen(createConsoleServer({ store }), Number(process.env["PORT"] ?? 8787), process.env["HOST"] ?? "127.0.0.1");
console.log(`ops console (${demo ? "demo, in-memory" : "postgres"}) → http://127.0.0.1:${port}/  (set x-actor-id / x-actor-role; the UI's role picker does)`);
