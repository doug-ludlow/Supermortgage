/**
 * 32.10 — Servicing: hardship and delinquency: the flow-specific UI. The shell renders whatever cards the API creates
 * (src/runtime/borrower/flows/10-hardship.ts); these helpers carry the one thing a plain card cannot: the Loan section's
 * hardship rows — the trial payment line (`hardship.tpp`), the paused period (`hardship.forb`), the late-charge hold
 * (`hardship.plan.on_hold_fees`), a written cease (`hardship.cease.confirmed`) and the bankruptcy statement form
 * (`hardship.bk.statements`) — every sentence from the copy library, every date the owning process's own.
 */
import { copy } from "@/lib/copy";
import { formatDate, formatMoney } from "@/lib/format";
import type { HardshipBlock } from "@/lib/types/record";

const day = (d: string): string => formatDate(`${d}T12:00:00Z`, "UTC");

/** The Loan section rows (label, value) for the hardship block; nothing when there is nothing to say. */
export function hardshipRows(h: HardshipBlock | undefined): [string, string][] {
  if (!h) return [];
  const rows: [string, string][] = [];
  if (h.tpp && (h.status === "tpp_active" || h.status === "offer_pending")) rows.push(["Trial period plan", copy("hardship.tpp", { n: String(h.tpp.n), money: formatMoney(h.tpp.amount_cents), date: day(h.tpp.due_on) })]);
  if (h.forbearance && h.forbearance.status === "active") {
    rows.push(["Forbearance", copy("hardship.forb", { date: day(h.forbearance.term_end) })]);
    if (h.forbearance.late_charges_suppressed) rows.push(["Late charges", copy("hardship.plan.on_hold_fees")]);
  }
  if (h.offer && h.offer.status === "pending" && h.offer.accept_by) rows.push(["Offer", copy("hardship.offer.deadline", { date: day(h.offer.accept_by) })]);
  if (h.cease) rows.push(["Contact", copy("hardship.cease.confirmed")]);
  if (h.bankruptcy?.statement_mode && h.bankruptcy.statement_mode !== "standard") rows.push(["Statements", copy("hardship.bk.statements")]);
  return rows;
}

/** The state word a Loan-section caller may lead with (01 §4 catalogue: "On a plan" / "Paused"). */
export function hardshipStateLabel(h: HardshipBlock | undefined): string | null {
  if (!h) return null;
  if (h.status === "forbearance") return "Paused";
  if (h.status === "tpp_active" || h.status === "plan_accepted") return "On a plan";
  return null;
}
