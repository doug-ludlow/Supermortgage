/**
 * The deploy walk's screen driver (docs/ux/18 §2, PLAN §4): the Apply product driven the way a person drives it — the test ids of
 * docs/ux/18 §2.5 (`[data-testid="apply"]` with `data-door` / `data-tab` / `data-step`, `apply-continue`, `apply-error`,
 * `apply-card-{id}`, …) and the copy library's labels — in a 390 × 844 mobile context on the deployed demo. Every Continue is
 * followed by a wait for the next `data-step` and a read of `apply-error`; a step that does not advance, or advances with an
 * error line, is a `ScreenError` naming the step, the error text and the step the page is on. Nothing here talks to the API:
 * the page's own proxy calls are the page's; the walk (demo-walk.mts) reads the thread and the ops record beside these screens.
 *
 * Copied, not imported (this file runs from apps/borrower against a deployed demo): the fixture values of du-journey.mts.
 */
import type { Locator, Page } from "@playwright/test";

export type Log = (line: string) => void;
export type DriveOptions = { stepTimeoutMs?: number; log?: Log };
/** A step recorded by the driver: the step the page reached and the error line it showed (empty when none). */
export type StepRecord = { step: string; error: string };

export class ScreenError extends Error {
  readonly step: string;
  constructor(step: string, reason: string) { super(`${step}: ${reason}`); this.name = "ScreenError"; this.step = step; }
}

export const WALK_NAME = "Walk Tester";
export const WALK_DOB = "1988-04-12";
export const SSN = "123-45-6789";
export const ADDRESS = "100 N Central Ave, Phoenix, AZ 85004";
export const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;

const ROOT = '[data-testid="apply"]';
export const attr = (page: Page, name: string): Promise<string | null> => page.locator(ROOT).first().getAttribute(name);
/** The text of an element that may be absent: "" at once when it is not on the page (innerText() on a missing element waits Playwright's 30 s action timeout before failing — read on every Continue and every screenshot, that wait was the walk's whole running time: 60 s a screenshot, 30 s a step, 29 minutes for seven outcomes on run 184). */
const textOf = async (page: Page, selector: string): Promise<string> => { const el = page.locator(selector).first(); if ((await el.count()) === 0) return ""; return ((await el.innerText({ timeout: 5_000 }).catch(() => "")) ?? "").trim(); };
export const errorText = (page: Page): Promise<string> => textOf(page, '[data-testid="apply-error"]');
export const badgeText = (page: Page): Promise<string> => textOf(page, '[data-testid="apply-badge"]');
/** The whole Apply screen's text (what the borrower reads). */
export const screenText = (page: Page): Promise<string> => textOf(page, ROOT);

export async function waitForStep(page: Page, step: string, what: string, o: DriveOptions = {}): Promise<void> {
  try { await page.waitForSelector(`${ROOT}[data-step="${step}"]`, { timeout: o.stepTimeoutMs ?? 90_000 }); }
  catch { throw new ScreenError(what, `did not reach step ${step} (on ${await attr(page, "data-step")}; tab ${await attr(page, "data-tab")}; error ${JSON.stringify(await errorText(page))})`); }
}
export async function waitForTab(page: Page, tab: string, what: string, o: DriveOptions = {}): Promise<void> {
  try { await page.waitForSelector(`${ROOT}[data-tab="${tab}"]`, { timeout: o.stepTimeoutMs ?? 60_000 }); }
  catch { throw new ScreenError(what, `did not reach tab ${tab} (on ${await attr(page, "data-tab")}; door ${await attr(page, "data-door")}; error ${JSON.stringify(await errorText(page))})`); }
}

/** Continue → the next step, with no error line: the record of the step reached. */
export async function continueTo(page: Page, step: string, what: string, o: DriveOptions = {}): Promise<StepRecord> {
  await page.locator('[data-testid="apply-continue"]').first().click();
  await waitForStep(page, step, what, o);
  const error = await errorText(page);
  if (error) throw new ScreenError(what, `reached ${step} with an error line: ${JSON.stringify(error)}`);
  o.log?.(`${what} → ${step}`);
  return { step, error };
}

export const fill = (page: Page, label: string, value: string): Promise<void> => page.getByLabel(label, { exact: true }).first().fill(value);
export const pick = async (page: Page, label: string, option: string): Promise<void> => { await page.getByLabel(label, { exact: true }).first().selectOption({ label: option }); };
export const tab = async (page: Page, id: "apply" | "chat" | "loan" | "tasks" | "account", o: DriveOptions = {}): Promise<void> => { await page.locator(`[data-testid="apply-tab-${id}"]`).first().click(); await waitForTab(page, id, `the ${id} tab`, o); };

/** The door: welcome → intro → the account form in sign-up mode; the account created through the form; the landing on Apply at the goal step. */
export async function signUpThroughDoor(page: Page, base: string, email: string, password: string, o: DriveOptions = {}): Promise<void> {
  await page.goto(`${base}/app`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector(`${ROOT}[data-door="welcome"]`, { timeout: 60_000 });
  await page.locator('[data-testid="apply-continue"]').first().click();
  await page.waitForSelector(`${ROOT}[data-door="intro"]`, { timeout: 30_000 });
  await page.locator('[data-testid="apply-continue"]').first().click();   // "Create an account"
  await page.waitForSelector('[data-testid="account"][data-mode="sign_up"] [data-testid="account-form"]', { timeout: 30_000 });
  await page.locator('[data-testid="account-form"] input[type="email"]').fill(email);
  await page.locator('[data-testid="account-form"] input[type="password"]').fill(password);
  await page.locator('[data-testid="account-form"] button[type="submit"]').first().click();
  try { await page.waitForSelector(`${ROOT}[data-tab="apply"][data-step="goal"]`, { timeout: o.stepTimeoutMs ?? 90_000 }); }
  catch { throw new ScreenError("sign up", `the account did not land on the goal step: account-error=${JSON.stringify((await page.locator('[data-testid="account-error"]').allInnerTexts().catch(() => [])).join(" | "))} apply-error=${JSON.stringify(await errorText(page))} door=${await attr(page, "data-door")}`); }
  o.log?.(`account ${email} landed on Apply`);
}

/** The goal screen: Buy a home / Refinance my home (+ the refinance purpose), the occupancy; Continue → property. */
export async function goal(page: Page, intent: "buy" | "refi", occupancy: "My primary home" | "A second home" | "An investment property", purpose: "Lower payment" | "Pay off sooner" | "Take cash out" | null, o: DriveOptions = {}): Promise<StepRecord> {
  await waitForStep(page, "goal", "goal", o);
  await page.getByRole("button", { name: intent === "buy" ? "Buy a home" : "Refinance my home" }).first().click();
  if (purpose) await page.getByRole("button", { name: purpose }).first().click();
  await page.getByRole("button", { name: occupancy }).first().click();
  return continueTo(page, "property", "goal", o);
}

export type PropertyPlan =
  | { kind: "address"; address: string; state: string; price: string; down: string }
  | { kind: "shopping"; state: string; low: string; high: string; down: string; firstTime: "Yes" | "No" }
  | { kind: "refi"; address: string; state: string; worth: string; balance: string; cashOut?: string; /** DELTA-37: what the cash is for, by its option label (`apply.property.cash_out_purpose`); only on a cash-out */ cashOutPurpose?: string };

/** The property screen for the three branches (docs/ux/18 §2.2–2.4): the fields, the goal card's consents statement above Continue, Continue → you. */
export async function property(page: Page, plan: PropertyPlan, o: DriveOptions = {}): Promise<StepRecord & { consents: string; shoppingSwitch: number }> {
  await waitForStep(page, "property", "property", o);
  const shoppingSwitch = await page.locator('[data-testid="apply-property-switch"]').count();
  if (plan.kind === "shopping") {
    await page.getByRole("button", { name: "Still looking" }).first().click();
    await fill(page, "State", plan.state); await fill(page, "Price range — low", plan.low); await fill(page, "Price range — high", plan.high); await fill(page, "Down payment", plan.down); await pick(page, "First-time buyer?", plan.firstTime);
  } else {
    await fill(page, "Property address", plan.address); await fill(page, "State", plan.state);
    if (plan.kind === "address") { await fill(page, "Price", plan.price); await fill(page, "Down payment", plan.down); }
    else { await fill(page, "About what is it worth?", plan.worth); await fill(page, "Current balance", plan.balance); if (plan.cashOut !== undefined) await fill(page, "Cash out", plan.cashOut); if (plan.cashOutPurpose !== undefined) await pick(page, "What the cash is for", plan.cashOutPurpose); }
    await pick(page, "Do you own the land, or is it a leasehold?", "I own the land"); await pick(page, "Is there a PACE or clean-energy loan on the home?", "No");
  }
  const consentsEl = page.locator('[data-testid="apply-consents"]').first();
  await consentsEl.waitFor({ timeout: o.stepTimeoutMs ?? 90_000 }).catch(() => { throw new ScreenError("property", `the goal card's consents statement never rendered (error ${JSON.stringify("")})`); });
  const consents = (await consentsEl.innerText()).trim();
  const r = await continueTo(page, "you", "property", o);
  return { ...r, consents, shoppingSwitch };
}

/** The You screen: the name, the birth date, the SSN, "I live here as" Own, the months; Continue → connect. */
export async function you(page: Page, who: { name: string; dob: string; ssn: string; months: string }, o: DriveOptions = {}): Promise<StepRecord> {
  await waitForStep(page, "you", "you", o);
  await fill(page, "Legal name", who.name); await fill(page, "Date of birth", who.dob); await fill(page, "Social Security number", who.ssn);
  await page.getByRole("button", { name: /^Own$/ }).first().click();
  await fill(page, "Months at this address", who.months);
  return continueTo(page, "connect", "you", o);
}

/** The Connect screen: the monthly income and the employer; "Connect and continue" → details (the FAKE vendors finish on the tap). */
export async function connect(page: Page, income: string, employer: string, o: DriveOptions = {}): Promise<StepRecord> {
  await waitForStep(page, "connect", "connect", o);
  await fill(page, "Monthly income", income); await fill(page, "Employer", employer);
  return continueTo(page, "details", "connect", o);
}

/** The Details screen with the five facts; Continue → questions. */
export async function details(page: Page, o: DriveOptions = {}): Promise<StepRecord> {
  await waitForStep(page, "details", "details", o);
  await pick(page, "Citizenship", "U.S. citizen"); await pick(page, "Marital status", "Unmarried"); await fill(page, "Dependents", "0"); await pick(page, "Military service", "No"); await pick(page, "Language preference", "English");
  return continueTo(page, "questions", "details", o);
}

/** A card hosted in the chrome (`.sm-card-host[data-copy-key]`), waited for; `notId` skips the one just tapped. */
export async function hostedCard(page: Page, copyKey: string, o: DriveOptions = {}, notId?: string): Promise<{ host: Locator; id: string }> {
  const sel = `${ROOT} .sm-card-host[data-copy-key="${copyKey}"]${notId ? `:not([data-testid="apply-card-${notId}"])` : ""}`;
  try { await page.waitForSelector(sel, { timeout: o.stepTimeoutMs ?? 90_000 }); }
  catch { throw new ScreenError(`card ${copyKey}`, `never rendered (error ${JSON.stringify(await errorText(page))}; step ${await attr(page, "data-step")})`); }
  const host = page.locator(sel).first();
  return { host, id: ((await host.getAttribute("data-testid")) ?? "").replace(/^apply-card-/, "") };
}
export async function tapCard(page: Page, copyKey: string, option: RegExp, o: DriveOptions = {}, notId?: string): Promise<string> {
  const { host, id } = await hostedCard(page, copyKey, o, notId);
  await host.getByRole("button", { name: option }).first().click();
  o.log?.(`tapped ${copyKey}`);
  return id;
}

/** Questions, "None": 5a.A, 5a.E and the list — one card at a time — then the step moves on to Demographics. */
export async function declarationsNone(page: Page, o: DriveOptions = {}): Promise<StepRecord> {
  await waitForStep(page, "questions", "questions", o);
  await tapCard(page, "declarations.occupancy", /^Yes, and I haven't owned another home in the past three years$/, o);
  await tapCard(page, "declarations.clean_energy_lien", /^No$/, o);
  await tapCard(page, "declarations.title", /^None of these apply to me$/, o);
  await waitForStep(page, "demographics", "questions", o);
  const error = await errorText(page); if (error) throw new ScreenError("questions", `reached demographics with an error line: ${JSON.stringify(error)}`);
  o.log?.("questions → demographics");
  return { step: "demographics", error };
}

/** Demographics: the DemographicsCard in the chrome, every group declined, Save → Review. */
export async function demographicsDecline(page: Page, o: DriveOptions = {}): Promise<StepRecord> {
  await waitForStep(page, "demographics", "demographics", o);
  const { host } = await hostedCard(page, "demographics.title", o);
  for (const g of ["Ethnicity", "Race", "Sex"]) await host.locator(`fieldset:has(legend:text-is("${g}")) label:text-is("I do not wish to provide") input`).first().check();
  await host.getByRole("button", { name: /^Save$/ }).first().click();
  await waitForStep(page, "review", "demographics", o);
  const error = await errorText(page); if (error) throw new ScreenError("demographics", `reached review with an error line: ${JSON.stringify(error)}`);
  o.log?.("demographics → review");
  return { step: "review", error };
}

/** Review's one CTA — "Confirm these numbers" — then Result. */
export async function confirmNumbers(page: Page, o: DriveOptions = {}): Promise<StepRecord & { cta: string }> {
  await waitForStep(page, "review", "review", o);
  try { await page.waitForSelector('[data-testid="apply-continue"][data-copy-key="apply.review.confirm"]', { timeout: o.stepTimeoutMs ?? 90_000 }); }
  catch { throw new ScreenError("review", `the number cards never arrived (error ${JSON.stringify(await errorText(page))})`); }
  const cta = (await page.locator('[data-testid="apply-continue"]').first().innerText()).trim();
  const r = await continueTo(page, "result", "review", o);
  return { ...r, cta };
}

/** Poll the badge on the screen until it matches (Result re-reads the file on its own interval). */
export async function waitForBadge(page: Page, re: RegExp, timeoutMs: number): Promise<string> {
  const started = Date.now(); let last = "";
  while (Date.now() - started < timeoutMs) { last = await badgeText(page); if (re.test(last)) return last; await page.waitForTimeout(1000); }
  return last;
}

/** The whole application from the goal to Review, recording each step reached: the three branches share You → Connect → Details → Questions → Demographics. */
export async function driveToReview(page: Page, plan: { intent: "buy" | "refi"; purpose: "Lower payment" | "Pay off sooner" | "Take cash out" | null; property: PropertyPlan; who: { name: string; dob: string; ssn: string; months: string }; income: string; employer: string }, o: DriveOptions = {}): Promise<{ steps: StepRecord[]; consents: string; shoppingSwitch: number }> {
  const steps: StepRecord[] = [];
  steps.push(await goal(page, plan.intent, "My primary home", plan.purpose, o));
  const p = await property(page, plan.property, o); steps.push({ step: p.step, error: p.error });
  steps.push(await you(page, plan.who, o));
  steps.push(await connect(page, plan.income, plan.employer, o));
  steps.push(await details(page, o));
  steps.push(await declarationsNone(page, o));
  steps.push(await demographicsDecline(page, o));
  return { steps, consents: p.consents, shoppingSwitch: p.shoppingSwitch };
}
