/**
 * /app/talk — retired for now (docs/decisions/2026-09-16-apply-product.md item 5; docs/ux/18 §2.6): the route redirects to the
 * Apply product on /app. The proxy is replaced by a `page.route` canned 401 (no API), so what is asserted is the redirect and the
 * door it lands on — never a conversation, never a talk input.
 */
import { expect, test, type Route } from "@playwright/test";

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

test.describe("talk", () => {
  test("/app/talk redirects to /app: the Apply door renders, no talk input, no conversation", async ({ page }) => {
    await page.route("**/app/api/v1/borrower/**", (route) => json(route, 401, { code: "AUTH_REQUIRED", copy_key: "auth.sign_in" }));
    await page.goto("/app/talk");
    await page.waitForURL(/\/app\/?$/);
    await expect(page.getByTestId("apply")).toHaveAttribute("data-door", "welcome");
    await expect(page.getByTestId("talk-input")).toHaveCount(0);
    await expect(page.getByRole("log")).toHaveCount(0);
    await expect(page.getByTestId("footer-disclosure")).toHaveCount(1);
  });
});
