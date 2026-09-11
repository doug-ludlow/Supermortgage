/**
 * Component tests — one per CardKind (13 §1: every card kind renders from its schema; state
 * transitions update in place; keyboard operability; aria-live announcements).
 */
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/cards";
import { CARD_KINDS, type AnyCardInstance } from "@/lib/types/cards";
import { makeCard, resolver, TZ } from "./helpers";
import { parseDollarsToCents } from "@/components/cards/PaymentCard";
import refinance from "@/fixtures/refinance.json";
import servicing from "@/fixtures/servicing.json";

const user = userEvent.setup();

function renderCard(card: AnyCardInstance, extra: Partial<Parameters<typeof Card>[0]> = {}) {
  const r = resolver();
  const utils = render(<Card card={card} timezone={TZ} onResolve={r.onResolve} {...extra} />);
  return { ...utils, ...r };
}

describe("StatusCard", () => {
  it("renders state, next event as <time>, no action", () => {
    renderCard(makeCard("StatusCard", { state_label: "Application received Oct 20, 2026", next_event_label: "Your Loan Estimate arrives by", next_event_at: "2026-10-23T23:59:59-07:00" }, { status: "resolved" }));
    expect(screen.getByRole("heading", { name: "Application received Oct 20, 2026" })).toBeInTheDocument();
    expect(screen.getByText("Oct 23, 2026").tagName).toBe("TIME");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ChoiceCard", () => {
  it("resolves on tap with option evidence, one primary action, keyboard operable", async () => {
    const card = makeCard("ChoiceCard", {
      title: "Want to move forward?",
      options: [
        { id: "proceed", label: "Proceed", is_primary: true },
        { id: "not_yet", label: "Not yet" },
      ],
      command: "intent.record",
      command_args_by_option: { proceed: {}, not_yet: {} },
      disclosure_version_shown: "disc-le-1",
    });
    const { calls } = renderCard(card);
    const primary = screen.getAllByRole("button").filter((b) => b.className.includes("sm-btn-primary"));
    expect(primary).toHaveLength(1);
    await user.tab();
    expect(screen.getByRole("button", { name: "Proceed" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(calls[0]?.option_id).toBe("proceed");
    expect(calls[0]?.evidence).toMatchObject({ option_id: "proceed", disclosure_version_shown: "disc-le-1" });
  });
  it("collapses to a receipt when resolved and announces via aria-live", () => {
    const card = makeCard("ChoiceCard", { title: "Loan type", options: [{ id: "fixed_30", label: "30-year fixed" }], command: "x", command_args_by_option: {} });
    const { rerender } = renderCard(card);
    rerender(<Card card={{ ...card, status: "resolved", evidence: { option_id: "fixed_30", tapped_at: "2026-10-20T10:31:00-07:00" } }} timezone={TZ} onResolve={async () => {}} />);
    expect(screen.getByTestId("card-receipt")).toHaveTextContent("Loan type — 30-year fixed");
    expect(screen.getByTestId("card-live")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("card-live")).toHaveTextContent("You chose 30-year fixed");
  });
});

describe("ConfirmCard", () => {
  it("shows fields with sources and resolves with per-field confirmation evidence; Edit marks edited", async () => {
    const card = makeCard("ConfirmCard", { title: "Your home — right?", fields: [{ path: "application_properties.estimated_value", label: "Estimated value", value: "$712,000.00", source: "avm" }], commits_to: "application_properties.estimated_value" });
    const { calls } = renderCard(card);
    expect(screen.getByText("(our estimate)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Estimated value" });
    await user.clear(input);
    await user.type(input, "$700,000.00");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(calls[0]?.evidence).toMatchObject({ edited: true, fields: [{ path: "application_properties.estimated_value", value_confirmed: "$700,000.00", source: "avm" }] });
  });
});

describe("ConnectCard", () => {
  it("shows the FAKE vendor marker, launches, moves to in_progress, and offers the upload fallback", async () => {
    const card = makeCard("ConnectCard", { vendor: "truv_income", purpose_text: "Connect your payroll", what_we_get: ["employer"], fallback: { label: "Send paystubs instead" }, state: "not_started" });
    const { calls } = renderCard(card, { onLaunchVendor: async () => ({ vendor_session_id: "sess-1" }) });
    expect(screen.getByTestId("fake-vendor")).toHaveTextContent("FAKE vendor · Truv");
    await user.click(screen.getByRole("button", { name: "Connect with Truv" }));
    expect(calls[0]?.evidence).toMatchObject({ vendor: "truv_income", vendor_session_id: "sess-1", outcome: "in_progress" });
    expect(screen.getByTestId("connect-state")).toHaveTextContent("In progress");
  });
  it("T-X-12: a vendor error shows failed + fallback and no error code", async () => {
    const card = makeCard("ConnectCard", { vendor: "plaid_assets", purpose_text: "Connect your bank", what_we_get: [], fallback: { label: "Upload statements" }, state: "not_started" });
    renderCard(card, {
      onLaunchVendor: async () => {
        throw new Error("PLAID_ERR_500");
      },
    });
    await user.click(screen.getByRole("button", { name: "Connect with Plaid" }));
    expect(screen.getByTestId("connect-state")).toHaveTextContent("Couldn't connect — we'll take documents instead");
    expect(screen.queryByText(/PLAID_ERR/)).toBeNull();
    expect(screen.getByRole("button", { name: "Upload statements" })).toBeInTheDocument();
  });
});

describe("ConsentCard", () => {
  it("esign: checkbox + typed name required; evidence carries text hash and party", async () => {
    const card = makeCard("ConsentCard", { consent_kind: "esign", disclosure_version_id: "cdv-esign-3", scope: ["origination_disclosures"], affirmation_method: "checkbox_with_text", title: "Get your documents electronically", body_text: "E-SIGN statement…", footer_text: "Saying yes in chat or on a call doesn't count — check the box and type your name.", requires_typed_name: true, verification_state: "none" });
    const { calls } = renderCard(card);
    const agree = screen.getByRole("button", { name: "Agree" });
    expect(agree).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(agree).toBeDisabled();
    await user.type(screen.getByLabelText("Type your full name to sign"), "Maya Chen");
    expect(agree).toBeEnabled();
    await user.click(agree);
    expect(calls[0]?.evidence).toMatchObject({ consent_kind: "esign", disclosure_version_id: "cdv-esign-3", method: "checkbox_with_text", party_id: "party-1", typed_name: "Maya Chen" });
    expect((calls[0]?.evidence as { text_hash: string }).text_hash).toMatch(/^fnv1a:/);
    expect(screen.getByText(/doesn't count/)).toBeInTheDocument();
  });
  it("ai_disclosure_ack is a single tap", async () => {
    const card = makeCard("ConsentCard", { consent_kind: "ai_disclosure_ack", disclosure_version_id: "cdv-ai-1", scope: [], affirmation_method: "single_tap", title: "Automated assistant", body_text: "I'm an automated assistant.", requires_typed_name: false });
    const { calls } = renderCard(card);
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(calls[0]?.evidence).toMatchObject({ method: "single_tap" });
  });
});

describe("DocumentCard", () => {
  it("requires_ack → Confirm receipt resolves with esign_confirmed; viewer links to /app/doc/{id}", async () => {
    const card = makeCard("DocumentCard", { document_id: "doc-le-v1", disclosure_id: "disc-le-1", notice_code: "NTC_REGZ_1026_37_LE", title: "Your Loan Estimate", why_you_see_this: "Confirming receipt starts the timeline.", requires_ack: true, esign_scope_required: "origination_disclosures" });
    const { calls } = renderCard(card);
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute("href", "/app/doc/doc-le-v1");
    await user.click(screen.getByRole("button", { name: "Confirm receipt" }));
    expect(calls[0]?.evidence).toMatchObject({ receipt_evidence: "esign_confirmed" });
  });
  it("no ack → no button", () => {
    renderCard(makeCard("DocumentCard", { document_id: "doc-hcl", title: "Counseling list", why_you_see_this: "Required.", requires_ack: false, esign_scope_required: "origination_disclosures" }));
    expect(screen.queryByRole("button", { name: "Confirm receipt" })).toBeNull();
  });
});

describe("ComparisonCard", () => {
  it("renders columns from pre-formatted values, marks recommended, resolves like a ChoiceCard, stub on wide", async () => {
    const card = (refinance.cards as AnyCardInstance[]).find((c) => c.kind === "ComparisonCard")!;
    const { calls } = renderCard(card);
    expect(screen.getByRole("heading", { level: 4, name: /45 days · recommended/ })).toBeInTheDocument();
    expect(document.querySelector('.sm-column[data-recommended="true"] h4')).toHaveTextContent("45 days");
    expect(screen.getByText("$3,402.62/mo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose 45 days" }));
    expect(calls[0]?.option_id).toBe("lock_45");
    await user.click(screen.getByRole("button", { name: "Keep floating" }));
    expect(calls[1]?.option_id).toBe("float");
  });
  it("stub shows 'see options →' on ≥1024", () => {
    const card = (refinance.cards as AnyCardInstance[]).find((c) => c.kind === "ComparisonCard")!;
    renderCard(card, { comparisonStub: true });
    expect(screen.getByRole("button", { name: "see options →" })).toBeInTheDocument();
  });
});

describe("ChecklistCard", () => {
  it("lists owners and statuses; owner=you items open their card", async () => {
    const card = (refinance.cards as AnyCardInstance[]).find((c) => c.kind === "ChecklistCard")!;
    const opened: unknown[] = [];
    renderCard(card, { onOpen: (t) => void opened.push(t) });
    expect(screen.getAllByText("You")).toHaveLength(2);
    expect(screen.getByText("Third party")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(opened[0]).toEqual({ card_instance_id: "card-r3-truv" });
    expect(screen.getByTestId("card-live")).toHaveAttribute("aria-live", "polite");
  });
});

describe("UploadCard", () => {
  it("uploads a file through onUpload then resolves; mismatch copy renders", async () => {
    const card = makeCard("UploadCard", { document_class: "homeowners_policy", accepted_examples: ["declarations page"], why: "We need your policy.", freshness_hint: "current policy", mismatch: { detected: "paystub", expected: "homeowners policy" } });
    const uploaded: string[] = [];
    const { calls, container } = renderCard(card, {
      onUpload: async (f) => {
        uploaded.push(f.name);
        return { document_id: "d1" };
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("This looks like a paystub; we need a homeowners policy.");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "policy.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByTestId("card-receipt", {}, { timeout: 2000 }).catch(() => undefined);
    expect(uploaded).toEqual(["policy.pdf"]);
    expect(calls[0]?.evidence).toMatchObject({ document_class: "homeowners_policy", file_name: "policy.pdf" });
  });
});

describe("ExplanationCard", () => {
  it("requires min length and typed name; evidence carries text hash + attestation", async () => {
    const card = makeCard("ExplanationCard", { subject: "Inquiry from Desert Credit Union on Sep 3", prompt: "Did it result in a new account?", min_length: 10 });
    const { calls } = renderCard(card);
    const btn = screen.getByRole("button", { name: "Send explanation" });
    expect(btn).toBeDisabled();
    await user.type(screen.getByLabelText(/Your explanation/), "No new account — I was shopping for a car loan.");
    await user.type(screen.getByLabelText(/Type your full name/), "Maya Chen");
    await user.click(btn);
    expect(calls[0]?.evidence).toMatchObject({ attestation: "Maya Chen" });
    expect((calls[0]?.evidence as { text_hash: string }).text_hash).toMatch(/^fnv1a:/);
  });
});

describe("ScheduleCard", () => {
  it("radio slots, resolves with slot id; RON purpose shows FAKE vendor marker", async () => {
    const card = makeCard("ScheduleCard", { purpose: "ron_session", title: "Pick your signing time", slots: [{ id: "s1", starts_at: "2026-11-06T10:00:00-07:00", ends_at: "2026-11-06T10:30:00-07:00" }, { id: "s2", starts_at: "2026-11-06T14:00:00-07:00", ends_at: "2026-11-06T14:30:00-07:00" }] });
    const { calls } = renderCard(card);
    expect(screen.getByTestId("fake-vendor")).toHaveTextContent("RON platform");
    expect(screen.getByRole("button", { name: "Book this time" })).toBeDisabled();
    await user.click(screen.getAllByRole("radio")[1]!);
    await user.click(screen.getByRole("button", { name: "Book this time" }));
    expect(calls[0]?.evidence).toMatchObject({ slot_id: "s2" });
  });
});

describe("PaymentCard", () => {
  it("keeps money as cents strings; masks accounts; totals with bigint", async () => {
    const card = makeCard("PaymentCard", { mode: "one_time", amount_default_cents: "318234", amount_editable: true, date_options: ["2026-09-11", "2026-09-16"], accounts: [{ id: "a1", last4: "4417", label: "Checking" }], add_account: true, include_late_charge_option: { late_charge_cents: "12500" } });
    const { calls } = renderCard(card);
    expect(screen.getByText("Checking ••••4417")).toBeInTheDocument();
    expect(screen.getByTestId("payment-total")).toHaveTextContent("$3,182.34");
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByTestId("payment-total")).toHaveTextContent("$3,307.34");
    await user.click(screen.getByRole("button", { name: "Pay now" }));
    expect(calls[0]?.evidence).toMatchObject({ amount_cents: "330734", include_late_charge: true, account_id: "a1", date: "2026-09-11" });
  });
  it("parses dollars text to cents without floats", () => {
    expect(parseDollarsToCents("2,314.5")).toBe(231450n);
    expect(parseDollarsToCents("0.1")).toBe(10n);
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("1.234")).toBeNull();
  });
});

describe("InviteCard", () => {
  it("collects contact fields and resolves with the role", async () => {
    const card = makeCard("InviteCard", { party_role: "co_borrower", title: "Add Sam as a co-borrower", contact_fields: ["first_name", "email"] });
    const { calls } = renderCard(card);
    await user.type(screen.getByLabelText("First name"), "Sam");
    await user.type(screen.getByLabelText("Email"), "sam@example.com");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(calls[0]?.evidence).toMatchObject({ party_role: "co_borrower", contact: { first_name: "Sam", email: "sam@example.com" } });
  });
});

describe("HandoffCard", () => {
  it("RON destination shows FAKE marker and a launch action; mail letter has no action", async () => {
    const ron = makeCard("HandoffCard", { destination: "ron_platform", what_to_expect: "About 15–20 minutes with a notary.", return_state: "Signed" });
    const { calls, unmount } = renderCard(ron);
    expect(screen.getByTestId("fake-vendor")).toHaveTextContent("RON platform");
    await user.click(screen.getByRole("button", { name: "Open the signing session" }));
    expect(calls[0]?.option_id).toBe("launch");
    unmount();
    renderCard(makeCard("HandoffCard", { destination: "fannie_mae_letter", what_to_expect: "A letter is coming.", return_state: "Nothing changes." }));
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("OfferCard", () => {
  it("renders rates from decimal strings, money from cents, and Yes / Not now / Never", async () => {
    const card = makeCard("OfferCard", { refi_opportunity_id: "opp-1", current_rate: "7.000", offered_rate: "6.125", apr: "6.201", new_pi_payment_cents: "340262", monthly_savings_cents: "37630", costs_to_borrower_cents: "0", lender_legal_name: "Saguaro Home Lending, LLC", mlo_name: "Dana Whitfield", mlo_nmlsr_id: "2210987", expires_at: "2026-11-01T00:00:00-07:00", not_a_commitment_text: "This is not a commitment to lend;", rates_change_daily_text: "rates change daily." });
    const { calls } = renderCard(card);
    expect(screen.getByText("7.000%")).toBeInTheDocument();
    expect(screen.getAllByText("6.125%").length).toBeGreaterThan(0);
    expect(screen.getByText("$376.30/mo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(calls[0]?.evidence).toMatchObject({ decision: "not_now" });
  });
});

describe("NoticeCard", () => {
  it("renders the template's plain-language block and the rendered document link; mailed shows Mailed date", () => {
    renderCard(makeCard("NoticeCard", { notice_code: "NTC_REGB_1002_9_NOIA", title: "What's missing", rendered_document_id: "doc-noia", plain_language: "We need the items in this notice by Nov 3, 2026.", template_version: "v2", channel: "mail", mailed_at: "2026-10-22T00:00:00-07:00" }, { status: "resolved" }));
    expect(screen.getByTestId("notice-plain-language")).toHaveTextContent("We need the items in this notice");
    expect(screen.getByRole("link", { name: /Open the notice/ })).toHaveAttribute("href", "/app/doc/doc-noia");
    expect(screen.getByText(/Mailed Oct 22, 2026/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("PersonCard", () => {
  it("shows role, name, credentials and a tel link", () => {
    renderCard(makeCard("PersonCard", { role: "continuity_of_contact_team", name: "Team Saguaro", reach: "(602) 555-0142" }, { status: "resolved" }));
    expect(screen.getByRole("heading", { name: "Your team: Team Saguaro" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "(602) 555-0142" })).toHaveAttribute("href", "tel:6025550142");
  });
});

describe("ProfileCard", () => {
  it("no default counts as an answer; every field needs a tap before saving", async () => {
    const card = makeCard("ProfileCard", { title: "A few things only you can tell us.", fields: [{ path: "citizenship", label: "Citizenship", required: true, options: [{ id: "us", label: "U.S. citizen" }, { id: "pr", label: "Permanent resident" }] }, { path: "dependents", label: "Dependents", required: true, input: "number" }] });
    const { calls } = renderCard(card);
    const save = screen.getByRole("button", { name: "Save answers" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "U.S. citizen" }));
    expect(save).toBeDisabled();
    await user.type(screen.getByRole("spinbutton", { name: "Dependents" }), "2");
    await user.click(save);
    expect((calls[0]?.evidence as { fields: { path: string; value: string }[] }).fields).toEqual([expect.objectContaining({ path: "citizenship", value: "us" }), expect.objectContaining({ path: "dependents", value: "2" })]);
  });
});

describe("DemographicsCard", () => {
  it("evidence carries only collection_method + answered_at; values ride separately; 'I do not wish to provide' everywhere", async () => {
    const card = makeCard("DemographicsCard", { collection_method: "internet", statement_text: "The prescribed statement.", ethnicity: [{ id: "hispanic", label: "Hispanic or Latino", sub: [{ id: "mexican", label: "Mexican" }] }, { id: "not_hispanic", label: "Not Hispanic or Latino" }], race: [{ id: "asian", label: "Asian" }, { id: "white", label: "White" }], sex: [{ id: "female", label: "Female" }, { id: "male", label: "Male" }], available: true });
    const { calls } = renderCard(card);
    expect(screen.getAllByLabelText("I do not wish to provide")).toHaveLength(3);
    await user.click(screen.getByRole("checkbox", { name: "Hispanic or Latino" }));
    await user.click(screen.getByRole("checkbox", { name: "Mexican" }));
    await user.click(screen.getByRole("checkbox", { name: "White" }));
    await user.click(screen.getByRole("radio", { name: "Female" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const ev = calls[0]?.evidence as Record<string, unknown>;
    expect(ev.collection_method).toBe("internet");
    expect(ev.answers).toEqual({ ethnicity: ["hispanic", "mexican"], race: ["white"], sex: "female" });
  });
  it("unavailable before applications.status >= started", () => {
    renderCard(makeCard("DemographicsCard", { collection_method: "internet", statement_text: "", ethnicity: [], race: [], sex: [], available: false }));
    expect(screen.getByText(/once your application has started/)).toBeInTheDocument();
  });
});

describe("every CardKind", () => {
  it("has a component and both fixtures render every card without throwing", () => {
    const seen = new Set<string>();
    for (const c of [...(refinance.cards as AnyCardInstance[]), ...(servicing.cards as AnyCardInstance[])]) {
      const { unmount } = render(<Card card={c} timezone={TZ} onResolve={async () => {}} />);
      seen.add(c.kind);
      unmount();
    }
    expect(CARD_KINDS).toHaveLength(19);
    expect([...seen].every((k) => (CARD_KINDS as string[]).includes(k))).toBe(true);
  });
  it("every card exposes aria-live=polite and a labelled article", () => {
    const card = makeCard("StatusCard", { state_label: "Hello" });
    const { container } = renderCard(card);
    const article = container.querySelector("article")!;
    expect(article).toHaveAttribute("aria-labelledby");
    expect(within(article).getByTestId("card-live")).toHaveAttribute("aria-live", "polite");
  });
});
