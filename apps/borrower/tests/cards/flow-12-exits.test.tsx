/**
 * 32.12 — what the borrower SEES of a loan leaving servicing (the API facts are asserted in src/domain/borrower/32-12.spec.test.ts):
 * the components card with the positive-confirmation line (T1), the shortage NoticeCard's reason (T2), the read-only banner under
 * Closed / Transferred out (T5, T8), the autopay end and termination lines on the Loan section (T3, T5), the lien-release NoticeCard
 * explaining the trustee path (T4), the forwarded-payment cards with and without the protection text (T6), the transfer Dates rows (T5).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/cards";
import { DatesSection, LoanSection, StatusSection, badgeTone } from "@/components/record/sections";
import { autopayExitLine, READ_ONLY_EXIT_BADGES } from "@/components/flows/12-exits";
import { copy } from "@/lib/copy";
import type { BorrowerRecord } from "@/lib/types/record";
import { makeCard, resolver, TZ } from "./helpers";
import refinance from "@/fixtures/refinance.json";

const base = refinance.record as unknown as BorrowerRecord;
const noop = () => {};
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

describe("32.12 the payoff statement (T1) and the shortage (T2)", () => {
  it("the components StatusCard names principal, interest, per diem, total and the good-through date from 16.1's row, with the positive-confirmation line as its detail", () => {
    const { onResolve } = resolver();
    const tokens = { principal: usd(55_945_571), interest: usd(285_556), escrow: usd(206_250), fees: usd(0), per_diem: usd(9_388), total: usd(56_231_127), good_through: "2027-02-05", date: "2027-02-05", money: usd(56_231_127) };
    render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: tokens, detail_copy_key: "payoff.wire_confirm", next_event_label: "Good through", next_event_at: "2027-02-05T23:59:59.000Z" }, { copy_key: "payoff.statement.components", status: "resolved", subject: { loan_id: "loan-1" } })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("payoff.statement.components", tokens))).toBeTruthy();
    expect(screen.getByTestId("status-detail").textContent).toBe(copy("payoff.wire_confirm"));
    expect(copy("payoff.wire_confirm")).toMatch(/never change wire instructions by e-mail/);
  });
  it("the shortage NoticeCard states the difference, the reason (a copy key resolved through the library) and the cure-by date", () => {
    const { onResolve } = resolver();
    const props = { notice_code: "NTC_PAYOFF_SHORTAGE_DEMAND", title: "", rendered_document_id: "n-short", plain_language: "", line: "", copy_tokens: { money: "$300.00", date: "2027-02-08", uncured_on: "2027-03-03" }, copy_token_keys: { reason: "payoff.shortage.reason.amount" } };
    render(<Card card={makeCard("NoticeCard", props, { copy_key: "payoff.shortage", status: "resolved", subject: { loan_id: "loan-1" } })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("payoff.shortage", { money: "$300.00" }))).toBeTruthy();
    const line = screen.getByTestId("notice-plain-language").textContent ?? "";
    expect(line).toContain(copy("payoff.shortage.reason.amount"));
    expect(line).toContain("2027-02-08");
  });
});

describe("32.12 the Record under an exit badge (T3, T5, T8)", () => {
  const status = (badge: BorrowerRecord["status"]["badge"], one_liner: string, tokens: Record<string, string> = {}): BorrowerRecord["status"] => ({ badge, state_source: { state: badge, table: "loans" }, one_liner, one_liner_tokens: tokens });
  it("Closed is neutral and read-only: the banner says the documents stay; Paying off and Servicing moving are not read-only", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, read_only: true, needed_from_you: [], status: status("Closed", "closed") };
    render(<StatusSection r={r} link={noop} />);
    expect(screen.getByTestId("status-badge").getAttribute("data-tone")).toBe("neutral");
    const banner = screen.getByTestId("exit-banner");
    expect(banner.textContent).toContain(copy("closed"));
    expect(banner.textContent).toContain(copy("exit.documents_stay"));
    expect(badgeTone("Transferred out")).toBe("neutral");
    expect(badgeTone("Paying off")).toBe("info");
    expect(badgeTone("Servicing moving")).toBe("info");
    expect([...READ_ONLY_EXIT_BADGES]).toEqual(["Closed", "Transferred out"]);
  });
  it("Transferred out inside the 60 days carries the protection line; from day 61 it does not", () => {
    const tokens = { new_servicer: "FAKE Northwind Servicing", date: "2027-10-01", through: "2027-11-29" };
    const inWindow: BorrowerRecord = { ...base, timezone: TZ, read_only: true, needed_from_you: [], status: status("Transferred out", "transfer.after", tokens) };
    const { unmount } = render(<StatusSection r={inWindow} link={noop} />);
    expect(screen.getByTestId("exit-banner").textContent).toContain("counts as on time");
    expect(screen.getByTestId("exit-banner").textContent).toContain("FAKE Northwind Servicing");
    unmount();
    const after: BorrowerRecord = { ...base, timezone: TZ, read_only: true, needed_from_you: [], status: status("Transferred out", "transfer.after_window", tokens) };
    render(<StatusSection r={after} link={noop} />);
    expect(screen.getByTestId("exit-banner").textContent).not.toContain("counts as on time");
    expect(screen.getByTestId("exit-banner").textContent).not.toContain("protected");
  });
  it("Paid off is not read-only: no banner, the one-liner names the refund date the engine armed", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, read_only: false, needed_from_you: [], status: status("Paid off", "payoff.paid_in_full", { money: "$2,062.50", date: "2027-03-31", n: "2027-04-02" }) };
    render(<StatusSection r={r} link={noop} />);
    expect(screen.queryByTestId("exit-banner")).toBeNull();
    expect(screen.getByText(copy("payoff.paid_in_full", { money: "$2,062.50", date: "2027-03-31", n: "2027-04-02" }))).toBeTruthy();
  });
  it("the Loan section: autopay shows its end date on a transfer out and says so once terminated", () => {
    const moving: BorrowerRecord = { ...base, timezone: TZ, loan: { autodraft: { status: "active", next_draft_on: "2027-10-01", amount_cents: "409012", account_last4: "4321", ends_on: "2027-09-30" } } };
    const { unmount } = render(<LoanSection r={moving} />);
    expect(screen.getByText(/Autopay with us ends after Sep 30, 2027/)).toBeTruthy();
    unmount();
    expect(autopayExitLine({ status: "terminated", terminated_on: "2027-03-03" })).toBe(copy("autopay.terminated", { date: "Mar 3, 2027" }));
    expect(autopayExitLine({ status: "active" })).toBeNull();
    const paidOff: BorrowerRecord = { ...base, timezone: TZ, loan: { autodraft: { status: "terminated", terminated_on: "2027-03-03", termination_reason: "payoff" }, ratewatch_status: "void" } };
    render(<LoanSection r={paidOff} />);
    expect(screen.getByText(/Autopay ended Mar 3, 2027/)).toBeTruthy();
  });
  it("the transfer Dates rows 17.2 stored render with their labels", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, dates: [
      { timer_code: "transfer.transferor_stops", label: "Last payment to Supermortgage", due_at: "2027-09-30T12:00:00.000Z", calendar: "calendar" },
      { timer_code: "transfer.transferee_starts", label: "First payment to FAKE Northwind Servicing", due_at: "2027-10-01T12:00:00.000Z", calendar: "calendar" },
      { timer_code: "transfer.window_end", label: "Payment protection ends", due_at: "2027-11-29T12:00:00.000Z", calendar: "calendar days" },
    ] };
    render(<DatesSection r={r} link={noop} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Last payment to Supermortgage");
    expect(items[0]).toHaveTextContent("Sep 30, 2027");
    expect(items[2]).toHaveTextContent("Payment protection ends");
    expect(items[2]).toHaveTextContent("Nov 29, 2027");
  });
});

describe("32.12 the lien release (T4) and the forwarded payment (T6)", () => {
  it("NTC_LIEN_RELEASE_RECORDED on the trustee path explains the reconveyance and carries the recording reference", () => {
    const { onResolve } = resolver();
    const props = { notice_code: "NTC_LIEN_RELEASE_RECORDED", title: "", rendered_document_id: "n-rel", plain_language: "", line: "", copy_tokens: { date: "2027-03-26", reference: "FAKE Doc No. 20270326-0001", state: "CA" }, copy_token_keys: { path: "payoff.lien_release.trustee" } };
    render(<Card card={makeCard("NoticeCard", props, { copy_key: "payoff.lien_release", status: "resolved", subject: { loan_id: "loan-1" } })} timezone={TZ} onResolve={onResolve} />);
    const text = screen.getByTestId("notice-plain-language").textContent ?? "";
    expect(text).toContain(copy("payoff.lien_release.trustee"));
    expect(text).toMatch(/trustee/i);
    expect(text).toContain("FAKE Doc No. 20270326-0001");
    expect(screen.getByText(/Open the notice \(NTC_LIEN_RELEASE_RECORDED\)/)).toBeTruthy();
  });
  it("a direct-recording release explains no trustee", () => {
    const { onResolve } = resolver();
    const props = { notice_code: "NTC_LIEN_RELEASE_RECORDED", title: "", rendered_document_id: "n-rel2", plain_language: "", line: "", copy_tokens: { date: "2027-03-26", reference: "FAKE Instrument No. 1", state: "AZ" }, copy_token_keys: { path: "payoff.lien_release.direct" } };
    render(<Card card={makeCard("NoticeCard", props, { copy_key: "payoff.lien_release", status: "resolved", subject: { loan_id: "loan-1" } })} timezone={TZ} onResolve={onResolve} />);
    const text = screen.getByTestId("notice-plain-language").textContent ?? "";
    expect(text).toContain(copy("payoff.lien_release.direct"));
    expect(text).not.toMatch(/trustee/i);
  });
  it("a payment received inside the 60 days is forwarded and protected; from day 61 the card has no protection text", () => {
    const { onResolve } = resolver();
    const tokens = { money: "$4,090.12", date: "2027-10-14", new_servicer: "FAKE Northwind Servicing" };
    const { unmount } = render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: tokens }, { copy_key: "transfer.payment_forwarded", status: "resolved", subject: { loan_id: "loan-1" } })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("transfer.payment_forwarded", tokens))).toBeTruthy();
    expect(copy("transfer.payment_forwarded", tokens)).toMatch(/protected/);
    unmount();
    const late = { ...tokens, date: "2027-12-01" };
    render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: late }, { copy_key: "transfer.payment_forwarded.after_window", status: "resolved", subject: { loan_id: "loan-1" } })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("transfer.payment_forwarded.after_window", late))).toBeTruthy();
    expect(copy("transfer.payment_forwarded.after_window", late)).not.toMatch(/protected/);
  });
});
