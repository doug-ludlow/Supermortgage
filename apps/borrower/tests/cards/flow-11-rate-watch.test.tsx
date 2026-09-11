/**
 * 32.11 — what the borrower SEES for rate-watch and the re-refinance loop (the API facts are asserted in
 * src/domain/borrower/32-11.spec.test.ts): the OfferCard with every §2 field, the LE-style payment statement and the
 * no-cost line, the MLO attribution, the expiry the Timer Engine computed and no "guarantee" (T3); Not now / Never
 * receipts (T4, T5); the Loan section's Rate-watch block — passive until an opportunity exists, the open offer, the
 * refinance in progress — and the standing connections of DELTA-05 (T5, T9); the funded StatusCard with the autopay
 * token named by copy key and the escrow line (T7); no cancel window when 25.3 says not_applicable (T8); and the copy
 * string tests — no investor reference, no future-terms promise, no "guarantee" (T10).
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/cards";
import { DatesSection, LoanSection, StatusSection } from "@/components/record/sections";
import { offerLines, rateWatchDetailRows, rateWatchStateKey, standingConnectionsRow, withTokenKeys } from "@/components/flows/11-rate-watch";
import { COPY, copy, copyOptions, FORBIDDEN_WORDS, type CopyEntry } from "@/lib/copy";
import type { OfferCardProps } from "@/lib/types/cards";
import type { BorrowerRecord } from "@/lib/types/record";
import { makeCard, resolver, TZ } from "./helpers";
import servicing from "@/fixtures/servicing.json";

const base = servicing.record as unknown as BorrowerRecord;
const noop = () => {};
const NO_INVESTOR = /\b(fannie|freddie|fnma|fhlmc|investor|owns your loan|mbs|pool|gse|ginnie)\b/i;
const NO_FUTURE_TERMS = /\b(guarantee[ds]?|guaranteeing|promise[sd]?|we will (always|automatically)|automatically (lower|drop|refinance)|locked (in )?for life|self-improving|pre-?approved|next time your rate|whenever rates drop we will)\b/i;

/** The OfferCard the flow sends (src/runtime/borrower/flows/11-rate-watch.ts `offerCardProps`): every figure the owning rows' own. */
const OFFER: OfferCardProps = {
  refi_opportunity_id: "opp-1", current_rate: "6.125", offered_rate: "5.625", apr: "5.702", term_months: 360,
  new_pi_payment_cents: "322377", monthly_savings_cents: "17885", costs_to_borrower_cents: "0",
  lender_legal_name: "Desert Ridge Bank", lender_nmlsr_id: "123456", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654",
  expires_at: "2027-04-18T13:41:00.000Z", expiry_timer_code: "SM_REFI_OPPORTUNITY_EXPIRY_30", path: "proactive",
  not_a_commitment_text: "This is not a commitment to lend;", rates_change_daily_text: "rates change daily.",
};

describe("32.11 OfferCard (T3)", () => {
  it("renders every §2 field — both rates and the APR, the payment statement, the savings, the no-cost line, the lender, the MLO attribution, the expiry — and no guarantee", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("OfferCard", OFFER, { copy_key: "offer.card", card_instance_id: "c-offer", subject: { loan_id: "loan-1" } })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: "Lower your rate to 5.625%" })).toBeInTheDocument();
    expect(screen.getByText("Your rate now").nextElementSibling).toHaveTextContent("6.125%");
    expect(screen.getByText("Offered rate · APR 5.702%").nextElementSibling).toHaveTextContent("5.625%");
    expect(screen.getByText("New principal & interest").nextElementSibling).toHaveTextContent("$3,223.77/mo");
    expect(screen.getByText("Monthly savings").nextElementSibling).toHaveTextContent("$178.85/mo");
    expect(screen.getByText("Costs to you").nextElementSibling).toHaveTextContent("$0.00");
    // the Timer Engine's due_at, rendered in the borrower's zone — never computed here
    expect(screen.getByText("Offer good through").nextElementSibling?.querySelector("time")?.getAttribute("dateTime")).toBe("2027-04-18T13:41:00.000Z");
    expect(screen.getByText("Offer good through").nextElementSibling).toHaveTextContent("Apr 18, 2027");
    // the §2 statements from the library (20.2's LE-style payment statement; the program-default no-cost line)
    const lines = screen.getAllByTestId("offer-line").map((l) => l.textContent);
    expect(lines).toEqual([
      "360 monthly principal-and-interest payments of $3,223.77; payments do not include taxes and insurance, so your actual payment will be higher",
      "No lender fees and no third-party closing costs charged to you — Supermortgage pays them and they're reflected in the rate",
    ]);
    // the footer: not a commitment, the lender, the MLO of record's attribution (personalized terms always name them)
    const footer = document.querySelector(".sm-card-footer")!;
    expect(footer).toHaveTextContent("This is not a commitment to lend; rates change daily. Desert Ridge Bank. Jordan Rivera, NMLSR ID 987654.");
    // the three options, in the library's words
    const group = screen.getByRole("group", { name: "Your answer" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([...copyOptions("offer.card")]);
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Yes, let's do it", "Not now", "Never"]);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/guarantee/i);
    expect(text).not.toMatch(NO_INVESTOR);
  });
  it("a program that charges shows the amount instead of the no-cost line", () => {
    expect(offerLines({ ...OFFER, costs_to_borrower_cents: "125000" })[1]).toBe("Costs charged to you: $1,250.00");
    expect(offerLines({ ...OFFER, term_months: undefined })[0]).toMatch(/^360 monthly principal-and-interest payments/);
  });
});

describe("32.11 Not now / Never (T4, T5)", () => {
  it("Not now resolves with decision not_now and the receipt says the 90-day quiet; Never says exactly what stops and what continues", () => {
    const { onResolve, calls } = resolver();
    render(<Card card={makeCard("OfferCard", OFFER, { copy_key: "offer.card", card_instance_id: "c-offer" })} timezone={TZ} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.option_id).toBe("not_now");
    expect((calls[0]?.evidence as { decision: string }).decision).toBe("not_now");
    render(<Card card={makeCard("OfferCard", OFFER, { copy_key: "offer.card", card_instance_id: "c-offer-2", status: "resolved", evidence: { decision: "not_now", decided_at: "2027-03-20T16:00:00.000Z" } })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("offer.not_now"))).toBeInTheDocument();
    expect(copy("offer.not_now")).toBe("We'll stay quiet about offers for 90 days. Ask any time.");
    render(<Card card={makeCard("OfferCard", OFFER, { copy_key: "offer.card", card_instance_id: "c-offer-3", status: "resolved", evidence: { decision: "never", decided_at: "2027-04-01T16:00:00.000Z" } })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("offer.never"))).toBeInTheDocument();
    expect(copy("offer.never")).toMatch(/Proactive offers are off/);
    expect(copy("offer.never")).toMatch(/still ask/);
    expect(copy("offer.never")).toMatch(/loan messages continue/);
  });
});

describe("32.11 the Rate-watch block and the standing connections (T5, T9)", () => {
  const loan = (ratewatch: NonNullable<BorrowerRecord["loan"]>["ratewatch"], standing_connections?: NonNullable<BorrowerRecord["loan"]>["standing_connections"]): BorrowerRecord =>
    ({ ...base, timezone: TZ, loan: { ...base.loan, ratewatch, ...(standing_connections ? { standing_connections } : {}) } });
  it("passive: the block states both rates and what worth-it means, and nothing else", () => {
    render(<LoanSection r={loan({ current_rate: "6.125", best_available_rate: "5.750", state: "passive", state_copy_key: "ratewatch.passive", worth_it_copy_key: "ratewatch.worth_it", offer_card_instance_id: null, application_id: null })} />);
    expect(screen.getByText("Rate-watch").nextElementSibling).toHaveTextContent("Your rate 6.125% · best available today 5.750% · we'll tell you when a change is worth it.");
    expect(screen.getByText("Worth it").nextElementSibling).toHaveTextContent("Worth it means at least 0.25% lower with a real saving over seven years, at no cost to you.");
    expect(screen.getByText("Rate-watch status").nextElementSibling).toHaveTextContent(copy("ratewatch.passive"));
    expect(screen.queryByText("Standing connections")).toBeNull();
    expect(document.body.textContent).not.toMatch(NO_INVESTOR);
  });
  it("an open offer and a refinance in progress name themselves; the server's state key wins, else the state", () => {
    expect(rateWatchStateKey({ current_rate: "6.125", best_available_rate: "5.750", state: "offer_open" })).toBe("ratewatch.offer_open");
    expect(rateWatchStateKey({ current_rate: "6.125", best_available_rate: "5.750", state: "in_progress" })).toBe("ratewatch.in_progress");
    expect(rateWatchStateKey({ current_rate: "6.125", best_available_rate: "5.750" })).toBe("ratewatch.passive");
    expect(rateWatchStateKey({ current_rate: "6.125", best_available_rate: "5.750", state: "passive", state_copy_key: "ratewatch.offer_open" })).toBe("ratewatch.offer_open");
    render(<LoanSection r={loan({ current_rate: "6.125", best_available_rate: "5.625", state: "offer_open", offer_card_instance_id: "c-offer" })} />);
    expect(screen.getByText("Rate-watch status").nextElementSibling).toHaveTextContent("An offer is waiting for you in the thread.");
  });
  it("standing connections (DELTA-05): on → the row says they stay on until turned off; withdrawn → the next refinance asks again; none → no row", () => {
    const rw = { current_rate: "6.125", best_available_rate: "5.750", state: "passive" as const };
    expect(standingConnectionsRow({ ratewatch: rw, standing_connections: { status: "active", consent_id: "cons-1", manage_card_instance_id: "c-manage", vendors: ["truv_income", "plaid_assets"] } })).toEqual(["Standing connections", copy("ratewatch.standing.on")]);
    expect(standingConnectionsRow({ ratewatch: rw, standing_connections: { status: "withdrawn", consent_id: "cons-1", withdrawn_at: "2026-11-21T16:00:00.000Z" } })).toEqual(["Standing connections", copy("ratewatch.standing.off")]);
    expect(standingConnectionsRow({ ratewatch: rw, standing_connections: { status: "none" } })).toBeNull();
    expect(standingConnectionsRow({ ratewatch: rw })).toBeNull();
    expect(rateWatchDetailRows({ ratewatch: rw, standing_connections: { status: "active" } }).map(([k]) => k)).toEqual(["Worth it", "Rate-watch status", "Standing connections"]);
    render(<LoanSection r={loan(rw, { status: "withdrawn", consent_id: "cons-1", withdrawn_at: "2026-11-21T16:00:00.000Z" })} />);
    expect(screen.getByText("Standing connections").nextElementSibling).toHaveTextContent("Payroll and bank connections are off. For a future refinance we'll ask you to connect again.");
    expect(copy("consent.standing.off")).toBe("Standing connections are off. For a future refinance we'll ask you to connect again.");
    expect(copyOptions("consent.standing.manage")).toEqual(["Keep them on", "Turn them off"]);
  });
});

describe("32.11 same-servicer funding (T7)", () => {
  it("the funded StatusCard renders the rate, the new payment and its first date from the owning rows, and the autopay token named by copy key", () => {
    const { onResolve } = resolver();
    const props = { state_label: "", copy_tokens: { rate: "6.125%", money: "$4,090.12", date: "2027-01-01" }, detail_copy_key: "refi.same_servicer.autopay", autopay_copy_key: "refi.autopay.carried_over", copy_token_keys: { autopay: "refi.autopay.carried_over" } };
    render(<Card card={makeCard("StatusCard", props, { copy_key: "refi.same_servicer.funded", status: "resolved", card_instance_id: "c-funded" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: "Done. Your new rate 6.125% is live. Your old loan is paid off; your escrow balance moved over; your new payment is $4,090.12 starting 2027-01-01." })).toBeInTheDocument();
    expect(screen.getByTestId("status-detail")).toHaveTextContent("Autopay: carried over.");
    expect(withTokenKeys({ state_label: "", copy_tokens: { rate: "6.125%" }, autopay_copy_key: "refi.autopay.reauthorize" }).copy_tokens).toEqual({ rate: "6.125%", autopay: "please re-authorize it for your new loan" });
    expect(withTokenKeys({ state_label: "", copy_token_keys: { autopay: "refi.autopay.none" } }).copy_tokens).toEqual({ autopay: "not set up" });
    // the Thread line for the escrow credit (30.3 same-servicer netting): no refund to wait for
    expect(copy("refi.escrow.moved")).toBe("Your escrow balance moves to the new loan — no refund to wait for.");
  });
});

describe("32.11 rescission not_applicable (T8)", () => {
  it("renders whatever 25.3 wrote: with no rescission timer in `dates` and a Funded badge there is no cancel window anywhere", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, status: { badge: "Funded", state_source: { state: "funded", table: "fundings" }, one_liner: "funded.card", one_liner_tokens: { date: "2026-11-12" } }, needed_from_you: [], dates: [] };
    const { container } = render(<><StatusSection r={r} link={noop} /><DatesSection r={r} link={noop} /></>);
    expect(container.textContent).not.toMatch(/cancel window/i);
    expect(container.querySelector("[data-timer-code='REGZ_1026_23_RESCISSION_3SBD_GATE']")).toBeNull();
    expect(container.textContent).not.toMatch(/midnight/i);
  });
});

describe("32.11 copy string tests (T10)", () => {
  const entries = Object.values(COPY as Record<string, CopyEntry>).filter((e) => e.section === "Rate-watch and re-refinance" || e.key.startsWith("ratewatch.") || e.key.startsWith("offer.") || e.key.startsWith("refi.") || e.key.startsWith("consent.standing"));
  it("covers the Rate-watch library block", () => {
    expect(entries.length).toBeGreaterThanOrEqual(30);
    for (const k of ["ratewatch.block", "ratewatch.worth_it", "ratewatch.passive", "ratewatch.offer_open", "ratewatch.in_progress", "offer.card", "offer.not_now", "offer.never", "offer.payment_line", "offer.no_cost_line", "offer.lender_line", "offer.mlo_attribution", "offer.good_through", "refi.same_servicer.funded", "refi.escrow.moved", "consent.standing.title", "consent.standing.manage", "consent.standing.off", "ratewatch.standing.on", "ratewatch.standing.off"]) expect(entries.some((e) => e.key === k), k).toBe(true);
  });
  it("no investor reference, no future-terms promise, no guarantee — in the text, the extras and the options", () => {
    for (const e of entries) {
      const all = [e.text, e.notes ?? "", ...e.extras, ...(e.options ?? [])].join(" ");
      expect(e.text, e.key).not.toMatch(NO_INVESTOR);
      expect(all, e.key).not.toMatch(NO_FUTURE_TERMS);
      expect(all, e.key).not.toMatch(/guarantee/i);
      for (const f of FORBIDDEN_WORDS) if (!f.allowedKeyPrefixes.some((p) => e.key.startsWith(p))) expect(e.text, `${e.key}: ${f.word}`).not.toMatch(f.word);
    }
    // "best possible rate", never "guaranteed"; monitoring and offers, never a self-improving promise (B2-1.3-04)
    expect(copy("ratewatch.block", { rate: ["6.125%", "5.750%"] })).toMatch(/we'll tell you when a change is worth it/);
    expect(copy("offer.not_a_commitment")).toBe("This is not a commitment to lend; rates change daily.");
  });
});
