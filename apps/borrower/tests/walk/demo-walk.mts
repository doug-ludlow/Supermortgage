/**
 * The demo walk (docs/ux/18; PLAN §4): a real browser on the deployed demo — after every deploy, and on demand.
 *
 *   DEMO_BASE=https://demo.supermortgage.com node --experimental-strip-types tests/walk/demo-walk.mts
 *
 * It creates fresh accounts on the Apply product (32.19) and checks the ten things a person must see work; every step leaves a
 * screenshot in WALK_OUT (default walk-out/) and the verdicts land in report.json. It is the only claim of "working" the surface
 * accepts: the audit fractions measure the engine; this measures the experience. A check that fails fails the job — it never
 * hides behind a fraction, and nothing here passes by default.
 *
 * The ten outcomes:
 *   1. A fresh window reaches the light door: welcome on the paper, none of the old shell, the disclosure footer; Continue → intro;
 *      "Create an account" → the account form with Google; "Already have an account?" → the sign-in form.
 *   2. Creating an account lands on Apply at the goal step; GET /me through the page's proxy lists the application; no error line.
 *   3. Buy with an address reaches the DU moment from the screens: goal → property → you → connect → details → the declarations →
 *      the demographics → "Confirm these numbers"; every Continue advances with an empty error line; no preapproval card on the
 *      thread; the badge reads Verifying; the DU-side facts read through the ops API with WALK_OPS_TOKEN (no token → NOT ok, by
 *      name); no "DU" / "Desktop Underwriter" / "Fannie" on the screen.
 *   4. Buy, still looking, ends at the preapproval request: preapproval.where resolved, preapproval.target on Review, the badge
 *      Application received (or Preapproved), apply.review.tbd, and no six-item address on the ops record.
 *   5. Refinance, cash out: transaction_type cash_out on the ops record; no shopping switch; value, balance, cash out and what the cash is for
 *      collected (DELTA-37: application.field.captured{cash_out_purpose} on the ops record); refi.home.confirm resolved after the SSN with the
 *      estate and the lien; the same DU verdict (required_missing 0: the purpose reaches LOAN/REFINANCE/RefinancePrimaryPurposeType).
 *   6. Errors stay on the step, in copy: Details without citizenship keeps the step with a copy line; a 409 CARD_FIELD_REQUIRED
 *      (the refinance home card tapped bare after a reload) renders copy(copy_key) on the step, never the code.
 *   7. My Loan is empty for a fresh account (no dollar sign, no digit); Tasks marks the done rows and a tap jumps to the step.
 *   8. Sign out works: the next load is the door; a second fresh context sees nothing of the first person.
 *   9. A partner-book homeowner (33.1) signs in by code and lands on My Loan: Monitored, the servicer and the last four from the
 *      deployed partner_book; Apply shows no step and no goal card; sign out → the door. An unseeded book fails, never passes.
 *  10. Returns and ?card= land on the card: /app/return/{vendor}/{card} → /app?card= on the Connect step with the card's row;
 *      an unknown card → Apply with no card and no error naming one; /app/d/{token} without a session → Account with the token retained.
 *
 * Environment (the WALK_* contract): DEMO_BASE (the demo), WALK_OUT (screenshots + report.json), WALK_OPS_TOKEN (outcomes 3–5 read
 * the ops record; unset → those outcomes are NOT ok by name), WALK_DU_STEP_TIMEOUT_MS (per card/screen waited for), WALK_REPLY_TIMEOUT_MS
 * (the DU moment's wait on the ops record), WALK_PARTNER_BOOK_EMAIL / _PARTNER / _LAST4 (outcome 9's fixture), WALK_API_BASE (where
 * the ops API answers when it is not DEMO_BASE — a local run against the harness's app and API on two ports).
 */
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { duVerdict, waitForDuMoment, JourneyError, type OpsRecord } from "./du-journey.mts";
import { ADDRESS, MOBILE, SSN, WALK_DOB, WALK_NAME, ScreenError, attr, badgeText, confirmNumbers, connect, continueTo, declarationsNone, demographicsDecline, details, driveToReview, errorText, fill, goal, pick, property, screenText, signUpThroughDoor, tab, waitForBadge, waitForStep, watchNetwork, you, type DriveOptions, type StepRecord } from "./apply-journey.mts";

// the copy library as the app renders it (lib/copy/generated.ts, from docs/ux/12): loaded by URL — this file runs under plain node against a deployed demo, where a directory import does not resolve
const { COPY } = (await import(new URL("../../lib/copy/generated.ts", import.meta.url).href)) as { COPY: Record<string, { text: string }> };
const isCopyKey = (key: string): boolean => Object.prototype.hasOwnProperty.call(COPY, key);
const copy = (key: string): string => (isCopyKey(key) ? COPY[key]!.text : `{{copy:${key}}}`);

const BASE = (process.env["DEMO_BASE"] ?? "https://demo.supermortgage.com").replace(/\/$/, "");
const API_BASE = (process.env["WALK_API_BASE"] ?? BASE).replace(/\/$/, "");
const OUT = process.env["WALK_OUT"] ?? "walk-out";
// outcomes 3–5 read the DU record through the ops API (src/runtime/server.ts GET /v1/applications/{id}, `Authorization: Bearer <API_TOKEN>`): deploy.yml reads the token from Secret Manager, walk.yml from the WALK_OPS_TOKEN repository secret
const OPS_TOKEN = (process.env["WALK_OPS_TOKEN"] ?? "").trim();
const NO_OPS_TOKEN = "WALK_OPS_TOKEN not provided: this outcome reads the application's record through the ops API";
const DU_STEP_TIMEOUT_MS = Number(process.env["WALK_DU_STEP_TIMEOUT_MS"] ?? 90_000);   // per card or screen waited for: the deployed flows react asynchronously (the FAKE bureau, the FAKE DU run)
const DU_MOMENT_TIMEOUT_MS = Number(process.env["WALK_REPLY_TIMEOUT_MS"] ?? 180_000);   // the DU moment on the ops record, after the last tap
// 33.1 rule 7 / worked example A: loan 1 of the fixture book the demo seed imports (src/domain/partner-book/fixtures/partner-book-demo.ts:
// DEMO_PARTNER.legal_name, SEEDS[0].email, `NL-${100000 + 1}`) — copied here, not imported: this file runs from apps/borrower against the deployed demo
const PARTNER_BOOK = {
  email: process.env["WALK_PARTNER_BOOK_EMAIL"] ?? "maria.garcia@example.com",
  partner: process.env["WALK_PARTNER_BOOK_PARTNER"] ?? "Northlight Mortgage Servicing (FAKE partner)",
  loanLast4: process.env["WALK_PARTNER_BOOK_LAST4"] ?? "0001",   // NL-100001
  firstName: "Maria",
};
const NOT_SEEDED = "partner book not seeded: dispatch the deploy with seed_demo=true";
const DU_WORDS = /\bDU\b|Desktop Underwriter|Fannie/;
mkdirSync(OUT, { recursive: true });

type Check = { n: number; what: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (n: number, what: string, ok: boolean, detail = ""): void => { checks.push({ n, what, ok, detail }); console.log(`${ok ? "ok " : "NOT"} ${n}. ${what}${detail ? ` — ${detail}` : ""}`); };
let shot = 0;
const snap = async (page: Page, name: string): Promise<void> => {
  shot += 1; await page.screenshot({ path: join(OUT, `${String(shot).padStart(2, "0")}-${name}.png`), fullPage: false }).catch(() => undefined);
  // what the page says, in the log (the artifact host is not always reachable from where the report is read)
  const [door, tabId, step] = await Promise.all([attr(page, "data-door").catch(() => null), attr(page, "data-tab").catch(() => null), attr(page, "data-step").catch(() => null)]);
  const text = (await screenText(page)).replace(/\s+/g, " ").slice(0, 400);
  console.log(`--- ${name} @ ${page.url()}\n  door=${door} tab=${tabId} step=${step} badge=${JSON.stringify(await badgeText(page))} error=${JSON.stringify(await errorText(page))}\n  screen: ${JSON.stringify(text)}`);
};
const log = (line: string): void => console.log(`  ${line}`);
const opts: DriveOptions = { stepTimeoutMs: DU_STEP_TIMEOUT_MS, log };
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type ApiAnswer = { status: number; body: Record<string, unknown> };
/** A borrower API call made by the page itself through the same-origin proxy (/app/api → API), so a session answer's `token` becomes the page's HttpOnly cookie exactly as the app's own client gets it. */
const apiOnPage = (page: Page, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<ApiAnswer> =>
  page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(`/app/api${path}`, { method, credentials: "include", headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let json: Record<string, unknown> = {};
    try { json = (await res.json()) as Record<string, unknown>; } catch { /* a non-JSON body */ }
    return { status: res.status, body: json };
  }, { method, path, body });

type WireCard = { card_instance_id: string; kind: string; status: string; copy_key: string; props: Record<string, unknown>; resolved_at?: string | null; created_at?: string };
/** Every card the thread carries — the pending ones beside the messages and the messages' own (resolved) cards — one entry per id: the status, the props and resolved_at; never the evidence (record.ts threadMessages keeps the confirmed values off the wire). */
async function threadCards(page: Page): Promise<WireCard[]> {
  const t = await apiOnPage(page, "GET", "/v1/borrower/thread?limit=500");
  if (t.status !== 200) throw new JourneyError("thread", `GET /v1/borrower/thread answered ${t.status}: ${JSON.stringify(t.body).slice(0, 200)}`);
  const byId = new Map<string, WireCard>();
  for (const m of (Array.isArray(t.body["messages"]) ? (t.body["messages"] as Record<string, unknown>[]) : [])) { const c = m["card"] as WireCard | null | undefined; if (c && c.card_instance_id) byId.set(c.card_instance_id, c); }
  for (const c of (Array.isArray(t.body["cards"]) ? (t.body["cards"] as WireCard[]) : [])) byId.set(c.card_instance_id, c);
  return [...byId.values()];
}
/** The application on GET /v1/borrower/me (the organic one landSession created). */
async function applicationOnMe(page: Page): Promise<{ status: number; application_id: string | null; subjects: Record<string, unknown>[] }> {
  const me = await apiOnPage(page, "GET", "/v1/borrower/me");
  const subjects = Array.isArray(me.body["subjects"]) ? (me.body["subjects"] as Record<string, unknown>[]) : [];
  const app = subjects.find((s) => typeof s["application_id"] === "string" && s["application_id"]);
  return { status: me.status, application_id: app ? String(app["application_id"]) : null, subjects };
}
/** The ops record (GET /v1/applications/{id}) with the bearer — never the page's session (the ops routes refuse borrower sessions and the borrower routes the token). */
async function readOps(applicationId: string): Promise<OpsRecord> {
  const res = await fetch(`${API_BASE}/v1/applications/${encodeURIComponent(applicationId)}`, { headers: { accept: "application/json", authorization: `Bearer ${OPS_TOKEN}` } });
  if (res.status !== 200) throw new JourneyError("ops record", `GET /v1/applications/{id} answered ${res.status}${res.status === 401 || res.status === 403 ? " (is WALK_OPS_TOKEN the deployed API_TOKEN?)" : ""}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as OpsRecord;
}
const stepsLine = (steps: StepRecord[]): string => steps.map((s) => `${s.step}${s.error ? `!${JSON.stringify(s.error)}` : ""}`).join(" → ");

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

/** The DU moment from the screens (outcomes 3 and 5): the badge Verifying on Result, then the verdict on the ops record — without the token the outcome cannot be read, so it is NOT ok, by name. */
async function duMomentFromScreens(page: Page, applicationId: string): Promise<{ ok: boolean; detail: string }> {
  const badge = await waitForBadge(page, /^Verifying$/, DU_STEP_TIMEOUT_MS);
  const badgeOk = badge === "Verifying";
  if (!OPS_TOKEN) return { ok: false, detail: `${NO_OPS_TOKEN}; badge=${JSON.stringify(badge)}` };
  const rec = await waitForDuMoment(() => readOps(applicationId), { timeoutMs: DU_MOMENT_TIMEOUT_MS });
  const verdict = duVerdict(rec);
  return { ok: badgeOk && verdict.ok, detail: `badge=${JSON.stringify(badge)}; ${verdict.detail}` };
}

async function walk(browser: Browser): Promise<void> {
  const run = Date.now().toString(36);
  const password = `walk-${run}-correct-horse`;
  const email1 = `walk-${run}@example.test`;
  const mobile = (): Promise<BrowserContext> => browser.newContext(MOBILE);
  const ctx = await mobile(); const page = await ctx.newPage(); const net = watchNetwork(page, "buy", log);
  const pageErrors: string[] = []; page.on("pageerror", (e) => pageErrors.push(e.message));

  // 1. a fresh window reaches the light door
  const WHAT_1 = "a fresh window reaches the light door: welcome on the paper, none of the old shell, the footer; Continue → intro; Create an account → the account form with Google; Already have an account? → the sign-in form";
  try {
    await page.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector('[data-testid="apply"][data-door="welcome"]', { timeout: 60_000 });
    await snap(page, "fresh-window");
    const oldShell = await page.locator('[data-testid="thread"], [data-testid="record"], [data-testid="action-bar"]').count();
    const footer = await page.locator('[data-testid="footer-disclosure"]').count();
    await page.locator('[data-testid="apply-continue"]').first().click();
    await page.waitForSelector('[data-testid="apply"][data-door="intro"]', { timeout: 30_000 });
    await snap(page, "intro");
    await page.getByRole("button", { name: "Create an account" }).first().click();
    await page.waitForSelector('[data-testid="apply"][data-door="account"] [data-testid="account"][data-mode="sign_up"]', { timeout: 30_000 });
    const accountForm = await page.locator('[data-testid="account-form"]').count(); const google = await page.locator('[data-testid="account-google"]').count();
    await snap(page, "account-form");
    // back through the mark: welcome → intro → "Already have an account?" → the sign-in form
    await page.locator(".sm-mark").first().click(); await page.waitForSelector('[data-testid="apply"][data-door="welcome"]', { timeout: 30_000 });
    await page.locator('[data-testid="apply-continue"]').first().click(); await page.waitForSelector('[data-testid="apply"][data-door="intro"]', { timeout: 30_000 });
    await page.getByRole("button", { name: "Already have an account?" }).first().click();
    await page.waitForSelector('[data-testid="account"][data-mode="sign_in"]', { timeout: 30_000 });
    const signIn = await page.locator('[data-testid="account"][data-mode="sign_in"] [data-testid="account-form"]').count();
    await snap(page, "sign-in-form");
    record(1, WHAT_1, oldShell === 0 && footer === 1 && accountForm === 1 && google === 1 && signIn === 1, `oldShell=${oldShell} footer=${footer} accountForm=${accountForm} google=${google} signIn=${signIn}`);
  } catch (e) { await snap(page, "door-failed"); record(1, WHAT_1, false, reason(e)); }

  // 2. creating an account lands on Apply
  const WHAT_2 = "creating an account lands on Apply at the goal step; GET /me lists the application; no error line";
  let applicationId1 = "";
  try {
    // the sign-in form is up: switch to sign-up and create through the form (the same door a person uses)
    if ((await page.locator('[data-testid="account"][data-mode="sign_in"]').count()) === 1) await page.locator('[data-testid="apply-account-switch"]').first().click();
    if ((await page.locator('[data-testid="account"][data-mode="sign_up"]').count()) !== 1) await signUpThroughDoor(page, BASE, email1, password, opts);
    else {
      await page.locator('[data-testid="account-form"] input[type="email"]').fill(email1); await page.locator('[data-testid="account-form"] input[type="password"]').fill(password);
      await page.locator('[data-testid="account-form"] button[type="submit"]').first().click();
      await waitForStep(page, "goal", "sign up", opts);
    }
    await snap(page, "after-sign-up");
    const err = await errorText(page); const tabId = await attr(page, "data-tab"); const step = await attr(page, "data-step");
    const me = await applicationOnMe(page); applicationId1 = me.application_id ?? "";
    record(2, WHAT_2, tabId === "apply" && step === "goal" && err === "" && me.status === 200 && !!applicationId1, `tab=${tabId} step=${step} error=${JSON.stringify(err)} me=${me.status} application=${applicationId1 || "(none)"}`);
  } catch (e) { await snap(page, "sign-up-failed"); record(2, WHAT_2, false, reason(e)); }

  // 3. buy with an address reaches the DU moment from the screens
  const WHAT_3 = "buy with an address reaches the DU moment from the screens: every Continue advances with no error, no preapproval card, the badge Verifying, the ops record's DU facts, no DU word on the screen";
  let assetsCardId = "";
  try {
    const driven = await driveToReview(page, { intent: "buy", purpose: null, property: { kind: "address", address: ADDRESS, state: "AZ", price: "800000", down: "240000" }, who: { name: WALK_NAME, dob: WALK_DOB, ssn: SSN, months: "72" }, income: "9500", employer: "Walk Industries" }, opts);
    await snap(page, "buy-review");
    const cards = await threadCards(page);
    const preapproval = cards.filter((c) => c.copy_key === "preapproval.where" || c.copy_key === "preapproval.intro").length;
    assetsCardId = cards.find((c) => c.copy_key === "assets.connect.purpose")?.card_instance_id ?? "";
    const confirmed = await confirmNumbers(page, opts); driven.steps.push({ step: confirmed.step, error: confirmed.error });
    const du = await duMomentFromScreens(page, applicationId1);
    await snap(page, "buy-result");
    const text = await screenText(page); const duWord = DU_WORDS.exec(text)?.[0] ?? null;
    const advanced = driven.steps.every((s) => !s.error);
    record(3, WHAT_3, advanced && preapproval === 0 && du.ok && duWord === null, `application=${applicationId1} steps: ${stepsLine(driven.steps)}; cta=${JSON.stringify(confirmed.cta)}; preapproval cards=${preapproval}; ${du.detail}; duWord=${JSON.stringify(duWord)}`);
  } catch (e) { await snap(page, "buy-failed"); record(3, WHAT_3, false, `${reason(e)} — on step ${await attr(page, "data-step")} error=${JSON.stringify(await errorText(page))}; network: ${net.summary()}`); }

  // 4. buy, still looking, ends at the preapproval request (a second account)
  const WHAT_4 = "buy, still looking, ends at the preapproval request: preapproval.where resolved, preapproval.target on Review, the badge Application received or Preapproved, apply.review.tbd, no six-item address on the ops record";
  const ctx2 = await mobile(); const page2 = await ctx2.newPage(); const net2 = watchNetwork(page2, "tbd", log);
  try {
    await signUpThroughDoor(page2, BASE, `walk-tbd-${run}@example.test`, password, opts);
    const me2 = await applicationOnMe(page2); const applicationId2 = me2.application_id ?? "";
    const g = await goal(page2, "buy", "My primary home", null, opts);
    const p = await property(page2, { kind: "shopping", state: "AZ", low: "400000", high: "500000", down: "100000", firstTime: "Yes" }, opts);
    await snap(page2, "tbd-you");
    const afterWhere = await threadCards(page2); const where = afterWhere.find((c) => c.copy_key === "preapproval.where");
    const whereResolved = where?.status === "resolved";   // the thread carries the card's status and resolved_at, never its evidence (32.13: the confirmed values stay off the wire); the values the tap wrote are 32.19-T4's assertion on the database
    const steps: StepRecord[] = [g, { step: p.step, error: p.error }];
    steps.push(await you(page2, { name: "Walk Shopper", dob: "1991-02-14", ssn: "555-12-3456", months: "40" }, opts));
    steps.push(await connect(page2, "6400", "Desert Sky Foods", opts)); steps.push(await details(page2, opts)); steps.push(await declarationsNone(page2, opts)); steps.push(await demographicsDecline(page2, opts));
    const tbdLine = await page2.locator('[data-testid="apply-review-tbd"]').first().innerText({ timeout: DU_STEP_TIMEOUT_MS }).catch(() => "");
    await page2.waitForSelector('[data-testid="apply-continue"][data-copy-key="apply.review.confirm"]', { timeout: DU_STEP_TIMEOUT_MS }).catch(() => undefined);
    const targetPending = (await threadCards(page2)).find((c) => c.copy_key === "preapproval.target")?.status ?? "(none)";
    const shownValue = (await page2.locator('[data-testid="apply-review-value"]').first().innerText().catch(() => "")).trim(); const shownAmount = (await page2.locator('[data-testid="apply-review-amount"]').first().innerText().catch(() => "")).trim();   // the numbers the tap writes: the price high and high − down
    await snap(page2, "tbd-review");
    const confirmed = await confirmNumbers(page2, opts); steps.push({ step: confirmed.step, error: confirmed.error });
    const target = (await threadCards(page2)).find((c) => c.copy_key === "preapproval.target");
    const targetOk = targetPending === "pending" && target?.status === "resolved" && shownValue === "$500,000" && shownAmount === "$400,000";
    const badge = await badgeText(page2); const badgeOk = /^(Application received|Preapproved)$/.test(badge);
    await snap(page2, "tbd-result");
    let opsOk = false; let opsDetail = NO_OPS_TOKEN;
    if (OPS_TOKEN) { const rec = await readOps(applicationId2); const six = (rec.events ?? []).filter((e) => e.type === "application.six_item.captured" && e.payload?.["item"] === "property_address").length; const trid = (rec.events ?? []).some((e) => e.type === "application.trid_received"); opsOk = six === 0 && !trid; opsDetail = `ops: six-item address events=${six}, trid_received=${trid}`; }
    record(4, WHAT_4, steps.every((s) => !s.error) && p.shoppingSwitch === 1 && whereResolved && targetOk && badgeOk && tbdLine.trim() === copy("apply.review.tbd") && opsOk,
      `application=${applicationId2} steps: ${stepsLine(steps)}; shoppingSwitch=${p.shoppingSwitch}; preapproval.where=${where?.status ?? "(none)"}; preapproval.target=${targetPending} on Review → ${target?.status ?? "(none)"} on the tap (Review showed ${JSON.stringify(shownValue)} / ${JSON.stringify(shownAmount)}); badge=${JSON.stringify(badge)}; tbd=${JSON.stringify(tbdLine.trim())}; ${opsDetail}`);
  } catch (e) { await snap(page2, "tbd-failed"); record(4, WHAT_4, false, `${reason(e)} — on step ${await attr(page2, "data-step")} error=${JSON.stringify(await errorText(page2))}; network: ${net2.summary()}`); }
  await ctx2.close();

  // 5. refinance, cash out (a third account) — and, on the way, outcome 6's two facts (recorded after 5, in the table's order)
  const WHAT_5 = "refinance, cash out: transaction_type cash_out on the ops record; no shopping switch; value, balance, cash out and what the cash is for collected (DELTA-37: application.field.captured{cash_out_purpose} on the ops record); refi.home.confirm resolved after the SSN with the estate and the lien; the same DU verdict";
  const WHAT_6 = "errors stay on the step, in copy: Details without citizenship keeps the step with a copy line; a 409 CARD_FIELD_REQUIRED from the API renders copy(copy_key) on the step, never the code";
  let six: { ok: boolean; detail: string } = { ok: false, detail: "not reached (outcome 5 stopped before Details)" };
  const ctx3 = await mobile(); const page3 = await ctx3.newPage(); const net3 = watchNetwork(page3, "refi", log);
  try {
    await signUpThroughDoor(page3, BASE, `walk-refi-${run}@example.test`, password, opts);
    const me3 = await applicationOnMe(page3); const applicationId3 = me3.application_id ?? "";
    const steps: StepRecord[] = [await goal(page3, "refi", "My primary home", "Take cash out", opts)];
    const p = await property(page3, { kind: "refi", address: ADDRESS, state: "AZ", worth: "800000", balance: "500000", cashOut: "60000", cashOutPurpose: "Pay off other debts" }, opts); steps.push({ step: p.step, error: p.error });
    await snap(page3, "refi-you");
    // ── 6b: a 409 CARD_FIELD_REQUIRED from the API, on the step. A reload on You empties the draft (the address, estate and lien held since Property), so You's Continue resolves the
    // identity and SSN cards and then taps refi.home.confirm bare → the API refuses 409 CARD_FIELD_REQUIRED → the step stays on You with copy(thread.card_field_required), never the code.
    await page3.reload({ waitUntil: "load", timeout: 60_000 }); await waitForStep(page3, "goal", "reload", opts);
    await tab(page3, "tasks", opts); await page3.locator('[data-testid="apply-task-you"]').first().click(); await waitForStep(page3, "you", "Tasks → You", opts);
    await fill(page3, "Legal name", WALK_NAME); await fill(page3, "Date of birth", WALK_DOB); await fill(page3, "Social Security number", SSN); await page3.getByRole("button", { name: /^Own$/ }).first().click(); await fill(page3, "Months at this address", "72");
    await page3.locator('[data-testid="apply-continue"]').first().click();
    await page3.locator('[data-testid="apply-error"]').first().waitFor({ timeout: DU_STEP_TIMEOUT_MS }).catch(() => undefined);
    const err409 = await errorText(page3); const step409 = await attr(page3, "data-step");
    await snap(page3, "refi-you-409");
    const cards409 = await threadCards(page3); const home409 = cards409.find((c) => c.copy_key === "refi.home.confirm");
    // the same bare body through the proxy: the API's own answer names the code and the copy key the page rendered
    let apiCode = ""; let apiKey = "";
    if (home409 && home409.status === "pending") { const bare = await apiOnPage(page3, "POST", `/v1/borrower/cards/${home409.card_instance_id}/resolve`, { evidence: { fields: ((home409.props["fields"] as { path: string; value?: string }[] | undefined) ?? []).map((f) => ({ path: f.path, value_confirmed: f.value ?? "", source: "borrower", confirmed_at: new Date().toISOString() })), edited: false } }); apiCode = String(bare.body["code"] ?? ""); apiKey = String(bare.body["copy_key"] ?? ""); }
    const sixB = step409 === "you" && apiCode === "CARD_FIELD_REQUIRED" && isCopyKey(apiKey) && err409 === copy(apiKey) && !/[A-Z]{3,}_[A-Z_]+/.test(err409) && home409?.status === "pending";
    // the recovery: Property again with the two answers, then You's Continue completes the home card
    await tab(page3, "tasks", opts); await page3.locator('[data-testid="apply-task-property"]').first().click(); await waitForStep(page3, "property", "Tasks → Property", opts);
    await fill(page3, "Property address", ADDRESS); await fill(page3, "State", "AZ"); await fill(page3, "About what is it worth?", "800000"); await fill(page3, "Current balance", "500000"); await fill(page3, "Cash out", "60000"); await pick(page3, "What the cash is for", "Pay off other debts");
    await pick(page3, "Do you own the land, or is it a leasehold?", "I own the land"); await pick(page3, "Is there a PACE or clean-energy loan on the home?", "No");
    steps.push(await continueTo(page3, "you", "property again", opts)); steps.push(await continueTo(page3, "connect", "you again", opts));
    const afterHome = await threadCards(page3); const home = afterHome.find((c) => c.copy_key === "refi.home.confirm"); const ssnCard = afterHome.find((c) => c.copy_key === "identity.ssn.title");
    // the thread carries statuses and resolved_at, never the evidence; the card requires the estate and the lien (a bare tap is refused — the 409 above), so a resolved home card carries the two answers (32.19-T5 asserts them on the database);
    // the resolve's write shows on the ops record as the six-item address (`application.six_item.captured{item: property_address}` — outcome 4 asserts its absence on the still-looking file)
    let sixItemHome = 0; let sixItemDetail = "(no token)";
    if (OPS_TOKEN && home?.status === "resolved") { const evs = (await readOps(applicationId3)).events ?? []; sixItemHome = evs.filter((e) => e.type === "application.six_item.captured" && e.payload?.["item"] === "property_address").length; sixItemDetail = `six-item address events=${sixItemHome}`; }
    const homeOk = home?.status === "resolved" && ssnCard?.status === "resolved" && !!home.resolved_at && !!ssnCard.resolved_at && home.resolved_at >= ssnCard.resolved_at && sixItemHome >= 1;
    steps.push(await connect(page3, "11000", "Walk Industries", opts));
    // ── 6a: Details without citizenship — the step stays with a copy line, nothing posted
    await waitForStep(page3, "details", "details", opts);
    await pick(page3, "Marital status", "Unmarried"); await fill(page3, "Dependents", "0"); await pick(page3, "Military service", "No"); await pick(page3, "Language preference", "English");
    await page3.locator('[data-testid="apply-continue"]').first().click();
    await page3.locator('[data-testid="apply-error"]').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
    const errDetails = await errorText(page3); const stepDetails = await attr(page3, "data-step");
    await snap(page3, "refi-details-refused");
    const sixA = stepDetails === "details" && errDetails !== "" && !/^[A-Z_]{6,}$/.test(errDetails) && errDetails === copy("apply.details.required");
    six = { ok: sixA && sixB, detail: `Details: step=${stepDetails} error=${JSON.stringify(errDetails)}; You after the reload: step=${step409} error=${JSON.stringify(err409)} api=${apiCode || "(no bare body posted)"}/${apiKey} home=${home409?.status ?? "(none)"}` };
    steps.push(await details(page3, opts)); steps.push(await declarationsNone(page3, opts)); steps.push(await demographicsDecline(page3, opts));
    await page3.waitForSelector('[data-testid="apply-continue"][data-copy-key="apply.review.confirm"]', { timeout: DU_STEP_TIMEOUT_MS }).catch(() => undefined);
    const valueShown = (await page3.locator('[data-testid="apply-review-value"]').first().innerText().catch(() => "")).trim(); const amountShown = (await page3.locator('[data-testid="apply-review-amount"]').first().innerText().catch(() => "")).trim();   // the value ← worth, the amount ← balance + cash out (docs/ux/18 §2.4)
    await snap(page3, "refi-review");
    const confirmed = await confirmNumbers(page3, opts); steps.push({ step: confirmed.step, error: confirmed.error });
    const du = await duMomentFromScreens(page3, applicationId3);
    await snap(page3, "refi-result");
    const final = await threadCards(page3); const value = final.find((c) => c.copy_key === "refi.value.confirm"); const amount = final.find((c) => c.copy_key === "refi.loan_amount.confirm"); const product = final.find((c) => c.copy_key === "refi.product.choice");
    const numbersOk = valueShown === "$800,000" && amountShown === "$560,000" && value?.status === "resolved" && amount?.status === "resolved" && product?.status === "resolved";
    // DELTA-37: the purpose rode the amount card's tap — 21.1's application.field.captured{field: cash_out_purpose, value} on the ops record's events (the MISMO id the DU document then carries at LOAN/REFINANCE/RefinancePrimaryPurposeType — required_missing 0 is duVerdict's own clause)
    let txn = "(no token)"; let purpose = "(no token)";
    if (OPS_TOKEN) { const ops3 = await readOps(applicationId3); txn = String(((ops3.application ?? {}) as Record<string, unknown>)["transaction_type"] ?? "(absent)"); purpose = String((ops3.events ?? []).find((e) => e.type === "application.field.captured" && e.payload?.["field"] === "cash_out_purpose")?.payload?.["value"] ?? "(absent)"); }
    const purposeOk = !OPS_TOKEN || purpose === "DebtConsolidation";
    record(5, WHAT_5, steps.every((s) => !s.error) && p.shoppingSwitch === 0 && homeOk && numbersOk && txn === "cash_out" && purposeOk && du.ok,
      `application=${applicationId3} steps: ${stepsLine(steps)}; shoppingSwitch=${p.shoppingSwitch}; refi.home.confirm=${home?.status ?? "(none)"} at ${home?.resolved_at ?? "-"} (the SSN card at ${ssnCard?.resolved_at ?? "-"}; the card's required estate and lien answered — a bare tap is refused; ${sixItemDetail}); Review showed value ${JSON.stringify(valueShown)}, amount ${JSON.stringify(amountShown)}; cards: value=${value?.status ?? "(none)"} amount=${amount?.status ?? "(none)"} product=${product?.status ?? "(none)"}; transaction_type=${txn}; cash_out_purpose=${purpose}; ${du.detail}`);
  } catch (e) { await snap(page3, "refi-failed"); record(5, WHAT_5, false, `${reason(e)} — on step ${await attr(page3, "data-step")} error=${JSON.stringify(await errorText(page3))}; network: ${net3.summary()}`); }
  await ctx3.close();
  record(6, WHAT_6, six.ok, six.detail);

  // 7. My Loan is empty for a fresh account; Tasks marks and jumps (the first account, at the DU moment)
  const WHAT_7 = "My Loan is empty for a fresh account (no dollar sign, no digit); Tasks marks the done rows and tapping Your home jumps to Property";
  try {
    await tab(page, "loan", opts);
    const empty = (await page.locator('[data-testid="apply-loan-empty"]').first().innerText({ timeout: 30_000 }).catch(() => "")).trim();
    await snap(page, "my-loan-empty");
    await tab(page, "tasks", opts);
    await page.waitForSelector('[data-testid="apply-task-property"]', { timeout: 30_000 });
    const rows = await page.locator('[data-testid^="apply-task-"]').evaluateAll((els: Element[]) => els.map((e) => `${e.getAttribute("data-testid")?.replace("apply-task-", "")}=${e.getAttribute("data-done")}`));
    const doneRows = rows.filter((r) => r.endsWith("=true")).length;
    await snap(page, "tasks");
    await page.locator('[data-testid="apply-task-property"]').first().click(); await waitForStep(page, "property", "Tasks → Your home", opts);
    record(7, WHAT_7, empty.includes(copy("apply.loan.empty")) && !/[$\d]/.test(empty) && doneRows === 7 && (await attr(page, "data-step")) === "property", `loan=${JSON.stringify(empty)} rows=[${rows.join(", ")}]`);   // the panel is the heading (apply.loan.title) and the line
  } catch (e) { await snap(page, "my-loan-failed"); record(7, WHAT_7, false, reason(e)); }

  // 10 (computed now, while the first account is signed in; recorded after 9): the vendor return on the assets card from 3, an unknown card, a deep-link token without a session
  const WHAT_10 = "returns and ?card= land on the card: /app/return/{vendor}/{card} → /app?card= on the Connect step with the card's row; an unknown card → Apply with no card and no error naming one; /app/d/{token} without a session → Account with the token retained";
  let ten: { ok: boolean; detail: string } = { ok: false, detail: "not reached" };
  try {
    let returnOk = false; let returnDetail = "no assets card id from outcome 3";
    if (assetsCardId) {
      await page.goto(`${BASE}/app/return/plaid_assets/${encodeURIComponent(assetsCardId)}`, { waitUntil: "load", timeout: 60_000 });
      await page.waitForURL((u) => u.pathname === "/app" && u.searchParams.get("card") === assetsCardId, { timeout: 60_000 }).catch(() => undefined);
      await page.waitForSelector(`[data-testid="apply"][data-card="${assetsCardId}"]`, { timeout: 60_000 }).catch(() => undefined);   // the focus applied once the cards loaded
      await waitForStep(page, "connect", "the return", opts).catch(() => undefined);
      const row = page.locator(`[data-testid="apply-card-${assetsCardId}"]`).first();
      const rowCount = await row.count(); const expanded = rowCount ? await row.getAttribute("data-expanded") : null;
      await snap(page, "return-card");
      returnOk = new URL(page.url()).searchParams.get("card") === assetsCardId && (await attr(page, "data-tab")) === "apply" && (await attr(page, "data-step")) === "connect" && rowCount === 1 && expanded === "true";
      returnDetail = `url=${page.url()} tab=${await attr(page, "data-tab")} step=${await attr(page, "data-step")} row=${rowCount} expanded=${expanded}`;
    }
    const unknown = randomUUID();
    await page.goto(`${BASE}/app?card=${unknown}`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector('[data-testid="apply"][data-tab]', { timeout: 60_000 });
    await page.waitForTimeout(2500);   // the cards load; an id that is not the party's is ignored (no data-card on the root)
    const unknownCards = await page.locator('[data-testid^="apply-card-"]').count(); const unknownErr = await errorText(page); const unknownFocus = await attr(page, "data-card");
    await snap(page, "unknown-card");
    const unknownOk = (await attr(page, "data-tab")) === "apply" && unknownCards === 0 && unknownFocus === null && !unknownErr.includes(unknown) && !/card/i.test(unknownErr);
    const anon = await mobile(); const ap = await anon.newPage(); const token = `walk-${run}-${randomUUID().slice(0, 8)}`;
    await ap.goto(`${BASE}/app/d/${token}`, { waitUntil: "load", timeout: 60_000 });
    await ap.waitForSelector('[data-testid="deep-link"] [data-testid="account"]', { timeout: 60_000 }).catch(() => undefined);
    const retained = await ap.locator('[data-testid="deep-link"]').first().getAttribute("data-deep-link-token").catch(() => null);
    const accountInLink = await ap.locator('[data-testid="deep-link"] [data-testid="account"][data-mode="sign_in"]').count();
    const loanOnLink = await ap.locator("article[data-card-kind], [data-testid=\"apply\"]").count();
    await snap(ap, "deep-link-no-session");
    await anon.close();
    ten = { ok: returnOk && unknownOk && retained === token && accountInLink === 1 && loanOnLink === 0, detail: `return: ${returnDetail}; unknown card: cards=${unknownCards} focused=${unknownFocus} error=${JSON.stringify(unknownErr)}; deep link: token retained=${retained === token} account=${accountInLink} loanData=${loanOnLink}` };
  } catch (e) { ten = { ok: false, detail: reason(e) }; }

  // 8. sign out, and isolation
  const WHAT_8 = "sign out works: the next load is the door; a second fresh context sees nothing of the first person";
  try {
    await page.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector('[data-testid="apply"][data-tab]', { timeout: 60_000 });
    await tab(page, "account", opts);
    const signOut = page.locator('[data-testid="apply-sign-out"]');
    const hadSignOut = (await signOut.count()) === 1;
    if (hadSignOut) { await signOut.first().click(); await page.waitForSelector('[data-testid="apply"][data-door="welcome"]', { timeout: 30_000 }).catch(() => undefined); }
    await page.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector('[data-testid="apply"][data-door], [data-testid="apply"][data-tab]', { timeout: 60_000 });
    await snap(page, "after-sign-out");
    const doorAgain = (await attr(page, "data-door")) === "welcome" && (await page.locator('[data-testid="apply-tab-apply"]').count()) === 0;
    const other = await mobile(); const op = await other.newPage();
    await op.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
    await op.waitForSelector('[data-testid="apply"][data-door], [data-testid="apply"][data-tab]', { timeout: 60_000 });
    await snap(op, "second-context");
    const door2 = (await attr(op, "data-door")) === "welcome";
    const body2 = await op.locator("body").innerText().catch(() => "");
    await other.close();
    const firstName = WALK_NAME.split(" ")[0] ?? WALK_NAME;   // Account shows the first name alone (apply-account-name), so the leak to look for is the first name, not only the full name
    record(8, WHAT_8, hadSignOut && doorAgain && door2 && !body2.includes(email1) && !body2.includes(firstName), `signOut=${hadSignOut} doorAgain=${doorAgain} secondContextDoor=${door2} firstName=${JSON.stringify(firstName)} leaked=${body2.includes(email1) || body2.includes(firstName)}`);
  } catch (e) { await snap(page, "sign-out-failed"); record(8, WHAT_8, false, reason(e)); }

  // 9. a partner-book homeowner (33.1 rules 5–6): the code door on the fixture e-mail lands on My Loan — Monitored, the servicer and the last four from the deployed record; Apply shows no step; sign out. An unseeded book fails, never passes.
  const WHAT_9 = "a partner-book homeowner signs in by code and lands on My Loan: Monitored, the servicer and the last four from the deployed partner_book; Apply shows no step and no goal card; sign out → the door";
  const ctx4 = await mobile(); const page4 = await ctx4.newPage(); const net4 = watchNetwork(page4, "book", log);
  try {
    const door = await codeDoor(page4, PARTNER_BOOK.email);
    await snap(page4, "partner-book-code-door");
    if (door.error) record(9, WHAT_9, false, `${door.error} (door: ${door.how})`);
    else {
      // the session must be on the provisioned party: a loan subject. A code on an e-mail the book never provisioned opens a fresh lead-stage party with no subject (32.14) — that is the unseeded demo, and it fails here
      const me = await apiOnPage(page4, "GET", "/v1/borrower/me");
      const subjects = Array.isArray(me.body["subjects"]) ? (me.body["subjects"] as Record<string, unknown>[]) : [];
      const loanSubject = subjects.find((s) => typeof s["loan_id"] === "string" && s["loan_id"]);
      if (me.status !== 200 || !loanSubject) record(9, WHAT_9, false, `${NOT_SEEDED} (GET /me ${me.status}: ${subjects.length} subject(s), none a loan; door: ${door.how})`);
      else {
        // 33.1 rule 7: the demo book loads under the configured partner (BORROWER_DEFAULT_PARTNER_ID's party — "Partner Bank (FAKE demo)" on nonprod) and only under DEMO_PARTNER when none is
        // configured — so the partner My Loan must name and the loan's last four are read from the deployed record's partner_book, never assumed from the fixture; the fixture values stand in only when the record has none
        const rec = await apiOnPage(page4, "GET", `/v1/borrower/record?subject=${encodeURIComponent(String(loanSubject["loan_id"]))}`);
        const pb = rec.status === 200 && rec.body["partner_book"] && typeof rec.body["partner_book"] === "object" ? (rec.body["partner_book"] as Record<string, unknown>) : {};
        const expectedPartner = typeof pb["partner_name"] === "string" && pb["partner_name"] ? (pb["partner_name"] as string) : PARTNER_BOOK.partner;
        const expectedLast4 = typeof pb["loan_last4"] === "string" && pb["loan_last4"] ? (pb["loan_last4"] as string) : PARTNER_BOOK.loanLast4;
        await page4.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
        await page4.waitForSelector('[data-testid="apply"][data-tab]', { timeout: 60_000 });
        const landedTab = await attr(page4, "data-tab");
        const badge = await waitForBadge(page4, /\bMonitored\b/, 30_000);
        const servicer = (await page4.locator('[data-testid="apply-loan-servicer"]').first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const last4 = (await page4.locator('[data-testid="apply-loan-last4"]').first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const recordText = (await page4.locator('[data-testid="apply-loan-record"]').first().innerText().catch(() => "")).replace(/\s+/g, " ");
        await snap(page4, "partner-book-my-loan");
        await tab(page4, "apply", opts);
        await page4.waitForTimeout(1000);
        const step = await attr(page4, "data-step"); const goalCards = await page4.locator('.sm-card-host[data-copy-key="entry.goal.question"]').count(); const cta = await page4.locator('[data-testid="apply-continue"]').count();
        await snap(page4, "partner-book-apply");
        await tab(page4, "account", opts);
        const name = (await page4.locator('[data-testid="apply-account-name"]').first().innerText().catch(() => "")).trim();
        const signOut4 = page4.locator('[data-testid="apply-sign-out"]'); const hadSignOut4 = (await signOut4.count()) === 1;
        if (hadSignOut4) { await signOut4.first().click(); await page4.waitForSelector('[data-testid="apply"][data-door="welcome"]', { timeout: 30_000 }).catch(() => undefined); }
        await page4.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60_000 });
        await page4.waitForSelector('[data-testid="apply"][data-door], [data-testid="apply"][data-tab]', { timeout: 60_000 });
        await snap(page4, "partner-book-after-sign-out");
        const doorAfter = (await attr(page4, "data-door")) === "welcome";
        const monitoredOk = /\bMonitored\b/.test(badge) && servicer.includes(expectedPartner) && last4.endsWith(expectedLast4) && recordText.includes(expectedPartner);
        const noStepOk = step === null && goalCards === 0 && cta === 0;
        record(9, WHAT_9, landedTab === "loan" && monitoredOk && noStepOk && hadSignOut4 && doorAfter,
          `door=${door.how} partner=${JSON.stringify(expectedPartner)} last4=${expectedLast4} landed=${landedTab} badge=${JSON.stringify(badge)} servicer=${JSON.stringify(servicer)} last4Line=${JSON.stringify(last4)} step=${step} goalCards=${goalCards} cta=${cta} name=${JSON.stringify(name)} (fixture ${PARTNER_BOOK.firstName}) signOut=${hadSignOut4} doorAfter=${doorAfter}`);
      }
    }
  } catch (e) { await snap(page4, "partner-book-failed"); record(9, WHAT_9, false, `${reason(e)}; network: ${net4.summary()}`); }
  await ctx4.close();

  record(10, WHAT_10, ten.ok, ten.detail);

  if (pageErrors.length) console.log(`page errors: ${JSON.stringify(pageErrors.slice(0, 5))}`);
  await ctx.close();
}

const browser = await chromium.launch();
try { await walk(browser); }
catch (e) { record(0, "the walk itself ran to the end", false, e instanceof ScreenError || e instanceof JourneyError ? e.message : reason(e)); }
finally { await browser.close(); }
const failed = checks.filter((c) => !c.ok);
const report = { base: BASE, at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks };
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n--- report.json\n${JSON.stringify(report)}`);
console.log(`\n${checks.length - failed.length} of ${checks.length} outcomes hold on ${BASE}`);
process.exit(failed.length ? 1 : 0);
