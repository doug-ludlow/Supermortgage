/**
 * 32.14 S0–S2 — what the visitor SEES in the anonymous minute (the API facts — the lead row, the events, the
 * gate order — are asserted in src/domain/borrower/32-14.spec.test.ts). The lead client is mocked: every step,
 * the state-closed path, the checklist-refused path, the disclosure first with its marker, no float arithmetic
 * on money, every rendered sentence a copy key.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnonymousMinute, parseMoneyToCents, productLabel, US_STATES } from "@/components/entry";
import { ApiRequestError } from "@/lib/api/client";
import { leadAnswer, leadRange, leadStart, referralFromSearch, type LeadAnswerResponse, type LeadLine, type LeadRangeResponse, type LeadStartResponse, type LeadStep } from "@/lib/api/lead";
import { copy, copyOptions } from "@/lib/copy";

vi.mock("@/lib/api/lead", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/api/lead")>();
  return { ...mod, leadStart: vi.fn(), leadState: vi.fn(), leadAnswer: vi.fn(), leadRange: vi.fn() };
});

const user = userEvent.setup();
const PARTNER = { legal_name: "Partner Bank", nmlsr_id: "123456" };
const disclosure: LeadLine = { message_id: "m-1", at: "2026-10-19T14:00:00.000Z", sender: "agent", automation_marker: true, copy_key: "entry.disclosure.first" };
const goalStep: LeadStep = { id: "goal", kind: "ChoiceCard", copy_key: "entry.goal.question", options: [{ id: "buy" }, { id: "lower_rate" }, { id: "cash_out" }] };
const contractStep: LeadStep = { id: "contract", kind: "ChoiceCard", copy_key: "entry.buy.contract_question", options: [{ id: "signed" }, { id: "looking" }] };
const occupancyStep: LeadStep = { id: "occupancy", kind: "ChoiceCard", copy_key: "entry.occupancy.question", options: [{ id: "primary" }, { id: "second_home" }, { id: "investment" }] };
const stateStep: LeadStep = { id: "state", kind: "ChoiceCard", copy_key: "entry.state.question" };
const estimateStep: LeadStep = { id: "estimate", kind: "ConfirmCard", copy_key: "entry.estimate.value" };
const identify: LeadStep = { id: "identify", kind: "ChoiceCard", copy_key: "auth.choose_method" };
const startRes: LeadStartResponse = { lead_id: "lead-1", partner: PARTNER, lines: [disclosure], step: goalStep };
const answer = (step: LeadStep | null, lines: LeadLine[] = [], extra: Partial<LeadAnswerResponse> = {}): LeadAnswerResponse => ({ lead_id: "lead-1", lines, step, ...extra });
const RANGE = { low_pct: "6.125", high_pct: "6.875", apr_low_pct: "6.240", apr_high_pct: "6.990", product_code: "FRM30", rate_sheet_id: "rs-2026-10-19" };
const rangeTokens = { product: "30-year fixed", rate_low: "6.125%", apr_low: "6.240%", rate_high: "6.875%", apr_high: "6.990%", "partner.legal_name": PARTNER.legal_name, "partner.nmlsr_id": PARTNER.nmlsr_id };
const checkedSentence = copy("entry.range.card", rangeTokens);
const footer = copy("entry.range.disclaimer", rangeTokens);
const rangeRes = (text: string): LeadRangeResponse => ({ range: { ...RANGE, text }, card: { kind: "StatusCard", copy_key: "entry.range.card", personal_terms: false }, promise_copy_key: "entry.range.promise", disclaimer_copy_key: "entry.range.disclaimer", next: identify });
const refusedRes: LeadRangeResponse = { range: null, refused: "RANGE_CONTENT_CHECK", next: identify };

const mocks = () => ({ start: vi.mocked(leadStart), answer: vi.mocked(leadAnswer), range: vi.mocked(leadRange) });

beforeEach(() => {
  vi.mocked(leadStart).mockReset();
  vi.mocked(leadAnswer).mockReset();
  vi.mocked(leadRange).mockReset();
  vi.mocked(leadStart).mockResolvedValue(startRes);
});

/** Drive goal → occupancy(primary) → state → estimate (refinance) with the given per-step responses. */
async function toEstimate(stateLines: LeadLine[] = []) {
  const m = mocks();
  m.answer.mockResolvedValueOnce(answer(occupancyStep)).mockResolvedValueOnce(answer(stateStep)).mockResolvedValueOnce(answer(estimateStep, stateLines));
  await user.click(await screen.findByRole("button", { name: "Lower my rate or payment" }));
  await user.click(await screen.findByRole("button", { name: "Primary home" }));
  await user.selectOptions(await screen.findByTestId("entry-state-select"), "AZ");
  await user.click(screen.getByTestId("entry-state-continue"));
  await screen.findByTestId("lead-estimate-value_estimate_cents");
  return m;
}

describe("32.14 S0 — arrive: the root renders the thread with no session (T-15-01, T-15-05)", () => {
  it("posts lead.start on mount and renders the disclosure line FIRST with the automation marker, then the headline, the three goal tiles and the quiet time-budget line", async () => {
    render(<AnonymousMinute />);
    const goal = await screen.findByTestId("entry-goal");
    expect(mocks().start).toHaveBeenCalledTimes(1);
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("data-step", "goal");
    expect(log).toHaveAttribute("data-lead-id", "lead-1");
    // the first thing in the log is the disclosure, the library sentence with the partner's name, marked automated
    const first = log.firstElementChild?.matches("style") ? log.children[1]! : log.firstElementChild!;
    expect(first).toHaveAttribute("data-testid", "lead-line");
    expect(first).toHaveAttribute("data-copy-key", "entry.disclosure.first");
    expect(first).toHaveTextContent(copy("entry.disclosure.first", { "partner.legal_name": "Partner Bank" }));
    expect(within(first as HTMLElement).getByTestId("automation-marker")).toHaveTextContent("automated");
    expect(first.compareDocumentPosition(goal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // headline above the goal card, time budget under it — both library lines
    expect(screen.getByTestId("entry-headline")).toHaveTextContent(copy("entry.landing.headline"));
    expect(screen.getByTestId("entry-time-budget")).toHaveTextContent(copy("entry.landing.time_budget"));
    const card = goal.querySelector('article[data-card-kind="ChoiceCard"]')!;
    expect(card.compareDocumentPosition(screen.getByTestId("entry-time-budget")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // exactly buy · lower_rate · cash_out, labelled from entry.goal.question's options, nothing pressed
    const tiles = within(card as HTMLElement).getAllByRole("button", { pressed: false });
    expect(tiles.map((b) => b.textContent)).toEqual([...copyOptions("entry.goal.question")]);
    expect(copyOptions("entry.goal.question")).toEqual(["Buy a home", "Lower my rate or payment", "Take cash out"]);
    expect(within(card as HTMLElement).queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(screen.queryByTestId("identity-ask")).not.toBeInTheDocument();
  });

  it("passes ?ref= and utm_* from the landing URL to lead.start and nothing else", () => {
    expect(referralFromSearch("?ref=broker-7&utm_source=zillow&utm_campaign=fall&other=1")).toEqual({ referral: "broker-7", utm: { source: "zillow", campaign: "fall" } });
    expect(referralFromSearch("")).toEqual({});
  });

  it("a failed start renders the error copy (never a hard-coded sentence) and no step", async () => {
    mocks().start.mockRejectedValueOnce(new Error("network"));
    render(<AnonymousMinute />);
    expect(await screen.findByTestId("entry-error")).toHaveTextContent(copy("error.generic"));
    expect(screen.queryByTestId("entry-goal")).not.toBeInTheDocument();
  });
});

describe("32.14 S1 — the chips (T-15-05)", () => {
  it("Buy asks contract status (two chips, none tapped for you); the tap posts {step, value}", async () => {
    const m = mocks();
    m.answer.mockResolvedValueOnce(answer(contractStep));
    render(<AnonymousMinute />);
    await user.click(await screen.findByRole("button", { name: "Buy a home" }));
    expect(m.answer).toHaveBeenCalledWith("goal", "buy");
    const contract = await screen.findByText(copy("entry.buy.contract_question"));
    const card = contract.closest("article")!;
    const chips = within(card).getAllByRole("button", { pressed: false });
    expect(chips.map((b) => b.textContent)).toEqual([...copyOptions("entry.buy.contract_question")]);
    expect(within(card).queryAllByRole("button", { pressed: true })).toHaveLength(0);
    // the goal card collapsed to its receipt
    expect(screen.getByTestId("card-receipt")).toHaveTextContent("Buy a home");
    expect(screen.getByRole("log")).toHaveAttribute("data-step", "contract");
  });

  it("Lower my rate and Take cash out ask occupancy with no default tapped; primary is only highlighted", async () => {
    const m = mocks();
    m.answer.mockResolvedValueOnce(answer(occupancyStep));
    render(<AnonymousMinute />);
    await user.click(await screen.findByRole("button", { name: "Take cash out" }));
    expect(m.answer).toHaveBeenCalledWith("goal", "cash_out");
    const card = (await screen.findByText(copy("entry.occupancy.question"))).closest("article")!;
    const chips = within(card).getAllByRole("button");
    expect(chips.map((b) => b.textContent)).toEqual(["Primary home", "Second home", "Investment property"]);
    expect(chips.every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(chips[0]).toHaveClass("sm-btn-primary");
    await user.click(chips[2]!);
    expect(m.answer).toHaveBeenLastCalledWith("occupancy", "investment");
  });

  it("the state is a select of the 50 states + DC that needs an explicit Continue; the answer is the USPS code and the response lines render before the next chip (UT/CA variant, CO notice — T-15-02)", async () => {
    const m = mocks();
    const variant: LeadLine = { message_id: "m-2", at: "2026-10-19T14:01:00.000Z", sender: "agent", automation_marker: true, copy_key: "entry.disclosure.first", state_variant: "UT" };
    const coNotice: LeadLine = { message_id: "m-3", at: "2026-10-19T14:01:01.000Z", sender: "agent", copy_key: "entry.disclosure.co_admt" };
    m.answer.mockResolvedValueOnce(answer(occupancyStep)).mockResolvedValueOnce(answer(stateStep)).mockResolvedValueOnce(answer(estimateStep, [variant, coNotice]));
    render(<AnonymousMinute />);
    await user.click(await screen.findByRole("button", { name: "Lower my rate or payment" }));
    await user.click(await screen.findByRole("button", { name: "Primary home" }));
    const select = await screen.findByTestId("entry-state-select");
    expect(select).toHaveClass("sm-select");
    expect(select).toHaveAccessibleName(copy("entry.state.question"));
    expect(within(select as HTMLSelectElement).getAllByRole("option").map((o) => (o as HTMLOptionElement).value).filter(Boolean)).toHaveLength(51);
    expect(US_STATES.map((s) => s.code)).toContain("DC");
    const go = screen.getByTestId("entry-state-continue");
    expect(go).toBeDisabled();
    await user.selectOptions(select, "UT");
    expect(go).toBeEnabled();
    await user.click(go);
    expect(m.answer).toHaveBeenLastCalledWith("state", "UT");
    const estimate = await screen.findByTestId("lead-estimate-value_estimate_cents");
    const lines = screen.getAllByTestId("lead-line");
    expect(lines.map((l) => l.getAttribute("data-copy-key"))).toEqual(["entry.disclosure.first", "entry.disclosure.first", "entry.disclosure.co_admt"]);
    expect(lines[1]).toHaveAttribute("data-state-variant", "UT");
    expect(lines[2]).toHaveTextContent(copy("entry.disclosure.co_admt"));
    expect(lines[2]!.compareDocumentPosition(estimate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("card-receipt").at(-1)).toHaveTextContent("Utah");
  });

  it("a closed state (NY) renders lead.state_closed and nothing else — no range request, no identity ask (T-15-03)", async () => {
    const m = mocks();
    m.answer.mockResolvedValueOnce(answer(occupancyStep)).mockResolvedValueOnce(answer(stateStep)).mockResolvedValueOnce(answer(null, [], { closed: { reason: "state_not_licensed", copy_key: "lead.state_closed" } }));
    render(<AnonymousMinute renderIdentity={() => <div data-testid="sign-in">SignIn</div>} />);
    await user.click(await screen.findByRole("button", { name: "Lower my rate or payment" }));
    await user.click(await screen.findByRole("button", { name: "Primary home" }));
    await user.selectOptions(await screen.findByTestId("entry-state-select"), "NY");
    await user.click(screen.getByTestId("entry-state-continue"));
    const closed = await screen.findByText(copy("lead.state_closed", { state: "New York" }));
    expect(closed.closest("[data-copy-key]")).toHaveAttribute("data-copy-key", "lead.state_closed");
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("data-closed", "state_not_licensed");
    expect(log).toHaveAttribute("data-step", "closed");
    expect(m.range).not.toHaveBeenCalled();
    expect(screen.queryByTestId("range-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("identity-ask")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sign-in")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lead-estimate-value_estimate_cents")).not.toBeInTheDocument();
  });

  it("a refusal (409 L0_FACTS_ONLY) renders its copy key and leaves the chip pending (T-15-06 as seen)", async () => {
    const m = mocks();
    m.answer.mockRejectedValueOnce(new ApiRequestError(409, { code: "L0_FACTS_ONLY", gate: "L0_FACTS_ONLY", copy_key: "error.generic" }));
    render(<AnonymousMinute />);
    await user.click(await screen.findByRole("button", { name: "Buy a home" }));
    expect(await screen.findByTestId("entry-error")).toHaveTextContent(copy("error.generic"));
    expect(screen.getByRole("button", { name: "Buy a home" })).toBeEnabled();
    expect(screen.getByRole("log")).toHaveAttribute("data-step", "goal");
  });
});

describe("32.14 S1 — the estimate: money fields produce cents strings, no float arithmetic (T-X-09)", () => {
  it("parseMoneyToCents is integer-only and exact beyond float precision", () => {
    expect(parseMoneyToCents("$300,000")).toBe("30000000");
    expect(parseMoneyToCents("300000")).toBe("30000000");
    expect(parseMoneyToCents("1,250.5")).toBe("125050");
    expect(parseMoneyToCents("$0.99")).toBe("99");
    expect(parseMoneyToCents(".5")).toBe("50");
    expect(parseMoneyToCents("0.10")).toBe("10");
    expect(parseMoneyToCents("12.345")).toBe("1234"); // truncated, never rounded through a float
    expect(parseMoneyToCents("$12,345,678,901,234,567.89")).toBe("1234567890123456789");
    expect(parseMoneyToCents("000123")).toBe("12300");
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("$")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("1.2.3")).toBeNull();
  });

  it("refinance/cash-out asks value and balance; Continue waits for both; the answer carries value_estimate_cents and stated_existing_balance_cents as strings", async () => {
    render(<AnonymousMinute />);
    const m = await toEstimate();
    const value = screen.getByTestId("lead-estimate-value_estimate_cents");
    const balance = screen.getByTestId("lead-estimate-stated_existing_balance_cents");
    expect(value).toHaveClass("sm-input");
    expect(value).toHaveAccessibleName(copy("entry.estimate.value"));
    expect(balance).toHaveAccessibleName(copy("entry.estimate.balance"));
    expect(screen.queryByTestId("lead-estimate-price_range_cents")).not.toBeInTheDocument();
    const go = screen.getByTestId("entry-estimate-continue");
    expect(go).toBeDisabled();
    await user.type(value, "$300,000");
    expect(go).toBeDisabled();
    await user.type(balance, "200,000.50");
    await user.tab(); // blur normalizes the display through formatMoney (a decimal string, no Number())
    expect(balance).toHaveValue("$200,000.50");
    expect(go).toBeEnabled();
    m.answer.mockResolvedValueOnce(answer(null));
    m.range.mockResolvedValueOnce(refusedRes);
    await user.click(go);
    expect(m.answer).toHaveBeenLastCalledWith("estimate", { value_estimate_cents: "30000000", stated_existing_balance_cents: "20000050" });
    const sent = m.answer.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(Object.values(sent).every((v) => typeof v === "string")).toBe(true);
    expect((await screen.findAllByTestId("card-receipt")).at(-1)).toHaveTextContent("$300,000 · $200,000.50");
  });

  it("purchase asks price range and down payment and posts price_range_cents / down_payment_cents", async () => {
    const m = mocks();
    m.answer.mockResolvedValueOnce(answer(contractStep)).mockResolvedValueOnce(answer(stateStep)).mockResolvedValueOnce(answer(estimateStep));
    render(<AnonymousMinute />);
    await user.click(await screen.findByRole("button", { name: "Buy a home" }));
    await user.click(await screen.findByRole("button", { name: "Still looking" }));
    await user.selectOptions(await screen.findByTestId("entry-state-select"), "AZ");
    await user.click(screen.getByTestId("entry-state-continue"));
    const price = await screen.findByTestId("lead-estimate-price_range_cents");
    expect(price).toHaveAccessibleName(copy("entry.estimate.price_range"));
    await user.type(price, "525000");
    await user.type(screen.getByTestId("lead-estimate-down_payment_cents"), "105,000");
    m.answer.mockResolvedValueOnce(answer(null));
    m.range.mockResolvedValueOnce(rangeRes(checkedSentence));
    await user.click(screen.getByTestId("entry-estimate-continue"));
    expect(m.answer).toHaveBeenLastCalledWith("estimate", { price_range_cents: "52500000", down_payment_cents: "10500000" });
    await screen.findByTestId("range-card");
  });
});

describe("32.14 S2 — the give-back: a published range, then the identity ask (T-15-04)", () => {
  it("after the estimate, lead.requestRange renders the checked sentence verbatim (APR beside each rate), the not-a-commitment footer once, the promise line, then the identity slot", async () => {
    render(<AnonymousMinute renderIdentity={() => <div data-testid="sign-in">SignIn</div>} />);
    const m = await toEstimate();
    await user.type(screen.getByTestId("lead-estimate-value_estimate_cents"), "400000");
    await user.type(screen.getByTestId("lead-estimate-stated_existing_balance_cents"), "250000");
    m.answer.mockResolvedValueOnce(answer(null));
    m.range.mockResolvedValueOnce(rangeRes(`${checkedSentence} ${footer}`));
    await user.click(screen.getByTestId("entry-estimate-continue"));
    const card = await screen.findByTestId("range-card");
    expect(m.range).toHaveBeenCalledTimes(1);
    const article = card.querySelector('article[data-card-kind="StatusCard"]')!;
    expect(article).toHaveAttribute("data-card-id", "lead-range");
    expect(card).toHaveAttribute("data-personal-terms", "false");
    expect(card).toHaveAttribute("data-low", "6.125");
    expect(card).toHaveAttribute("data-apr-high", "6.990");
    expect(card).toHaveAttribute("data-product", "FRM30");
    expect(card).toHaveAttribute("data-rate-sheet", "rs-2026-10-19");
    // the sentence the checklist passed is what is shown, with an APR beside each rate
    expect(article).toHaveTextContent("6.125% (6.240% APR) to 6.875% (6.990% APR)");
    expect(article).toHaveTextContent("30-year fixed");
    expect(article.textContent!.match(/Not a commitment to lend/g)).toHaveLength(1);
    expect(article).toHaveTextContent("Partner Bank, NMLSR ID 123456");
    // no tier, LLPA or borrower figure
    expect(article.textContent).not.toMatch(/tier|LLPA|\$/i);
    // the promise line, then the identity ask
    const promise = screen.getByTestId("range-promise");
    expect(promise).toHaveTextContent(copy("entry.range.promise"));
    const ask = screen.getByTestId("identity-ask");
    expect(ask).toHaveAttribute("data-copy-key", "auth.choose_method");
    expect(within(ask).getByTestId("sign-in")).toBeInTheDocument();
    expect(card.compareDocumentPosition(promise) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(promise.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("log")).toHaveAttribute("data-step", "identify");
  });

  it("when the server's sentence lacks the footer, entry.range.disclaimer is appended from the library with the partner tokens; with no sentence at all the library line renders from the sheet's strings", async () => {
    const m = mocks();
    m.start.mockResolvedValueOnce({ ...startRes, step: null });
    m.range.mockResolvedValueOnce(rangeRes(checkedSentence));
    const { unmount } = render(<AnonymousMinute />);
    let card = await screen.findByTestId("range-card");
    expect(card.querySelector("article")!.textContent!.match(/Not a commitment to lend/g)).toHaveLength(1);
    expect(within(card).getByTestId("status-detail")).toHaveTextContent(footer);
    unmount();
    m.start.mockResolvedValueOnce({ ...startRes, step: null });
    m.range.mockResolvedValueOnce(rangeRes(""));
    render(<AnonymousMinute />);
    card = await screen.findByTestId("range-card");
    expect(card.querySelector("h3")).toHaveTextContent(checkedSentence);
    expect(checkedSentence).toContain("6.125% (6.240% APR)");
    expect(productLabel("FRM15")).toBe("15-year fixed");
    expect(productLabel("ARM5")).toBe("Adjustable (ARM)");
    expect(productLabel("X")).toBe("X");
  });

  it("a failing 20.2 checklist (RANGE_CONTENT_CHECK) shows no number and the identity ask still renders", async () => {
    render(<AnonymousMinute renderIdentity={() => <div data-testid="sign-in">SignIn</div>} />);
    const m = await toEstimate();
    await user.type(screen.getByTestId("lead-estimate-value_estimate_cents"), "400000");
    await user.type(screen.getByTestId("lead-estimate-stated_existing_balance_cents"), "250000");
    m.answer.mockResolvedValueOnce(answer(null));
    m.range.mockResolvedValueOnce(refusedRes);
    await user.click(screen.getByTestId("entry-estimate-continue"));
    const ask = await screen.findByTestId("identity-ask");
    expect(within(ask).getByTestId("sign-in")).toBeInTheDocument();
    expect(screen.queryByTestId("range-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("range-promise")).not.toBeInTheDocument();
    expect(screen.getByTestId("range-refused")).toHaveAttribute("data-refused", "RANGE_CONTENT_CHECK");
    expect(screen.getByRole("log").textContent).not.toMatch(/%/);
  });

  it("a range refusal (409 STATE_GATE_FIRST) renders its copy and no identity ask", async () => {
    render(<AnonymousMinute renderIdentity={() => <div data-testid="sign-in">SignIn</div>} />);
    const m = await toEstimate();
    await user.type(screen.getByTestId("lead-estimate-value_estimate_cents"), "400000");
    await user.type(screen.getByTestId("lead-estimate-stated_existing_balance_cents"), "250000");
    m.answer.mockResolvedValueOnce(answer(null));
    m.range.mockRejectedValueOnce(new ApiRequestError(409, { code: "STATE_GATE_FIRST", copy_key: "error.generic" }));
    await user.click(screen.getByTestId("entry-estimate-continue"));
    expect(await screen.findByTestId("entry-error")).toHaveTextContent(copy("error.generic"));
    expect(screen.queryByTestId("identity-ask")).not.toBeInTheDocument();
  });

  it("a return visit whose lead already shows a range renders it from the state (no second range request) and the identity ask", async () => {
    const m = mocks();
    m.start.mockResolvedValueOnce({ ...startRes, step: identify, range: { ...RANGE, text: checkedSentence } });
    render(<AnonymousMinute renderIdentity={() => <div data-testid="sign-in">SignIn</div>} />);
    await screen.findByTestId("range-card");
    expect(screen.getByTestId("identity-ask")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "false"));
    expect(m.range).not.toHaveBeenCalled();
    expect(m.answer).not.toHaveBeenCalled();
  });
});
