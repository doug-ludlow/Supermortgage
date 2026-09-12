/**
 * E2E over fixtures mode (NEXT_PUBLIC_FIXTURES=1) at 1280 and 390 px.
 *  - 32.16 §1 principle 8: no "Talk to a person" control while no person exists; the disclosure footer on every screen;
 *    the input bar is one input, Send and the attach icon.
 *  - 32.16 §2.1–2.2: the thread is conversation and chips; the cards live on the rail (T11) and resolve there.
 *  - T-X-10 Mobile parity: the status strip shows badge, next event and the needed-from-you count; the sheet is the rail.
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

    test("32.16 §1 principle 8: no Talk to a person control, no microphone; the disclosure footer with its two links is on the screen; the input bar is input · Send · attach", async ({ page }) => {
      await expect(page.getByTestId("talk-to-person")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /voice/i })).toHaveCount(0);
      const footer = page.getByTestId("footer-disclosure");
      await expect(footer).toBeVisible();
      await expect(footer).toContainText("This chat is AI-powered.");
      await expect(footer).toContainText("NMLS #");
      await expect(footer.getByRole("link", { name: "here" })).toHaveAttribute("href", "https://www.nmlsconsumeraccess.org/");
      await expect(footer.getByRole("link", { name: "Disclosures and licenses" })).toHaveAttribute("href", "/app/disclosures");
      expect(await inViewport(page, "footer-disclosure")).toBe(true);
      const bar = page.getByTestId("action-bar");
      await expect(bar.getByTestId("attach")).toBeVisible();
      await expect(bar.getByTestId("send")).toBeVisible();
      await expect(bar.getByRole("textbox")).toBeVisible();
      // the header: the brand and Sign in (the fixtures build can demo sign-in) — no e-mail, no assurance level, no sentence
      await expect(page.getByTestId("header")).not.toContainText(/L1|L2|L3|@|automated/);
      // the log: no sender label rows, no "automated" badge, no disclosure sentence; the disclosure row is the footer
      await expect(page.getByTestId("thread")).not.toContainText("automated assistant");
      await expect(page.getByTestId("thread").locator(".sm-msg-meta")).toHaveCount(0);
      // no card component renders in the thread (32.16-T11)
      await expect(page.getByTestId("thread").locator("article[data-card-kind]")).toHaveCount(0);
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
        // the rail: Needed from you with the current ask expanded (its component), the sections in order; no default waiting bar
        const rail = page.getByTestId("record");
        await expect(rail.locator('[data-record-section="needed"]')).toBeVisible();
        await expect(rail.locator('[data-rail-card][data-current-ask="true"][data-expanded="true"] article[data-card-kind]')).toHaveCount(1);
        await expect(page.getByTestId("waiting-on-you")).toHaveCount(0);
        const sections = await rail.locator("[data-record-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-record-section")));
        const order = ["status", "progress", "needed", "connections", "documents", "doing", "people", "numbers", "dates", "property", "loan"];
        expect(sections.filter((s) => order.includes(s!)).map((s) => order.indexOf(s!))).toEqual([...sections.filter((s) => order.includes(s!)).map((s) => order.indexOf(s!))].sort((a, b) => a - b));
        if (fixture === "refinance") await expect(rail.getByTestId("progress-count")).toHaveText("10 of 12");
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

    test("cards resolve in place on the rail and the Record's needed-from-you updates", async ({ page }) => {
      const vp = page.viewportSize()!;
      if (vp.width < 768) await page.getByTestId("status-strip").click(); // the sheet is the rail
      const rail = page.getByTestId("record");
      if (fixture === "refinance") {
        // ConnectCard (Truv) under Needed from you: it waits behind "n more after this" until it is the ask (32.16 §2.2); open the line, expand its row, FAKE vendor marker and launch → in_progress
        const later = rail.getByTestId("needs-later");
        await expect(later).toHaveText(/\d+ more after this/);
        await later.click();
        const row = rail.locator('[data-rail-card="card-r3-truv"]');
        await row.locator("> button").click();
        const truv = rail.locator('article[data-card-id="card-r3-truv"]');
        await expect(truv.getByTestId("fake-vendor")).toContainText("FAKE vendor");
        await truv.getByRole("button", { name: "Connect with Truv" }).click();
        await expect(truv.getByTestId("connect-state")).toContainText("In progress");
        // the confirm chip (32.16 §3.4): the model's proposal read back in the thread; Confirm resolves the card; the chip becomes the receipt
        if (vp.width < 768) await page.getByRole("button", { name: "Close your record" }).click();
        const chip = page.getByTestId("confirm-chip");
        await expect(chip.getByTestId("confirm-chip-readback")).toContainText("$8,200.00 a month, base pay · Acme Corp");
        await chip.getByTestId("confirm-chip-confirm").click();
        await expect(page.getByTestId("confirm-chip")).toHaveCount(0);
        await expect(page.locator('[data-testid="chip-receipt"][data-card-id="card-r3-income"]')).toContainText("confirmed");
        // the rates element (32.16-T7): product, low and high each with its APR, the lender and NMLSR ID as the footer
        const rates = page.getByTestId("rates-element");
        await expect(rates.getByTestId("rates-product")).toHaveText("30-year fixed");
        await expect(rates.getByTestId("rates-low")).toContainText("6.125% · 6.240% APR");
        await expect(rates.getByTestId("rates-high")).toContainText("6.875% · 6.990% APR");
        await expect(rates.getByTestId("rates-footer")).toHaveText("Saguaro Home Lending, LLC, NMLSR ID 1873421. Not a commitment to lend; rates change daily.");
      } else {
        const pending = rail.locator('[data-rail-card][data-current-ask="true"] article[data-status="pending"]').first();
        expect(await pending.getAttribute("data-card-kind")).toBe("PaymentCard");
        await pending.getByRole("button", { name: "Pay now" }).click();
        // resolved: the card leaves Needed from you; its reference in the thread becomes the receipt (32.16-T12)
        await expect(rail.locator('[data-rail-card="card-s-pay"]')).toHaveCount(0);
        await expect(rail.getByTestId("needs-none")).toBeVisible();
        if (vp.width < 768) await page.getByRole("button", { name: "Close your record" }).click();
        await expect(page.locator('[data-testid="chip-receipt"][data-card-id="card-s-pay"]')).toBeVisible();
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
