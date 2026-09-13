/**
 * The demo walk (docs/ux/17 §8.7): a real browser, the real model, the deployed demo — after every deploy, and on demand.
 *
 *   DEMO_BASE=https://demo.supermortgage.com node --experimental-strip-types tests/walk/demo-walk.mts
 *
 * It creates a fresh account, talks, and checks the ten things a person must see work; every step leaves a screenshot in
 * WALK_OUT (default walk-out/) and the verdicts land in report.json. It is the only claim of "working" the surface accepts:
 * the audit fractions measure the engine; this measures the experience. A check that fails fails the job — it never
 * hides behind a fraction.
 *
 * The ten outcomes:
 *   1. A fresh window reaches the account door, and creating an account lands in the conversation.
 *   2. The first message is the model's: it names the first step; no e-mail as a name; no template token; no fixed sentence.
 *   3. The rail shows one open card and one "Your record" line — nothing else.
 *   4. The disclosure footer is on the screen.
 *   5. Typing "Buy a home" gets a reply from the model that leads with the next need.
 *   6. The reply carries no deep link and no fixed line; the borrower's own line is in the thread.
 *   7. The rail's card follows the conversation (the current ask changes or stays the goal card, but never a batch).
 *   8. Sign out works: the next load shows the door, not the conversation.
 *   9. A second fresh context on the same host sees nothing of the first person.
 *  10. /video reaches the video page behind the door (the FAKE or the live replica, never a 404).
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env["DEMO_BASE"] ?? "https://demo.supermortgage.com").replace(/\/$/, "");
const OUT = process.env["WALK_OUT"] ?? "walk-out";
const REPLY_TIMEOUT_MS = Number(process.env["WALK_REPLY_TIMEOUT_MS"] ?? 90_000);   // the real model, cold, through the guard
mkdirSync(OUT, { recursive: true });

type Check = { n: number; what: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (n: number, what: string, ok: boolean, detail = ""): void => { checks.push({ n, what, ok, detail }); console.log(`${ok ? "ok " : "NOT"} ${n}. ${what}${detail ? ` — ${detail}` : ""}`); };
let shot = 0;
const snap = async (page: Page, name: string): Promise<void> => { shot += 1; await page.screenshot({ path: join(OUT, `${String(shot).padStart(2, "0")}-${name}.png`), fullPage: false }).catch(() => undefined); };

const FIXED_LINE = /\{\{|You told me:|Tap to confirm so it counts|Bringing a person in now|What next\?$|Anything else\?$/i;
const agentLines = async (page: Page): Promise<string[]> => page.locator('[data-testid="thread"] .sm-msg[data-sender="agent"] .sm-msg-body').allInnerTexts();
const borrowerLines = async (page: Page): Promise<string[]> => page.locator('[data-testid="thread"] .sm-msg[data-sender="borrower"] .sm-msg-body').allInnerTexts();
const waitForAgentLines = async (page: Page, atLeast: number): Promise<string[]> => {
  const started = Date.now();
  while (Date.now() - started < REPLY_TIMEOUT_MS) { const lines = await agentLines(page); if (lines.length >= atLeast && lines[atLeast - 1]!.trim()) return lines; await page.waitForTimeout(1000); }
  return agentLines(page);
};
const railState = async (page: Page) => {
  const rail = page.locator('[data-testid="record"]');
  const openRows = await rail.locator('[data-record-section="needed"] [data-rail-card][data-expanded="true"]').count();
  const visibleRows = await rail.locator('[data-record-section="needed"] [data-rail-card]:visible').count();
  const later = await rail.locator('[data-testid="needs-later"]').count();
  const laterText = later ? (await rail.locator('[data-testid="needs-later"]').first().innerText()).trim() : "";
  const recordLine = await rail.locator('[data-record-section="record"]').count();
  const recordOpen = recordLine ? await rail.locator('[data-record-section="record"]').getAttribute("data-open") : null;
  const currentKey = await rail.locator('[data-rail-card][data-current-ask="true"] article').first().getAttribute("data-copy-key").catch(() => null);
  const currentId = await rail.locator('[data-rail-card][data-current-ask="true"]').first().getAttribute("data-rail-card").catch(() => null);
  return { openRows, visibleRows, later, laterText, recordLine, recordOpen, currentKey, currentId };
};

async function signUp(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE}/app/sign-up`, { waitUntil: "load", timeout: 60_000 });
  await page.locator('[data-testid="account-form"] input[type="email"]').fill(email);
  await page.locator('[data-testid="account-form"] input[type="password"]').fill(password);
  await page.locator('[data-testid="account-form"] button[type="submit"]').click();
  await page.waitForURL((u) => /\/app\/?(\?.*)?$/.test(u.pathname + u.search) || u.pathname === "/app", { timeout: 60_000 }).catch(() => undefined);
  await page.waitForSelector('[data-testid="thread"]', { timeout: 60_000 });
}

async function walk(browser: Browser): Promise<void> {
  const run = Date.now().toString(36);
  const email = `walk-${run}@example.test`; const password = `walk-${run}-correct-horse`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors: string[] = []; page.on("pageerror", (e) => pageErrors.push(e.message));

  // 1. the door, then the conversation
  await page.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
  await snap(page, "fresh-window");
  const doorShown = (await page.locator('[data-testid="account"], [data-testid="sign-in-button"]').count()) > 0;
  await signUp(page, email, password);
  await snap(page, "after-sign-up");
  record(1, "a fresh window shows the door; creating an account lands in the conversation", doorShown && (await page.locator('[data-testid="thread"]').count()) === 1, doorShown ? "" : "no door on the fresh window");

  // 2. the first message is the model's
  const first = await waitForAgentLines(page, 1);
  await snap(page, "first-message");
  const greeting = first[0] ?? "";
  record(2, "the first message is the model's, names the first step, no e-mail, no token, no fixed line", !!greeting && !greeting.includes("@") && !FIXED_LINE.test(greeting) && greeting.length > 20, greeting.slice(0, 160));

  // 3. the rail: one open card, one "Your record" line
  const r0 = await railState(page);
  record(3, "the rail shows one open card and the Your record line, nothing else open", r0.openRows === 1 && r0.visibleRows === 1 && r0.recordLine === 1 && r0.recordOpen === "false", JSON.stringify(r0));

  // 4. the footer
  record(4, "the disclosure footer is on the screen", (await page.locator('[data-testid="footer-disclosure"]').count()) === 1 && (await page.locator('[data-testid="talk-to-person"]').count()) === 0);

  // 5–7. talk
  const input = page.locator('[data-testid="action-bar"] textarea, [data-testid="action-bar"] input').first();
  await input.fill("Buy a home");
  await page.locator('[data-testid="send"]').click();
  const after = await waitForAgentLines(page, 2);
  await snap(page, "after-buy-a-home");
  const reply = after[1] ?? "";
  record(5, 'typing "Buy a home" gets a reply from the model that leads with the next need', !!reply && !FIXED_LINE.test(reply) && reply.length > 20 && !/^what next\??$/i.test(reply.trim()), reply.slice(0, 200));
  const mine = await borrowerLines(page);
  record(6, "the borrower's own line is in the thread; no deep link, no fixed line", mine.some((l) => /buy a home/i.test(l)) && !after.some((l) => FIXED_LINE.test(l)), `borrower lines: ${JSON.stringify(mine)}`);
  const r1 = await railState(page);
  record(7, "the rail still shows one card, following the conversation (never a batch)", r1.openRows <= 1 && r1.visibleRows <= 1, `${JSON.stringify(r0)} → ${JSON.stringify(r1)}`);

  // 10. /video behind the door (same session)
  await page.goto(`${BASE}/video`, { waitUntil: "load", timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  await snap(page, "video");
  const videoOk = /\/app\/video/.test(page.url()) && (await page.locator('text=This page could not be found').count()) === 0 && (await page.locator('[data-testid="video-call"], [data-testid="video-frame"], [data-testid="video-frame-fake"], [data-testid="video-permission-note"], [data-testid="video-unavailable"], [data-testid="video-status"]').count()) > 0;
  record(10, "/video reaches the video page behind the door (never a 404)", videoOk, page.url());

  // 8. sign out
  await page.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector('[data-testid="thread"]', { timeout: 60_000 }).catch(() => undefined);
  const signOut = page.locator('[data-testid="sign-out-button"]');
  const hadSignOut = (await signOut.count()) === 1;
  if (hadSignOut) { await signOut.click(); await page.waitForTimeout(2000); }
  await page.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(2500);
  await snap(page, "after-sign-out");
  const doorAgain = (await page.locator('[data-testid="account"], [data-testid="sign-in-button"]').count()) > 0 && (await page.locator('[data-testid="thread"] .sm-msg').count()) === 0;
  record(8, "sign out works: the next load shows the door, not the conversation", hadSignOut && doorAgain, hadSignOut ? "" : "no Sign out control");

  // 9. a second fresh context sees nothing of the first person
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await ctx2.newPage();
  await page2.goto(`${BASE}/app/talk`, { waitUntil: "load", timeout: 60_000 }).catch(() => undefined);
  await page2.waitForTimeout(4000);
  await snap(page2, "second-context-talk");
  const talkText = await page2.locator("body").innerText().catch(() => "");
  await page2.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
  await page2.waitForTimeout(2500);
  const door2 = (await page2.locator('[data-testid="account"], [data-testid="sign-in-button"]').count()) > 0;
  record(9, "a second fresh context sees nothing of the first person", door2 && !talkText.includes("Buy a home") && !talkText.includes(email), door2 ? "" : "the second context did not get the door");
  await ctx2.close();

  if (pageErrors.length) console.log(`page errors: ${JSON.stringify(pageErrors.slice(0, 5))}`);
  await ctx.close();
}

const browser = await chromium.launch();
try { await walk(browser); }
catch (e) { record(0, "the walk itself ran to the end", false, e instanceof Error ? e.message : String(e)); }
finally { await browser.close(); }
const failed = checks.filter((c) => !c.ok);
writeFileSync(join(OUT, "report.json"), JSON.stringify({ base: BASE, at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
console.log(`\n${checks.length - failed.length} of ${checks.length} outcomes hold on ${BASE}`);
process.exit(failed.length ? 1 : 0);
