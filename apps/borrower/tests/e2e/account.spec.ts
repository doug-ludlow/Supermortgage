/**
 * 32.16 §2.0 (DELTA-29) e2e over the fixtures build at 1280 and 390 px: the account routes (/app/sign-up, /app/sign-in,
 * /app/reset) with `page.route` canned answers for `POST /v1/borrower/auth/account` (no API; the proxy would turn `token`
 * into the HttpOnly cookie). What is asserted is what the borrower sees: the disclosure line first on the sign-up, e-mail +
 * password + Google and nothing else (no code chooser, no passkey), create → the code step with the FAKE code → /app with the
 * thread; the sign-in refusals by copy key (auth.password_wrong, auth.account_locked, account.exists), EMAIL_UNVERIFIED →
 * the code step; the reset to account.reset.done; axe AA on each screen.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { copy, copyOptions } from "../../lib/copy";

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const SESSION = { level: "L1", session: "cookie", expires_at: "2027-01-01T00:00:00.000Z", party: { party_id: "party-0001", party_type: "borrower", display_name: "Maya Ortiz", first_name: "Maya" } };
const ANON = { code: "AUTH_REQUIRED", copy_key: "auth.sign_in" };
const PASSWORD = "correct horse battery";
const CODE = "246810";
const googleLabel = copy("auth.google.button");
const [continueLabel = ""] = copyOptions("auth.code.enter");
type Call = { path: string; body: Record<string, unknown> };

/**
 * Canned account API: `taken@example.com` exists (verified, password PASSWORD); `locked@example.com` is locked;
 * `unverified@example.com` signs in to EMAIL_UNVERIFIED with a fresh code; any other e-mail can be created. A verified code
 * or a password sign-in flips `state.signedIn`, after which /me and /thread answer.
 */
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
    calls.push({ path, body });
    if (path === "v1/borrower/me") return state.signedIn ? json(route, 200, { party: { party_id: "party-0001", display_name: "Maya Ortiz", first_name: "Maya" }, level: "L1", session: { session_id: "s-1", level: "L1", auth_method: "password" }, subjects: [], partner: { legal_name: "Saguaro Home Lending, LLC", nmlsr_id: "1873421" } }) : json(route, 401, ANON);
    if (path === "v1/borrower/thread") return state.signedIn ? json(route, 200, { conversation_id: "c-1", messages: [{ message_id: "m-1", conversation_id: "c-1", at: "2026-10-19T14:00:00.000Z", sender: "agent", sender_label: "Supermortgage", channel: "app", body_text: "{{copy:entry.disclosure.first}}", subject: {}, voice_turn: false, delivery: { sent: true, delivered: true, read: false } }], cards: [] }) : json(route, 401, ANON);
    if (path === "v1/borrower/auth/account") {
      const email = String(body.email ?? "").toLowerCase();
      const password = String(body.password ?? "");
      switch (body.action) {
        case "create":
          if (email === "taken@example.com") return json(route, 409, { code: "ACCOUNT_EXISTS", copy_key: "account.exists" });
          if (password.length < 8) return json(route, 400, { code: "PASSWORD_WEAK", copy_key: "account.password_weak" });
          return json(route, 200, { challenge_id: "ch-create", delivery: "FAKE", expires_at: "2027-01-01T00:00:00.000Z", fake_code: CODE });
        case "verify_email":
          if (body.code !== CODE) return json(route, 401, { code: "OTP_INVALID", copy_key: "auth.code_wrong" });
          state.signedIn = true;
          return json(route, 200, SESSION);
        case "sign_in":
          if (email === "locked@example.com") return json(route, 423, { code: "ACCOUNT_LOCKED", copy_key: "auth.account_locked" });
          if (email === "unverified@example.com") return json(route, 403, { code: "EMAIL_UNVERIFIED", copy_key: "auth.email_unverified", challenge_id: "ch-unverified", fake_code: CODE });
          if (email === "taken@example.com" && password === PASSWORD) {
            state.signedIn = true;
            return json(route, 200, SESSION);
          }
          return json(route, 401, { code: "PASSWORD_WRONG", copy_key: "auth.password_wrong" });
        case "request_reset":
          return json(route, 200, { ok: true, ...(email === "taken@example.com" ? { challenge_id: "ch-reset", fake_code: CODE } : {}) });
        case "reset":
          if (body.challenge_id !== "ch-reset" || body.code !== CODE) return json(route, 401, { code: "OTP_INVALID", copy_key: "auth.code_wrong" });
          return json(route, 200, { ok: true });
      }
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

test.describe("32.16 §2.0 — create an account", () => {
  test("the disclosure line first, then e-mail + password + Google and nothing else; create → the code step with the FAKE code → /app with the thread; axe on both screens", async ({ page }) => {
    const calls = await cannedApi(page, { signedIn: false });
    await page.goto("/app/sign-up");
    const form = page.locator("#otp");
    await expect(form).toBeVisible();
    await expect(form.getByTestId("account-title")).toHaveText(copy("account.create.title"));
    const disclosure = form.getByTestId("account-disclosure");
    await expect(disclosure).toHaveAttribute("data-copy-key", "entry.disclosure.first");
    await expect(disclosure).not.toContainText("{{");
    const box = (await disclosure.boundingBox())!;
    const titleBox = (await form.getByTestId("account-title").boundingBox())!;
    expect(box.y).toBeLessThan(titleBox.y); // the disclosure is the first line on the account screen
    await expect(form.getByRole("button", { name: googleLabel })).toBeVisible();
    for (const gone of copyOptions("auth.choose_method").filter((o) => o !== googleLabel)) await expect(form.getByRole("button", { name: gone })).toHaveCount(0);
    await expect(form.getByRole("link", { name: copy("account.have_account") })).toHaveAttribute("href", "/app/sign-in");
    await expect(page.locator("article[data-card-kind]")).toHaveCount(0);
    await axeClean(page);
    await form.getByLabel(copy("account.email.field")).fill("maya@example.com");
    await form.getByLabel(copy("account.password.field")).fill(PASSWORD);
    await form.getByRole("button", { name: copy("account.create.button") }).click();
    await expect(form.getByTestId("account-title")).toHaveText(copy("account.verify.title"));
    const code = form.getByLabel(copy("auth.code.enter", { destination: "maya@example.com" }));
    await expect(code).toBeVisible();
    await expect(form.getByTestId("fake-code")).toContainText(CODE);
    await expect(form.getByTestId("account-disclosure")).toHaveCount(0);
    await axeClean(page);
    await code.fill("000000");
    await form.getByRole("button", { name: continueLabel }).click();
    await expect(form.getByRole("alert")).toHaveText(copy("auth.code_wrong"));
    await code.fill(CODE);
    await form.getByRole("button", { name: continueLabel }).click();
    await page.waitForURL(/\/app\/?$/);
    await expect(page.getByTestId("thread")).toBeVisible(); // the fixtures build lands on the recorded thread; the disclosure as the session's first message is the API's fact (32.16-T25)
    await expect(page.getByTestId("action-bar")).toBeVisible();
    expect(calls.find((c) => c.path === "v1/borrower/auth/account" && c.body.action === "create")!.body).toMatchObject({ email: "maya@example.com", password: PASSWORD });
    expect(calls.find((c) => c.path === "v1/borrower/auth/account" && c.body.action === "verify_email")!.body).toMatchObject({ challenge_id: "ch-create" });
  });

  test("an e-mail with an account → account.exists, never the code", async ({ page }) => {
    await cannedApi(page, { signedIn: false });
    await page.goto("/app/sign-up");
    const form = page.locator("#otp");
    await form.getByLabel(copy("account.email.field")).fill("taken@example.com");
    await form.getByLabel(copy("account.password.field")).fill(PASSWORD);
    await form.getByRole("button", { name: copy("account.create.button") }).click();
    await expect(form.getByRole("alert")).toHaveText(copy("account.exists"));
    expect(await page.content()).not.toContain("ACCOUNT_EXISTS");
    await expect(form.getByTestId("account-title")).toHaveText(copy("account.create.title"));
  });
});

test.describe("32.16 §2.0 — sign in", () => {
  test("wrong password → auth.password_wrong; a locked account → auth.account_locked; the right password → /app; Forgot → /app/reset; New here → /app/sign-up; axe", async ({ page }) => {
    await cannedApi(page, { signedIn: false });
    await page.goto("/app/sign-in");
    const form = page.locator("#otp");
    await expect(form.getByTestId("account-title")).toHaveText(copy("account.signin.title"));
    await expect(form.getByTestId("account-disclosure")).toHaveCount(0);
    await expect(form.getByRole("link", { name: copy("account.forgot") })).toHaveAttribute("href", "/app/reset");
    await expect(form.getByRole("link", { name: copy("account.new") })).toHaveAttribute("href", "/app/sign-up");
    for (const gone of copyOptions("auth.welcome_back").filter((o) => o !== googleLabel)) await expect(form.getByRole("button", { name: gone })).toHaveCount(0);
    await axeClean(page);
    await form.getByLabel(copy("account.email.field")).fill("taken@example.com");
    await form.getByLabel(copy("account.password.field")).fill("nope");
    await form.getByRole("button", { name: copy("account.signin.button") }).click();
    await expect(form.getByRole("alert")).toHaveText(copy("auth.password_wrong"));
    await form.getByLabel(copy("account.email.field")).fill("locked@example.com");
    await form.getByRole("button", { name: copy("account.signin.button") }).click();
    await expect(form.getByRole("alert")).toHaveText(copy("auth.account_locked"));
    expect(await page.content()).not.toContain("ACCOUNT_LOCKED");
    await form.getByLabel(copy("account.email.field")).fill("taken@example.com");
    await form.getByLabel(copy("account.password.field")).fill(PASSWORD);
    await form.getByRole("button", { name: copy("account.signin.button") }).click();
    await page.waitForURL(/\/app\/?$/);
    await expect(page.getByTestId("thread")).toBeVisible();
  });

  test("EMAIL_UNVERIFIED → auth.email_unverified over the code step (a fresh code was sent); the code opens the session", async ({ page }) => {
    const calls = await cannedApi(page, { signedIn: false });
    await page.goto("/app/sign-in");
    const form = page.locator("#otp");
    await form.getByLabel(copy("account.email.field")).fill("unverified@example.com");
    await form.getByLabel(copy("account.password.field")).fill(PASSWORD);
    await form.getByRole("button", { name: copy("account.signin.button") }).click();
    await expect(form.getByTestId("account-title")).toHaveText(copy("account.verify.title"));
    await expect(form.getByRole("alert")).toHaveText(copy("auth.email_unverified"));
    await expect(form.getByTestId("fake-code")).toContainText(CODE);
    await form.getByLabel(copy("auth.code.enter", { destination: "unverified@example.com" })).fill(CODE);
    await form.getByRole("button", { name: continueLabel }).click();
    await page.waitForURL(/\/app\/?$/);
    await expect(page.getByTestId("thread")).toBeVisible();
    expect(calls.find((c) => c.path === "v1/borrower/auth/account" && c.body.action === "verify_email")!.body).toMatchObject({ challenge_id: "ch-unverified", code: CODE });
  });
});

test.describe("32.16 §2.0 — reset a password", () => {
  test("e-mail → the code + new password step with the FAKE code → account.reset.done with the sign-in link; no session; axe", async ({ page }) => {
    const calls = await cannedApi(page, { signedIn: false });
    await page.goto("/app/reset");
    const form = page.locator("#otp");
    await expect(form.getByTestId("account-title")).toHaveText(copy("account.reset.title"));
    await expect(form.getByLabel(copy("account.password.field"))).toHaveCount(0);
    await form.getByLabel(copy("account.email.field")).fill("taken@example.com");
    await form.getByRole("button", { name: continueLabel }).click();
    await expect(form.getByTestId("account-title")).toHaveText(copy("account.reset.code"));
    await expect(form.getByTestId("fake-code")).toContainText(CODE);
    await axeClean(page);
    await form.getByLabel(copy("auth.code.enter", { destination: "taken@example.com" })).fill(CODE);
    await form.getByLabel(copy("account.password.field")).fill("new horse battery");
    await form.getByRole("button", { name: copy("account.reset.button") }).click();
    const done = form.getByTestId("account-done");
    await expect(done).toContainText(copy("account.reset.done"));
    await expect(done.getByRole("link", { name: copy("account.signin.button") })).toHaveAttribute("href", "/app/sign-in");
    expect(calls.find((c) => c.path === "v1/borrower/auth/account" && c.body.action === "reset")!.body).toMatchObject({ challenge_id: "ch-reset", code: CODE, password: "new horse battery" });
    expect(calls.filter((c) => c.path === "v1/borrower/me")).toHaveLength(0); // no session was opened by the reset
    await done.getByRole("link", { name: copy("account.signin.button") }).click();
    await page.waitForURL(/\/app\/sign-in$/);
    await expect(page.locator("#otp").getByTestId("account-title")).toHaveText(copy("account.signin.title"));
  });
});
