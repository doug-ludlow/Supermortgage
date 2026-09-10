/**
 * §5 tools — investor reporting and remittance (5.1–5.7). Tool strings are
 * verbatim from each process's Agents paragraph; guardrails encode the
 * "cannot"/"never" sentences and the confidence thresholds. Agents: 5.1/5.3/
 * 5.6/5.7 `investor-reporting` (5.3 also `payoff-release`/`claims-reo`/
 * `foreclosure-ops`), 5.2/5.4/5.5 `custodial-recon`.
 */
import { defineTools, escalate, decision, ledgerPost, compute, never, needsRole, humanWhen, cents, str, num, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { projectLar96, prevalidate } from "../../domain/investor/lar.ts";
import { crsAaRequest, classifyVariance, gfeeCheckFigure, fundingDecision } from "../../domain/investor/remittance.ts";
import { actionCode, removalAmounts, type LiquidationKind, type InsuredFlag } from "../../domain/investor/liquidation.ts";
import { predictSda, applyRecovery, type SdaState } from "../../domain/investor/sda.ts";
import { mbsRepurchasePrice } from "../../domain/investor/repurchase.ts";
import { deriveStatusCode, candidates, statusLine, consistencyErrors, inPopulation, type LoanStatusFacts } from "../../domain/investor/delinquency-status.ts";
import { bd2CloseMs, nextMonth } from "../../domain/investor/period.ts";
import type { LarPayload, RemittanceType, ChannelMode } from "../../domain/investor/types.ts";
import { ET, escrowDepositRouting, softRejectInterest, advanceTransfer, reconcileDra, reogramConfirmation, projectLiquidationEvent, removalConfidenceHold, tpsProceeds, matchReimbursements, sdaStatusVariance, form496Line12, gfeeBillLine, gfeeReliefPrediction, gfeeRecovery, gfeeBillVariance, projectLar65, dqExceptionCycle, dqEventForAction, amnTransmission, validateF121Layout, postCloseRemovalError, type AdvanceRow, type DraMilestone } from "../../domain/investor/ops.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const afterBd2Close = (i: ToolInput): boolean => { const p = str(i, "activity_period"); if (!/^\d{4}-\d{2}$/.test(p)) return false; const [y, m] = p.split("-").map(Number) as [number, number]; return Date.parse(str(i, "now") || "") > bd2CloseMs(nextMonth(D(`${y}-${String(m).padStart(2, "0")}-01` as PlainDate))); };
const noPostCloseRemovalCorrection = never("NO_REMOVAL_CORRECTION_AFTER_BD2", "5.1/5.3/5.6 guardrail: cannot submit/change a removal correction after BD2 17:00 ET (IRM 4-08)", (i) => str(i, "family") === "removal" && flag(i, "correction") && afterBd2Close(i), "removal corrections close at BD2 17:00 ET; open a qc_finding instead");
const recordDecision: Omit<ToolDef, "process" | "agent"> = { name: "recordDecision", kind: "write", handler: decision(), decision: (i) => ({ action: str(i, "action") || "recordDecision", rationale: str(i, "rationale") }) };

// ---- 5.1 LAR submission -----------------------------------------------------
const p51 = defineTools("5.1", "investor-reporting", [
  { name: "projectEvent", kind: "write", handler: compute((i, ctx) => {
      need(i, "event_type");
      if (str(i, "family") === "escrow") return escrowDepositRouting((str(i, "mode") || "legacy") as ChannelMode, Date.parse(str(i, "processed_at") || ctx.now));
      const p = i.payload as LarPayload | undefined; if (!p) throw new RangeError("payload (LarPayload) is required");
      const lar = projectLar96(str(i, "servicer_number") || "000000000", str(i, "fnma_loan_number") || "0000000000", p);
      ctx.events.append({ type: "investor_events.projected", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { event_type: str(i, "event_type"), record: lar.record } });
      return lar;
    }),
    guardrails: [never("NO_DIRECT_LEDGER", "5.1 guardrail: cannot alter ledger balances directly — Section 2 correction commands post the reversing entries", (i) => flag(i, "adjust_ledger"), "issue a cashiering correction command instead"),
      never("NO_ACCEPT_WITHOUT_RESPONSE", "5.1 guardrail: cannot mark an event `accepted` without a parsed Fannie Mae response", (i) => str(i, "set_status") === "accepted" && !flag(i, "fnma_response_parsed"), "acceptance is written from the parsed feedback only"),
      noPostCloseRemovalCorrection, humanWhen("ROOT_CAUSE_CONFIDENCE", "5.1 guardrail: confidence < 0.8 on root cause → hold and escalate", (i) => typeof i.root_cause === "string" && num(i, "confidence") < 0.8, "root-cause confidence below 0.8: hold and escalate")] },
  { name: "validateLar80", kind: "read", handler: compute((i) => { need(i, "record"); const r = str(i, "record"); const errs: string[] = [];
      if (r.length !== 80) errs.push(`record is ${r.length} characters, not 80`);
      if (!/^(96|97|81|83|89|32)/.test(r)) errs.push("record type must be 96/97/81/83/89/32");
      if (r.startsWith("96") && !/^[0-9]{10}[{}A-R]$/.test(r.slice(21, 32))) errs.push("interest field is not zone-signed");
      return { ok: errs.length === 0, errors: errs }; }) },
  { name: "validateSeJson", kind: "read", handler: compute((i) => { const p = i.payload as LarPayload | undefined; if (!p) throw new RangeError("payload is required");
      const expected = { upb_cents: cents(i.expected_upb_cents), lpi_date: (i.expected_lpi_date as PlainDate | null | undefined) ?? null };
      const errs = prevalidate(p, expected, date(i, "today"), (i.last_accepted_effective as PlainDate | null | undefined) ?? null);
      const names = ["Loan Servicer Transaction Effective Date", "Loan Servicer Transaction Processed Date", "Loan Last Paid Installment Due Date", "Loan Actual UPB Amount", "Loan Non-Interest Bearing Balance Amount", "Loan Suspense Balance Amount", "Loan Interest Rate", "Loan Lender Pass Through Rate", "Loan Principal and Interest Payment Amount", "Loan Event Sequence Number"];
      return { ok: errs.length === 0, errors: errs, schema_fields: names }; }) },
]);

// ---- 5.2 remittance of P&I -------------------------------------------------
const p52 = defineTools("5.2", "custodial-recon", [
  { name: "buildCrsBatch", kind: "write", handler: compute((i) => { need(i, "today"); const r = crsAaRequest(cents(i.net_collected_cents), date(i, "today"), flag(i, "last_work_day_of_month"));
      return { ...r, servicer_number: str(i, "servicer_number"), duplicate_blocked: flag(i, "existing_request_same_settlement") && str(i, "existing_status") !== "failed" }; }),
    guardrails: [never("NO_CANCEL_AFTER_1600_T1", "5.2 guardrail: cannot cancel a CRS request after 16:00 ET T−1", (i) => i.op === "cancel" && typeof i.settlement_date === "string" && Date.parse(str(i, "now") || "") > zonedEpochMs(D(str(i, "settlement_date")), "16:00", ET) - 86_400_000, "CRS requests are final after 16:00 ET the business day before settlement"),
      never("NO_DUPLICATE_001", "5.2 edge case: a second 001 request for the same servicer number/settlement date is blocked unless the first failed", (i) => flag(i, "existing_request_same_settlement") && str(i, "existing_status") !== "failed", "duplicate CRS 001 for the settlement date")] },
  { name: "openPortalTask", kind: "act", handler: escalate("human_portal_task"), decision: (i) => ({ action: "openPortalTask", rationale: str(i, "reason") || "fnma_portal_operator: CRS upload/instruction or Connect pull" }) },
  { name: "pullDraftNotifications", kind: "read", handler: compute((i, _c, rt) => rt.store.list("draft_notifications", (d) => !i.period || d.period === i.period).map((r) => ({ id: r.id, ...r.data }))) },
  { name: "matchBankDebits", kind: "write", handler: compute((i) => { const debits = rows<{ id: string; amount_cents: bigint; date: string; originator: string }>(i, "debits"); const rem = rows<{ id: string; expected_cents: bigint; draft_date: string }>(i, "remittances");
      const matched: { debit_id: string; remittance_id: string }[] = []; const used = new Set<string>();
      for (const d of debits) { const m = rem.find((r) => !used.has(r.id) && r.expected_cents === d.amount_cents && r.draft_date === d.date && /fannie/i.test(d.originator)); if (m) { used.add(m.id); matched.push({ debit_id: d.id, remittance_id: m.id }); } }
      const unmatched = debits.filter((d) => !matched.some((m) => m.debit_id === d.id)).map((d) => d.id);
      return { matched, unmatched_debits: unmatched, alert: unmatched.length ? "sev1" : null, ledger_rule: "Dr fnma_remittance_payable / Cr custodial_pi_cash" }; }) },
  { name: "explainVariance", kind: "read", handler: compute((i) => { need(i, "expected_cents", "notified_cents"); const v = classifyVariance(cents(i.expected_cents), cents(i.notified_cents), { ...(flag(i, "sda_active") ? { sda_active: true } : {}), ...(i.sda_credit_cents !== undefined ? { sda_credit_cents: cents(i.sda_credit_cents) } : {}), ...(flag(i, "recovery") ? { recovery: true } : {}), ...(typeof i.code === "string" ? { code: i.code } : {}) });
      const abs = v.variance_cents < 0n ? -v.variance_cents : v.variance_cents;
      return { ...v, escalate_officer: v.class === "unexplained" && (abs > 50_000n || cents(i.draft_code_total_variance_cents) > 500_000n) }; }) },
  { name: "postLedger", kind: "write", handler: ledgerPost(), moneyFields: ["entry_set"],
    guardrails: [never("NO_TI_FOR_PI", "5.2 guardrail: never uses escrow (T&I) funds for P&I drafts", (i) => { const s = i.entry_set as { lines?: { account?: { account?: string }; side?: string }[] } | undefined; return !!s?.lines?.some((l) => l.side === "credit" && /custodial_ti|escrow/.test(String(l.account?.account ?? ""))) && !!s?.lines?.some((l) => /fnma_remittance_payable/.test(String(l.account?.account ?? ""))); }, "P&I drafts are never funded from the T&I custodial account"),
      needsRole("DUAL_CONTROL_250K", "5.2 guardrail: single custodial↔corporate transfer > $250,000 or daily > $1,000,000 requires officer approval", (i) => str(i, "transfer_kind") === "advance" && (cents(i.transfer_cents) > 25_000_000n || cents(i.daily_total_cents) > 100_000_000n), ["officer"], "dual control: an officer approves the transfer"),
      never("ADVANCE_COMMANDS_ONLY", "5.2 guardrail: cannot move money between custodial and corporate accounts except through the advance/fee_sweep commands", (i) => flag(i, "custodial_corporate_transfer") && !["advance", "fee_sweep"].includes(str(i, "transfer_kind")), "custodial↔corporate movements go through `advance`/`fee_sweep`")] },
  recordDecision,
]);

// ---- 5.3 liquidations -------------------------------------------------------
const liqKind = (i: ToolInput): LiquidationKind => { need(i, "kind"); return str(i, "kind") as LiquidationKind; };
const p53 = [
  ...defineTools("5.3", "investor-reporting", [
    { name: "selectLiquidationCode", kind: "read", handler: compute((i) => { const code = actionCode(liqKind(i), (str(i, "insured") || "none") as InsuredFlag); const hold = removalConfidenceHold({ confidence: typeof i.confidence === "number" ? i.confidence : 1, deadline_ms: Date.parse(str(i, "deadline_at") || "") || 0, candidates: ["70", "71", "72"], evidence: Array.isArray(i.evidence) ? (i.evidence as string[]) : [] }); return { code, ...hold }; }),
      guardrails: [humanWhen("CODE_CONFIDENCE_090", "5.3 guardrail: confidence < 0.9 on 70 vs 71 vs 72 → hold and escalate to the claims-reo human reviewer before the deadline − 4h", (i) => typeof i.confidence === "number" && i.confidence < 0.9, "insured/purchaser status uncertain: human_agent review")] },
    { name: "computeRemovalAmounts", kind: "read", handler: compute((i) => removalAmounts({ kind: liqKind(i), insured: (str(i, "insured") || "none") as InsuredFlag, type: (str(i, "type") || "SS") as RemittanceType, actual_upb_cents: cents(i.actual_upb_cents), scheduled_upb_cents: cents(i.scheduled_upb_cents), nib_cents: cents(i.nib_cents), ptr: str(i, "ptr") || "0", legal_date: date(i, "legal_date"), period_open: i.period_open !== false, ...(i.interest_cents !== undefined ? { interest_cents: cents(i.interest_cents) } : {}) })) },
    { name: "projectEvent", kind: "write", handler: compute((i, ctx) => { const p = projectLiquidationEvent({ mode: (str(i, "mode") || "legacy") as ChannelMode, kind: liqKind(i), insured: (str(i, "insured") || "none") as InsuredFlag, principal_cents: cents(i.principal_cents), interest_cents: cents(i.interest_cents), legal_date: date(i, "legal_date"), fnma_loan_number: str(i, "fnma_loan_number"), cit: flag(i, "cit") });
        ctx.events.append({ type: "investor_events.projected", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { family: "removal", action_code: p.lar.action_code, env: p.env } }); return p; }),
      guardrails: [never("NO_AC60_WITHOUT_CLEARED_FUNDS", "5.3 guardrail: never project AC 60 without cleared funds", (i) => str(i, "kind") === "payoff" && !flag(i, "funds_cleared"), "`removal.payoff` is projected only from `payoff.funds.cleared`"), noPostCloseRemovalCorrection] },
    { name: "buildCrsBatch", kind: "write", handler: compute((i) => tpsProceeds({ bid_cents: cents(i.bid_cents), received_on: date(i, "received_on"), scheduled_upb_cents: cents(i.scheduled_upb_cents), ptr: str(i, "ptr") || "0", lpi_due: date(i, "lpi_due"), sale_on: date(i, "sale_on"), settlement_on: date(i, "settlement_on") })) },
    { name: "draftCpmNotice", kind: "write", handler: compute((i) => { need(i, "loan_id", "reason"); return { to: "SF CPM", kind: str(i, "kind") || "code_change", loan_id: str(i, "loan_id"), body: `Request to change the liquidation action code for loan ${str(i, "loan_id")}: ${str(i, "reason")}`, status: "draft", send_by: ["fnma_portal_operator", "officer"] }; }),
      guardrails: [never("AGENT_DRAFTS_ONLY", "5.3 guardrail: code-change requests to SF CPM and readd requests are drafted by the agent and sent by fnma_portal_operator/officer", (i) => flag(i, "send"), "the agent drafts; a human sends")] },
    { name: "recordDecision", kind: "write", handler: decision(), decision: (i) => ({ action: str(i, "action") || "recordDecision", rationale: str(i, "rationale") }) },
  ]),
  ...defineTools("5.3", "claims-reo", [
    { name: "prepareReogramPackage", kind: "write", handler: compute((i) => { need(i, "loan_id", "received_at"); const t = reogramConfirmation(Date.parse(str(i, "received_at"))); return { loan_id: str(i, "loan_id"), package: { sale_date: i.sale_date ?? null, bid_cents: cents(i.bid_cents), occupancy: i.occupancy ?? null, insurance: i.insurance ?? null, hoa: i.hoa ?? null, contacts: i.contacts ?? null, mi_claim_status: i.mi_claim_status ?? null }, ...t }; }) },
  ]),
  ...defineTools("5.3", "foreclosure-ops", [
    { name: "reconcileDra", kind: "write", handler: compute((i) => reconcileDra({ dra: rows<DraMilestone>(i, "dra"), ours: rows<DraMilestone>(i, "ours"), as_of: date(i, "as_of") })) },
  ]),
];

// ---- 5.4 Stop Delinquency Advance ------------------------------------------
const sdaFacts = (i: ToolInput) => ({ lpi: date(i, "lpi"), type: (str(i, "type") || "SS") as RemittanceType, option: (str(i, "option") || "special") as "special" | "regular", period_end: date(i, "period_end") });
const p54 = defineTools("5.4", "custodial-recon", [
  { name: "predictSdaEntry", kind: "read", handler: compute((i) => { const f = sdaFacts(i); return predictSda(f.lpi, f.type, f.option, f.period_end); }) },
  { name: "parseRemittanceDetail", kind: "read", handler: compute((i) => { const lines = rows<{ fnma_loan_number: string; expected_pi_cents: bigint; stop_advance_credit_cents?: bigint; recovery_cents?: bigint }>(i, "lines");
      return lines.map((l) => ({ fnma_loan_number: l.fnma_loan_number, expected_pi_cents: l.expected_pi_cents, stop_advance_credit_cents: l.stop_advance_credit_cents ?? 0n, recovery_cents: l.recovery_cents ?? 0n, net_cents: l.expected_pi_cents - (l.stop_advance_credit_cents ?? 0n) - (l.recovery_cents ?? 0n), fm_pi_receivable_delta_cents: l.stop_advance_credit_cents ?? 0n })); }) },
  { name: "matchAdjustments", kind: "write", handler: compute((i) => { if (i.recovery_cents !== undefined) { const st = i.state as SdaState | undefined; if (!st) throw new RangeError("state (SdaState) is required"); return applyRecovery(st, cents(i.recovery_cents)); }
      return matchReimbursements({ advances: rows<AdvanceRow>(i, "advances"), credits: rows<bigint>(i, "credits"), cycles_elapsed: num(i, "cycles_elapsed") || 0 }); }),
    guardrails: [never("HOLD_PI_UNTIL_RECOVERY_DRAFT", "5.4 guardrail: never release custodial P&I collected on an SDA loan before Fannie Mae's recovery draft settles", (i) => flag(i, "release_custodial_pi") && !flag(i, "recovery_draft_settled"), "collected P&I stays in custodial_pi_cash until the recovery draft settles")] },
  { name: "rollForwardReceivables", kind: "write", handler: compute((i) => { const st = i.state as SdaState | undefined; if (!st) throw new RangeError("state (SdaState) is required");
      const delta = cents(i.fm_pi_receivable_delta_cents); const v = sdaStatusVariance({ predicted: st.status, predicted_months: num(i, "predicted_months") || 0, fnma_status: (str(i, "fnma_status") || "advancing") as "stop_advance" | "advancing", our_lpi: date(i, "our_lpi"), fnma_lpi: (i.fnma_lpi as PlainDate | null | undefined) ?? null, reporting_history: Array.isArray(i.reporting_history) ? (i.reporting_history as { period: string; lpi: PlainDate; status: string }[]) : [] });
      return { fm_pi_receivable_cents: st.fm_pi_receivable_cents + delta, servicer_advances_outstanding_cents: st.servicer_advances_outstanding_cents, ...v }; }),
    guardrails: [never("NO_ADVANCE_ON_STOP_ADVANCE", "5.4 guardrail: never fund an advance for a loan Fannie Mae has flagged Stop Advance", (i) => flag(i, "fund_advance") && str(i, "fnma_status") === "stop_advance", "Fannie Mae has set Stop Advance for the loan"),
      humanWhen("UNREIMBURSED_25K_OR_60D", "5.4 guardrail: escalate to officer when unreimbursed advances exceed $25,000 per loan or 60 days after an exit", (i) => cents(i.unreimbursed_cents) > 2_500_000n || num(i, "days_since_exit") > 60, "unreimbursed advances beyond $25,000 or 60 days after exit: officer")] },
  { name: "buildForm496Line12", kind: "read", handler: compute((i) => form496Line12(rows<{ loan_id: string; sda_status: SdaState["status"]; fm_pi_receivable_reported_cents: bigint }>(i, "rows"))) },
  { name: "openPortalTask", kind: "act", handler: escalate("human_portal_task"), decision: (i) => ({ action: "openPortalTask", rationale: str(i, "reason") || "fnma_portal_operator: report pull or deselection entry" }) },
  recordDecision,
]);

// ---- 5.5 guaranty fee relief -----------------------------------------------
const p55 = defineTools("5.5", "custodial-recon", [
  { name: "parseGfeeBill", kind: "read", handler: compute((i) => { const lines = rows<{ fnma_loan_number: string; amount_cents: bigint }>(i, "lines"); return { period: str(i, "period"), lines, total_cents: lines.reduce((a, l) => a + l.amount_cents, 0n), zero_lines: lines.filter((l) => l.amount_cents === 0n).map((l) => l.fnma_loan_number) }; }) },
  { name: "computeGfeeCheckFigures", kind: "read", handler: compute((i) => rows<{ fnma_loan_number: string; prior_scheduled_upb_cents: bigint; gfee_pct: string; adjustment_cents?: bigint }>(i, "loans").map((l) => ({ fnma_loan_number: l.fnma_loan_number, check_figure_cents: gfeeBillLine(l.prior_scheduled_upb_cents, l.gfee_pct, l.adjustment_cents ?? 0n), base_cents: gfeeCheckFigure(l.prior_scheduled_upb_cents, l.gfee_pct) }))) },
  { name: "reconcileRelief", kind: "write", handler: compute((i) => { if (i.bill_total_cents !== undefined) return gfeeBillVariance({ bill_total_cents: cents(i.bill_total_cents), computed_total_cents: cents(i.computed_total_cents), per_loan: rows<{ loan_id: string; bill_cents: bigint; computed_cents: bigint }>(i, "per_loan") });
      return gfeeReliefPrediction({ lpi: date(i, "lpi"), period_end: date(i, "period_end"), type: (str(i, "type") || "SS") as RemittanceType, option: (str(i, "option") || "special") as "special" | "regular", sda_status: (str(i, "sda_status") || "not_applicable") as SdaState["status"], bill_line_cents: cents(i.bill_line_cents) }); }),
    guardrails: [humanWhen("BILL_VARIANCE_OFFICER", "5.5 guardrail: bill total differs from the check-figure total by more than the greater of $500 or 0.5% → officer", (i) => i.bill_total_cents !== undefined && gfeeBillVariance({ bill_total_cents: cents(i.bill_total_cents), computed_total_cents: cents(i.computed_total_cents), per_loan: [] }).escalation === "officer", "systemic PTR/UPB variance: officer review"),
      humanWhen("RELIEF_LOAN_REAPPEARED", "5.5 guardrail: a relief loan reappearing on the bill without a contractual payment → officer", (i) => flag(i, "relief_loan_on_bill") && !flag(i, "contractual_payment_reported"), "relief loan billed without a contractual payment")] },
  { name: "fundDraft", kind: "write", handler: compute((i) => { need(i, "draft_date"); const a = advanceTransfer({ expected_draft_cents: cents(i.expected_draft_cents), custodial_available_cents: cents(i.custodial_available_cents), facility_available_cents: cents(i.facility_available_cents), at_ms: Date.parse(str(i, "now") || new Date().toISOString()), draft_date: date(i, "draft_date") }); return { ...a, source_account: str(i, "source_account") || "corporate" }; }), moneyFields: ["expected_draft_cents"],
    guardrails: [never("NO_TI_FUNDING", "5.5 guardrail: never fund from T&I", (i) => /custodial_ti|escrow/.test(str(i, "source_account")), "g-fee drafts are never funded from the T&I custodial account"),
      needsRole("DUAL_CONTROL_250K", "5.2 guardrail (shared): transfer > $250,000 requires officer approval", (i) => fundingDecision(cents(i.expected_draft_cents), cents(i.custodial_available_cents)).dual_control, ["officer"], "dual control on the corporate advance")] },
  { name: "matchDebit", kind: "write", handler: compute((i) => { need(i, "debit_cents"); const r = gfeeRecovery({ outstanding_fnma_gfee_cents: cents(i.outstanding_fnma_gfee_cents), servicer_gfee_advances_cents: cents(i.servicer_gfee_advances_cents), payment_gfees_cents: rows<bigint>(i, "payment_gfees_cents") }); return { ...r, debit_cents: cents(i.debit_cents), matched: r.bill_draft_cents === cents(i.debit_cents), ledger_rule: "Cr servicer_advance_receivable(gfee)" }; }) },
  recordDecision,
]);

// ---- 5.6 repurchases --------------------------------------------------------
const p56 = defineTools("5.6", "investor-reporting", [
  { name: "projectEvent", kind: "write", handler: compute((i, ctx) => { need(i, "processed_at"); const r = projectLar65({ approval_document_id: (i.approval_document_id as string | undefined) || null, processed_at_ms: Date.parse(str(i, "processed_at")), arm_modification_feature: flag(i, "arm_modification_feature") });
      if (r.event) ctx.events.append({ type: "investor_events.projected", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { family: "removal", action_code: r.event.action_code } });
      return { ...r, price: i.scheduled_upb_cents !== undefined ? mbsRepurchasePrice(cents(i.scheduled_upb_cents), str(i, "ptr") || "0") : null }; }),
    guardrails: [never("LAR65_NEEDS_APPROVAL_DOC", "5.6 guardrail: LAR 65/67 is projected only after the approval document is attached", (i) => !i.approval_document_id, "attach the approval document; an officer escalation is open until then"), noPostCloseRemovalCorrection] },
  { name: "buildCrsBatch", kind: "write", handler: compute((i) => { need(i, "type"); const t = str(i, "type"); const code = t === "AA" ? "001" : t === "make_whole" ? "309" : t === "reo" ? "315" : t === "advances" ? "352" : null; return { crs_code: code, drafted_by_type: code === null, amount_cents: cents(i.amount_cents), funding_source: "responsible_party" }; }) },
  { name: "draftLetter", kind: "write", handler: compute((i) => { need(i, "kind"); return { kind: str(i, "kind"), status: "draft", requires: "officer", package: ["pricing worksheet", "loan history", "eligibility", "alternative analysis"], body: str(i, "body") }; }),
    guardrails: [never("NEVER_COMMITS_PARTNER", "5.6 guardrail: the agent never commits the partner — every offer, acceptance, appeal and payment authorization is an officer escalation", (i) => flag(i, "commit") || flag(i, "send"), "offers/acceptances/appeals/payment authorizations are officer decisions")] },
  { name: "openPortalTask", kind: "act", handler: escalate("officer"), decision: (i) => ({ action: "openPortalTask", rationale: str(i, "reason") || "officer: repurchase package" }) },
  recordDecision,
]);

// ---- 5.7 delinquent loan status -------------------------------------------
const LEVEL1_WITHOUT_SMDU = new Set(["27", "29", "32", "44"]);
const facts = (i: ToolInput): LoanStatusFacts => { const f = i.facts as LoanStatusFacts | undefined; if (!f) throw new RangeError("facts (LoanStatusFacts) is required"); return f; };
const p57 = defineTools("5.7", "investor-reporting", [
  { name: "buildDqSnapshot", kind: "write", handler: compute((i) => { const loans = rows<{ loan_id: string; facts: LoanStatusFacts }>(i, "loans"); const pop = loans.filter((l) => inPopulation(l.facts)); return { period: str(i, "period"), population: pop.map((l) => l.loan_id), record_count: pop.length }; }) },
  { name: "deriveStatusCode", kind: "read", handler: compute((i) => { const f = facts(i); const c = deriveStatusCode(f); const line = statusLine(f); return { chosen: c, candidates: candidates(f), line, evidence_event_ids: f.actions.map((a) => a.evidence_event_id ?? null) }; }),
    guardrails: [never("CODE_NEEDS_EVIDENCE", "5.7 guardrail: a code is never chosen without an evidence event id", (i) => { const f = i.facts as LoanStatusFacts | undefined; return !!f && f.actions.some((a) => !a.evidence_event_id); }, "every candidate action carries its evidence event id"),
      never("LEVEL1_NEEDS_SMDU_CASE", "5.7 guardrail: no Level 1 code without an SMDU case id (except 27/29/32/44)", (i) => { const f = i.facts as LoanStatusFacts | undefined; if (!f) return false; const c = deriveStatusCode(f); return !!c && c.level === 1 && !LEVEL1_WITHOUT_SMDU.has(c.code) && !i.smdu_case_id; }, "Level 1 codes require the SMDU case id"),
      never("REASON_CHANGE_NEEDS_STATEMENT", "5.7 guardrail: reason code changes require a new borrower statement", (i) => typeof i.prior_reason_code === "string" && typeof i.reason_code === "string" && i.prior_reason_code !== i.reason_code && !flag(i, "new_borrower_statement"), "the reason code only changes on a new borrower statement"),
      humanWhen("LINE_CONFIDENCE_085", "5.7 guardrail: confidence < 0.85 → line flagged for human_agent review before BD2 (file still transmits)", (i) => typeof i.confidence === "number" && i.confidence < 0.85, "line flagged for human review; best code transmits on time")] },
  { name: "validateF121Layout", kind: "read", handler: compute((i) => { need(i, "line"); const l = i.line as { status: string; reason: string; effective: string; completion: string }; const errors = validateF121Layout(l); return { ok: errors.length === 0, errors }; }) },
  { name: "submitAmnFile", kind: "act", handler: compute((i, ctx) => { need(i, "period_month"); const t = amnTransmission({ period_month: date(i, "period_month"), transmitted_at_ms: Date.parse(str(i, "transmitted_at") || ctx.now), record_count: num(i, "record_count") || 0 });
      ctx.events.append({ type: "delinquency_reports.submitted", loanId: ctx.loanId, actor: ctx.actor, payload: { period: str(i, "period_month").slice(0, 7), late: t.late, aw_repeated: flag(i, "aw_repeated") } }); return t; }),
    guardrails: [never("AW_ONCE", "5.7 guardrail: AW once", (i) => flag(i, "aw_repeated"), "AW may not repeat in consecutive periods")] },
  { name: "parseExceptionReport", kind: "write", handler: compute((i) => dqExceptionCycle({ file_month: date(i, "file_month"), exceptions: rows(i, "exceptions"), published_cd10: date(i, "published_cd10") })) },
  { name: "submitDqEvent", kind: "act", handler: compute((i, ctx) => { need(i, "action"); const e = dqEventForAction({ action: str(i, "action"), processed_at_ms: Date.parse(str(i, "processed_at") || ctx.now), mode: (str(i, "mode") || "legacy") as ChannelMode });
      ctx.events.append({ type: "delinquency_events.submitted", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { servicer_action_type: e.servicer_action_type, env: e.env } }); return e; }) },
  { name: "checkConsistency", kind: "read", handler: compute((i) => { const f = facts(i); const line = statusLine(f); const errors = line ? consistencyErrors(f, line) : []; const smdu = str(i, "smdu_case_status"); if (line && ["09", "12", "BF"].includes(line.status) && smdu && smdu !== "active") errors.push(`${line.status} but SMDU case status is ${smdu}`); return { line, errors, ok: errors.length === 0 }; }) },
  recordDecision,
]);

export const SECTION_05_TOOLS: readonly ToolDef[] = [...p51, ...p52, ...p53, ...p54, ...p55, ...p56, ...p57];
