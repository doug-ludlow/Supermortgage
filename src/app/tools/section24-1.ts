/**
 * §24.1 process-owned tools — bus tools for 24.1 defined with `defineTools("24.1", "valuation", defs)` from ../tools.ts.
 * Every tool string is one spec/registry/agents.json names for 24.1; src/app/tools.test.ts refuses the rest. Spread by
 * ./index.ts. The handlers are thin: the rules live in src/domain/property/ops-24-1.ts; the store keeps
 * `valuation_orders`, `property_data_collections`, `appraiser_panel`, `amc_registrations`, `valuation_fee_benchmarks`
 * and `air_contact_log` (migration 0088); the DU offer is read from 23.1's `du.findings.received`, the LE receipt from
 * 21.2's events and the intent from 21.4's `intent_records`. The AMC (`services.amc`) and the Property Data API
 * (`services.propertyData`) are ports; the in-process fakes stand in until a vendor adapter is wired.
 * Guardrails encode the AI-design sentences ("never alone, never at all"): no value, value range, target LTV, loan
 * amount, DU estimated value or "needed" value in any outbound payload (schema allowlist; `air.guardrail.blocked` row);
 * no comparables before engagement; no fee conditioned on value; no vendor exclusion for "low values"; no order by a
 * restricted-party actor; no order before ITP when borrower-paid; no appraisal accepted from an interested party; the
 * §1026.42(g)/AIR §7 misconduct determination and referral are the partner `officer`'s.
 */
import { defineTools, compute, never, needsRole, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { intentInForce, leReceiptFromEvents, type IntentRecord } from "../../domain/application/ops-21-4.ts";
import {
  CREDITOR_TZ, FakeAmc, FakePropertyDataApi, ValuationRefused, acceptTransferredReport, amcRegistrationGate, appraiserLicenseGate, assertFeeGate, assignAppraiser, benchmarkFee, cancelOrder, civilDate, completeInspection, convertOnSafetyIssue, decisionRecord, deliveryData, detectOfferLoss,
  evaluateAppraisalUpdate, logContact, orderAppraisalUpdate, orderPdc, placeOrder, readDuOffer, receiveAppraisalUpdate, receiveReport, recordMethodSelection, recordPdcCollection, referMisconduct, scheduleInspection, selectMethod, selectVendor, submitPropertyData, suspectMisconduct, validateOrderPayload,
  type AmcPort, type AmcRegistration, type AppraiserFacts, type AssignmentType, type FeeBenchmark, type FeePaidBy, type FeeTest, type MethodFacts, type MethodSelection, type OfferType, type OrderChannel, type PropertyDataCollection, type PropertyDataPort, type UadVersion, type ValuationOrder, type VendorCandidate,
} from "../../domain/property/ops-24-1.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "application_id") || ctx.applicationId || ""; if (!id) throw new RangeError("application_id is required"); return id; };
const at = (i: ToolInput, k: string, ctx: CommandContext): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const dateOf = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const orderOf = (rt: ToolRuntime, i: ToolInput, k = "order_id"): ValuationOrder => { need(i, k); return rt.store.require("valuation_orders", str(i, k)).data as unknown as ValuationOrder; };
const putOrder = (rt: ToolRuntime, o: ValuationOrder, ctx: CommandContext): ValuationOrder => rt.store.put("valuation_orders", o.order_id, { ...o }, ctx.actor, ctx.now).data as unknown as ValuationOrder;
const pdcOf = (rt: ToolRuntime, i: ToolInput, k = "pdc_id"): PropertyDataCollection => { need(i, k); return rt.store.require("property_data_collections", str(i, k)).data as unknown as PropertyDataCollection; };
const putPdc = (rt: ToolRuntime, x: PropertyDataCollection, ctx: CommandContext): PropertyDataCollection => rt.store.put("property_data_collections", x.pdc_id, { ...x }, ctx.actor, ctx.now).data as unknown as PropertyDataCollection;
const intentsOf = (rt: ToolRuntime, app: string): IntentRecord[] => rt.store.list("intent_records", (d) => d.application_id === app).map((r) => r.data as unknown as IntentRecord);
const amcOf = (rt: ToolRuntime): AmcPort => { const svc = rt.services.amc as AmcPort | undefined; if (svc) return svc; const f = new FakeAmc(); (rt.services as Record<string, unknown>).amc = f; return f; };
const pdApiOf = (rt: ToolRuntime): PropertyDataPort => { const svc = rt.services.propertyData as PropertyDataPort | undefined; if (svc) return svc; const f = new FakePropertyDataApi(); (rt.services as Record<string, unknown>).propertyData = f; return f; };
const tzOf = (i: ToolInput): string => str(i, "time_zone") || CREDITOR_TZ;
/** R1 facts from the tool input (23.1's offer is read from events unless `offer_type` overrides it). */
const methodFacts = (i: ToolInput, offer: ReturnType<typeof readDuOffer>, ctx: CommandContext): MethodFacts => {
  need(i, "transaction_type", "occupancy", "units", "property_type", "ltv_bps");
  return { offer_type: (str(i, "offer_type") || offer.offer_type) as OfferType, du_recommendation: str(i, "du_recommendation") || offer.recommendation, hybrid_offered: flag(i, "hybrid_offered") || offer.hybrid_offered, desktop_offered: flag(i, "desktop_offered") || offer.desktop_offered,
    transaction_type: str(i, "transaction_type") as MethodFacts["transaction_type"], occupancy: str(i, "occupancy") as MethodFacts["occupancy"], units: Number(i.units), property_type: str(i, "property_type") as MethodFacts["property_type"], ltv_bps: Number(i.ltv_bps),
    homeready: flag(i, "homeready"), hpml_non_exempt: flag(i, "hpml_non_exempt"), flip_test_fires: flag(i, "flip_test_fires"), known_condition_issue: flag(i, "known_condition_issue"), appraisal_obtained: flag(i, "appraisal_obtained"), pdc_on_file: flag(i, "pdc_on_file"), pdc_safety_issue: flag(i, "pdc_safety_issue"),
    manually_underwritten: flag(i, "manually_underwritten"), rental_income_qualifying: flag(i, "rental_income_qualifying"), ordered_on: optDate(i, "ordered_on") ?? civilDate(at(i, "at", ctx), tzOf(i)) };
};
const feeGateFacts = (rt: ToolRuntime, i: ToolInput, ctx: CommandContext, app: string, checkedAt: string) => ({
  le_effective_receipt_date: optDate(i, "le_effective_receipt_date") ?? leReceiptFromEvents(ctx.events, app)?.effective_receipt_date ?? null,
  intent: (i.intent as IntentRecord | undefined) ?? intentInForce(intentsOf(rt, app), checkedAt),
  ...(i.order_before_itp !== undefined ? { order_before_itp: flag(i, "order_before_itp") } : {}), fee_item_id: str(i, "fee_item_id") || null,
});
const benchmarkOf = (rt: ToolRuntime, i: ToolInput): FeeBenchmark => {
  const inline = i.benchmark as Record<string, unknown> | undefined;
  const row = inline ?? (typeof i.benchmark_id === "string" ? rt.store.require("valuation_fee_benchmarks", i.benchmark_id).data : undefined);
  if (!row) throw new RangeError("benchmark (or benchmark_id) is required");
  return { benchmark_id: String(row.benchmark_id ?? i.benchmark_id ?? "benchmark"), state: String(row.state ?? ""), county_fips: String(row.county_fips ?? ""), form_code: String(row.form_code ?? ""), assignment_type: String(row.assignment_type ?? "traditional") as AssignmentType, median_fee_cents: cents(row.median_fee_cents), p25_fee_cents: cents(row.p25_fee_cents), p75_fee_cents: cents(row.p75_fee_cents), source: (String(row.source ?? "third_party_survey_1026_42f3")) as FeeBenchmark["source"], as_of: D(String(row.as_of ?? "2026-01-01")) };
};
const appraiserOf = (i: ToolInput): AppraiserFacts => {
  const a = (i.appraiser as Record<string, unknown> | undefined) ?? i;
  for (const k of ["party_id", "license_state", "license_number", "license_expires_on", "asc_registry_checked_on"]) if (a[k] === undefined || a[k] === null || a[k] === "") throw new RangeError(`appraiser.${k} is required`);
  return { party_id: String(a.party_id), license_state: String(a.license_state), license_type: (String(a.license_type ?? "certified_residential")) as AppraiserFacts["license_type"], license_number: String(a.license_number), license_expires_on: D(String(a.license_expires_on)), asc_registry_status: (String(a.asc_registry_status ?? "active")) as AppraiserFacts["asc_registry_status"], asc_registry_checked_on: D(String(a.asc_registry_checked_on)), ...(a.panel_status ? { panel_status: String(a.panel_status) as "active" | "suspended" | "removed" } : {}) };
};
const registrationOf = (rt: ToolRuntime, i: ToolInput): AmcRegistration | null => {
  const r = (i.amc_registration as Record<string, unknown> | undefined) ?? (typeof i.amc_registration_id === "string" ? rt.store.get("amc_registrations", i.amc_registration_id)?.data : undefined);
  if (!r) return null;
  return { amc_registration_id: String(r.amc_registration_id ?? i.amc_registration_id ?? ""), amc_party_id: String(r.amc_party_id ?? ""), state: String(r.state ?? ""), registration_number: String(r.registration_number ?? ""), expires_on: D(String(r.expires_on)), asc_amc_registry_status: (String(r.asc_amc_registry_status ?? "unknown")) as AmcRegistration["asc_amc_registry_status"], verified_at: String(r.verified_at ?? "") };
};
const hasValueKeys = (i: ToolInput): boolean => { const p = i.order_payload as Record<string, unknown> | undefined; return !!p && !validateOrderPayload(p).ok; };
/** ops-24-1 refusals (ValuationRefused) surface as CommandRefused with the same code and citation. */
const refusing = (defs: readonly Omit<ToolDef, "process" | "agent">[]): Omit<ToolDef, "process" | "agent">[] => defs.map((d) => ({ ...d, handler: async (i, ctx, rt) => { try { return await d.handler(i, ctx, rt); } catch (e) { if (e instanceof ValuationRefused) throw new CommandRefused(d.name, e.code, e.citation, e.message); throw e; } } }));
const decide = (ctx: CommandContext, app: string, action: string, rationale: string, extra: Partial<Parameters<CommandContext["decide"]>[0]> = {}): void =>
  ctx.decide({ agent: "valuation", action, rationale, ruleSetVersion: "fnma.selling.2026-09-02", applicationId: app, loanId: ctx.loanId, modelVersion: ctx.run?.modelVersion ?? "valuation-2026.09", promptVersion: ctx.run?.promptVersion ?? "24.1-r1-v1", confidence: ctx.run?.confidence ?? 0.99, ...extra });

export const TOOLS_24_1: readonly ToolDef[] = defineTools("24.1", "valuation", refusing([
  // The DU offer (23.1) is the menu: value_acceptance / value_acceptance_pd / none plus the hybrid and desktop messages; never an LTV-table computation.
  { name: "readDuOffer", kind: "read", handler: compute((i, ctx) => readDuOffer(ctx.events, appOf(i, ctx))) },
  // R1 on every trigger: offer loss detected first (`valuation.offer.lost`), then the selection event and the decision record with the exclusion list.
  { name: "selectMethod", kind: "write", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const when = at(i, "at", ctx);
      const lost = detectOfferLoss(ctx.events, app, when, ctx.actor);
      const offer = readDuOffer(ctx.events, app);
      const facts = methodFacts(i, offer, ctx);
      const sel: MethodSelection = selectMethod(facts);
      const event = recordMethodSelection(ctx.events, app, sel, when, { offer_type: facts.offer_type, du_submission_id: offer.du_submission_id, pdc_id: str(i, "pdc_id") || null, time_zone: tzOf(i), actor: ctx.actor });
      const record = decisionRecord(sel, { application_id: app, offer_type: facts.offer_type, du_submission_id: offer.du_submission_id, ...(ctx.run ? { model_version: ctx.run.modelVersion, prompt_version: ctx.run.promptVersion } : {}) });
      const id = `sel-${rt.store.list("valuation_method_selections").length + 1}`;
      rt.store.put("valuation_method_selections", id, { selection_id: id, ...record, selected_at: when, event_id: event.id, offer_lost_event_id: lost?.id ?? null }, ctx.actor, ctx.now);
      return { selection_id: id, ...sel, offer_type: facts.offer_type, offer_lost: lost !== null, event_id: event.id, decision: record };
    }, ), decision: (i, o) => ({ action: "selectMethod", rationale: (o as { decision: { rationale: string } }).decision.rationale, subject: { kind: "valuation_method_selection", id: (o as { selection_id: string }).selection_id }, ruleCode: "24.1 R1" }) },
  // R2: borrower-paid → 21.4's fee gate (a fee_gate_checks row for every attempt, refusals included); SM-borne → ordering waits for a documented intent (valuation.order_before_itp=false).
  { name: "assertFeeGate", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "fee_paid_by", "amount_cents"); const app = appOf(i, ctx); const when = at(i, "checked_at", ctx);
      const r = assertFeeGate(ctx.events, { application_id: app, command: (str(i, "command") || "order_appraisal") as "order_appraisal" | "order_pdc", fee_paid_by: str(i, "fee_paid_by") as FeePaidBy, amount_cents: cents(i.amount_cents), checked_at: when, ...feeGateFacts(rt, i, ctx, app, when), time_zone: tzOf(i) }, ctx.actor);
      if (r.check) rt.store.put("fee_gate_checks", r.check.check_id, { ...r.check }, ctx.actor, ctx.now);
      return { open: true, ...r };
    }), guardrails: [never("FEE_BEFORE_INTENT", "12 CFR 1026.19(e)(2)(i)(A)", (i) => flag(i, "impose_before_intent"), "no order before ITP when borrower-paid; the fee gate decides, never the agent")] },
  // Rotation across panel/AMC by geo-competency and turn-time — never by prior values.
  { name: "selectVendor", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "state", "property_type");
      const cands = (i.candidates as VendorCandidate[] | undefined) ?? rt.store.list("vendors").map((r) => r.data as unknown as VendorCandidate);
      const r = selectVendor(cands, { state: str(i, "state"), county: str(i, "county") || null, property_type: str(i, "property_type"), channel: (str(i, "channel") || null) as OrderChannel | null });
      void ctx; return { vendor_party_id: r.vendor.party_id, channel: r.vendor.kind, ranked: r.ranked };
    }), guardrails: [never("AIR_1_2_VALUE_BASED_EXCLUSION", "AIR §1.2; 12 CFR 1026.42(c)(1)", (i) => typeof i.exclude_for === "string" && /value/i.test(i.exclude_for), "no vendor exclusion for \"low values\"")] },
  // SM_APPRAISER_LICENSE_GATE: license active in the property state, ASC check ≤ 30 days; with `order_id` the appraiser is assigned (or the order reassigned when the gate blocks).
  { name: "verifyAppraiserLicense", kind: "write", handler: compute((i, ctx, rt) => {
      const a = appraiserOf(i);
      rt.store.put("appraiser_panel", a.party_id, { ...a, verified_at: ctx.now }, ctx.actor, ctx.now);
      if (typeof i.order_id === "string" && i.order_id) {
        const order = orderOf(rt, i); const r = assignAppraiser(ctx.events, order, a, at(i, "assigned_at", ctx), ctx.actor);
        if (r.reassigned) { putOrder(rt, { ...order, status: "reassigned" }, ctx); putOrder(rt, r.order, ctx); } else putOrder(rt, r.order, ctx);
        return { open: r.gate.open, reason: r.gate.reason ?? null, reassigned: r.reassigned, order_id: r.order.order_id, status: r.order.status, event_id: r.event.id };
      }
      need(i, "property_state"); const g = appraiserLicenseGate(a, str(i, "property_state"), optDate(i, "on") ?? civilDate(ctx.now, tzOf(i)));
      return { open: g.open, reason: g.reason ?? null, reassigned: false };
    }) },
  // SM_AMC_REGISTRATION_GATE: the `amc_registrations` row for the property state, unexpired, ASC AMC registry active (12 U.S.C. 3353).
  { name: "verifyAmcRegistration", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "property_state"); const r = registrationOf(rt, i);
      if (r) rt.store.put("amc_registrations", r.amc_registration_id || `${r.amc_party_id}-${r.state}`, { ...r }, ctx.actor, ctx.now);
      const g = amcRegistrationGate(r, str(i, "property_state"), optDate(i, "on") ?? civilDate(ctx.now, tzOf(i)));
      return { open: g.open, reason: g.reason ?? null, amc_registration_id: r?.amc_registration_id ?? null };
    }) },
  // R3: the appraiser share (not the AMC gross) against p25–p75 of the benchmark row, or a §1026.42(f)(2) adjustment reason; otherwise held for a vendor re-quote.
  { name: "benchmarkFee", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "gross_cents", "appraiser_share_cents");
      const t = benchmarkFee({ gross_cents: cents(i.gross_cents), appraiser_share_cents: cents(i.appraiser_share_cents), amc_share_cents: i.amc_share_cents === undefined ? null : cents(i.amc_share_cents), adjustment_reason: str(i, "adjustment_reason") || null }, benchmarkOf(rt, i));
      void ctx; return { ...t, tested_cents: String(t.tested_cents), p25_fee_cents: String(t.p25_fee_cents), p75_fee_cents: String(t.p75_fee_cents), fee_item_current_amount_cents: String(t.fee_item_current_amount_cents) };
    }), guardrails: [never("AIR_1_2_FEE_CONDITIONED_ON_VALUE", "AIR §1.2; 12 CFR 1026.42(c)(1)", (i) => flag(i, "conditioned_on_value"), "no fee conditioned on value")] },
  // The order: restricted-party check, fee gate, fee benchmark, AMC registration, AIR payload allowlist, `valuation.ordered` (+ `valuation.amc.verified`); the AMC receives only the allowlisted payload.
  { name: "placeOrder", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "property_state", "vendor_party_id", "fee_paid_by", "fee_quote_cents", "fee_test"); const app = appOf(i, ctx); const when = at(i, "ordered_at", ctx);
      const offer = readDuOffer(ctx.events, app);
      const selection = (i.selection as MethodSelection | undefined) ?? selectMethod(methodFacts(i, offer, ctx));
      const feeTest = i.fee_test as FeeTest;
      const r = placeOrder(ctx.events, { application_id: app, selection, offer, ordered_at: when, property_state: str(i, "property_state"), channel: (str(i, "channel") || "amc") as OrderChannel, vendor_party_id: str(i, "vendor_party_id"), fee_paid_by: str(i, "fee_paid_by") as FeePaidBy, fee_quote_cents: cents(i.fee_quote_cents),
        fee_test: { ...feeTest, held_for_requote: feeTest.held_for_requote === true, benchmark_id: String(feeTest.benchmark_id ?? "") }, fee_gate: feeGateFacts(rt, i, ctx, app, when), amc_registration: registrationOf(rt, i), order_payload: (i.order_payload as Record<string, unknown> | undefined) ?? {}, amc: amcOf(rt), pdc_id: str(i, "pdc_id") || null,
        first_ucdp_submission_on: optDate(i, "first_ucdp_submission_on"), application_status: str(i, "application_status") || "active", ...(str(i, "assignment_type") ? { assignment_type: str(i, "assignment_type") as AssignmentType } : {}), reassigned_from_order_id: str(i, "reassigned_from_order_id") || null, agent_run_id: ctx.run?.runId ?? null, time_zone: tzOf(i) }, ctx.actor);
      if (r.fee_gate.check) rt.store.put("fee_gate_checks", r.fee_gate.check.check_id, { ...r.fee_gate.check }, ctx.actor, ctx.now);
      putOrder(rt, r.order, ctx);
      decide(ctx, app, "placeOrder", `${selection.rationale}; vendor ${r.order.vendor_party_id} (${r.order.channel}); fee ${r.order.fee_quote_cents} cents ${feeTest.reason}; fee gate ${r.fee_gate.tolerance_class}`, { subject: { kind: "valuation_order", id: r.order.order_id }, ruleCode: "24.1 R1–R3" });
      return { order_id: r.order.order_id, status: r.order.status, method: r.order.method, form_code: r.order.form_code, uad_version: r.order.uad_version, vendor_order_id: r.order.vendor_order_id, fee_gate: r.fee_gate.tolerance_class, event_id: r.event.id };
    }), decision: () => null,
    guardrails: [
      never("AIR_1_2_VALUE_INFORMATION", "AIR §1.2; 12 CFR 1026.42(c)(1)", hasValueKeys, "no value, value range, target LTV, loan amount, DU estimated value or \"needed\" value in any outbound payload (order-payload allowlist)"),
      never("AIR_1_2_COMPARABLES_BEFORE_ENGAGEMENT", "AIR §1.2", (i) => Array.isArray(i.comparables) && i.comparables.length > 0, "no comparables sent before engagement"),
      never("FNMA_B4_1_1_03_INTERESTED_PARTY", "B4-1.1-03", (i) => ["borrower", "seller", "agent"].includes(str(i, "ordered_by")), "no appraisal ordered or received by the borrower, seller, agent or another interested party"),
    ] },
  // Inspection access scheduling (content restricted to scheduling); `op=complete` records the AMC's inspection-complete webhook.
  { name: "scheduleInspection", kind: "write", handler: compute((i, ctx, rt) => {
      const order = orderOf(rt, i);
      if (i.op === "complete") { const r = completeInspection(ctx.events, order, at(i, "completed_at", ctx), ctx.actor); putOrder(rt, r.order, ctx); return { order_id: order.order_id, status: r.order.status, event_id: r.event.id }; }
      need(i, "scheduled_for"); const r = scheduleInspection(ctx.events, order, at(i, "scheduled_at", ctx), str(i, "scheduled_for"), ctx.actor); putOrder(rt, r.order, ctx);
      return { order_id: order.order_id, status: r.order.status, event_id: r.event.id };
    }), guardrails: [never("AIR_VALUE_DISCUSSION", "24.1 integrations: borrower channels are scheduling only", (i) => typeof i.message === "string" && /value|worth|appraise[d]? at/i.test(i.message), "the valuation agent never discusses value with the borrower")] },
  // Order tracking: status (AMC getStatus), `op=receive` (the report: FNM0391 / wrong lender-client rejections, `valuation.received`, ledger), `op=cancel`, `op=transfer_in` (AIR §6), `op=delivery_data` (29.3).
  { name: "trackOrder", kind: "write", handler: compute((i, ctx, rt) => {
      switch (i.op ?? "status") {
        case "status": { const o = orderOf(rt, i); return { order_id: o.order_id, status: o.status, vendor_status: o.vendor_order_id ? amcOf(rt).getStatus(o.vendor_order_id).status : null, timers: ctx.timers.forSubject("application", o.application_id).filter((t) => t.code.startsWith("SM_VALUATION_")).map((t) => ({ code: t.code, status: t.status, due_date: t.dueDate ?? null })) }; }
        case "receive": {
          const o = orderOf(rt, i); need(i, "report_document_id", "uad_version", "effective_date");
          const r = receiveReport(ctx.events, o, { report_document_id: str(i, "report_document_id"), uad_version: str(i, "uad_version") as UadVersion, effective_date: dateOf(i, "effective_date"), received_at: at(i, "received_at", ctx), ...(str(i, "assignment_type") ? { assignment_type: str(i, "assignment_type") as AssignmentType } : {}), declined: flag(i, "declined"), lender_client_name: str(i, "lender_client_name") || null, partner_name: str(i, "partner_name") || null, fee_invoice_cents: i.fee_invoice_cents === undefined ? null : cents(i.fee_invoice_cents), delivered_by: (str(i, "delivered_by") || "vendor") as "vendor" | "borrower" | "seller" | "agent" | "other_lender" }, ctx.ledger, ctx.actor);
          if (r.accepted) putOrder(rt, r.order, ctx);
          return { accepted: r.accepted, reference: r.reference, order_id: r.order.order_id, status: r.order.status, effective_date: r.order.effective_date, age_4m_update_after: r.dates?.age_4m_update_after ?? null, age_12m_expires_on: r.dates?.age_12m_expires_on ?? null, reengagement_event_id: r.reengagement?.id ?? null, ledger_set_id: r.ledger_set?.id ?? null };
        }
        case "cancel": { const o = orderOf(rt, i); need(i, "reason"); const r = cancelOrder(ctx.events, o, str(i, "reason"), at(i, "cancelled_at", ctx), amcOf(rt), ctx.actor); putOrder(rt, r.order, ctx); return { order_id: o.order_id, status: r.order.status }; }
        case "transfer_in": {
          const app = appOf(i, ctx); need(i, "report_document_id", "effective_date", "note_date", "original_lender_client_name", "property_state");
          const r = acceptTransferredReport(ctx.events, { application_id: app, report_document_id: str(i, "report_document_id"), effective_date: dateOf(i, "effective_date"), note_date: dateOf(i, "note_date"), air_attestation_document_id: str(i, "air_attestation_document_id") || null, original_lender_client_name: str(i, "original_lender_client_name"), uad_version: (str(i, "uad_version") || "3.6") as UadVersion, received_at: at(i, "received_at", ctx), property_state: str(i, "property_state") }, ctx.actor);
          putOrder(rt, r.order, ctx); return { order_id: r.order.order_id, status: r.order.status, transferred_from_lender: true, ucdp_resubmission_required: r.ucdp_resubmission_required, review_process: r.review_process };
        }
        case "delivery_data": { const o = orderOf(rt, i); const pdc = o.pdc_id ? (rt.store.get("property_data_collections", o.pdc_id)?.data as unknown as PropertyDataCollection | undefined) ?? null : null; return deliveryData(o, pdc); }
        default: throw new RangeError(`trackOrder op ${String(i.op)} is not one of status/receive/cancel/transfer_in/delivery_data`);
      }
    }), guardrails: [never("FNMA_B4_1_1_03_INTERESTED_PARTY", "B4-1.1-03", (i) => ["borrower", "seller", "agent"].includes(str(i, "delivered_by")), "no appraisal accepted from the borrower, seller, agent or another interested party")] },
  // VA+PD: `op=order` (vetted collector; fee gate), `op=collect` (UPD, ANSI floor plan, safety flag), `op=submit` (Property Data API → Property Data ID; FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE), `op=convert` (safety issue → hybrid with the PDC shared at engagement).
  { name: "submitPropertyData", kind: "act", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx);
      switch (i.op ?? "submit") {
        case "order": {
          need(i, "vendor_party_id", "collector_party_id", "collector_background_check_on", "collector_training_evidence_id", "pdcir_attestation_id"); const when = at(i, "ordered_at", ctx);
          const gate = assertFeeGate(ctx.events, { application_id: app, command: "order_pdc", fee_paid_by: (str(i, "fee_paid_by") || "sm") as FeePaidBy, amount_cents: cents(i.amount_cents ?? 15_000n), checked_at: when, ...feeGateFacts(rt, i, ctx, app, when), time_zone: tzOf(i) }, ctx.actor);
          const r = orderPdc(ctx.events, app, { vendor_party_id: str(i, "vendor_party_id"), collector_party_id: str(i, "collector_party_id"), collector_background_check_on: dateOf(i, "collector_background_check_on"), collector_training_evidence_id: str(i, "collector_training_evidence_id"), pdcir_attestation_id: str(i, "pdcir_attestation_id") }, when, gate, str(i, "order_id") || null, ctx.actor);
          putPdc(rt, r.pdc, ctx); return { pdc_id: r.pdc.pdc_id, status: r.pdc.status, event_id: r.event.id };
        }
        case "collect": {
          const pdc = pdcOf(rt, i); need(i, "collected_at", "upd_version", "floor_plan_document_id", "image_document_ids");
          const r = recordPdcCollection(ctx.events, pdc, { collected_at: str(i, "collected_at"), upd_version: str(i, "upd_version"), floor_plan_document_id: str(i, "floor_plan_document_id"), image_document_ids: (i.image_document_ids as string[]), safety_issue_flag: flag(i, "safety_issue_flag"), safety_issue_notes: str(i, "safety_issue_notes") || null, interior_observed: i.interior_observed !== false, exterior_observed: i.exterior_observed !== false, ansi_floor_plan: i.ansi_floor_plan !== false }, ctx.actor);
          putPdc(rt, r.pdc, ctx); return { pdc_id: pdc.pdc_id, status: r.pdc.status, safety_issue_flag: r.pdc.safety_issue_flag, safety_event_id: r.safety_event?.id ?? null };
        }
        case "submit": {
          const pdc = pdcOf(rt, i); const r = submitPropertyData(ctx.events, pdc, pdApiOf(rt), at(i, "submitted_at", ctx), ctx.actor);
          putPdc(rt, r.pdc, ctx); return { pdc_id: pdc.pdc_id, status: r.pdc.status, submission_status: r.pdc.submission_status, property_data_id_fnma: r.pdc.property_data_id_fnma, accepted_on: r.pdc.accepted_on, rejection_messages: r.pdc.rejection_messages };
        }
        case "convert": {
          const pdc = pdcOf(rt, i); const offer = readDuOffer(ctx.events, app); const f = methodFacts(i, offer, ctx);
          const r = convertOnSafetyIssue(ctx.events, app, pdc, f, at(i, "at", ctx), offer, ctx.actor);
          putPdc(rt, { ...pdc, status: r.conversion }, ctx);
          decide(ctx, app, "submitPropertyData:convert", r.decision.rationale, { subject: { kind: "property_data_collection", id: pdc.pdc_id }, ruleCode: "B4-1.4-11" });
          return { pdc_id: pdc.pdc_id, conversion: r.conversion, method: r.selection.method, form_code: r.selection.form_code, pdc_shared: r.pdc_shared, citations: r.decision.citations, event_id: r.event.id };
        }
        default: throw new RangeError(`submitPropertyData op ${String(i.op)} is not one of order/collect/submit/convert`);
      }
    }), decision: (i, o) => (i.op === "convert" ? null : { action: `submitPropertyData:${String(i.op ?? "submit")}`, rationale: `B4-1.4-11 property data collection ${String((o as { pdc_id: string }).pdc_id)}`, subject: { kind: "property_data_collection", id: String((o as { pdc_id: string }).pdc_id) }, ruleCode: "B4-1.4-11" }) },
  // B4-1.2-04: `op=evaluate` (the 4-month rule against the note date), `op=order` (child appraisal_update order), `op=receive` (update report; "declined" → method_pending).
  { name: "orderAppraisalUpdate", kind: "act", handler: compute((i, ctx, rt) => {
      const parent = orderOf(rt, i); const note = dateOf(i, "note_date");
      switch (i.op ?? "order") {
        case "evaluate": { if (!parent.effective_date) throw new RangeError("order has no effective_date"); const u = i.update as { effective_date: string; declined: boolean; report_document_id: string } | undefined; return evaluateAppraisalUpdate(parent.effective_date, note, u ? { effective_date: D(u.effective_date), declined: u.declined === true, report_document_id: u.report_document_id } : null); }
        case "order": { const r = orderAppraisalUpdate(ctx.events, parent, at(i, "ordered_at", ctx), note, ctx.actor); putOrder(rt, { ...parent, status: "update_required" }, ctx); putOrder(rt, r.order, ctx); return { order_id: r.order.order_id, parent_order_id: parent.order_id, form_code: r.order.form_code, window: r.window, event_id: r.event.id }; }
        case "receive": {
          const child = orderOf(rt, i, "update_order_id"); need(i, "report_document_id", "effective_date");
          const r = receiveAppraisalUpdate(ctx.events, parent, child, { report_document_id: str(i, "report_document_id"), effective_date: dateOf(i, "effective_date"), declined: flag(i, "declined"), received_at: at(i, "received_at", ctx) }, note, ctx.actor);
          putOrder(rt, r.receipt.order, ctx); putOrder(rt, r.parent, ctx);
          return { parent_status: r.parent.status, next_status: r.evaluation.next_status, open: r.evaluation.open, reason: r.evaluation.reason, window: r.evaluation.window };
        }
        default: throw new RangeError(`orderAppraisalUpdate op ${String(i.op)} is not one of evaluate/order/receive`);
      }
    }) },
  // Every contact with the appraiser/AMC/PDC/borrower is logged with the actor's restricted-party status (enforced false); "what value do you need?" gets the scripted refusal.
  { name: "logContact", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "direction", "counterparty_role", "channel", "content"); const app = appOf(i, ctx);
      const r = logContact(ctx.events, { application_id: app, valuation_order_id: str(i, "order_id") || null, direction: str(i, "direction") as "outbound" | "inbound", counterparty_role: str(i, "counterparty_role") as "appraiser" | "amc" | "pdc" | "borrower" | "agent", channel: str(i, "channel"), content: str(i, "content"), at: at(i, "at", ctx), payload_document_id: str(i, "payload_document_id") || null }, ctx.actor);
      const id = `contact-${rt.store.list("air_contact_log").length + 1}`;
      rt.store.put("air_contact_log", id, { contact_id: id, ...(r.event.payload as Record<string, unknown>) }, ctx.actor, ctx.now);
      return { contact_id: id, content_hash: r.content_hash, scripted_refusal: r.scripted_refusal, event_id: r.event.id };
    }), guardrails: [never("AIR_4_1_1_RESTRICTED_PARTY", "AIR §4.1.1", (i) => flag(i, "actor_is_restricted_party"), "no contact with the appraisal function by a restricted party")] },
  // The `agent_decisions` record per order: exclusions, method/form/UAD, vendor, fee test, license/AMC checks, rule-set / model / prompt versions, rationale, confidence.
  { name: "writeDecision", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "action", "rationale"); const app = appOf(i, ctx);
      const rec = { ...((i.record as Record<string, unknown> | undefined) ?? {}), application_id: app, action: str(i, "action"), rationale: str(i, "rationale"), rule_set_version: str(i, "rule_set_version") || "fnma.selling.2026-09-02", model_version: str(i, "model_version") || ctx.run?.modelVersion || "valuation-2026.09", prompt_version: str(i, "prompt_version") || ctx.run?.promptVersion || "24.1-r1-v1", confidence: typeof i.confidence === "number" ? i.confidence : ctx.run?.confidence ?? 0.99, recorded_at: ctx.now };
      const id = `dec-${rt.store.list("valuation_decisions").length + 1}`; rt.store.put("valuation_decisions", id, rec, ctx.actor, ctx.now);
      return { decision_id: id, ...rec };
    }), decision: (i, o) => ({ action: str(i, "action"), rationale: str(i, "rationale"), subject: { kind: str(i, "subject_kind") || "valuation_order", id: str(i, "order_id") || String((o as { decision_id: string }).decision_id) }, ...(str(i, "rule_code") ? { ruleCode: str(i, "rule_code") } : {}) }) },
  // Escalations: `officer` for §1026.42(g)/AIR §7 referrals (op=misconduct_suspected / misconduct_referred — the officer's acts) and vendor termination; `licensed_specialist` where jurisdiction_rules require; `human_agent` on borrower request (scheduling only).
  { name: "fileEscalation", kind: "act", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx);
      switch (i.op ?? "escalate") {
        case "misconduct_suspected": {
          need(i, "appraiser_party_id", "basis"); const r = suspectMisconduct(ctx.events, { application_id: app, valuation_order_id: str(i, "order_id") || null, appraiser_party_id: str(i, "appraiser_party_id"), basis: str(i, "basis"), determination_at: at(i, "determination_at", ctx) }, ctx.actor);
          const e = rt.escalations.open({ kind: "officer", applicationId: app, loanId: ctx.loanId, severity: "sev1", payload: { reason: "air_misconduct_referral", appraiser_party_id: str(i, "appraiser_party_id"), referral_due_on: r.referral_due_on, citation: "12 CFR 1026.42(g); AIR §7" } }, ctx.actor);
          return { escalation_id: e.id, referral_due_on: r.referral_due_on, event_id: r.event.id };
        }
        case "misconduct_referred": { need(i, "appraiser_party_id", "agency", "referral_document_id"); const e = referMisconduct(ctx.events, { application_id: app, valuation_order_id: str(i, "order_id") || null, appraiser_party_id: str(i, "appraiser_party_id"), agency: str(i, "agency"), referred_at: at(i, "referred_at", ctx), referral_document_id: str(i, "referral_document_id") }, ctx.actor); return { event_id: e.id }; }
        default: {
          need(i, "kind", "reason");
          const kind = str(i, "kind"); if (!["officer", "licensed_specialist", "human_agent", "fnma_portal_operator", "appraiser", "property_data_collector", "mlo_of_record"].includes(kind)) throw new RangeError(`escalation kind ${kind} is not one the 24.1 design names`);
          const e = rt.escalations.open({ kind: kind as "officer", applicationId: app, loanId: ctx.loanId, payload: { reason: str(i, "reason"), order_id: str(i, "order_id") || null, ...((i.payload as Record<string, unknown> | undefined) ?? {}) }, ...(typeof i.severity === "string" ? { severity: i.severity } : {}) }, ctx.actor);
          return { escalation_id: e.id, kind: e.kind, owner_role: e.ownerRole };
        }
      }
    }), guardrails: [needsRole("REGZ_1026_42G_OFFICER", "12 CFR 1026.42(g); AIR §7", (i) => i.op === "misconduct_suspected" || i.op === "misconduct_referred", ["officer"], "the misconduct determination and the referral to the state agency are the partner officer's acts, never the agent's alone")] },
]));
