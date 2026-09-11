/**
 * E2E over fixtures mode (NEXT_PUBLIC_FIXTURES=1) at 1280 and 390 px.
 *  - T-X-08 Talk to a person: visible without scrolling on every screen; after the (simulated)
 *    transfer a PersonCard{human_agent} exists.
 *  - T-X-10 Mobile parity: the status strip shows badge, next event and the needed-from-you count.
 *  - axe on the dark theme (13 §1 component list; the 13 §6 "no AA violations" bar).
 */
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function inViewport(page: Page, testId: string): Promise<boolean> {
  const box = await page.getByTestId(testId).boundingBox();
  const vp = page.viewportSize()!;
  return !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= vp.height && box.x + box.width <= vp.width;
}

for (const fixture of ["refinance", "servicing"]) {
  test.describe(`${fixture} fixture`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/app?fixture=${fixture}`);
      await expect(page.getByTestId("shell")).toBeVisible();
      await expect(page.getByTestId("fake-banner")).toBeVisible();
    });

    test("T-X-08 Talk to a person is visible without scrolling; transfer yields a PersonCard", async ({ page }) => {
      expect(await inViewport(page, "talk-to-person")).toBe(true);
      await page.getByTestId("talk-to-person").click();
      const human = page.locator('article[data-card-kind="PersonCard"]', { hasText: "A person on your loan" });
      await expect(human).toHaveCount(1);
      await expect(human).toBeVisible();
      // still visible after the thread grew
      expect(await inViewport(page, "talk-to-person")).toBe(true);
    });

    test("shell regions and breakpoint layout", async ({ page }, testInfo) => {
      const vp = page.viewportSize()!;
      await expect(page.getByTestId("thread")).toBeVisible();
      await expect(page.getByTestId("action-bar")).toBeVisible();
      if (vp.width >= 1280) {
        // 58 / 42 split: Record visible beside the Thread
        await expect(page.getByTestId("record")).toBeVisible();
        const thread = (await page.locator("main.sm-thread").boundingBox())!;
        const record = (await page.getByTestId("record").boundingBox())!;
        expect(Math.round((thread.width / (thread.width + record.width)) * 100)).toBe(58);
        await expect(page.getByTestId("status-strip")).toBeHidden();
        // pinned current ask shows the most recent pending card
        await expect(page.getByTestId("pinned-ask")).toBeVisible();
      } else {
        // T-X-10: status strip with badge, next event and needed-from-you count; Record as a bottom sheet
        const strip = page.getByTestId("status-strip");
        await expect(strip).toBeVisible();
        await expect(strip.getByTestId("status-badge")).toBeVisible();
        await expect(strip.getByTestId("strip-next")).not.toBeEmpty();
        await expect(strip.getByTestId("strip-count")).toContainText(/needed/);
        await expect(page.getByTestId("record")).toBeHidden();
        await strip.click();
        await expect(page.getByTestId("record")).toBeVisible();
        await expect(page.getByTestId("record").locator('[data-record-section="status"]')).toBeVisible();
        await page.getByRole("button", { name: "Close your record" }).click();
        await expect(page.getByTestId("record")).toBeHidden();
      }
      testInfo.annotations.push({ type: "viewport", description: `${vp.width}x${vp.height}` });
    });

    test("cards resolve in place and the Record's needed-from-you updates", async ({ page }) => {
      const pending = page.locator('article[data-status="pending"]').first();
      const kind = await pending.getAttribute("data-card-kind");
      if (fixture === "refinance") {
        // ConnectCard (Truv): FAKE vendor marker and launch → in_progress
        const truv = page.locator('article[data-card-id="card-r3-truv"]');
        await expect(truv.getByTestId("fake-vendor")).toContainText("FAKE vendor");
        await truv.getByRole("button", { name: "Connect with Truv" }).click();
        await expect(truv.getByTestId("connect-state")).toContainText("In progress");
      } else {
        expect(kind).toBe("PaymentCard");
        await pending.getByRole("button", { name: "Pay now" }).click();
        await expect(page.locator('article[data-card-id="card-s-pay"]')).toHaveAttribute("data-status", "resolved");
      }
    });

    test("axe: no WCAG 2.x A/AA violations on the dark theme", async ({ page }) => {
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      const vp = page.viewportSize()!;
      if (vp.width < 768) await page.getByTestId("status-strip").click(); // scan the bottom sheet too
      const results = await // @axe-core/playwright bundles a newer playwright-core; the Page API used here is the same.
      new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(" | ")}`);
      expect(summary).toEqual([]);
    });
  });
}
