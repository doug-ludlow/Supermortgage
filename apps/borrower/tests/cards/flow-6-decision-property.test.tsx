/**
 * 32.6 — what the borrower SEES for the decision, property, insurance, MI and clear to close (the API facts are asserted
 * in src/domain/borrower/32-6.spec.test.ts): the Property row "No appraisal needed" (T4), the deficiency NoticeCard naming
 * the deductible only through `copy_token_keys` (T8), the pre-funding hold StatusCard `ctc.final_review` without "QC"
 * (T12), the MI ComparisonCard's four plans with one cancellation line each resolved through `title_key` / `value_key`
 * (T10), the "Clear to close" badge (T11) and the SQ-08 HandoffCard to the HOA management company (T7).
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/cards";
import { PropertySection, StatusBadgeView, badgeTone } from "@/components/record/sections";
import { columnTitle, propertyStateLabel, resolveCopyTokens, rowValue } from "@/components/flows/6-decision-property";
import { copy } from "@/lib/copy";
import type { AnyCardInstance } from "@/lib/types/cards";
import type { BorrowerRecord } from "@/lib/types/record";
import { makeCard, resolver, TZ } from "./helpers";
import refinance from "@/fixtures/refinance.json";

const base = refinance.record as unknown as BorrowerRecord;
const user = userEvent.setup();

function renderCard(card: AnyCardInstance) {
  const r = resolver();
  const utils = render(<Card card={card} timezone={TZ} onResolve={r.onResolve} />);
  return { ...utils, ...r };
}

describe("32.6 Property section (T4)", () => {
  it("value acceptance reads 'No appraisal needed' from the API label, and from the state when the label is missing", () => {
    const withLabel: BorrowerRecord = { ...base, property: { tbd: false, property_type: "sfr", units: 1, valuation: { method: "value_acceptance", status: "no_appraisal_needed", label: "No appraisal needed" } } };
    const { unmount } = render(<PropertySection r={withLabel} />);
    expect(screen.getByText("No appraisal needed")).toBeInTheDocument();
    unmount();
    const noLabel: BorrowerRecord = { ...base, property: { tbd: false, property_type: "sfr", units: 1, valuation: { method: "value_acceptance", status: "no_appraisal_needed" }, flood: { status: "not_in_flood_zone" }, hazard: { status: "deficient" }, project_review: { status: "pending_docs" } } };
    render(<PropertySection r={noLabel} />);
    expect(screen.getByText("No appraisal needed")).toBeInTheDocument();
    expect(screen.getByText("Not in a flood zone")).toBeInTheDocument();
    expect(screen.getByText("Insurance — one thing to fix")).toBeInTheDocument();
    expect(screen.getByText("Waiting on HOA documents")).toBeInTheDocument();
    expect(propertyStateLabel("valuation", "something_else")).toBe("something_else");
  });
});

describe("32.6 deficiency NoticeCard (T8)", () => {
  it("names the failing element and its fix through copy_token_keys — the deductible only, no other element", () => {
    const card = makeCard("NoticeCard", { notice_code: "SM_INSURANCE_DEFICIENCY", title: "", rendered_document_id: "doc-def-1", plain_language: "", copy_token_keys: { element: "insurance.deficient.element.deductible", fix: "insurance.deficient.fix.deductible" } }, { copy_key: "insurance.deficient", status: "resolved" });
    renderCard(card);
    const tokens = resolveCopyTokens(card.props);
    expect(tokens).toEqual({ element: "the deductible", fix: "a deductible no more than 5% of the coverage amount" });
    const text = copy("insurance.deficient", tokens);
    expect(text).toContain("the deductible");
    expect(text).toContain("5%");
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    for (const other of ["mortgagee", "carrier", "effective date", "coverage form", "flood"]) expect(document.body.textContent?.toLowerCase()).not.toContain(other);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("a literal copy_tokens value stands when no key is named; an unknown key falls back to the key itself", () => {
    expect(resolveCopyTokens({ copy_tokens: { element: "the roof" } })).toEqual({ element: "the roof" });
    expect(resolveCopyTokens({ copy_token_keys: { element: "no.such.key" } })).toEqual({ element: "no.such.key" });
    expect(resolveCopyTokens({})).toBeUndefined();
  });
});

describe("32.6 pre-funding hold StatusCard (T12)", () => {
  it("ctc.final_review says a final review is in progress and never says QC", () => {
    renderCard(makeCard("StatusCard", { state_label: "" }, { copy_key: "ctc.final_review", status: "resolved" }));
    const text = copy("ctc.final_review");
    expect(screen.getByRole("heading", { name: text })).toBeInTheDocument();
    expect(text).not.toMatch(/QC|quality control/i);
    expect(document.body.textContent).not.toMatch(/QC/);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("32.6 MI ComparisonCard (T10)", () => {
  const plans = ["bpmi_monthly", "single", "split", "lpmi"] as const;
  const card = makeCard("ComparisonCard", {
    title: "",
    command: "mi.selectPlan",
    columns: plans.map((id) => ({ id, title: "", title_key: `mi.plan.${id}`, rows: [
      { label: "Monthly cost", value: id === "lpmi" ? "$0.00/mo" : "$380.27/mo", emphasis: true },
      { label: "Upfront cost", value: id === "single" ? "$12,880.00" : "$0.00" },
      { label: "Rate", value: id === "lpmi" ? "6.375%" : "6.125%" },
      { label: "When it can be cancelled", value: "", value_key: `mi.cancel.${id}` },
    ] })),
    command_args_by_option: Object.fromEntries(plans.map((id) => [id, { plan: id, quote_id: `Q-${id}` }])),
  }, { copy_key: "mi.compare.title" });

  it("renders four plans titled from title_key with one cancellation line each from value_key", () => {
    renderCard(card);
    const heads = screen.getAllByRole("heading", { level: 4 });
    expect(heads.map((h) => h.textContent)).toEqual(plans.map((id) => copy(`mi.plan.${id}`)));
    for (const id of plans) expect(screen.getByText(copy(`mi.cancel.${id}`))).toBeInTheDocument();
    expect(copy("mi.cancel.bpmi_monthly")).toMatch(/80%/);
    expect(copy("mi.cancel.lpmi")).toMatch(/higher rate/);
    expect(screen.getAllByText("$380.27/mo")).toHaveLength(3);
    expect(columnTitle({ title: "Given", title_key: "mi.plan.lpmi" })).toBe("Given");
    expect(rowValue({ value: "", value_key: "mi.cancel.split" })).toBe(copy("mi.cancel.split"));
  });
  it("choosing the lender-paid column resolves with option_id lpmi", async () => {
    const { calls } = renderCard(card);
    await user.click(screen.getByRole("button", { name: `Choose ${copy("mi.plan.lpmi")}` }));
    expect(calls[0]?.option_id).toBe("lpmi");
  });
});

describe("32.6 clear to close badge (T11)", () => {
  it("'Clear to close' is a positive badge; 'Decision letter sent' is neutral (read-only Record)", () => {
    render(<StatusBadgeView badge="Clear to close" oneLiner={copy("ctc.reached")} />);
    const badge = screen.getByTestId("status-badge");
    expect(badge).toHaveAttribute("data-tone", "positive");
    expect(within(badge).getByText("Clear to close")).toBeInTheDocument();
    expect(badgeTone("Decision letter sent")).toBe("neutral");
    expect(badgeTone("Counteroffer")).toBe("caution");
  });
});

describe("32.6 SQ-08 HandoffCard (T7)", () => {
  it("the HOA management company handoff names the destination, has no action and no vendor marker", () => {
    renderCard(makeCard("HandoffCard", { destination: "hoa_management", what_to_expect: "The management company sends it straight to us.", return_state: "Project review complete." }, { copy_key: "hoa.docs.handoff", status: "resolved" }));
    expect(screen.getByRole("heading", { name: "Your HOA management company" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("fake-vendor")).toBeNull();
  });
});
