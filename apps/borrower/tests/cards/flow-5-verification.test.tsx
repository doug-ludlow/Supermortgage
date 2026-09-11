/**
 * 32.5 — what the borrower SEES for verification, the needs list, conditions and the second borrower (the API facts are
 * asserted in src/domain/borrower/32-5.spec.test.ts): the verb-first Needed-from-you line with owner *you* and the pinned
 * ChecklistCard's owner chips (T1), the UploadCard's mismatch copy with the detected class (T2) and the 30-day freshness
 * copy (T3), the re-request reason after a moved closing (T4), the credit-refresh ConfirmCard naming creditor and open
 * date and nothing about the decision (T5), the large-deposit ExplanationCard (T6), the invitee's joint-intent
 * ConsentCard (T7), People "invited, waiting" (T7/T8), the per-party delivery line (T9), the human-agent PersonCard (T10),
 * and the nothing-needed state with a strip count of 0 (T11).
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/cards";
import { DocumentsSection, NeededSection, PeopleSection } from "@/components/record/sections";
import { StatusStrip } from "@/components/shell/StatusStrip";
import { copy, FORBIDDEN_WORDS } from "@/lib/copy";
import type { BorrowerRecord } from "@/lib/types/record";
import { makeCard, resolver, TZ } from "./helpers";
import refinance from "@/fixtures/refinance.json";

const base = refinance.record as unknown as BorrowerRecord;
const noop = () => {};

describe("32.5 Needed from you (T1, T11)", () => {
  it("renders the verb-first line from the copy library with owner=you, and What we're doing with the owner labels", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ,
      needed_from_you: [{ item_id: "cond-1", kind: "condition", label: "Upload your most recent pay stub", label_copy_key: "upload.title", copy_tokens: { document: "most recent pay stub" }, owner: "you", due_at: "2026-10-11T23:59:59.000Z", card_instance_id: "card-up-1" }],
      what_we_are_doing: [
        { item_id: "cond-9", kind: "condition", label: "Your lender is obtaining the title commitment for the property.", owner: "title_company", owner_copy_key: "needs.owner.title_company", status: "waiting_third_party", source: "conditions" },
        { item_id: "cond-10", kind: "condition", label: "Your lender needs the payoff statement for the mortgage being paid off.", owner: "prior_servicer", owner_copy_key: "needs.owner.prior_servicer", status: "waiting_third_party", source: "conditions" },
        { item_id: "cond-3", kind: "condition", label: "Your lender will confirm your current employment with your employer before closing.", owner: "us", owner_copy_key: "needs.owner.us", status: "open", source: "conditions" },
      ] };
    render(<NeededSection r={r} link={noop} />);
    expect(screen.getByRole("heading", { name: "Needed from you · 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy("upload.title", { document: "most recent pay stub" }) })).toHaveTextContent("Upload your most recent pay stub");
    const doing = screen.getByTestId("what-we-are-doing");
    expect(within(doing).getByRole("heading", { name: copy("needs.doing.title") })).toBeInTheDocument();
    const rows = within(doing).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("the title company");
    expect(rows[1]).toHaveTextContent("your current servicer");
    expect(rows[2]).toHaveTextContent("us");
    expect(rows[0]).toHaveAttribute("data-owner", "title_company");
  });
  it("zero owner=you items: the nothing-needed state and a strip count of 0", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, needed_from_you: [], what_we_are_doing: [], needed_summary: { count: 0, nothing_needed: true, copy_key: "needs.none" } };
    render(<NeededSection r={r} link={noop} />);
    expect(screen.getByTestId("needs-none")).toHaveTextContent("Nothing needed from you. We'll message you when something is.");
    expect(screen.getByTestId("needs-none")).toHaveTextContent(copy("needs.none"));
    expect(screen.queryByTestId("what-we-are-doing")).toBeNull();
    render(<StatusStrip record={r} onOpen={noop} />);
    expect(screen.getByTestId("strip-count")).toHaveTextContent("0 needed");
  });
  it("the pinned ChecklistCard: owner chips, the action chip only on the borrower's items", () => {
    const card = makeCard("ChecklistCard", { items: [
      { condition_id: "c1", label: "Upload your most recent pay stub", owner: "you", status: "waiting_borrower", due_at: "2026-10-11T23:59:59.000Z", action: { kind: "upload", card_kind: "UploadCard", card_instance_id: "card-up-1" } },
      { condition_id: "c9", label: "Your lender is obtaining the title commitment for the property.", owner: "third_party", status: "waiting_third_party" },
    ] }, { copy_key: "needs.title" });
    const { onResolve } = resolver();
    render(<Card card={card} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: "Needed from you" })).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByRole("button", { name: "Upload" })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("Waiting on you");
    expect(within(rows[1]!).queryByRole("button")).toBeNull();
    expect(rows[1]).toHaveTextContent("Third party");
  });
});

describe("32.5 UploadCard copy (T2, T3, T4)", () => {
  const props = { document_class: "paystub", accepted_examples: ["a pay stub from your employer"], why: "", freshness_hint: "dated within the last 30 days", title: "", copy_tokens: { document: "most recent pay stub" }, label_copy_key: "upload.title", request_id: "req-1", condition_id: "cond-1" };
  it("re-opened for a class mismatch: 'This looks like a W-2; we need a most recent pay stub.'", () => {
    render(<Card card={makeCard("UploadCard", { ...props, mismatch: { detected: "W-2", expected: "most recent pay stub" } }, { copy_key: "upload.title" })} timezone={TZ} onResolve={resolver().onResolve} />);
    expect(screen.getByRole("heading", { name: "Upload your most recent pay stub" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This looks like a W-2; we need a most recent pay stub.");
  });
  it("re-opened for the paystub floor: 'This one is dated Aug 26, 2026; we need one from the last 30 days.'", () => {
    render(<Card card={makeCard("UploadCard", { ...props, stale: { date: "Aug 26, 2026", n: 30 } }, { copy_key: "upload.title" })} timezone={TZ} onResolve={resolver().onResolve} />);
    expect(screen.getByTestId("upload-stale")).toHaveTextContent(copy("upload.stale", { date: "Aug 26, 2026", n: "30" }));
    expect(screen.getByTestId("upload-stale")).toHaveTextContent("we need one from the last 30 days");
  });
  it("the freshness re-request after a moved closing carries the reason with the new date", () => {
    render(<Card card={makeCard("UploadCard", { ...props, document_class: "bank_statement", reason_copy_key: "upload.rerequest.closing_moved", copy_tokens: { document: "bank statement", date: "Dec 15, 2026", n: "120" } }, { copy_key: "upload.title" })} timezone={TZ} onResolve={resolver().onResolve} />);
    expect(screen.getByRole("heading", { name: "Upload your bank statement" })).toBeInTheDocument();
    expect(screen.getByTestId("upload-reason")).toHaveTextContent("Closing moved to Dec 15, 2026, so we need a bank statement from the last 120 days.");
  });
});

describe("32.5 the credit refresh's ConfirmCard (T5)", () => {
  it("names the creditor and the open date, states the source, says nothing about the decision, and yes/no map to options", async () => {
    const card = makeCard("ConfirmCard", { commits_to: "application_liabilities", fields: [{ path: "credit.alert.a1", label: "Account", value: "Conn's Home Plus", source: "credit_report" }, { path: "credit.alert.a1.opened", label: "Opened", value: "2026-10-22", source: "credit_report" }], copy_tokens: { creditor: "Conn's Home Plus", date: "Oct 22, 2026" }, helper_copy_key: "new_debt.source", options: [{ id: "yes", label: "Yes, that's mine", is_primary: true }, { id: "no", label: "No, I don't recognize it" }] }, { copy_key: "new_debt.confirm" });
    const { onResolve, calls } = resolver();
    const { container } = render(<Card card={card} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: "We see a new account with Conn's Home Plus opened Oct 22, 2026. Is this yours?" })).toBeInTheDocument();
    expect(screen.getByTestId("confirm-helper")).toHaveTextContent("Source: the credit refresh we run before closing.");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/approv|declin|qualif|decision|denied|eligib/i);
    for (const w of FORBIDDEN_WORDS) expect(text).not.toMatch(w.word);
    screen.getByRole("button", { name: "Yes, that's mine" }).click();
    await Promise.resolve();
    expect(calls[0]?.option_id).toBe("yes");
  });
});

describe("32.5 the large deposit's ExplanationCard (T6)", () => {
  it("one card for that deposit: the subject names the fact, the prompt asks one question", () => {
    const card = makeCard("ExplanationCard", { subject: "", prompt: "", min_length: 40, subject_copy_key: "explain.deposit.subject", prompt_copy_key: "explain.deposit", copy_tokens: { money: "$9,000.00", date: "Sep 14, 2026", account_last4: "····1234", subject: "$9,000.00 deposit on Sep 14, 2026" } }, { copy_key: "explain.title" });
    render(<Card card={card} timezone={TZ} onResolve={resolver().onResolve} />);
    expect(screen.getByRole("heading", { name: "$9,000.00 deposit on Sep 14, 2026" })).toBeInTheDocument();
    expect(screen.getByText("A deposit of $9,000.00 on Sep 14, 2026 into ····1234 — where did it come from?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send explanation" })).toBeDisabled();
  });
});

describe("32.5 the second borrower (T7, T8)", () => {
  it("ConsentCard{joint_intent}: the question names the other borrower; a checkbox and a typed name, never a single tap", () => {
    const card = makeCard("ConsentCard", { consent_kind: "joint_intent", disclosure_version_id: "REGB_1002_7D_JOINT_INTENT", scope: [], affirmation_method: "checkbox_with_text", title: "", body_text: "", requires_typed_name: true, verification_state: "none", copy_tokens: { other_first_name: "Alex" } } as never, { copy_key: "consent.joint_intent.title" });
    render(<Card card={card} timezone={TZ} onResolve={resolver().onResolve} />);
    expect(screen.getByRole("heading", { name: "Do you intend to apply for this loan jointly with Alex?" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
  it("People: the invitee reads 'invited, waiting'; a non-borrowing spouse has their own role label", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, people: [
      { party_id: "p-a", role: "borrower", display_name: "Alex Borrower", progress: { consents_ok: true, confirmations_ok: true, signed: false } },
      { party_id: "p-c", role: "co_borrower", display_name: "Casey", waiting: true, progress: { consents_ok: false, confirmations_ok: false, signed: false } },
      { party_id: "p-s", role: "non_borrowing_spouse", display_name: "Sam", waiting: true },
    ] };
    render(<PeopleSection r={r} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[1]).toHaveTextContent("Casey");
    expect(rows[1]).toHaveTextContent("invited, waiting");
    expect(rows[2]).toHaveTextContent("Non-borrowing spouse");
    expect(rows[2]).not.toHaveTextContent("undefined");
  });
});

describe("32.5 per-party delivery (T9)", () => {
  it("one LE, two statuses: Alex delivered electronically, Blake mailed", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, documents: [
      { document_id: "d1", disclosure_id: "LE-1", notice_code: "NTC_REGZ_1026_37_LE", title: "Loan Estimate", kind: "disclosure:le", status: "mailed", mailed_at: "2026-10-05T16:10:00-07:00", delivered_at: "2026-10-05T16:10:00-07:00", requires_ack: true, channel: "mail", le_version: 1,
        deliveries: [{ borrower_id: "B1", display_name: "Alex", channel: "esign_portal", status: "delivered", at: "2026-10-05T16:10:00-07:00" }, { borrower_id: "B2", display_name: "Blake", channel: "mail", status: "mailed", at: "2026-10-05T16:10:00-07:00" }] },
    ] };
    render(<DocumentsSection r={r} link={noop} />);
    const list = screen.getByTestId("party-deliveries");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Alex");
    expect(rows[0]).toHaveTextContent("Delivered electronically Oct 5, 2026");
    expect(rows[1]).toHaveTextContent("Blake");
    expect(rows[1]).toHaveTextContent("Mailed by mail Oct 5, 2026");
    expect(rows[1]).toHaveAttribute("data-status", "mailed");
  });
});

describe("32.5 the human agent (T10)", () => {
  it("PersonCard{human_agent}: the pending name and the intro from the copy library; no action", () => {
    const card = makeCard("PersonCard", { role: "human_agent", name: "", name_copy_key: "human.agent.pending", intro: "", intro_copy_key: "human.agent.intro" }, { copy_key: "human.agent.intro", status: "resolved" });
    render(<Card card={card} timezone={TZ} onResolve={resolver().onResolve} />);
    expect(screen.getByRole("heading", { name: "A person on your loan: Your Supermortgage contact" })).toBeInTheDocument();
    expect(screen.getByText(copy("human.agent.intro"))).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
