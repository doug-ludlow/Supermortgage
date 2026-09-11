/**
 * 32.14 S0–S2 E2E at 1280 and 390 px over the FAKE entry preview (/app/entry-preview, dev/fixtures builds only)
 * with `page.route` canned answers for the lead API (`**\/app/api/v1/borrower/lead`) — the browser never sees a
 * token; the proxy would keep it in the HttpOnly cookie. What is asserted here is what the visitor sees:
 *  - S0: the disclosure line first with the automation marker, the headline, the three goal tiles, the quiet
 *    time-budget line; on a phone the status strip reads `entry.landing.getting_started` and no Record is shown.
 *  - S1: chips, the state select, the Colorado pre-use line before anything priced, the estimate as money fields.
 *  - S2: the published range with an APR beside each rate and the not-a-commitment footer, the promise, the
 *    identity ask; a closed state stops with `lead.state_closed`; a failed checklist shows no number.
 *  - axe: no WCAG 2.x A/AA violations on the dark theme at the range and at the closed state.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { copy } from "../../lib/copy";

type Scenario = "refinance" | "closed" | "refused";

const PARTNER = { legal_name: "Partner Bank", nmlsr_id: "123456" };
const RANGE = { low_pct: "6.125", high_pct: "6.875", apr_low_pct: "6.240", apr_high_pct: "6.990", product_code: "FRM30", rate_sheet_id: "rs-2026-10-19" };
const rangeTokens = { product: "30-year fixed", rate_low: "6.125%", apr_low: "6.240%", rate_high: "6.875%", apr_high: "6.990%", "partner.legal_name": PARTNER.legal_name, "partner.nmlsr_id": PARTNER.nmlsr_id };
const CHECKED_TEXT = `${copy("entry.range.card", rangeTokens)} ${copy("entry.range.disclaimer", rangeTokens)}`;

const line = (n: number, copy_key: string, extra: Record<string, unknown> = {}) => ({ message_id: `m-${n}`, at: new Date(Date.UTC(2026, 9, 19, 14, 0, n)).toISOString(), sender: "agent", copy_key, ...extra });
const STEPS = {
  goal: { id: "goal", kind: "ChoiceCard", copy_key: "entry.goal.question", options: [{ id: "buy" }, { id: "lower_rate" }, { id: "cash_out" }] },
  contract: { id: "contract", kind: "ChoiceCard", copy_key: "entry.buy.contract_question", options: [{ id: "signed" }, { id: "looking" }] },
  occupancy: { id: "occupancy", kind: "ChoiceCard", copy_key: "entry.occupancy.question", options: [{ id: "primary" }, { id: "second_home" }, { id: "investment" }] },
  state: { id: "state", kind: "ChoiceCard", copy_key: "entry.state.question" },
  estimate: { id: "estimate", kind: "ConfirmCard", copy_key: "entry.estimate.value" },
  identify: { id: "identify", kind: "ChoiceCard", copy_key: "auth.choose_method" },
};

/** FAKE lead API: one lead per page, the fixed step order, the state gate as the spec orders it (S1 (i)–(iii)). */
function fakeLeadApi(scenario: Scenario) {
  const calls: Record<string, unknown>[] = [];
  let n = 10;
  const handler = async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push(body);
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    switch (body.action) {
      case "start":
        // the proxy strips lead_token and sets the HttpOnly cookie; the page never sees a token
        return json({ lead_id: "lead-e2e", partner: PARTNER, lines: [line(1, "entry.disclosure.first", { automation_marker: true })], step: STEPS.goal });
      case "answer": {
        const step = body.step as string;
        const value = body.value as string | Record<string, string>;
        if (step === "goal") return json({ lead_id: "lead-e2e", lines: [], step: value === "buy" ? STEPS.contract : STEPS.occupancy });
        if (step === "contract" || step === "occupancy") return json({ lead_id: "lead-e2e", lines: [], step: STEPS.state });
        if (step === "state") {
          if (scenario === "closed" || value === "NY") return json({ lead_id: "lead-e2e", lines: [], step: null, closed: { reason: "state_not_licensed", copy_key: "lead.state_closed" } });
          const lines: unknown[] = [];
          if (value === "UT" || value === "CA") lines.push(line((n += 1), "entry.disclosure.first", { automation_marker: true, state_variant: value }));
          if (value === "CO") lines.push(line((n += 1), "entry.disclosure.co_admt"));
          return json({ lead_id: "lead-e2e", lines, step: STEPS.estimate });
        }
        if (step === "estimate") {
          const v = value as Record<string, string>;
          if (!Object.values(v).every((c) => /^\d+$/.test(c))) return json({ code: "BAD_CENTS", copy_key: "error.generic" }, 409);
          return json({ lead_id: "lead-e2e", lines: [], step: null });
        }
        return json({ code: "STEP_ORDER", copy_key: "error.generic" }, 409);
      }
      case "range":
        if (scenario === "refused") return json({ range: null, refused: "RANGE_CONTENT_CHECK", next: STEPS.identify });
        return json({ range: { ...RANGE, text: CHECKED_TEXT }, card: { kind: "StatusCard", copy_key: "entry.range.card", personal_terms: false }, promise_copy_key: "entry.range.promise", disclaimer_copy_key: "entry.range.disclaimer", next: STEPS.identify });
      default:
        return json({ code: "not_found", copy_key: "error.generic" }, 404);
    }
  };
  return { handler, calls };
}

async function open(page: Page, scenario: Scenario) {
  const api = fakeLeadApi(scenario);
  await page.route("**/app/api/v1/borrower/lead", api.handler);
  await page.goto("/app/entry-preview");
  await expect(page.getByTestId("shell")).toBeVisible();
  await expect(page.getByTestId("fake-banner")).toBeVisible();
  await expect(page.getByTestId("entry-goal")).toBeVisible();
  return api;
}

/** goal → occupancy → state → estimate (refinance), leaving the page at whatever follows the estimate. */
async function throughEstimate(page: Page, state: string) {
  await page.getByRole("button", { name: "Lower my rate or payment" }).click();
  await page.getByRole("button", { name: "Primary home" }).click();
  await page.getByTestId("entry-state-select").selectOption(state);
  await page.getByTestId("entry-state-continue").click();
  if (state === "NY") return;
  await page.getByTestId("lead-estimate-value_estimate_cents").fill("$400,000");
  await page.getByTestId("lead-estimate-stated_existing_balance_cents").fill("250,000");
  await page.getByTestId("entry-estimate-continue").click();
}

async function axe(page: Page) {
  const results = await // @axe-core/playwright bundles a newer playwright-core; the Page API used here is the same.
  new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(" | ")}`);
}

test.describe("32.14 the anonymous minute", () => {
  test("S0: the thread renders with no session — disclosure first with the marker, headline, three tiles, time budget; phones read Getting started", async ({ page }) => {
    const api = await open(page, "refinance");
    expect(api.calls[0]).toMatchObject({ action: "start", channel: "web_chat" });
    const log = page.getByTestId("anonymous-minute");
    await expect(log).toHaveAttribute("data-step", "goal");
    // the first line in the log is the disclosure, automated, with the partner's name; the goal card follows it
    const first = log.locator("[data-testid=lead-line]").first();
    await expect(first).toHaveAttribute("data-copy-key", "entry.disclosure.first");
    await expect(first).toContainText("working for Partner Bank");
    await expect(first.getByTestId("automation-marker")).toHaveText("automated");
    const firstBox = (await first.boundingBox())!;
    const goalBox = (await page.getByTestId("entry-goal").boundingBox())!;
    expect(firstBox.y).toBeLessThan(goalBox.y);
    await expect(page.getByTestId("entry-headline")).toHaveText(copy("entry.landing.headline"));
    const tiles = page.locator('article[data-card-id="lead-goal"] .sm-option');
    await expect(tiles).toHaveText(["Buy a home", "Lower my rate or payment", "Take cash out"]);
    await expect(page.getByTestId("entry-time-budget")).toHaveText(copy("entry.landing.time_budget"));
    await expect(page.getByTestId("identity-ask")).toHaveCount(0);
    const vp = page.viewportSize()!;
    if (vp.width < 768) {
      const strip = page.getByTestId("status-strip");
      await expect(strip).toBeVisible();
      await expect(strip.getByTestId("status-badge")).toContainText(copy("entry.landing.getting_started")); // the badge is an icon glyph + the library line
    } else {
      await expect(page.getByTestId("status-strip")).toBeHidden();
    }
    // no Record pane: there is no subject
    await expect(page.getByTestId("record")).toHaveCount(0);
    // no horizontal scroll at either width
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(vp.width);
  });

  test("S1→S2 refinance in Colorado: chips, the pre-use notice before anything priced, money fields as cents, the range with APRs and the footer, the promise, the identity ask; axe AA", async ({ page }) => {
    const api = await open(page, "refinance");
    await page.getByRole("button", { name: "Lower my rate or payment" }).click();
    const occupancy = page.locator('article[data-card-id="lead-occupancy"]');
    await expect(occupancy.locator('.sm-option[aria-pressed="true"]')).toHaveCount(0);
    await expect(occupancy.locator(".sm-option")).toHaveText(["Primary home", "Second home", "Investment property"]);
    await page.getByRole("button", { name: "Primary home" }).click();
    await expect(page.getByTestId("entry-state-continue")).toBeDisabled();
    await page.getByTestId("entry-state-select").selectOption("CO");
    await page.getByTestId("entry-state-continue").click();
    // (iii) CO → the pre-use notice line, before the estimate and before any range
    const co = page.locator('[data-testid=lead-line][data-copy-key="entry.disclosure.co_admt"]');
    await expect(co.locator(".sm-msg-body")).toHaveText(copy("entry.disclosure.co_admt"));
    await expect(page.getByTestId("entry-estimate-continue")).toBeDisabled();
    const value = page.getByTestId("lead-estimate-value_estimate_cents");
    await expect(value).toHaveAccessibleName(copy("entry.estimate.value"));
    await value.fill("$400,000");
    await page.getByTestId("lead-estimate-stated_existing_balance_cents").fill("250,000.50");
    await page.getByTestId("entry-estimate-continue").click();
    const card = page.getByTestId("range-card");
    await expect(card).toBeVisible();
    const estimateCall = api.calls.find((c) => c.action === "answer" && c.step === "estimate")!;
    expect(estimateCall.value).toEqual({ value_estimate_cents: "40000000", stated_existing_balance_cents: "25000050" });
    expect(api.calls.map((c) => c.action)).toEqual(["start", "answer", "answer", "answer", "answer", "range"]);
    const coBox = (await co.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    expect(coBox.y).toBeLessThan(cardBox.y);
    await expect(card).toHaveAttribute("data-personal-terms", "false");
    await expect(card).toContainText("6.125% (6.240% APR) to 6.875% (6.990% APR)");
    await expect(card).toContainText("Not a commitment to lend");
    await expect(card).toContainText("Partner Bank, NMLSR ID 123456");
    expect((await card.textContent())!.match(/Not a commitment to lend/g)).toHaveLength(1);
    await expect(page.getByTestId("range-promise")).toContainText(copy("entry.range.promise"));
    const ask = page.getByTestId("identity-ask");
    await expect(ask).toBeVisible();
    await expect(ask.getByTestId("fake-identity-marker")).toContainText("FAKE");
    await expect(ask).toContainText(copy("auth.choose_method"));
    await expect(page.getByTestId("anonymous-minute")).toHaveAttribute("data-step", "identify");
    expect(await axe(page)).toEqual([]);
  });

  test("S1 closed state (NY): lead.state_closed and nothing else — no range, no identity ask; axe AA", async ({ page }) => {
    const api = await open(page, "closed");
    await throughEstimate(page, "NY");
    const closed = page.locator('[data-testid=lead-line][data-copy-key="lead.state_closed"]');
    await expect(closed.locator(".sm-msg-body")).toHaveText(copy("lead.state_closed", { state: "New York" }));
    await expect(page.getByTestId("anonymous-minute")).toHaveAttribute("data-closed", "state_not_licensed");
    await expect(page.getByTestId("range-card")).toHaveCount(0);
    await expect(page.getByTestId("identity-ask")).toHaveCount(0);
    await expect(page.getByTestId("entry-estimate-continue")).toHaveCount(0);
    expect(api.calls.map((c) => c.action)).not.toContain("range");
    expect(await axe(page)).toEqual([]);
  });

  test("S2 checklist refused: no number is shown and the identity ask still renders", async ({ page }) => {
    await open(page, "refused");
    await throughEstimate(page, "AZ");
    await expect(page.getByTestId("identity-ask")).toBeVisible();
    await expect(page.getByTestId("range-card")).toHaveCount(0);
    await expect(page.getByTestId("range-promise")).toHaveCount(0);
    await expect(page.getByTestId("anonymous-minute")).not.toContainText("%");
  });

  test("an API failure renders error.generic copy, never a hard-coded sentence", async ({ page }) => {
    await page.route("**/app/api/v1/borrower/lead", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "api_not_configured", copy_key: "error.generic" }) }));
    await page.goto("/app/entry-preview");
    await expect(page.getByTestId("entry-error")).toHaveText(copy("error.generic"));
    await expect(page.getByTestId("entry-goal")).toHaveCount(0);
  });
});

// 32.14 S0 at the ROOT of the host (not the preview page): no session → the anonymous minute renders in the shell, the Record stays hidden,
// and the header's Sign in opens the chooser under auth.welcome_back. `?fixture=api` makes the fixtures build take the live path.
test("the root with no session is the anonymous minute; the header's Sign in opens the chooser", async ({ page }) => {
  const api = fakeLeadApi("refinance");
  await page.route("**/app/api/v1/borrower/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/v1/borrower/lead")) return api.handler(route);
    return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "AUTH_REQUIRED", copy_key: "auth.sign_in" }) });
  });
  await page.goto("/app?fixture=api");
  await expect(page.getByTestId("shell")).toBeVisible();
  const log = page.getByTestId("anonymous-minute");
  await expect(log).toHaveAttribute("data-step", "goal");
  await expect(log.locator("[data-testid=lead-line]").first()).toHaveAttribute("data-copy-key", "entry.disclosure.first");
  expect(api.calls[0]).toMatchObject({ action: "start", channel: "web_chat" });
  await expect(page.getByTestId("sign-in-methods")).toHaveCount(0);
  await expect(page.getByTestId("record")).toHaveCount(0);
  await page.getByTestId("sign-in-button").click();
  await expect(page.getByTestId("sign-in-title")).toHaveText(copy("auth.welcome_back"));
});
