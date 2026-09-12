/**
 * 32.3 — what the borrower SEES at entry and through the five-minute qualification (the API facts are asserted in
 * src/domain/borrower/32-3.spec.test.ts): the automation disclosure as the first assistant line with its marker (T1),
 * the 20.3 "are you a real person?" script line (T2), the contract ConfirmCard's `document_extraction` provenance (T29),
 * the ProfileCard that submits nothing until every required tap is made (T13), the Stripe-extracted identity ConfirmCard
 * whose edit becomes the borrower's own value (T5).
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/cards";
import { Thread } from "@/components/shell/Thread";
import { renderMessageBody } from "@/components/flows/3-entry";
import { copy } from "@/lib/copy";
import type { AnyCardInstance } from "@/lib/types/cards";
import type { ThreadMessage } from "@/lib/types/record";
import { makeCard, resolver, TZ } from "./helpers";

const user = userEvent.setup();
const noop = () => {};
const msg = (over: Partial<ThreadMessage>): ThreadMessage => ({ message_id: "m-1", conversation_id: "c-1", at: "2026-10-19T14:00:00.000Z", sender: "agent", sender_label: "Supermortgage", channel: "app", subject: {}, voice_turn: false, delivery: { sent: true, delivered: true, read: false }, ...over });
const threadProps = (messages: ThreadMessage[], cards: Record<string, AnyCardInstance> = {}) => ({ messages, cards, timezone: TZ, partnerLegalName: "Partner Bank", showSubjectLabels: false, wide: false, cardProps: { onOpen: noop, onLaunchVendor: async () => ({ vendor_session_id: "vs-FAKE" }), onUpload: async () => ({ document_id: "doc-FAKE" }) }, resolve: async () => {}, cardErrors: {} });

describe("32.3 E2 — the automation disclosure (T1, T2)", () => {
  it("the {{copy:entry.disclosure.first}} row is the session's first row on the API and is NOT a line in the log (32.16 §2.0: the footer is the disclosure); the next line renders plainly, no sender label, no badge", () => {
    render(<Thread {...threadProps([msg({ message_id: "m-2", at: "2026-10-19T14:00:05.000Z", body_text: "{{copy:thread.assistant_placeholder.intake}}" }), msg({ body_text: "{{copy:entry.disclosure.first}}", automation_marker: true })])} />);
    const log = screen.getByRole("log"); const lines = within(log).getAllByText((_, el) => el?.className === "sm-msg-body");
    expect(lines).toHaveLength(1);
    expect(log.textContent).not.toContain(copy("entry.disclosure.first", { "partner.legal_name": "Partner Bank" }));
    expect(log.textContent).not.toContain("working for Partner Bank");
    expect(within(log).queryByText("automated")).toBeNull();
    expect(lines[0]).toHaveTextContent(copy("thread.assistant_placeholder.intake"));
    expect(lines[0]!.textContent).not.toContain("{{copy:");
  });
  it("the 20.3 T11 reply line reads as the script, spoken lines carry the voice tag, and an unknown key stays visible", () => {
    render(<Thread {...threadProps([msg({ body_text: "{{copy:entry.disclosure.real_person}}", channel: "voice", voice_turn: true })])} />);
    expect(screen.getByText(/automated assistant\. I can bring a person in right now/)).toBeInTheDocument();
    expect(screen.getAllByTestId("provenance").some((p) => /voice/.test(p.textContent ?? ""))).toBe(true);   // provenance is an aria detail, not a visible row (32.16 §2.1)
    expect(renderMessageBody("{{copy:not.a.real.key}}").text).toBe("not.a.real.key");
    expect(renderMessageBody("{{copy:thread.card_affirmative_deep_link}} /d/abc").text).toMatch(/\/d\/abc$/);
    expect(renderMessageBody("plain words").copy_key).toBeNull();
  });
});

describe("32.3 E5/C1 — ConfirmCard provenance (T5, T29)", () => {
  it("shows each field's source; an edit resolves with the borrower's value beside the platform's sources", async () => {
    const r = resolver();
    render(<Card card={makeCard("ConfirmCard", { fields: [{ path: "legal_name", label: "Legal name", value: "Jane Q. Public", source: "stripe_identity" }, { path: "date_of_birth", label: "Date of birth", value: "1990-04-01", source: "stripe_identity" }, { path: "current_address", label: "Current address", value: "14 Elm St", source: "stripe_identity" }], commits_to: "application_borrowers" }, { copy_key: "identity.confirm.title" })} timezone={TZ} onResolve={r.onResolve} />);
    expect(screen.getAllByText("(from your ID)")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const addr = screen.getByLabelText("Current address"); await user.clear(addr); await user.type(addr, "22 Elm St");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    const ev = r.calls[0]!.evidence as { fields: { path: string; value_confirmed: string; source: string }[]; edited: boolean };
    expect(ev.edited).toBe(true); expect(ev.fields.find((f) => f.path === "current_address")!.value_confirmed).toBe("22 Elm St"); expect(ev.fields.find((f) => f.path === "legal_name")!.value_confirmed).toBe("Jane Q. Public");
  });
  it("a contract's extracted fields carry the document_extraction provenance and no confirmation until the tap", () => {
    render(<Card card={makeCard("ConfirmCard", { fields: [{ path: "property_address", label: "Property address", value: "9 Saguaro Way, Phoenix, AZ 85018", source: "document_extraction", confirmed_at: null }, { path: "purchase_price_cents", label: "Purchase price", value: "52500000", source: "document_extraction", confirmed_at: null }], commits_to: "purchase_contracts" }, { copy_key: "contract.confirm" })} timezone={TZ} onResolve={resolver().onResolve} />);
    expect(screen.getAllByText("(from your contract)")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
  });
});

describe("32.3 R4 — ProfileCard (T13)", () => {
  it("submits nothing until every required field has a tap; then resolves with the answers", async () => {
    const r = resolver();
    render(<Card card={makeCard("ProfileCard", { title: "A few things only you can tell us.", fields: [{ path: "citizenship_status", label: "Citizenship", required: true, options: [{ id: "us_citizen", label: "U.S. citizen" }, { id: "permanent_resident", label: "Permanent resident" }] }, { path: "marital_status", label: "Marital status", required: true, options: [{ id: "married", label: "Married" }, { id: "unmarried", label: "Unmarried" }] }] }, { copy_key: "profile.title" })} timezone={TZ} onResolve={r.onResolve} />);
    const submit = screen.getByRole("button", { name: "Save answers" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText("Married"));
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText("U.S. citizen"));
    expect(submit).toBeEnabled();
    await user.click(submit);
    const ev = r.calls[0]!.evidence as { fields: { path: string; value: string }[] };
    expect(ev.fields.find((f) => f.path === "citizenship_status")!.value).toBe("us_citizen");
  });
});
