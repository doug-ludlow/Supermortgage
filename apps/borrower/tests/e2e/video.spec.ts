/**
 * 32.17 — /app/video over the fixtures build (NEXT_PUBLIC_FIXTURES=1) at 1280 and 390 px (T10, T12 as the shell shows them):
 *  - the call pane in the thread's place (a FAKE call), the rail beside it at ≥ 1024 with only the current ask open and the other
 *    pending cards behind one "n more after this" line; no card component inside the call pane;
 *  - the disclosure footer with its two links; no composer, no microphone control of Supermortgage's own, no "Talk to a person";
 *  - Leave → the ended line and a new call; the rail stays;
 *  - on a phone the status strip opens the same rail as the sheet;
 *  - axe on the dark theme.
 */
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function inViewport(page: Page, testId: string): Promise<boolean> {
  const box = await page.getByTestId(testId).boundingBox();
  const vp = page.viewportSize()!;
  return !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= vp.height && box.x + box.width <= vp.width;
}

test.describe("the video agent (refinance fixture)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app/video?fixture=refinance");
    await expect(page.getByTestId("shell")).toBeVisible();
    await expect(page.getByTestId("video-call")).toHaveAttribute("data-phase", "live");
  });

  test("32.17-T10 (the screen): the disclosure footer, no composer, no microphone control of Supermortgage's own, no Talk to a person; the FAKE marker", async ({ page }) => {
    await expect(page.getByTestId("footer-disclosure")).toBeVisible();
    await expect(page.getByTestId("footer-disclosure")).toContainText("NMLS #");
    await expect(page.getByTestId("footer-disclosure").getByRole("link", { name: "Disclosures and licenses" })).toHaveAttribute("href", "/app/disclosures");
    await expect(page.getByTestId("action-bar")).toHaveCount(0);
    await expect(page.getByTestId("thread")).toHaveCount(0);
    await expect(page.getByTestId("talk-to-person")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /microphone|voice|mic\b/i })).toHaveCount(0);
    await expect(page.getByTestId("video-fake-marker")).toContainText("FAKE video agent");
    expect(await inViewport(page, "footer-disclosure")).toBe(true);
  });

  test("32.17-T12 (the screen): the stage alone — no rail beside the call, no card inside the call pane; Your record opens the rail as a drawer with only the current ask open and the rest behind one line; Leave ends the call and offers a new one with the rail still live", async ({ page }) => {
    const vp = page.viewportSize()!;
    const call = (await page.getByTestId("video-call").boundingBox())!;
    const body = (await page.locator(".sm-body").boundingBox())!;
    expect(Math.abs(call.width - body.width)).toBeLessThanOrEqual(2);   // 32.17 rule 16: the stage is the body's width at every size
    expect(await page.getByTestId("record").boundingBox()).toBeNull();   // no rail on the screen until asked for
    await expect(page.getByTestId("video-call").locator("article[data-card-kind]")).toHaveCount(0);
    if (vp.width >= 1024) {
      await expect(page.getByTestId("status-strip")).toBeHidden();
      await page.locator('[data-testid="header"] button[aria-haspopup="dialog"]').first().click();
      await expect(page.locator('[data-testid="record"][data-open="true"]')).toBeVisible();
      const needed = page.locator('[data-testid="record"] [data-record-section="needed"]');
      const rows = needed.locator("[data-rail-card]:not([data-tone='caution'])");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toHaveAttribute("data-expanded", "true");
      await expect(rows.first().locator("article[data-card-kind]")).toHaveCount(1);
      const later = needed.getByTestId("needs-later");
      await expect(later).toHaveText(/\d+ more after this$/);
      await expect(later).toHaveAttribute("aria-expanded", "false");
      await page.locator('[data-testid="record"] .sm-record-close').click();
      expect(await page.getByTestId("record").boundingBox()).toBeNull();
    }
    // a card that rose over the stage (the fixture's current ask needs a tap) never covers Leave
    const ask = page.getByTestId("ask-overlay");
    if (await ask.count()) { const a = (await ask.boundingBox())!; const leave = (await page.getByTestId("video-leave").boundingBox())!; expect(a.y).toBeGreaterThanOrEqual(leave.y + leave.height - 1); }
    await page.getByTestId("video-leave").click();
    await expect(page.getByTestId("video-ended")).toBeVisible();
    await expect(page.getByTestId("video-new-call")).toBeVisible();
    await expect(page.getByTestId("record")).toBeAttached();
    await page.getByTestId("video-new-call").click();
    await expect(page.getByTestId("video-call")).toHaveAttribute("data-phase", "live");
  });

  test("on a phone the status strip opens the rail as the sheet; the page never scrolls sideways", async ({ page }) => {
    const vp = page.viewportSize()!;
    test.skip(vp.width >= 768, "phone only");
    await expect(page.getByTestId("status-strip")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390 && document.body.scrollWidth <= 390)).toBe(true);
    await page.getByTestId("status-strip").click();
    await expect(page.locator('[data-testid="record"][data-open="true"]')).toBeVisible();
    await expect(page.locator('[data-testid="record"][data-open="true"] [data-record-section="needed"]')).toBeVisible();
  });

  test("axe: no AA violations on the dark theme", async ({ page }) => {
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});
