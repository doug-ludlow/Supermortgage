/**
 * DELTA-37 (docs/ux/18 §2.4 review): the amount card's edits on Review — `amountEdits` and `fieldsEvidence` over a card that asks
 * what the cash is for. Pure: nothing is posted here (commitReview's resolve is driven by 32.19-T5/T12 in the browser).
 */
import { describe, expect, it } from "vitest";
import { amountEdits, fieldsEvidence, StepError } from "@/components/apply/wire";
import { CASH_OUT_PURPOSES, EMPTY, type Draft } from "@/components/apply/apply-model";
import { copy, copyOptions } from "@/lib/copy";
import type { AnyCardInstance } from "@/lib/types/cards";

const refi = (o: Partial<Draft>): Draft => ({ ...EMPTY, intent: "refinance", balance: "500000", ...o });
const amountCard = (cashOut: boolean): AnyCardInstance => ({
  card_instance_id: "card-amount", conversation_id: "conv-1", party_id: "party-1", subject: { application_id: "app-1" }, kind: "ConfirmCard", status: "pending", created_by: "agent:intake", copy_key: "refi.loan_amount.confirm", created_at: "2026-10-20T10:00:00-07:00",
  props: { title: "", fields: [{ path: "loan_amount_sought", label: "Loan amount", value: "", source: "borrower" }, ...(cashOut ? [{ path: "cash_out_purpose", label: "What the cash is for", value: "", source: "borrower" as const, options: CASH_OUT_PURPOSES.map((id) => ({ id, label: id })) }] : [])], commits_to: "applications.loan_amount_sought", money_paths: ["loan_amount_sought"], required_paths: cashOut ? ["loan_amount_sought", "cash_out_purpose"] : ["loan_amount_sought"] },
} as AnyCardInstance);

describe("the amount card's edits on a cash-out (DELTA-37)", () => {
  it("carries the balance + cash out and what the cash is for (a MISMO id) — the four ids in the copy library's option order", () => {
    expect(amountEdits(refi({ refiGoal: "cash", cashOut: "60000", cashOutPurpose: "DebtConsolidation" }), false)).toEqual({ loan_amount_sought: "56000000", cash_out_purpose: "DebtConsolidation" });
    expect(CASH_OUT_PURPOSES).toEqual(["DebtConsolidation", "HomeImprovement", "Education", "Cash"]);
    expect(copyOptions("apply.property.cash_out_purpose")).toEqual(["Pay off other debts", "Improve the home", "Pay for school", "Other / keep the cash"]);
    expect(copy("apply.property.cash_out_purpose")).toBe("What the cash is for");
    for (const id of CASH_OUT_PURPOSES) expect(amountEdits(refi({ refiGoal: "cash", cashOut: "0", cashOutPurpose: id }), false)["cash_out_purpose"]).toBe(id);
  });
  it("refuses an empty purpose before anything is posted — apply.review.required, rendered as copy, never a code", () => {
    let caught: unknown; try { amountEdits(refi({ refiGoal: "cash", cashOut: "60000" }), false); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StepError); expect((caught as StepError).copyKey).toBe("apply.review.required"); expect(copy((caught as StepError).copyKey)).toBe("Fill in the numbers above first.");
    // a reloaded draft whose goal was not seeded still learns the ask from the card's required paths
    expect(() => amountEdits(refi({ refiGoal: "lower" }), false, ["loan_amount_sought", "cash_out_purpose"])).toThrow(StepError);
    expect(amountEdits(refi({ refiGoal: "lower", cashOutPurpose: "Cash" }), false, ["loan_amount_sought", "cash_out_purpose"])).toEqual({ loan_amount_sought: "50000000", cash_out_purpose: "Cash" });
  });
  it("carries no purpose on a limited cash-out or a purchase, whatever the draft holds", () => {
    expect(amountEdits(refi({ refiGoal: "lower", cashOutPurpose: "Cash" }), false)).toEqual({ loan_amount_sought: "50000000" });
    expect(amountEdits(refi({ refiGoal: "faster" }), false)).toEqual({ loan_amount_sought: "50000000" });
    expect(amountEdits({ ...EMPTY, intent: "purchase", price: "650000", down: "130000", cashOutPurpose: "Cash" }, true)).toEqual({ loan_amount_sought: "52000000" });
    expect(amountEdits(refi({ balance: "" }), false)).toEqual({});   // the card's own figure stands (commitReview then requires one)
  });
  it("lands on the card's field as the borrower's own (source borrower, edited) in the API's evidence shape", () => {
    const ev = fieldsEvidence(amountCard(true), amountEdits(refi({ refiGoal: "cash", cashOut: "60000", cashOutPurpose: "HomeImprovement" }), false, ["loan_amount_sought", "cash_out_purpose"]), "2026-10-20T17:00:00.000Z");
    expect(ev.evidence.edited).toBe(true);
    expect(ev.evidence.fields).toEqual([
      { path: "loan_amount_sought", value_confirmed: "56000000", source: "borrower", confirmed_at: "2026-10-20T17:00:00.000Z" },
      { path: "cash_out_purpose", value_confirmed: "HomeImprovement", source: "borrower", confirmed_at: "2026-10-20T17:00:00.000Z" },
    ]);
    // a card without the field (a limited cash-out) gets only the amount
    expect((fieldsEvidence(amountCard(false), amountEdits(refi({}), false), "2026-10-20T17:00:00.000Z").evidence.fields as { path: string }[]).map((f) => f.path)).toEqual(["loan_amount_sought"]);
  });
});
