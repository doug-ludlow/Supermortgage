/**
 * 32.14 Phase 1 e2e (DELTA-12, DELTA-14) over the fixtures build at 1280 and 390 px. The proxy is replaced by `page.route`
 * canned responses (no API): the header's Sign in → the chooser under auth.welcome_back with Talk to a person still visible (no phone number in the header);
 * a deep link without a session (T16) → the chooser with the token retained → the FAKE code → the card pinned on /app; the
 * Google FAKE path (FAKE identity form → start → the callback page posts with x-fake-oidc → the pending deep link resumes);
 * expired / unknown / another party's tokens; the vendor return; Use my passkey offered first on a device with the hint
 * (T12); axe AA on the new screens.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { copy, copyOptions } from "../../lib/copy";

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const SESSION = { level: "L1", session: "cookie", expires_at: "2027-01-01T00:00:00.000Z", party: { party_id: "party-0001", party_type: "borrower", display_name: "Maya Ortiz", first_name: "Maya" } };
const ANON = { code: "AUTH_REQUIRED", copy_key: "auth.sign_in" };
const [smsLabel = "", , googleLabel = "", passkeyLabel = ""] = copyOptions("auth.welcome_back");
const [continueLabel = ""] = copyOptions("auth.code.enter");
type Call = { path: string; body: Record<string, unknown>; headers: Record<string, string> };

async function inViewport(page: Page, testId: string): Promise<boolean> {
  const box = await page.getByTestId(testId).boundingBox();
  const vp = page.viewportSize()!;
  return !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= vp.height && box.x + box.width <= vp.width;
}

/** Canned proxy: the borrower API as the shell sees it through /app/api. `state.signedIn` flips on a verified code, a Google callback or a passkey assertion. */
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
    if (path === "v1/borrower/me") return state.signedIn ? json(route, 200, { party: { party_id: "party-0001", display_name: "Maya Ortiz", first_name: "Maya" }, level: "L1", session: { session_id: "s-1", level: "L1", auth_method: "otp_phone" }, subjects: [], partner: { legal_name: "Saguaro Home Lending, LLC", nmlsr_id: "1873421" } }) : json(route, 401, ANON);
    if (path === "v1/borrower/auth/otp") {
      if (body.action === "request") return json(route, 200, { challenge_id: "ch-1", channel: body.channel, delivery: "FAKE", expires_at: "2027-01-01T00:00:00.000Z", fake_code: "246810" });
      if (body.action === "verify") {
        if (body.challenge_id === "ch-1" && body.code === "246810") {
          state.signedIn = true;
          return json(route, 200, SESSION);
        }
        return json(route, 401, { code: "OTP_INVALID", copy_key: "auth.code_wrong" });
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
    if (path === "v1/borrower/auth/passkey") {
      if (body.action === "assert_options") return json(route, 200, { challenge_id: "ch-p", challenge: "AQID", rp: { id: "127.0.0.1", name: "Supermortgage" }, allow_credentials: [], timeout_ms: 600000 });
      if (body.action === "assert") {
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

test.describe("32.14 S6 — Sign in from the header", () => {
  test("opens the chooser under auth.welcome_back in place of the thread; Talk to a person stays visible; no phone number in the header; axe", async ({ page }) => {
    await cannedApi(page, { signedIn: false });
    await page.goto("/app?fixture=refinance");
    await expect(page.getByTestId("shell")).toBeVisible();
    await expect(page.getByTestId("partner-phone")).toHaveCount(0);
    await page.getByTestId("sign-in-button").click();
    const signIn = page.locator("#otp");
    await expect(signIn).toBeVisible();
    await expect(signIn.getByTestId("sign-in-title")).toHaveText(copy("auth.welcome_back"));
    await expect(signIn.getByRole("button", { name: smsLabel })).toBeVisible();
    await expect(signIn.getByRole("button", { name: googleLabel })).toBeVisible();
    await expect(signIn.getByRole("button", { name: passkeyLabel })).toHaveCount(0);
    await expect(page.getByTestId("thread")).toHaveCount(0);
    expect(await inViewport(page, "talk-to-person")).toBe(true);
    await axeClean(page);
    // a wrong code renders auth.code_wrong; the right one reloads the shell
    await signIn.getByRole("button", { name: smsLabel }).click();
    await signIn.getByLabel(copy("auth.sms.field")).fill("(602) 555-0100");
    await signIn.getByRole("button", { name: smsLabel }).click();
    await expect(signIn.getByTestId("fake-code")).toContainText("246810");
    await signIn.getByLabel(copy("auth.code.enter", { destination: "(602) 555-0100" })).fill("000000");
    await signIn.getByRole("button", { name: continueLabel }).click();
    await expect(signIn.getByRole("alert")).toHaveText(copy("auth.code_wrong"));
    await signIn.getByLabel(copy("auth.code.enter", { destination: "(602) 555-0100" })).fill("246810");
    await signIn.getByRole("button", { name: continueLabel }).click();
    await expect(page.getByTestId("thread")).toBeVisible();
  });

  test("T12: a device that registered a passkey is offered Use my passkey first; the assertion opens the session", async ({ page }) => {
    await cannedApi(page, { signedIn: false });
    await page.addInitScript(() => {
      window.localStorage.setItem("sm_passkey_device", "1");
      // FAKE authenticator: the browser's WebAuthn call answers a canned credential; the API (canned here too) verifies
      const bytes = (...b: number[]) => new Uint8Array(b).buffer;
      Object.defineProperty(navigator, "credentials", { value: { get: async () => ({ id: "cred-1", response: { clientDataJSON: bytes(1, 2, 3), authenticatorData: bytes(4), signature: bytes(5, 6) } }), create: async () => null }, configurable: true });
    });
    await page.goto("/app?fixture=refinance");
    await page.getByTestId("sign-in-button").click();
    const methods = page.getByTestId("sign-in-methods").getByRole("button");
    await expect(methods.first()).toHaveText(passkeyLabel);
    await expect(methods.first()).toHaveClass(/sm-btn-primary/);
    await methods.first().click();
    await expect(page.getByTestId("thread")).toBeVisible();
  });
});

test.describe("32.14 S5 — deep links and the return page", () => {
  test("T16: without a session the chooser renders with the token retained and no loan data; after the code the card is pinned and scrolled into view", async ({ page }) => {
    const calls = await cannedApi(page, { signedIn: false });
    await page.goto("/app/d/tok-card");
    const signIn = page.locator("#otp");
    await expect(signIn).toBeVisible();
    await expect(page.getByTestId("deep-link")).toHaveAttribute("data-deep-link-token", "tok-card");
    await expect(signIn.getByTestId("sign-in-title")).toHaveText(copy("auth.welcome_back"));
    expect(await page.locator("article[data-card-kind]").count()).toBe(0);
    const html = await page.content();
    expect(html.replace(/<script[\s\S]*?<\/script>/g, "")).not.toMatch(/\$\d/);
    await axeClean(page);
    await signIn.getByRole("button", { name: smsLabel }).click();
    await signIn.getByLabel(copy("auth.sms.field")).fill("6025550100");
    await signIn.getByRole("button", { name: smsLabel }).click();
    await signIn.getByLabel(copy("auth.code.enter", { destination: "6025550100" })).fill("246810");
    await signIn.getByRole("button", { name: continueLabel }).click();
    await page.waitForURL(/\/app\?card=card-r3-truv$/);
    await expect(page.getByTestId("pinned-ask")).toHaveAttribute("data-pinned-card", "card-r3-truv");
    await expect(page.locator('article[data-card-id="card-r3-truv"]')).toBeInViewport();
    expect(calls.filter((c) => c.path === "v1/borrower/deeplink/tok-card")).toHaveLength(2);
  });

  test("DELTA-12: Continue with Google from a deep link — the FAKE identity form → start → the callback posts with x-fake-oidc: FAKE → the pending deep link resumes", async ({ page }) => {
    const calls = await cannedApi(page, { signedIn: false });
    await page.goto("/app/d/tok-card");
    const signIn = page.locator("#otp");
    await signIn.getByRole("button", { name: googleLabel }).click();
    const fake = page.getByTestId("fake-google");
    await expect(fake.locator(".sm-fake")).toHaveText("FAKE Google identity");
    await fake.getByLabel(copy("auth.email.field")).fill("maya@example.com");
    await fake.getByRole("button", { name: googleLabel }).click();
    await page.waitForURL(/\/app\?card=card-r3-truv$/);
    await expect(page.getByTestId("pinned-ask")).toHaveAttribute("data-pinned-card", "card-r3-truv");
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
    await expect(page.getByTestId("pinned-ask")).toHaveAttribute("data-pinned-card", "card-r3-truv");
    const truv = page.locator('article[data-card-id="card-r3-truv"]');
    await expect(truv).toBeInViewport();
    await expect(truv.getByTestId("connect-state")).toContainText("Not started");
  });
});
