/**
 * 32.7 — what the borrower SEES for the CD, closing, rescission, funding and boarding (the API facts are asserted in
 * src/domain/borrower/32-7.spec.test.ts): the LE→CD What-changed block titled `cd.what_changed` beside the wire warning
 * (T1), the ScheduleCard that offers ipen|hybrid|wet and never ron when 26.2 refused RON, narrowing its slots to the
 * chosen type (T4, T5), the H-8 card's quiet "How to cancel" link posting a message — never a primary button (T6, T8),
 * the Cancelled badge as a neutral read-only state (T8), the funding hold with its single ask (T9), the funded line's
 * `funded.no_skip` detail (T10), the autodraft ConsentCard's elements and optional statement (T11), the servicing
 * E-SIGN offer (T12) and the Fannie Mae letter hand-off with 30.4's explainer (T13).
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Card } from "@/components/cards";
import { StatusBadgeView, badgeTone } from "@/components/record/sections";
import { defaultClosingType, slotsForType, statusDetailLines, handoffLine } from "@/components/flows/7-closing";
import { copy } from "@/lib/copy";
import { makeCard, resolver, TZ } from "./helpers";

describe("32.7 Closing Disclosure card (T1, T2)", () => {
  it("the LE→CD What-changed block titles itself cd.what_changed, lists the APR and payoff rows, and the wire-fraud warning rides on the card", () => {
    const { onResolve } = resolver();
    const card = makeCard("DocumentCard", { document_id: "doc-cd", disclosure_id: "CD-1", notice_code: "NTC_REGZ_1026_38_CD", title: "", why_you_see_this: "", requires_ack: true, esign_scope_required: "disclosures", wire_warning_copy_key: "cd.wire_warning",
      what_changed: { since_version: 0, kind: "le_to_cd", kind_copy_key: null, title_key: "cd.what_changed", rows: [{ key: "apr", label_key: "cd.row.apr", from: "6.125", to: "6.159", unit: "rate" }, { key: "payoff", label_key: "cd.row.payoff", from: null, to: "54820000", unit: "cents" }] } }, { copy_key: "cd.delivered" });
    render(<Card card={card} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: copy("cd.delivered") })).toBeInTheDocument();
    const block = screen.getByTestId("what-changed");
    expect(within(block).getByRole("heading", { level: 4 })).toHaveTextContent(copy("cd.what_changed"));
    const rows = within(block).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("data-row-key"))).toEqual(["apr", "payoff"]);
    expect(rows[0]).toHaveTextContent("APR");
    expect(rows[1]).toHaveTextContent("—");
    expect(rows[1]).toHaveTextContent("$548,200.00");
    expect(screen.getByTestId("wire-warning")).toHaveTextContent(copy("cd.wire_warning"));
    expect(screen.getByRole("button", { name: "Confirm receipt" })).toBeInTheDocument();
  });
  it("the restart line after a corrected CD carries the new earliest date", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: { date: "2026-11-06" } }, { copy_key: "cd.redisclosed_restart", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: copy("cd.redisclosed_restart", { date: "2026-11-06" }) })).toBeInTheDocument();
  });
});

describe("32.7 closing ScheduleCard (T4, T5)", () => {
  const slots = [
    { id: "ipen:2026-11-09T10", starts_at: "2026-11-09T17:00:00.000Z", ends_at: "2026-11-09T17:45:00.000Z", closing_type: "ipen" },
    { id: "hybrid:2026-11-09T10", starts_at: "2026-11-09T17:00:00.000Z", ends_at: "2026-11-09T17:45:00.000Z", closing_type: "hybrid" },
    { id: "wet:2026-11-09T10", starts_at: "2026-11-09T17:00:00.000Z", ends_at: "2026-11-09T17:45:00.000Z", closing_type: "wet" },
    { id: "wet:2026-11-09T14", starts_at: "2026-11-09T21:00:00.000Z", ends_at: "2026-11-09T21:45:00.000Z", closing_type: "wet" },
  ];
  const props = { purpose: "ron_session" as const, slots, closing_type_options: [{ id: "ipen", copy_key: "closing.schedule.type.ipen", is_default: true }, { id: "hybrid", copy_key: "closing.schedule.type.hybrid" }, { id: "wet", copy_key: "closing.schedule.type.wet" }], default_closing_type: "ipen", ron_eligible: false, fallback_copy_key: "closing.schedule.fallback" };
  it("offers ipen | hybrid | wet and never ron; the slot list narrows to the chosen type; booking a wet slot resolves with that slot", () => {
    const { onResolve, calls } = resolver();
    render(<Card card={makeCard("ScheduleCard", props, { copy_key: "closing.schedule" })} timezone={TZ} onResolve={onResolve} />);
    const types = within(screen.getByTestId("closing-type-options")).getAllByRole("radio");
    expect(types.map((r) => r.getAttribute("value"))).toEqual(["ipen", "hybrid", "wet"]);
    expect(screen.queryByText(copy("closing.schedule.type.ron"))).toBeNull();
    expect(screen.getByTestId("closing-type-fallback")).toHaveTextContent(copy("closing.schedule.fallback"));
    // the default type's slots only
    expect(screen.getAllByRole("radio", { name: /2026|Nov/ })).toHaveLength(1);
    fireEvent.click(types[2]!);
    const wetSlots = screen.getAllByRole("radio").filter((r) => r.getAttribute("name")?.startsWith("slot-"));
    expect(wetSlots).toHaveLength(2);
    fireEvent.click(wetSlots[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Book this time" }));
    expect(calls[0]?.option_id).toBe("wet:2026-11-09T14");
    expect((calls[0]?.evidence as { slot_id: string }).slot_id).toBe("wet:2026-11-09T14");
  });
  it("defaultClosingType and slotsForType pick the flagged default and filter by type; cards without types keep every slot", () => {
    expect(defaultClosingType(props.closing_type_options, "wet")).toBe("wet");
    expect(defaultClosingType(props.closing_type_options, "ron")).toBe("ipen");
    expect(defaultClosingType(undefined)).toBeUndefined();
    expect(slotsForType(slots, "wet").map((s) => s.id)).toEqual(["wet:2026-11-09T10", "wet:2026-11-09T14"]);
    expect(slotsForType(slots, undefined)).toHaveLength(4);
  });
  it("the paper-path confirmation and the wet hand-off render from their copy keys", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: { date: "2026-11-09" } }, { copy_key: "closing.paper_path", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    render(<Card card={makeCard("HandoffCard", { destination: "settlement_agent", what_to_expect: "", return_state: "", what_to_expect_copy_key: "closing.wet.what_to_expect", return_state_copy_key: "closing.presign.return" }, { copy_key: "closing.wet.handoff", card_instance_id: "c-wet", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: copy("closing.paper_path", { date: "2026-11-09" }) })).toBeInTheDocument();
    expect(screen.getByText(copy("closing.wet.what_to_expect"))).toBeInTheDocument();
    expect(screen.getByText(`When it's done, you'll see: ${copy("closing.presign.return")}`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open the signing session" })).toBeNull();
  });
});

describe("32.7 rescission (T6, T7, T8)", () => {
  it("the H-8 card renders with the receipt action and a quiet 'How to cancel' link that posts the message — never a primary button", () => {
    const { onResolve } = resolver();
    const onMessage = vi.fn();
    const h8 = makeCard("DocumentCard", { document_id: "doc-h8", notice_code: "NTC_REGZ_1026_23_H8", title: "", why_you_see_this: "", requires_ack: true, esign_scope_required: "disclosures", how_to_cancel: { copy_key: "rescission.how", message_text: "How to cancel", quiet: true } }, { copy_key: "rescission.notice" });
    render(<Card card={h8} timezone={TZ} onResolve={onResolve} onMessage={onMessage} />);
    expect(screen.getByRole("heading", { name: copy("rescission.notice") })).toBeInTheDocument();
    const link = screen.getByTestId("how-to-cancel");
    expect(link).toHaveTextContent(copy("rescission.how"));
    expect(link).toHaveClass("sm-link");
    expect(link).not.toHaveClass("sm-btn-primary");
    expect(screen.getAllByRole("button").filter((b) => b.classList.contains("sm-btn-primary")).map((b) => b.textContent)).toEqual(["Confirm receipt"]);
    fireEvent.click(link);
    expect(onMessage).toHaveBeenCalledWith("How to cancel");
    expect(onResolve).not.toHaveBeenCalled();
  });
  it("the signed lines: the refinance names the cancel deadline, the purchase does not mention cancelling", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: { expires_at: "2026-11-10", date: "2026-11-12" } }, { copy_key: "signed.refi", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: { when: "2026-11-06" } }, { copy_key: "signed.purchase", status: "resolved", card_instance_id: "c-p" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: copy("signed.refi", { expires_at: "2026-11-10", date: "2026-11-12" }) })).toBeInTheDocument();
    const purchase = screen.getByRole("heading", { name: copy("signed.purchase", { when: "2026-11-06" }) });
    expect(purchase.textContent).not.toMatch(/cancel/i);
  });
  it("the cancel ChoiceCard keeps 'Keep my loan' as the accent action and the cancelled line names the refund date; Cancelled is a neutral badge", () => {
    const { onResolve, calls } = resolver();
    const choice = makeCard("ChoiceCard", { title: "", helper: "", options: [{ id: "keep", label: "Keep my loan", is_primary: true }, { id: "cancel", label: "Cancel my loan" }], command: "rescission.exercise", command_args_by_option: { cancel: { method: "portal" } }, no_command_options: ["keep"] }, { copy_key: "rescission.confirm" });
    render(<Card card={choice} timezone={TZ} onResolve={onResolve} />);
    const keep = screen.getByRole("button", { name: "Keep my loan" });
    expect(keep).toHaveClass("sm-btn-primary");
    expect(screen.getByRole("button", { name: "Cancel my loan" })).not.toHaveClass("sm-btn-primary");
    fireEvent.click(screen.getByRole("button", { name: "Cancel my loan" }));
    expect(calls[0]?.option_id).toBe("cancel");
    render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: { date: "2026-11-29" } }, { copy_key: "rescission.cancelled", status: "resolved", card_instance_id: "c-x" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: copy("rescission.cancelled", { date: "2026-11-29" }) })).toBeInTheDocument();
    expect(badgeTone("Cancelled")).toBe("neutral");
    render(<StatusBadgeView badge="Cancelled" />);
    expect(screen.getByTestId("status-badge")).toHaveAttribute("data-tone", "neutral");
  });
});

describe("32.7 funding (T9, T10)", () => {
  it("the hold shows one line and one upload ask — the effective date — with no wire detail", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("StatusCard", { state_label: "" }, { copy_key: "funding.held", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    render(<Card card={makeCard("UploadCard", { document_class: "homeowners_policy", accepted_examples: ["the declarations page"], why: "", title: "" }, { copy_key: "funding.held.insurance_effective_date", card_instance_id: "c-up" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: copy("funding.held") })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy("funding.held.insurance_effective_date") })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/wire|IMAD|warehouse|fraud/i);
  });
  it("the funded line names the prior servicer, the first payment and, as its detail, that no payment is skipped", () => {
    const { onResolve } = resolver();
    const tokens = { prior_servicer: "Partner Bank, N.A.", money: "$4,090.12", date: "2027-01-01", disbursement: "2026-11-12", month_end: "2026-12-01" };
    render(<Card card={makeCard("StatusCard", { state_label: "", copy_tokens: tokens, detail_copy_key: "funded.no_skip", next_event_label: "First payment due", next_event_at: "2027-01-01T12:00:00.000Z" }, { copy_key: "funded.refi", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: copy("funded.refi", tokens) })).toBeInTheDocument();
    expect(screen.getByTestId("status-detail")).toHaveTextContent(copy("funded.no_skip", tokens));
    expect(statusDetailLines({ detail: "literal", detail_copy_key: "funded.no_skip", detail_copy_keys: ["closing.package.cd_final"], copy_tokens: tokens })).toEqual(["literal", copy("funded.no_skip", tokens), copy("closing.package.cd_final")]);
  });
  it("the signing package list renders one line per copy key", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("StatusCard", { state_label: "", detail_copy_keys: ["closing.package.cd_final", "closing.package.rescission_notice", "closing.package.first_payment_letter"] }, { copy_key: "closing.package_items", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getAllByTestId("status-detail").map((p) => p.textContent)).toEqual([copy("closing.package.cd_final"), copy("closing.package.rescission_notice"), copy("closing.package.first_payment_letter")]);
  });
});

describe("32.7 boarding (T11, T12, T13)", () => {
  it("the autodraft ConsentCard lists every 2.3 element by its copy key, states autopay is optional, and nothing is pre-checked", () => {
    const { onResolve } = resolver();
    const elements = ["borrower", "loan", "account", "amount", "amount_variable", "timing", "first_debit", "company", "revoke", "date", "esign"].map((id) => ({ id, label_key: `consent.autodraft.element.${id === "amount_variable" ? "amount.variable" : id}`, value: id === "borrower" ? "Alex Borrower" : id === "amount" ? "$4,090.12" : "" }));
    render(<Card card={makeCard("ConsentCard", { consent_kind: "autodraft_authorization", disclosure_version_id: "AUTODRAFT-AUTHORIZATION-2026-09", scope: [], affirmation_method: "checkbox_with_text", title: "", body_text: "", requires_typed_name: true, elements, optional_statement_copy_key: "consent.autodraft.optional", optional: true }, { copy_key: "consent.autodraft.title" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: copy("consent.autodraft.title") })).toBeInTheDocument();
    expect(screen.getByTestId("consent-optional")).toHaveTextContent(copy("consent.autodraft.optional"));
    const list = screen.getByTestId("consent-elements");
    expect(within(list).getAllByRole("term").map((t) => t.textContent)).toEqual(elements.map((e) => copy(e.label_key)));
    expect(list.querySelector('[data-element="amount"] dd')).toHaveTextContent("$4,090.12");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Agree" })).toBeDisabled();
  });
  it("the servicing E-SIGN offer and the paper-until-then line render from their copy keys", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("StatusCard", { state_label: "" }, { copy_key: "statement.paper_until_esign", status: "resolved" })} timezone={TZ} onResolve={onResolve} />);
    render(<Card card={makeCard("ConsentCard", { consent_kind: "esign", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", scope: ["periodic_statements"], affirmation_method: "checkbox_with_text", title: "", body_text: "", requires_typed_name: true }, { copy_key: "consent.esign.servicing", card_instance_id: "c-es" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByRole("heading", { name: copy("statement.paper_until_esign") })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy("consent.esign.servicing") })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
  it("the Fannie Mae letter hand-off explains the letter from its copy keys and 30.4's points, with no vendor launch", () => {
    const { onResolve } = resolver();
    render(<Card card={makeCard("HandoffCard", { destination: "fannie_mae_letter", what_to_expect: "", return_state: "", what_to_expect_copy_key: "boarding.fannie_letter.what_to_expect", return_state_copy_key: "boarding.fannie_letter.return", explainer_headline: "About the letter", explainer_points: ["Fannie Mae owns the loan.", "Keep paying Supermortgage."] }, { copy_key: "boarding.fannie_letter" })} timezone={TZ} onResolve={onResolve} />);
    expect(screen.getByText(copy("boarding.fannie_letter.what_to_expect"))).toBeInTheDocument();
    expect(screen.getByText(`When it's done, you'll see: ${copy("boarding.fannie_letter.return")}`)).toBeInTheDocument();
    expect(within(screen.getByTestId("handoff-explainer")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
    expect(handoffLine("literal", "boarding.fannie_letter.return")).toBe("literal");
    expect(handoffLine("", "boarding.fannie_letter.return")).toBe(copy("boarding.fannie_letter.return"));
  });
});
