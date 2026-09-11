/**
 * 32.10 — what the borrower SEES for hardship and delinquency (the API facts are asserted in
 * src/domain/borrower/32-10.spec.test.ts): the team PersonCard's reachable number (T1), the protection sentence (T4),
 * the offer ComparisonCard's deadline line — the copy that says what silence means (T5), the trial PaymentCard defaulting
 * to the trial amount (T6), the Loan section's paused period and trial line (T6, T7), the foreclosure advice NoticeCard's
 * help-still-available paragraph and the reinstatement ChoiceCard (T10), the cease acknowledgment (T11), the bankruptcy badge (T9).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/cards";
import { LoanSection, StatusBadgeView } from "@/components/record/sections";
import { hardshipRows, hardshipStateLabel } from "@/components/flows/10-hardship";
import { copy, copyExtra } from "@/lib/copy";
import type { BorrowerRecord, HardshipBlock } from "@/lib/types/record";
import { makeCard, resolver, TZ } from "./helpers";
import refinance from "@/fixtures/refinance.json";

const base = refinance.record as unknown as BorrowerRecord;
const withLoan = (hardship: HardshipBlock): BorrowerRecord => ({ ...base, timezone: TZ, loan: { hardship } } as unknown as BorrowerRecord);

describe("32.10 Loan section (T6, T7)", () => {
  it("an active forbearance reads Payments paused through {{date}} with the late-charge hold; the state word is Paused", () => {
    const h: HardshipBlock = { status: "forbearance", forbearance: { plan_id: "wp-1", term_start: "2026-11-01", term_end: "2027-01-31", status: "active", late_charges_suppressed: true } };
    render(<LoanSection r={withLoan(h)} />);
    expect(screen.getByText(copy("hardship.forb", { date: "Jan 31, 2027" }))).toBeInTheDocument();
    expect(screen.getByText(copy("hardship.plan.on_hold_fees"))).toBeInTheDocument();
    expect(hardshipStateLabel(h)).toBe("Paused");
  });
  it("an active trial period plan reads Trial payment {{n}} of 3 — {{money}} due {{date}} (the evaluation's own figures); the state word is On a plan", () => {
    const h: HardshipBlock = { status: "tpp_active", offer: { option: "flex_mod", status: "accepted", accept_by: "2026-11-16" }, tpp: { n: 2, count: 3, amount_cents: "444625", due_on: "2027-01-01", remaining: 2 } };
    render(<LoanSection r={withLoan(h)} />);
    expect(screen.getByText(copy("hardship.tpp", { n: "2", money: "$4,446.25", date: "Jan 1, 2027" }))).toBeInTheDocument();
    expect(hardshipStateLabel(h)).toBe("On a plan");
  });
  it("an expired forbearance and a bare application leave no hardship rows", () => {
    expect(hardshipRows({ status: "application_pending", application: { application_id: "lma-1", status: "incomplete" } })).toEqual([]);
    expect(hardshipRows({ status: "none", forbearance: { plan_id: "wp-1", term_start: "2026-11-01", term_end: "2027-01-31", status: "expired", late_charges_suppressed: true } })).toEqual([]);
    expect(hardshipRows(undefined)).toEqual([]);
  });
});

describe("32.10 cards", () => {
  it("T1: the team PersonCard names the team and a reachable (tel:) direct number", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("PersonCard", { role: "continuity_of_contact_team", name: "Team 7", reach: "(800) 555-0177" }, { copy_key: "team.assigned", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText("Team 7")).toBeInTheDocument();
    const tel = screen.getByRole("link", { name: "(800) 555-0177" });
    expect(tel.getAttribute("href")).toMatch(/^tel:\+?1?8005550177$/);
  });
  it("T4: the protection sentence is the library's, verbatim", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("StatusCard", { state_label: "" }, { copy_key: "hardship.protection", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText("Your complete application arrived more than 37 days before the sale date. So the sale can't go ahead while we review it.")).toBeInTheDocument();
  });
  it("T5: the offer ComparisonCard carries the deadline line that says what silence means — the same copy the Record repeats when the deadline passes", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("ComparisonCard", { title: "", columns: [{ id: "accept", title: "Payment Deferral", rows: [{ label: "New payment", value: "$4,446.25/mo", emphasis: true }] }], recommended_id: "accept", command: "lossmit.respondToOffer", command_args_by_option: { accept: { decision: "accept" }, decline: { decision: "decline" } }, secondary_option: { id: "decline", label: "Decline" }, footnote: "", copy_tokens: { date: "2026-11-16" } }, { copy_key: "hardship.offer.compare", subject: { loan_id: "loan-1" } as never })} timezone={TZ} onResolve={onResolve} />);
    const line = copyExtra("hardship.offer.compare", "footnote", { date: "2026-11-16" });
    expect(line).toBe(copy("hardship.offer.deadline", { date: "2026-11-16" }));
    expect(screen.getByText(line!)).toBeInTheDocument();
    render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: { date: "2026-11-16" } }, { copy_key: "hardship.offer.deemed_rejected", status: "resolved", card_instance_id: "c-deemed" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("hardship.offer.deemed_rejected", { date: "2026-11-16" }))).toBeInTheDocument();
  });
  it("T6: the trial PaymentCard defaults to the trial amount, read-only, titled by its copy key", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("PaymentCard", { mode: "one_time", amount_default_cents: "444625", amount_editable: false, date_options: ["2026-11-20", "2026-11-21"], accounts: [{ id: "acct-0001", last4: "0001", label: "Checking ····0001" }], add_account: false, copy_tokens: { n: "1", count: "3" } }, { copy_key: "hardship.tpp.pay", subject: { loan_id: "loan-1" } as never })} timezone={TZ} onResolve={onResolve} />);
    const amount = screen.getByLabelText("Amount") as HTMLInputElement;
    expect(amount.value.replace(/,/g, "")).toBe("4446.25");
    expect(amount).toHaveAttribute("readonly");
    expect(screen.getByText(copy("hardship.tpp.pay", { n: "1", count: "3" }))).toBeInTheDocument();
    expect(screen.getByTestId("payment-total")).toHaveTextContent("$4,446.25");
  });
  it("T10: the referral advice NoticeCard shows the notice's own help-still-available paragraph; the reinstatement ChoiceCard offers the figure", () => {
    const { onResolve } = resolver();
    const paragraph = "This does not end your options: you may reinstate the loan by paying the amount past due plus allowable fees and costs, request a payoff figure, or apply for mortgage assistance at any time.";
    render(<Card card={makeCard("NoticeCard", { notice_code: "NTC_SM_FC_REFERRAL_ADVICE", title: "", rendered_document_id: "doc-1", plain_language: paragraph, channel: "mail", mailed_at: "2026-12-31T13:05:00Z" }, { copy_key: "hardship.fc.advice", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("hardship.fc.advice"))).toBeInTheDocument();
    expect(screen.getByTestId("notice-plain-language")).toHaveTextContent("apply for mortgage assistance at any time");
    render(<Card card={makeCard("ChoiceCard", { title: "", options: [{ id: "send", label: "Send me the figure", is_primary: true }, { id: "not_now", label: "Not now" }], command: "case.open", command_args_by_option: { send: { kind: "rfi" }, not_now: {} }, no_command_options: ["not_now"] }, { copy_key: "hardship.fc.reinstate", card_instance_id: "c-reinstate" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("hardship.fc.reinstate"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send me the figure" })).toBeInTheDocument();
  });
  it("T11: the cease acknowledgment NoticeCard and the confirmation status read from the library", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("NoticeCard", { notice_code: "NTC_REGF_1006_6C_CEASE_ACK", title: "", rendered_document_id: "doc-2", plain_language: "", channel: "mail" }, { copy_key: "hardship.cease.ack", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("hardship.cease.ack"))).toBeInTheDocument();
    expect(screen.getAllByText(copyExtra("hardship.cease.ack", "line")!).length).toBeGreaterThan(0);   // the line, and the plain-language block that falls back to it when the document's own text is absent
  });
  it("T9: the bankruptcy badge renders with a caution tone", () => {
    render(<StatusBadgeView badge="Bankruptcy — protections in effect" />);
    const badge = screen.getByTestId("status-badge");
    expect(badge).toHaveTextContent("Bankruptcy — protections in effect");
    expect(badge).toHaveAttribute("data-tone", "caution");
  });
});
