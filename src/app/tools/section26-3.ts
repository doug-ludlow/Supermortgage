/**
 * §26.3 process-owned tools — bus tools for 26.3 defined with `defineTools("26.3", "funder", defs)` from ../tools.ts.
 * Every tool string must be one spec/registry/agents.json names for 26.3; src/app/tools.test.ts refuses the rest.
 * Spread by ./index.ts.
 *
 * The `funder` agent (spec "AI agent design"): evaluateFundingConditions (op=evaluate|waive), computeDates, computePerDiem,
 * decideInterestMode, buildFundingWorksheet, reconcileToSettlementStatement, scoreBecIndicators, prepareWire
 * (op=prepare|release|accept|settle|reject|return — release is the funding_approver's human step), runFourEyesChecks,
 * requestWarehouseAdvance (= authorizeFunding: every gate re-asserted, `funding.requested`/`funding.authorized` emitted,
 * op=advance_approved), notifySettlementAgent (op=notify|disbursement_authorization|agent_receipt|resync),
 * confirmDisbursement (→ `loan.funded`), postLedger, openUnwind (op=open|step|complete|cancel), writeDecision.
 * Guardrails encode the paragraph: never releases a wire; never accepts wire instructions from e-mail; never waives a
 * regulatory gate; never funds before `rescission_expires_at` unless an officer-accepted waiver or the escrow pre-fund
 * exception; never changes the first payment date or note figures (re-draw through 26.1); never funds an unreconciled
 * worksheet; never a second wire without `officer`; never funds under Form B economics. State lives in the entity store
 * (`fundings`, `funding_conditions`, `funding_worksheets`, `funding_wires`, `funding_unwinds`); every event goes through
 * ops-26-3.ts so the 26.3 clocks arm and close.
 */
import { defineTools, compute, decision, never, needsRole, str, num, flag, cents, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { ToolRuntime } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { computeDates, computePerDiem, decideInterestMode, buildFundingWorksheet, reconcileToSettlementStatement, recordReconciliation, evaluateFundingConditions, recordConditionsEvaluated, assertWaivable, openFunding, requestFunding, authorizeFunding, recordAdvanceApproved, scoreBecIndicators, recordBecHold, prepareWire, recordWirePrepared, runFourEyesChecks, releaseWire, acceptWire, settleWire, rejectWire, returnWire, confirmAgentReceipt, issueDisbursementAuthorization, notifySettlementAgent, confirmDisbursement, resyncDates, postFundingLedger, partnerMirrorLines, openUnwind, executeUnwindStep, completeUnwind, cancelFunding, funderDecisionRecord, documentsNotReturned, holdFunding, FundingRefused, WAIVABLE_FC, RULE_SETS_26_3,
  type Funding, type FundingCalendar, type FundingConditions, type ConditionFacts, type FundingWorksheet, type FundingWire, type VerifiedWireRecord, type FundingUnwind, type FcCode, type Waiver, type CancelReason, type UnwindTrigger, type DisbursementSource, type InboundInstruction, type TransactionType } from "../../domain/closing/ops-26-3.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`26.3 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("26.3 tool needs application_id (every 26.3 event carries it so the funding clocks arm under origination context)"); return a; };
const dateIn = (i: ToolInput, k: string): PlainDate => D(str(i, k));
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] ? D(str(i, k)) : null);
const obj = <T>(i: ToolInput, k: string): T | null => (i[k] && typeof i[k] === "object" ? (i[k] as T) : null);
const list = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const fundingOf = (rt: ToolRuntime, i: ToolInput): Funding => { need(i, "funding_id"); const r = rt.store.get("fundings", str(i, "funding_id")); if (!r) throw new RangeError(`no fundings row ${str(i, "funding_id")} — run requestWarehouseAdvance op=open (or computeDates op=open) first`); return r.data as unknown as Funding; };
const wireOf = (rt: ToolRuntime, id: string): FundingWire => { const r = rt.store.get("funding_wires", id); if (!r) throw new RangeError(`no funding_wires row ${id}`); return r.data as unknown as FundingWire; };
const putFunding = (rt: ToolRuntime, ctx: CommandContext, f: Funding): void => { rt.store.put("fundings", f.funding_id, f as unknown as Record<string, unknown>, ctx.actor, ctx.now); };
const putWire = (rt: ToolRuntime, ctx: CommandContext, w: FundingWire): void => { rt.store.put("funding_wires", w.wire_id, w as unknown as Record<string, unknown>, ctx.actor, ctx.now); };
const at = (i: ToolInput, ctx: CommandContext, k = "at"): string => str(i, k) || ctx.now;
const big = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as T; };
const isOfficer = (a: Actor): boolean => a.kind === "human" && a.role === "officer";

export const TOOLS_26_3: readonly ToolDef[] = defineTools("26.3", "funder", [
  { name: "computeDates", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "state", "transaction_type", "time_zone");
      const application_id = appOf(i, ctx);
      const cal: FundingCalendar = computeDates({ application_id, state: str(i, "state"), transaction_type: str(i, "transaction_type") as TransactionType, time_zone: str(i, "time_zone"), consummation_at: (i.consummation_at as string | undefined) ?? null, rescindable: i.rescindable !== false && str(i, "transaction_type") !== "purchase", waiver_accepted_on: optDate(i, "waiver_accepted_on"), hold_through_mail_allowance: flag(i, "hold_through_mail_allowance"), tx_50a6_expires_on: optDate(i, "tx_50a6_expires_on"), review_completed_on: optDate(i, "review_completed_on"), recording_confirmed_on: optDate(i, "recording_confirmed_on"), record_before_fund: flag(i, "record_before_fund"), closing_date: optDate(i, "closing_date"), funding_type_override: (i.funding_type as "wet" | "dry" | undefined) ?? null, scheduled_funding_date: optDate(i, "scheduled_funding_date") });
      if (i.op === "open") {
        need(i, "funding_id", "partner_id", "partner_loan_number", "gross_loan_cents", "note_rate_pct");
        const f = openFunding({ funding_id: str(i, "funding_id"), application_id, closing_id: (i.closing_id as string | undefined) ?? null, partner_id: str(i, "partner_id"), partner_loan_number: str(i, "partner_loan_number"), calendar: cal, gross_loan_cents: cents(i.gross_loan_cents), note_rate_pct: str(i, "note_rate_pct"), interest: { borrower_elected_credit: flag(i, "borrower_elected_credit"), note_first_payment_date: optDate(i, "note_first_payment_date") }, legal_form: (i.warehouse_legal_form as Funding["legal_form"] | undefined) ?? "secured_loan_to_partner", escrow_prefund: flag(i, "escrow_prefund") });
        putFunding(rt, ctx, f);
        const r = requestFunding(ctx.events, f, at(i, ctx));
        return { calendar: cal, funding: f, event_id: r.event.id };
      }
      return cal; }),
    guardrails: [never("NO_FUNDING_BEFORE_RESCISSION_EXPIRY", "26.3 guardrails / §1026.23(c): never funds before `rescission_expires_at` unless a waiver was accepted by the officer or the escrow pre-fund exception is approved", (i) => i.fund_before_expiry === true && !i.waiver_accepted_on && !(i.escrow_prefund === true && i.officer_prefund_approval_id), "funding before rescission expiry needs an officer-accepted waiver (25.3) or the officer-approved escrow pre-fund exception")] },
  { name: "computePerDiem", kind: "act", handler: compute((i) => {
      need(i, "gross_loan_cents", "note_rate_pct", "disbursement_date");
      const r = computePerDiem(cents(i.gross_loan_cents), str(i, "note_rate_pct"), dateIn(i, "disbursement_date"));
      const { unrounded_product_cents: _u, ...artifact } = r;   // the unrounded product never leaves the reconciliation note
      return { ...artifact, reconciliation_note: `unrounded product ${r.unrounded_product_cents} cents not used (${r.convention})` }; }),
    guardrails: [never("PER_DIEM_CONVENTION", "26.3 rule 2: per-diem rounded once, then × days (365_rounded_per_diem); 360 only where a state form requires", (i) => i.per_diem_basis !== undefined && Number(i.per_diem_basis) !== 365 && !i.state_form_requires_360, "per_diem_basis 360 needs a state/investor form requirement (26.3-Q6)")] },
  { name: "decideInterestMode", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "disbursement_date", "gross_loan_cents", "note_rate_pct");
      const d = decideInterestMode({ disbursement_date: dateIn(i, "disbursement_date"), gross_loan_cents: cents(i.gross_loan_cents), note_rate_pct: str(i, "note_rate_pct"), window_days: i.window_days === undefined ? 7 : num(i, "window_days"), borrower_elected_credit: flag(i, "borrower_elected_credit"), note_first_payment_date: optDate(i, "note_first_payment_date"), note_maturity_date: optDate(i, "note_maturity_date") });
      const application_id = appOf(i, ctx);
      const events: { id: string }[] = [ctx.events.append({ type: "funding.interest_mode.decided", applicationId: application_id, actor: ctx.actor, occurredAt: at(i, ctx), payload: { application_id, source: "origination", mode: d.mode, days: d.mode === "interest_credit" ? d.interest_credit_days : d.prepaid_days, per_diem_cents: String(d.per_diem_cents), amount_cents: String(d.mode === "interest_credit" ? d.interest_credit_cents : d.prepaid_interest_cents), first_payment_date: d.first_payment_date, redraw_required: d.redraw_required, refusal: d.refusal } })];
      if (d.redraw_required) events.push(ctx.events.append({ type: "funding.redraw.requested", applicationId: application_id, actor: ctx.actor, occurredAt: at(i, ctx), payload: { application_id, source: "origination", to_process: "26.1", redraw_reason: "date_change", first_payment_date: d.first_payment_date, maturity_date_expected: d.maturity_date_expected } }));
      if (i.funding_id && rt.store.get("fundings", str(i, "funding_id"))) putFunding(rt, ctx, { ...fundingOf(rt, i), interest: d, delivery_window_compressed: d.delivery_window_compressed });
      return { ...d, event_ids: events.map((e) => e.id) }; }),
    guardrails: [never("NO_FIRST_PAYMENT_OVERRIDE", "26.3 guardrails: never changes the first payment date or note figures — it re-draws through 26.1", (i) => i.override_first_payment_date !== undefined || i.override_maturity_date !== undefined || i.override_note_amount_cents !== undefined, "the first payment date and note figures are computed; a mismatch opens a 26.1 re-draw (date_change)")] },
  { name: "evaluateFundingConditions", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "funding_id", "facts");
      const application_id = appOf(i, ctx);
      const facts = obj<ConditionFacts>(i, "facts")!;
      const waivers = [...(facts.waivers ?? []), ...list<Waiver>(i, "waivers")];
      if (i.op === "waive") { need(i, "code", "reason"); assertWaivable(str(i, "code") as FcCode, ctx.actor.role ?? ctx.actor.kind); waivers.push({ code: str(i, "code") as FcCode, waived_by: ctx.actor.role as Waiver["waived_by"], reason: str(i, "reason"), at: ctx.now }); }
      const c: FundingConditions = evaluateFundingConditions(str(i, "funding_id"), { ...facts, as_of: facts.as_of || ctx.now, waivers });
      rt.store.put("funding_conditions", c.checklist_id, c as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      const ev = recordConditionsEvaluated(ctx.events, application_id, c, at(i, ctx));
      let held: string | null = null;
      if (c.blocking_codes.length && rt.store.get("fundings", str(i, "funding_id"))) { const f = fundingOf(rt, i); if (f.status !== "held" && f.status !== "pending_conditions") { const h = holdFunding(ctx.events, f, `conditions_failed:${c.blocking_codes.join(",")}`, at(i, ctx)); putFunding(rt, ctx, h.funding); held = h.funding.hold_reason; } }
      if (i.signing_on && facts.execution && !facts.execution.package_returned) { const d = documentsNotReturned({ signing_on: dateIn(i, "signing_on"), time_zone: str(i, "time_zone") || "America/Phoenix", as_of: at(i, ctx), package_returned: false }); if (d.stage === "escalate_settlement_agent") rt.escalations.open({ kind: "settlement_agent", applicationId: application_id, severity: "sev2", payload: { funding_id: str(i, "funding_id"), reason: "executed package not returned", return_deadline_at: d.return_deadline_at } }, ctx.actor); if (d.stage === "notify_title_underwriter") { rt.escalations.open({ kind: "officer", applicationId: application_id, severity: "sev2", payload: { funding_id: str(i, "funding_id"), reason: "executed package not returned — CPL notice to the title underwriter; cancel and re-schedule", notify: "title_underwriter" } }, ctx.actor); } return { ...c, event_id: ev.id, held, documents: d }; }
      return { ...c, event_id: ev.id, held }; }),
    guardrails: [never("REGULATORY_GATE_NOT_WAIVABLE", "26.3 rule 1: a regulatory gate is never waivable — only FC_RECORDING_CONFIRMED, FC_COMMITMENT_LIVE (soft) and FC_CD_ACK may be waived", (i) => i.op === "waive" && !!i.code && !(WAIVABLE_FC as readonly string[]).includes(String(i.code)), "only the three waivable items may be waived, by the funding_approver with a reason"),
      needsRole("WAIVER_BY_FUNDING_APPROVER", "26.3 rule 1: waivers by funding_approver with a reason", (i) => i.op === "waive", ["funding_approver", "officer"], "the agent never waives a funding condition"),
      never("NO_EMAIL_EVIDENCE", "26.3 rule 1: every item resolves from platform state — the agent never accepts an e-mail assertion as evidence", (i) => i.evidence_source === "email", "e-mail assertions are not evidence for a funding condition")] },
  { name: "buildFundingWorksheet", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "funding_id", "version", "cd_version", "gross_loan_cents", "prepaid_interest_cents", "escrow_deposit_cents", "lender_credits_cents");
      const ws: FundingWorksheet = buildFundingWorksheet({ funding_id: str(i, "funding_id"), version: num(i, "version"), cd_version: num(i, "cd_version"), settlement_statement_document_id: (i.settlement_statement_document_id as string | undefined) ?? null, gross_loan_cents: cents(i.gross_loan_cents), prepaid_interest_cents: cents(i.prepaid_interest_cents), interest_credit_cents: cents(i.interest_credit_cents), escrow_deposit_cents: cents(i.escrow_deposit_cents), lender_retained_fees_cents: cents(i.lender_retained_fees_cents), lender_credits_cents: cents(i.lender_credits_cents), informational: list<{ line_code: string; description: string; amount_cents: bigint; cd_reference?: string | null }>(i, "informational").map((l) => big(l, ["amount_cents"])) });
      rt.store.put("funding_worksheets", ws.worksheet_id, ws as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      if (rt.store.get("fundings", ws.funding_id)) putFunding(rt, ctx, { ...fundingOf(rt, i), worksheet: ws });
      return ws; }) },
  { name: "reconcileToSettlementStatement", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "funding_id", "worksheet_id", "agent_requested_net_cents");
      const application_id = appOf(i, ctx);
      const wsr = rt.store.get("funding_worksheets", str(i, "worksheet_id")); if (!wsr) throw new RangeError(`no funding_worksheets row ${str(i, "worksheet_id")}`);
      const r = reconcileToSettlementStatement(big(wsr.data as unknown as FundingWorksheet, ["gross_loan_cents", "lender_retained_cents", "lender_credits_cents", "interest_credit_cents", "net_wire_cents"]), cents(i.agent_requested_net_cents), { at: at(i, ctx), run_id: ctx.run?.runId ?? `${ctx.actor.kind}:${ctx.actor.id}`, explanation: (i.explanation as string | undefined) ?? null });
      rt.store.put("funding_worksheets", r.worksheet.worksheet_id, r.worksheet as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      const ev = recordReconciliation(ctx.events, application_id, r, at(i, ctx));
      let funding: Funding | null = rt.store.get("fundings", str(i, "funding_id")) ? fundingOf(rt, i) : null;
      if (funding) { funding = { ...funding, worksheet: r.worksheet, net_wire_cents: r.worksheet.net_wire_cents }; if (r.hold.held && funding.status !== "held" && funding.status !== "pending_conditions") funding = holdFunding(ctx.events, funding, "figures_variance", at(i, ctx)).funding; putFunding(rt, ctx, funding); }
      if (r.hold.held) rt.escalations.open({ kind: "settlement_agent", applicationId: application_id, severity: "sev3", payload: { funding_id: str(i, "funding_id"), variance_cents: String(r.worksheet.variance_cents), reason: r.hold.reason } }, ctx.actor);
      return { ...r, event_id: ev.id }; }) },
  { name: "scoreBecIndicators", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "instruction", "funding_date");
      const s = scoreBecIndicators(obj<InboundInstruction>(i, "instruction")!, dateIn(i, "funding_date"), str(i, "time_zone") || "America/New_York");
      if (!s.hold || !i.funding_id || !rt.store.get("fundings", str(i, "funding_id"))) return s;
      const application_id = appOf(i, ctx);
      const r = recordBecHold(ctx.events, fundingOf(rt, i), s, at(i, ctx)); putFunding(rt, ctx, r.funding);
      rt.escalations.open({ kind: s.officer_and_fraud_case ? "officer" : "funding_approver", applicationId: application_id, severity: s.officer_and_fraud_case ? "sev1" : "sev2", payload: { funding_id: str(i, "funding_id"), indicators: [...s.indicators], callback_number_source: s.callback_number_source, earliest_release_after_confirmation: s.earliest_release_after_confirmation } }, ctx.actor);
      return { ...s, event_ids: r.events.map((e) => e.id) }; }) },
  { name: "runFourEyesChecks", kind: "act", handler: compute((i) => {
      need(i, "prepared_hash", "amount_cents", "record", "funding_date");
      return runFourEyesChecks({ prepared_hash: str(i, "prepared_hash"), amount_cents: cents(i.amount_cents), worksheet_net_cents: i.worksheet_net_cents === undefined ? null : cents(i.worksheet_net_cents), record: obj<VerifiedWireRecord>(i, "record")!, as_of: str(i, "as_of") || new Date().toISOString(), funding_date: dateIn(i, "funding_date") }); }) },
  { name: "prepareWire", kind: "act", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "prepare";
      const f = fundingOf(rt, i);
      if (op === "prepare") {
        need(i, "wire_id", "record", "instructions_hash", "value_date", "run_id", "borrower_last_name", "property_short", "funding_account_ref_hash");
        const existing = f.wire_id ? wireOf(rt, f.wire_id) : null;
        const w = prepareWire({ wire_id: str(i, "wire_id"), funding: f, record: big(obj<VerifiedWireRecord>(i, "record")!, []), instructions_hash: str(i, "instructions_hash"), instructions_source: (str(i, "instructions_source") || "verified_record") as "verified_record" | "email" | "portal", value_date: dateIn(i, "value_date"), prepared_at: at(i, ctx, "prepared_at"), run_id: str(i, "run_id"), editors: list<string>(i, "editors"), borrower_last_name: str(i, "borrower_last_name"), property_short: str(i, "property_short"), funding_account_ref_hash: str(i, "funding_account_ref_hash"), closing_documents: list<{ kind: string; assignee?: string | null }>(i, "closing_documents"), replacement_for_missing_wire: flag(i, "replacement_for_missing_wire"), officer_approval_id: (i.officer_approval_id as string | undefined) ?? null, existing_wire: existing });
        const r = recordWirePrepared(ctx.events, f, w); putWire(rt, ctx, w); putFunding(rt, ctx, r.funding);
        rt.escalations.open({ kind: "funding_approver", applicationId: f.application_id, severity: "sev2", payload: { funding_id: f.funding_id, wire_id: w.wire_id, amount_cents: String(w.amount_cents), four_eyes_check: w.four_eyes_check, sla: "SM_O73_DUAL_CONTROL_RELEASE_1H" } }, ctx.actor);
        return { wire: w, event_id: r.event.id };
      }
      need(i, "wire_id"); const w = wireOf(rt, str(i, "wire_id"));
      if (op === "release") { need(i, "bank_ref"); const r = releaseWire(ctx.events, f, big(w, ["amount_cents"]), { by: ctx.actor, released_at: at(i, ctx, "released_at"), bank_ref: str(i, "bank_ref") }); putWire(rt, ctx, r.wire); putFunding(rt, ctx, r.funding); return { wire: r.wire, cutoff: r.cutoff, event_ids: r.events.map((e) => e.id) }; }
      if (op === "accept") { need(i, "imad"); const r = acceptWire(ctx.events, f, big(w, ["amount_cents"]), { imad: str(i, "imad"), accepted_at: at(i, ctx, "accepted_at") }); putWire(rt, ctx, r.wire); putFunding(rt, ctx, r.funding); return { wire: r.wire, event_id: r.event.id }; }
      if (op === "settle") { need(i, "omad"); const r = settleWire(ctx.events, w, { omad: str(i, "omad"), settled_at: at(i, ctx, "settled_at") }); putWire(rt, ctx, r.wire); return { wire: r.wire, event_id: r.event.id }; }
      if (op === "reject") { need(i, "reason"); const r = rejectWire(ctx.events, f, w, { reason: str(i, "reason"), at: at(i, ctx) }); putWire(rt, ctx, r.wire); putFunding(rt, ctx, r.funding); return { wire: r.wire, event_id: r.event.id }; }
      if (op === "return") { need(i, "returned_cents"); const r = returnWire(ctx.events, f, w, { returned_cents: cents(i.returned_cents), returned_at: at(i, ctx, "returned_at"), matched_advance_id: (i.matched_advance_id as string | undefined) ?? f.warehouse_advance_id }); putWire(rt, ctx, r.wire); putFunding(rt, ctx, r.funding); return { wire: r.wire, event_id: r.event.id }; }
      throw new RangeError(`prepareWire: unknown op ${op}`); }),
    humanRoles: ["funding_approver", "officer", "ops_analyst"],
    guardrails: [needsRole("AGENT_NEVER_RELEASES", "26.3 guardrails: the funder agent may prepare but never release; the funding_approver releases in the bank channel (dual control)", (i) => i.op === "release", ["funding_approver"], "release is the funding_approver's human step"),
      never("NO_EMAIL_INSTRUCTIONS", "26.3 rule 7: never an account first seen by e-mail; instructions come from the 24.4 verified record", (i) => i.instructions_source === "email", "wire instructions from e-mail are never prepared"),
      never("NO_SECOND_WIRE", "26.3 rule 7: never sends a second wire for a 'missing' wire without officer approval — bank trace with OMAD", (i) => i.replacement_for_missing_wire === true && !i.officer_approval_id, "a replacement wire needs officer approval"),
      never("NO_FORM_B", "26.3 rule 9: never funds under Form B economics (purchase_at_settlement) absent an officer + attorney decision record (31.1-T9)", (i) => i.warehouse_legal_form === "purchase_at_settlement" && !i.officer_attorney_decision_id, "table_funding_form_not_approved")] },
  { name: "requestWarehouseAdvance", kind: "act", handler: compute((i, ctx, rt) => {
      const f = fundingOf(rt, i);
      if (i.op === "advance_approved") { need(i, "advance_id"); const g = recordAdvanceApproved(f, str(i, "advance_id")); putFunding(rt, ctx, g); return { funding: g }; }
      need(i, "conditions", "ptf", "cash_to_close");
      const a = authorizeFunding(ctx.events, f, { at: at(i, ctx), conditions: obj<FundingConditions>(i, "conditions")!, rescission: obj(i, "rescission"), fraud_hold: obj(i, "fraud_hold"), ptf: obj(i, "ptf")!, cash_to_close: obj<Record<string, unknown>>(i, "cash_to_close")!, gifts: list(i, "gifts"), sale_proceeds: obj(i, "sale_proceeds"), qm: obj(i, "qm"), is_hoepa: flag(i, "is_hoepa"), legal_form_decision_id: (i.officer_attorney_decision_id as string | undefined) ?? null, decision_roles: list<string>(i, "decision_roles"), officer_prefund_approval_id: (i.officer_prefund_approval_id as string | undefined) ?? null });
      putFunding(rt, ctx, a.funding);
      return { funding: a.funding, advance_request: a.advance_request, gates_asserted: a.gates_asserted, event_ids: a.events.map((e) => e.id) }; }),
    guardrails: [never("NO_UNRECONCILED_WORKSHEET", "26.3 guardrails: never funds a loan whose worksheet does not reconcile", (i) => i.worksheet_reconciled === false, "reconcile the worksheet to the consummated CD and the settlement statement first"),
      never("NO_FORM_B", "26.3 rule 9 / 31.1-T9: `funding.authorized` is refused with `table_funding_form_not_approved` under purchase_at_settlement without an officer + attorney decision record", (i) => i.warehouse_legal_form === "purchase_at_settlement" && !i.officer_attorney_decision_id, "table_funding_form_not_approved"),
      never("NO_FUNDING_BEFORE_RESCISSION_EXPIRY", "26.3 guardrails / §1026.23(c)", (i) => i.fund_before_expiry === true && !i.waiver_id && !i.officer_prefund_approval_id, "funding before rescission expiry needs an officer-accepted waiver or the escrow pre-fund exception")] },
  { name: "notifySettlementAgent", kind: "act", handler: compute((i, ctx, rt) => {
      const f = fundingOf(rt, i); const op = str(i, "op") || "notify";
      if (op === "disbursement_authorization") { need(i, "execution_review_passed_at", "funding_number"); const e = issueDisbursementAuthorization(ctx.events, f, { execution_review_passed_at: str(i, "execution_review_passed_at"), issued_at: at(i, ctx, "issued_at"), channel: (str(i, "channel") || "portal") as "portal", funding_number: str(i, "funding_number") }); return { event_id: e.id }; }
      if (op === "agent_receipt") { need(i, "funds_received_by_agent_at"); const r = confirmAgentReceipt(ctx.events, f, { funds_received_by_agent_at: str(i, "funds_received_by_agent_at"), channel: (str(i, "channel") || "portal") as "portal", confirmed_by: str(i, "confirmed_by") || "settlement_agent" }); putFunding(rt, ctx, r.funding); return { funding: r.funding, event_id: r.event.id }; }
      if (op === "resync") { need(i, "new_date", "reason"); const r = resyncDates(ctx.events, f, { new_date: dateIn(i, "new_date"), at: at(i, ctx), reason: str(i, "reason"), hazard: obj(i, "hazard"), payoffs: list(i, "payoffs"), consummated_cd: i.consummated_cd ? big(obj<{ disbursement_date: PlainDate | null; prepaid_interest_cents: bigint | null }>(i, "consummated_cd")!, ["prepaid_interest_cents"]) : null }); putFunding(rt, ctx, r.funding); return { ...r, event_ids: r.events.map((e) => e.id) }; }
      need(i, "kind"); const e = notifySettlementAgent(ctx.events, f, { kind: str(i, "kind") as "wire_notice", channel: (str(i, "channel") || "portal") as "portal", at: at(i, ctx), detail: obj<Record<string, unknown>>(i, "detail") ?? {} }); return { event_id: e.id }; }),
    guardrails: [never("VERIFIED_CHANNEL_ONLY", "26.3 integrations: the disbursement authorization and wire notice go through the verified channel; instruction changes only through 24.4's change-detected flow", (i) => i.channel === "email" || i.channel === "unverified_email", "use the portal, a callback or the verified e-mail channel")] },
  { name: "confirmDisbursement", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "funding_id", "disbursement_date", "source");
      const f = fundingOf(rt, i);
      const r = confirmDisbursement(ctx.events, f, { disbursement_date: dateIn(i, "disbursement_date"), confirmed_at: at(i, ctx, "confirmed_at"), source: str(i, "source") as DisbursementSource, evidence_document_id: (i.evidence_document_id as string | undefined) ?? null, escrow_deposit_cents: cents(i.escrow_deposit_cents) });
      putFunding(rt, ctx, r.funding);
      return { funding: r.funding, loan_funded: r.loan_funded, event_ids: r.events.map((e) => e.id) }; }),
    guardrails: [never("CONFIRMATION_SOURCE_REQUIRED", "26.3 state machine: `disbursed` requires a disbursement confirmation source", (i) => i.source !== undefined && !["final_settlement_statement", "recording_confirmation", "agent_attestation", "bank_debit_trace"].includes(String(i.source)), "final settlement statement, recording confirmation, agent attestation or bank debit trace")] },
  { name: "postLedger", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "funding_id", "effective_date");
      const f = fundingOf(rt, i);
      const net = f.net_wire_cents ?? f.worksheet?.net_wire_cents; if (net === null || net === undefined) throw new RangeError("postLedger needs a reconciled worksheet (net_wire_cents)");
      const set = postFundingLedger(ctx.ledger, { gross_loan_cents: f.gross_loan_cents, net_wire_cents: net, loan_ref: f.loan_id ?? f.application_id, effective_date: dateIn(i, "effective_date"), source_event_id: (i.source_event_id as string | undefined) ?? null }, ctx.now);
      const mirror = partnerMirrorLines({ gross_loan_cents: f.gross_loan_cents, lender_credits_cents: f.worksheet?.lender_credits_cents ?? 0n, prepaid_interest_cents: f.interest.prepaid_interest_cents, interest_credit_cents: f.interest.interest_credit_cents, escrow_deposit_cents: cents(i.escrow_deposit_cents), net_wire_cents: net, loan_ref: f.loan_id ?? f.application_id });
      return { set_id: set.id, split: set.split, posting_target: "warehouse_advance_receivable", partner_mirror: mirror }; }),
    moneyFields: ["gross_loan_cents", "net_wire_cents"],
    guardrails: [never("POSTING_TARGET", "26.3 rule 9: `funding_wires.kind=funding` is booked to `warehouse_advance_receivable`, never to a loan-purchase account", (i) => i.posting_target !== undefined && i.posting_target !== "warehouse_advance_receivable", "the posting target is warehouse_advance_receivable")] },
  { name: "openUnwind", kind: "act", handler: compute((i, ctx, rt) => {
      const f = fundingOf(rt, i); const op = str(i, "op") || "open";
      if (op === "cancel") { need(i, "reason", "unwind_id"); const r = cancelFunding(ctx.events, f, { reason: str(i, "reason") as CancelReason, at: at(i, ctx), hpml_appraisal_rules_apply: flag(i, "hpml_appraisal_rules_apply"), unwind_id: str(i, "unwind_id"), enote: flag(i, "enote"), security_instrument_recorded: flag(i, "security_instrument_recorded") }); putFunding(rt, ctx, r.funding); rt.store.put("funding_unwinds", r.unwind.unwind_id, r.unwind as unknown as Record<string, unknown>, ctx.actor, ctx.now); return { funding: r.funding, unwind: r.unwind, event_ids: r.events.map((e) => e.id) }; }
      if (op === "open") { need(i, "unwind_id", "trigger"); const r = openUnwind(ctx.events, f, { unwind_id: str(i, "unwind_id"), trigger: str(i, "trigger") as UnwindTrigger, at: at(i, ctx), exercise: obj(i, "exercise"), enote: flag(i, "enote"), security_instrument_recorded: flag(i, "security_instrument_recorded"), prior_lien_paid: flag(i, "prior_lien_paid") }); putFunding(rt, ctx, r.funding); rt.store.put("funding_unwinds", r.unwind.unwind_id, r.unwind as unknown as Record<string, unknown>, ctx.actor, ctx.now); if (r.unwind.funds_position === "disbursed") rt.escalations.open({ kind: "officer", applicationId: f.application_id, severity: "sev1", payload: { funding_id: f.funding_id, unwind_id: r.unwind.unwind_id, reason: "money steps after disbursement need officer approval" } }, ctx.actor); return { funding: r.funding, unwind: r.unwind, event_id: r.event.id }; }
      need(i, "unwind_id"); const ur = rt.store.get("funding_unwinds", str(i, "unwind_id")); if (!ur) throw new RangeError(`no funding_unwinds row ${str(i, "unwind_id")}`); const u = ur.data as unknown as FundingUnwind;
      if (op === "step") { need(i, "step_index", "evidence"); const n = executeUnwindStep(u, num(i, "step_index"), { actor: ctx.actor, at: at(i, ctx), evidence: str(i, "evidence") }); rt.store.put("funding_unwinds", n.unwind_id, n as unknown as Record<string, unknown>, ctx.actor, ctx.now); return n; }
      if (op === "complete") { need(i, "outcome"); const r = completeUnwind(ctx.events, f, u, { at: at(i, ctx), by: ctx.actor, outcome: str(i, "outcome") }); putFunding(rt, ctx, r.funding); rt.store.put("funding_unwinds", r.unwind.unwind_id, r.unwind as unknown as Record<string, unknown>, ctx.actor, ctx.now); return { funding: r.funding, unwind: r.unwind, event_id: r.event.id }; }
      throw new RangeError(`openUnwind: unknown op ${op}`); }),
    humanRoles: ["officer", "funding_approver", "ops_analyst"],
    guardrails: [needsRole("UNWIND_MONEY_NEEDS_OFFICER", "26.3 automation class: officer sign-off on any unwind that moves money after disbursement", (i) => (i.op === "step" && i.moves_money === true && i.funds_position === "disbursed") || (i.op === "complete" && i.funds_position === "disbursed"), ["officer"], "no step moving money executes without officer approval")] },
  { name: "writeDecision", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "funding_id", "rationale", "confidence");
      const f = fundingOf(rt, i);
      const checklist = i.checklist_id ? ((rt.store.get("funding_conditions", str(i, "checklist_id"))?.data as unknown as FundingConditions | undefined) ?? null) : null;
      const record = funderDecisionRecord({ funding: f, checklist, wire: f.wire_id && rt.store.get("funding_wires", f.wire_id) ? wireOf(rt, f.wire_id) : null, bec_score: i.bec_score === undefined ? null : num(i, "bec_score"), advance: f.warehouse_advance_id ? { advance_id: f.warehouse_advance_id, amount_cents: f.net_wire_cents ?? 0n } : null, gates_asserted: list<string>(i, "gates_asserted"), rationale: str(i, "rationale"), confidence: num(i, "confidence"), model_version: ctx.run?.modelVersion ?? (str(i, "model_version") || "human"), prompt_version: ctx.run?.promptVersion ?? (str(i, "prompt_version") || "n/a") });
      const d = decision()({ ...i, action: `funder:${str(i, "action") || "funding_decision"}`, subject: { kind: "fundings", id: f.funding_id }, rule_code: str(i, "rule_code") || "26.3", data: record }, ctx);
      return { record, decision: d, rule_set_versions: RULE_SETS_26_3, officer_review: isOfficer(ctx.actor) }; }),
    decision: (i) => ({ action: `funder:${String(i.action ?? "funding_decision")}`, rationale: String(i.rationale ?? ""), subject: { kind: "fundings", id: String(i.funding_id ?? "") }, ruleCode: String(i.rule_code ?? "26.3") }) },
]);

export { FundingRefused };
