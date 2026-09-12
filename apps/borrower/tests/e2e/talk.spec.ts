/**
 * /app/talk — the entry as one conversation. The proxy is replaced by `page.route` canned responses (no API): the first turn
 * shows the disclosure notice then the agent's question; a typed answer is posted as `{text}` and the transcript re-renders;
 * the range sentence arrives as a notice; the hand-off line shows the Create account link (no code by text or e-mail —
 * docs/ux/17 §2.0); a 503 says the route is not configured; axe AA.
 */
import { expect, test, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const at = "2026-10-19T14:00:00.000Z";
const disclosure = { role: "notice", text: "I'm Supermortgage's automated assistant, working for Partner Bank, your lender. You can reach a person at any time — just say *human*.", copy_key: "entry.disclosure.first", at };
const RANGE = "Today's 30-year fixed rates for this program range from 6.125% (6.240% APR) to 6.875% (6.990% APR) depending on credit and loan-to-value. This is not a commitment to lend; rates change daily. Partner Bank, NMLSR ID 123456.";

test.describe("talk", () => {
  test("the conversation: disclosure first, the agent asks, a typed answer posts {text}, the range arrives as a notice, the hand-off shows the Create account link; axe", async ({ page }) => {
    const posts: Record<string, unknown>[] = [];
    let transcript: Record<string, unknown>[] = [];
    await page.route("**/app/api/v1/borrower/talk", async (route) => {
      const body = (route.request().postDataJSON() as Record<string, unknown>) ?? {};
      posts.push(body);
      const text = typeof body.text === "string" ? body.text : "";
      const lines: Record<string, unknown>[] = [];
      if (!transcript.length) { lines.push(disclosure, { role: "agent", text: "Hi. What would you like to do: buy a home, lower your rate or payment, or take cash out?", at }); }
      else if (/lower/i.test(text)) { lines.push({ role: "you", text, at }, { role: "agent", text: "Got it. Is this your primary home, a second home, or an investment property?", at }); }
      else if (/450/.test(text)) { lines.push({ role: "you", text, at }, { role: "notice", text: RANGE, copy_key: "entry.range.card", at }, { role: "agent", text: "Those are today's rates above. Where should I send your real number?", at }); }
      else if (/go ahead/i.test(text)) { lines.push({ role: "you", text, at }, { role: "notice", text: "Create your account to get your real number. Your answers come with you.", copy_key: "account.from_talk", at }, { role: "agent", text: "Your real number takes a soft credit check that doesn't affect your score, and it starts with an account.", at }); }
      else lines.push({ role: "you", text, at }, { role: "agent", text: "Okay.", at });
      transcript = [...transcript, ...lines];
      return json(route, 200, { lead_id: "lead-1", agent: "claude", model: "claude-opus-5", transcript, lines, step: "goal", session_opened: false, level: null });
    });
    await page.goto("/app/talk");
    const log = page.getByRole("log");
    await expect(log.locator("li").first()).toHaveAttribute("data-copy-key", "entry.disclosure.first");
    await expect(log.locator("li").nth(1)).toContainText("What would you like to do");
    expect(posts[0]).toEqual({});
    await page.getByTestId("talk-input").fill("I want to lower my payment");
    await page.getByTestId("talk-send").click();
    await expect(log).toContainText("primary home");
    expect(posts[1]).toEqual({ text: "I want to lower my payment" });
    await page.getByTestId("talk-input").fill("worth 450k, owe 300k");
    await page.getByTestId("talk-input").press("Enter");
    const range = log.locator('li[data-copy-key="entry.range.card"]');
    await expect(range).toHaveAttribute("data-role", "notice");
    await expect(range).toContainText("6.125% (6.240% APR)");
    await expect(range).toContainText("NMLSR ID 123456");
    await page.getByTestId("talk-input").fill("ok go ahead");
    await page.getByTestId("talk-send").click();
    await expect(log).toHaveAttribute("data-step", "sign_up");
    await expect(log.locator('li[data-copy-key="account.from_talk"]')).toHaveAttribute("data-role", "notice");
    await expect(page.getByTestId("talk-sign-up")).toHaveAttribute("href", "/app/sign-up");
    await expect(page.getByRole("link", { name: "Open your file" })).toHaveCount(0);
    await expect(page.locator(".sm-talk-foot")).toContainText("claude-opus-5");
    // @axe-core/playwright bundles a newer playwright-core; the Page API used here is the same.
    const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(" | ")}`)).toEqual([]);
  });

  test("a server without the model key answers 503 and the page says so", async ({ page }) => {
    await page.route("**/app/api/v1/borrower/talk", (route) => json(route, 503, { code: "TALK_NOT_CONFIGURED", copy_key: "error.generic" }));
    await page.goto("/app/talk");
    await expect(page.locator("p[role=alert]")).toContainText("not configured");   // (Next's route announcer is the other alert on the page)
  });
});
