/**
 * 32.4 — what the borrower SEES for disclosures, intent, lock and revised LEs (the API facts are asserted in
 * src/domain/borrower/32-4.spec.test.ts): the Documents rows *Mailed {{date}}* / *Received (deemed) {{date}}* and the
 * electronic copy beside the mailing (T1, T2), the LE + companions as one grouped message (T3, T4), the Dates row
 * caution from SM_LOCK_EXPIRY_WARN_7 (T6), the lock-expired explanation (T7), `revised_le.on_cd_instead` (T8), the
 * What-changed block listing exactly the changed fee with both amounts and the kind label (T9), the refund NoticeCard (T10).
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/cards";
import { DatesSection, DocumentsSection } from "@/components/record/sections";
import { Thread } from "@/components/shell/Thread";
import { Rail } from "@/components/record/Rail";
import { fireEvent } from "@testing-library/react";
import { packageMembers } from "@/components/flows/4-disclosures";
import { copy } from "@/lib/copy";
import type { AnyCardInstance } from "@/lib/types/cards";
import type { BorrowerRecord, ThreadMessage } from "@/lib/types/record";
import { makeCard, resolver, TZ } from "./helpers";
import refinance from "@/fixtures/refinance.json";

const base = refinance.record as unknown as BorrowerRecord;
const noop = () => {};

describe("32.4 Documents rows (T1, T2)", () => {
  it("a mailed LE reads Mailed {{date}}; the electronic copy is its own row beside it; a mailbox-rule receipt reads Received (deemed) {{date}}", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, documents: [
      { document_id: "d1", disclosure_id: "LE-1", notice_code: "NTC_REGZ_1026_37_LE", title: "Loan Estimate", kind: "disclosure:le", status: "mailed", mailed_at: "2026-10-05T16:10:00-07:00", requires_ack: true, channel: "mail", le_version: 1 },
      { document_id: "d2", disclosure_id: "LE-1", notice_code: "NTC_REGZ_1026_37_LE", title: "Loan Estimate (electronic copy)", kind: "disclosure:le", status: "delivered", delivered_at: "2026-10-12T09:00:00-07:00", requires_ack: true, channel: "app", le_version: 1, copy_of_disclosure_id: "LE-1" },
      { document_id: "d3", disclosure_id: "LE-2", notice_code: "NTC_REGZ_1026_37_LE", title: "Loan Estimate", kind: "disclosure:le", status: "deemed_received", received_at: "2026-10-08T12:00:00Z", received_on: "2026-10-08", requires_ack: true, channel: "email", le_version: 1 },
    ] };
    render(<DocumentsSection r={r} link={noop} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Mailed Oct 5, 2026");
    expect(items[1]).toHaveTextContent("Loan Estimate (electronic copy)");
    expect(items[1]).toHaveTextContent("Delivered Oct 12, 2026");
    expect(items[2]).toHaveTextContent("Received (deemed) Oct 8, 2026");
    expect(items[2]).toHaveTextContent(copy("le.deemed", { date: "Oct 8, 2026" }));
  });
});

describe("32.4 grouped LE package (T3, T4)", () => {
  const le = makeCard("DocumentCard", { document_id: "doc-le", disclosure_id: "LE-1", notice_code: "NTC_REGZ_1026_37_LE", title: "", why_you_see_this: "", requires_ack: true, esign_scope_required: "disclosures", package_id: "LE-1", le_version: 1 }, { card_instance_id: "c-le", copy_key: "le.delivered" });
  const arm = makeCard("DocumentCard", { document_id: "doc-arm", disclosure_id: "arm_program:REGZ_1026_19B-app", notice_code: "NTC_REGZ_1026_19B_ARM_PROGRAM", title: "", why_you_see_this: "", requires_ack: false, esign_scope_required: "disclosures", package_id: "LE-1", companion_kind: "arm_program" }, { card_instance_id: "c-arm", copy_key: "companion.arm", status: "resolved" });
  const charm = makeCard("DocumentCard", { document_id: "doc-charm", disclosure_id: "charm:REGZ_1026_19B-app", notice_code: "NTC_REGZ_1026_19B_CHARM", title: "", why_you_see_this: "", requires_ack: false, esign_scope_required: "disclosures", package_id: "LE-1", companion_kind: "charm" }, { card_instance_id: "c-charm", copy_key: "companion.arm", status: "resolved" });
  const msg = (id: string, at: string, card_instance_id: string): ThreadMessage => ({ message_id: id, conversation_id: "conv-1", at, sender: "agent", sender_label: "Supermortgage", channel: "app", card_instance_id, subject: { application_id: "app-1" }, voice_turn: false, delivery: { sent: true, delivered: true, read: false } });
  const messages = [msg("m-arm", "2026-10-05T16:05:00-07:00", "c-arm"), msg("m-charm", "2026-10-05T16:06:00-07:00", "c-charm"), msg("m-le", "2026-10-05T16:10:00-07:00", "c-le")];
  const cards: Record<string, AnyCardInstance> = { "c-le": le, "c-arm": arm, "c-charm": charm };

  it("packageMembers pulls the LE and its companions into one head with the LE first (ARM pair delivered before the LE receipt card)", () => {
    const roles = packageMembers(messages, cards);
    const head = roles.get("m-arm");
    expect(head?.role).toBe("head");
    expect(head && head.role === "head" ? head.cards.map((c) => c.card_instance_id) : []).toEqual(["c-le", "c-arm", "c-charm"]);
    expect(roles.get("m-charm")?.role).toBe("member");
    expect(roles.get("m-le")?.role).toBe("member");
  });
  it("the Thread renders a single grouped message: 'Your Loan Estimate and 2 related document(s).' as one reference with a chip per document; on the rail each document is its own card (32.16 §2.1: no card in the thread)", () => {
    const { onResolve } = resolver();
    const thread = render(<Thread messages={messages} cards={cards} timezone={TZ} partnerLegalName="Partner Bank" showSubjectLabels={false} resolve={async (c, req) => onResolve(req)} cardErrors={{}} />);
    const pkg = screen.getAllByTestId("disclosure-package");
    expect(pkg).toHaveLength(1);
    expect(screen.getByTestId("disclosure-package-header")).toHaveTextContent("Your Loan Estimate and 2 related document(s).");
    expect(within(pkg[0]!).getAllByTestId(/^(reference-chip|chip-receipt)$/)).toHaveLength(3);
    expect(within(pkg[0]!).queryAllByRole("article")).toHaveLength(0);
    thread.unmount();
    // the rail's Documents section: each document its own card, expanded in place; the LE card (requires_ack) carries the receipt action
    render(<Rail record={{ ...base, timezone: TZ, documents: [] }} cards={cards} timezone={TZ} cardProps={{}} resolve={async (c, req) => onResolve(req)} cardErrors={{}} link={noop} />);
    const docs = document.querySelector('[data-record-section="documents"]')!;
    expect(docs.getAttribute("data-open")).toBe("false"); // Documents starts collapsed (32.16 §2.2): a card appears when it is needed
    fireEvent.click(docs.querySelector("h2 > button")!);
    for (const id of ["c-le", "c-arm", "c-charm"]) fireEvent.click(docs.querySelector(`[data-rail-card="${id}"] > button`)!);
    expect(within(docs as HTMLElement).getAllByRole("article")).toHaveLength(3);
    expect(within(docs as HTMLElement).getByRole("button", { name: "Confirm receipt" })).toBeInTheDocument();
    expect(within(docs as HTMLElement).getAllByRole("heading", { name: "How your adjustable rate works" })).toHaveLength(2);
  });
});

describe("32.4 lock cards (T6, T7)", () => {
  it("a Dates row with tone=caution renders caution styling on the lock row", () => {
    const r: BorrowerRecord = { ...base, timezone: TZ, dates: [
      { timer_code: "SM_LOCK_EXPIRY_DEADLINE", label: "Rate lock expires", due_at: "2026-12-12T00:00:00.000Z", calendar: "calendar", tone: "caution" },
      { timer_code: "REGZ_1026_37A13_COSTS_EXPIRE_10BD", label: "Estimated costs on your LE are good through", due_at: "2026-12-20T00:00:00.000Z", calendar: "business days" },
    ] };
    render(<DatesSection r={r} link={noop} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveAttribute("data-tone", "caution");
    expect(rows[0]!.querySelector("time")).toHaveClass("sm-caution-text");
    expect(rows[1]!.querySelector("time")).not.toHaveClass("sm-caution-text");
  });
  it("the expired-lock StatusCard and the 'lock before closing documents' explanation render from their copy keys", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: { date: "2026-11-23" } }, { copy_key: "lock.expired", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    render(<Card card={makeCard("StatusCard", { state_label: "" }, { copy_key: "lock.required_before_closing", status: "resolved", card_instance_id: "c-req" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: "Your lock expired 2026-11-23. Your loan can still close; the rate is set again when you relock." })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "You'll need to lock before we can prepare closing documents." })).toBeInTheDocument();
  });
});

describe("32.4 revised LE (T8, T9) and tolerance refund (T10)", () => {
  it("the What-changed block lists exactly the changed fee row with both amounts and the kind label", () => {
    const { onResolve } = resolver();
    const card = makeCard("DocumentCard", { document_id: "doc-le2", disclosure_id: "LE-2", notice_code: "NTC_REGZ_1026_37_LE", title: "", why_you_see_this: "", requires_ack: true, esign_scope_required: "disclosures", le_version: 2,
      what_changed: { since_version: 1, kind: "new_info", kind_copy_key: "revised_le.kind.new_info", rows: [{ key: "fee:appraisal", label: "Appraisal Fee to AMC", from: "65000", to: "85000", unit: "cents" }] } }, { copy_key: "revised_le.delivered" });
    render(<Card card={card} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: "Your updated Loan Estimate" })).toBeInTheDocument();
    const block = screen.getByTestId("what-changed");
    expect(within(block).getByText("What changed since your last estimate")).toBeInTheDocument();
    const rows = within(block).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-row-key", "fee:appraisal");
    expect(rows[0]).toHaveTextContent("Appraisal Fee to AMC");
    expect(rows[0]).toHaveTextContent("$650.00");
    expect(rows[0]).toHaveTextContent("$850.00");
    expect(screen.getByTestId("what-changed-kind")).toHaveTextContent("New information about you or your loan");
  });
  it("the on-CD-instead StatusCard uses revised_le.on_cd_instead", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("StatusCard", { state_label: "" }, { copy_key: "revised_le.on_cd_instead", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: copy("revised_le.on_cd_instead") })).toBeInTheDocument();
  });
  it("the refund NoticeCard has no action and states the amount from the copy line", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("NoticeCard", { notice_code: "NTC_REGZ_1026_38_CD_CORRECTED", title: "", rendered_document_id: "doc-cd-3", plain_language: "", copy_tokens: { money: "$200.00", date: "2026-11-24" }, amount_cents: "20000" }, { copy_key: "tolerance.refund.notice", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: "A refund is on its way" })).toBeInTheDocument();
    expect(screen.getByTestId("notice-plain-language")).toHaveTextContent("refunding $200.00");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
