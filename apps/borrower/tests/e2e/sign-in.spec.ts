/**
 * 32.14 DELTA-12 / DELTA-14 e2e over the fixtures build at 1280 and 390 px, with the sign-in screen of 32.16 §2.0. The proxy
 * is replaced by `page.route` canned responses (no API): the header's Sign in → the account form under auth.welcome_back in
 * place of the thread, no action bar while signed out, no code chooser and no passkey; a deep link without a session (T16)
 * → the same form with the token retained → e-mail + password → the card pinned on /app; the Google FAKE path (FAKE identity
 * form → start → the callback page posts with x-fake-oidc → the pending deep link resumes); expired / unknown / another
 * party's tokens; the vendor return; axe AA on the screens.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { copy, copyOptions } from "../../lib/copy";

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const SESSION = { level: "L1", session: "cookie", expires_at: "2027-01-01T00:00:00.000Z", party: { party_id: "party-0001", party_type: "borrower", display_name: "Maya Ortiz", first_name: "Maya" } };
const ANON = { code: "AUTH_REQUIRED", copy_key: "auth.sign_in" };
const PASSWORD = "correct horse battery";
const googleLabel = copy("auth.google.button");
type Call = { path: string; body: Record<string, unknown>; headers: Record<string, string> };

/** Canned proxy: the borrower API as the shell sees it through /app/api. `state.signedIn` flips on a password sign-in or a Google callback. */
async function cannedApi(page: Page, state: { signedIn: boolean }): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/app/api/v1/borrower/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/app\/api\//, "");
    let body: Record<string, unknown> = {};
    try {
      body = (req.postDataJSON() as Record<string, unknown>) ?? {};
    } catch {
      /* no JSON body */
    }
    calls.push({ path, body, headers: req.headers() });
    if (path === "v1/borrower/me") return state.signedIn ? json(route, 200, { party: { party_id: "party-0001", display_name: "Maya Ortiz", first_name: "Maya" }, level: "L1", session: { session_id: "s-1", level: "L1", auth_method: "password" }, subjects: [], partner: { legal_name: "Saguaro Home Lending, LLC", nmlsr_id: "1873421" } }) : json(route, 401, ANON);
    if (path === "v1/borrower/thread") return state.signedIn ? json(route, 200, { conversation_id: "c-1", messages: [], cards: [] }) : json(route, 401, ANON);
    if (path === "v1/borrower/auth/account") {
      if (body.action === "sign_in") {
        if (body.password === PASSWORD) {
          state.signedIn = true;
          return json(route, 200, SESSION);
        }
        return json(route, 401, { code: "PASSWORD_WRONG", copy_key: "auth.password_wrong" });
      }
    }
    if (path === "v1/borrower/auth/oidc") {
      if (body.action === "start") return json(route, 200, { authorization_url: `/app/auth/google/callback?code=FAKE-${encodeURIComponent(String((body.fake as { email?: string } | undefined)?.email ?? ""))}&state=st-1`, state: "st-1", expires_at: "2027-01-01T00:00:00.000Z" });
      if (body.action === "callback") {
        if (req.headers()["x-fake-oidc"] !== "FAKE" || body.state !== "st-1") return json(route, 401, { code: "OIDC_INVALID", copy_key: "auth.google.failed" });
        state.signedIn = true;
        return json(route, 200, SESSION);
      }
    }
    if (path.startsWith("v1/borrower/deeplink/")) {
      const token = path.slice("v1/borrower/deeplink/".length);
      if (!state.signedIn) return json(route, 401, ANON);
      if (token === "tok-card") return json(route, 200, { token, target: { card_instance_id: "card-r3-truv" }, expires_at: "2027-01-01T00:00:00.000Z" });
      if (token === "tok-old") return json(route, 410, { code: "DEEP_LINK_EXPIRED", copy_key: "deeplink.expired" });
      if (token === "tok-theirs") return json(route, 403, { code: "PARTY_SCOPE", copy_key: "error.not_yours" });
      return json(route, 404, { code: "DEEP_LINK_UNKNOWN", copy_key: "deeplink.unknown" });
    }
    return json(route, 404, { code: "not_found", copy_key: "error.generic" });
  });
  return calls;
}

async function axeClean(page: Page) {
  const results = await // @axe-core/playwright bundles a newer playwright-core; the Page API used here is the same.
  new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(" | ")}`)).toEqual([]);
}

async function signInWithPassword(form: ReturnType<Page["locator"]>, password = PASSWORD) {
  await form.getByLabel(copy("account.email.field")).fill("maya@example.com");
  await form.getByLabel(copy("account.password.field")).fill(password);
  await form.getByRole("button", { name: copy("account.signin.button") }).click();
}

test.describe("32.16 §2.0 — Sign in from the header (32.14 S6)", () => {
  test("opens the account form under auth.welcome_back in place of the thread; no action bar while signed out; no code chooser, no passkey; axe; a wrong password → auth.password_wrong; the right one → the thread", async ({ page }) => {
    await cannedApi(page, { signedIn: false });
    await page.goto("/app?fixture=refinance");
    await expect(page.getByTestId("shell")).toBeVisible();
    await expect(page.getByTestId("partner-phone")).toHaveCount(0);
    await page.getByTestId("sign-in-button").click();
    const form = page.locator("#otp");
    await expect(form).toBeVisible();
    await expect(form.getByTestId("account-title")).toHaveText(copy("auth.welcome_back"));
    await expect(form.getByLabel(copy("account.email.field"))).toBeVisible();
    await expect(form.getByLabel(copy("account.password.field"))).toBeVisible();
    await expect(form.getByRole("button", { name: googleLabel })).toBeVisible();
    for (const gone of copyOptions("auth.welcome_back").filter((o) => o !== googleLabel)) await expect(form.getByRole("button", { name: gone })).toHaveCount(0);
    await expect(page.getByTestId("thread")).toHaveCount(0);
    await expect(page.getByTestId("action-bar")).toHaveCount(0);
    await expect(page.getByTestId("talk-to-person")).toHaveCount(0);
    await expect(page.getByTestId("footer-disclosure")).toContainText("This chat is AI-powered.");   // 32.16 §1 principle 8: the footer is the disclosure on the sign-in screen too
    await axeClean(page);
    await signInWithPassword(form, "nope");
    await expect(form.getByRole("alert")).toHaveText(copy("auth.password_wrong"));
    await expect(form.getByRole("alert")).not.toContainText("PASSWORD_WRONG");
    await form.getByLabel(copy("account.password.field")).fill(PASSWORD);
    await form.getByRole("button", { name: copy("account.signin.button") }).click();
    await expect(page.getByTestId("thread")).toBeVisible();
    await expect(page.getByTestId("action-bar")).toBeVisible();
  });

  test("a 401 at the root renders the sign-in form under auth.welcome_back (never the anonymous minute) with the links to sign-up and reset", async ({ page }) => {
    await cannedApi(page, { signedIn: false });
    await page.goto("/app?fixture=api");
    const form = page.locator("#otp");
    await expect(form).toBeVisible();
    await expect(form.getByTestId("account-title")).toHaveText(copy("auth.welcome_back"));
    await expect(form.getByRole("link", { name: copy("account.new") })).toHaveAttribute("href", "/app/sign-up");
    await expect(form.getByRole("link", { name: copy("account.forgot") })).toHaveAttribute("href", "/app/reset");
    await expect(page.getByTestId("action-bar")).toHaveCount(0);
    await expect(page.getByTestId("thread")).toHaveCount(0);
    expect(await page.content()).not.toContain(copy("entry.landing.headline"));
  });
});

test.describe("32.14 S5 — deep links and the return page", () => {
  test("T16: without a session the sign-in form renders with the token retained and no loan data; after the sign-in the card is pinned and scrolled into view", async ({ page }) => {
    const calls = await cannedApi(page, { signedIn: false });
    await page.goto("/app/d/tok-card");
    const form = page.locator("#otp");
    await expect(form).toBeVisible();
    await expect(page.getByTestId("deep-link")).toHaveAttribute("data-deep-link-token", "tok-card");
    await expect(form.getByTestId("account-title")).toHaveText(copy("auth.welcome_back"));
    expect(await page.locator("article[data-card-kind]").count()).toBe(0);
    const html = await page.content();
    expect(html.replace(/<script[\s\S]*?<\/script>/g, "")).not.toMatch(/\$\d/);
    await axeClean(page);
    await signInWithPassword(form);
    await page.waitForURL(/\/app\?card=card-r3-truv$/);
    await expect(page.locator('[data-rail-card="card-r3-truv"]')).toHaveAttribute("data-expanded", "true");   // 32.16 §2.2: focused and expanded on the rail (the sheet, on a phone)
    await expect(page.locator('article[data-card-id="card-r3-truv"]')).toBeInViewport();
    expect(calls.filter((c) => c.path === "v1/borrower/deeplink/tok-card")).toHaveLength(2);
    const signIn = calls.find((c) => c.path === "v1/borrower/auth/account")!;
    expect(signIn.body).toMatchObject({ action: "sign_in", email: "maya@example.com" });
  });

  test("DELTA-12: Continue with Google from a deep link — the FAKE identity form → start → the callback posts with x-fake-oidc: FAKE → the pending deep link resumes", async ({ page }) => {
    const calls = await cannedApi(page, { signedIn: false });
    await page.goto("/app/d/tok-card");
    const form = page.locator("#otp");
    await form.getByRole("button", { name: googleLabel }).click();
    const fake = page.getByTestId("fake-google");
    await expect(fake.locator(".sm-fake")).toHaveText("FAKE Google identity");
    await fake.getByLabel(copy("auth.email.field")).fill("maya@example.com");
    await fake.getByRole("button", { name: googleLabel }).click();
    await page.waitForURL(/\/app\?card=card-r3-truv$/);
    await expect(page.locator('[data-rail-card="card-r3-truv"]')).toHaveAttribute("data-expanded", "true");
    const start = calls.find((c) => c.path === "v1/borrower/auth/oidc" && c.body.action === "start")!;
    expect(start.body).toMatchObject({ provider: "google", fake: { email: "maya@example.com", email_verified: true } });
    expect(String(start.body.redirect_uri)).toMatch(/\/app\/auth\/google\/callback$/);
    const cb = calls.find((c) => c.path === "v1/borrower/auth/oidc" && c.body.action === "callback")!;
    expect(cb.body).toMatchObject({ provider: "google", code: "FAKE-maya@example.com", state: "st-1" }); // the page passes Google's `code` decoded, as the API expects it
    expect(cb.headers["x-fake-oidc"]).toBe("FAKE");
  });

  test("an expired token → deep_link.expired with the sign-in offer; unknown → deep_link.unknown; another party's → the refusal and no target", async ({ page }) => {
    await cannedApi(page, { signedIn: true });
    await page.goto("/app/d/tok-old");
    const refused = page.getByTestId("deep-link-refused"); // scoped: Next's route announcer is a second role=alert
    await expect(refused).toHaveAttribute("data-copy-key", "deep_link.expired");
    await expect(refused.getByRole("alert")).toHaveText(copy("deep_link.expired"));
    await expect(refused.getByRole("link", { name: copyOptions("deep_link.expired")[0]! })).toBeVisible();
    await axeClean(page);
    await page.goto("/app/d/tok-nope");
    await expect(refused.getByRole("alert")).toHaveText(copy("deep_link.unknown"));
    await page.goto("/app/d/tok-theirs");
    await expect(refused.getByRole("alert")).toHaveText(copy("error.not_yours"));
    await expect(refused.getByRole("link")).toHaveCount(0);
    expect(page.url()).toContain("/app/d/tok-theirs");
    expect(await page.content()).not.toContain("PARTY_SCOPE");
  });

  test("/return/{vendor}/{card} lands on /app with the card pinned; the ConnectCard's state is the API's, not the return's", async ({ page }) => {
    await page.goto("/app/return/truv/card-r3-truv");
    await page.waitForURL(/\/app\?card=card-r3-truv$/);
    await expect(page.locator('[data-rail-card="card-r3-truv"]')).toHaveAttribute("data-expanded", "true");
    const truv = page.locator('article[data-card-id="card-r3-truv"]');
    await expect(truv).toBeInViewport();
    await expect(truv.getByTestId("connect-state")).toContainText("Not started");
  });
});
