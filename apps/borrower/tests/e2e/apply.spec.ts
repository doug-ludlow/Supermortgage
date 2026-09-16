/**
 * 32.19 — the Apply product over the fixtures build (NEXT_PUBLIC_FIXTURES=1) at 1280 and 390 px, the proxy replaced by
 * `page.route` canned answers (no API). What the borrower sees, never the engine (src/domain/borrower/32-19.spec.test.ts
 * drives the real API):
 *  - T-18-01 the door: welcome → intro → the account form (e-mail + password + Google) on the paper, the disclosure footer on every
 *    screen, none of the old shell's regions (thread, record, action bar, tab nav);
 *  - T-18-02 / T-18-17 a session lands on Apply at the goal step with the pending goal card; the five tabs and the primary CTA in the
 *    viewport, no horizontal scroll at 390, the mark and the paper tokens from apply.css; Tasks with the seven rows derived (all
 *    open), My Loan `apply.loan.empty`, Account with the first name and the partner; Sign out → the door;
 *  - axe (WCAG 2.x A/AA) on the door, the goal step and Tasks at both widths — no serious or critical violation.
 * Not a CI gate (the walk and 32.19's suite are); it type-checks in the image build (Dockerfile.borrower runs `next build` over tests/).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { copy } from "../../lib/copy";

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ANON = { code: "AUTH_REQUIRED", copy_key: "auth.sign_in" };
const APPLICATION_ID = "0b0e7d2a-2c1f-4c8e-9a6b-1f3e5d7c9a11";
const GOAL_CARD = "c0a1b2c3-d4e5-4f60-8a7b-9c0d1e2f3a44";
const ME = { party: { party_id: "party-0001", party_type: "borrower", display_name: "Maya Ortiz", first_name: "Maya" }, level: "L1", session: { session_id: "s-1", level: "L1", auth_method: "password" }, subjects: [{ application_id: APPLICATION_ID, loan_id: null, role: "borrower", stage: "origination", label: "Buying" }], partner: { legal_name: "Saguaro Home Lending, LLC", nmlsr_id: "1873421" } };
const GOAL = { card_instance_id: GOAL_CARD, party_id: "party-0001", kind: "ChoiceCard", status: "pending", created_by: "flow", copy_key: "entry.goal.question", created_at: "2026-10-19T14:00:00.000Z", command_ref: "application.setGoal", subject: { application_id: APPLICATION_ID, loan_id: null },
  props: { title: "", statement: "By continuing you agree to e-sign, to texts and to a credit check.", statement_version: "consents-on-goal-2026-09", options: [{ id: "buy", label: "Buy a home", is_primary: true }, { id: "lower_rate", label: "Lower my rate or payment" }, { id: "cash_out", label: "Take cash out" }], command: "application.setGoal", command_args_by_option: { buy: {}, lower_rate: {}, cash_out: {} } } };

/** The canned borrower API: a session (or none), the organic application with its pending goal card, no record yet (the interview opens on the goal tap). */
async function cannedApi(page: Page, state: { signedIn: boolean }): Promise<{ path: string; body: Record<string, unknown> }[]> {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/app/api/v1/borrower/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/app\/api\//, "");
    let body: Record<string, unknown> = {};
    try { body = (req.postDataJSON() as Record<string, unknown>) ?? {}; } catch { /* no JSON body */ }
    calls.push({ path, body });
    if (!state.signedIn) return json(route, 401, ANON);
    if (path === "v1/borrower/me") return json(route, 200, ME);
    if (path === "v1/borrower/thread") return json(route, 200, { conversation_id: "c-1", messages: [], cards: [GOAL], pinned_placed_by: null, pinned_card: null });
    if (path === "v1/borrower/record") return json(route, 404, { code: "RECORD_NOT_READY", copy_key: "error.generic" });   // no record before the interview: the page shows no badge, no error
    if (path === "v1/borrower/auth/sign-out") { state.signedIn = false; return json(route, 200, { signed_out: true }); }
    return json(route, 404, { code: "not_found", copy_key: "error.generic" });
  });
  return calls;
}

/** axe over the page: only a serious or critical violation fails (T-18-17); the rest is logged on the test. */
async function axeSerious(page: Page, what: string, testInfo: { annotations: { type: string; description?: string }[] }) {
  const results = await // @axe-core/playwright bundles a newer playwright-core; the Page API used here is the same.
  new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const line = (v: (typeof results.violations)[number]) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(" | ")}`;
  for (const v of results.violations) testInfo.annotations.push({ type: `axe ${what}`, description: line(v) });
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map(line)).toEqual([]);
}

async function inViewport(page: Page, selector: string): Promise<boolean> {
  const box = await page.locator(selector).first().boundingBox();
  const vp = page.viewportSize()!;
  return !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= vp.height && box.x + box.width <= vp.width;
}

test.describe("32.19 — the door (T-18-01)", () => {
  test("a fresh window: welcome on the paper with the mark and the footer; none of the old shell; Continue → intro → Create an account → the account form with Google; Already have an account? → sign in; axe", async ({ page }, testInfo) => {
    await cannedApi(page, { signedIn: false });
    await page.goto("/app");
    const root = page.getByTestId("apply");
    await expect(root).toHaveAttribute("data-door", "welcome");
    await expect(root).not.toHaveAttribute("data-tab", /.+/);
    for (const gone of ["thread", "record", "action-bar", "shell", "tab-nav", "account", "header"]) await expect(page.getByTestId(gone)).toHaveCount(0);
    await expect(page.locator(".sm-mark .sm-mark-s")).toBeVisible();
    await expect(page.locator(".sm-mark-name")).toHaveText(copy("apply.door.title"));
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".sm-phone")!).backgroundColor)).toBe("rgb(252, 252, 252)");   // apply.css --paper
    const vp = page.viewportSize()!;
    const column = (await page.locator(".sm-phone").boundingBox())!;
    expect(Math.round(column.width)).toBe(vp.width >= 1280 ? 430 : vp.width);
    const footer = page.getByTestId("footer-disclosure");
    await expect(footer).toHaveCount(1);
    await expect(footer).toContainText("This chat is AI-powered. Chats are recorded for quality.");
    await expect(footer.getByRole("link", { name: "Disclosures and licenses" })).toHaveAttribute("href", "/app/disclosures");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width);
    await axeSerious(page, "welcome", testInfo);
    await expect(page.getByTestId("apply-continue")).toHaveText(copy("apply.continue"));
    await page.getByTestId("apply-continue").click();
    await expect(root).toHaveAttribute("data-door", "intro");
    await expect(page.locator(".sm-bubble h1")).toHaveText(copy("apply.door.what"));
    await expect(footer).toHaveCount(1);
    await page.getByRole("button", { name: copy("apply.door.create") }).click();
    await expect(root).toHaveAttribute("data-door", "account");
    const account = page.getByTestId("account");
    await expect(account).toHaveAttribute("data-mode", "sign_up");
    await expect(page.locator('[data-testid="account-form"] input[type="email"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="account-form"] input[type="password"]')).toHaveCount(1);
    await expect(page.getByTestId("account-google")).toHaveCount(1);
    await expect(footer).toHaveCount(1);
    await axeSerious(page, "account", testInfo);
    await page.getByTestId("apply-account-switch").click();
    await expect(account).toHaveAttribute("data-mode", "sign_in");
    await expect(page.getByTestId("account-code-request")).toHaveCount(1);   // the code door beside Sign in (33.1 rule 5)
    // the mark goes home: welcome again, then "Already have an account?" on the intro lands on sign in
    await page.locator(".sm-mark").click();
    await expect(root).toHaveAttribute("data-door", "welcome");
    await page.getByTestId("apply-continue").click();
    await page.getByTestId("apply-have-account").click();
    await expect(page.getByTestId("account")).toHaveAttribute("data-mode", "sign_in");
  });
});

test.describe("32.19 — a session on Apply (T-18-02, T-18-17)", () => {
  test("lands on the goal step with the pending goal card; the five tabs and the CTA in the viewport, no sideways scroll; Tasks' seven open rows, My Loan empty, Account; Sign out → the door; axe", async ({ page }, testInfo) => {
    const calls = await cannedApi(page, { signedIn: true });
    await page.goto("/app");
    const root = page.getByTestId("apply");
    await expect(root).toHaveAttribute("data-tab", "apply");
    await expect(root).toHaveAttribute("data-step", "goal");
    await expect(root).not.toHaveAttribute("data-door", /.+/);
    for (const gone of ["thread", "record", "action-bar", "shell", "tab-nav", "account"]) await expect(page.getByTestId(gone)).toHaveCount(0);
    const vp = page.viewportSize()!;
    await expect(page.locator(".sm-bubble h1")).toHaveText(copy("apply.goal.question"));
    for (const id of ["apply", "chat", "loan", "tasks", "account"]) expect(await inViewport(page, `[data-testid="apply-tab-${id}"]`), `tab ${id} in the viewport`).toBe(true);
    expect(await inViewport(page, '[data-testid="apply-continue"]'), "the CTA in the viewport").toBe(true);
    await expect(page.getByTestId("footer-disclosure")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".sm-mark-s")!).color)).toBe("rgb(191, 36, 43)");   // apply.css --accent on the mark
    await expect(page.getByTestId("apply-error")).toHaveCount(0);
    await axeSerious(page, "goal", testInfo);
    // the goal card is loaded (the thread's pending card): Buy a home → Property shows the card's own consents statement above Continue
    await page.getByRole("button", { name: copy("apply.goal.buy") }).click();
    await page.getByTestId("apply-continue").click();
    await expect(root).toHaveAttribute("data-step", "property");
    await expect(page.getByTestId("apply-consents")).toHaveText(GOAL.props.statement);
    await expect(page.getByTestId("apply-consents")).toHaveAttribute("data-statement-version", GOAL.props.statement_version);
    expect(calls.some((c) => c.path === "v1/borrower/thread")).toBe(true);
    // Tasks: the seven rows, none done (nothing resolved on the canned thread); a tap jumps to the step
    await page.getByTestId("apply-tab-tasks").click();
    await expect(root).toHaveAttribute("data-tab", "tasks");
    for (const t of ["property", "you", "connect", "details", "questions", "demographics", "review"]) await expect(page.getByTestId(`apply-task-${t}`)).toHaveAttribute("data-done", "false");
    await expect(page.getByTestId("tasks-empty")).toHaveCount(0);
    await axeSerious(page, "tasks", testInfo);
    await page.getByTestId("apply-task-property").click();
    await expect(root).toHaveAttribute("data-tab", "apply");
    await expect(root).toHaveAttribute("data-step", "property");
    // My Loan: apply.loan.empty — no dollar sign, no digit
    await page.getByTestId("apply-tab-loan").click();
    const empty = page.getByTestId("apply-loan-empty");
    await expect(empty).toContainText(copy("apply.loan.empty"));
    expect(await empty.innerText()).not.toMatch(/[$\d]/);
    // Chat: the composer is the dock's input, in the viewport
    await page.getByTestId("apply-tab-chat").click();
    expect(await inViewport(page, ".sm-composer input")).toBe(true);
    await expect(page.getByTestId("apply-chat")).toContainText(copy("apply.chat.empty"));
    // Account: the first name and the partner; Sign out posts auth/sign-out and the next screen is the door
    await page.getByTestId("apply-tab-account").click();
    await expect(page.getByTestId("apply-account-name")).toHaveText("Maya");
    await expect(page.getByTestId("apply-account-partner")).toHaveText("Saguaro Home Lending, LLC");
    await page.getByTestId("apply-sign-out").click();
    await expect(root).toHaveAttribute("data-door", "welcome");
    expect(calls.filter((c) => c.path === "v1/borrower/auth/sign-out")).toHaveLength(1);
    await expect(page.getByTestId("apply-tab-apply")).toHaveCount(0);
  });

  test("?card= on the goal card lands on its step; an unknown card is ignored — Apply with no card and no error", async ({ page }) => {
    await cannedApi(page, { signedIn: true });
    await page.goto(`/app?card=${GOAL_CARD}`);
    const root = page.getByTestId("apply");
    await expect(root).toHaveAttribute("data-tab", "apply");
    await expect(root).toHaveAttribute("data-step", "goal");
    await page.goto("/app?card=7d0f7c3e-1a2b-4c5d-8e9f-0a1b2c3d4e5f");
    await expect(root).toHaveAttribute("data-tab", "apply");
    await expect(root).toHaveAttribute("data-step", "goal");
    await expect(page.locator('[data-testid^="apply-card-"]')).toHaveCount(0);
    await expect(page.getByTestId("apply-error")).toHaveCount(0);
  });
});
