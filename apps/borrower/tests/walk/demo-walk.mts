/**
 * The demo walk (docs/ux/17 §8.7): a real browser, the real model, the deployed demo — after every deploy, and on demand.
 *
 *   DEMO_BASE=https://demo.supermortgage.com node --experimental-strip-types tests/walk/demo-walk.mts
 *
 * It creates a fresh account, talks, and checks the eleven things a person must see work; every step leaves a screenshot in
 * WALK_OUT (default walk-out/) and the verdicts land in report.json. It is the only claim of "working" the surface accepts:
 * the audit fractions measure the engine; this measures the experience. A check that fails fails the job — it never
 * hides behind a fraction.
 *
 * The eleven outcomes:
 *   1. A fresh window reaches the account door, and creating an account lands in the conversation.
 *   2. The first message is the model's: it names the first step; no e-mail as a name; no template token; no fixed sentence.
 *   3. The rail shows one open card and one "Your record" line — nothing else.
 *   4. The disclosure footer is on the screen.
 *   5. Typing "Buy a home" gets a reply from the model that leads with the next need.
 *   6. The reply carries no deep link and no fixed line; the borrower's own line is in the thread.
 *   7. The rail's card follows the conversation (the current ask changes or stays the goal card, but never a batch).
 *   8. Sign out works: the next load shows the door, not the conversation.
 *   9. A second fresh context on the same host sees nothing of the first person.
 *  10. /video with no account reaches the call itself: no sign-in form, the call live, an account opened on the spot (32.17 rule 11).
 *  11. A homeowner from the partner book (33.1 rules 5–6): the code door on the fixture e-mail lands in the conversation; the first
 *      message names the partner as the servicer (the partner the deployed record carries — the configured partner on nonprod, 33.1 rule 7)
 *      and carries no digit; the record reads Monitored with the partner as servicer and the
 *      loan's last four; no goal card and no organic application ask on the rail; sign out. An unseeded book fails, never passes.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env["DEMO_BASE"] ?? "https://demo.supermortgage.com").replace(/\/$/, "");
const OUT = process.env["WALK_OUT"] ?? "walk-out";
const REPLY_TIMEOUT_MS = Number(process.env["WALK_REPLY_TIMEOUT_MS"] ?? 180_000);   // the real model, cold, through the guard and its tool calls
// 33.1 rule 7 / worked example A: loan 1 of the fixture book the demo seed imports (src/domain/partner-book/fixtures/partner-book-demo.ts:
// DEMO_PARTNER.legal_name, SEEDS[0].email, `NL-${100000 + 1}`) — copied here, not imported: this file runs from apps/borrower against the deployed demo
const PARTNER_BOOK = {
  email: process.env["WALK_PARTNER_BOOK_EMAIL"] ?? "maria.garcia@example.com",
  partner: process.env["WALK_PARTNER_BOOK_PARTNER"] ?? "Northlight Mortgage Servicing (FAKE partner)",
  loanLast4: process.env["WALK_PARTNER_BOOK_LAST4"] ?? "0001",   // NL-100001
  firstName: "Maria",
};
const NOT_SEEDED = "partner book not seeded: dispatch the deploy with seed_demo=true";
mkdirSync(OUT, { recursive: true });

type Check = { n: number; what: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (n: number, what: string, ok: boolean, detail = ""): void => { checks.push({ n, what, ok, detail }); console.log(`${ok ? "ok " : "NOT"} ${n}. ${what}${detail ? ` — ${detail}` : ""}`); };
let shot = 0;
const snap = async (page: Page, name: string): Promise<void> => {
  shot += 1; await page.screenshot({ path: join(OUT, `${String(shot).padStart(2, "0")}-${name}.png`), fullPage: false }).catch(() => undefined);
  // what the page says, in the log (the artifact host is not always reachable from where the report is read)
  const thread = await page.locator('[data-testid="thread"] .sm-msg').evaluateAll((els: Element[]) => els.map((e) => `${e.getAttribute("data-sender")}: ${(e.querySelector(".sm-msg-body") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").slice(0, 240) ?? "(no body)"}`)).catch(() => [] as string[]);
  const rail = await page.locator('[data-testid="record"]').first().innerText().catch(() => "");
  const header = await page.locator('[data-testid="header"]').first().innerText().catch(() => "");
  const fixtures = await page.locator('[data-testid="shell"]').first().getAttribute("data-fixtures").catch(() => null);
  console.log(`--- ${name} @ ${page.url()}\n  header: ${JSON.stringify(header.replace(/\s+/g, " "))} fixtures=${fixtures}\n  thread: ${JSON.stringify(thread)}\n  rail: ${JSON.stringify(rail.replace(/\s+/g, " ").slice(0, 400))}`);
};

// a fixed line, or the step's default copy standing in for the model (a card title as the reply, the placeholder): the model did not speak
const FIXED_LINE = /\{\{|You told me:|Tap to confirm so it counts|Bringing a person in now|What next\?$|Anything else\?$|^What are we doing today\?$|I'm looking at your file now|I'm checking your loan now/i;
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

type ApiAnswer = { status: number; body: Record<string, unknown> };
/** A borrower API call made by the page itself through the same-origin proxy (/app/api → API), so a session answer's `token` becomes the page's HttpOnly cookie exactly as the app's own client gets it. */
const apiOnPage = (page: Page, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<ApiAnswer> =>
  page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(`/app/api${path}`, { method, credentials: "include", headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json: Record<string, unknown> = {};
    try { json = (await res.json()) as Record<string, unknown>; } catch { /* a non-JSON body */ }
    return { status: res.status, body: json };
  }, { method, path, body });

/**
 * 33.1 rule 5 — the code door on the sign-in page for an e-mail on file: request a code to the e-mail, enter the code the FAKE e-mail port echoes
 * (`fake_code`, outside production only), and the session opens on the party that carries the e-mail. When the sign-in page renders the code door
 * itself (`[data-testid="account-code-request"]` beside the e-mail field — the integration step's control), it is driven through the form and the
 * echoed code is read from `[data-testid="fake-code"]` ("FAKE code · 123456") and typed into `[data-testid="account-code"] input`; until then the
 * same two calls (`POST /v1/borrower/auth/otp {action: request, channel: email}` → `{action: verify}`) go through the page's proxy, which sets the
 * same cookie. The API never says whether an e-mail is known (no enumeration), so "unknown" is read after the door: a session with no loan subject.
 */
async function codeDoor(page: Page, email: string): Promise<{ how: "form" | "proxy"; error?: string }> {
  await page.goto(`${BASE}/app/sign-in`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector('[data-testid="account"]', { timeout: 60_000 }).catch(() => undefined);
  const formDoor = page.locator('[data-testid="account-code-request"]');
  if ((await formDoor.count()) === 1) {
    await page.locator('[data-testid="account-form"] input[type="email"]').fill(email);
    await formDoor.click();
    await page.waitForSelector('[data-testid="account-code"]', { timeout: 30_000 });
    const echoed = ((await page.locator('[data-testid="fake-code"]').first().innerText().catch(() => "")).match(/(\d{6})/) ?? [])[1];
    if (!echoed) return { how: "form", error: "the sign-in page showed the code step but no echoed FAKE code (is the demo running with the FAKE e-mail port outside production?)" };
    await page.locator('[data-testid="account-code"] input').fill(echoed);
    await page.locator('[data-testid="account-code"] button[type="submit"]').click();
    await page.waitForURL((u) => /^\/app\/?$/.test(u.pathname), { timeout: 60_000 }).catch(() => undefined);
    const refusal = await page.locator('[data-testid="account-error"]').first().innerText().catch(() => "");
    return { how: "form", ...(refusal.trim() ? { error: `the code step refused: ${refusal.trim()}` } : {}) };
  }
  const requested = await apiOnPage(page, "POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
  if (requested.status !== 200) {
    const code = String(requested.body["code"] ?? "");
    // a door that refuses the e-mail as not on file is the unseeded book; anything else is the door itself failing
    const unknown = requested.status === 404 || /unknown|not_found|not_on_file|no_such/i.test(code);
    return { how: "proxy", error: unknown ? NOT_SEEDED : `code request answered ${requested.status} ${JSON.stringify(requested.body).slice(0, 200)}` };
  }
  const fakeCode = typeof requested.body["fake_code"] === "string" ? (requested.body["fake_code"] as string) : "";
  if (!fakeCode) return { how: "proxy", error: `no echoed FAKE code on the request answer (delivery=${String(requested.body["delivery"])}): the demo must run the FAKE e-mail port outside production` };
  const verified = await apiOnPage(page, "POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: String(requested.body["challenge_id"] ?? ""), code: fakeCode });
  if (verified.status !== 200) return { how: "proxy", error: `code verify answered ${verified.status} ${JSON.stringify(verified.body).slice(0, 200)}` };
  return { how: "proxy" };
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
  const input = page.locator('[data-testid="action-bar"] textarea, [data-testid="action-bar"] input:not([type="file"])').first();
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

  // 10. the video door: a fresh context with no account reaches the call itself (32.17 rule 11) — never a 404, never a sign-in form; an account is opened on the spot
  const ctxV = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera", "microphone"] });
  const pv = await ctxV.newPage();
  const videoStarted = Date.now();
  await pv.goto(`${BASE}/video`, { waitUntil: "load", timeout: 60_000 }).catch(() => undefined);
  await pv.waitForSelector('[data-testid="video-call"][data-phase="live"], [data-testid="video-call"][data-phase="failed"]', { timeout: 90_000 }).catch(() => undefined);
  const liveAfterMs = Date.now() - videoStarted;
  await pv.waitForTimeout(1500);
  await snap(pv, "video-door");
  const videoPhase = await pv.locator('[data-testid="video-call"]').getAttribute("data-phase").catch(() => null);
  const videoVendor = await pv.locator('[data-testid="video-call"]').getAttribute("data-vendor").catch(() => null);
  // on the live vendor the call is working only when the replica's video is playing on the stage (32.17 rule 15) — the seconds it takes are the black-screen time
  let replica: string | null = null; let replicaAfterMs: number | null = null;
  if (videoPhase === "live" && videoVendor && videoVendor !== "FAKE") {
    await pv.waitForSelector('[data-testid="video-live"][data-replica="in"] video[data-testid="video-remote"]', { timeout: 75_000 }).then(() => { replicaAfterMs = Date.now() - videoStarted; }).catch(() => undefined);
    replica = await pv.locator('[data-testid="video-live"]').getAttribute("data-replica").catch(() => null);
    await snap(pv, "video-michelle");
  }
  const videoStatus = await pv.locator('[data-testid="video-status"], [data-testid="video-error"], [data-testid="video-debug"]').allInnerTexts().catch(() => [] as string[]);
  const videoOk = /\/app\/video/.test(pv.url()) && (await pv.locator('text=This page could not be found').count()) === 0 && videoPhase === "live" && (await pv.locator('[data-testid="account"], main form input[type="password"]').count()) === 0 && (videoVendor === "FAKE" || replica === "in");
  record(10, "/video with no account reaches the call itself: no sign-in form, the call live, an account opened on the spot", videoOk, `${pv.url()} phase=${videoPhase} vendor=${videoVendor} live after ${liveAfterMs}ms; Michelle ${replica === "in" ? `in the room after ${replicaAfterMs}ms` : `not in the room after 75s (${replica})`}; stage: ${JSON.stringify(videoStatus)}`);
  await ctxV.close();

  // 8. sign out
  await page.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector('[data-testid="thread"]', { timeout: 60_000 }).catch(() => undefined);
  const signOut = page.locator('[data-testid="sign-out-button"]');
  await signOut.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);   // the header shows Sign out once GET /me has answered — after the thread renders
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

  // 11. a homeowner from the partner book (33.1 rules 5–6): the code door on the fixture e-mail, the first turn naming the partner, the Monitored record, no goal card; sign out
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page3 = await ctx3.newPage();
  const door = await codeDoor(page3, PARTNER_BOOK.email);
  await snap(page3, "partner-book-code-door");
  if (door.error) {
    record(11, "a partner-book homeowner signs in by code: the first turn names the partner, the record reads Monitored, no goal card", false, `${door.error} (door: ${door.how})`);
  } else {
    // the session must be on the provisioned party: a loan subject. A code on an e-mail the book never provisioned opens a fresh lead-stage party with no subject (32.14) — that is the unseeded demo, and it fails here
    const me = await apiOnPage(page3, "GET", "/v1/borrower/me");
    const subjects = Array.isArray(me.body["subjects"]) ? (me.body["subjects"] as Record<string, unknown>[]) : [];
    const loanSubject = subjects.find((s) => typeof s["loan_id"] === "string" && s["loan_id"]);
    if (me.status !== 200 || !loanSubject) {
      record(11, "a partner-book homeowner signs in by code: the first turn names the partner, the record reads Monitored, no goal card", false, `${NOT_SEEDED} (GET /me ${me.status}: ${subjects.length} subject(s), none a loan; door: ${door.how})`);
    } else {
      // 33.1 rule 7: the demo book loads under the configured partner (BORROWER_DEFAULT_PARTNER_ID's party — "Partner Bank (FAKE demo)" on
      // nonprod) and only under DEMO_PARTNER when none is configured — so the partner the first turn must name and the loan's last four are
      // read from the deployed record's partner_book, never assumed from the fixture; the fixture values stand in only when the record has none
      const rec = await apiOnPage(page3, "GET", `/v1/borrower/record?subject=${encodeURIComponent(String(loanSubject["loan_id"]))}`);
      const pb = rec.status === 200 && rec.body["partner_book"] && typeof rec.body["partner_book"] === "object" ? (rec.body["partner_book"] as Record<string, unknown>) : {};
      const expectedPartner = typeof pb["partner_name"] === "string" && pb["partner_name"] ? (pb["partner_name"] as string) : PARTNER_BOOK.partner;
      const expectedLast4 = typeof pb["loan_last4"] === "string" && pb["loan_last4"] ? (pb["loan_last4"] as string) : PARTNER_BOOK.loanLast4;
      await page3.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
      await page3.waitForSelector('[data-testid="thread"]', { timeout: 60_000 }).catch(() => undefined);
      const landed = /^\/app\/?$/.test(new URL(page3.url()).pathname) && (await page3.locator('[data-testid="thread"]').count()) === 1 && (await page3.locator('[data-testid="account"]').count()) === 0;
      const firstLines = await waitForAgentLines(page3, 1);
      const greeting = firstLines[0] ?? "";
      // the rail: "Your record" is one collapsed line (its body is `hidden`) — open it to read the badge, the header's loan label and the people rows
      const rail = page3.locator('[data-testid="record"]');
      const recordToggle = rail.locator('[data-record-section="record"] > h2 button').first();
      if ((await rail.locator('[data-record-section="record"][data-open="false"]').count()) === 1) await recordToggle.click().catch(() => undefined);
      await page3.waitForTimeout(500);
      await snap(page3, "partner-book-first-turn");
      const badge = (await rail.locator('[data-record-section="status"] [data-testid="status-badge"]').first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const headerLine = (await rail.locator('[data-record-section="header"]').first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const peopleText = (await rail.locator('[data-record-section="people"]').first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const numbersText = (await rail.locator('[data-record-section="numbers"]').first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const goalCards = await rail.locator('[data-rail-card] article[data-copy-key="entry.goal.question"], [data-rail-card] article[data-copy-key="entry.proceed.question"]').count();
      const neededCards = await rail.locator('[data-record-section="needed"] [data-rail-card]').count();
      const nothingNeeded = (await rail.locator('[data-testid="needs-none"]').count()) === 1;
      const greetsByName = greeting.includes(PARTNER_BOOK.firstName);   // rule 5: by first name (logged; the verdict is the partner and no figure)
      // the first-turn instruction (src/runtime/borrower/agent/context.ts) has the assistant say "your loan ending {{partner_book.loan_last4}}" — those four digits are the one number a first turn may carry; any other digit, a %, a $ or an unresolved token fails
      const digitsOtherThanLast4 = /\d/.test(greeting.split(expectedLast4).join(""));
      const greetingOk = !!greeting && greeting.includes(expectedPartner) && !digitsOtherThanLast4 && !/[%$]/.test(greeting) && !FIXED_LINE.test(greeting) && !greeting.includes("@");
      const monitoredOk = /\bMonitored\b/.test(badge) && peopleText.includes(expectedPartner) && headerLine.endsWith(expectedLast4);
      const noGoalOk = goalCards === 0 && neededCards === 0 && nothingNeeded;
      // sign out: the header's control, then the next load is the door
      const signOut3 = page3.locator('[data-testid="sign-out-button"]');
      await signOut3.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
      const hadSignOut3 = (await signOut3.count()) === 1;
      if (hadSignOut3) { await signOut3.click(); await page3.waitForTimeout(2000); }
      await page3.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
      await page3.waitForTimeout(2500);
      await snap(page3, "partner-book-after-sign-out");
      const doorAfter3 = (await page3.locator('[data-testid="account"], [data-testid="sign-in-button"]').count()) > 0 && (await page3.locator('[data-testid="thread"] .sm-msg').count()) === 0;
      record(11, "a partner-book homeowner signs in by code: the first turn names the partner, the record reads Monitored, no goal card",
        landed && greetingOk && monitoredOk && noGoalOk && hadSignOut3 && doorAfter3,
        `door=${door.how} partner=${JSON.stringify(expectedPartner)} last4=${expectedLast4} landed=${landed} byName=${greetsByName} greeting=${JSON.stringify(greeting.slice(0, 200))} badge=${JSON.stringify(badge)} header=${JSON.stringify(headerLine)} people=${JSON.stringify(peopleText.slice(0, 160))} numbers=${JSON.stringify(numbersText.slice(0, 160))} goalCards=${goalCards} neededCards=${neededCards} nothingNeeded=${nothingNeeded} signOut=${hadSignOut3} doorAfter=${doorAfter3}`);
    }
  }
  await ctx3.close();

  if (pageErrors.length) console.log(`page errors: ${JSON.stringify(pageErrors.slice(0, 5))}`);
  await ctx.close();
}

const browser = await chromium.launch();
try { await walk(browser); }
catch (e) { record(0, "the walk itself ran to the end", false, e instanceof Error ? e.message : String(e)); }
finally { await browser.close(); }
const failed = checks.filter((c) => !c.ok);
const report = { base: BASE, at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks };
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n--- report.json\n${JSON.stringify(report)}`);
console.log(`\n${checks.length - failed.length} of ${checks.length} outcomes hold on ${BASE}`);
process.exit(failed.length ? 1 : 0);
