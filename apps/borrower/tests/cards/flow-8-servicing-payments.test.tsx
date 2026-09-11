/**
 * 32.8 — what the borrower SEES for the loan home, payments, autopay, statements and escrow (the API facts are asserted
 * in src/domain/borrower/32-8.spec.test.ts): the badge one-liners with the engine's dates (T1), the PaymentCard titled
 * from `payment.due` and the fresh-code refusal on the card (T2), *held* with the remainder and the 30-day rule plus the
 * refund ChoiceCard (T3), the returned-payment NoticeCard and the re-activation ChoiceCard (T4), every 2.x rule-1
 * element and the optional statement on the autopay ConsentCard (T5), the amount-change NoticeCard (T6), *Mailed* rows
 * and the re-verification ConsentCard after a bounce (T7), the shortage ChoiceCard's two figures and the plan receipt
 * (T8), the surplus receipts (T9), the HPML escrow-period refusal copy (T10) and the year-end row + December consent (T11).
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/cards";
import { LoanSection, StatusSection } from "@/components/record/sections";
import { ConsentElements } from "@/components/flows/7-closing";
import { AUTOPAY_ELEMENT_IDS, autopayElementsMissing, form1098Label, paymentTitle } from "@/components/flows/8-servicing-payments";
import { copy, copyExtra, copyOptions } from "@/lib/copy";
import type { ConsentElement } from "@/lib/types/cards";
import type { BorrowerRecord } from "@/lib/types/record";
import { makeCard, resolver, TZ } from "./helpers";
import servicing from "@/fixtures/servicing.json";

const base = servicing.record as unknown as BorrowerRecord;
const noop = () => {};
const status = (badge: BorrowerRecord["status"]["badge"], one_liner: string, one_liner_tokens: Record<string, string | string[]>): BorrowerRecord => ({ ...base, timezone: TZ, status: { badge, state_source: { state: "loan_installments", table: "loan_installments" }, one_liner, one_liner_tokens }, needed_from_you: [] });

describe("32.8 account badge (T1)", () => {
  it("Payment due shows the due date and 2.7's grace end; Past due the assessed late charge; Current the next payment", () => {
    const { unmount } = render(<StatusSection r={status("Payment due", "account.payment_due", { date: "Oct 1, 2027", grace_end: "Oct 18, 2027" })} link={noop} />);
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Payment due");
    expect(screen.getByText("Due Oct 1, 2027 — no late charge if received by Oct 18, 2027.")).toBeInTheDocument();
    unmount();
    const past = render(<StatusSection r={status("Past due", "account.past_due", { money: "$204.51", date: "Oct 19, 2027" })} link={noop} />);
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Past due");
    expect(screen.getByText("Past due. Late charge $204.51 applied Oct 19, 2027.")).toBeInTheDocument();
    past.unmount();
    render(<StatusSection r={status("Current", "account.current_autopay", { money: "$4,090.12", date: ["Nov 1, 2027", "Nov 1, 2027"] })} link={noop} />);
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Current");
    expect(screen.getByText("Next payment $4,090.12 due Nov 1, 2027 · autopay on Nov 1, 2027.")).toBeInTheDocument();
  });
});

describe("32.8 PaymentCard (T2, T3)", () => {
  const pay = makeCard("PaymentCard", { mode: "one_time", amount_default_cents: "409012", amount_editable: true, date_options: ["2027-01-01", "2027-01-16"], accounts: [], add_account: true, title: "", copy_tokens: { money: "$4,090.12", date: "2027-01-01" }, installment_due_date: "2027-01-01", grace_end_on: "2027-01-16" }, { copy_key: "payment.due", subject: { loan_id: "loan-1" } });
  it("is titled from `payment.due` with the installment and its due date; the date options are the engine's, never later than the grace end", () => {
    const { onResolve } = resolver();
    render(<Card card={pay} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText("Your payment of $4,090.12 is due 2027-01-01.")).toBeInTheDocument();
    expect(paymentTitle("payment.due", pay.props)).toBe("Your payment of $4,090.12 is due 2027-01-01.");
    expect(paymentTitle("payment.another_way", { mode: "one_time", copy_tokens: { money: "$4,090.12", date: "2028-01-01" } })).toBe("Pay $4,090.12 for 2028-01-01 another way.");
    expect(paymentTitle("nope", { mode: "extra_principal" })).toBe("Extra principal");
    const options = within(screen.getByLabelText("Payment date")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["2027-01-01", "2027-01-16"]);
  });
  it("without a fresh L1 code the API's refusal shows on the card as `auth.fresh_code` — the card asks for the code, nothing was changed", () => {
    const { onResolve } = resolver();
    render(<Card card={pay} timezone={TZ} onResolve={onResolve} error={copy("auth.fresh_code")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("For payments we ask for a fresh code. We just sent one.");
  });
  it("a partial shows *held*, the remainder and the 30-day rule; the refund ChoiceCard offers the held amount back", () => {
    const { onResolve } = resolver();
    const held = makeCard("StatusCard", { state_label: "", copy_tokens: { money: ["$1,000.00", "$3,090.12"] }, next_event_label: "Returned if the rest hasn't arrived by", next_event_at: "2027-02-04T12:00:00Z" }, { copy_key: "payment.held" });
    render(<Card card={held} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText("Received $1,000.00. Held until the remaining $3,090.12 arrives; if it doesn't within 30 days we'll return it.")).toBeInTheDocument();
    expect(screen.getByText(/Returned if the rest hasn't arrived by/)).toBeInTheDocument();
    const choice = makeCard("ChoiceCard", { title: "", options: [{ id: "refund", label: "Return my $1,000.00", is_primary: true }, { id: "keep", label: "Keep holding it" }], command: "case.open", command_args_by_option: { refund: { kind: "general_inquiry" }, keep: {} }, no_command_options: ["keep"], copy_tokens: { money: "$1,000.00" } }, { copy_key: "payment.refund.choice", card_instance_id: "c-refund" });
    render(<Card card={choice} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("group", { name: "Want the held $1,000.00 back?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return my $1,000.00" })).toBeInTheDocument();
    expect(copyOptions("payment.refund.choice")).toEqual(["Return my {{money}}", "Keep holding it"]);
    expect(copy("payment.refunded", { money: "$1,000.00", date: "Jan 20, 2027" })).toBe("We returned $1,000.00 to you on Jan 20, 2027.");
  });
});

describe("32.8 returned draft (T4)", () => {
  it("the R01 NoticeCard names the returned date and the retry date; after a second return the ChoiceCard offers the same account again or another way", () => {
    const { onResolve } = resolver();
    const ret = makeCard("NoticeCard", { notice_code: "AUTODRAFT-RETURN-v1", title: "", rendered_document_id: "n-1", plain_language: "", line: "", delivered_at: "2028-01-04T12:00:00Z", channel: "app", copy_tokens: { date: ["Jan 3, 2028", "Jan 6, 2028"] } }, { copy_key: "payment.returned" });
    render(<Card card={ret} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText("Your bank returned the Jan 3, 2028 payment. We'll try again on Jan 6, 2028 unless you pay another way.")).toBeInTheDocument();
    const again = makeCard("ChoiceCard", { title: "", options: [{ id: "reactivate", label: "Use account ····4417 again", is_primary: true }, { id: "pay_another_way", label: "Pay another way" }], command: "autodraft.change", command_args_by_option: { reactivate: {}, pay_another_way: {} }, copy_tokens: { last4: "4417" } }, { copy_key: "autopay.suspended.choice", card_instance_id: "c-susp" });
    render(<Card card={again} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("group", { name: copy("autopay.suspended.choice") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use account ····4417 again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay another way" })).toBeInTheDocument();
    expect(copy("payment.returned.final", { date: "Jan 6, 2028" })).toContain("Autopay is paused");
  });
});

describe("32.8 autopay ConsentCard (T5, T6)", () => {
  const elements: ConsentElement[] = [
    { id: "borrower", label_key: "consent.autodraft.element.borrower", value: "Avery Borrower" },
    { id: "loan", label_key: "consent.autodraft.element.loan", value: "****0731" },
    { id: "account", label_key: "consent.autodraft.element.account", value: "021000021 · ····9876 · checking" },
    { id: "amount", label_key: "consent.autodraft.element.amount", value: "$4,090.12 (your contractual payment)" },
    { id: "amount_variable", label_key: "consent.autodraft.element.amount.variable", value: "" },
    { id: "timing", label_key: "consent.autodraft.element.timing", value: "monthly on the 1st" },
    { id: "first_debit", label_key: "consent.autodraft.element.first_debit", value: "2027-03-01" },
    { id: "company", label_key: "consent.autodraft.element.company", value: "SUPERMORTGAGE" },
    { id: "revoke", label_key: "consent.autodraft.element.revoke", value: "" },
    { id: "date", label_key: "consent.autodraft.element.date", value: "2027-01-20" },
    { id: "esign", label_key: "consent.autodraft.element.esign", value: "" },
  ];
  it("shows every 2.x rule-1 element by its copy label and the optional statement; the card is titled Set up autopay and is never pre-checked", () => {
    expect(autopayElementsMissing(elements)).toEqual([]);
    expect(autopayElementsMissing(elements.slice(0, 5))).toEqual([...AUTOPAY_ELEMENT_IDS.slice(5)]);
    render(<ConsentElements elements={elements} optionalStatementCopyKey="consent.autodraft.optional" />);
    for (const e of elements) expect(screen.getByText(copy(e.label_key))).toBeInTheDocument();
    expect(screen.getByTestId("consent-optional")).toHaveTextContent(copy("consent.autodraft.optional"));
    expect(screen.getByText("SUPERMORTGAGE")).toBeInTheDocument();
    const { onResolve } = resolver();
    const card = makeCard("ConsentCard", { consent_kind: "autodraft_authorization", disclosure_version_id: "AUTODRAFT-CONFIRM-v1", scope: ["autopay"], affirmation_method: "checkbox_with_text", title: "", body_text: "Authorization", requires_typed_name: true, elements, optional_statement_copy_key: "consent.autodraft.optional", optional: true, prechecked: false } as never, { copy_key: "consent.autodraft.title" });
    render(<Card card={card} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText("Set up autopay")).toBeInTheDocument();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Agree" })).toBeDisabled();
  });
  it("the amount-change NoticeCard names the new amount and the debit it applies to", () => {
    const { onResolve } = resolver();
    const n = makeCard("NoticeCard", { notice_code: "AUTODRAFT-AMOUNT-CHANGE-v1", title: "", rendered_document_id: "n-2", plain_language: "", line: "", delivered_at: "2027-12-15T12:00:00Z", channel: "app", copy_tokens: { money: "$4,140.12", date: "Jan 1, 2028" } }, { copy_key: "autopay.amount_change" });
    render(<Card card={n} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText("Your autopay changes to $4,140.12 on Jan 1, 2028.")).toBeInTheDocument();
    expect(copy("autopay.active", { money: "$4,090.12", date: "Mar 1, 2027", last4: "9876" })).toBe("Autopay is on: $4,090.12 on Mar 1, 2027 from ••••9876. A copy of your authorization is on its way.");
  });
});

describe("32.8 statements after a bounce (T7)", () => {
  it("the statement reads Mailed {{date}} with no receipt action and the re-verification ConsentCard is offered", () => {
    const { onResolve } = resolver();
    const mailed = makeCard("StatusCard", { state_label: "", copy_tokens: { month: "November 2027", date: "Nov 20, 2027" } }, { copy_key: "statement.mailed" });
    render(<Card card={mailed} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText("Your November 2027 statement was mailed Nov 20, 2027.")).toBeInTheDocument();
    const notice = makeCard("NoticeCard", { notice_code: "NTC_REGZ_41_STMT_STD", title: "Your statement", rendered_document_id: "n-3", plain_language: "", channel: "mail", mailed_at: "2027-11-20T19:00:00Z" }, { copy_key: "statement.available", card_instance_id: "c-n3" });
    render(<Card card={notice} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(/Mailed Nov 20, 2027/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Got it|Acknowledge/ })).toBeNull();
    const re = makeCard("ConsentCard", { consent_kind: "esign", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", scope: ["periodic_statements"], affirmation_method: "checkbox_with_text", title: "", body_text: "E-SIGN statement", helper_text: copyExtra("consent.esign.reverify", "helper"), requires_typed_name: true, verification_state: "none" }, { copy_key: "consent.esign.reverify", card_instance_id: "c-re" });
    render(<Card card={re} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText("Turn e-delivery back on")).toBeInTheDocument();
    expect(screen.getByText(/bounced, so your documents go by mail/)).toBeInTheDocument();
  });
});

describe("32.8 escrow (T8, T9, T10)", () => {
  it("the shortage ChoiceCard shows +$50.00/mo or $600.00 now; the plan receipt names 12 installments", () => {
    const { onResolve } = resolver();
    const c = makeCard("ChoiceCard", { title: "", options: [{ id: "spread_12", label: "Spread over 12 months (+$50.00/mo)", is_primary: true }, { id: "lump_sum", label: "Pay $600.00 now" }], command: "escrow.electShortage", command_args_by_option: { spread_12: {}, lump_sum: {} }, copy_tokens: { money: ["$600.00", "$50.00", "$600.00"] } }, { copy_key: "escrow.shortage.choice", card_instance_id: "c-short" });
    render(<Card card={c} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("group", { name: "Your escrow is short $600.00." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spread over 12 months (+$50.00/mo)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay $600.00 now" })).toBeInTheDocument();
    expect(copy("escrow.plan.created", { n: "12", money: "$50.00", date: "Jan 1, 2028" })).toBe("Shortage spread over 12 months: +$50.00 a month from Jan 1, 2028.");
  });
  it("a $75 surplus reads refund on its way; $40 reads credited to your payments", () => {
    expect(copy("escrow.surplus", { money: "$75.00" })).toBe("Escrow surplus of $75.00 — refund on its way.");
    expect(copy("escrow.surplus_credit", { money: "$40.00", monthly: "$3.33" })).toBe("Escrow surplus of $40.00 — credited to your payments ($3.33 a month).");
    expect(copy("escrow.surplus.notice", { money: "$75.00" })).toBe("Your escrow surplus refund of $75.00.");
  });
  it("the HPML escrow-period refusal shows on the waiver ChoiceCard with the date the gate names", () => {
    const { onResolve } = resolver();
    const w = makeCard("ChoiceCard", { title: "", options: [{ id: "request", label: "Ask to close my escrow account", is_primary: true }, { id: "keep", label: "Keep escrow" }], command: "escrow.requestWaiver", command_args_by_option: { request: {}, keep: {} } }, { copy_key: "escrow.waiver.choice", card_instance_id: "c-waiver" });
    render(<Card card={w} timezone={TZ} onResolve={onResolve} error={copy("escrow.waiver.hpml_period", { date: "Nov 6, 2031" })} />);
    expect(screen.getByRole("group", { name: "Ask to close your escrow account?" })).toBeInTheDocument();
    expect(screen.getByText(/Flood and mortgage-insurance lines can't be waived/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your loan keeps its escrow account until Nov 6, 2031");
  });
});

describe("32.8 year-end (T11)", () => {
  it("without irs_estatement consent the Loan section's Form 1098 row reads Mailed {{date}}; the December ConsentCard names the tax year", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, loan: { ...base.loan, year_end: { form_1098_status: "mailed", tax_year: 2027, furnished_on: "2028-01-20", channel: "paper" } } };
    render(<LoanSection r={r} />);
    expect(screen.getByText("Form 1098").nextElementSibling).toHaveTextContent("Mailed Jan 20, 2028 (2027)");
    expect(form1098Label({ form_1098_status: "available", furnished_on: "2028-01-20" })).toBe("Available Jan 20, 2028");
    expect(form1098Label({ form_1098_status: "pending" })).toBe("Ready by January 31");
    const { onResolve } = resolver();
    const c = makeCard("ConsentCard", { consent_kind: "irs_estatement" as never, disclosure_version_id: "NTC_IRS_ESTATEMENT_CONSENT_DISCLOSURE", scope: ["irs_estatement"], affirmation_method: "checkbox_with_text", title: "", body_text: "Statement", helper_text: copyExtra("consent.irs_estatement.title", "helper"), requires_typed_name: true, copy_tokens: { year: "2027" } }, { copy_key: "consent.irs_estatement.title", card_instance_id: "c-1098" });
    render(<Card card={c} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText("Get your 2027 Form 1098 electronically")).toBeInTheDocument();
    expect(screen.getByText(/arrives by mail by January 31/)).toBeInTheDocument();
    expect(copy("year_end.1098", { year: "2027" })).toBe("Your 2027 Form 1098 is ready.");
  });
});
