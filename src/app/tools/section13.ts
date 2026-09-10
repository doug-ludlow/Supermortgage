/**
 * §13 tools — foreclosure (`foreclosure-ops`). Every tool string is the spec's
 * verbatim; 13.3 and 13.9 register no tools of their own in agents.json, so
 * their guardrail sentences are enforced on the tools their engines run on:
 * the bid/method-deviation rules (13.3) on `attorney.instruction.send`, the
 * no-court-relief and attorney-reviewed-denial rules (13.9) on the attorney
 * messaging tools and on `scra.case.get/open/close`. Guardrails encode the
 * "cannot"/"never" sentences: the agent cannot open a closed gate (exceptions
 * come from an officer's record with counsel's memo, never from the input),
 * never sends RESUME/CERTIFY_SALE while a `foreclosure_holds` row is open or
 * an evaluator gate is closed, never marks an application complete or
 * rejected, never records a checklist `pass` without evidence, never
 * recommends foreclosure to hazard_loss@ without the outreach cadence, cannot
 * add delay credits or set the allowable days, cannot set the fee basis of an
 * invoice or approve a rejected line, never files pleadings, never opens the
 * SCRA gate (only tail expiry, a court order at Fannie Mae's direction or an
 * attorney-reviewed §3918 agreement can), never ends a service period without
 * evidence and never asks a servicemember to waive.
 *
 * Gate facts are read from the store and the event log — 12.x rows
 * (`lossmit_applications`, `foreclosure_holds`), 13.x rows (`scra_cases`,
 * `scra_verifications`, `foreclosure_cases`, `litigation_matters`,
 * `foreclosure_gate_evaluations`), 14.x (`bankruptcy_cases`) — never from the
 * caller: the loan's counters, occupancy and state are the loan row's (13.1:
 * "computed daily (baseline §3)"; "the agent … can only add evidence that
 * changes an input"), a DMDC result is the adapter's, a bid is
 * `totalIndebtedness()`/`bid()` over the loan's balances (13.3), the SCRA
 * late-charge waiver is the 2.7 `fees` rows assessed after the call to duty
 * (13.8), and a human verification is a human_agent's own checklist entry
 * (13.4). A command a closed gate refuses leaves its trail — the evaluation
 * row, `foreclosure.gate.refused{command, code}` and the sev-1 Compliance
 * Sentinel escalation (13.1 Outputs; 13.2 timer rows "refused; sev 1").
 */
import { defineTools, escalate, compute, never, needsRole, read, timerOps, cents, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { evaluateGate, GateClosed } from "../evaluators.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, addDays, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { AdapterUnavailable } from "../../infra/integrations/failures.ts";
import { pacerMatchAccepted, type DmdcRequest, type DmdcResult, type PacerParty } from "../../infra/integrations/legal.ts";
import { gate120, regxDays, stepAllowed, BLOCKED_BY_HOLD, type Hold, type GateState } from "../../domain/foreclosure/gates.ts";
import { referralEligible, reviewOutcome, totalIndebtedness, bid as bidOf, type Gates } from "../../domain/foreclosure/referral.ts";
import { allowable, exposure, projectedExposure, isDelayCategory, type Delay } from "../../domain/foreclosure/timeframes.ts";
import { reviewInvoice, type Method as FirmMethod, type Confirmation } from "../../domain/foreclosure/firms.ts";
import { classify as classifyLitigation } from "../../domain/foreclosure/litigation.ts";
import { occupancyDefault, refusedReferral, mnReferralGate, modelItemGate, maLeadPaintItem, bankruptcyScrubItem, boardingDmdc, openScraCase, waiverRequest, disasterHold, exceptionGround, scraAffidavit, scraCaseClose, litigationIntake, assertedServiceWithoutEvidence, reserveFallback, type Escalation as DomainEscalation } from "../../domain/foreclosure/ops.ts";
import { preServiceObligation } from "../../domain/foreclosure/scra.ts";
import { dmdcBatchPrepare_13_8, scraStatusVerified_13_8, scraReliefStarted_13_8, scraReliefSweep_13_8, scraCaseOps_13_8, affidavitGateFacts_13_8 } from "./section13-8.ts";
import { scraCaseOps_13_9, scraPeriodEnded_13_9 } from "./section13-9.ts";
import { recordSaleInstruction, appealWindowSweep, appealWindowFacts } from "../../domain/foreclosure/ops-13-2.ts";
import { TimeframeTracker, loadedExhibits } from "../../domain/foreclosure/ops-13-5.ts";
import { startReview, completeReview, windowFor, prProhibitions, nonPrBrpItem, ingestWorkoutPlanPayment, submitDisasterFcRequest, recordDisasterFcResponse, recordMortgageeOfRecord, type DisasterRequest, type FnmaDisasterResponse } from "../../domain/foreclosure/ops-13-4.ts";
import { litigationClassifyHandler, LITIGATION_CLASSIFY_GUARDRAILS_13_7, attorneyMessageHandler137, ATTORNEY_MESSAGE_GUARDRAILS_13_7 } from "./section13-7.ts";
import { attorneyMessageHandler136, ATTORNEY_MESSAGE_GUARDRAILS_13_6, invoiceReviewHandler136, draSnapshotImportHandler136 } from "./section13-6.ts";
import { firmMessageIngest_13_3, foreclosureAct_13_3 } from "./section13-3.ts";

type Rt = ToolRuntime; type Ctx = CommandContext; type Row = Record<string, unknown>;
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const has = (i: ToolInput, ...keys: string[]): boolean => keys.some((k) => i[k] !== undefined);
const todayOf = (ctx: Ctx): PlainDate => D(ctx.now.slice(0, 10));
const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && v.length >= 10 ? D(v.slice(0, 10)) : null);
const loanRows = (rt: Rt, kind: string, loanId: string) => rt.store.list(kind).filter((r) => r.data.loan_id === loanId);
const AGENT = "foreclosure-ops";
const HOLD_INSTRUCTIONS = /^(RESUME|CERTIFY_SALE)$/;
const STEPS = ["refer", "first_notice", "judgment_motion", "sale_schedule", "sale_certify", "sale_conduct", "eviction"] as const;
type Step = (typeof STEPS)[number];
/** 13.2 hold vocabulary → the gate each hold enforces, so a refusal names the gate (`foreclosure.gate.refused{code}`), never a generic code. */
const HOLD_GATES: readonly [RegExp, string][] = [[/^scra/, "SCRA_3953C_FC_PROTECTION_GATE"], [/^bk|bankrupt/, "BK_362_STAY_GATE"], [/^litigation/, "LITIGATION_HOLD"], [/^environmental/, "FNMA_F108_ENV_NO_FORECLOSURE_GATE"], [/^title/, "TITLE_HOLD"], [/^disaster/, "FNMA_D1301_DISASTER_FC_APPROVAL_GATE"], [/^(fnma_(trial|plan)_performing|hold_performing)$/, "REGX_1024_41G_TRIAL_PERFORMING_FC_GATE"], [/^regx_f2_prefiling$/, "REGX_1024_41F2_PRE_FILING_APP_GATE"], [/^transfer_k2$/, "REGX_1024_41K2_NO_FIRST_FILING_GATE"], [/^state_dual_track:MN/, "STATE_MN_582_043_DUAL_TRACK_GATE"], [/^state_dual_track:CA/, "STATE_CA_2924_18_DUAL_TRACK_GATE"]];
const gateForHold = (kind: string): string => HOLD_GATES.find(([re]) => re.test(kind))?.[1] ?? (kind.startsWith("state_dual_track:") ? `STATE_${kind.slice(17).toUpperCase()}_DUAL_TRACK_GATE` : "REGX_1024_41G_DUAL_TRACK_GATE");
const COURT_RELIEF = /court[_ -]?relief|petition[_ ]to[_ ]proceed|proceed[_ ]despite|relief[_ ]from[_ ]scra|motion[_ ]to[_ ]proceed/i;
const escalationCreate = (): Omit<ToolDef, "process" | "agent"> => ({ name: "escalation.create", kind: "act", handler: escalate("officer") });
const lossmitCaseGet = (): Omit<ToolDef, "process" | "agent"> => ({ name: "lossmit.case.get", kind: "read", handler: read("lossmit_applications") });
const contactsSearch = (): Omit<ToolDef, "process" | "agent"> => ({ name: "contacts.search", kind: "read", handler: compute((i, _c, rt) => rt.store.list("contacts").filter((r) => r.data.loan_id === str(i, "loan_id") && (!str(i, "purpose") || r.data.purpose === str(i, "purpose"))).map((r) => r.data)) });
const inspectionGet = (): Omit<ToolDef, "process" | "agent"> => ({ name: "inspection.get", kind: "read", handler: read("inspections") });
const draSnapshotGet = (): Omit<ToolDef, "process" | "agent"> => ({ name: "dra.snapshot.get", kind: "read", handler: read("dra_snapshots") });

// ---- shared gate facts (store/event-log backed) ----------------------------------------
/** 13.2 guardrail, enforced on the store: every open `foreclosure_holds` row for the loan (12.x writes `status: active|released`; 13.x/14.x writers may close with `closed_at`), never the caller's `open_holds`. */
const holdOpen = (d: Row): boolean => d.status !== "released" && d.status !== "closed" && (d.closed_at === undefined || d.closed_at === null);
const openHoldRows = (rt: Rt, loanId: string) => loanRows(rt, "foreclosure_holds", loanId).filter((r) => holdOpen(r.data));
const openHolds = (rt: Rt, loanId: string): string[] => openHoldRows(rt, loanId).map((r) => String(r.data.kind));
const openCase = (rt: Rt, loanId: string): (Row & { id: string }) | null => { const r = rt.store.list("foreclosure_cases").find((c) => c.data.loan_id === loanId && c.data.status !== "closed"); return r ? { ...r.data, id: r.id } : null; };
const isCompleteApp = (a: Row): boolean => /complete/.test(String(a.status ?? "")) && !/incomplete/.test(String(a.status ?? ""));
const appReceived = (a: Row): PlainDate | null => dateOf(a.complete_received_on) ?? dateOf(a.completed_on) ?? dateOf(a.received_on);
const F2_EXITS = ["ineligible_no_appeal", "appeal_denied", "all_offers_rejected", "agreement_defaulted"];
const G_EXITS = ["ineligible_notice_no_appeal", "appeal_denied", "all_options_rejected", "trial_failed", "shortsale_window_ended"];
/** §1024.41(f)(2)/(g) facts from the 12.x application rows and the case's first-notice/sale dates — never from the caller. */
const applicationFacts = (rt: Rt, loanId: string) => {
  const fc = openCase(rt, loanId); const firstNotice = dateOf(fc?.first_notice_filed_at); const sale = dateOf(fc?.sale_on) ?? dateOf(fc?.sale_held_at);
  const apps: (Row & { id: string })[] = loanRows(rt, "lossmit_applications", loanId).map((r): Row & { id: string } => ({ ...r.data, id: r.id }));
  const complete = apps.filter(isCompleteApp);
  const exitOf = (a: Row): string => String(a.exit ?? a.g_exit ?? a.f2_exit ?? "");
  const beforeFirstNotice = complete.filter((a) => { const rcv = appReceived(a); return !!rcv && (firstNotice === null || rcv < firstNotice) && !F2_EXITS.includes(exitOf(a)); });
  const afterFirstNotice = complete.filter((a) => { const rcv = appReceived(a); return !!rcv && firstNotice !== null && rcv >= firstNotice && (sale === null || daysBetween(rcv, sale) > 37) && !G_EXITS.includes(exitOf(a)); });
  const pending = apps.filter((a) => !/closed|withdrawn|denied|exited/.test(String(a.status ?? "")) && !exitOf(a));
  const reasonable = apps.map((a) => dateOf(a.reasonable_date)).filter((d): d is PlainDate => d !== null).sort().at(-1) ?? null;
  return {
    f2: { complete_app_before_first_notice: beforeFirstNotice.length > 0, exit: beforeFirstNotice.length ? "" : exitOf(complete.at(-1) ?? {}), duplicative_41i: complete.some((a) => a.duplicative_41i === true), application_ids: beforeFirstNotice.map((a) => String(a.id)) },
    g: { complete_app_after_first_notice: afterFirstNotice.length > 0, exit: afterFirstNotice.length ? "" : exitOf(complete.at(-1) ?? {}), application_ids: afterFirstNotice.map((a) => String(a.id)) },
    pending: pending.length > 0, pending_status: pending.some((a) => isCompleteApp(a)) ? "pending_complete" as const : pending.length ? "pending_incomplete" as const : "none" as const,
    complete_first_lien_pending: pending.some((a) => isCompleteApp(a)), reasonable_date: reasonable, first_notice_filed_at: firstNotice, sale_on: sale, case_id: fc ? String(fc.id ?? fc.case_id ?? "") : "",
  };
};
/**
 * 13.8: the loan's SCRA case after the tail sweep. The engine — never the agent — closes a case the day after
 * `protection_ends_on` (rule 3: calendar-year tail, gate opens the following day): `scra.case.closed{reason=tail_expired}`
 * plus `foreclosure.gate.opened{code=SCRA_3953C_FC_PROTECTION_GATE, reason=tail_expired}` (satisfies SCRA_3953_TAIL_1Y).
 * Rows carry the 0015 `scra_cases` columns (`case_id`, `basis`, `pre_service_obligation`, dates, `status`); the
 * closing reason and the gate-opening date live on the events and the evaluation row.
 */
const scraCaseFor = (rt: Rt, ctx: Ctx, loanId: string): Row | null => {
  const rec = rt.store.list("scra_cases").find((r) => r.data.loan_id === loanId && r.data.status !== "closed");
  if (!rec) return null;
  const ends = dateOf(rec.data.protection_ends_on);
  if (rec.data.status === "open_tail_12m" && ends && todayOf(ctx) > ends) {
    const gateOpensOn = addDays(ends, 1);
    const closed = rt.store.put("scra_cases", rec.id, { status: "closed" }, ctx.actor, ctx.now);
    ctx.events.append({ type: "scra.case.closed", loanId, actor: ctx.actor, payload: { case_id: rec.id, reason: "tail_expired", protection_ends_on: ends, gate_opens_on: gateOpensOn, closed_on: ctx.now.slice(0, 10) } });
    gateOpened(rt, ctx, loanId, "SCRA_3953C_FC_PROTECTION_GATE", "tail_expired", { case_id: rec.id, protection_ends_on: ends, gate_opens_on: gateOpensOn });
    return closed.data;
  }
  return rec.data;
};
/** The newest `scra_cases` row for the loan, closed or not (its `service_end_on` dates the tail an older Y certificate predates). */
const scraCaseAny = (rt: Rt, loanId: string): Row | null => loanRows(rt, "scra_cases", loanId).map((r) => r.data).sort((a, b) => (String(a.service_begin_on ?? "") < String(b.service_begin_on ?? "") ? 1 : -1))[0] ?? null;
/**
 * Facts for `13.8.protectionGateOpen`, all from the store: on duty while the case is `open_active_duty` **or the loan's
 * latest DMDC certificate says Y** (13.4-T5: the Y result governs — a case row is the D2-3.4-01 consequence, not the
 * precondition) dated on/after any recorded service end; in the tail the gate stays closed through `protection_ends_on`
 * inclusive; a court order at Fannie Mae's direction or a reviewed §3918 agreement is the attorney's recorded
 * `foreclosure_gate_evaluations` row (`result=open`, `reason_code=<basis>`) for this case — never a caller flag.
 */
const scraGateFacts = (rt: Rt, ctx: Ctx, loanId: string, scra: Row | null) => {
  const anyCase = scra ?? scraCaseAny(rt, loanId); const v = latestDmdc(rt, loanId);
  const yOnFile = v?.on_active_duty === "Y" && (!anyCase?.service_end_on || String(v.status_date ?? "") >= String(anyCase.service_end_on));
  const exception = scra ? rt.store.list("foreclosure_gate_evaluations").map((r) => r.data).filter((e) => e.loan_id === loanId && e.gate_code === "SCRA_3953C_FC_PROTECTION_GATE" && e.result === "open" && GATE_EXCEPTION_BASES.includes(String(e.reason_code) as "section_3918_agreement") && (e.inputs as Row | undefined)?.case_id === scra.case_id).map((e) => String(e.reason_code)).at(-1) ?? null : null;
  return { active_duty: scra?.status === "open_active_duty" || yOnFile, protection_ends_on: scra?.status === "open_tail_12m" ? String(scra.protection_ends_on ?? "") : "", today: todayOf(ctx), court_order_at_fnma_direction: exception === "court_order_at_fnma_direction", section_3918_agreement_reviewed: exception === "section_3918_agreement", dmdc_verification_id: v?.id ?? null, scra_case_id: scra?.case_id ?? null };
};
const GATE_EXCEPTION_BASES = ["court_order_at_fnma_direction", "section_3918_agreement"] as const;
/** One append-only `foreclosure_gate_evaluations` row in the 0015 shape: `result ∈ {open, closed}` (does the step proceed?), `reason_code` carries the gate code, `not_applicable` or `exception_open:<ground>`, and the evaluator rides in `inputs`. */
const evaluationRow = (rt: Rt, ctx: Ctx, loanId: string, gateCode: string, step: string, result: "open" | "closed", reasonCode: string | null, inputs: Row, evaluator: string | null): string => {
  const n = rt.store.list("foreclosure_gate_evaluations").length + 1;
  return rt.store.put("foreclosure_gate_evaluations", `fge-${loanId}-${step}-${gateCode}-${ctx.now}-${n}`, { loan_id: loanId, case_id: openCase(rt, loanId)?.id ?? null, gate_code: gateCode, step, evaluated_at: ctx.now, result, reason_code: reasonCode, inputs: { ...inputs, evaluator }, rule_set_version: "13.1@tools.v1", command_id: ctx.run?.runId ?? null }, ctx.actor, ctx.now).id;
};
/** 13.1 Outputs: `foreclosure.gate.opened{code}` with its evaluation row (append-only projection; the opening is not step-scoped, so the row's `step` is `*`). */
const gateOpened = (rt: Rt, ctx: Ctx, loanId: string, code: string, reason: string, inputs: Row): void => {
  evaluationRow(rt, ctx, loanId, code, "*", "open", reason, inputs, "13.8.protectionGateOpen");
  ctx.events.append({ type: "foreclosure.gate.opened", loanId, actor: ctx.actor, payload: { code, reason, ...inputs } });
};
/**
 * 13.1 Outputs / 13.2 timer rows ("refused; sev 1"): a command a closed gate stops leaves its trail — the evaluation row
 * (`result=closed`), `foreclosure.gate.refused{command, code, step}` and the sev-1 Compliance Sentinel escalation — and
 * the returned `GateClosed` (ref = the gate code) fails the command. Nothing leaves for the attorney network.
 */
const refuseOnGate = (rt: Rt, ctx: Ctx, loanId: string, step: string, command: string, gate: string, reason: string, opensOn: PlainDate | null, inputs: Row, evaluator: string | null): GateClosed => {
  const r = refusedReferral({ gate, opens_on: opensOn, attempted_on: todayOf(ctx), actor: ctx.actor.id });
  const evaluationId = evaluationRow(rt, ctx, loanId, gate, step, "closed", gate, inputs, evaluator);
  ctx.events.append({ type: r.event.type, loanId, actor: ctx.actor, payload: { ...r.event, code: gate, step, command, reason, evaluation_id: evaluationId } });
  rt.escalations.open({ kind: "sev1", ownerRole: "compliance_sentinel", loanId, payload: { reason: r.escalation.reason, gate, step, command, evaluation_id: evaluationId } }, ctx.actor);
  return new GateClosed(gate, `${command} refused by ${gate}: ${reason}`);
};
/** The loan's newest `scra_verifications` row (13.8 data model: `on_active_duty`, `status_date`, `purpose`, `certificate_id`). */
const latestDmdc = (rt: Rt, loanId: string): (Row & { id: string }) | null => loanRows(rt, "scra_verifications", loanId).map((r): Row & { id: string } => ({ ...r.data, id: r.id })).sort((a, b) => (`${a.status_date ?? ""}|${a.requested_at ?? ""}` < `${b.status_date ?? ""}|${b.requested_at ?? ""}` ? 1 : -1))[0] ?? null;
const dmdcAgeDays = (rt: Rt, ctx: Ctx, loanId: string): number => { const v = latestDmdc(rt, loanId); const on = dateOf(v?.status_date); return on && v?.on_active_duty !== "Z" ? daysBetween(on, todayOf(ctx)) : Number.POSITIVE_INFINITY; };
const BID_MONEY_FIELDS = ["max_bid_cents", "bid_cents", "opening_bid_cents", "total_indebtedness_cents", "reserve_price_cents", "interest_cents", "insurance_claims_cents", "insurance_claim_outstanding_cents"] as const;
/**
 * 13.3 rule 5 / E-3.3-05 — money figures computed by deterministic code; the model never edits amounts. Total
 * indebtedness is `totalIndebtedness()` over the loan's balances (`loans` / `fc_timeframe_tracking`: UPB, note rate, LPI
 * due date, escrow and corporate advances, attorney fees — the case's reviewed `attorney_invoices` when any exist —
 * costs, late charges, outstanding insurance claims) to the case's scheduled sale date; the bid is `bid()` against Fannie
 * Mae's reserve price (`reserve_prices`, from `fnma.reserve_price.received{expires_on}`) — an expired reserve falls back to
 * indebtedness (`reserveFallback`, 13.3-T10), never lower. An officer override rides in `changes` (moneyFields) and is
 * still refused below indebtedness without an unexpired reserve. Writes the `bid_instructions` row (13.3 data model).
 */
const bidInstruction = (rt: Rt, ctx: Ctx, loanId: string, i: ToolInput): { id: string; data: Row } => {
  const loan = rt.store.get("loans", loanId)?.data ?? {}; const fc = openCase(rt, loanId); const tracking = rt.store.list("fc_timeframe_tracking").find((r) => r.data.loan_id === loanId || (fc !== null && r.data.case_id === fc.id))?.data ?? {};
  const pick = (k: string): unknown => loan[k] ?? tracking[k] ?? fc?.[k];
  const saleOn = dateOf(fc?.sale_on) ?? dateOf(fc?.sale_scheduled_at) ?? dateOf(fc?.sale_at); if (!saleOn) throw new RangeError(`no scheduled sale on the foreclosure case for ${loanId} (foreclosure.sale.scheduled) — bid instructions are issued against the sale date (E-3.3-05)`);
  const lpi = dateOf(pick("lpi_due_date")) ?? dateOf(pick("lpi_due")); if (!lpi) throw new RangeError("lpi_due_date is required on loans/fc_timeframe_tracking (13.3 rule 5)");
  if (pick("upb_cents") === undefined || pick("note_rate_pct") === undefined) throw new RangeError("upb_cents and note_rate_pct are required on the loan row (13.3 rule 5)");
  const invoices = rt.store.list("attorney_invoices").filter((r) => (fc !== null && (r.data.case_id === fc.id || r.data.matter_id === fc.id)) || r.data.loan_id === loanId).filter((r) => ["reviewed", "approved", "paid"].includes(String(r.data.status)));
  const attorneyFees = invoices.length ? invoices.reduce((s, r) => s + cents(r.data.fee_approved_cents), 0n) : cents(pick("attorney_fees_cents"));
  const claims = cents(pick("insurance_claims_cents") ?? pick("insurance_claim_outstanding_cents"));
  const ti = totalIndebtedness({ upb_cents: cents(pick("upb_cents")), note_rate_pct: String(pick("note_rate_pct")), lpi_due: lpi, sale_on: saleOn, escrow_advances_cents: cents(pick("escrow_advances_cents")), corporate_advances_cents: cents(pick("corporate_advances_cents")), attorney_fees_cents: attorneyFees, costs_cents: cents(pick("costs_cents")), late_charges_cents: cents(pick("late_charges_cents")), insurance_claims_cents: claims });
  const reserve = loanRows(rt, "reserve_prices", loanId).map((r) => r.data).sort((a, b) => (String(a.received_on ?? "") < String(b.received_on ?? "") ? 1 : -1))[0] ?? (fc?.reserve_price_cents !== undefined && fc?.reserve_price_cents !== null ? { reserve_price_cents: fc.reserve_price_cents, expires_on: fc.reserve_expires_on ?? null } : null);
  const fb = reserveFallback({ reserve_cents: reserve ? cents(reserve.reserve_price_cents) : null, reserve_expires_on: dateOf(reserve?.expires_on), sale_on: saleOn, refresh_available_by: null, total_indebtedness_cents: ti.total_cents });
  const transferTax = loan.transfer_tax_no_exemption === true || fc?.transfer_tax_incremental === true;
  const b = bidOf(ti.total_cents, fb.basis === "reserve" ? fb.max_bid_cents : null, transferTax, fb.basis === "reserve" ? { expires_on: dateOf(reserve?.expires_on), sale_on: saleOn } : null);
  const changes = (i.changes as Row | undefined) ?? {}; let max = b.max_bid_cents; let override: string | null = null;
  if (changes.max_bid_cents !== undefined) { const o = cents(changes.max_bid_cents); if (o < ti.total_cents && fb.basis !== "reserve") throw new RangeError(`bid ${o} below total indebtedness ${ti.total_cents} refused: no unexpired reserve price (13.3 guardrail; E-3.3-05)`); max = o; override = `officer override by ${ctx.actor.kind}:${ctx.actor.id}`; }
  const rec = rt.store.put("bid_instructions", `bid-${loanId}-${saleOn}-${ctx.now}`, { case_id: fc?.id ?? null, loan_id: loanId, sale_at: saleOn, basis: fb.basis === "reserve" ? "reserve_price" : "total_indebtedness", reserve_price_cents: reserve ? cents(reserve.reserve_price_cents) : null, reserve_expires_on: reserve?.expires_on ?? null, total_indebtedness_cents: ti.total_cents, interest_cents: ti.interest_cents, interest_days: ti.days, insurance_claim_outstanding_cents: claims, bid_cents: max, opening_bid_cents: transferTax ? b.opening_bid_cents : max, transfer_tax_incremental: transferTax, issued_at: ctx.now, rationale: override ? `${fb.rationale}; ${override}` : fb.rationale }, ctx.actor, ctx.now);
  return { id: rec.id, data: rec.data };
};

// ---- attorney.instruction.send (13.2 / 13.5 / 13.8; carries the 13.3 and 13.9 sentences) -------------------------
const attorneyInstructionSend = (): Omit<ToolDef, "process" | "agent"> => ({ name: "attorney.instruction.send", kind: "act", moneyFields: [...BID_MONEY_FIELDS], handler: compute((i, ctx, rt) => { need(i, "loan_id", "kind"); const loanId = str(i, "loan_id"); const kind = str(i, "kind"); const command = `attorney.instruction.send{kind=${kind}}`;
    if (HOLD_INSTRUCTIONS.test(kind)) {
      const step: Step = kind === "RESUME" ? "judgment_motion" : "sale_certify";
      const holds = openHoldRows(rt, loanId);
      if (holds.length) { const kinds = holds.map((r) => String(r.data.kind)); throw refuseOnGate(rt, ctx, loanId, step, command, gateForHold(kinds[0]!), `foreclosure_holds open for ${loanId} (${kinds.join(", ")}) — release the hold through its writer first (13.2 guardrail)`, null, { holds: holds.map((r) => ({ id: r.id, kind: r.data.kind, scope: r.data.scope ?? null })) }, null); }
      // §1024.41(g) facts come from the 12.x application rows (a complete application after the first notice and >37 days before the sale), not from the holds table the line above already cleared, and never from the caller.
      // 13.2 (g)(1) exit determination first: a denial's 14-day appeal window that has expired (or an appeal on file) closes on the event log and the application row carries the exit (`appealWindowSweep`, ops-13-2.ts).
      for (const c of appealWindowSweep(ctx.events, ctx.actor, { loan_id: loanId, today: todayOf(ctx), applications: loanRows(rt, "lossmit_applications", loanId).map((r) => appealWindowFacts(r.id, r.data)) }).closed) if (c.exit) rt.store.put("lossmit_applications", c.application_id, { exit: c.exit, appeal_window_closed_on: c.closed_on, appeal_window_outcome: c.outcome }, ctx.actor, ctx.now);
      const apps = applicationFacts(rt, loanId); const gFacts = { complete_app_after_first_notice: apps.g.complete_app_after_first_notice, exit: apps.g.exit, application_ids: apps.g.application_ids };
      const g = evaluateGate("13.2.dualTrackGateOpen", gFacts); if (!g.open) throw refuseOnGate(rt, ctx, loanId, step, command, "REGX_1024_41G_DUAL_TRACK_GATE", `13.2.dualTrackGateOpen: ${g.reason ?? "closed"}`, null, gFacts, "13.2.dualTrackGateOpen");
      const sFacts = scraGateFacts(rt, ctx, loanId, scraCaseFor(rt, ctx, loanId));
      const s = evaluateGate("13.8.protectionGateOpen", sFacts); if (!s.open) throw refuseOnGate(rt, ctx, loanId, step, command, "SCRA_3953C_FC_PROTECTION_GATE", `13.8.protectionGateOpen: ${s.reason ?? "closed"}`, sFacts.protection_ends_on ? addDays(D(sFacts.protection_ends_on), 1) : null, sFacts, "13.8.protectionGateOpen");
      // 13.8 SCRA_3931_AFFIDAVIT_GATE ("motion instruction refused"): once the firm has proposed a judicial default-judgment/dispositive motion, the instruction to proceed to it leaves only after the signing_officer's affidavit on ≤30-day certificates is filed (50 U.S.C. §3931; facts from ./section13-8.ts, never the caller).
      if (step === "judgment_motion") { const aFacts = affidavitGateFacts_13_8(rt, ctx, loanId); if (aFacts.judicial_motion_proposed) { const a = evaluateGate("13.8.affidavitOnFreshCertificates", aFacts); if (!a.open) throw refuseOnGate(rt, ctx, loanId, step, command, "SCRA_3931_AFFIDAVIT_GATE", `13.8.affidavitOnFreshCertificates: ${a.reason ?? "closed"}`, null, aFacts, "13.8.affidavitOnFreshCertificates"); } }
    }
    const bidRec = kind === "BID_INSTRUCTIONS" ? bidInstruction(rt, ctx, loanId, i) : null;
    const rec = rt.store.put("attorney_instructions", str(i, "id") || `ai-${loanId}-${kind}-${ctx.now}`, { loan_id: loanId, kind, firm_id: str(i, "firm_id") || null, sent_at: ctx.now, status: "sent", ack_due_business_days: 1, ...(bidRec ? { bid_instruction_id: bidRec.id, basis: bidRec.data.basis === "reserve_price" ? "reserve" : "indebtedness", max_bid_cents: bidRec.data.bid_cents, opening_bid_cents: bidRec.data.opening_bid_cents, total_indebtedness_cents: bidRec.data.total_indebtedness_cents, reserve_price_cents: bidRec.data.reserve_price_cents, reserve_expires_on: bidRec.data.reserve_expires_on, sale_at: bidRec.data.sale_at } : {}) }, ctx.actor, ctx.now);
    ctx.events.append({ type: "attorney.instruction.sent", loanId, actor: ctx.actor, payload: { instruction_id: rec.id, kind, ...(bidRec ? { bid_instruction_id: bidRec.id } : {}) } });
    // 13.2 Outputs: CERTIFY_SALE ⇒ `foreclosure.sale.certified` (E-3.3-02 window), POSTPONE_SALE ⇒ `foreclosure.sale.postpone_instructed`, WORKOUT_AGREED/REINSTATED ⇒ `foreclosure.workout.firm_notified` (E-3.2-06) — ops-13-2.ts.
    recordSaleInstruction(ctx.events, ctx.actor, { loan_id: loanId, instruction_id: rec.id, kind, today: todayOf(ctx), sale_at: dateOf(openCase(rt, loanId)?.sale_on) ?? optDate(i, "sale_on"), until: optDate(i, "until"), firm_id: str(i, "firm_id") || null }, ctx.timers);
    if (bidRec) ctx.events.append({ type: "foreclosure.sale.bid.issued", loanId, actor: ctx.actor, payload: { bid_instruction_id: bidRec.id, instruction_id: rec.id, basis: bidRec.data.basis, bid_cents: bidRec.data.bid_cents, total_indebtedness_cents: bidRec.data.total_indebtedness_cents, sale_at: bidRec.data.sale_at } });
    return rec.data; }),
  guardrails: [never("NO_RESUME_WHILE_HELD", "13.2 guardrail: no RESUME/CERTIFY_SALE instruction while any hold is open", (i) => HOLD_INSTRUCTIONS.test(str(i, "kind")) && Array.isArray(i.open_holds) && (i.open_holds as unknown[]).length > 0, "release the hold through 12.x first (the handler also checks foreclosure_holds and the 13.2/13.8 evaluator gates)"),
    never("GUIDE_MANDATED_ONLY", "13.6 guardrail: the agent never instructs a firm on legal strategy beyond Guide-mandated instructions", (i) => !/^(HOLD|HOLD_DISPOSITIVE|POSTPONE_SALE|RESUME|CERTIFY_SALE|CANCEL_SALE|BID_INSTRUCTIONS|WITHDRAW_MOTION|REQUEST_CONTINUANCE|SCRA_STAY|STATUS_DEMAND|BK_HOLD|BK_FILED|REFER_BACK|DOCUMENT_REQUEST|WORKOUT_AGREED|REINSTATED)$/.test(str(i, "kind")), "hold/postpone/bid/certify and the Guide's other mandated instructions only"),
    never("NO_MODEL_BID_FIGURES", "13.3 guardrail: money figures computed by deterministic code; the model never edits amounts — the bid is totalIndebtedness()/bid() over the loan's balances, the case's sale date and Fannie Mae's reserve price (E-3.3-05)", (i) => str(i, "kind") === "BID_INSTRUCTIONS" && has(i, ...BID_MONEY_FIELDS, "sale_on", "reserve_expires_on"), "omit the figures; an officer override travels in `changes` (moneyFields)"),
    never("BID_BELOW_INDEBTEDNESS_NEEDS_RESERVE", "13.3 guardrail: any bid below total indebtedness without an unexpired reserve price is refused (E-3.3-05)", (i) => { const c = (i.changes as Row | undefined) ?? {}; return str(i, "kind") === "BID_INSTRUCTIONS" && c.max_bid_cents !== undefined && c.total_indebtedness_cents !== undefined && cents(c.max_bid_cents) < cents(c.total_indebtedness_cents); }, "bid total indebtedness, or refresh the reserve price (fnma.reserve_price.received with expires_on on/after the sale date); the handler refuses the same override against the computed indebtedness"),
    never("METHOD_DEVIATION_NEEDS_FORM20", "13.3 guardrail: any deviation from the preferred method needs Form 20 (13.7)", (i) => flag(i, "method_deviation") && !str(i, "form20_approval_id"), "obtain Regional Counsel approval via Form 20 first (FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE)"),
    needsRole("METHOD_DEVIATION_OFFICER", "13.3 guardrail: a deviation from the preferred method needs officer approval", (i) => flag(i, "method_deviation"), ["officer"], "the officer approves the non-preferred method with the Form 20 response attached"),
    never("NO_COURT_RELIEF_REQUEST", "13.9 guardrail / D2-3.4-01: no court-relief request (petition to proceed against a servicemember) is ever prepared", (i) => flag(i, "court_relief_request") || COURT_RELIEF.test(str(i, "kind")) || COURT_RELIEF.test(str(i, "subject")), "Fannie Mae prohibits seeking consent or petitioning to proceed; wait for the tail or the attorney's court order at Fannie Mae's direction")] });

// ---- 13.1 120-day prohibition ------------------------------------------------------
type GateResultKind = "open" | "closed" | "not_applicable" | "exception_open";
interface GateEvaluation { readonly gate_code: string; readonly step: Step; readonly result: GateResultKind; readonly reason_code: string | null; readonly reason: string | null; readonly evaluator: string | null; readonly inputs: Row }
/** The loan's counters, from the loan row only (13.1: "computed daily (baseline §3) with FIFO crediting"; T2: the anchor moves only when a full periodic payment is credited). */
const counters = (rt: Rt, ctx: Ctx, loanId: string) => { const loan = rt.store.get("loans", loanId)?.data ?? {}; const eu = dateOf(loan.earliest_unpaid_due) ?? dateOf(loan.earliest_unpaid_due_date); const today = todayOf(ctx); return { loan, today, earliest_unpaid_due: eu, regx_days_delinquent: regxDays(today, eu), fc_120_day_open_on: eu ? addDays(eu, 121) : null, fc_referral_deadline_on: eu ? addDays(eu, 120) : null }; };
/**
 * 13.1 rule 3: `loans.principal_residence` from origination occupancy, overridden by a verified change on file — a
 * borrower statement recorded in `contacts` (`occupancy_statement`), an inspection showing tenant occupancy with a lease
 * (`inspections.tenant_occupied` + `lease_document_id`) — unknown or disputed ⇒ principal residence. The model's own
 * conclusion (`model_conclusion`) is the only caller input, and below 0.9 it is escalated, never used.
 */
const occupancyEvidence = (rt: Rt, loanId: string, loan: Row): { occupancy: "principal_residence" | "non_principal" | "unknown"; evidence: Row[] } => {
  const evidence: Row[] = [];
  const stated = loanRows(rt, "contacts", loanId).map((r): Row & { id: string } => ({ ...r.data, id: r.id })).filter((c) => c.occupancy_statement === "non_principal" || c.occupancy_statement === "principal_residence").at(-1);
  const inspected = loanRows(rt, "inspections", loanId).map((r): Row & { id: string } => ({ ...r.data, id: r.id })).filter((x) => x.tenant_occupied === true && x.lease_document_id).at(-1);
  if (stated) evidence.push({ source: "contacts", id: stated.id, occupancy_statement: stated.occupancy_statement });
  if (inspected) evidence.push({ source: "inspections", id: inspected.id, tenant_occupied: true, lease_document_id: inspected.lease_document_id });
  const origination = loan.principal_residence === false || loan.occupancy === "non_principal" || loan.occupancy_type === "investment" || loan.occupancy_type === "second_home" ? "non_principal" : loan.principal_residence === true || loan.occupancy === "principal_residence" || loan.occupancy_type === "primary" ? "principal_residence" : "unknown";
  evidence.push({ source: "loans", principal_residence: loan.principal_residence ?? null, occupancy: loan.occupancy ?? loan.occupancy_type ?? null });
  const verified = stated ? (stated.occupancy_statement as "non_principal" | "principal_residence") : inspected ? "non_principal" : null;
  const disputed = verified !== null && origination !== "unknown" && verified !== origination && stated && inspected && stated.occupancy_statement !== "non_principal";
  return { occupancy: disputed ? "unknown" : verified ?? origination, evidence };
};
/** 13.3 rule 1 "package readiness": the note copy/original or LNA (`note_custody`), the assignment executed — and recorded where the state requires pre-foreclosure recordation — (`assignments`), and the E-1.1-03 data set (the case's `referral_package_document_id`). */
const packageReadiness = (rt: Rt, loanId: string, loan: Row, fc: (Row & { id: string }) | null) => {
  const custody = loanRows(rt, "note_custody", loanId).map((r) => r.data);
  const note = custody.some((c) => c.released_at || c.image_received_at || c.lost_note_affidavit_id);
  const mers = loan.mortgagee_of_record === "MERS" || loan.mers_mortgagee === true;
  const assignment = loanRows(rt, "assignments", loanId).map((r) => r.data).find((a) => a.executed_at && (loan.pre_recordation_state !== true || a.recorded_at)) ?? null;
  const assignmentOk = !mers || assignment !== null;
  const dataSet = Boolean(fc?.referral_package_document_id);
  return { ready: note && assignmentOk && dataSet, note_ready: note, assignment_ready: assignmentOk, mers_mortgagee: mers, data_set_ready: dataSet, case_id: fc?.id ?? null, missing: [...(note ? [] : ["note copy/original or LNA (note_custody)"]), ...(assignmentOk ? [] : ["MERS assignment executed/recorded (assignments)"]), ...(dataSet ? [] : ["E-1.1-03 data set (foreclosure_cases.referral_package_document_id)"])] };
};
const p131 = defineTools("13.1", AGENT, [
  { name: "loan.get", kind: "read", handler: read("loans") },
  { name: "delinquency.counters.get", kind: "read", handler: compute((i, ctx, rt) => { need(i, "loan_id"); const c = counters(rt, ctx, str(i, "loan_id")); return { loan_id: str(i, "loan_id"), regx_days_delinquent: c.regx_days_delinquent, earliest_unpaid_due: c.earliest_unpaid_due, today: c.today, fc_120_day_open_on: c.fc_120_day_open_on, fc_referral_deadline_on: c.fc_referral_deadline_on }; }),
    guardrails: [never("COUNTERS_ARE_COMPUTED", "13.1: `regx_days_delinquent` is computed daily from the loan's due-date history (baseline §3), never supplied", (i) => has(i, "today", "earliest_unpaid_due", "regx_days_delinquent"), "read the loan; a payment moves the anchor (2.1/2.2)")] },
  lossmitCaseGet(),
  contactsSearch(),
  inspectionGet(),
  /**
   * `foreclosure.gates.evaluate(loan_id, step)`: the ordered list of gate evaluations for the step with reasons (13.1
   * Integrations), each written as an append-only `foreclosure_gate_evaluations` row, with the 13.1 decision record.
   * Order follows 13.3 rule 1 for `refer`; the (g)/trial/method gates join for the later steps; every open
   * `foreclosure_holds` row is evaluated against its scope. Every fact comes from the store and the event log — the
   * counters, occupancy and state are the loan row's; the caller may add only its `model_conclusion` (occupancy, with
   * confidence) and name the `ground` and `step` it asks about; it can never open a gate.
   */
  { name: "foreclosure.gates.evaluate", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id"); const loanId = str(i, "loan_id"); const step = (str(i, "step") || "refer") as Step; if (!STEPS.includes(step)) throw new RangeError(`step must be one of ${STEPS.join(", ")}`);
      const { loan, today, earliest_unpaid_due: eu, regx_days_delinquent: days } = counters(rt, ctx, loanId); const fc = openCase(rt, loanId);
      const occEvidence = occupancyEvidence(rt, loanId, loan);
      const occ = occupancyDefault({ occupancy: occEvidence.occupancy, model_conclusion: (i.model_conclusion as { non_principal: boolean; confidence: number } | undefined) ?? null });
      // 13.1 guardrail: a "not a principal residence" conclusion below 0.9 goes to a human_agent (servicing specialist) before the non-PR path is used — opened, not merely returned.
      const occEscalation = occ.escalation ? rt.escalations.open({ kind: "human_agent", loanId, payload: { reason: occ.escalation.reason, model_conclusion: i.model_conclusion ?? null, treated_as: occ.treated_as, evidence: occEvidence.evidence } }, ctx.actor) : null;
      const pr = occ.treated_as === "principal_residence"; const state = String(loan.state ?? "").toUpperCase();
      // (f)(1)(ii)/(iii): the exception is an officer's record with counsel's memo (`foreclosure.exception.recorded`) — read from the store/event log, never from the caller.
      const ground = (str(i, "ground") || "default") as "default" | "due_on_sale" | "join_lienholder";
      const fromStore = rt.store.list("foreclosure_exceptions").find((r) => r.data.loan_id === loanId && r.data.kind === ground)?.data;
      const fromEvents = ctx.events.all().find((e) => e.type === "foreclosure.exception.recorded" && e.loanId === loanId && (e.payload as { kind?: unknown }).kind === ground)?.payload as Row | undefined;
      const exc = fromStore ?? fromEvents;
      const ex = ground !== "default" && eu ? exceptionGround({ ground, recorded_by_role: String(exc?.recorded_by_role ?? ""), counsel_memo_document_id: (exc?.counsel_memo_document_id as string | undefined) ?? null, today, earliest_unpaid_due: eu, principal_residence: pr }) : null;
      const g = gate120(today, eu, pr, ex?.allowed ? ground as "due_on_sale" : null);
      const apps = applicationFacts(rt, loanId); const holdRows = openHoldRows(rt, loanId); const holds = holdRows.map((r) => String(r.data.kind)); const scra = scraCaseFor(rt, ctx, loanId);
      const bk = loanRows(rt, "bankruptcy_cases", loanId).map((r) => r.data).find((c) => /active|open|pending/.test(String(c.status ?? "")) && !/lifted|terminated|released|relief_granted/.test(String(c.stay_status ?? "")));
      // 13.4 data model: `disaster_fc_approval_requests.fnma_response ∈ {pending, approved, denied, info_requested}`; the gate opens only on `approved`.
      const disasterRequests = loanRows(rt, "disaster_fc_approval_requests", loanId).map((r): Row & { id: string } => ({ ...r.data, id: r.id })); const disasterApproved = disasterRequests.filter((r) => r.fnma_response === "approved").at(-1) ?? null;
      const litigation = loanRows(rt, "litigation_matters", loanId).map((r) => r.data).at(-1) ?? null;
      // 13.7 data model: `environmental_hazards.severity ∈ {suspected, confirmed}`, `status ∈ {open, cleared, fnma_directed_proceed, fnma_directed_hold, charged_off}`, `fnma_direction`.
      const env = loanRows(rt, "environmental_hazards", loanId).map((r) => r.data).find((h) => h.severity === "confirmed" && !["cleared", "charged_off"].includes(String(h.status ?? ""))) ?? null;
      const envDirection = env ? (env.status === "fnma_directed_proceed" ? "proceed" : String(env.fnma_direction ?? "")) : "";
      const title = loanRows(rt, "title_orders", loanId).map((r) => r.data).find((t) => /defect|uncured|exception/.test(String(t.status ?? "")) && t.cured !== true) ?? null;
      const pkg = packageReadiness(rt, loanId, loan, fc);
      const review = loanRows(rt, "prereferral_reviews", loanId).map((r) => r.data).filter((r) => r.completed_at).at(-1) ?? null;
      const evals: GateEvaluation[] = [];
      const push = (gate_code: string, applies: boolean, evaluator: string | null, inputs: Row, direct?: { open: boolean; reason?: string | null; result?: GateResultKind }): void => {
        if (!applies) { evals.push({ gate_code, step, result: "not_applicable", reason_code: null, reason: null, evaluator, inputs }); return; }
        const r = direct ?? evaluateGate(evaluator!, inputs);
        evals.push({ gate_code, step, result: direct?.result ?? (r.open ? "open" : "closed"), reason_code: r.open ? null : gate_code, reason: r.open ? null : (r.reason ?? "closed"), evaluator, inputs });
      };
      const in_ = (...steps: Step[]): boolean => steps.includes(step);
      // 13.3 rule 1 order for `refer`; the step-scoped gates follow.
      push("REGX_1024_41F1_120_DAY_GATE", in_("refer", "first_notice"), "13.1.preForeclosureReviewPeriodElapsed", { regx_days_delinquent: days, non_principal_residence: !pr, earliest_unpaid_due: eu, today, exception_ground: ex?.allowed ? ground : null, occupancy_evidence: occEvidence.evidence }, !pr ? { open: true, result: "not_applicable" } : ex?.allowed ? { open: true, result: "exception_open" } : undefined);
      push("REGX_1024_41F2_PRE_FILING_APP_GATE", in_("refer", "first_notice"), "13.1.preFilingAppGateOpen", { ...apps.f2 });
      push("REGX_1024_41K2_NO_FIRST_FILING_GATE", in_("refer", "first_notice") && apps.reasonable_date !== null, null, { today, reasonable_date: apps.reasonable_date }, { open: apps.reasonable_date === null || today > apps.reasonable_date, reason: `no first notice/filing before the reasonable date ${apps.reasonable_date} on the incomplete-application acknowledgment (§1024.41(k)(2))` });
      push("FNMA_E1202_REFER_NO_EARLIER_121", in_("refer") && pr, null, { regx_days_delinquent: days, principal_residence: pr }, { open: days >= 121, reason: `day ${days}: a principal-residence referral is no earlier than day 121 (E-1.2-02)` });
      push("BK_362_STAY_GATE", true, null, { bankruptcy_case: bk ? String(bk.case_number ?? bk.id ?? "") : null, holds: holds.filter((h) => /bk|bankrupt/.test(h)) }, { open: !bk && !holds.some((h) => /bk|bankrupt/.test(h)), reason: "11 U.S.C. §362 automatic stay: no foreclosure step while a bankruptcy case is active (14.x)" });
      const scraFacts = scraGateFacts(rt, ctx, loanId, scra);
      push("SCRA_3953C_FC_PROTECTION_GATE", true, "13.8.protectionGateOpen", scraFacts);
      const age = dmdcAgeDays(rt, ctx, loanId);
      push("SCRA_DMDC_STALE_30", in_("refer", "first_notice", "judgment_motion", "eviction"), "13.4.dmdcCertificateFresh", { dmdc_certificate_age_days: age, verification_id: scraFacts.dmdc_verification_id });
      push("SCRA_DMDC_STALE_7", in_("sale_certify", "sale_conduct"), null, { dmdc_certificate_age_days: age, verification_id: scraFacts.dmdc_verification_id }, { open: age <= 7, reason: `DMDC certificate is ${age} days old; a pre-sale check is ≤7 days (13.8 decision 3)` });
      // 13.8 SCRA_3931_AFFIDAVIT_GATE: applies to judgment_motion once the firm has proposed a judicial default-judgment/dispositive motion (facts from ./section13-8.ts; same gate set at every step, not_applicable elsewhere).
      const affFacts = affidavitGateFacts_13_8(rt, ctx, loanId);
      push("SCRA_3931_AFFIDAVIT_GATE", in_("judgment_motion") && affFacts.judicial_motion_proposed, "13.8.affidavitOnFreshCertificates", affFacts);
      push("FNMA_D1301_DISASTER_FC_APPROVAL_GATE", true, "13.1.disasterApprovalOnFile", { disaster_impacted: loan.disaster_impacted === true || disasterRequests.length > 0 || holds.some((h) => /disaster/.test(h)), fnma_disaster_fc_approval_id: String(disasterApproved?.response_document_id ?? disasterApproved?.id ?? loan.fnma_disaster_fc_approval_id ?? ""), request_ids: disasterRequests.map((r) => r.id) });
      push("LITIGATION_HOLD", in_("refer", "judgment_motion", "sale_certify", "sale_conduct"), "13.7.litigationHoldReleased", { litigation_hold: holds.includes("litigation"), fnma_direction: String(litigation?.fnma_direction ?? "") });
      push("FNMA_F108_ENV_NO_FORECLOSURE_GATE", true, "13.7.environmentalDirectionToProceed", { environmental_hazard_confirmed: env !== null || holds.includes("environmental"), fnma_direction: envDirection, hazard_status: env?.status ?? null });
      const mn = mnReferralGate({ state, application_status: apps.pending_status });
      push("STATE_MN_582_043_DUAL_TRACK_GATE", in_("refer", "sale_schedule", "sale_conduct"), "13.2.mnDualTrackGateOpen", { state, application_pending: apps.pending }, in_("refer") ? { open: mn.allowed, reason: mn.refusal } : undefined);
      push("STATE_CA_2924_18_DUAL_TRACK_GATE", in_("first_notice", "sale_schedule"), "13.2.caDualTrackGateOpen", { state, complete_first_lien_application_pending: apps.complete_first_lien_pending && (loan.lien_position === undefined || Number(loan.lien_position) === 1 || loan.first_lien === true), owner_occupied: loan.owner_occupied === true || (loan.owner_occupied === undefined && pr) });
      push("TITLE_HOLD", in_("refer", "first_notice"), null, { title_order: title ? String(title.id ?? title.order_id ?? "") : null, holds: holds.filter((h) => /title/.test(h)) }, { open: title === null && !holds.some((h) => /title/.test(h)), reason: "uncured title defect blocking the action (13.3 rule 1)" });
      push("PACKAGE_READY", in_("refer"), null, { ...pkg }, { open: pkg.ready, reason: `referral package not ready: ${pkg.missing.join("; ")} (13.3 rule 1)` });
      push("REGX_1024_41G_DUAL_TRACK_GATE", in_("judgment_motion", "sale_schedule", "sale_certify", "sale_conduct"), "13.2.dualTrackGateOpen", { ...apps.g });
      push("REGX_1024_41G_TRIAL_PERFORMING_FC_GATE", in_("first_notice", "judgment_motion", "sale_schedule", "sale_certify", "sale_conduct"), "13.2.trialPerformingNoSale", { trial_active: holds.includes("fnma_trial_performing") || holds.includes("hold_performing"), trial_defaulted: false });
      push("FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE", in_("first_notice"), "13.5.methodDeviationApproved", { preferred_method: fc?.method_deviation !== true, form20_approval_id: String(fc?.form20_approval_id ?? "") });
      for (const h of holdRows) { const kind = String(h.data.kind); const scope = Array.isArray(h.data.scope) ? (h.data.scope as unknown[]).map(String) : null; const blocks = scope ? scope.includes(step) : Object.hasOwn(BLOCKED_BY_HOLD, kind) ? !stepAllowed(step, [kind as Hold]) : true; push(`HOLD:${kind}`, true, null, { hold_id: h.id, kind, scope, from: h.data.from ?? null, gate: gateForHold(kind) }, { open: !blocks, reason: `foreclosure_holds ${h.id} (${kind}) is open for ${step} — release it through its writer (13.2)` }); }
      // evaluation rows: append-only projections (13.1 data model) in the 0015 shape — `result ∈ {open, closed}`, the four-state gate result in `reason_code`.
      const evaluationIds = evals.map((e) => evaluationRow(rt, ctx, loanId, e.gate_code, step, e.result === "closed" ? "closed" : "open", e.result === "closed" ? e.gate_code : e.result === "open" ? null : e.result === "exception_open" ? `exception_open:${ground}` : "not_applicable", e.inputs, e.evaluator));
      const closed = evals.filter((e) => e.result === "closed"); const open = closed.length === 0;
      const gates: Gates = { regx_120: !closed.some((e) => e.gate_code === "REGX_1024_41F1_120_DAY_GATE"), regx_prefiling: !closed.some((e) => e.gate_code === "REGX_1024_41F2_PRE_FILING_APP_GATE"), no_first_filing_41k2: !closed.some((e) => e.gate_code === "REGX_1024_41K2_NO_FIRST_FILING_GATE"), fnma_121: !closed.some((e) => e.gate_code === "FNMA_E1202_REFER_NO_EARLIER_121"), bk_stay: closed.some((e) => e.gate_code === "BK_362_STAY_GATE"), scra: closed.some((e) => e.gate_code === "SCRA_3953C_FC_PROTECTION_GATE"), dmdc_age_days: Number.isFinite(age) ? age : 9_999, disaster_approval: !closed.some((e) => e.gate_code === "FNMA_D1301_DISASTER_FC_APPROVAL_GATE"), litigation_hold: closed.some((e) => e.gate_code === "LITIGATION_HOLD"), environmental_hold: closed.some((e) => e.gate_code === "FNMA_F108_ENV_NO_FORECLOSURE_GATE"), mn_dual_track: closed.some((e) => e.gate_code === "STATE_MN_582_043_DUAL_TRACK_GATE"), title_hold: closed.some((e) => e.gate_code === "TITLE_HOLD"), package_ready: !closed.some((e) => e.gate_code === "PACKAGE_READY") };
      const reviewOutcomeOf = String(review?.outcome ?? ""); const referral = step === "refer" ? referralEligible((["refer", "hold_lossmit", "hold_disaster_approval", "hold_scra", "hold_bankruptcy", "postpone_e3204"].includes(reviewOutcomeOf) ? reviewOutcomeOf : "hold_lossmit") as "refer", gates) : null;
      const attempted = flag(i, "attempt_referral") || flag(i, "attempt_step");
      const refused = attempted && !open ? refusedReferral({ gate: closed[0]!.gate_code, opens_on: closed[0]!.gate_code === "REGX_1024_41F1_120_DAY_GATE" ? g.opens_on ?? null : null, attempted_on: today, actor: ctx.actor.id }) : null;
      if (refused) { ctx.events.append({ type: refused.event.type, loanId, actor: ctx.actor, payload: { ...refused.event, code: refused.event.gate, step, command: `foreclosure.${step}`, closed: closed.map((e) => e.gate_code), evaluation_ids: evaluationIds } }); rt.escalations.open({ kind: "sev1", ownerRole: "compliance_sentinel", loanId, payload: { reason: refused.escalation.reason, gate: refused.event.gate, step, command: `foreclosure.${step}` } }, ctx.actor); }
      return { loan_id: loanId, step, open, blocked_by: closed.map((e) => e.gate_code), gates: evals, evaluation_ids: evaluationIds, occupancy: { ...occ, evidence: occEvidence.evidence, on_file: occEvidence.occupancy }, occupancy_escalation_id: occEscalation?.id ?? null, counters: { today, earliest_unpaid_due: eu, regx_days_delinquent: days }, gate_120: g, exception: ex, review_outcome: reviewOutcomeOf || null, referral, refused }; }),
    // 13.1 decision record: {loan_id, step, gate_results[], occupancy_evidence[], principal_residence_conclusion, confidence, rule_set_version, model_version, rationale} — the gate results are the evaluation rows it cites.
    decision: (i, output) => { const o = output as { loan_id: string; step: string; open: boolean; blocked_by: string[]; evaluation_ids: string[]; occupancy: { treated_as: string; evidence: Row[] } }; const m = i.model_conclusion as { non_principal?: boolean; confidence?: number } | undefined; return { action: `foreclosure.gates.evaluate:${o.step}`, rationale: `${o.open ? "all gates open" : `closed: ${o.blocked_by.join(", ")}`}; occupancy ${o.occupancy.treated_as} from ${o.occupancy.evidence.map((e) => e.source).join("+")}${m ? ` (model: non_principal=${String(m.non_principal)} @ ${String(m.confidence)})` : ""}`, subject: { kind: "loan", id: o.loan_id }, ruleCode: o.blocked_by[0] ?? "GATES_OPEN", evidenceDocumentIds: o.evaluation_ids }; },
    guardrails: [never("CANNOT_OPEN_GATE", "13.1 guardrail: the agent cannot open a closed gate; it can only add evidence that changes an input — the counters, occupancy and state are the loan row's (computed daily, baseline §3), and (f)(1)(ii)/(iii) exceptions are an officer's record with counsel's memo, never an input", (i) => flag(i, "force_open") || has(i, "exception", "exception_open", "gate_state", "recorded_by_role", "counsel_memo_document_id", "holds", "open_holds", "gates", "today", "earliest_unpaid_due", "regx_days_delinquent", "occupancy", "principal_residence", "non_principal_residence", "state", "package_ready"), "add evidence instead (a payment moves the anchor; a contact/inspection records occupancy); an officer records the exception with counsel's memo")] },
  escalationCreate(),
]);

// ---- 13.2 dual tracking --------------------------------------------------------------
const p132 = defineTools("13.2", AGENT, [
  { ...lossmitCaseGet(), guardrails: [never("NO_APP_STATUS_CHANGE", "13.2 guardrail: the agent cannot mark an application complete or rejected — only 12.x can", (i) => i.op === "write" && /complete|rejected/.test(str(i, "status")), "12.x owns application status")] },
  { name: "foreclosure.case.get", kind: "read", handler: compute((i, _c, rt) => { const c = rt.store.get("foreclosure_cases", str(i, "id"))?.data ?? null; const loanId = str(i, "loan_id") || String(c?.loan_id ?? ""); const stored = loanId ? openHolds(rt, loanId) : []; const holds = [...new Set([...stored, ...((i.holds as Hold[] | undefined) ?? [])])] as Hold[]; return { case: c, open_holds: stored, step_allowed: str(i, "step") ? stepAllowed(str(i, "step"), holds.filter((h) => Object.hasOwn(BLOCKED_BY_HOLD, h))) && !stored.some((h) => !Object.hasOwn(BLOCKED_BY_HOLD, h)) : null }; }) },
  attorneyInstructionSend(),
  /** Status read by default; `op: "acknowledge"` records the firm's inbound ACK (13.2 Integrations: "firm acknowledgment required within 1 BD (`attorney.instruction.acknowledged`)") — `acknowledged_at`/`ack_by` on the row and the event that closes REGX_1024_41G_INSTRUCT_COUNSEL_1BD, FNMA_E3104_BK_NOTIFY_FIRM_1BD, FNMA_E3205_BID_INSTRUCTIONS_5BD and arms SM_DRA_EVENT_EXPECTED_2BD. */
  { name: "attorney.instruction.status", kind: "write", handler: compute((i, ctx, rt) => { if (str(i, "op") === "firm_message") return firmMessageIngest_13_3(i, ctx, rt); if (str(i, "op") !== "acknowledge") return read("attorney_instructions")(i, ctx, rt);
      need(i, "id"); const cur = rt.store.require("attorney_instructions", str(i, "id")); const loanId = String(cur.data.loan_id ?? ctx.loanId);
      const rec = rt.store.put("attorney_instructions", cur.id, { status: "acknowledged", acknowledged_at: str(i, "acknowledged_at") || ctx.now, ack_by: str(i, "ack_by") || String(cur.data.firm_id ?? "firm"), evidence_document_id: str(i, "evidence_document_id") || null }, ctx.actor, ctx.now);
      ctx.events.append({ type: "attorney.instruction.acknowledged", loanId, actor: ctx.actor, payload: { instruction_id: rec.id, kind: String(rec.data.kind), firm_id: rec.data.firm_id ?? null, acknowledged_at: rec.data.acknowledged_at, ...(rec.data.bid_instruction_id ? { bid_instruction_id: rec.data.bid_instruction_id } : {}) } });
      if (rec.data.bid_instruction_id) rt.store.put("bid_instructions", String(rec.data.bid_instruction_id), { firm_ack_at: rec.data.acknowledged_at }, ctx.actor, ctx.now);
      return rec.data; }),
    decision: (i, output) => (str(i, "op") === "acknowledge" ? { action: "attorney.instruction.status:acknowledge", rationale: `firm acknowledged ${String((output as Row).kind)} instruction ${str(i, "id")}`, subject: { kind: "attorney_instruction", id: str(i, "id") } } : null) },
  draSnapshotGet(),
  { name: "timer.create", kind: "act", handler: timerOps() },
  { ...escalationCreate(), handler: escalate("attorney") },
]);

// ---- 13.4 prereferral review ---------------------------------------------------------
const request = (i: ToolInput): Row => ((i.request as Row | undefined) ?? {});
type Handler = (i: ToolInput, ctx: Ctx, rt: Rt) => unknown | Promise<unknown>;
const ITEM_RESULTS = ["pass", "fail", "n_a"];
const HOLD_ITEMS: Record<string, "scra_active" | "bk_hit" | "disaster_impacted" | "pr_prohibition_failing" | "nonpr_complete_brp"> = { SCRA_DMDC: "scra_active", BK_SCRUB: "bk_hit", DISASTER: "disaster_impacted", REGX_GATES: "pr_prohibition_failing", PR_NO_APPROVED_ARRANGEMENT: "pr_prohibition_failing", PR_NOT_IN_30_DAY_EVAL: "pr_prohibition_failing", PR_NO_OPEN_OFFER_WINDOW: "pr_prohibition_failing", PR_NOT_PERFORMING_ON_ACCEPTED_OFFER: "pr_prohibition_failing", PR_NO_OPEN_APPEAL: "pr_prohibition_failing", NONPR_BRP: "nonpr_complete_brp" };
/** A rule item's result derived from the adapter's answer (13.4 state machine: "Only the agent (rules + model …) and, on escalation, a human_agent verify items"); the caller's `item_result` never governs it. */
type DerivedItem = { result: "pass" | "fail" | "n_a"; evidence_ids: string[]; reason: string; item_code?: string } | null;
/** The current result per item code — the newest checklist entry for it (a human_agent's entry supersedes the model's `pending_human`). */
const currentItems = (checklist: readonly Row[]): Map<string, Row> => { const m = new Map<string, Row>(); for (const c of checklist) m.set(String(c.item_code), c); return m; };
/** 13.4 rule 2 facts the outcome reads from the store — the DMDC result and any open SCRA case (13.4-T5), an open 14.x case or `bk_stay` hold (13.4-T10), a disaster request not yet approved (13.4-T4). */
const reviewFacts = (rt: Rt, ctx: Ctx, loanId: string) => {
  const scra = scraGateFacts(rt, ctx, loanId, scraCaseFor(rt, ctx, loanId));
  const bk = loanRows(rt, "bankruptcy_cases", loanId).some((r) => /active|open|pending/.test(String(r.data.status ?? "")) && !/lifted|terminated|released|relief_granted/.test(String(r.data.stay_status ?? ""))) || openHolds(rt, loanId).some((h) => /bk|bankrupt/.test(h));
  const disaster = loanRows(rt, "disaster_fc_approval_requests", loanId).map((r) => r.data).some((r) => r.fnma_response !== "approved");
  return { scra_active: scra.active_duty, bk_hit: bk, disaster_impacted: disaster };
};
/**
 * 13.4 checklist: each item tool records its result on the review row (`prereferral_reviews.checklist`, one row per
 * attempt, versioned). A rule item (DMDC, bankruptcy scrub) records the adapter's result; a caller-recorded item needs
 * `item_result` and, for a `pass`, `evidence_document_id` (guardrail); a model-evaluated item below 0.85 is recorded
 * `pending_human` with the `human_agent` verification task opened — whatever result the model proposed — and is
 * resolved only by a human_agent's own entry for the same item (evaluator `human`), never by a caller flag;
 * `complete_review` computes the outcome (`reviewOutcome`) from the current items **and the store's facts** (an active
 * DMDC Y holds `hold_scra` even if every item passes, 13.4-T5) — MA needs the lead-paint citation search first.
 */
const withItem = (itemCode: string, handler: Handler, derive?: (base: unknown) => DerivedItem): Handler => async (i, ctx, rt) => {
  const base = await handler(i, ctx, rt);
  const derived = derive ? derive(base) : null;
  const requested = str(i, "item_result"); const complete = flag(i, "complete_review");
  if (!derived && !requested && !complete) return base;
  need(i, "loan_id"); const loanId = str(i, "loan_id"); const reviewId = str(i, "review_id") || `prr-${loanId}`;
  // The first entry on an attempt is the review start (ops-13-4 startReview: window, preconditions from the 11.x notices, `prereferral.review.started`, the scheduler's due event inside the window).
  if (!rt.store.get("prereferral_reviews", reviewId)) startReview({ events: ctx.events, store: rt.store, actor: ctx.actor, now: ctx.now }, { loan_id: loanId, review_id: reviewId, case_id: openCase(rt, loanId)?.id ?? null, state: str(i, "state") || null, principal_residence: typeof i.principal_residence === "boolean" ? i.principal_residence : null, earliest_unpaid_due: optDate(i, "earliest_unpaid_due"), breach_letter_expires_on: optDate(i, "breach_letter_expires_on"), solicitation_respond_by: optDate(i, "solicitation_respond_by"), latest_dmdc_certificate_date: optDate(i, "latest_dmdc_certificate_date") });
  const prev = rt.store.get("prereferral_reviews", reviewId)?.data; const checklist = [...((prev?.checklist as Row[] | undefined) ?? [])];
  let item: Row | null = null;
  if (derived || requested) {
    const code = derived ? derived.item_code ?? itemCode : str(i, "item") || itemCode; const result = derived ? derived.result : requested;
    if (!ITEM_RESULTS.includes(result)) throw new RangeError(`item_result must be one of ${ITEM_RESULTS.join(", ")}`);
    const modelled = !derived && typeof i.confidence === "number"; const human = !derived && !modelled && ctx.actor.kind === "human";
    const humanResolved = checklist.some((c) => c.item_code === code && c.evaluator === "human");
    const gate = modelled ? modelItemGate({ item: code, confidence: num(i, "confidence"), human_resolved: humanResolved }) : null;
    const task = gate?.verification_task ? rt.escalations.open({ kind: "human_agent", loanId, payload: { review_id: reviewId, item: code, confidence: num(i, "confidence"), proposed_result: result, reason: gate.verification_task.reason } }, ctx.actor) : null;
    item = { item_code: code, result: gate && !gate.review_can_complete ? "pending_human" : result, evidence_ids: derived ? derived.evidence_ids : [str(i, "evidence_document_id")].filter(Boolean), evaluated_at: ctx.now, evaluator: derived ? "rule" : modelled ? "model" : human ? "human" : "rule", ...(modelled ? { confidence: num(i, "confidence"), proposed_result: result } : {}), ...(task ? { verification_task_id: task.id } : {}), ...(derived ? { reason: derived.reason, ...(requested && requested !== derived.result ? { caller_result_ignored: requested } : {}) } : {}), ...(human ? { recorded_by: `${ctx.actor.kind}:${ctx.actor.id}`, role: ctx.actor.role ?? null } : {}) };
    checklist.push(item);
  }
  let outcome: string | null = (prev?.outcome as string | undefined) ?? null; let completedAt: string | null = (prev?.completed_at as string | undefined) ?? null;
  const current = currentItems(checklist);
  if (complete) {
    const state = (str(i, "state") || String(rt.store.get("loans", loanId)?.data.state ?? "")).toUpperCase();
    const lead = maLeadPaintItem({ state, citation_search_document_id: (i.citation_search_document_id as string | undefined) ?? ((current.get("MA_LEAD_PAINT")?.result === "pass" ? current.get("MA_LEAD_PAINT")!.evidence_ids as string[] : undefined)?.[0] ?? null) });
    if (lead.required && !lead.passed) throw new RangeError(lead.refusal!);
    const pending = [...current.values()].filter((c) => c.result === "pending_human").map((c) => String(c.item_code));
    if (pending.length) throw new RangeError(`review cannot complete: ${pending.join(", ")} await${pending.length === 1 ? "s" : ""} human_agent verification — a human_agent records the item on the review (13.4 guardrail; 13.4-T8)`);
    const failed = (code: string): boolean => current.get(code)?.result === "fail";
    const facts = reviewFacts(rt, ctx, loanId);
    const f = { items_all_pass: current.size > 0 && [...current.values()].every((c) => c.result === "pass" || c.result === "n_a"), pr_prohibition_failing: false, disaster_impacted: facts.disaster_impacted, nonpr_complete_brp: false, scra_active: facts.scra_active, bk_hit: facts.bk_hit };
    for (const [code, key] of Object.entries(HOLD_ITEMS)) if (failed(code)) f[key] = true;
    outcome = reviewOutcome(f); completedAt = ctx.now;
  }
  // Rule 1: a completion outside the window is recorded but not valid for referral (ops-13-4 completeReview; 13.4-T1).
  const prWin = typeof prev?.principal_residence === "boolean" ? prev.principal_residence : typeof i.principal_residence === "boolean" ? i.principal_residence : null;
  const window = (dateOf(prev?.window_opens_on) && dateOf(prev?.referral_required_on) ? { opens: dateOf(prev?.window_opens_on)!, referral_on: dateOf(prev?.referral_required_on)!, rule: prWin === true ? "refer_no_earlier_than" as const : "refer_by" as const } : null) ?? windowFor(optDate(i, "earliest_unpaid_due") ?? dateOf(rt.store.get("loans", loanId)?.data.earliest_unpaid_due_date), prWin);
  const done = complete && outcome ? completeReview({ events: ctx.events, store: rt.store, actor: ctx.actor, now: ctx.now }, { loan_id: loanId, review_id: reviewId, outcome, items: current.size, window, referral_on: optDate(i, "referral_on") }) : null;
  const rec = rt.store.put("prereferral_reviews", reviewId, { loan_id: loanId, case_id: prev?.case_id ?? openCase(rt, loanId)?.id ?? null, started_at: prev?.started_at ?? ctx.now, checklist, outcome, completed_at: completedAt, ...(complete ? { status: "completed", valid_for_referral: done?.valid_for_referral ?? null } : {}) }, ctx.actor, ctx.now);
  return { result: base, item, review: { id: rec.id, outcome, completed_at: completedAt, items: current.size, window, valid_for_referral: done?.valid_for_referral ?? null, referral: done?.referral ?? null, pending_human: [...current.values()].filter((c) => c.result === "pending_human").map((c) => String(c.item_code)) } };
};
const ITEM_GUARDRAILS = [
  never("ITEM_PASS_NEEDS_EVIDENCE", "13.4 guardrail: an item may be pass only with attached evidence", (i) => str(i, "item_result") === "pass" && !str(i, "evidence_document_id"), "attach the evidence document"),
  never("HUMAN_RESOLUTION_IS_RECORDED", "13.4 guardrail: model-evaluated items below 0.85 route to human_agent verification — the verification is the human_agent's own checklist entry, never a caller flag", (i) => has(i, "human_resolved", "verified_by_human", "human_verified"), "the human_agent records the item on the review (evaluator human); the review cannot complete until then"),
  never("MA_LEAD_PAINT", "13.4/F-1-08: MA needs the lead-paint citation search", (i) => str(i, "state") === "MA" && flag(i, "complete_review") && !maLeadPaintItem({ state: "MA", citation_search_document_id: (i.citation_search_document_id as string | undefined) ?? null }).passed, "evidence the citation search"),
];
const item = (name: string, kind: ToolDef["kind"], itemCode: string, handler: Handler, extra: readonly NonNullable<ToolDef["guardrails"]>[number][] = [], derive?: (base: unknown) => DerivedItem): Omit<ToolDef, "process" | "agent"> => ({ name, kind, handler: withItem(itemCode, handler, derive), guardrails: [...ITEM_GUARDRAILS, ...extra] });
const deps134 = (ctx: Ctx, rt: Rt) => ({ events: ctx.events, store: rt.store, actor: ctx.actor, now: ctx.now });
const p134 = defineTools("13.4", AGENT, [
  /**
   * 12.x case state for the review. `op=pr_prohibitions` evaluates the five E-3.2-01 principal-residence "must not
   * refer" items (ops-13-4 prProhibitions; 13.4-T2), `op=e3204_ladder` the non-principal-residence BRP item and its
   * E-3.2-04 ladder state (13.4-T3; an inquiry never postpones), `op=record_plan_payment` ingests a posted workout-plan
   * payment (`workout_plan.payment.received{first}` — the first one ends FNMA_E3204_NONPR_FIRST_PAYMENT_EOM). The
   * derived item is the rule's, never the caller's `item_result`.
   */
  item("lossmit.case.get", "read", "PR_PROHIBITIONS", (i, ctx, rt) => {
      const op = str(i, "op"); if (!op) return read("lossmit_applications")(i, ctx, rt);
      need(i, "loan_id"); const loanId = str(i, "loan_id"); const today = optDate(i, "today") ?? todayOf(ctx);
      const pr = typeof i.principal_residence === "boolean" ? i.principal_residence : rt.store.get("loans", loanId)?.data.principal_residence === true;
      if (op === "pr_prohibitions") return { op, ...prProhibitions({ today, principal_residence: pr, approved_arrangement: flag(i, "approved_arrangement"), complete_brp_received_on: optDate(i, "complete_brp_received_on"), evaluation_sent_on: optDate(i, "evaluation_sent_on"), offer_sent_on: optDate(i, "offer_sent_on"), offer_response_ends_on: optDate(i, "offer_response_ends_on"), offer_accepted_on: optDate(i, "offer_accepted_on"), ...(i.performing === undefined ? {} : { performing: flag(i, "performing") }), appeal_window_ends_on: optDate(i, "appeal_window_ends_on") }) };
      if (op === "e3204_ladder") return { op, ...nonPrBrpItem({ today, principal_residence: pr, earliest_unpaid_due: optDate(i, "earliest_unpaid_due") ?? dateOf(rt.store.get("loans", loanId)?.data.earliest_unpaid_due_date), complete_brp_received_on: optDate(i, "complete_brp_received_on"), inquiry_only: flag(i, "inquiry_only"), offer_sent_on: optDate(i, "offer_sent_on"), offer_accepted_on: optDate(i, "offer_accepted_on"), first_payment_due: optDate(i, "first_payment_due"), ...(i.first_payment_received === undefined ? {} : { first_payment_received: flag(i, "first_payment_received") }), breached: flag(i, "breached") }) };
      if (op === "record_plan_payment") { need(i, "plan_id", "due_on", "received_on", "amount_cents"); return { op, ...ingestWorkoutPlanPayment(deps134(ctx, rt), { loan_id: loanId, plan_id: str(i, "plan_id"), due_on: date(i, "due_on"), received_on: date(i, "received_on"), amount_cents: cents(i.amount_cents), ...(i.first === undefined ? {} : { first: flag(i, "first") }), first_payment_due: optDate(i, "first_payment_due") }) }; }
      throw new RangeError(`unknown op ${op} (pr_prohibitions | e3204_ladder | record_plan_payment)`); },
    [], (base) => { const b = base as { op?: string; items?: { item_code: string; result: "pass" | "fail" | "n_a"; reason: string }[]; failing?: string[]; item?: { item_code: string; result: "pass" | "fail" | "n_a"; reason: string } };
      if (b?.op === "pr_prohibitions" && b.items) { const bad = b.items.find((it) => it.result === "fail"); return bad ? { item_code: bad.item_code, result: "fail", evidence_ids: [], reason: bad.reason } : { item_code: "PR_PROHIBITIONS", result: b.items.every((it) => it.result === "n_a") ? "n_a" : "pass", evidence_ids: ["lossmit-case-state"], reason: b.items.map((it) => `${it.item_code}: ${it.reason}`).join("; ") }; }
      if (b?.op === "e3204_ladder" && b.item) return { item_code: b.item.item_code, result: b.item.result, evidence_ids: b.item.result === "pass" ? ["lossmit-case-state"] : [], reason: b.item.reason };
      return null; }),
  contactsSearch(),
  /** The 11.x notices; `op=start_review` opens the attempt (ops-13-4 startReview: window per rule 1, E-3.2-01 preconditions from the breach/solicitation notices, `prereferral.review.started`, `prereferral.review.due` inside the window). */
  { name: "notices.search", kind: "read", handler: compute((i, ctx, rt) => { if (str(i, "op") === "start_review") { need(i, "loan_id"); const loanId = str(i, "loan_id"); const s = startReview(deps134(ctx, rt), { loan_id: loanId, review_id: str(i, "review_id") || `prr-${loanId}`, case_id: openCase(rt, loanId)?.id ?? null, state: str(i, "state") || null, principal_residence: typeof i.principal_residence === "boolean" ? i.principal_residence : null, earliest_unpaid_due: optDate(i, "earliest_unpaid_due"), breach_letter_expires_on: optDate(i, "breach_letter_expires_on"), solicitation_respond_by: optDate(i, "solicitation_respond_by"), latest_dmdc_certificate_date: optDate(i, "latest_dmdc_certificate_date") }); return { review_id: s.review_id, started_at: s.started_at, window: s.window, in_window: s.in_window, preconditions: s.preconditions, items: s.items }; }
      return rt.store.list("notices").filter((r) => r.data.loan_id === str(i, "loan_id") && (!str(i, "template_code") || r.data.template_code === str(i, "template_code"))).map((r) => r.data); }) },
  item("inspection.get", "read", "OCCUPANCY", read("inspections")),
  /**
   * DMDC single-record lookup through the `dmdc` adapter. No adapter or an outage ⇒ review outcome `hold_scra` with a
   * `human_portal_task{kind=dmdc_batch}` — never a fabricated "not on active duty" and never a
   * `dmdc.verification.completed` (13.4 Integrations: "never refer without a current certificate"; edge cases: "never
   * refer on stale data"). X/Z results are unknown (13.8 edge cases): recorded as Z for the alternate-name retry.
   */
  item("dmdc.verify", "act", "SCRA_DMDC", async (i, ctx, rt) => { need(i, "loan_id"); const loanId = str(i, "loan_id"); const purpose = str(i, "purpose") || "prereferral";
      const hold = (reason: string) => { const esc = rt.escalations.open({ kind: "human_portal_task", loanId, payload: { kind: "dmdc_batch", purpose, reason } }, ctx.actor); ctx.events.append({ type: "prereferral.hold.opened", loanId, actor: ctx.actor, payload: { kind: "hold_scra", purpose, reason, escalation_id: esc.id } }); return { status: "unavailable", on_active_duty: "unknown", certificate_id: null, verified: false, outcome: "hold_scra", reason, escalation_id: esc.id }; };
      const dmdc = rt.ports.dmdc; if (!dmdc) return hold("DMDC adapter is not wired into this runtime — a current certificate is required before referral (13.4 Integrations)");
      need(i, "last_name"); const req: DmdcRequest = { requestId: `${loanId}-${ctx.now}`, lastName: str(i, "last_name"), firstName: str(i, "first_name"), ...(str(i, "dob") ? { dob: str(i, "dob") } : {}), ...(str(i, "ssn") ? { ssn: str(i, "ssn") } : {}), activeDutyStatusDate: str(i, "as_of") || ctx.now.slice(0, 10) };
      let r: DmdcResult; try { r = await dmdc.singleLookup(req); } catch (e) { if (e instanceof AdapterUnavailable) return hold(`DMDC outage: ${e.message} — postpone rather than proceed (13.8-T7)`); throw e; }
      const status = r.status === "active_duty" ? "Y" : r.status === "not_active" ? "N" : "Z";
      // 13.8 data model `scra_verifications` (0015): method, status_date, on_active_duty, service dates, certificate id, purpose.
      const rec = rt.store.put("scra_verifications", str(i, "id") || `scrav-${loanId}-${ctx.now}`, { loan_id: loanId, borrower_id: str(i, "borrower_id") || null, requested_at: ctx.now, method: "dmdc_single", status_date: req.activeDutyStatusDate, on_active_duty: status, left_active_duty_367: status === "N" && Boolean(r.serviceEnd), future_call_up: false, service_begin_on: r.serviceStart ?? null, service_end_on: r.serviceEnd ?? null, certificate_id: r.certificateId ?? null, certificate_document_id: null, error_code: status === "Z" ? r.status : null, purpose, operator_id: null }, ctx.actor, ctx.now);
      ctx.events.append({ type: "dmdc.verification.completed", loanId, actor: ctx.actor, payload: { verification_id: rec.id, purpose, status, on_active_duty: status, certificate_id: r.certificateId ?? null, status_date: req.activeDutyStatusDate, age_days: daysBetween(D(req.activeDutyStatusDate), todayOf(ctx)) } });
      // 13.4 timer table: SM_DMDC_VERIFY_PRE_REFERRAL_30 "satisfied by `scra.status.verified`" — a certificate (Y or N) verifies the status; Z verifies nothing.
      if (status !== "Z") ctx.events.append({ type: "scra.status.verified", loanId, actor: ctx.actor, payload: { verification_id: rec.id, purpose, on_active_duty: status, certificate_id: r.certificateId ?? null, status_date: req.activeDutyStatusDate, latest_dmdc_certificate_date: req.activeDutyStatusDate, age_days: daysBetween(D(req.activeDutyStatusDate), todayOf(ctx)) } });
      return { ...rec.data, id: rec.id, status, verified: status !== "Z", outcome: status === "Y" ? "hold_scra" : status === "Z" ? "retry_alternates" : "pass" }; },
    // 13.4-T5: the DMDC result governs the SCRA_DMDC item — Y ⇒ fail (hold_scra), N ⇒ pass on the certificate, Z/outage ⇒ fail (never refer on stale data).
    [], (base) => { const b = base as { status: string; certificate_id: string | null; id?: string; reason?: string }; return b.status === "Y" ? { result: "fail", evidence_ids: [b.certificate_id ?? ""].filter(Boolean), reason: "DMDC: on active duty (D2-3.4-01 hold_scra)" } : b.status === "N" ? { result: "pass", evidence_ids: [b.certificate_id ?? ""].filter(Boolean), reason: "DMDC: not on active duty" } : { result: "fail", evidence_ids: [], reason: b.status === "Z" ? "DMDC: Z (no match) — retry with alternates (13.8 edge cases)" : b.reason ?? "DMDC unavailable — never refer on stale data (13.4 edge cases)" }; }),
  /**
   * Bankruptcy scrub through the `pacer` adapter by name + SSN4 (14.1 matching); the result is stored. No adapter or an
   * outage ⇒ hold — never the caller's own `pacer_hit`. A hit (13.4-T10 "hold_bankruptcy and 14.x case opened") opens the
   * `bk_stay` hold (13.2 vocabulary; closes BK_362_STAY_GATE on every step now) and hands the petition to 14.x as
   * `bankruptcy.petition.filed{source=pacer_scrub}` (13.1 Inputs; FNMA_E3104_BK_NOTIFY_FIRM_1BD on a referred loan).
   */
  item("bk.scrub", "act", "BK_SCRUB", async (i, ctx, rt) => { need(i, "loan_id", "last_name"); if (!str(i, "ssn4") && !str(i, "ssn")) throw new RangeError("ssn4 or ssn is required with last_name — PCL rejects SSN-only queries"); const loanId = str(i, "loan_id");
      const borrower = { lastName: str(i, "last_name"), ssn4: str(i, "ssn4") || str(i, "ssn").slice(-4) };
      const hold = (reason: string) => { ctx.events.append({ type: "prereferral.hold.opened", loanId, actor: ctx.actor, payload: { kind: "hold_bankruptcy", reason } }); return { scrubbed: false, outcome: "hold_bankruptcy", reason, hits: [], open_bk_case: null }; };
      const pacer = rt.ports.pacer; if (!pacer) return hold("PACER/bk-monitor adapter is not wired into this runtime — never refer on stale data (13.4 edge cases)");
      let parties: readonly PacerParty[]; try { const { reportId } = await pacer.partiesFind({ lastName: borrower.lastName, ssn4: borrower.ssn4, dateFiledFrom: str(i, "date_filed_from") || "2000-01-01" }); if ((await pacer.reportStatus(reportId)) !== "complete") return hold(`PACER report ${reportId} did not complete`); parties = await pacer.reportDownload(reportId); } catch (e) { if (e instanceof AdapterUnavailable) return hold(`PACER outage: ${e.message}`); throw e; }
      const hits = parties.filter((p) => pacerMatchAccepted(p, borrower) && p.status === "open");
      const scrub = bankruptcyScrubItem({ pacer_hit: hits.length > 0, case_number: hits[0]?.caseNumber ?? null });
      const rec = rt.store.put("bk_scrubs", str(i, "id") || `bks-${loanId}-${ctx.now}`, { loan_id: loanId, scrubbed_on: ctx.now.slice(0, 10), hits: hits.map((h) => ({ case_number: h.caseNumber, court: h.court, chapter: h.chapter, date_filed: h.dateFiled, status: h.status })), ...scrub }, ctx.actor, ctx.now);
      ctx.events.append({ type: "bk.scrub.completed", loanId, actor: ctx.actor, payload: { scrub_id: rec.id, outcome: scrub.outcome, hits: hits.length } });
      let holdId: string | null = null;
      if (scrub.open_bk_case) { const h = hits[0]!; const hrow = rt.store.put("foreclosure_holds", `hold-${loanId}-bk_stay`, { loan_id: loanId, kind: "bk_stay", status: "active", scope: [...STEPS], from: ctx.now.slice(0, 10), rule_citation: "11 U.S.C. §362(a)", reason: `PACER scrub hit: ${h.caseNumber} (${h.court}, chapter ${h.chapter}, filed ${h.dateFiled})`, source_scrub_id: rec.id, case_number: h.caseNumber }, ctx.actor, ctx.now); holdId = hrow.id;
        ctx.events.append({ type: "foreclosure.hold.opened", loanId, actor: ctx.actor, payload: { hold_id: hrow.id, kind: "bk_stay", scope: [...STEPS], case_number: h.caseNumber, scrub_id: rec.id } });
        ctx.events.append({ type: "bankruptcy.petition.filed", loanId, actor: ctx.actor, payload: { case_number: h.caseNumber, court: h.court, chapter: h.chapter, date_filed: h.dateFiled, source: "pacer_scrub", scrub_id: rec.id, hold_id: hrow.id } }); }
      return { scrubbed: true, ...rec.data, id: rec.id, hold_id: holdId }; },
    // 13.4-T10: the scrub result governs the BK_SCRUB item — a hit fails it (hold_bankruptcy); a clean scrub passes on the scrub receipt.
    [], (base) => { const b = base as { scrubbed: boolean; outcome: string; id?: string; reason?: string }; return !b.scrubbed ? { result: "fail", evidence_ids: [], reason: b.reason ?? "PACER unavailable — never refer on stale data" } : b.outcome === "hold_bankruptcy" ? { result: "fail", evidence_ids: [b.id ?? ""].filter(Boolean), reason: "PACER scrub hit — 14.x" } : { result: "pass", evidence_ids: [b.id ?? ""].filter(Boolean), reason: "PACER scrub clear" }; }),
  /** Title status; `op=record_mortgagee_of_record` records the E-1.1-02 finding (ops-13-4 recordMortgageeOfRecord → `foreclosure.prep.mortgagee_of_record.identified`, FNMA_E1102_MORTGAGEE_OF_RECORD_ID_90) as the `TITLE_MORTGAGEE_OF_RECORD` item on the title report's evidence. */
  item("title.status.get", "read", "TITLE", (i, ctx, rt) => (str(i, "op") === "record_mortgagee_of_record" ? (need(i, "loan_id", "mortgagee_of_record", "identified_on", "evidence_document_id"), { op: "record_mortgagee_of_record", ...recordMortgageeOfRecord(deps134(ctx, rt), { loan_id: str(i, "loan_id"), title_order_id: str(i, "title_order_id") || str(i, "id") || null, mortgagee_of_record: str(i, "mortgagee_of_record"), identified_on: date(i, "identified_on"), evidence_document_id: str(i, "evidence_document_id"), ...(i.assignment_needed === undefined ? {} : { assignment_needed: flag(i, "assignment_needed") }) }) }) : read("title_orders")(i, ctx, rt)),
    [], (base) => { const b = base as { op?: string; row?: Row; title_order_id?: string }; return b?.op === "record_mortgagee_of_record" && b.row ? { item_code: "TITLE_MORTGAGEE_OF_RECORD", result: "pass", evidence_ids: [String(b.row.mortgagee_of_record_document_id)], reason: `mortgagee of record ${String(b.row.mortgagee_of_record)} identified ${String(b.row.mortgagee_of_record_identified_on)} (E-1.1-02)` } : null; }),
  { name: "custodian.request", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "documents"); return ctx.events.append({ type: "custodian.document.requested", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { documents: i.documents } }); }) },
  item("mi.status.get", "read", "MI_NOD", read("mi_policies")),
  item("insurance.status.get", "read", "INSURANCE", read("insurance_policies")),
  /**
   * Disaster overlay (rule 4: FEMA IA declaration for the county ∧ damage evidence ⇒ impacted ⇒ `hold_disaster_approval`;
   * the DISASTER item is derived from the lookup, never the caller's `item_result`). `op=submit_request` sends the
   * D1-3-01 prior-approval request to hazard_loss@ (ops-13-4 submitDisasterFcRequest: all five content elements or
   * refused; `disaster_fc_approval_requests.submitted` ends FNMA_D1301_DISASTER_FC_REQUEST_5 and arms the 10-BD
   * follow-up); `op=record_response` records Fannie Mae's reply (`fnma.disaster_fc.responded{response}`; approval opens
   * the 13.1 gate and releases the hold; a denial the partner wishes to contest goes to the officer).
   */
  item("disaster.lookup", "read", "DISASTER", (i, ctx, rt) => {
      const op = str(i, "op");
      if (op === "submit_request") { need(i, "loan_id", "request"); const loanId = str(i, "loan_id"); const kind = (str(i, "kind") || (openCase(rt, loanId)?.referred_on ? "continue" : "initiate")) as "initiate" | "continue"; const r = submitDisasterFcRequest(deps134(ctx, rt), { loan_id: loanId, request_id: str(i, "request_id") || null, case_id: openCase(rt, loanId)?.id ?? null, review_id: str(i, "review_id") || `prr-${loanId}`, kind, request: i.request as DisasterRequest, message_id: str(i, "message_id") || null }); return { op, request_id: r.request_id, due_by: r.due_by, ...r.row, channel: "email:hazard_loss" }; }
      if (op === "record_response") { need(i, "loan_id", "request_id", "response"); const r = recordDisasterFcResponse(deps134(ctx, rt), { loan_id: str(i, "loan_id"), request_id: str(i, "request_id"), response: str(i, "response") as FnmaDisasterResponse, response_document_id: str(i, "response_document_id") || null, responded_at: str(i, "responded_at") || null, note: str(i, "note") || null }); const esc = r.escalate ? rt.escalations.open({ kind: "officer", loanId: str(i, "loan_id"), payload: { request_id: str(i, "request_id"), response: "denied", reason: "Fannie Mae denied the disaster foreclosure request — contest, re-request when repairs/claims progress, or forbearance/deferral per 12.x (13.4 escalations)" } }, ctx.actor) : null; return { op, ...r.row, approval_id: r.approval_id, hold_released: r.hold_released, escalation_id: esc?.id ?? null }; }
      need(i, "county_fips"); const rows = rt.store.list("disaster_registry").filter((r) => r.data.county_fips === str(i, "county_fips") && r.data.fema_ia === true);
      const approved = str(i, "fnma_approval_id") || (str(i, "loan_id") ? loanRows(rt, "disaster_fc_approval_requests", str(i, "loan_id")).map((r) => r.data).filter((r) => r.fnma_response === "approved").at(-1)?.fnma_approval_id as string | undefined : undefined) || null;
      const hold = disasterHold({ fema_ia: rows.length > 0, inspection_damage: flag(i, "inspection_damage") || flag(i, "borrower_report") || flag(i, "insurance_claim") || flag(i, "forbearance_reason_disaster"), review_completed_on: optDate(i, "review_completed_on") ?? todayOf(ctx), request: (i.request as Row | undefined) ?? null, fnma_approval_id: approved });
      const lookup = str(i, "loan_id") ? rt.store.put("disaster_lookups", `dlk-${str(i, "loan_id")}-${ctx.now}`, { loan_id: str(i, "loan_id"), county_fips: str(i, "county_fips"), fema_ia: rows.length > 0, disaster_event_ids: rows.map((r) => r.id), damage_evidence: flag(i, "inspection_damage") || flag(i, "borrower_report") || flag(i, "insurance_claim") || flag(i, "forbearance_reason_disaster"), impacted: hold.gate === "closed" || Boolean(approved), fnma_approval_id: approved, looked_up_on: ctx.now.slice(0, 10) }, ctx.actor, ctx.now) : null;
      return { fema_ia: rows.length > 0, events: rows.map((r) => r.data), hold, lookup_id: lookup?.id ?? null, fnma_approval_id: approved }; },
    [never("NO_FC_RECOMMENDATION_WITHOUT_OUTREACH", "13.4 guardrail: never send a disaster request recommending foreclosure where QRPC was never achieved unless the D2-2-02 cadence was met", (i) => { const r = request(i); const rec = String(r.recommendation ?? i.recommendation ?? ""); const contact = (r.borrower_engagement as Row | undefined) ?? (r.borrower_contact_and_hardship_status as Row | undefined) ?? {}; const qrpc = contact.qrpc_achieved === true || flag(i, "qrpc_achieved"); const cadence = contact.d2202_cadence_met === true || flag(i, "d2202_cadence_met"); return /foreclos/i.test(rec) && !qrpc && !cadence; }, "Fannie Mae will ask for the outreach log")],
    // Rule 4 / 13.4-T4: the DISASTER item follows the overlay — impacted without Fannie Mae's approval fails it (hold_disaster_approval); a declared county without damage evidence or an approved request passes on the lookup record.
    (base) => { const b = base as { op?: string; hold?: { outcome: string; gate: string }; lookup_id?: string | null; fema_ia?: boolean; fnma_approval_id?: string | null }; if (b?.op || !b?.hold) return null; return b.hold.gate === "closed" ? { result: "fail", evidence_ids: [b.lookup_id ?? ""].filter(Boolean), reason: "disaster-impacted (FEMA IA declaration + damage evidence) — Fannie Mae prior written approval required (D1-3-01)" } : { result: "pass", evidence_ids: [b.lookup_id ?? ""].filter(Boolean), reason: b.fnma_approval_id ? `Fannie Mae approval ${b.fnma_approval_id} on file (D1-3-01)` : b.fema_ia ? "declared county — no damage evidence (rule 4)" : "no FEMA IA declaration for the property's county" }; }),
]);

// ---- 13.5 timeframes -------------------------------------------------------------------
const p135 = defineTools("13.5", AGENT, [
  { name: "fc.timeframe.get", kind: "read", handler: compute((i, ctx, rt) => { need(i, "loan_id"); const loanId = str(i, "loan_id");
      // Exposure inputs are the tracker's rows: fc_timeframe_tracking (state, county, LPI, UPB, PTR, sale), fc_delay_credits (the delay-credit events with their 5.4 acknowledgments) and the exhibit in code. The caller may supply the loan facts only when no tracking row exists (a projection); it can never supply credits or allowable days.
      const tracking = rt.store.list("fc_timeframe_tracking").find((r) => r.data.loan_id === loanId || r.data.case_id === str(i, "case_id"))?.data ?? null;
      const loan = rt.store.get("loans", loanId)?.data ?? null;
      const pick = (k: string): unknown => tracking?.[k] ?? loan?.[k] ?? i[k];
      const state = String(pick("state") ?? ""); if (!state) throw new RangeError("state is required (fc_timeframe_tracking.state)");
      const county = pick("county") === undefined || pick("county") === null ? null : String(pick("county"));
      const lpi = pick("lpi_due_date") ?? pick("lpi_due"); if (!lpi) throw new RangeError("lpi_due_date is required (fc_timeframe_tracking.lpi_due_date)");
      const saleRaw = pick("sale_held_at") ?? pick("sale_on"); const saleOn = saleRaw ? D(String(saleRaw).slice(0, 10)) : null;
      const a = allowable(state, county, saleOn, loadedExhibits(rt.store));   // 13.5-T4: the exhibit version in force on the sale date, over the built-in 06.18.25 exhibit plus every retained version in jurisdiction_rules
      const caseId = String(tracking?.case_id ?? i.case_id ?? "");
      const delays: Delay[] = rt.store.list("fc_delay_credits").filter((r) => (caseId && r.data.case_id === caseId) || r.data.loan_id === loanId).map((r) => { const d = r.data; if (!isDelayCategory(d.category)) throw new RangeError(`fc_delay_credits ${r.id}: ${String(d.category)} is not a comp_fee_delay_rules category`); return { id: r.id, category: d.category, from: D(String(d.begin_on)), to: D(String(d.end_on ?? ctx.now.slice(0, 10))), reported_timely: d.reported_timely === true, ...(typeof d.status_code_reported === "string" ? { status_code_reported: d.status_code_reported } : {}) }; });
      const base = { lpi_due: D(String(lpi)), allowable: a.days, delays, upb_cents: cents(pick("upb_cents")), ptr_pct: String(pick("ptr_pct") ?? pick("ptr") ?? "0") };
      const e = saleOn ? exposure({ ...base, sale_on: saleOn }) : projectedExposure({ ...base, as_of: optDate(i, "as_of") ?? D(ctx.now.slice(0, 10)) });
      return { loan_id: loanId, case_id: caseId || null, state, nyc: a.nyc, method_preferred: a.method, exhibit_version: a.exhibit_version, source: tracking ? "fc_timeframe_tracking" : loan ? "loans" : "projection_inputs", ...e }; }),
    guardrails: [never("NO_MODEL_CREDITS", "13.5 guardrail: exposure math is code; the model cannot add credits — delay credits are the tracker's fc_delay_credits rows and the allowable days are the exhibit's", (i) => has(i, "extra_credit_days", "delays", "credits", "credited_days", "allowable", "allowable_override", "allowable_days", "excess_days"), "credits come from reported status codes only; allowable days from the exhibit")] },
  { name: "status.history.get", kind: "read", handler: read("delinquency_status_history") },
  draSnapshotGet(),
  attorneyInstructionSend(),
  /** A rebuttal bundle is drafted by the agent; `submit: true` is the officer's signature — it records the signer, emits the submission and resolves the bill's rebuttal clock (`comp_fee_bill.resolved{result=rebutted}` satisfies SM_COMP_FEE_BILL_REBUTTAL_30). */
  { name: "documents.bundle", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "document_ids"); const loanId = str(i, "loan_id"); const purpose = str(i, "purpose") || "comp_fee_rebuttal"; const submit = flag(i, "submit");
      const rec = rt.store.put("document_bundles", str(i, "id") || `bundle-${loanId}-${ctx.now}`, { loan_id: loanId, document_ids: i.document_ids, purpose, status: submit ? "submitted" : "drafted", ...(submit ? { submitted_at: ctx.now, signed_by: `${ctx.actor.kind}:${ctx.actor.id}`, signer_role: ctx.actor.role ?? null, bill_id: str(i, "bill_id") || null } : {}) }, ctx.actor, ctx.now);
      if (submit) { ctx.events.append({ type: "document_bundle.submitted", loanId, actor: ctx.actor, payload: { bundle_id: rec.id, purpose, bill_id: str(i, "bill_id") || null } }); if (purpose === "comp_fee_rebuttal") ctx.events.append({ type: "comp_fee_bill.resolved", loanId, actor: ctx.actor, payload: { result: "rebutted", bundle_id: rec.id, bill_id: str(i, "bill_id") || null } }); }
      return rec.data; }),
    guardrails: [needsRole("OFFICER_SIGNS_REBUTTAL", "13.5 guardrail: rebuttals are officer-signed", (i) => (str(i, "purpose") || "comp_fee_rebuttal") === "comp_fee_rebuttal" && flag(i, "submit"), ["officer"], "the officer certifies Fannie Mae performance-management correspondence")] },
  { name: "fnma_connect.report.pull", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "report"); const p = rt.ports.connect as unknown as { pull?: (r: string) => Promise<unknown> } | undefined; if (!p?.pull) return rt.escalations.open({ kind: "human_portal_task", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { report: str(i, "report"), reason: "Fannie Mae Connect pull is portal-only" } }, ctx.actor);
      const pulled = await p.pull(str(i, "report"));
      // 13.5 Integrations: a pulled compensatory-fee bill file is ingested into comp_fee_bills — each row validated, `comp_fee_bill.received` appended (SM_COMP_FEE_BILL_REBUTTAL_30), the rebuttal package drafted and the officer escalated (ops-13-5.ts).
      if (str(i, "report") === "comp_fee_bills" && Array.isArray(pulled)) return new TimeframeTracker({ events: ctx.events, store: rt.store, escalations: rt.escalations, clock: { now: () => ctx.now }, actor: ctx.actor }).ingestCompFeeBills(pulled);
      return pulled; }) },
]);

// ---- 13.6 law-firm management -------------------------------------------------------------
const NO_COURT_RELIEF_MESSAGE = never("NO_COURT_RELIEF_REQUEST", "13.9 guardrail / D2-3.4-01: no court-relief request (petition to proceed against a servicemember) is ever prepared", (i) => flag(i, "court_relief_request") || COURT_RELIEF.test(str(i, "subject")) || COURT_RELIEF.test(str(i, "kind")), "Fannie Mae prohibits seeking consent or petitioning to proceed; route SCRA stays to the attorney");
const p136 = defineTools("13.6", AGENT, [
  { name: "firm.get", kind: "read", handler: read("attorney_firms") },
  { name: "documents.extract", kind: "read", handler: compute((i, ctx, rt) => { need(i, "document_id"); const ai = rt.services.documentAi as { extract?: (id: string, kind: string) => Promise<unknown> } | undefined; if (!ai?.extract) return rt.escalations.open({ kind: "human_portal_task", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { document_id: str(i, "document_id"), kind: str(i, "kind") || "invoice", reason: "document AI unavailable" } }, ctx.actor); return ai.extract(str(i, "document_id"), str(i, "kind") || "invoice"); }) },
  { name: "fee_schedule.get", kind: "read", handler: read("attorney_fee_schedules") },
  // The E-5-05 rules engine and the invoice lifecycle (`op` review/received/pay — firm.invoice.received/reviewed/approved/paid for
  // SM_INVOICE_REVIEW_10BD and SM_INVOICE_PAY_30) live in ./section13-6.ts over src/domain/foreclosure/ops-13-6.ts.
  { name: "invoice.review", kind: "write", moneyFields: ["allowable_cents", "previously_paid_cents"], handler: invoiceReviewHandler136,
    guardrails: [never("NO_MODEL_FEE_BASIS", "13.6 rule 3: each fee line must match the matter's state/method schedule — the allowable fee and amounts paid are read from attorney_fee_schedules/attorney_invoices, never taken from the caller (officer overrides go through `changes`)", (i) => has(i, "allowable_cents", "previously_paid_cents", "fee_earned_cents", "fee_approved_cents"), "omit the fee basis; the schedule and paid history decide it"),
      never("NO_APPROVE_REJECTED_LINE", "13.6 guardrail: the model cannot approve an invoice line the rules reject", (i) => (Array.isArray(i.override_approve) && (i.override_approve as unknown[]).length > 0) || flag(i, "approve_rejected") || flag(i, "approve_all"), "rejected lines stay rejected; excess fees route to SF CPM")] },
  { name: "dra.snapshot.import", kind: "act", handler: draSnapshotImportHandler136 },   // rows validated into dra_snapshots/dra_events, then rule-6 reconciliation (dra.event.matched / dra.exception.raised) — ./section13-6.ts
  { name: "attorney.message.send", kind: "act", handler: compute((i, ctx, rt) => { if (str(i, "op").startsWith("fc.")) return foreclosureAct_13_3(i, ctx, rt); return attorneyMessageHandler136(i, ctx, rt); }),   // 13.6 firm/matter lifecycle ops by `kind` (default `message`) — ./section13-6.ts
    guardrails: [...ATTORNEY_MESSAGE_GUARDRAILS_13_6, needsRole("OFFICER_DECIDES_SUSPENSION", "13.6 guardrail: suspension/termination decisions are officer decisions", (i) => /suspend|terminat/i.test(str(i, "subject")), ["officer"], "the AI prepares the package; the officer decides"),
      needsRole("FORM200_OFFICER_CERTIFIES", "13.6 guardrail: Form 200 certification is the partner officer's (legally the servicer's certification to Fannie Mae)", (i) => flag(i, "form200_certification") || (/form\s?200/i.test(str(i, "subject")) && /certif|sign|submit/i.test(str(i, "subject"))), ["officer"], "the agent prepares the due-diligence file and the form; the officer certifies"),
      never("NO_LEGAL_STRATEGY", "13.6 guardrail: litigation instructions are the attorney's domain", (i) => flag(i, "legal_strategy"), "route to the attorney"),
      NO_COURT_RELIEF_MESSAGE] },
]);

// ---- 13.7 litigation --------------------------------------------------------------------------
const p137 = defineTools("13.7", AGENT, [
  { name: "documents.extract", kind: "read", handler: compute((i, ctx, rt) => { need(i, "document_id"); const ai = rt.services.documentAi as { extract?: (id: string, kind: string) => Promise<unknown> } | undefined; if (!ai?.extract) return rt.escalations.open({ kind: "attorney", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { document_id: str(i, "document_id"), reason: "pleading extraction unavailable — attorney review" } }, ctx.actor); return ai.extract(str(i, "document_id"), "pleading"); }) },
  /**
   * The litigation/environmental lifecycle runs as ops on `litigation.classify` (classify → confirm → trigger →
   * form20_submitted / form20_portal_filed / form20_responded → status_update; hazard_suspected → hazard_confirmed →
   * servicing_rep_report / lead_paint_notification → hazard_direction / hazard_cleared; ma_citation_search) and
   * `attorney.message.send` (pleading_due → draft_to_fnma → review_closed → file_pleading; removal_or_appeal_proposed
   * → approval_granted → file_removal_or_appeal; workout_notice → counsel_ack → workout_offer_release) — the handlers
   * and role guardrails live in ./section13-7.ts; every event a 13.7 timer arms or is satisfied by is built by
   * src/domain/foreclosure/ops-13-7.ts and appended there.
   */
  { name: "litigation.classify", kind: "act", handler: litigationClassifyHandler,
    guardrails: [...LITIGATION_CLASSIFY_GUARDRAILS_13_7, never("NEVER_STATE_FNMA_POSITION", "13.7 guardrail: the agent never states Fannie Mae's position", (i) => typeof i.fnma_position === "string", "positions come from the officer/Fannie Mae"),
      never("ENV_CLEARED_NEEDS_HUMAN_EVIDENCE", "13.7 guardrail: environmental 'cleared' requires human-reviewed evidence", (i) => str(i, "environmental_status") === "cleared" && !str(i, "reviewer_evidence_document_id"), "attorney or licensed inspector report")] },
  { name: "foreclosure.case.get", kind: "read", handler: read("foreclosure_cases") },
  { name: "attorney.message.send", kind: "act", handler: attorneyMessageHandler137,
    guardrails: [...ATTORNEY_MESSAGE_GUARDRAILS_13_7, never("NEVER_FILES_PLEADINGS", "13.7 guardrail: the agent never files pleadings or communicates positions to courts/opposing counsel", (i) => /^(file_pleading|court|opposing_counsel)$/.test(str(i, "recipient_kind")), "attorney only"), NO_COURT_RELIEF_MESSAGE] },
]);

// ---- 13.8 SCRA foreclosure protection -----------------------------------------------------------
/** D2-3.4-01 "waive late charges after the call to active duty": the 2.7 `fees` rows of type late_charge assessed on/after `service_begin_on` and still outstanding — the amount is the ledger's, never the caller's (13.9 guardrail: money math is code). */
const lateChargesSinceService = (rt: Rt, loanId: string, since: PlainDate): { cents: bigint; fee_ids: string[] } => {
  const rows = loanRows(rt, "fees", loanId).filter((r) => r.data.fee_type === "late_charge" && String(r.data.assessed_on ?? "") >= since && ["assessed", "accrued_suspended", "partially_collected", undefined].includes(r.data.state as string | undefined));
  const outstanding = (d: Row): bigint => { const o = cents(d.amount_cents) - cents(d.collected_cents) - cents(d.waived_cents); return o > 0n ? o : 0n; };
  return { cents: rows.reduce((s, r) => s + outstanding(r.data), 0n), fee_ids: rows.map((r) => r.id) };
};
const SCRA_MONEY_FIELDS = ["late_charges_since_service_cents", "late_charges_waived_cents"] as const;
const p138 = defineTools("13.8", AGENT, [
  /** The day's batch: listed loans plus every inbound firm/eviction record's loan, each record's milestone event appended first (./section13-8.ts). */
  { name: "dmdc.batch.prepare", kind: "act", handler: compute(dmdcBatchPrepare_13_8) },
  /** Batch results parsed into `scra_verifications` (13.8 data model; one append-only row per borrower result, method dmdc_batch) with `dmdc.verification.completed{purpose}` — `purpose=boarding` satisfies SM_DMDC_VERIFY_BOARDING_0. */
  { name: "dmdc.results.import", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "results"); const loanId = str(i, "loan_id"); const purpose = str(i, "purpose") || "boarding"; const results = i.results as Parameters<typeof boardingDmdc>[0]["results"]; const r = boardingDmdc({ boarded_on: optDate(i, "boarded_on") ?? D(ctx.now.slice(0, 10)), results });
      const ids = results.map((x, n) => rt.store.put("scra_verifications", `${str(i, "id") || `scrav-${loanId}-${ctx.now}`}-${n + 1}`, { loan_id: loanId, borrower_id: x.borrower_id, requested_at: ctx.now, method: "dmdc_batch", status_date: x.as_of, on_active_duty: x.status, left_active_duty_367: (x as Row).left_active_duty_367 === true, future_call_up: (x as Row).future_call_up === true, service_begin_on: dateOf((x as Row).service_begin_on), service_end_on: dateOf((x as Row).service_end_on), certificate_id: x.certificate_id, certificate_document_id: null, error_code: x.certificate_id ? null : "missing_certificate", purpose, operator_id: str(i, "operator_id") || null, batch_id: str(i, "batch_id") || null }, ctx.actor, ctx.now).id);
      const status = results.some((p) => p.status === "Y") ? "Y" : results.some((p) => p.status === "Z") ? "Z" : "N";
      ctx.events.append({ type: "dmdc.verification.completed", loanId, actor: ctx.actor, payload: { verification_ids: ids, purpose, status, on_active_duty: status, certificate_ids: r.parsed.map((p) => p.certificate_id), age_days: 0 } });
      // 13.8 Outputs `scra.status.verified{purpose, result}` with the §3931(g) post-judgment flag (./section13-8.ts)
      const verified = scraStatusVerified_13_8(ctx, rt, loanId, purpose, results.map((x) => ({ status: x.status, service_begin_on: dateOf((x as Row).service_begin_on), service_end_on: dateOf((x as Row).service_end_on), future_call_up: (x as Row).future_call_up === true })), dateOf(results[0]?.as_of) ?? todayOf(ctx), ids);
      return { ...r, verification_ids: ids, status, purpose, post_judgment_on_duty: verified.post_judgment_on_duty, service_end_date: verified.service_end_date, reopen_application_deadline: verified.reopen_application_deadline, escalation_id: verified.escalation_id }; }) },
  /**
   * `get` runs the tail sweep (the engine closes the case the day after `protection_ends_on`); `open` writes the
   * D2-3.4-01 consequences — the firm's SCRA_STAY instruction (attorney_instructions + `attorney.instruction.sent`),
   * status code 32 queued for 5.x, the late-charge waiver computed from the 2.7 `fees` rows and posted (Dr
   * late_charge_income / Cr late_charges) — and the quarterly contact/re-verification timers; `close` ends the period
   * only on evidence; `gate_exception` is the attorney's record of a court order at Fannie Mae's direction or a
   * reviewed §3918 agreement — written as the gate's evaluation row (`foreclosure_gate_evaluations`, result open,
   * reason_code = basis) with `foreclosure.gate.opened`, which opens the gate without ending the service period;
   * `affidavit` is the signing officer's execution after the recorded records review. Case rows carry the 0015
   * `scra_cases` columns: `case_id`, `basis`, `service_begin_on`, `service_end_on`, `pre_service_obligation`,
   * `protection_ends_on`, `fc_stay_granted_at`, `contact_cadence_next_on`, `status`.
   */
  { name: "scra.case.get/open/close", kind: "write", moneyFields: [...SCRA_MONEY_FIELDS], handler: compute((i, ctx, rt) => { need(i, "loan_id"); const loanId = str(i, "loan_id"); const op = str(i, "op") || "get"; const id = str(i, "id") || `scra-${loanId}`;
      if (op === "get") { const cur = rt.store.get("scra_cases", id)?.data.status === "closed" ? rt.store.get("scra_cases", id)!.data : scraCaseFor(rt, ctx, loanId) ?? rt.store.get("scra_cases", id)?.data ?? null; scraReliefSweep_13_8(ctx, rt, loanId); return cur; }
      if (op === "open") { const loan = rt.store.get("loans", loanId)?.data ?? {}; const latest = latestDmdc(rt, loanId); const dmdcStatus = (str(i, "dmdc_status") || String(latest?.on_active_duty ?? "N")) as "Y" | "N" | "Z";
        const origination = optDate(i, "origination_on") ?? dateOf(loan.origination_date) ?? dateOf(loan.note_date); if (!origination) throw new RangeError("origination_on is required (loans.origination_date) — §3953 applies to obligations that originated before service");
        const serviceBegin = date(i, "service_begin_on"); const waiver = lateChargesSinceService(rt, loanId, serviceBegin);
        const r = openScraCase({ dmdc_status: dmdcStatus, origination_on: origination, service_begin_on: serviceBegin, verified_on: optDate(i, "verified_on") ?? dateOf(latest?.status_date) ?? todayOf(ctx), late_charges_since_service_cents: waiver.cents });
        if (!r.opened) { if (flag(i, "written_assertion")) { const a = assertedServiceWithoutEvidence({ written_assertion: true, dmdc_status: dmdcStatus, orders_document_id: (i.orders_document_id as string | undefined) ?? null }); if (a.request_orders) ctx.events.append({ type: "scra.orders.requested", loanId, actor: ctx.actor, payload: { reason: r.refusal } }); const esc = a.escalation ? rt.escalations.open({ kind: "attorney", loanId, payload: { reason: a.escalation.reason } }, ctx.actor) : null; return { opened: false, refusal: r.refusal, denial_allowed: a.denial_allowed, request_orders: a.request_orders, escalation_id: esc?.id ?? null }; } throw new RangeError(r.refusal!); }
        const basis = str(i, "basis") || (i.orders_document_id ? "orders" : "dmdc");
        const rec = rt.store.put("scra_cases", id, { case_id: id, loan_id: loanId, servicemember_party_id: str(i, "party_id") || null, basis, service_begin_on: str(i, "service_begin_on"), service_end_on: null, pre_service_obligation: preServiceObligation(origination, serviceBegin), protection_ends_on: null, fc_stay_granted_at: ctx.now, rate_cap_case_id: str(i, "rate_cap_case_id") || null, contact_cadence_next_on: r.next_contact_on, status: "open_active_duty" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "scra.case.opened", loanId, actor: ctx.actor, payload: { case_id: rec.id, timers: r.timers, status_code: r.status_code, gate: r.gate, basis, verification_id: latest?.id ?? null } });
        ctx.events.append({ type: "scra.period.started", loanId, actor: ctx.actor, payload: { case_id: rec.id, service_begin_on: str(i, "service_begin_on"), pre_service_obligation: true } });
        ctx.events.append({ type: "scra.stay.granted", loanId, actor: ctx.actor, payload: { case_id: rec.id, granted_at: ctx.now } });
        scraReliefStarted_13_8(ctx, loanId, rec.id, r.status_code!);
        const fi = r.firm_instruction!; const instruction = rt.store.put("attorney_instructions", `ai-${loanId}-${fi.kind}-${ctx.now}`, { loan_id: loanId, kind: fi.kind, firm_id: str(i, "firm_id") || null, sent_at: ctx.now, due: fi.due, status: "sent", ack_due_business_days: 1, scra_case_id: rec.id }, ctx.actor, ctx.now);
        ctx.events.append({ type: "attorney.instruction.sent", loanId, actor: ctx.actor, payload: { instruction_id: instruction.id, kind: fi.kind, due: fi.due } });
        ctx.events.append({ type: "delinquency.status_code.queued", loanId, actor: ctx.actor, payload: { code: r.status_code, reason: "military_indulgence", scra_case_id: rec.id } });
        let ledgerSetId: string | null = null;
        if (r.late_charges_waived_cents > 0n) { const w = r.late_charges_waived_cents; const set = ctx.ledger.post({ effectiveDate: todayOf(ctx), description: `SCRA late-charge waiver since service began ${str(i, "service_begin_on")} (D2-3.4-01): fees ${waiver.fee_ids.join(", ")}`, lines: [{ account: { scope: "corporate", account: "late_charge_income" }, amountCents: w, ruleRef: "13.8.D2-3.4-01.late_charge_waiver" }, { account: { scope: "loan", loanId, account: "late_charges" }, amountCents: -w, ruleRef: "13.8.D2-3.4-01.late_charge_waiver" }] }, ctx.now); ledgerSetId = set.id; ctx.events.append({ type: "late_charges.waived", loanId, actor: ctx.actor, payload: { cents: w, fee_ids: waiver.fee_ids, reason: "scra_service", ledger_set_id: set.id } }); }
        return { ...rec.data, ...r, late_charge_fee_ids: waiver.fee_ids, firm_instruction: { ...fi, instruction_id: instruction.id }, ledger_set_id: ledgerSetId }; }
      if (op === "close") { const r = scraCaseClose({ service_end_on: date(i, "service_end_on"), evidence: { orders_document_id: (i.orders_document_id as string | undefined) ?? null, dmdc_certificate_id: (i.dmdc_certificate_id as string | undefined) ?? null, borrower_confirmation_contact_id: (i.borrower_confirmation_contact_id as string | undefined) ?? null } }); if (!r.allowed) throw new RangeError(r.refusal!); const rec = rt.store.put("scra_cases", id, { case_id: id, loan_id: loanId, status: r.status, service_end_on: str(i, "service_end_on"), protection_ends_on: r.protection_ends_on }, ctx.actor, ctx.now); ctx.events.append({ type: "scra.period.ended", loanId, actor: ctx.actor, payload: { case_id: rec.id, basis: r.basis, ended_on: str(i, "service_end_on"), protection_ends_on: r.protection_ends_on, gate_opens_on: r.gate_opens_on, timer: r.timer } }); const ratePeriodId = scraPeriodEnded_13_9(ctx, rt, loanId, date(i, "service_end_on")); return { ...(scraCaseFor(rt, ctx, loanId) ?? rec.data), service_end_basis: r.basis, gate_opens_on: r.gate_opens_on, timer: r.timer, rate_period_id: ratePeriodId }; }
      if (op === "gate_exception") { need(i, "basis", "document_id"); const basis = str(i, "basis") as (typeof GATE_EXCEPTION_BASES)[number]; if (!GATE_EXCEPTION_BASES.includes(basis)) throw new RangeError(`basis must be one of ${GATE_EXCEPTION_BASES.join(", ")}`);
        if (basis === "court_order_at_fnma_direction") need(i, "fnma_direction_document_id"); else need(i, "attorney_review_document_id");
        const cur = rt.store.get("scra_cases", id)?.data; if (!cur || cur.status === "closed") throw new RangeError(`no open SCRA case ${id} — nothing to except`);
        const exception = { basis, document_id: str(i, "document_id"), fnma_direction_document_id: str(i, "fnma_direction_document_id") || null, attorney_review_document_id: str(i, "attorney_review_document_id") || null, recorded_by: `${ctx.actor.kind}:${ctx.actor.id}`, recorded_at: ctx.now };
        gateOpened(rt, ctx, loanId, "SCRA_3953C_FC_PROTECTION_GATE", basis, { case_id: id, ...exception });
        const facts = scraGateFacts(rt, ctx, loanId, cur);
        return { ...cur, gate: "open", gate_exception: exception, court_order_at_fnma_direction: facts.court_order_at_fnma_direction, section_3918_agreement_reviewed: facts.section_3918_agreement_reviewed }; }
      if (op === "affidavit") { const c = (i.checklist as Row | undefined) ?? {}; const r = scraAffidavit({ judicial: i.judicial !== false, today: D(ctx.now.slice(0, 10)), executed_by_role: ctx.actor.kind === "human" ? (ctx.actor.role ?? null) : null, kind: (str(i, "kind") || "non_military_affidavit") as "non_military_affidavit", checklist: { certificate_ids: (c.certificate_ids as string[] | undefined) ?? [], certificate_on: c.certificate_on ? D(String(c.certificate_on)) : D("1970-01-01"), party_match: c.party_match === true, conflicting_assertions: c.conflicting_assertions === true, future_call_up: c.future_call_up === true }, filing_evidence_document_id: (i.filing_evidence_document_id as string | undefined) ?? null }); if (!r.allowed) throw new RangeError(r.refusal!); const rec = rt.store.put("scra_affidavits", str(i, "affidavit_id") || `aff-${loanId}-${ctx.now}`, { loan_id: loanId, kind: str(i, "kind") || "non_military_affidavit", judicial: i.judicial !== false, subjects: c.certificate_ids ?? [], certificate_on: c.certificate_on ? String(c.certificate_on) : null, records_review: r.records_review, executed_by: `${ctx.actor.kind}:${ctx.actor.id}`, executed_by_role: ctx.actor.kind === "human" ? (ctx.actor.role ?? null) : null, executed_at: ctx.now }, ctx.actor, ctx.now); ctx.events.append({ type: "scra.affidavit.executed", loanId, actor: ctx.actor, payload: { affidavit_id: rec.id, motion_instruction_released: r.motion_instruction_released } }); return { ...rec.data, ...r }; }
      const extra = scraCaseOps_13_8(op, i, ctx, rt, loanId, id); if (extra !== undefined) return extra;
      const extra139 = scraCaseOps_13_9(op, i, ctx, rt, loanId, id); if (extra139 !== undefined) return extra139;   // 13.9 SCRA 6% cap ops (./section13-9.ts)
      throw new RangeError(`op ${op} is not one of get/open/close/gate_exception/affidavit/contact/affidavit_filed/judgment_reopen`); }),
    guardrails: [never("CANNOT_OPEN_GATE", "13.8 guardrail: the agent cannot open a gate; only tail expiry, a court order at Fannie Mae's direction, or an attorney-reviewed §3918 agreement can", (i) => flag(i, "open_gate") || has(i, "protection_ends_on", "gate_opens_on", "gate", "closed_reason", "court_order_at_fnma_direction", "section_3918_agreement_reviewed", "status") || (str(i, "op") === "close" && !has(i, "orders_document_id", "dmdc_certificate_id", "borrower_confirmation_contact_id")) || (str(i, "op") === "gate_exception" && !GATE_EXCEPTION_BASES.includes(str(i, "basis") as "section_3918_agreement")), "wait for the tail or the attorney; a service end needs orders, the DMDC Left-Active-Duty flag or the borrower's confirmation; the exception is the attorney's recorded evaluation row, never a flag"),
      never("NO_MODEL_LATE_CHARGE_FIGURE", "13.9 guardrail / D2-3.4-01: money math is code; the model never edits amounts — the late-charge waiver is the 2.7 fees rows assessed after the call to active duty", (i) => has(i, ...SCRA_MONEY_FIELDS), "omit the amount; the handler sums the loan's late-charge fees assessed on/after service_begin_on (officer overrides travel in `changes`)"),
      needsRole("GATE_EXCEPTION_IS_ATTORNEYS", "13.8 guardrail: a court order obtained at Fannie Mae's direction or a §3918 agreement is recorded by the attorney who reviewed it", (i) => str(i, "op") === "gate_exception" || flag(i, "open_gate"), ["attorney"], "the attorney records the order/agreement with the documents; the agent never opens the gate"),
      never("NEVER_SEEK_WAIVER", "13.8 guardrail: the agent never asks a servicemember to waive rights (D2-3.4-01)", (i) => flag(i, "solicit_waiver") || flag(i, "accept_waiver") || str(i, "basis") === "borrower_waiver" || str(i, "basis") === "borrower_consent" || (flag(i, "borrower_asks_to_waive") && waiverRequest({ borrower_asks_to_waive: true }).escalation !== null && str(i, "op") === "close"), "route to the attorney; the agent neither solicits nor accepts a waiver"),
      never("NO_COURT_RELIEF_REQUEST", "13.9 guardrail / D2-3.4-01: no court-relief request (petition to proceed against a servicemember) is ever prepared", (i) => flag(i, "court_relief_request") || COURT_RELIEF.test(str(i, "op")) || COURT_RELIEF.test(str(i, "kind")), "Fannie Mae prohibits seeking consent or petitioning to proceed"),
      needsRole("ATTORNEY_REVIEWS_ASSERTED_SERVICE_DENIAL", "13.9 guardrail: no denial without attorney review when service is asserted in writing", (i) => str(i, "op") === "open" && flag(i, "written_assertion") && str(i, "dmdc_status") !== "Y" && !str(i, "orders_document_id"), ["attorney"], "DMDC N/Z against a written assertion: request orders and let the attorney review before any denial"),
      needsRole("AFFIDAVIT_SIGNING_OFFICER", "13.8 guardrail: affidavits are executed only by a signing_officer after the recorded records review", (i) => str(i, "op") === "affidavit", ["signing_officer"], "checklist: certificate ids, dates, party matching, no conflicting assertions"),
      needsRole("REOPEN_DECISION_IS_ATTORNEYS", "13.8 timer table SCRA_3931G_DEFAULT_JUDGMENT_REOPEN_90 (breach → `attorney`): the court's 50 U.S.C. 3931(g) reopening decision is recorded by the attorney", (i) => str(i, "op") === "judgment_reopen", ["attorney"], "the attorney records the decision with the order; the agent only escalates the post-judgment Y")] },
]);

export const SECTION_13_TOOLS: readonly ToolDef[] = [...p131, ...p132, ...p134, ...p135, ...p136, ...p137, ...p138];
export type { GateEvaluation, Step as GateStep, GateState };
