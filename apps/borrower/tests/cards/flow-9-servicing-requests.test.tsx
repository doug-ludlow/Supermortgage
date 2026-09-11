/**
 * 32.9 — what the borrower SEES for insurance, PMI, ARM, life events and requests (the API facts — the timers, events,
 * cases, notices and cards — are asserted in src/domain/borrower/32-9.spec.test.ts): the Dates row for the flood
 * placement date (T3), the NoE acknowledgment NoticeCard with the response date (T8), the estimated ARM payment on
 * Numbers (T6), the valuation-fee ChoiceCard with the tabulated fee (T5), the documents card for a successor (T7).
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/cards";
import { DatesSection, NumbersSection } from "@/components/record/sections";
import { copy, copyExtra } from "@/lib/copy";
import type { BorrowerRecord, PostFundingNumbers } from "@/lib/types/record";
import { makeCard, resolver, TZ } from "./helpers";
import servicing from "@/fixtures/servicing.json";

const base = servicing.record as unknown as BorrowerRecord;
const noop = () => {};
const loanCard = { subject: { loan_id: "loan-1" }, created_by: "agent:borrower-comms" } as const;

describe("32.9 Dates: the flood placement date (T3)", () => {
  it("FDPA_4012A_E_FLOOD_FPI_NOTICE_45 renders as its own Dates row with the engine's date and the calendar note", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, dates: [{ timer_code: "FDPA_4012A_E_FLOOD_FPI_NOTICE_45", label: "Flood coverage may be placed on", due_at: "2027-08-20T23:59:59-07:00", calendar: "calendar days", message_id: "msg-flood" }] };
    render(<DatesSection r={r} link={noop} />);
    const row = screen.getByRole("listitem");
    expect(row).toHaveAttribute("data-timer-code", "FDPA_4012A_E_FLOOD_FPI_NOTICE_45");
    expect(row).toHaveTextContent("Flood coverage may be placed on");
    expect(row).toHaveTextContent("calendar days");
    expect(within(row).getByRole("button")).toHaveTextContent("Aug 20, 2027");
  });
});

describe("32.9 Thread: the acknowledgment carries the response date (T8)", () => {
  it("the NoE acknowledgment NoticeCard renders the library's line with the response date, the suppression date and the receipt date", () => {
    const { onResolve } = resolver();
    const card = makeCard("NoticeCard", { notice_code: "NTC_REGX_35D_ACK", title: "", rendered_document_id: "n-ack-1", plain_language: "", line: "", channel: "mail", mailed_at: "2027-01-13T16:30:00Z", copy_tokens: { date: "2027-02-25", until: "2027-03-14", received: "2027-01-13" } }, { ...loanCard, copy_key: "case.noe.ack", status: "resolved" });
    render(<Card card={card} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("case.noe.ack", { received: "2027-01-13" }))).toBeInTheDocument();
    const line = copyExtra("case.noe.ack", "line", { date: "2027-02-25", until: "2027-03-14" })!;
    expect(line).toContain("2027-02-25");
    expect(screen.getAllByText(line).length).toBeGreaterThan(0);
  });
});

describe("32.9 Numbers: the estimated ARM payment (T6)", () => {
  it("shows the engine's estimated payment and rate from the record, with the change date, and never a recomputed figure", () => {
    const numbers: PostFundingNumbers = { ...(base.numbers as PostFundingNumbers), arm_estimate: { basis: "estimate", change_on: "2028-06-01", first_new_payment_due: "2028-07-01", estimated_rate: "6.390", estimated_pi_cents: "349811", notice_id: "n-arm-1", sent_on: "2027-11-10" } };
    render(<NumbersSection r={{ ...base, timezone: TZ, numbers }} />);
    const est = screen.getByTestId("arm-estimate");
    expect(est).toHaveAttribute("data-basis", "estimate");
    expect(est).toHaveTextContent("$3,498.11");
    expect(est).toHaveTextContent("Jul 1, 2028");
    expect(est).toHaveTextContent(copy("arm.change", { date: "Jul 1, 2028", money: "$3,498.11" }));
    expect(screen.getByTestId("arm-estimate-rate")).toHaveTextContent("6.390%");
    expect(screen.getByText("Estimated new payment")).toBeInTheDocument();
  });
  it("renders no estimate row before the notice is sent", () => {
    render(<NumbersSection r={{ ...base, timezone: TZ }} />);
    expect(screen.queryByTestId("arm-estimate")).toBeNull();
  });
});

describe("32.9 PMI: the valuation-fee ChoiceCard (T5)", () => {
  it("offers the tabulated fee and Not now, resolving on tap with the option id", async () => {
    const { onResolve, calls } = resolver();
    const card = makeCard("ChoiceCard", { title: copy("pmi.fee.choice", { money: "$190.00" }), options: [{ id: "pay_fee", label: "Pay the $190.00 valuation fee", is_primary: true }, { id: "not_now", label: "Not now" }], command: "payment.makeOneTime", command_args_by_option: { pay_fee: { amount_cents: "19000", designation: "mi_valuation_fee" }, not_now: {} }, no_command_options: ["not_now"], copy_tokens: { money: "$190.00" } }, { ...loanCard, copy_key: "pmi.fee.choice", expires_at: "2027-10-02T23:59:59-07:00" });
    render(<Card card={card} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("pmi.fee.choice", { money: "$190.00" }))).toBeInTheDocument();
    const pay = screen.getByRole("button", { name: /Pay the \$190\.00 valuation fee/ });
    expect(pay).toHaveClass("sm-btn-primary");
    pay.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]?.option_id).toBe("pay_fee");
  });
});

describe("32.9 Successor: the documents card from the matrix (T7)", () => {
  it("names the matrix documents in the library's line and carries no collection language", () => {
    const { onResolve } = resolver();
    const documents = "a death certificate; the recorded deed; letters testamentary (from the probate court); the will";
    const card = makeCard("NoticeCard", { notice_code: "NTC_REGX_38B1VI_SII_DOCS", title: "", rendered_document_id: "n-sii-1", plain_language: "", line: "", channel: "mail", mailed_at: "2027-01-19T17:00:00Z", copy_tokens: { documents } }, { ...loanCard, copy_key: "successor.documents", status: "resolved" });
    const { container } = render(<Card card={card} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("successor.documents"))).toBeInTheDocument();
    expect(container.textContent).toContain("letters testamentary");
    expect(container.textContent ?? "").not.toMatch(/past due|delinquen|collection|amount due|pay now|foreclos/i);
  });
});
