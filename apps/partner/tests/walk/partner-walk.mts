/**
 * The partner portal's deploy walk (36; docs/partner-portal/00-CLAUDE-BUILD-INSTRUCTIONS.md §8 Session 6): a real browser on the
 * deployed demo's /partners — after every deploy, beside the borrower walk (apps/borrower/tests/walk/demo-walk.mts, whose shape
 * this file copies: outcomes recorded by name, a screenshot per step in WALK_OUT, the verdicts in report.json, exit 1 under the
 * count; nothing passes by default).
 *
 *   DEMO_BASE=https://demo.supermortgage.com node --experimental-strip-types tests/walk/partner-walk.mts
 *
 * The deployed walk repeats what src/domain/servicing-partner-portal/36-app.walk.test.ts can repeat without its harness — the
 * door, the sign-in, Home, Eligibility, the loan page's banner, the Serviced tab, sign-out. It does not re-upload the fixture
 * tape (the fixture module builds the tape from src/domain/partner-book/fixtures, which apps/partner does not ship) and it
 * invites no partner_ops user (a second person left on the deployed tenant after every walk; the local walk covers both).
 *
 * The seven outcomes:
 *   1. A fresh window at /partners reaches the door: no session → /partners/sign-in keeping the return path; the partner the image
 *      was built with is named on the door (WALK_DOOR_PARTNER_LEGAL_NAME / _NMLSR_ID, the build args); no loan on it; no cookie.
 *   2. The seeded partner_admin signs in through the door: the code the FAKE port echoes (`fake_code`, outside production only),
 *      then the password — set at enrolment on the first walk, kept from then on (WALK_PARTNER_PASSWORD, one deterministic default);
 *      Home opens under the partner's legal name with the Admin item; the session rides in the HttpOnly cookie sm_partner_session.
 *      The unseeded demo fails here by name — "the seeded partner_admin is absent: dispatch seed_demo": the API echoes a code for
 *      an address it does not know too (no enumeration) and refuses its verification (401 OTP_INVALID), so the refusal of the
 *      echoed code is that verdict; a code step with nothing echoed (no FAKE port) is named as such. Never a pass.
 *   3. Home shows the monitored count (12 after the seed) and the three bucket counts, equal to GET /v1/partner/home's through the
 *      page's own proxy; the tape as-of and the in-flight count are there.
 *   4. Eligibility's three buckets sum to monitored − on hold; three tabs and the state filter only; each tab lists its count.
 *   5. A monitored loan's page shows the banner "Monitored — <the partner's legal name> remains servicer" (36.5 rule 5; the name
 *      from GET /v1/partner/me, never assumed); no Pay, Escrow, Draft or other servicing control on the page.
 *   6. The Serviced tab is visible, disabled, with the 36.6 copy — no chart, no zero.
 *   7. Sign out returns to the door: the cookie is gone, the next load of /partners is the door again, and a second fresh context
 *      sees the door and nothing of the book.
 *
 * Environment (the WALK_* contract): DEMO_BASE (the demo), WALK_OUT (screenshots + report.json), WALK_PARTNER_ADMIN_EMAIL (the
 * seeded partner_admin — src/runtime/partner-portal/seed.ts DEMO_PARTNER_ADMIN_EMAIL, copied here: this file runs from apps/partner
 * against a deployed demo), WALK_PARTNER_PASSWORD (the password the walk sets at enrolment and signs in with afterwards; unset → a
 * deterministic default, so a later walk still opens the account an earlier one enrolled), WALK_DOOR_PARTNER_LEGAL_NAME /
 * WALK_DOOR_PARTNER_NMLSR_ID (what the door must show — the image's build args; unset → the door's line is only required to name
 * a partner).
 */
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env["DEMO_BASE"] ?? "https://demo.supermortgage.com").replace(/\/$/, "");
const OUT = process.env["WALK_OUT"] ?? "walk-out";
const ADMIN_EMAIL = (process.env["WALK_PARTNER_ADMIN_EMAIL"] ?? "partner.admin@northlight.example").trim();
// ≥ 12 characters, not a breached-list word (src/runtime/staff/auth.ts passwordProblem); the same value on every walk so the account an earlier walk enrolled still opens
const PASSWORD = (process.env["WALK_PARTNER_PASSWORD"] ?? "walk-northlight-partner-admin-2026").trim();
const DOOR_PARTNER = { legalName: (process.env["WALK_DOOR_PARTNER_LEGAL_NAME"] ?? "").trim(), nmlsrId: (process.env["WALK_DOOR_PARTNER_NMLSR_ID"] ?? "").trim() };
const NOT_SEEDED = "the seeded partner_admin is absent: dispatch seed_demo (Actions → deploy → Run workflow → seed_demo; the seed-demo job invites the demo partner's first partner_admin)";
const SESSION_COOKIE = "sm_partner_session";
const DOOR = "/partners/sign-in";
/** 36.6 rule 4's copy (src/domain/servicing-partner-portal/serviced.ts SERVICED_TAB_COPY) — copied, not imported: this file runs from apps/partner against a deployed demo. */
const SERVICED_TAB_COPY = "Serviced pane not built (V1). When Supermortgage subservices the refinanced loan, its payment, escrow, insurance, delinquency, remittance, custodial, notice, QC and payoff detail will appear here.";
const bannerMonitored = (partnerLegalName: string): string => `Monitored — ${partnerLegalName} remains servicer`;
const BANNER_IN_REFINANCE = "In refinance — origination in progress";
const SERVICING_CONTROL = /pay|escrow|draft|statement|ach|payoff|resolve|exclude|message|re-offer/i;
mkdirSync(OUT, { recursive: true });

type Check = { n: number; what: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (n: number, what: string, ok: boolean, detail = ""): void => { checks.push({ n, what, ok, detail }); console.log(`${ok ? "ok " : "NOT"} ${n}. ${what}${detail ? ` — ${detail}` : ""}`); };
const log = (line: string): void => console.log(`  ${line}`);
const reason = (e: unknown): string => (e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e));

/** The text of an element that may be absent: "" at once when it is not on the page (never Playwright's 30 s action wait). */
const textOf = async (page: Page, selector: string): Promise<string> => { const el = page.locator(selector).first(); if ((await el.count()) === 0) return ""; return ((await el.innerText({ timeout: 5_000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim(); };
const text = (page: Page, testId: string): Promise<string> => textOf(page, `[data-testid="${testId}"]`);
const doorStep = async (page: Page): Promise<string | null> => { const d = page.locator('[data-testid="door"]').first(); return (await d.count()) ? d.getAttribute("data-step") : null; };
let shot = 0;
const snap = async (page: Page, name: string): Promise<void> => {
  shot += 1; await page.screenshot({ path: join(OUT, `${String(shot).padStart(2, "0")}-${name}.png`), fullPage: false }).catch(() => undefined);
  // what the page says, in the log (the artifact host is not always reachable from where the report is read)
  const body = (await textOf(page, "body")).slice(0, 400);
  console.log(`--- ${name} @ ${page.url()}\n  door-step=${await doorStep(page)} error=${JSON.stringify(await text(page, "door-error"))}\n  screen: ${JSON.stringify(body)}`);
};

/**
 * The page's proxy traffic (/partners/api/*), watched as the borrower walk watches its own: every answer of 400 or more, every
 * failed request and every request slower than `slowMs` is logged as it happens and kept; `pending()` names what is still in
 * flight, so a step that never advances says which request did not come back.
 */
type NetworkWatch = { readonly lines: string[]; pending(): string[]; summary(): string };
function watchNetwork(page: Page, label: string, slowMs = 5_000): NetworkWatch {
  const started = new Map<Request, number>(); const lines: string[] = [];
  const keep = (s: string): void => { lines.push(s); log(`net ${label}: ${s}`); };
  const pathOf = (u: string): string => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
  const isApi = (u: string): boolean => /\/partners\/api\//.test(u);
  page.on("request", (r) => { if (isApi(r.url())) started.set(r, Date.now()); });
  page.on("response", (res) => {
    const r = res.request(); const t0 = started.get(r); if (t0 === undefined) return; started.delete(r);
    const ms = Date.now() - t0; const status = res.status();
    if (status < 400 && ms < slowMs) return;
    void (status >= 400 ? res.text().catch(() => "") : Promise.resolve("")).then((body) => keep(`${new Date().toISOString()} ${r.method()} ${pathOf(r.url())} → ${status} in ${ms} ms${body ? ` ${JSON.stringify(body.slice(0, 200))}` : ""}`));
  });
  page.on("requestfailed", (r) => { const t0 = started.get(r); if (t0 === undefined) return; started.delete(r); keep(`${new Date().toISOString()} ${r.method()} ${pathOf(r.url())} → FAILED (${r.failure()?.errorText ?? "?"}) after ${Date.now() - t0} ms`); });
  const pending = (): string[] => [...started.entries()].map(([r, t0]) => `${r.method()} ${pathOf(r.url())} in flight ${Date.now() - t0} ms`);
  return { lines, pending, summary: () => { const all = [...lines.slice(-8), ...pending()]; return all.length ? all.join(" | ") : "(no failed, slow or in-flight API request)"; } };
}

type ApiAnswer = { status: number; body: Record<string, unknown> };
/** A partner API call made by the page itself through the same-origin proxy (/partners/api → /v1/partner/*), with the page's HttpOnly cookie riding as the bearer exactly as the app's own client is served. */
const apiOnPage = (page: Page, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<ApiAnswer> =>
  page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(`/partners/api${path}`, { method, credentials: "include", headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let json: Record<string, unknown> = {};
    try { json = (await res.json()) as Record<string, unknown>; } catch { /* a non-JSON body */ }
    return { status: res.status, body: json };
  }, { method, path, body });
const sessionCookie = async (ctx: BrowserContext): Promise<{ value: string; path: string; httpOnly: boolean; secure: boolean; sameSite: string } | undefined> => (await ctx.cookies()).find((c) => c.name === SESSION_COOKIE);
const isDoor = (page: Page): boolean => new URL(page.url()).pathname === DOOR;
const count = (page: Page, selector: string): Promise<number> => page.locator(selector).count();
/** Home's three bucket counts and the monitored count as the tiles show them. */
type HomeTiles = { monitored: number; eligibleNow: number; likelySoon: number; notNear: number; inFlight: number };
const asCount = (s: string): number => (/^\d+$/.test(s) ? Number(s) : Number.NaN);

/** The first step of the door's answer to "Send code": the echoed code, the door's error line, or the code step with nothing echoed (the unknown-address answer — no enumeration). */
async function sendCode(page: Page, email: string): Promise<{ code: string } | { error: string }> {
  await page.getByTestId("door-email").fill(email);
  await page.getByTestId("door-send-code").click();
  await page.locator('[data-testid="door"][data-step="code"], [data-testid="door-error"]').first().waitFor({ timeout: 30_000 });
  const error = await text(page, "door-error");
  if (error) return { error: `the door refused the code request: ${error}` };
  const echoed = ((await text(page, "door-fake-code")).match(/(\d{6})/) ?? [])[1];
  if (!echoed) return { error: `the door answered the code step for ${email} with no echoed FAKE code: the demo must run the FAKE e-delivery port outside production (the code is echoed for any address there)` };
  return { code: echoed };
}

async function walk(browser: Browser): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage(); const net = watchNetwork(page, "admin");
  const pageErrors: string[] = []; page.on("pageerror", (e) => pageErrors.push(e.message));
  let legalName = "";   // the partner's legal name as the shell reads it from GET /v1/partner/me (outcome 2), the banner's name (outcome 5)
  let tiles: HomeTiles | null = null;

  // 1. a fresh window reaches the door
  const WHAT_1 = "a fresh window at /partners reaches the door: no session → /partners/sign-in keeping the return path; the partner named on the door; no loan on it; no session cookie";
  try {
    await page.goto(`${BASE}/partners`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForURL((u) => u.pathname === DOOR, { timeout: 60_000 });
    await page.waitForSelector('[data-testid="door"]', { timeout: 30_000 });
    await snap(page, "door");
    const returnTo = new URL(page.url()).searchParams.get("return");
    const partnerLine = await text(page, "door-partner");
    const expectedLine = DOOR_PARTNER.legalName ? `${DOOR_PARTNER.legalName}${DOOR_PARTNER.nmlsrId ? ` · NMLSR ID ${DOOR_PARTNER.nmlsrId}` : ""}` : null;
    const named = expectedLine ? partnerLine === expectedLine : partnerLine !== "" && partnerLine !== "Servicing partner portal";
    const loans = await count(page, '[data-testid="loan-link"]'); const shell = await count(page, '[data-testid="partner-shell"]');
    const cookie = await sessionCookie(ctx);
    record(1, WHAT_1, returnTo === "/partners" && named && loans === 0 && shell === 0 && !cookie, `return=${JSON.stringify(returnTo)} door=${JSON.stringify(partnerLine)}${expectedLine ? ` expected=${JSON.stringify(expectedLine)}` : " (WALK_DOOR_PARTNER_LEGAL_NAME unset: any partner name accepted)"} loans=${loans} shell=${shell} cookie=${cookie ? "present" : "none"}`);
  } catch (e) { await snap(page, "door-failed"); record(1, WHAT_1, false, `${reason(e)}; network: ${net.summary()}`); }

  // 2. the seeded partner_admin signs in through the door
  const WHAT_2 = "the seeded partner_admin signs in through the door: the echoed code, then the password (set at enrolment, kept afterwards); Home opens under the partner's legal name with the Admin item; the session rides in the HttpOnly cookie";
  try {
    if (!isDoor(page)) { await page.goto(`${BASE}${DOOR}`, { waitUntil: "load", timeout: 60_000 }); await page.waitForSelector('[data-testid="door"]', { timeout: 30_000 }); }
    const sent = await sendCode(page, ADMIN_EMAIL);
    await snap(page, "code-step");
    if ("error" in sent) record(2, WHAT_2, false, sent.error);
    else {
      await page.getByTestId("door-code").fill(sent.code); await page.getByTestId("door-verify").click();
      await page.locator('[data-testid="door-new-password"], [data-testid="door-password"], [data-testid="door-error"]').first().waitFor({ timeout: 30_000 });
      const verifyError = await text(page, "door-error");
      // the API echoes a code for an address it does not know as well (no enumeration) and refuses its verification: a refused echoed code is the unseeded demo (or a locked account)
      if (verifyError) throw new Error(`${NOT_SEEDED} — the door refused the echoed code for ${ADMIN_EMAIL}: ${JSON.stringify(verifyError)} (the API echoes a code for an unknown address too and answers OTP_INVALID on its verification; a locked account answers the same)`);
      const enrolling = (await count(page, '[data-testid="door-new-password"]')) === 1;
      if (enrolling) { log(`enrolment: the seeded partner_admin sets the walk's password (first walk against this seed)`); await page.getByTestId("door-new-password").fill(PASSWORD); await page.getByTestId("door-set-password").click(); }
      else { log(`already enrolled: signing in with WALK_PARTNER_PASSWORD${process.env["WALK_PARTNER_PASSWORD"] ? "" : "'s default"}`); await page.getByTestId("door-password").fill(PASSWORD); await page.getByTestId("door-sign-in").click(); }
      // whichever comes first: the landing on /partners, or the door's error line (each wait caught on its own — the loser must not reject unhandled later)
      await Promise.race([page.waitForURL((u) => u.pathname === "/partners", { timeout: 60_000 }).catch(() => undefined), page.locator('[data-testid="door-error"]').first().waitFor({ timeout: 60_000 }).catch(() => undefined)]);
      if (isDoor(page)) {
        const err = await text(page, "door-error");
        throw new Error(err ? `the door refused ${enrolling ? "the password at enrolment" : "the sign-in"}: ${err}${!enrolling && /not valid/i.test(err) ? " (the admin is enrolled with a password other than WALK_PARTNER_PASSWORD — an earlier walk or a person set it; a partner_admin resets it on the door with the current password, or re-seed a fresh database)" : ""}` : `still on the door after ${enrolling ? "the password step" : "sign-in"} with no error line; step=${await doorStep(page)}`);
      }
      await page.waitForSelector('[data-testid="home"]', { timeout: 60_000 });
      await snap(page, "home");
      legalName = await text(page, "partner-legal-name");
      const who = await text(page, "who");
      const nav = (await page.getByTestId("nav").locator("a").allInnerTexts()).map((s) => s.trim());
      const cookie = await sessionCookie(ctx);
      const cookieOk = !!cookie?.value && cookie.path === "/partners" && cookie.httpOnly && cookie.sameSite === "Lax" && (cookie.secure || !BASE.startsWith("https"));   // Secure on the deployed demo; a local http run's cookie may be Secure too (the proxy sets it under NODE_ENV=production)
      const me = await apiOnPage(page, "GET", "/v1/partner/me");
      const meName = me.status === 200 && me.body["partner"] && typeof me.body["partner"] === "object" ? String((me.body["partner"] as Record<string, unknown>)["legal_name"] ?? "") : "";
      record(2, WHAT_2, legalName !== "" && legalName === meName && /Admin/.test(who) && nav.join(",") === "Home,Book,Eligibility,Pipeline,Reports,Admin" && cookieOk,
        `${enrolling ? "enrolled" : "signed in"} as ${ADMIN_EMAIL}; partner=${JSON.stringify(legalName)} me=${me.status} ${JSON.stringify(meName)} who=${JSON.stringify(who)} nav=[${nav.join(", ")}] cookie=${cookie ? `path=${cookie.path} httpOnly=${cookie.httpOnly} secure=${cookie.secure} sameSite=${cookie.sameSite}` : "none"}`);
    }
  } catch (e) { await snap(page, "sign-in-failed"); record(2, WHAT_2, false, `${reason(e)}; network: ${net.summary()}`); }

  // 3. Home's counts
  const WHAT_3 = "Home shows the monitored count (12 after the seed) and the three bucket counts, the API's own (GET /v1/partner/home through the page's proxy); the tape as-of and the in-flight count are there";
  try {
    if (new URL(page.url()).pathname !== "/partners") await page.goto(`${BASE}/partners`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector('[data-testid="home"]', { timeout: 60_000 });
    const empty = await page.getByTestId("home").getAttribute("data-empty");
    if (empty === "true") { await snap(page, "home-empty"); record(3, WHAT_3, false, `the book is empty (${JSON.stringify(await text(page, "home-empty"))}): dispatch seed_demo`); }
    else {
      const [monitored, eligibleNow, likelySoon, notNear, inFlight, lastAsOf] = await Promise.all(["home-monitored", "home-eligible-now", "home-likely-soon", "home-not-near", "home-in-flight", "home-last-as-of"].map((id) => text(page, id)));
      tiles = { monitored: asCount(monitored ?? ""), eligibleNow: asCount(eligibleNow ?? ""), likelySoon: asCount(likelySoon ?? ""), notNear: asCount(notNear ?? ""), inFlight: asCount(inFlight ?? "") };
      const home = await apiOnPage(page, "GET", "/v1/partner/home");
      const book = (home.body["book"] ?? {}) as Record<string, unknown>; const el = (home.body["eligibility"] ?? {}) as Record<string, unknown>; const pl = (home.body["pipeline"] ?? {}) as Record<string, unknown>;
      const apiTiles = [book["loans_monitored"], el["eligible_now"], el["likely_soon"], el["not_near"], pl["in_flight"]].map((v) => Number(v));
      const shown = [tiles.monitored, tiles.eligibleNow, tiles.likelySoon, tiles.notNear, tiles.inFlight];
      const same = home.status === 200 && shown.every((v, i) => Number.isInteger(v) && v === apiTiles[i]);
      await snap(page, "home-counts");
      record(3, WHAT_3, tiles.monitored > 0 && same && (lastAsOf ?? "") !== "" && lastAsOf !== "—",
        `monitored=${monitored} (12 after the seed) eligible_now=${eligibleNow} likely_soon=${likelySoon} not_near=${notNear} in_flight=${inFlight} last_as_of=${JSON.stringify(lastAsOf)}; GET /v1/partner/home ${home.status} → [${apiTiles.join(", ")}]`);
    }
  } catch (e) { await snap(page, "home-failed"); record(3, WHAT_3, false, `${reason(e)}; network: ${net.summary()}`); }

  // 4. Eligibility's sum
  const WHAT_4 = "Eligibility's three buckets sum to monitored − on hold; three tabs and the state filter only; each tab lists its count";
  try {
    await page.goto(`${BASE}/partners/eligibility`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector('[data-testid="eligibility"]', { timeout: 60_000 });
    const [a, b, c, held] = (await Promise.all(["count-eligible-now", "count-likely-soon", "count-not-near", "count-on-hold"].map((id) => text(page, id)))).map((s) => asCount(s));
    const monitored = tiles?.monitored ?? Number((((await apiOnPage(page, "GET", "/v1/partner/home")).body["book"] ?? {}) as Record<string, unknown>)["loans_monitored"]);
    const tabs = await count(page, '[data-testid="eligibility-tabs"] [role="tab"]'); const selects = await count(page, "select");
    const rows: string[] = []; let listed = true;
    for (const [bucket, n] of [["eligible_now", a], ["likely_soon", b], ["not_near", c]] as const) {
      await page.getByTestId(`tab-${bucket}`).click();
      const r = await count(page, `[data-testid="bucket-table-${bucket}"] [data-testid="bucket-row"]`);
      rows.push(`${bucket}=${r}/${n}`); if (r !== n) listed = false;
    }
    await page.getByTestId("tab-eligible_now").click();
    await snap(page, "eligibility");
    const sumOk = [a, b, c, held, monitored].every((v) => Number.isInteger(v)) && (a ?? 0) + (b ?? 0) + (c ?? 0) === monitored - (held ?? 0);
    record(4, WHAT_4, sumOk && monitored > 0 && tabs === 3 && selects === 1 && listed, `${a} + ${b} + ${c} = ${(a ?? 0) + (b ?? 0) + (c ?? 0)}; monitored ${monitored} − held ${held} = ${monitored - (held ?? 0)}; tabs=${tabs} selects=${selects} rows: ${rows.join(" ")}`);
  } catch (e) { await snap(page, "eligibility-failed"); record(4, WHAT_4, false, `${reason(e)}; network: ${net.summary()}`); }

  // 5. a monitored loan's page: the banner names the partner
  const WHAT_5 = `a monitored loan's page shows the banner "Monitored — <the partner's legal name> remains servicer" (the name from GET /v1/partner/me); no Pay, Escrow, Draft or other servicing control on the page`;
  try {
    if (!legalName) throw new Error("no partner name: the sign-in (outcome 2) did not open the shell");
    if (new URL(page.url()).pathname !== "/partners/eligibility") { await page.goto(`${BASE}/partners/eligibility`, { waitUntil: "load", timeout: 60_000 }); await page.waitForSelector('[data-testid="eligibility"]', { timeout: 60_000 }); }
    // the board's rows in tab order; a row whose page reads "In refinance" (a monitored loan with an open application) is passed over for the next
    const ids: string[] = [];
    for (const bucket of ["eligible_now", "likely_soon", "not_near"]) { await page.getByTestId(`tab-${bucket}`).click(); for (const id of await page.locator(`[data-testid="bucket-table-${bucket}"] [data-testid="loan-link"]`).evaluateAll((els) => els.map((el) => el.getAttribute("data-loan-id") ?? ""))) if (id && !ids.includes(id)) ids.push(id); }
    if (!ids.length) throw new Error("no loan row on the board: dispatch seed_demo");
    const expected = bannerMonitored(legalName); const tried: string[] = []; let banner = ""; let loanId = "";
    for (const id of ids.slice(0, 12)) {
      await page.goto(`${BASE}/partners/loans/${encodeURIComponent(id)}`, { waitUntil: "load", timeout: 60_000 });
      await page.waitForSelector('[data-testid="loan-banner"], [data-testid="loan-banner-retired"]', { timeout: 60_000 });
      banner = await text(page, "loan-banner"); loanId = id; tried.push(`${id.slice(0, 8)}…: ${JSON.stringify(banner || (await text(page, "loan-banner-retired")))}`);
      if (banner === expected || banner !== BANNER_IN_REFINANCE) break;
    }
    await snap(page, "loan-page");
    const controls = (await page.locator("button, a.btn, input[type=submit]").allInnerTexts()).map((s) => s.trim());
    const servicing = controls.filter((t) => SERVICING_CONTROL.test(t));
    const status = await page.getByTestId("loan-page").getAttribute("data-status");
    record(5, WHAT_5, banner === expected && servicing.length === 0 && status === "monitored", `loan=${loanId} banner=${JSON.stringify(banner)} expected=${JSON.stringify(expected)} status=${status} servicingControls=[${servicing.join(", ")}] tried: ${tried.join("; ")}`);
  } catch (e) { await snap(page, "loan-page-failed"); record(5, WHAT_5, false, `${reason(e)}; network: ${net.summary()}`); }

  // 6. the Serviced tab
  const WHAT_6 = "the Serviced tab is visible and disabled with the 36.6 copy (no chart, no zero); the loan page's status is monitored";
  try {
    if (!/^\/partners\/loans\//.test(new URL(page.url()).pathname)) throw new Error("not on a loan page (outcome 5 did not reach one)");
    const tab = page.getByTestId("tab-serviced");
    const present = await tab.count(); const visible = present === 1 && (await tab.isVisible());
    const disabled = present === 1 && (await tab.getAttribute("disabled")) !== null && (await tab.getAttribute("aria-disabled")) === "true";
    const title = present === 1 ? (await tab.getAttribute("title")) ?? "" : ""; const copy = await text(page, "serviced-tab-copy");
    const status = await page.getByTestId("loan-page").getAttribute("data-status");
    record(6, WHAT_6, visible && disabled && title === SERVICED_TAB_COPY && copy === SERVICED_TAB_COPY && status === "monitored", `present=${present} visible=${visible} disabled=${disabled} copyMatches=${copy === SERVICED_TAB_COPY} titleMatches=${title === SERVICED_TAB_COPY} status=${status} copy=${JSON.stringify(copy.slice(0, 60))}`);
  } catch (e) { await snap(page, "serviced-tab-failed"); record(6, WHAT_6, false, reason(e)); }

  // 7. sign out, and isolation
  const WHAT_7 = "sign out returns to the door: the cookie is gone, the next load of /partners is the door again, and a second fresh context sees the door and nothing of the book";
  try {
    await page.goto(`${BASE}/partners`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector('[data-testid="partner-shell"], [data-testid="door"]', { timeout: 60_000 });
    const signOut = page.getByTestId("sign-out"); const hadSignOut = (await signOut.count()) === 1;
    if (hadSignOut) { await signOut.first().click(); await page.waitForURL((u) => u.pathname === DOOR, { timeout: 30_000 }).catch(() => undefined); }
    const cookieAfter = await sessionCookie(ctx);
    await page.goto(`${BASE}/partners`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForURL((u) => u.pathname === DOOR, { timeout: 60_000 }).catch(() => undefined);
    await snap(page, "after-sign-out");
    const doorAgain = isDoor(page) && (await count(page, '[data-testid="partner-shell"]')) === 0;
    const other = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const op = await other.newPage();
    await op.goto(`${BASE}/partners`, { waitUntil: "load", timeout: 60_000 });
    await op.waitForURL((u) => u.pathname === DOOR, { timeout: 60_000 }).catch(() => undefined);
    await snap(op, "second-context");
    const door2 = isDoor(op) && (await count(op, '[data-testid="partner-shell"]')) === 0 && (await count(op, '[data-testid="loan-link"]')) === 0;
    await other.close();
    record(7, WHAT_7, hadSignOut && !cookieAfter?.value && doorAgain && door2, `signOut=${hadSignOut} cookieAfter=${cookieAfter?.value ? "present" : "gone"} doorAgain=${doorAgain} secondContextDoor=${door2}`);
  } catch (e) { await snap(page, "sign-out-failed"); record(7, WHAT_7, false, `${reason(e)}; network: ${net.summary()}`); }

  if (pageErrors.length) console.log(`page errors: ${JSON.stringify(pageErrors.slice(0, 5))}`);
  await ctx.close();
}

const browser = await chromium.launch();
try { await walk(browser); }
catch (e) { record(0, "the walk itself ran to the end", false, reason(e)); }
finally { await browser.close(); }
const failed = checks.filter((c) => !c.ok);
const report = { base: `${BASE}/partners`, at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks };
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n--- report.json\n${JSON.stringify(report)}`);
console.log(`\n${checks.length - failed.length} of ${checks.length} outcomes hold on ${BASE}/partners`);
process.exit(failed.length ? 1 : 0);
