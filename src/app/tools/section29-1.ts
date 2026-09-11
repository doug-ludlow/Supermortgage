/**
 * §29.1 process-owned tools — bus tools for 29.1 defined with `defineTools("29.1", "secondary", defs)` from ../tools.ts.
 * Every tool string is one spec/registry/agents.json names for 29.1; src/app/tools.test.ts refuses the rest. Spread by
 * ./index.ts. The handlers are thin: the rules live in src/domain/secondary/ops-29-1.ts (CommitmentService — the
 * runtime service `secondary` that 21.4's `requestCommitment` also calls through the CommitmentPort); the store keeps
 * `commitments` and its children (migration 0103) as the service's projections. Guardrails encode the AI-design
 * sentences: never commit without an executed, MLO-approved lock; never a mandatory commitment, pair-off,
 * over-delivery or Sales Desk order without the officer authorization the policy requires; never commit on a
 * close-of-business or expired price; never a second open commitment on a lineage or a commitment on a TBD address;
 * never change a commitment's remittance type or execution type; never let a closed loan pass its auto-extension cap
 * without a pair-off decision escalated ≥ 5 business days earlier; never allocate a fee to the partner without the
 * documented cause; no Sales Desk orders by SM personnel unless the partner authorizes named individuals in writing.
 */
import { defineTools, compute, decision, escalate, never, needsRole, cents, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Lock } from "../../domain/application/ops-21-4.ts";
import type { LlpaTable } from "../../domain/leads-pricing/ops-20-4.ts";
import {
  CommitmentService, DEFAULT_POLICY, commitmentExpiration, committingWindow, rollExpirationToBusinessDay, passThroughRate, mandatoryPtrRange, mandatoryTolerance, netPriceForecast, executionVarianceCents,
  type Amortization, type BestEffortsRequest, type CapturePurpose, type Commitment, type CommitmentPolicy, type ExecutionChannel, type FalloutReason, type FeeDraftNotification, type FeePayer, type FnmaLoanStatus, type PewlPort, type RemittanceType, type UnderwritingMethod,
} from "../../domain/secondary/ops-29-1.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const at = (i: ToolInput, k: string, ctx: CommandContext): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optStr = (i: ToolInput, k: string): string | null => (typeof i[k] === "string" && i[k] ? String(i[k]) : null);
const obj = (i: ToolInput, k: string): Record<string, unknown> => ((i[k] as Record<string, unknown> | undefined) ?? {});
/** Feature flags (`execution.mandatory_enabled`, `secondary.after_hours_commit`) from a `flags` input or the entity store's `feature_flags` rows. */
const flagsOf = (i: ToolInput, rt: ToolRuntime): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of ["execution.mandatory_enabled", "secondary.after_hours_commit"]) { const row = rt.store.get("feature_flags", k); if (row && row.data.value !== undefined) out[k] = row.data.value; }
  return { ...out, ...obj(i, "flags") };
};
/** The runtime service `secondary` (29.1's CommitmentService; 21.4's requestCommitment goes through the same object); built over the unit of work when the runtime has not wired it. */
const svcOf = (rt: ToolRuntime, ctx: CommandContext): CommitmentService => {
  const s = rt.services.secondary; if (s instanceof CommitmentService) return s;
  const pewl = rt.services.pewl as PewlPort | undefined; const tables = rt.services.llpaTables as readonly LlpaTable[] | undefined; const policy = rt.services.secondaryPolicy as Partial<CommitmentPolicy> | undefined;
  const svc = new CommitmentService({ events: ctx.events, clock: ctx.clock, ledger: ctx.ledger, escalations: rt.escalations, ...(pewl ? { pewl } : {}), ...(tables ? { llpaTables: tables } : {}), ...(policy ? { policy } : {}) });
  (rt.services as Record<string, unknown>).secondary = svc; return svc;
};
const project = (rt: ToolRuntime, c: Commitment, ctx: CommandContext): Commitment => { rt.store.put("commitments", c.commitment_id, { ...c }, ctx.actor, ctx.now); return c; };
const lockOf = (rt: ToolRuntime, i: ToolInput): Lock | null => (typeof i.lock_id === "string" && rt.store.get("locks", i.lock_id) ? (rt.store.get("locks", i.lock_id)!.data as unknown as Lock) : null);
const view = (c: Commitment) => ({ commitment_id: c.commitment_id, commitment_id_fnma: c.commitment_id_fnma, type: c.type, status: c.status, fnma_loan_status: c.fnma_loan_status, execution_channel: c.execution_channel, application_id: c.application_id, lineage_id: c.lineage_id, lock_id: c.lock_id, underwriting_method: c.underwriting_method,
  note_rate: c.note_rate, pass_through_rate: c.pass_through_rate, ptr_range_low: c.ptr_range_low, ptr_range_high: c.ptr_range_high, remittance_type: c.remittance_type, amount_cents: c.amount_cents, max_amount_cents: c.max_amount_cents, original_amount_cents: c.original_amount_cents, remaining_balance_cents: c.remaining_balance_cents, purchased_cents: c.purchased_cents, paired_off_cents: c.paired_off_cents,
  tolerance_low_cents: c.tolerance_low_cents, tolerance_high_cents: c.tolerance_high_cents, commitment_price: c.commitment_price, quote_id_fnma: c.quote_id_fnma, quote_expires_at: c.quote_expires_at, executed_at: c.executed_at, effective_on: c.effective_on, commitment_period_days: c.commitment_period_days, expires_on: c.expires_on, original_expires_on: c.original_expires_on,
  manual_extension_days: c.manual_extension_days, auto_extension_days: c.auto_extension_days, closed_status_set_at: c.closed_status_set_at, fallout_reason: c.fallout_reason, pair_off_expected: c.pair_off_expected, dpa_exposure_until: c.dpa_exposure_until, duplicate_of_commitment_id: c.duplicate_of_commitment_id, expected_purchase_ready_date: c.expected_purchase_ready_date,
  llpa_forecast_pct: c.llpa_forecast_pct, llpa_forecast_cents: c.llpa_forecast_cents, net_price_forecast: c.net_price_forecast, proceeds_forecast_cents: c.proceeds_forecast_cents, execution_variance_cents: c.execution_variance_cents, overnight_price_change: c.overnight_price_change, queued_release_at: c.queued_release_at, confirmation_document_id: c.confirmation_document_id, sfcs_staged: c.sfcs_staged, disbursement_date: c.disbursement_date, first_payment_date: c.first_payment_date });
const beRequest = (i: ToolInput, ctx: CommandContext): BestEffortsRequest => ({
  application_id: str(i, "application_id") || ctx.applicationId || "", lock_id: str(i, "lock_id"), lineage_id: str(i, "lineage_id"), lock_status: str(i, "lock_status") || "executed", mlo_approved: i.mlo_approved !== false, loan_amount_cents: cents(i.loan_amount_cents), note_rate: str(i, "note_rate"), base_price: str(i, "base_price"), product_code: str(i, "product_code"),
  lock_expires_on: D(str(i, "lock_expires_on")), rate_set_date: D(str(i, "rate_set_date")), property_address: optStr(i, "property_address"), borrower_last_name: optStr(i, "borrower_last_name"), address_complete: i.address_complete !== false && !!optStr(i, "property_address"), du_casefile_id: optStr(i, "du_casefile_id"),
  underwriting_method: (optStr(i, "underwriting_method") as UnderwritingMethod | null) ?? (optStr(i, "du_casefile_id") ? "du" : "other"), ...(optStr(i, "du_recommendation_at") ? { du_recommendation_at: str(i, "du_recommendation_at") } : {}), ...(optStr(i, "amortization") ? { amortization: str(i, "amortization") as Amortization } : {}), ...(i.term_months !== undefined ? { term_months: num(i, "term_months") } : {}), ...(i.lpmi_bps !== undefined ? { lpmi_bps: num(i, "lpmi_bps") } : {}),
  ...(optStr(i, "remittance_type") ? { remittance_type: str(i, "remittance_type") as RemittanceType } : {}), requested_expires_on: optDate(i, "requested_expires_on"), loan_age_due_on: optDate(i, "loan_age_due_on"), disbursement_date_planned: optDate(i, "disbursement_date_planned"), dpa_acknowledged: flag(i, "dpa_acknowledged"), dpa_officer_approved: flag(i, "dpa_officer_approved"),
  forecast: (i.forecast as BestEffortsRequest["forecast"] | undefined) ?? null, seller_loan_number: optStr(i, "seller_loan_number") });
/** An officer authorization is an `officer` escalation (task officer_mandatory_authorization / officer_pair_off_approval) completed by the officer — never an input flag. */
const authorizationOf = (rt: ToolRuntime, id: string | null, task: string): { escalation_id: string; status: string } | null => {
  if (!id) return null; const e = rt.escalations.list().find((x) => x.id === id); if (!e) return null;
  return { escalation_id: e.id, status: e.kind === "officer" && e.payload.task === task && e.status === "completed" ? "approved" : "pending" };
};

export const TOOLS_29_1: readonly ToolDef[] = defineTools("29.1", "secondary", [
  // Rule 4: the Loan Pricing API quote (or a UI/Browse Prices read) stored raw with quote id and expiry; a close-of-business price is captured but never executable.
  { name: "priceForCommitment", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "product_code", "note_rate", "expires_on", "loan_amount_cents");
      const svc = svcOf(rt, ctx); const rolled = rollExpirationToBusinessDay(D(str(i, "expires_on")), svc.cal);
      const cap = svc.priceForCommitment({ commitment_id: optStr(i, "commitment_id"), product_code: str(i, "product_code"), note_rate: str(i, "note_rate"), ...(optStr(i, "pass_through_rate") ? { pass_through_rate: str(i, "pass_through_rate") } : {}), ...(optStr(i, "remittance_type") ? { remittance_type: str(i, "remittance_type") as RemittanceType } : {}),
        expires_on: rolled.expires_on, loan_amount_cents: cents(i.loan_amount_cents), purpose: (optStr(i, "purpose") as CapturePurpose | null) ?? "commitment", at: at(i, "at", ctx), ...(optStr(i, "price") ? { price: str(i, "price"), source: (optStr(i, "source") as "ui" | "browse_export" | null) ?? "ui" } : {}), ltv_pct: optStr(i, "ltv_pct"), representative_score: i.representative_score === undefined ? null : num(i, "representative_score"), ...(optStr(i, "state") ? { state: str(i, "state") } : {}) });
      rt.store.put("pewl_price_captures", cap.capture_id, { ...cap }, ctx.actor, ctx.now);
      if (cap.commitment_id) project(rt, svc.get(cap.commitment_id), ctx);
      return { ...cap, expires_on: rolled.expires_on, expiration_rolled: rolled.rolled, early_close: rolled.early_close, sweep_hhmm: rolled.sweep_hhmm, window: committingWindow(cap.captured_at, svc.policy, svc.cal).kind, pass_through_rate: cap.ptr, executable: !cap.close_of_business }; }),
    guardrails: [never("COB_PRICE_NEVER_EXECUTED", "PE–WL (00b-orig F7): close-of-business prices … may not be used to execute any commitments", (i) => flag(i, "close_of_business") && flag(i, "execute"), "a close-of-business price is captured for the mark, never executed")] },
  // Rule 1 end to end: validate the lineage, DU window, address, day limit and window; price; commit inside the quote window; store the confirmation; `commitment.executed`; 21.4 links the lock. op=release runs the after-hours / daily-limit queue at the window open.
  { name: "commitBestEfforts", kind: "act", handler: compute((i, ctx, rt) => {
      const svc = svcOf(rt, ctx); const when = at(i, "at", ctx); const flags = flagsOf(i, rt);
      if (i.op === "release") { const out = svc.releaseQueue(when, { lock: lockOf(rt, i), flags, only: optStr(i, "commitment_id") }); for (const r of out) project(rt, r.commitment, ctx); return { released: out.map((r) => ({ ...view(r.commitment), overnight_price_change: r.commitment.overnight_price_change, quote_id_fnma: r.quote?.quote_id_fnma ?? null })) }; }
      if (i.op === "position") return { position: svc.position(when), uncommitted_beyond_policy: svc.uncommittedBeyondPolicy(when) };
      need(i, "lock_id", "lineage_id", "loan_amount_cents", "note_rate", "base_price", "product_code", "lock_expires_on", "rate_set_date");
      const req = beRequest(i, ctx); if (!req.application_id) throw new RangeError("application_id is required");
      const lock = lockOf(rt, i);
      try {
        const r = svc.commitBestEfforts(req, { at: when, lock, flags });
        project(rt, r.commitment, ctx); if (lock) rt.store.put("locks", lock.lock_id, { ...lock, commitment_id: r.commitment.commitment_id }, ctx.actor, ctx.now);
        return { ...view(r.commitment), quote: r.quote ? { quote_id_fnma: r.quote.quote_id_fnma, price: r.quote.price, ptr: r.quote.ptr, quoted_at: r.quote.captured_at, quote_expires_at: r.quote.quote_expires_at, source: r.quote.source } : null, forecast: r.forecast, guardrail_results: r.guardrail_results, linked: r.linked_event?.type ?? null };
      } finally { const c = svc.byLineage(req.lineage_id).at(-1); if (c) project(rt, c, ctx); } }),
    guardrails: [never("BEST_EFFORTS_TO_MANDATORY", "Selling Guide C2-1.2-03: lenders may not change a best efforts commitment to a mandatory commitment (or vice versa)", (i) => flag(i, "convert_to_mandatory") || flag(i, "as_mandatory"), "a commitment's execution type is never switched (impossible in PE–WL — refused in code)"),
      never("SECOND_OPEN_COMMITMENT", "29.1 rule 13 / AI design: never create a second open commitment on a lineage (C2-1.2-02 duplicate commitment price adjustment)", (i) => flag(i, "force_duplicate_commitment"), "one open commitment per lineage_id"),
      never("TBD_ADDRESS", "29.1 rule 13 / AI design: never a commitment on a TBD address (PE–WL: a TBD/incomplete address commitment that falls out is subject to the DPA)", (i) => i.address_complete === false, "property address must be complete"),
      never("STALE_OR_COB_PRICE", "29.1 AI design: never commit on a close-of-business or expired price (FNMA_PEWL_COMMIT_ACCEPT_60S)", (i) => flag(i, "accept_stale_quote") || flag(i, "use_close_of_business_price"), "re-price; a stale or close-of-business price is never executed"),
      never("LOCK_NOT_APPROVED", "29.1 AI design: never commit without an executed, MLO-approved lock", (i) => i.mlo_approved === false || (typeof i.lock_status === "string" && !["executed", "confirmed"].includes(String(i.lock_status))), "the lock must be executed and approved by the MLO of record (21.4)"),
      needsRole("DPA_OFFICER_APPROVAL", "29.1 open question 8: DPA acceptances above $1,000 require the officer", (i) => flag(i, "dpa_officer_approved"), ["officer"], "an officer approval of the duplicate price adjustment is the officer's act")] },
  // Rule 7: key-data modifications (amount, product, note rate, units, seller loan number, loan status) within FNMA_C2_1_2_03_KEY_DATA_CHANGE_1BD; product/rate changes re-price at worse case.
  { name: "modifyCommitment", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "commitment_id", "changed_at", "after");
      const svc = svcOf(rt, ctx); const after = obj(i, "after");
      const m = svc.modifyCommitment({ commitment_id: str(i, "commitment_id"), changed_at: str(i, "changed_at"), reported_at: at(i, "reported_at", ctx), after: { ...after, ...(after.loan_amount_cents !== undefined ? { loan_amount_cents: cents(after.loan_amount_cents) } : {}) }, live_price_for_new_terms: optStr(i, "live_price_for_new_terms"), channel: (optStr(i, "channel") as ExecutionChannel | null) ?? "api", confirmation_document_id: optStr(i, "confirmation_document_id"), lock_id: optStr(i, "lock_id"),
        ...(i.complete_address_change !== undefined ? { complete_address_change: flag(i, "complete_address_change") } : {}), ...(i.uw_method_to_other !== undefined ? { uw_method_to_other: flag(i, "uw_method_to_other") } : {}), ...(i.ineligible !== undefined ? { ineligible: flag(i, "ineligible") } : {}) });
      rt.store.put("commitment_modifications", m.modification_id, { ...m }, ctx.actor, ctx.now); const c = project(rt, svc.get(m.commitment_id), ctx);
      return { ...m, amount_cents: c.amount_cents, max_amount_cents: c.max_amount_cents, commitment_price: c.commitment_price, note_rate: c.note_rate, pass_through_rate: c.pass_through_rate, status: c.status }; }),
    guardrails: [never("REMITTANCE_TYPE_IMMUTABLE", "C2-1.2-03: lenders may not … change the remittance type from scheduled/scheduled to actual/actual (or vice versa)", (i) => obj(i, "after").remittance_type !== undefined || obj(i, "after").type !== undefined || obj(i, "after").execution_type !== undefined, "remittance type and execution type are chosen at commitment and never changed")] },
  // Rule 9: closed status on `loan.funded` (disbursement) — the same day where possible, never later than 5:00 p.m. ET the next Fannie Mae business day; the loan becomes a mandatory obligation.
  { name: "setClosedStatus", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "commitment_id", "disbursement_date");
      const svc = svcOf(rt, ctx);
      const c = svc.setClosedStatus({ commitment_id: str(i, "commitment_id"), disbursement_date: D(str(i, "disbursement_date")), at: at(i, "at", ctx), first_payment_date: optDate(i, "first_payment_date"), loan_id: optStr(i, "loan_id") ?? ctx.loanId ?? null, ...(i.funded !== undefined ? { funded: flag(i, "funded") } : {}), ...(optStr(i, "channel") ? { channel: str(i, "channel") as ExecutionChannel } : {}) });
      return view(project(rt, c, ctx)); }),
    guardrails: [never("CLOSED_REQUIRES_DISBURSEMENT", "PE–WL glossary: closed = funds have been disbursed to the borrower(s) — consummation alone is not closed", (i) => flag(i, "consummated_only"), "closed status follows `loan.funded` (disbursement), not consummation")] },
  // Rules 10, 12: manual extensions (≤ 30 days cumulative; the fee on the 360-day count) as an operator task; auto-extensions recorded from confirmations (op=auto).
  { name: "requestExtension", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "commitment_id"); const svc = svcOf(rt, ctx);
      if (i.op === "auto") { need(i, "kind"); const e = svc.recordAutoExtension({ commitment_id: str(i, "commitment_id"), kind: str(i, "kind") as "auto_1d" | "auto_5d", at: at(i, "at", ctx), source: (optStr(i, "source") as "confirmation" | "draft" | null) ?? "confirmation", confirmation_document_id: optStr(i, "confirmation_document_id") }); rt.store.put("commitment_extensions", e.extension_id, { ...e }, ctx.actor, ctx.now); project(rt, svc.get(e.commitment_id), ctx); return { ...e, cap_on: svc.get(e.commitment_id).original_expires_on }; }
      need(i, "days");
      const e = svc.requestExtension({ commitment_id: str(i, "commitment_id"), days: num(i, "days"), at: at(i, "at", ctx), ...(optStr(i, "payer") ? { payer: str(i, "payer") as FeePayer } : {}), ...(optStr(i, "cause") ? { cause: str(i, "cause") } : {}), ...(optStr(i, "channel") ? { channel: str(i, "channel") as ExecutionChannel } : {}) });
      rt.store.put("commitment_extensions", e.extension_id, { ...e }, ctx.actor, ctx.now); const c = project(rt, svc.get(e.commitment_id), ctx);
      return { ...e, manual_extension_days: c.manual_extension_days, expires_on: c.expires_on }; }),
    guardrails: [never("FEE_ALLOCATION_NEEDS_CAUSE", "29.1 AI design: never allocate a fee to the partner without the documented cause (open question 3)", (i) => i.payer === "partner" && !optStr(i, "cause"), "a partner-borne fee needs its documented cause (custodian it selected, volume limitation, retention election)")] },
  // Rule 8: fallout classification (withdrawal / declination / ineligibility → no fee; DPA window opens); closed loans are a pair-off, never fallout.
  { name: "moveToFallout", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "commitment_id", "reason"); const svc = svcOf(rt, ctx);
      if (i.op === "expire") { const c = svc.expire({ commitment_id: str(i, "commitment_id"), at: at(i, "at", ctx) }); return view(project(rt, c, ctx)); }
      const c = svc.moveToFallout({ commitment_id: str(i, "commitment_id"), reason: str(i, "reason") as FalloutReason, at: at(i, "at", ctx), detail: optStr(i, "detail") });
      return view(project(rt, c, ctx)); }),
    guardrails: [never("NO_FEE_PASS_THROUGH", "29.1 open question 3: no Fannie Mae fee pass-through to borrowers", (i) => flag(i, "charge_borrower"), "Fannie Mae committing fees are never charged to the borrower")] },
  // Rule 11 / 12: the pair-off package (fee on max amount × price delta; carry alternative; officer approval above $2,500) and op=execute for the operator's / Sales Desk confirmation.
  { name: "preparePairOffPackage", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "commitment_id"); const svc = svcOf(rt, ctx);
      if (i.op === "execute") {
        const approval = authorizationOf(rt, optStr(i, "approval_escalation_id"), "officer_pair_off_approval");
        const po = svc.recordPairOff({ commitment_id: str(i, "commitment_id"), ...(optStr(i, "pair_off_id") ? { pair_off_id: str(i, "pair_off_id") } : {}), ...(optStr(i, "kind") ? { kind: str(i, "kind") as "lender_requested" | "automatic" } : {}), executed_at: at(i, "executed_at", ctx), confirmation_document_id: optStr(i, "confirmation_document_id"), officer_approved: approval?.status === "approved" || flag(i, "officer_approved"), ...(optStr(i, "channel") ? { channel: str(i, "channel") as "ui_operator" | "sales_desk" } : {}), ...(i.fee_cents !== undefined ? { fee_cents: cents(i.fee_cents) } : {}), ...(i.amount_cents !== undefined ? { amount_cents: cents(i.amount_cents) } : {}) });
        rt.store.put("commitment_pair_offs", po.pair_off_id, { ...po }, ctx.actor, ctx.now); project(rt, svc.get(po.commitment_id), ctx); return po;
      }
      if (i.op === "over_delivery") { need(i, "amount_cents", "market_price"); const od = svc.recordOverDelivery({ commitment_id: str(i, "commitment_id"), amount_cents: cents(i.amount_cents), market_price: str(i, "market_price"), at: at(i, "at", ctx), officer_authorized: authorizationOf(rt, optStr(i, "authorization_escalation_id"), "officer_mandatory_authorization")?.status === "approved" || flag(i, "officer_authorized") }); rt.store.put("commitment_over_deliveries", od.over_delivery_id, { ...od }, ctx.actor, ctx.now); project(rt, svc.get(od.commitment_id), ctx); return od; }
      const auth = authorizationOf(rt, optStr(i, "authorization_escalation_id"), "officer_mandatory_authorization");
      const r = svc.preparePairOffPackage({ commitment_id: str(i, "commitment_id"), ...(optStr(i, "market_price") ? { market_price: str(i, "market_price") } : {}), at: at(i, "at", ctx), ...(i.amount_cents !== undefined ? { amount_cents: cents(i.amount_cents) } : {}), certain_non_delivery: i.certain_non_delivery !== false, ...(optStr(i, "cure_probability") ? { cure_probability: str(i, "cure_probability") } : {}), ...(optStr(i, "reason") ? { reason: str(i, "reason") } : {}), ...(optStr(i, "payer") ? { payer: str(i, "payer") as FeePayer } : {}), officer_authorized: auth?.status === "approved" || flag(i, "officer_authorized"), ...(optStr(i, "channel") ? { channel: str(i, "channel") as "ui_operator" | "sales_desk" } : {}) });
      rt.store.put("commitment_pair_offs", r.pair_off_id, { ...r, decision: undefined, package: undefined }, ctx.actor, ctx.now); project(rt, svc.get(r.commitment_id), ctx); return r; }),
    guardrails: [needsRole("OFFICER_PAIR_OFF_APPROVAL", "29.1 open question 8: officer approval for pair-off / over-delivery fees > $2,500 — an officer act, never an agent assertion", (i) => flag(i, "officer_approved") || flag(i, "officer_authorized"), ["officer"], "the officer approves the pair-off in the escalation"),
      never("SALES_DESK_AUTHORIZED_TRADER", "29.1 open question 4: no Sales Desk orders by SM personnel unless the partner authorizes named individuals in writing", (i) => i.channel === "sales_desk" && !flag(i, "partner_authorized_trader"), "a Sales Desk recorded-line order needs a partner-authorized trader"),
      never("FEE_ALLOCATION_NEEDS_CAUSE", "29.1 AI design: never allocate a fee to the partner without the documented cause", (i) => i.payer === "partner" && !optStr(i, "reason"), "a partner-borne pair-off fee needs its documented cause")] },
  // Rule 12 / open question 4: the mandatory operator package (flag-gated; officer authorization; five PTRs; tolerance band; expiration on a business day) and op=execute for the confirmation.
  { name: "prepareMandatoryPackage", kind: "act", handler: compute((i, ctx, rt) => {
      const svc = svcOf(rt, ctx);
      if (i.op === "execute") { need(i, "commitment_id", "commitment_id_fnma", "price"); const c = svc.recordMandatoryExecution({ commitment_id: str(i, "commitment_id"), commitment_id_fnma: str(i, "commitment_id_fnma"), price: str(i, "price"), executed_at: at(i, "executed_at", ctx), confirmation_document_id: optStr(i, "confirmation_document_id"), ...(optStr(i, "channel") ? { channel: str(i, "channel") as "ui_operator" | "sales_desk" } : {}), expires_on: optDate(i, "expires_on") }); return view(project(rt, c, ctx)); }
      if (i.op === "purchase") { need(i, "commitment_id", "purchased_cents"); const c = svc.recordPurchase({ commitment_id: str(i, "commitment_id"), purchased_cents: cents(i.purchased_cents), at: at(i, "at", ctx), loan_id: optStr(i, "loan_id"), purchase_date: optDate(i, "purchase_date") }); return view(project(rt, c, ctx)); }
      need(i, "amount_cents", "product_code", "min_ptr", "period_days");
      const auth = authorizationOf(rt, optStr(i, "authorization_escalation_id"), "officer_mandatory_authorization") ?? ((i.officer_authorization as { escalation_id: string; status: string } | undefined) ?? null);
      const r = svc.prepareMandatoryPackage({ amount_cents: cents(i.amount_cents), product_code: str(i, "product_code"), min_ptr: str(i, "min_ptr"), period_days: num(i, "period_days"), ...(optStr(i, "remittance_type") ? { remittance_type: str(i, "remittance_type") as RemittanceType } : {}), at: at(i, "at", ctx), flags: flagsOf(i, rt), officer_authorization: auth, hedge_request_id: optStr(i, "hedge_request_id"), hbl_cap_pct: optStr(i, "hbl_cap_pct") });
      const { package: pkg, operator_escalation_id, ...c } = r; return { ...view(project(rt, c, ctx)), package: pkg, operator_escalation_id }; }),
    guardrails: [never("MANDATORY_DISABLED", "29.1 rule 1 / baseline §9: execution.mandatory_enabled=false → best efforts only", (i) => obj(i, "flags")["execution.mandatory_enabled"] === false, "mandatory execution is off for the partner"),
      needsRole("OFFICER_MANDATORY_AUTHORIZATION", "29.1 guards: mandatory executed requires an officer_mandatory_authorization escalation resolved approved — the officer's act", (i) => (i.officer_authorization as { status?: unknown } | undefined)?.status === "approved", ["officer"], "an agent cannot assert the officer's authorization; reference the completed escalation"),
      never("SALES_DESK_AUTHORIZED_TRADER", "29.1 open question 4: no Sales Desk orders by SM personnel unless the partner authorizes named individuals in writing", (i) => i.channel === "sales_desk" && !flag(i, "partner_authorized_trader"), "a Sales Desk recorded-line order needs a partner-authorized trader")] },
  // Rule 11 / 12: the live price at the moment of a pair-off, extension quote or mark (same product / PTR / remaining period).
  { name: "captureMarketPrice", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "commitment_id", "purpose"); const svc = svcOf(rt, ctx);
      const cap = svc.captureMarketPrice({ commitment_id: str(i, "commitment_id"), purpose: str(i, "purpose") as CapturePurpose, at: at(i, "at", ctx), ...(optStr(i, "price") ? { price: str(i, "price"), source: (optStr(i, "source") as "ui" | "browse_export" | null) ?? "ui" } : {}) });
      rt.store.put("pewl_price_captures", cap.capture_id, { ...cap }, ctx.actor, ctx.now); return cap; }) },
  // Rule 15: the daily Committing & Delivery Fee Draft Notifications reconciled to child rows within ±$1.00 and posted; exceptions to the officer.
  { name: "reconcileFeeDrafts", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "drafts"); const svc = svcOf(rt, ctx); const raw = i.drafts as Record<string, unknown>[]; if (!Array.isArray(raw)) throw new RangeError("drafts must be an array of Fee Draft Notifications");
      const drafts: FeeDraftNotification[] = raw.map((d) => ({ draft_id: String(d.draft_id ?? ""), notification_date: D(String(d.notification_date ?? "")), draft_date: D(String(d.draft_date ?? d.notification_date ?? "")), commitment_id_fnma: String(d.commitment_id_fnma ?? ""), fnma_loan_number: (d.fnma_loan_number as string | null | undefined) ?? null, fee_type: String(d.fee_type ?? "other") as FeeDraftNotification["fee_type"], amount_cents: cents(d.amount_cents), raw_document_id: (d.raw_document_id as string | null | undefined) ?? null }));
      const out = svc.reconcileFeeDrafts(drafts, at(i, "at", ctx));
      for (const r of out) rt.store.put("committing_fee_drafts", r.draft_id, { ...r }, ctx.actor, ctx.now);
      return { drafts: out, matched: out.filter((r) => r.status === "matched").length, exceptions: out.filter((r) => r.status === "exception").length }; }),
    guardrails: [never("FEE_ALLOCATION_NEEDS_CAUSE", "29.1 AI design: never allocate a fee to the partner without the documented cause", (i) => flag(i, "allocate_to_partner") && !optStr(i, "cause"), "a partner allocation needs its documented cause")] },
  // Nightly PE–WL / Loan Delivery status reconciliation (op=sweep runs the 4:30 p.m. ET / 12:30 early-close expiring sweep; op=operator_confirmation attaches the operator's confirmation).
  { name: "reconcilePewlStatus", kind: "write", handler: compute((i, ctx, rt) => {
      const svc = svcOf(rt, ctx);
      if (i.op === "sweep") { const r = svc.expiringSweep(at(i, "at", ctx)); for (const id of [...r.escalated, ...r.auto_extended]) project(rt, svc.get(id), ctx); return r; }
      if (i.op === "operator_confirmation") { need(i, "commitment_id", "escalation_id", "confirmation_document_id"); const e = svc.recordOperatorConfirmation({ escalation_id: str(i, "escalation_id"), commitment_id: str(i, "commitment_id"), confirmation_document_id: str(i, "confirmation_document_id"), at: at(i, "at", ctx) }); return { event: e.type, escalation_id: str(i, "escalation_id") }; }
      need(i, "commitment_id", "fnma_loan_status");
      const r = svc.reconcilePewlStatus({ commitment_id: str(i, "commitment_id"), fnma_loan_status: str(i, "fnma_loan_status") as FnmaLoanStatus, at: at(i, "at", ctx), commitment_id_fnma: optStr(i, "commitment_id_fnma"), expires_on: optDate(i, "expires_on") });
      return { ...view(project(rt, r.commitment, ctx)), mismatch: r.mismatch, escalation_id: r.escalation_id }; }) },
  // Rule 5: LLPA forecast on the matrix in force on the expected Purchase Ready date, net price, proceeds and the SFCs staged for 29.3; op=terms is the pure calculator (expiration, PTR, tolerance, variance).
  { name: "computeNetPriceForecast", kind: "write", handler: compute((i, ctx, rt) => {
      if (i.op === "terms") {
        need(i, "note_rate"); const svc = svcOf(rt, ctx);
        const exp = optDate(i, "lock_expires_on") ? commitmentExpiration(D(str(i, "lock_expires_on")), D(str(i, "effective_on") || ctx.now.slice(0, 10)), svc.policy, optDate(i, "loan_age_due_on"), svc.cal) : null;
        return { pass_through_rate: passThroughRate(str(i, "note_rate"), i.servicing_fee_bps === undefined ? DEFAULT_POLICY.servicing_fee_bps : num(i, "servicing_fee_bps"), i.lpmi_bps === undefined ? 0 : num(i, "lpmi_bps")), expiration: exp, ptr_range: optStr(i, "min_ptr") ? mandatoryPtrRange(str(i, "min_ptr")) : null, tolerance: i.original_amount_cents !== undefined ? mandatoryTolerance(cents(i.original_amount_cents)) : null,
          net: optStr(i, "commitment_price") && optStr(i, "llpa_forecast_pct") && i.upb_at_purchase_cents !== undefined ? netPriceForecast({ commitment_price: str(i, "commitment_price"), llpa_forecast_pct: str(i, "llpa_forecast_pct"), upb_at_purchase_cents: cents(i.upb_at_purchase_cents), ...(i.credits_forecast_cents !== undefined ? { credits_forecast_cents: cents(i.credits_forecast_cents) } : {}) }) : null,
          execution_variance_cents: optStr(i, "commitment_price") && optStr(i, "base_price") && i.loan_amount_cents !== undefined ? executionVarianceCents(str(i, "commitment_price"), str(i, "base_price"), cents(i.loan_amount_cents)) : null };
      }
      need(i, "commitment_id", "forecast"); const svc = svcOf(rt, ctx);
      const raw = obj(i, "forecast"); const f = { ...raw, ...(raw.value_cents !== undefined ? { value_cents: cents(raw.value_cents) } : {}), ...(raw.upb_at_purchase_cents !== undefined ? { upb_at_purchase_cents: cents(raw.upb_at_purchase_cents) } : {}), ...(raw.purchase_price_cents !== undefined && raw.purchase_price_cents !== null ? { purchase_price_cents: cents(raw.purchase_price_cents) } : {}), ...(raw.subordinate_financing_cents !== undefined ? { subordinate_financing_cents: cents(raw.subordinate_financing_cents) } : {}) } as unknown as Parameters<CommitmentService["computeNetPriceForecast"]>[0]["forecast"];
      const r = svc.computeNetPriceForecast({ commitment_id: str(i, "commitment_id"), forecast: f, at: at(i, "at", ctx) });
      project(rt, svc.get(str(i, "commitment_id")), ctx); return r; }),
    guardrails: [never("LLPA_MATRIX_BY_PURCHASE_READY", "LLPA Matrix 09.09.2026: LLPAs are calculated on the Purchase Ready date — the version in force on that date governs, never the lock date (SM_LLPA_TABLE_VERSION_GATE)", (i) => flag(i, "use_lock_date_matrix"), "the forecast selects the matrix by expected_purchase_ready_date")] },
  // Escalations: `fnma_portal_operator` (every UI-only step), partner `officer` (mandatory authorization; fees above threshold; DPA > $1,000; uncommitted > 5 business days; Sales Desk; fee-draft disputes), `compliance-sentinel` (key-data breach).
  { name: "openEscalation", kind: "act", handler: escalate("officer") },
  { name: "writeDecision", kind: "write", handler: decision() },
]);
