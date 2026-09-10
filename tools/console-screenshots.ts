/**
 * Drive the demo console in headless Chromium and write docs/console/*.png.
 *   node --experimental-strip-types tools/console-screenshots.ts
 * Needs playwright-core (devDependency) and a Chromium at PLAYWRIGHT_CHROMIUM
 * (defaults to the /opt/pw-browsers install).
 */
import { chromium } from "playwright-core";
import { createConsoleServer, listen } from "../src/console/server.ts";
import { demoStore } from "./console-demo.ts";

const exe = process.env["PLAYWRIGHT_CHROMIUM"] ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const store = await demoStore();
const server = createConsoleServer({ store, clock: { now: () => "2026-10-17T15:00:00.000Z" } });
const port = await listen(server);
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => { localStorage.setItem("sm.actor", JSON.stringify({ id: "m.ruiz", role: "officer" })); });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector(".tile");
await page.screenshot({ path: "docs/console/dashboard.png" });
await page.click('nav a[data-kind="queue"]'); await page.waitForSelector("table, .empty");
await page.screenshot({ path: "docs/console/my-queue.png" });
await page.click('nav a[data-view="loans"]'); await page.waitForSelector("#results table");
await page.click('#results a[data-loan]'); await page.waitForSelector(".tabs");
await page.click('.tabs button[data-tab="decisions"]'); await page.waitForSelector("table");
await page.screenshot({ path: "docs/console/loan-decisions.png" });
await page.click('nav a[data-view="agents"]'); await page.waitForSelector("table");
await page.screenshot({ path: "docs/console/agents.png" });
await browser.close(); server.close();
console.log(`screenshots written to docs/console; page errors: ${errors.length}${errors.length ? "\n" + errors.join("\n") : ""}`);
if (errors.length) process.exit(1);
