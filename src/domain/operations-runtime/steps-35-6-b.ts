/**
 * §35.6 State machine — the closing, signing, funding and delivery steps (clear_to_close … purchased) and the off-path
 * `unwinding` step. Each step's `actions` run the OWNING tools as the OWNING agents through the bus with inputs read from the
 * record (facts-35-6-b.ts), idempotent by the owner's own result on the record (PASS_IS_IDEMPOTENT); the pass appends no
 * owning event (OWNER_EMITS) and never performs a reserved act (HUMAN_ACTS_STAY_HUMAN: the wire release is the
 * funding_approver's — the FAKE reviewer's on nonprod — and the row waits `waiting_human{funding_approver}` until the
 * role's event arrives). Every vendor is this process's FAKE (fakes-35-6.ts): the RON platform's session feed, the settlement
 * agent, the funding bank, the print/mail vendor. The delivery steps (boarded … purchased) get their actions in group C.
 */
import { createHash } from "node:crypto";
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { OrchRecord } from "./facts-35-6.ts";
import type { EntityRecord } from "../../app/tools.ts";
import type { StepContext } from "./orchestration-35-6.ts";
import type { StepDef, StepOutcome } from "./steps-35-6.ts";
import { cents, RecordGap, src, sources, type Source } from "./facts-35-6.ts";
import { closingFacts, partyFacts, loanTerms, escrowFacts, creditorFeeLines, payoffFacts, fundsToClose, esignConsents, esignDisclosureClasses, cdRow, cdReceipts, fundingConditionFacts, verifiedWireRecord, warehouseFacts, rescissionFacts, type ClosingFacts } from "./facts-35-6-b.ts";
import { storeDocument } from "./documents-port-35-6.ts";
import { creditOrderFacts } from "./facts-35-6.ts";
import { refreshWindowStart } from "../verification/ops-22-2.ts";
import { GATES } from "../compliance-disclosures/ops-25-1.ts";
import { FACILITY_FIXTURE } from "../warehouse/ops-27-1.ts";
import type { UnwindTrigger } from "../closing/ops-26-3.ts";
import { SERVICER_CONTACT } from "../../runtime/servicing.ts";
import { productFacts, lockStatus, trustPoaGate, decisionStatus, templateVersionGate, eclosingFacts, dollars, custodialAccountIdFor, executionReviewUnrecoverable } from "./facts-35-6-b.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { wetPreSigningFunding } from "./steps-35-6-e.ts";

type Row = Record<string, unknown>;
const exitOn = (type: string, pred?: (p: Row) => boolean) => (rec: OrchRecord): DomainEvent | null => rec.last(type, pred);
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const DISCLOSURE = { kind: "agent", id: "disclosure" } as const;
const COMPLIANCE = { kind: "agent", id: "compliance-tester" } as const;
const VERIFICATION = { kind: "agent", id: "verification" } as const;
const CLOSER = { kind: "agent", id: "title-closing" } as const;
const FUNDER = { kind: "agent", id: "funder" } as const;
export const WAREHOUSE = { kind: "agent", id: "warehouse" } as const;
const POST_CLOSING = { kind: "agent", id: "post-closing" } as const;
const ESCROW = { kind: "agent", id: "escrow" } as const;
const S = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const civil = (rec: OrchRecord, iso: string): string => rec.civilDate(iso);
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
/** 25.1's AprCalculation with its cents as bigints (the compliance snapshot is taken raw off the bus input; a stored row carries strings). */
const aprBig = (a: Row): Row => ({ ...a, ...Object.fromEntries(["amount_financed_cents", "prepaid_finance_charges_cents", "prepaid_interest_cents", "finance_charge_cents", "total_of_payments_cents", "total_interest_cents", "loan_amount_cents"].filter((k) => a[k] !== undefined && a[k] !== null).map((k) => [k, cents(a[k])])) });
/** The funding id and the closing id are the application's (one funding per orchestration). */
export const fundingIdOf = (rec: OrchRecord): string => S(rec.payload("funding.requested")?.["funding_id"]) ?? `F-${rec.app.id.slice(0, 8)}`;
const advanceIdOf = (rec: OrchRecord): string => `ADV-${rec.app.id.slice(0, 8)}`;
const UNWIND_TRIGGERS: readonly UnwindTrigger[] = ["rescission_exercised_pre_disbursement", "rescission_exercised_post_disbursement", "conditions_failed", "documents_not_returned", "agent_failed_to_disburse", "fraud", "borrower_withdrew", "partner_hold"];
const cdIdOf = (rec: OrchRecord, version: number): string => `CD-${rec.app.id.slice(0, 8)}-${version}`;

// ───────────────────────────── shared readers the steps use ─────────────────────────────
function needClosing(rec: OrchRecord): ClosingFacts { const c = closingFacts(rec); if (!c) throw new RecordGap("closing.scheduled", "no closing scheduled (26.2 through 32.7)"); return c; }
/** 26.3's funding calendar for the scheduled slot (a read: no funding opened yet) — the disbursement date the CD, the APR and the note terms are computed against. */
type Calendar = { funding_type: string; scheduled_funding_date: string; earliest_funding_date: string; rescission_expires_on: string | null };
const CALENDARS = new WeakMap<StepContext, Map<string, Promise<Calendar>>>();
/** 26.3's funding calendar, read once per pass and closing (the read is the owner's `computeDates{op: read}`). */
async function calendar(ctx: StepContext, closing: ClosingFacts): Promise<Calendar> {
  let m = CALENDARS.get(ctx); if (!m) { m = new Map(); CALENDARS.set(ctx, m); }
  let c = m.get(closing.closing_id); if (!c) { c = calendarRead(ctx, closing); m.set(closing.closing_id, c); }
  return c;
}
async function calendarRead(ctx: StepContext, closing: ClosingFacts): Promise<Calendar> {
  const rec = ctx.rec;
  const opened = rec.payload("funding.requested");
  if (opened) return { funding_type: String(opened["funding_type"]), scheduled_funding_date: String(opened["disbursement_date"] ?? opened["scheduled_funding_date"]), earliest_funding_date: String(opened["earliest_funding_date"]), rescission_expires_on: S(opened["rescission_expires_at"])?.slice(0, 10) ?? null };
  const cal = await ctx.run<Row>({ process: "26.3", name: "computeDates", actor: FUNDER, input: { state: closing.state, transaction_type: rec.app.transaction_type ?? "limited_cash_out", time_zone: closing.time_zone, consummation_at: closing.scheduled_at, closing_date: closing.scheduled_note_date, rescindable: closing.rescindable }, detail: { sources: { closing: src("entity", `closings:${closing.row.id}:${closing.row.version}`, "26.2") }, read: true } });
  return { funding_type: String(cal["funding_type"]), scheduled_funding_date: String(cal["scheduled_funding_date"]), earliest_funding_date: String(cal["earliest_funding_date"]), rescission_expires_on: S(cal["rescission_expires_on"]) };
}

// ───────────────────────────── closing_scheduled: the CD (T4) ─────────────────────────────
const closingScheduled: StepDef = {
  name: "closing_scheduled",
  exit: exitOn("disclosure.cd.waiting_period.computed", (p) => p["earliest_consummation_date"] !== undefined && p["earliest_consummation_date"] !== null),
  clocked: () => true,
  actions: async (ctx) => {
    let rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now;
    let cd = cdRow(rec);
    if (!cd) {
      const terms = loanTerms(rec); const parties = await partyFacts(rec, closing); const escrow = escrowFacts(rec);
      if (!escrow) throw new RecordGap("30.3", "no approved initial escrow analysis on the record (30.3's frozen analysis is the CD's escrow figure source)");
      const title = rec.entities("title_orders").at(-1); if (!title) throw new RecordGap("title_orders", "no title order (24.4) — the settlement agent's figure source");
      const cal = await calendar(ctx, closing);
      const version = 1; const disclosureId = cdIdOf(rec, version);
      const saSource = `SRC-SA-${rec.app.id.slice(0, 8)}`; const escrowSource = `SRC-ESCROW-${rec.app.id.slice(0, 8)}`; const creditorSource = `SRC-CREDITOR-${rec.app.id.slice(0, 8)}`;
      // 25.2's figure sources: the settlement agent's quote against 24.4's title order, 30.3's frozen analysis, the creditor's own lines as the LE disclosed them
      const quote = ctx.fakes.settlementAgent.feeQuote(title.id, now);
      if (!rec.entities("cd_figure_sources", (d) => d["source_id"] === saSource).length) await ctx.run({ process: "25.2", name: "assembleCdFigures", actor: DISCLOSURE, input: { op: "record_source", source_id: saSource, party: "settlement_agent", payload: { fees: quote.fees }, payload_document_id: title.id }, detail: { sources: { title_order: src("entity", `title_orders:${title.id}:${title.version}`, "24.4"), quote: src("platform", `FAKE settlement agent fee quote against title_orders:${title.id}`, "35.6") } } });
      if (!rec.entities("cd_figure_sources", (d) => d["source_id"] === escrowSource).length) await ctx.run({ process: "25.2", name: "assembleCdFigures", actor: DISCLOSURE, input: { op: "record_source", source_id: escrowSource, party: "escrow", payload: { monthly_cents: String(escrow.monthly_escrow_cents), deposit_cents: String(escrow.initial_escrow_payment_cents) }, payload_document_id: escrow.analysis.id }, detail: { sources: { escrow_analysis: escrow.source } } });
      const creditor = creditorFeeLines(rec, creditorSource);
      if (!rec.entities("cd_figure_sources", (d) => d["source_id"] === creditorSource).length) await ctx.run({ process: "25.2", name: "assembleCdFigures", actor: DISCLOSURE, input: { op: "record_source", source_id: creditorSource, party: "creditor", payload: { fees: creditor.value.map((f) => ({ fee_code: f.fee_code, amount_cents: f.amount_cents })) } }, detail: { sources: { le_fees: creditor.source } } });
      // the note terms and the prepaid interest are 26.1's and 26.3's own computations
      const note = await ctx.run<Row>({ process: "26.1", name: "computeNoteTerms", actor: CLOSER, input: { principal_cents: String(terms.loan_amount_cents.value), note_rate_pct: terms.note_rate_pct.value, term_months: terms.term_months, scheduled_disbursement_date: cal.scheduled_funding_date, state: closing.state }, detail: { sources: sources({ principal_cents: terms.loan_amount_cents, note_rate_pct: terms.note_rate_pct }), read: true } });
      const interest = await ctx.run<Row>({ process: "26.3", name: "decideInterestMode", actor: FUNDER, input: { disbursement_date: cal.scheduled_funding_date, gross_loan_cents: String(terms.loan_amount_cents.value), note_rate_pct: terms.note_rate_pct.value, note_first_payment_date: String(note["first_payment_date"]) }, detail: { sources: sources({ gross_loan_cents: terms.loan_amount_cents, note_rate_pct: terms.note_rate_pct }) } });
      const prepaid = cents(interest["prepaid_interest_cents"]); const perDiem = cents(interest["per_diem_cents"]); const prepaidDays = Number(interest["prepaid_days"] ?? 0); const product = productFacts(rec, terms);
      const payoffs = payoffFacts(rec); const ftc = fundsToClose(rec);
      const fees: Row[] = [...creditor.value.map((f) => ({ ...f })), ...quote.fees.map((f) => ({ fee_code: f.fee_code, description: f.fee_code === "title_lender_policy" ? "Title — Lender's policy" : f.fee_code === "settlement_fee" ? "Title — Settlement fee" : "Recording fees", amount_cents: f.amount_cents, section: f.fee_code === "recording" ? "E_taxes_gov" : "C_can_shop", tolerance_class: "ten_percent", source_id: saSource })),
        { fee_code: "prepaid_interest", description: `Prepaid interest ($${dollars(perDiem)} per day, ${prepaidDays} days from ${cal.scheduled_funding_date})`, amount_cents: String(prepaid), section: "F_prepaids", tolerance_class: "unlimited", source_id: creditorSource },
        { fee_code: "escrow_deposit", description: "Initial escrow payment at closing", amount_cents: String(escrow.initial_escrow_payment_cents), section: "G_initial_escrow", tolerance_class: "unlimited", source_id: escrowSource }];
      await ctx.run({ process: "25.2", name: "reconcileFigureSources", actor: DISCLOSURE, input: { fees }, detail: { sources: { settlement_agent: src("entity", `cd_figure_sources:${saSource}`, "25.2"), escrow: src("entity", `cd_figure_sources:${escrowSource}`, "25.2"), creditor: src("entity", `cd_figure_sources:${creditorSource}`, "25.2") } } });
      // 25.1: the finance-charge classification over the CD's lines and the APR at the cd checkpoint
      const items = fees.filter((f) => f["fee_code"] !== "escrow_deposit").map((f) => ({ fee_item_id: `${disclosureId}:${f["fee_code"]}`, service_code: f["fee_code"] === "prepaid_interest" ? "interest_prepaid" : String(f["fee_code"]), description: String(f["description"]), amount_cents: String(f["amount_cents"]), paid_to: String(f["source_id"]).startsWith("SRC-SA") ? parties.settlement_agent_name : parties.partner_legal_name, paid_to_kind: String(f["source_id"]).startsWith("SRC-SA") ? (f["fee_code"] === "recording" ? "public_official" : "third_party") : "creditor" }));
      const cls = await ctx.run<Row>({ process: "25.1", name: "classifyFinanceCharges", actor: COMPLIANCE, input: { items, state: closing.state }, detail: { sources: { fees: creditor.source } } });
      const apr = await ctx.run<Row>({ process: "25.1", name: "computeApr", actor: COMPLIANCE, input: { loan_amount_cents: String(terms.loan_amount_cents.value), note_rate_pct: terms.note_rate_pct.value, term_months: terms.term_months, term_start_date: cal.scheduled_funding_date, first_payment_date: String(note["first_payment_date"]), prepaid_finance_charges_cents: String(cls["prepaid_finance_charges_cents"]), prepaid_interest_cents: String(prepaid), checkpoint: "cd" }, detail: { sources: sources({ loan_amount_cents: terms.loan_amount_cents, note_rate_pct: terms.note_rate_pct }) } });
      const rendered = await ctx.run<Row>({ process: "25.2", name: "renderCd", actor: DISCLOSURE, input: { disclosure_id: disclosureId, cd_version: version, transaction_type: rec.app.transaction_type === "purchase" ? "purchase" : "refinance", state: closing.state, required_consumer_ids: parties.borrower_ids,
        loan: { loan_amount_cents: String(terms.loan_amount_cents.value), rate_pct: terms.note_rate_pct.value, term_months: terms.term_months, pi_cents: String(note["pi_cents"] ?? terms.pi_cents.value), product: product.cd_product, loan_type: product.loan_type, purpose: rec.app.transaction_type === "purchase" ? "Purchase" : "Refinance", prepayment_penalty: product.prepayment_penalty, balloon: product.balloon, arm: product.amortization === "arm", loan_id_number: rec.app.id, mic_number: null, first_payment_date: String(note["first_payment_date"]), maturity_date: String(note["maturity_date"]) },
        apr: { apr_calculation_id: apr["apr_calculation_id"], apr_pct: apr["apr_disclosed_str"], finance_charge_cents: String(apr["finance_charge_cents"]), amount_financed_cents: String(apr["amount_financed_cents"]), total_of_payments_cents: String(apr["total_of_payments_cents"]), tip_pct: String(Number(apr["tip_pct"]).toFixed(3)) },
        fees, escrow: { established: true, monthly_escrow_cents: String(escrow.monthly_escrow_cents), initial_escrow_payment_cents: String(escrow.initial_escrow_payment_cents), escrowed_costs_year1_cents: String(escrow.escrowed_costs_year1_cents), non_escrowed_costs_year1_cents: String(escrow.non_escrowed_costs_year1_cents) },
        parties: { borrowers: parties.borrower_names, creditor_name: parties.partner_legal_name, creditor_nmlsr_id: parties.partner_nmlsr_id, mlo_name: parties.mlo_name, mlo_nmlsr_id: parties.mlo_nmlsr_id, settlement_agent_name: parties.settlement_agent_name, settlement_agent_license_id: parties.settlement_agent_license },
        dates: { date_issued: civil(rec, now), closing_date: closing.scheduled_note_date, disbursement_date: cal.scheduled_funding_date }, property_address: parties.property_address, cash_to_close_cents: String(ftc.cash_to_close_cents < 0n ? 0n : ftc.cash_to_close_cents), lender_credits_cents: String(terms.lender_credit_cents.value), payoffs_and_payments_cents: String(payoffs.total_cents), rescindable: closing.rescindable },
        detail: { sources: { ...sources({ loan_amount_cents: terms.loan_amount_cents, note_rate_pct: terms.note_rate_pct, lender_credits_cents: terms.lender_credit_cents }), escrow: escrow.source, payoffs: payoffs.source, cash_to_close: ftc.computed ? src("event", `funds_to_close.computed:${ftc.computed.id}`, "22.4") : src("derived", "no 22.4 worksheet", "22.4"), title_order: src("entity", `title_orders:${title.id}:${title.version}`, "24.4"), ...parties.sources }, cd_version: version } });
      // 35.2: the rendered CD is a documents row with a sha256 over its figures
      const docId = await storeDocument(ctx.rt.db, { kind: "closing_disclosure", application_id: rec.app.id, loan_id: null, text: JSON.stringify({ disclosure_id: disclosureId, figures_hash: rendered["figures_hash"], checklist: rendered["checklist"], fees, escrow: { monthly_escrow_cents: String(escrow.monthly_escrow_cents), initial_escrow_payment_cents: String(escrow.initial_escrow_payment_cents) } }), retention_class: "regz_cd_5y", source: `25.2 renderCd ${disclosureId}`, now });
      ctx.journal.push({ step: "closing_scheduled", kind: "waiting", waiting_on: null, detail: { document_id: docId, disclosure_id: disclosureId, kind: "closing_disclosure" } });
      // 25.1's CD checkpoint gate over the record's snapshot (the gate run the delivery cites; a blocked gate holds the row)
      const consents = await esignConsents(rec); const rateSet = civil(rec, terms.lock.occurredAt); const highCost = rec.payload("compliance.high_cost.determined");
      const primaryConsent = consents[parties.borrower_ids[0]!] ?? null;
      const consentRow = primaryConsent ? (await rec.q.query<{ scope: string[] | null; captured_at: string; revoked_at: string | null; hw_sw_version: string | null; verified: boolean }>(`SELECT scope, captured_at::text AS captured_at, revoked_at::text AS revoked_at, hw_sw_version, verified FROM consents WHERE id = $1`, [primaryConsent.consent_id]))[0] : undefined;
      await ctx.run({ process: "25.2", name: "assertGateOpen", actor: COMPLIANCE, input: { gate: "SM_O61_COMPLIANCE_PASS_CD_GATE", disclosure_id: disclosureId, snapshot: { application_id: rec.app.id, as_of: civil(rec, now), property_state: closing.state, property_county: parties.county, lien_position: "first", occupancy: rec.app.occupancy === "primary" ? "primary" : rec.app.occupancy ?? "primary", loan_amount_cents: terms.loan_amount_cents.value, note_rate_pct: terms.note_rate_pct.value, term_months: terms.term_months, rate_set_date: rateSet,
        apr: { actual: aprBig(apr), disclosed_apr: apr["apr_disclosed_str"], disclosed_finance_charge_cents: cents(apr["finance_charge_cents"]), transaction: { irregular_first_period: true } }, fees: { items: items.map((f) => ({ ...f, amount_cents: cents(f.amount_cents) })), benchmarks: [] }, escrow_established: true, jurisdiction: { high_cost_statute: S((highCost?.["state_tests"] as Row[] | undefined)?.[0]?.["statute"]) },
        esign: { consent: consentRow ? { kind: "esign", granted_at: consentRow.captured_at, withdrawn_at: consentRow.revoked_at, scope: esignDisclosureClasses(consentRow.scope), hw_sw_statement_version: consentRow.hw_sw_version ?? "", access_demonstrated: consentRow.verified } : null, delivery_channel: consentRow ? "electronic" : "paper", delivery_at: now, disclosure_class: "cd" } } },
        detail: { sources: { ...sources({ loan_amount_cents: terms.loan_amount_cents, note_rate_pct: terms.note_rate_pct }), lock: src("event", `lock.executed:${terms.lock.id}`, "21.4"), esign: primaryConsent?.source ?? src("derived", "no E-SIGN consent", "32.2") } } });
      rec = await ctx.refresh(); cd = cdRow(rec);
      if (!cd) throw new RangeError(`25.2 renderCd left no disclosures row for ${disclosureId}`);
    }
    // 22.4 R8: the worksheet reconciled to the CD's cash to close (`funds_to_close.reconciled`, the figure 26.1's doc-gen gate and 26.3's funding conditions read); a variance is 22.4's to route to 25.2 — the worksheet never overrides the CD
    {
      const ftcNow = fundsToClose(rec); const cdFig = (cd.data["figures"] as Row | undefined) ?? {};
      if (ftcNow.computed && !rec.has("funds_to_close.reconciled", (p) => p["cd_disclosure_id"] === cd!.id) && !rec.has("funds_to_close.variance", (p) => p["cd_disclosure_id"] === cd!.id)) {
        await ctx.run({ process: "22.4", name: "reconcileToCd", actor: VERIFICATION, input: { worksheet_id: String(ftcNow.computed.payload["worksheet_id"] ?? ""), cd_disclosure_id: cd.id, cd_version: Number(cd.data["cd_version"] ?? 1), cd_cash_to_close_cents: String(cdFig["cash_to_close_cents"] ?? ftcNow.cash_to_close_cents), cd_lines: [], worksheet_lines: [] }, detail: { sources: { worksheet: src("event", `funds_to_close.computed:${ftcNow.computed.id}`, "22.4"), cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2") } } });
        rec = await ctx.refresh(); cd = cdRow(rec)!;
      }
    }
    // delivery per consumer under the consumer's own E-SIGN consent — a consumer without one gets the printed CD (mailed the same day, the mailbox rule)
    const disclosureId = cd.id; const consents = await esignConsents(rec); const receipts = cdReceipts(rec, disclosureId);
    const required = (cd.data["required_consumer_ids"] as string[] | undefined) ?? rec.borrowerIds();
    for (const consumer of required) {
      if (receipts.some((r) => r.data["consumer_id"] === consumer)) continue;
      const consent = consents[consumer];
      if (consent) await ctx.run({ process: "25.2", name: "deliverDisclosure", actor: DISCLOSURE, input: { disclosure_id: disclosureId, consumer_id: consumer, channel: "esign_portal", at: now, esign_consent_id: consent.consent_id }, detail: { sources: { esign_consent: consent.source }, consumer_id: consumer, channel: "esign_portal" } });
      else { const m = ctx.fakes.printMail.mail(disclosureId, consumer, now); await ctx.run({ process: "25.2", name: "deliverDisclosure", actor: DISCLOSURE, input: { disclosure_id: disclosureId, consumer_id: consumer, channel: "mail", at: m.mailed_at, mailing_proof_id: m.mailing_proof_id }, detail: { sources: { esign_consent: src("derived", `no consents{kind: esign} row for ${consumer}`, "32.2"), mailing_proof: src("platform", `FAKE print/mail ${m.mailing_proof_id}`, "35.6") }, consumer_id: consumer, channel: "mail" } }); }
    }
    rec = await ctx.refresh();
    // the receipts are the consumers' acknowledgements (32.7 → 25.2 recordReceipt) or the mailbox rule's deemed date (25.2 deems on the presumption date); the waiting period is computed once every required consumer has an effective receipt
    const rs = cdReceipts(rec, disclosureId);
    const missing = required.filter((c) => !rs.some((r) => r.data["consumer_id"] === c && r.data["effective_receipt_date"]));
    if (missing.length) {
      const deemable = rs.filter((r) => missing.includes(String(r.data["consumer_id"])) && r.data["presumed_receipt_date"] && String(r.data["presumed_receipt_date"]) <= civil(rec, now) && !r.data["receipt_evidence"]);
      if (deemable.length) { await ctx.run({ process: "25.2", name: "computeEarliestConsummation", actor: DISCLOSURE, input: { op: "deem", disclosure_id: disclosureId, today: civil(rec, now) }, detail: { deemed: deemable.map((r) => r.id) } }); rec = await ctx.refresh(); }
      const still = required.filter((c) => !cdReceipts(rec, disclosureId).some((r) => r.data["consumer_id"] === c && r.data["effective_receipt_date"]));
      // a consumer whose printed CD is in the mail is the mailbox rule's clock (§1026.19(f)(1)(iii): received 3 business days after mailing) — a window, not the borrower; every other consumer is the borrower's acknowledgement
      const mailed = still.filter((c) => cdReceipts(rec, disclosureId).some((r) => r.data["consumer_id"] === c && r.data["presumed_receipt_date"] && !r.data["receipt_evidence"]));
      if (still.length) return { wait: mailed.length === still.length ? { status: "waiting_window", waiting_on: "REGZ_1026_19F1_CD_MAILBOX_RULE", clocked: true } : { status: "waiting_borrower", waiting_on: "borrower", clocked: false } };
    }
    if (!rec.has("disclosure.cd.waiting_period.computed", (p) => p["disclosure_id"] === disclosureId && p["earliest_consummation_date"] !== null && p["earliest_consummation_date"] !== undefined)) await ctx.run({ process: "25.2", name: "computeEarliestConsummation", actor: DISCLOSURE, input: { disclosure_id: disclosureId }, detail: { sources: { receipts: src("entity", `cd_receipts:${cdReceipts(rec, disclosureId).map((r) => r.id).join(",")}`, "25.2") } } });
    return {};
  },
};

// ───────────────────────────── cd_delivered: the refresh, the gate, the documents (T5) ─────────────────────────────
const cdDelivered: StepDef = {
  name: "cd_delivered",
  exit: exitOn("closing.documents.released"),
  // the CD's waiting period (25.2's gate) holds the step until the earliest consummation date; the refresh and the documents run inside it as their own windows open
  entryWait: () => ({ status: "waiting_window", waiting_on: "REGZ_1026_19F1_CD_3SBD_GATE", clocked: false }),
  clocked: () => true,
  actions: async (ctx) => {
    let rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now; const today = civil(rec, now);
    const terms = loanTerms(rec); const cd = cdRow(rec); if (!cd) throw new RecordGap("disclosures{kind: cd}", "no CD on the record");
    // 22.2's soft refresh inside the pre-closing window (22.2's own rule: refreshWindowStart on the creditor calendar); the gate is 22.2's to assert
    const refreshed = rec.entities("credit_reports", (d) => d["report_type"] === "soft_refresh" || d["report_type"] === "udm_snapshot").length > 0;
    if (!refreshed) {
      const cal = await calendar(ctx, closing);
      const windowStart = refreshWindowStart(D(closing.scheduled_note_date));
      if (today < windowStart) return { wait: { status: "waiting_window", waiting_on: today < String(rec.payload("disclosure.cd.waiting_period.computed")?.["earliest_consummation_date"] ?? today) ? "REGZ_1026_19F1_CD_3SBD_GATE" : "SM_CREDIT_REFRESH_PRECLOSE_GATE", clocked: false } };
      const f = await creditOrderFacts(rec); if (!f) throw new RecordGap("credit_authorizations", "the refresh needs the partner's credit authorization facts (22.2)");
      await ctx.run({ process: "22.2", name: "orderRefresh", actor: VERIFICATION, input: { permissible_purpose: f.permissible_purpose.value, certification_ref: f.certification_ref.value, borrower_authorization_ref: f.borrower_authorization_ref.value, subscriber_code: f.subscriber_code.value, scheduled_consummation_date: closing.scheduled_note_date, at: now }, detail: { sources: sources({ permissible_purpose: f.permissible_purpose, certification_ref: f.certification_ref, borrower_authorization_ref: f.borrower_authorization_ref, subscriber_code: f.subscriber_code }), scheduled_consummation_date: closing.scheduled_note_date, disbursement_date: cal.scheduled_funding_date } });
      // a vendor order ends the row's pass: 22.2's compare raises `credit.udm.alert.received` for new tradelines, triaged by people (22.2 R9) — the gate is asserted over the received report on the next pass
      return { wait: { status: "open", waiting_on: "SM_CREDIT_REFRESH_PRECLOSE_GATE", clocked: true } };
    }
    await ctx.run({ process: "22.2", name: "orderRefresh", actor: VERIFICATION, input: { op: "assert_gate", scheduled_consummation_date: closing.scheduled_note_date }, detail: { gate: "SM_CREDIT_REFRESH_PRECLOSE_GATE", read: true } });
    // 25.2's CD 3-SBD gate for the scheduled date; 22.4's cash-to-close reconciliation and 23.3's CTC gate read from the record
    await ctx.run({ process: "25.2", name: "assertGateOpen", actor: DISCLOSURE, input: { gate: "REGZ_1026_19F1_CD_3SBD_GATE", requested_on: closing.scheduled_note_date }, detail: { gate: "REGZ_1026_19F1_CD_3SBD_GATE", requested_on: closing.scheduled_note_date, read: true } });
    const ftc = fundsToClose(rec); const ctc = rec.last("clear_to_close.issued", (p) => p["passed"] === true);
    if (!ctc) throw new RecordGap("clear_to_close.issued", "23.3's CTC is not on the record");
    if (!ftc.reconciled) throw new RecordGap("funds_to_close.reconciled", "22.4 has not reconciled the cash to close to the CD");
    // 30.3: the approved initial analysis freezes against the delivered CD version (`escrow.initial_analysis.frozen{cd_version_id}`) — the row the statement, the closing package and 30.2's hand-off read — as `escrow`
    const approvedAnalysis = rec.entities("escrow_analyses", (d) => d["source"] === "origination" && (d["status"] === "approved" || d["status"] === "disclosed_on_cd")).at(-1);
    if (approvedAnalysis && !rec.entities("escrow_analyses", (d) => d["source"] === "origination" && d["status"] === "frozen").length) {
      await ctx.run({ process: "30.3", name: "buildEscrowLines", actor: ESCROW, input: { op: "freeze", application_id: rec.app.id, analysis_id: approvedAnalysis.id, cd_version_id: cd.id }, detail: { sources: { analysis: src("entity", `escrow_analyses:${approvedAnalysis.id}:${approvedAnalysis.version}`, "30.3"), cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2") } } });
      rec = await ctx.refresh();
    }
    // 26.1: the note terms, the doc-gen gates, the snapshot, the render, the eNote, the QC and the release — as title-closing
    const parties = await partyFacts(rec, closing); const escrow = escrowFacts(rec); const cal = await calendar(ctx, closing);
    const setId = `SET-${rec.app.id.slice(0, 8)}-1`;
    // 26.1's doc-gen gate facts, each from its owner: the final CD delivered (25.2's delivery / waiting-period events for this CD), the PTD conditions cleared (23.3's CTC carries CTC_PTD_ALL_CLEARED), 24.4's trust/POA review gate, 25.1's CD compliance gate, 21.4's lock status and expiry
    const cdDelivered = rec.last("disclosure.cd.delivered", (p) => p["disclosure_id"] === cd.id) ?? rec.last("disclosure.cd.waiting_period.computed", (p) => p["disclosure_id"] === cd.id);
    const trustPoa = trustPoaGate(rec); const lockSt = lockStatus(rec, terms);
    const gate = { final_cd_delivered: !!cdDelivered, approval_ptd_cleared: ctc.payload["passed"] === true, trust_poa_gate_open: trustPoa.value, compliance_pass_cd_gate_open: rec.has("compliance.gate.opened", (p) => p["gate"] === "cd"), lock_status: lockSt.value, lock_expires_on: terms.lock_expires_on, closing_date: closing.scheduled_note_date };
    const gateSources = { final_cd_delivered: cdDelivered ? src("event", `${cdDelivered.type}:${cdDelivered.id}`, "25.2") : src("derived", `no delivery of CD ${cd.id} on the record`, "25.2"), approval_ptd_cleared: src("event", `clear_to_close.issued:${ctc.id}`, "23.3"), trust_poa_gate_open: trustPoa.source, lock_status: lockSt.source, compliance_pass_cd_gate_open: src("event", `compliance.gate.opened:${rec.last("compliance.gate.opened", (p) => p["gate"] === "cd")?.id ?? ""}`, "25.1"), lock: src("event", `lock.executed:${terms.lock.id}`, "21.4"), cash_to_close: src("event", `funds_to_close.reconciled:${ftc.reconciled!.id}`, "22.4") };
    const set = rec.entities("closing_document_sets").at(-1);
    const terms26 = await ctx.run<Row>({ process: "26.1", name: "computeNoteTerms", actor: CLOSER, input: { principal_cents: String(terms.loan_amount_cents.value), note_rate_pct: terms.note_rate_pct.value, term_months: terms.term_months, scheduled_disbursement_date: cal.scheduled_funding_date, state: closing.state }, detail: { sources: sources({ principal_cents: terms.loan_amount_cents, note_rate_pct: terms.note_rate_pct }), read: true } });
    if (!set) await ctx.run({ process: "26.1", name: "evaluateDocGenGates", actor: CLOSER, input: { set_id: setId, gate }, detail: { sources: gateSources } });
    rec = await ctx.refresh();
    const setRow = rec.entities("closing_document_sets").at(-1)!;
    const min = S(rec.payload("closing.scheduled")?.["min"]) ?? S(rec.entities("mers_registrations").at(-1)?.data["min"]);
    if (!setRow.data["snapshot_id"]) {
      const cdFigures = (cd.data["figures"] as Row | undefined) ?? {};
      // the servicer is the platform's own contact record (SERVICER_CONTACT, the one 30.2 boards); the vesting is 24.4's title commitment; the product is 21.4's lock; the eClosing flags are 26.2's decision and rows
      const product = productFacts(rec, terms); const titleVesting = (rec.last("title.commitment.received")?.payload["vesting"] as Row | undefined) ?? null; const eclosing = eclosingFacts(rec, closing);
      const vestingNames = ((titleVesting?.["names"] as unknown[] | undefined) ?? []).map(String);
      const snapshot: Row = { application_id: rec.app.id, cd_version: Number(cd.data["cd_version"] ?? 1), du_submission_number: String(rec.payload("du.findings.received")?.["submission_number"] ?? "1"), lock_id: String(terms.lock.payload["lock_id"]), partner: { legal_name: parties.partner_legal_name, nmlsr_id: parties.partner_nmlsr_id, mers_org_id: parties.partner_mers_org_id ?? "" }, mlo_of_record: { name: parties.mlo_name, nmlsr_id: parties.mlo_nmlsr_id }, servicer: { name: SERVICER_CONTACT.servicer_name, payment_address: SERVICER_CONTACT.servicer_address },
        state: closing.state, county: parties.county ?? "", property_address: parties.property_address, legal_description: parties.legal_description ?? parties.property_address, transaction_type: rec.app.transaction_type ?? "limited_cash_out", occupancy: rec.app.occupancy ?? "primary", property_type: rec.propertyType() ?? "sfr", units: rec.subject?.units ?? 1, vesting: titleVesting?.["trust"] === true ? "trust" : "individual", vesting_text: vestingNames.length ? vestingNames.join(" and ") : parties.borrower_names.join(" and "),
        borrowers: parties.borrower_ids.map((id, k) => ({ party_id: id, legal_name: parties.borrower_names[k], credit_used: true, on_title: true, capacities: ["borrower"] })),
        loan_amount_cents: String(terms.loan_amount_cents.value), note_rate_pct: terms.note_rate_pct.value, term_months: terms.term_months, product: product.amortization, note_date: closing.scheduled_note_date, scheduled_disbursement_date: cal.scheduled_funding_date, scheduled_closing_date: closing.scheduled_note_date, escrowed: !!escrow, rescindable: closing.rescindable,
        ...eclosing.facts, ...(min ? { min } : {}) };
      // the MIN: the record's when 26.2/26.4 already carry one; otherwise 26.1 allocates it (generateMin) from a sequence unique to this application — the application id's leading hex as a 10-digit sequence, never the tool's default of 1
      const minSequence = min ? null : String(1_000_000_000n + (BigInt(`0x${rec.app.id.replace(/-/g, "").slice(0, 12)}`) % 8_999_999_999n));
      await ctx.run({ process: "26.1", name: "takeClosingSnapshot", actor: CLOSER, input: { set_id: setId, snapshot, gate, ...(minSequence ? { min_sequence: minSequence } : {}) }, detail: { sources: { ...gateSources, cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2"), closing: src("entity", `closings:${closing.row.id}:${closing.row.version}`, "26.2"), ...parties.sources, product: product.source, vesting: titleVesting ? src("event", `title.commitment.received:${rec.last("title.commitment.received")!.id}`, "24.4") : src("derived", "no title commitment; individual vesting from the borrowers", "24.4"), ...eclosing.sources, min: min ? src("event", "closing.scheduled / mers_registrations", "26.2") : src("derived", `MIN sequence ${minSequence} allocated from the application id (26.1 generateMin)`, "26.1") }, cd_figures: cdFigures["loan_amount_cents"] ?? null } });
    }
    if (!(setRow.data["documents"] as unknown[] | undefined)?.length) await ctx.run({ process: "26.1", name: "renderDocument", actor: CLOSER, input: { set_id: setId }, detail: { set_id: setId } });
    rec = await ctx.refresh();
    const docs = (rec.entities("closing_document_sets").at(-1)!.data["documents"] as Row[] | undefined) ?? [];
    if (closing.note_form === "enote" && !rec.entities("closing_documents", (d) => d["kind"] === "enote" && d["smart_doc"] !== undefined).length) await ctx.run({ process: "26.1", name: "buildSmartDocENote", actor: CLOSER, input: { set_id: setId }, detail: { set_id: setId } });
    if (!rec.has("closing.document_qc.passed")) {
      const cdF = (cd.data["figures"] as Row | undefined) ?? {}; const du = rec.payload("du.findings.received"); const ulad = rec.entities("du_requests").at(-1)?.data ?? {};
      const upstream = { cd: { loan_amount_cents: String(cdF["loan_amount_cents"] ?? terms.loan_amount_cents.value), note_rate_pct: String(cdF["rate_pct"] ?? terms.note_rate_pct.value), pi_cents: String(cdF["pi_cents"] ?? terms26["pi_cents"]), org_nmlsr_id: parties.partner_nmlsr_id, mlo_nmlsr_id: parties.mlo_nmlsr_id, first_payment_date: String(terms26["first_payment_date"]) }, du: { loan_amount_cents: String(du?.["loan_amount_cents"] ?? terms.loan_amount_cents.value), note_rate_pct: String(du?.["note_rate_pct"] ?? terms.note_rate_pct.value), term_months: terms.term_months }, lock: { note_rate_pct: terms.note_rate_pct.value }, title: { vesting_text: parties.borrower_names.join(" and "), legal_description: parties.legal_description ?? parties.property_address }, urla_1003: { org_nmlsr_id: parties.partner_nmlsr_id, mlo_nmlsr_id: parties.mlo_nmlsr_id, loan_amount_cents: String(ulad["loan_amount_cents"] ?? terms.loan_amount_cents.value), note_rate_pct: String(ulad["note_rate_pct"] ?? terms.note_rate_pct.value), term_months: terms.term_months }, note_date: closing.scheduled_note_date };
      await ctx.run({ process: "26.1", name: "runDocumentQc", actor: CLOSER, input: { set_id: setId, upstream }, detail: { sources: { cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2"), du: du ? src("event", `du.findings.received:${rec.last("du.findings.received")!.id}`, "23.1") : src("derived", "no findings", "23.1"), lock: src("event", `lock.executed:${terms.lock.id}`, "21.4"), title: src("event", `title.commitment.received:${rec.last("title.commitment.received")?.id ?? ""}`, "24.4") } } });
      rec = await ctx.refresh();
    }
    const qc = rec.last("closing.document_qc.passed"); if (!qc) return { hold: { reason: "gate_closed", gate: "SM_O71_DOC_QC_PASS_GATE", detail: { set_id: setId, documents: docs.length } } };
    await ctx.run({ process: "26.1", name: "releaseToSettlementAgent", actor: CLOSER, input: { set_id: setId, released_to_party_id: closing.settlement_agent_party_id, facts: { qc_pass_gate_open: true, template_version_gate_open: templateVersionGate(rec, setId).value } }, detail: { sources: { qc: src("event", `closing.document_qc.passed:${qc.id}`, "26.1"), template_version: templateVersionGate(rec, setId).source, settlement_agent: src("entity", `closings:${closing.row.id}:${closing.row.version}`, "26.2") } } });
    return {};
  },
};

/** 25.1's checkpoint snapshot as the record carries it (the loan, the lock's rate-set date, the CD's APR calculation); 25.2's gate reuses the owner's own fresh run over the full snapshot (GATES[...].freshness_hours) and re-derives over this one otherwise. */
function recordSnapshot(rec: OrchRecord, closing: ClosingFacts, now: string, terms: ReturnType<typeof loanTerms>, apr: EntityRecord, cd: EntityRecord): Row {
  return { application_id: rec.app.id, as_of: civil(rec, now), property_state: closing.state, lien_position: productFacts(rec, terms).lien_position, loan_amount_cents: terms.loan_amount_cents.value, note_rate_pct: terms.note_rate_pct.value, term_months: terms.term_months, rate_set_date: civil(rec, terms.lock.occurredAt), apr: { actual: aprBig(apr.data), disclosed_apr: String((cd.data["figures"] as Row | undefined)?.["apr_pct"] ?? apr.data["apr_disclosed_str"]), disclosed_finance_charge_cents: cents(apr.data["finance_charge_cents"]), transaction: { irregular_first_period: true } }, escrow_established: true };
}
// ───────────────────────────── documents_released → consummated: the RON session (T6) ─────────────────────────────
function notaryOf(ctx: StepContext, closing: ClosingFacts): Row {
  const row = closing.notary_party_id ? ctx.rec.entity("notaries", closing.notary_party_id) : undefined;
  return { party_id: closing.notary_party_id ?? `FAKE:notary:${closing.state}`, commission_state: String(row?.data["commission_state"] ?? closing.state), commission_number: String(row?.data["commission_number"] ?? `${closing.state}-${(closing.notary_party_id ?? "FAKE").replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`), physical_location_state: String(row?.data["physical_location_state"] ?? closing.state) };
}
/** The RON platform's feed (FAKE) replayed into 26.2's `monitorSession` ops up to `now`; returns whether every session event has been applied. */
async function pollRon(ctx: StepContext): Promise<{ done: boolean; sealed: boolean }> {
  let rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now; const feed = ctx.fakes.ron;
  const session = rec.entities("signing_sessions", (d) => d["closing_id"] === closing.closing_id).at(-1);
  if (!session) return { done: false, sealed: false };
  const docs = rec.entities("closing_documents", (d) => d["set_id"] !== undefined);
  const docOf = (kind: string): string => String(docs.find((d) => d.data["kind"] === kind)?.id ?? docs.find((d) => kind === "enote" && d.data["kind"] === "note")?.id ?? `DOC-${kind.toUpperCase()}-${rec.app.id.slice(0, 8)}`);
  const parties = rec.borrowerIds(); const notary = notaryOf(ctx, closing);
  const min = S(rec.entities("closing_documents", (d) => d["kind"] === "enote").at(-1)?.data["min"]) ?? S(rec.entities("closing_data_snapshots").at(-1)?.data["min"]) ?? S((rec.entities("closing_data_snapshots").at(-1)?.data["payload"] as Row | undefined)?.["min"]);
  const mers = S(rec.entities("closing_data_snapshots").at(-1)?.data["partner_org_id"]) ?? S((rec.entities("closing_data_snapshots").at(-1)?.data["payload"] as Row | undefined)?.["partner"] && ((rec.entities("closing_data_snapshots").at(-1)!.data["payload"] as Row)["partner"] as Row)["mers_org_id"]);
  const timeline = feed.timeline(closing.closing_id, closing.scheduled_at, parties, { enote: docOf("enote"), final_1003: docOf("final_1003"), security_instrument: docOf("security_instrument") }, { enote: closing.note_form === "enote", min, partner_org_id: mers, notary_party_id: String(notary["party_id"]) });
  const applied = new Set<number>();
  const sessionRow = () => rec.entities("signing_sessions", (d) => d["closing_id"] === closing.closing_id).at(-1)!;
  for (const e of feed.pending(closing.closing_id, timeline, now)) {
    const s = sessionRow(); const proofed = (s.data["identity_proofing"] as Row[] | undefined) ?? []; const signed = (s.data["documents_signed"] as Row[] | undefined) ?? []; const acts = (s.data["notarial_acts"] as Row[] | undefined) ?? [];
    const already = e.op === "identity" ? proofed.some((p) => p["party_id"] === e.detail["party_id"]) : e.op === "start" ? !!s.data["started_at"] : e.op === "enote_created" ? rec.entities("enotes", (d) => d["closing_id"] === closing.closing_id).length > 0 : e.op === "sign" ? signed.some((d) => d["closing_document_id"] === e.detail["closing_document_id"] && d["signer_party_id"] === e.detail["signer_party_id"]) : e.op === "notarial_act" ? acts.some((a) => a["closing_document_id"] === e.detail["closing_document_id"]) : e.op === "seal" ? !!rec.entities("enotes", (d) => d["closing_id"] === closing.closing_id).at(-1)?.data["tamper_sealed_at"] : false;
    if (!already) {
      const detail = { sources: { session_event: src("platform", `FAKE RON feed ${closing.closing_id}#${e.seq} ${e.op} @ ${e.at}`, "35.6") }, seq: e.seq, op: e.op, at: e.at };
      if (e.op === "seal") {
        if (closing.note_form === "enote") { const copy = feed.authoritativeCopy(min, dollars(loanTerms(rec).loan_amount_cents.value), loanTerms(rec).note_rate_pct.value); await ctx.run({ process: "26.2", name: "validateAuthoritativeCopy", actor: CLOSER, input: { op: "seal", closing_id: closing.closing_id, seal_hash: sha256(copy), signing_completed_at: e.detail["signing_completed_at"], authoritative_copy_ref: `EV-${rec.app.id.slice(0, 8)}`, tamper_sealed_at: e.detail["tamper_sealed_at"] }, detail }); }
      } else await ctx.run({ process: "26.2", name: "monitorSession", actor: CLOSER, input: { op: e.op, closing_id: closing.closing_id, session_id: s.id, ...e.detail }, detail });
      rec = await ctx.refresh();
    }
    feed.applied(closing.closing_id, e.seq); applied.add(e.seq);
  }
  const done = feed.consumedThrough(closing.closing_id) >= timeline.length;
  return { done, sealed: !!rec.entities("enotes", (d) => d["closing_id"] === closing.closing_id).at(-1)?.data["tamper_sealed_at"] };
}
const documentsReleased: StepDef = {
  name: "documents_released",
  exit: exitOn("closing.consummated"),
  clocked: () => true,
  actions: async (ctx) => {
    let rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now;
    const released = rec.last("closing.documents.released")!;
    if (!closing.document_set_id) { await ctx.run({ process: "26.2", name: "runPreSessionChecks", actor: CLOSER, input: { op: "upstream", closing_id: closing.closing_id, event: { type: released.type, occurredAt: released.occurredAt, payload: released.payload } }, detail: { sources: { released: src("event", `closing.documents.released:${released.id}`, "26.1") } } }); rec = await ctx.refresh(); }
    const consents = await esignConsents(rec); const primary = consents[rec.borrowerIds()[0]!];
    const consentRow = primary ? (await rec.q.query<{ scope: string[] | null; captured_at: string; revoked_at: string | null; hw_sw_version: string | null; verified: boolean }>(`SELECT scope, captured_at::text AS captured_at, revoked_at::text AS revoked_at, hw_sw_version, verified FROM consents WHERE id = $1`, [primary.consent_id]))[0] : undefined;
    const consent = consentRow ? { consent_id: primary!.consent_id, kind: "esign", scope: consentRow.scope ?? [], granted_at: new Date(consentRow.captured_at).toISOString(), withdrawn_at: consentRow.revoked_at ? new Date(consentRow.revoked_at).toISOString() : null, hw_sw_statement_version: consentRow.hw_sw_version, access_demonstrated: consentRow.verified, paper_option_disclosed: true } : null;
    if (!rec.has("closing.consent.verified") && closing.closing_type !== "wet") await ctx.run({ process: "26.2", name: "verifyEsignConsent", actor: CLOSER, input: { closing_id: closing.closing_id, consent }, detail: { sources: { consent: primary?.source ?? src("derived", "no consents{kind: esign} row", "32.2") } } });
    // wet states (26.3 rule 6 / SM_O73_WET_FUNDS_AT_TABLE_GATE): the funds reach the table before the session — the pre-signing subset, the advance and the wire the business day before the note date (steps-35-6-e.ts); the row waits on the approver, the bank or the warehouse approver there
    const wet = await wetPreSigningFunding(ctx); if (wet) return wet; rec = ctx.rec;
    // the pre-session checks run inside 25.1's consummation-gate freshness window before the slot (GATES[...].freshness_hours): a run older than that is not the one the signing consummates under
    const preSessionOpensAt = new Date(Date.parse(closing.scheduled_at) - GATES["SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE"].freshness_hours * 3_600_000).toISOString();
    if (now < preSessionOpensAt) return { wait: { status: "waiting_window", waiting_on: "closing.scheduled", clocked: false } };
    // 25.1's consummate checkpoint gate over the record (the pre-session check reads it)
    if (!rec.has("compliance.gate.opened", (p) => p["gate"] === "consummation" || p["gate"] === "consummate")) {
      const terms = loanTerms(rec); const cd = cdRow(rec)!; const apr = rec.entities("apr_calculations", (d) => d["checkpoint"] === "cd").at(-1);
      if (apr) await ctx.run({ process: "25.2", name: "assertGateOpen", actor: COMPLIANCE, input: { gate: "SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE", snapshot: recordSnapshot(rec, closing, now, terms, apr, cd) }, detail: { sources: { apr: src("entity", `apr_calculations:${apr.id}:${apr.version}`, "25.1"), cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2") } } });
      rec = await ctx.refresh();
    }
    if (!rec.has("closing.pre_session_checks.passed")) {
      const ctc = rec.last("clear_to_close.issued", (p) => p["passed"] === true); const le = rec.payload("disclosure.le.issued"); const wp = rec.payload("disclosure.cd.waiting_period.computed"); const vvoe = rec.last("vvoe.completed"); const terms = loanTerms(rec); const fraud = rec.last("fraud.hold.placed") && !rec.last("fraud.hold.released");
      const decision = decisionStatus(rec, civil(rec, now)); const packageComposed = rec.last("notice.closing_package.composed"); const released = rec.last("closing.documents.released") ?? rec.last("closing.package.released");
      const facts = { ctc: { ctc_issued: !!ctc, checklist_passed: ctc?.payload["passed"] === true, decision_status: decision.value }, le: { earliest_consummation_date: S(le?.["earliest_consummation_date"]) }, cd: { earliest_consummation_date: S(wp?.["earliest_consummation_date"]), receipts_complete: !!wp?.["earliest_consummation_date"] }, // two copies of the H-8 per consumer on a rescindable loan (§1026.23(b)(1)), one otherwise; the material disclosures ride 25.4's composed closing package; receipt capture is the platform's for an eSign session and the settlement agent's release instructions for paper
        signing_package: rec.borrowerIds().map((c) => ({ consumer_id: c, copies: closing.rescindable ? 2 : 1, channel: closing.closing_type === "wet" || !consents[c] ? "in_person" : "esign", esign_consent_id: consents[c]?.consent_id ?? null, material_disclosures_in_package: !!packageComposed, receipt_capture: closing.closing_type !== "wet" && !!consents[c] ? true : !!released })), fraud_hold: { fraud_hold: !!fraud }, compliance_consummate_gate_open: rec.has("compliance.gate.opened", (p) => p["gate"] === "consummation" || p["gate"] === "consummate"), vvoe_within_10bd: vvoe ? vvoe.payload["within_window"] !== false : false, mi_commitment_valid: rec.entities("mi_certificates").length === 0 || rec.entities("mi_certificates", (d) => ["committed", "docs_ready", "activation_requested", "active"].includes(String(d["status"])) && (!d["commitment_expires_at"] || String(d["commitment_expires_at"]) >= closing.scheduled_at)).length > 0, lock_valid_through_closing: terms.lock_expires_on >= closing.scheduled_note_date, documents_released: true,
        // the notice gates 25.4 and 24.2 own, read from their events: GLBA privacy (privacy.gate.evaluated), the closing package composed and gated (notice.closing_package.composed), the appraisal copy delivered for the final version (valuation.copy.delivered)
        privacy_notice_gate_open: rec.has("privacy.gate.evaluated", (p) => p["result"] === "open"), state_notice_gate_open: rec.has("notice.closing_package.composed", (p) => p["status"] === "gated"), appraisal_copy_gate_open: rec.has("valuation.copy.delivered", (p) => p["is_final_version"] === true) };
      const noticeSources = { privacy: src("event", `privacy.gate.evaluated:${rec.last("privacy.gate.evaluated")?.id ?? ""}`, "25.4"), closing_package: src("event", `notice.closing_package.composed:${rec.last("notice.closing_package.composed")?.id ?? ""}`, "25.4"), appraisal_copy: src("event", `valuation.copy.delivered:${rec.last("valuation.copy.delivered")?.id ?? ""}`, "24.2") };
      const r = await ctx.run<Row>({ process: "26.2", name: "runPreSessionChecks", actor: CLOSER, input: { closing_id: closing.closing_id, consent, facts }, detail: { sources: { ...noticeSources, ctc: ctc ? src("event", `clear_to_close.issued:${ctc.id}`, "23.3") : src("derived", "no CTC", "23.3"), cd_waiting_period: src("event", `disclosure.cd.waiting_period.computed:${rec.last("disclosure.cd.waiting_period.computed")?.id ?? ""}`, "25.2"), vvoe: vvoe ? src("event", `vvoe.completed:${vvoe.id}`, "22.3") : src("derived", "no vvoe.completed", "22.3"), lock: src("event", `lock.executed:${terms.lock.id}`, "21.4"), consent: primary?.source ?? src("derived", "no E-SIGN consent", "32.2") } } });
      if (r["passed"] !== true) { const blocking = (r["blocking"] as string[] | undefined) ?? []; const owner = blocking[0]?.split(":")[0] ?? "26.2"; ctx.journal.push({ step: "documents_released", kind: "waiting", waiting_on: owner, detail: { blocking, checked: r["checked"] ?? [] } }); return { wait: { status: "open", waiting_on: owner, clocked: true } }; }
      rec = await ctx.refresh();
    }
    // the session opens at the slot; before it the row waits on the window
    if (now < closing.scheduled_at) return { wait: { status: "waiting_window", waiting_on: "closing.scheduled", clocked: false } };
    if (!rec.entities("signing_sessions", (d) => d["closing_id"] === closing.closing_id).length) {
      await ctx.run({ process: "26.2", name: "openSigningSession", actor: CLOSER, input: { closing_id: closing.closing_id, session_id: `SES-${closing.closing_id}`, signer_party_ids: rec.borrowerIds(), notary: notaryOf(ctx, closing), consent_record_id: primary?.consent_id ?? null }, detail: { sources: { closing: src("entity", `closings:${closing.row.id}:${closing.row.version}`, "26.2"), notary: src("platform", `FAKE notary ${closing.notary_party_id ?? ""}`, "35.6") } } });
      rec = await ctx.refresh();
    }
    const polled = await pollRon(ctx);
    if (!ctx.rec.has("closing.consummated")) return { wait: { status: "waiting_vendor", waiting_on: "26.2.ron", clocked: !polled.done } };
    return {};
  },
};
const consummated: StepDef = {
  name: "consummated",
  exit: exitOn("closing.execution_review.passed"),
  clocked: () => true,
  actions: async (ctx) => {
    let rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now;
    const polled = await pollRon(ctx); rec = ctx.rec;
    if (!polled.done) return { wait: { status: "waiting_vendor", waiting_on: "26.2.ron", clocked: true } };
    const consummatedEv = rec.last("closing.consummated")!;
    if (closing.note_form === "enote") {
      const enote = rec.entities("enotes", (d) => d["closing_id"] === closing.closing_id).at(-1);
      if (!enote?.data["authoritative_copy_validated_at"]) { const terms = loanTerms(rec); const copy = ctx.fakes.ron.authoritativeCopy(S(enote?.data["min"]), dollars(terms.loan_amount_cents.value), terms.note_rate_pct.value); await ctx.run({ process: "26.2", name: "validateAuthoritativeCopy", actor: CLOSER, input: { closing_id: closing.closing_id, authoritative_copy: copy }, detail: { sources: { seal: src("entity", `enotes:${enote?.id ?? ""}`, "26.2"), copy: src("platform", "FAKE RON platform authoritative copy", "35.6") } } }); rec = await ctx.refresh(); }
      if (!rec.has("enote.registered")) { await ctx.run({ process: "26.2", name: "registerENote", actor: CLOSER, input: { closing_id: closing.closing_id }, detail: { sources: { validated: src("event", `enote.authoritative_copy.validated:${rec.last("enote.authoritative_copy.validated")?.id ?? ""}`, "26.2") } } }); rec = await ctx.refresh(); }
      if (!rec.has("enote.secured_party.set")) { await ctx.run({ process: "26.2", name: "setSecuredParty", actor: CLOSER, input: { closing_id: closing.closing_id }, detail: { sources: { registered: src("event", `enote.registered:${rec.last("enote.registered")?.id ?? ""}`, "26.2") } } }); rec = await ctx.refresh(); }
    }
    // 25.2: the CD version consummated (`disclosure.cd.consummated` — 26.3's FC_CD_ACK reads the consummated version)
    if (!rec.has("disclosure.cd.consummated")) {
      const cd = cdRow(rec)!; const consummationAt = String(consummatedEv.payload["consummation_at"] ?? consummatedEv.occurredAt);
      await ctx.run({ process: "25.2", name: "assertGateOpen", actor: DISCLOSURE, input: { gate: "REGZ_1026_19F1_CD_3SBD_GATE", op: "consummate", requested_on: civil(rec, consummationAt), at: consummationAt }, detail: { sources: { consummated: src("event", `closing.consummated:${consummatedEv.id}`, "26.2"), cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2") } } });
      rec = await ctx.refresh();
    }
    // 26.3: the funding calendar opened from the consummation (rescission expiry, earliest funding date, wet/dry)
    if (!rec.has("funding.requested")) {
      const terms = loanTerms(rec); const parties = await partyFacts(rec, closing); const note = rec.entities("closing_data_snapshots").at(-1);
      const firstPayment = S((note?.data["payload"] as Row | undefined)?.["note_terms"] && (((note!.data["payload"] as Row)["note_terms"] as Row)["first_payment_date"])) ?? S(rec.payload("funding.interest_mode.decided")?.["first_payment_date"]);
      await ctx.run({ process: "26.3", name: "computeDates", actor: FUNDER, input: { op: "open", funding_id: fundingIdOf(rec), state: closing.state, transaction_type: rec.app.transaction_type ?? "limited_cash_out", time_zone: closing.time_zone, consummation_at: String(consummatedEv.payload["consummation_at"] ?? consummatedEv.occurredAt), review_completed_on: civil(rec, now), partner_id: parties.partner_id, partner_loan_number: S(rec.intake()?.["partner_loan_number"]) ?? `PL-${rec.app.id.slice(0, 8)}`, gross_loan_cents: String(terms.loan_amount_cents.value), note_rate_pct: terms.note_rate_pct.value, ...(firstPayment ? { note_first_payment_date: firstPayment } : {}), closing_id: closing.closing_id, rescindable: closing.rescindable }, detail: { sources: { consummated: src("event", `closing.consummated:${consummatedEv.id}`, "26.2"), ...sources({ gross_loan_cents: terms.loan_amount_cents, note_rate_pct: terms.note_rate_pct }), partner: parties.sources["partner"]! } } });
      rec = await ctx.refresh();
    }
    // 26.4: the MIN registered on the MERS System as post-closing (MOM; MERS_PROC_MOM_REGISTER_7 from the note date) — 26.4's SOR row, the one its MIN reversal (SM_O74_MIN_REVERSAL_2BD) runs against on an unwind
    {
      const min = S(rec.entities("enotes", (d) => d["closing_id"] === closing.closing_id).at(-1)?.data["min"]) ?? S(rec.payload("closing.scheduled")?.["min"]) ?? S(rec.entities("closing_data_snapshots").at(-1)?.data["min"]) ?? S((rec.entities("closing_data_snapshots").at(-1)?.data["payload"] as Row | undefined)?.["min"]);
      const parties = await partyFacts(rec, closing);
      if (min && parties.partner_mers_org_id && !rec.entities("mers_registrations", (d) => d["min"] === min).length) {
        const funding = rec.payload("funding.requested");
        await ctx.run({ process: "26.4", name: "registerMin", actor: POST_CLOSING, input: { op: "register", min, partner_org_id: parties.partner_mers_org_id, transaction_type: rec.app.transaction_type ?? "limited_cash_out", state: closing.state, escrow_state: closing.dry_state, note_date: S(consummatedEv.payload["note_date"]) ?? closing.scheduled_note_date, ...(S(funding?.["disbursement_date"]) ? { funding_date: S(funding!["disbursement_date"]) } : {}), submitted_at: now, time_zone: closing.time_zone }, detail: { sources: { min: src("event", `closing.consummated:${consummatedEv.id}`, "26.2"), partner: parties.sources["partner"] ?? src("table", `parties:${parties.partner_id}`, "20.1"), note_date: src("event", `closing.consummated:${consummatedEv.id}`, "26.2") } } });
        rec = await ctx.refresh();
      }
    }
    // 25.3: rescindability, the H-8 to each consumer at the signing (the session's audit trail is the evidence), the period from the latest of consummation, notice and the CD receipts
    if (closing.rescindable && !rec.has("rescission.period.started")) {
      const parties = await partyFacts(rec, closing); const payoffs = payoffFacts(rec); const apr = rec.entities("apr_calculations", (d) => d["checkpoint"] === "cd").at(-1); const cd = cdRow(rec)!; const funding = rec.payload("funding.requested")!;
      const prior = payoffs.rows.at(-1); const nonFc = (cd.data["figures"] as Row | undefined)?.["fees"] as Row[] | undefined;
      const refiCosts = (nonFc ?? []).filter((f) => ["C_can_shop", "E_taxes_gov"].includes(String(f["section"]))).reduce((s, f) => s + cents(f["amount_cents"]), 0n);
      if (!rec.has("rescission.applicability.determined")) await ctx.run({ process: "25.3", name: "determineRescindability", actor: DISCLOSURE, input: { transaction_type: rec.app.transaction_type ?? "limited_cash_out", consumers: parties.borrower_ids.map((c) => ({ consumer_id: c, role: "borrower", ownership_interest: true, occupancy: "primary" })), partner_id: parties.partner_id, existing_loan: prior ? { original_creditor_id: String(prior.data["creditor_party_id"] ?? prior.data["servicer_party_id"] ?? prior.data["liability_id"]), upb_cents: String(cents(prior.data["principal_cents"])), earned_unpaid_finance_charge_cents: String(cents(prior.data["interest_cents"])), refinancing_costs_cents: String(refiCosts) } : null, amount_financed_cents: String(apr?.data["amount_financed_cents"] ?? 0), time_zone: closing.time_zone }, detail: { sources: { payoff: payoffs.source, apr: apr ? src("entity", `apr_calculations:${apr.id}:${apr.version}`, "25.1") : src("derived", "no cd APR", "25.1"), cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2") } } });
      rec = await ctx.refresh();
      const session = rec.entities("signing_sessions", (d) => d["closing_id"] === closing.closing_id).at(-1);
      const trail = ctx.fakes.ron.auditTrail(closing.closing_id, S(session?.data["platform_session_ref"]), ctx.fakes.ron.timeline(closing.closing_id, closing.scheduled_at, rec.borrowerIds(), { enote: "", final_1003: "", security_instrument: "" }, { enote: closing.note_form === "enote", min: null, partner_org_id: null, notary_party_id: "" }));
      let trailDoc = S(session?.data["audit_trail_document_id"]);
      if (!trailDoc) { trailDoc = await storeDocument(ctx.rt.db, { kind: "ron_audit_trail", application_id: rec.app.id, loan_id: null, text: trail.text, retention_class: "fnma_enote_signing_life_plus_7y", source: `FAKE RON platform audit trail ${closing.closing_id}`, now, source_channel: "vendor_delivery" }); ctx.journal.push({ step: "consummated", kind: "waiting", waiting_on: null, detail: { document_id: trailDoc, kind: "ron_audit_trail" } }); }
      const consummationAt = String(consummatedEv.payload["consummation_at"] ?? consummatedEv.occurredAt);
      for (const c of parties.borrower_ids) {
        if (rec.entities("disclosures", (d) => String(d["kind"] ?? "").startsWith("rescission") && d["consumer_id"] === c && d["status"] === "delivered").length) continue;
        await ctx.run({ process: "25.3", name: "renderRescissionNotice", actor: DISCLOSURE, input: { form: "h8", consumer_id: c, consumer_name: rec.borrowerName(c), transaction_date: civil(rec, consummationAt), expires_on: S(funding["rescission_expires_at"]) ? civil(rec, String(funding["rescission_expires_at"])) : undefined, creditor_name: parties.partner_legal_name, designated_address: String(rec.intake()?.["partner_address"] ?? parties.partner_legal_name), property_address: parties.property_address }, detail: { consumer_id: c, sources: { funding: src("event", `funding.requested:${rec.last("funding.requested")!.id}`, "26.3") } } });
        await ctx.run({ process: "25.3", name: "deliverRescissionNotice", actor: DISCLOSURE, input: { consumer_id: c, delivered_at: consummationAt, channel: "in_person", copies: 2, evidence_document_id: trailDoc, form: "h8", time_zone: closing.time_zone }, detail: { consumer_id: c, sources: { audit_trail: src("table", `documents:${trailDoc}`, "35.2") } } });
      }
      rec = await ctx.refresh();
      const receipts = cdReceipts(rec, cd.id);
      await ctx.run({ process: "25.3", name: "computeRescissionPeriod", actor: DISCLOSURE, input: { consummation_at: consummationAt, time_zone: closing.time_zone, notice_deliveries: parties.borrower_ids.map((c) => ({ consumer_id: c, delivered_at: consummationAt, channel: "in_person", copies: 2, evidence_document_id: trailDoc })), material_disclosures: parties.borrower_ids.map((c) => ({ consumer_id: c, cd_version: Number(cd.data["cd_version"] ?? 1), effective_receipt_date: S(receipts.find((r) => r.data["consumer_id"] === c)?.data["effective_receipt_date"]), accurate: true })), material_disclosures_accurate: true }, detail: { sources: { consummated: src("event", `closing.consummated:${consummatedEv.id}`, "26.2"), receipts: src("entity", `cd_receipts:${receipts.map((r) => r.id).join(",")}`, "25.2") } } });
      rec = await ctx.refresh();
    }
    // 26.2: the audit trail on file, then the post-signing execution review
    const session = rec.entities("signing_sessions", (d) => d["closing_id"] === closing.closing_id).at(-1)!;
    if (!session.data["audit_trail_received_at"]) {
      const trail = ctx.fakes.ron.auditTrail(closing.closing_id, S(session.data["platform_session_ref"]), ctx.fakes.ron.timeline(closing.closing_id, closing.scheduled_at, rec.borrowerIds(), { enote: "", final_1003: "", security_instrument: "" }, { enote: closing.note_form === "enote", min: null, partner_org_id: null, notary_party_id: "" }));
      const existing = rec.entities("disclosures", (d) => String(d["kind"] ?? "").startsWith("rescission") && d["status"] === "delivered").at(-1);
      const docId = S(existing?.data["evidence_document_id"]) ?? await storeDocument(ctx.rt.db, { kind: "ron_audit_trail", application_id: rec.app.id, loan_id: null, text: trail.text, retention_class: "fnma_enote_signing_life_plus_7y", source: `FAKE RON platform audit trail ${closing.closing_id}`, now, source_channel: "vendor_delivery" });
      await ctx.run({ process: "26.2", name: "ingestAuditTrail", actor: CLOSER, input: { closing_id: closing.closing_id, session_id: session.id, document_id: docId, audit_trail_hash: sha256(trail.text), platform_hash: sha256(trail.text), recording_ref: trail.recording_ref, journal_ref: trail.journal_ref }, detail: { sources: { trail: src("platform", `FAKE RON platform audit trail ${trail.recording_ref}`, "35.6") } } });
      rec = await ctx.refresh();
    }
    if (!rec.has("closing.execution_review.passed") && !rec.has("closing.execution_review.failed")) {
      // a paper note is reviewed from the executed package the settlement agent returns after the table (the FAKE agent scans it an hour after the signing; SM_O72_POST_SIGNING_REVIEW_4H runs from consummation); an eNote's package is the platform's at once
      if (closing.note_form === "paper") { const pkg = ctx.fakes.settlementAgent.executedPackage(closing.closing_id, String(consummatedEv.payload["consummation_at"] ?? consummatedEv.occurredAt), now); if (!pkg) return { wait: { status: "waiting_vendor", waiting_on: "settlement_agent", clocked: true } }; ctx.journal.push({ step: "consummated", kind: "waiting", waiting_on: null, detail: { executed_package: pkg.package_ref, returned_at: pkg.returned_at } }); }
      const s = rec.entities("signing_sessions", (d) => d["closing_id"] === closing.closing_id).at(-1)!; const signed = (s.data["documents_signed"] as Row[] | undefined) ?? []; const acts = (s.data["notarial_acts"] as Row[] | undefined) ?? [];
      const docs = rec.entities("closing_documents", (d) => d["set_id"] !== undefined); const enote = rec.entities("enotes", (d) => d["closing_id"] === closing.closing_id).at(-1);
      // the MIN on the recordable set: the eNote's, else the one 26.1's snapshot / 26.2's schedule carry for a paper note (26.4's MOM registration)
      const minOnRecord = S(enote?.data["min"]) ?? S(rec.payload("closing.scheduled")?.["min"]) ?? S(rec.entities("closing_data_snapshots").at(-1)?.data["min"]) ?? S((rec.entities("closing_data_snapshots").at(-1)?.data["payload"] as Row | undefined)?.["min"]);
      const documents = docs.map((d) => { const kind = String(d.data["kind"]); const sigs = signed.filter((x) => x["closing_document_id"] === d.id); const act = acts.find((a) => a["closing_document_id"] === d.id);
        // the signers a document requires: 26.1's own list on the row when it carries one; the note class (note/eNote, the security instrument) every borrower; anything else the signers the platform recorded on it
        const listed = (d.data["required_signers"] ?? d.data["signers"]) as unknown; const listedIds = Array.isArray(listed) ? listed.map((x) => (typeof x === "string" ? x : String((x as Row)["party_id"] ?? ""))).filter(Boolean) : null;
        const required = listedIds?.length ? listedIds : (kind === "enote" || kind === "note" || kind === "security_instrument") ? rec.borrowerIds() : [...new Set(sigs.map((x) => String(x["signer_party_id"])))];
        return { closing_document_id: d.id, kind, form: closing.closing_type === "wet" || kind === "note" ? "paper" : "electronic", required_signers: required.map((p) => ({ party_id: p, typed_name: rec.borrowerName(p), capacity: "borrower" })), signatures: sigs.map((x) => ({ party_id: String(x["signer_party_id"]), signed_name: rec.borrowerName(String(x["signer_party_id"])), attributable: true, dated: true })), notarized: !!act, ...(act ? { notarial_certificate: { venue: true, date: true, notary_name: true, commission_expiry: true, seal: true, ...(closing.closing_type === "ron" ? { ron_statement: true } : {}) } } : {}), witness_count_required: 0, witnesses: 0, handwritten_changes: [], recordable: kind === "security_instrument", min_present: kind === "enote" || kind === "security_instrument" ? !!minOnRecord : true, cover_sheet: true, ...(kind === "enote" ? { smart_doc_hash: S(enote?.data["tamper_seal_hash"]), eregistry_hash: S(enote?.data["tamper_seal_hash"]) } : {}) }; })
        .filter((d) => d.signatures.length > 0 || d.required_signers.length > 0);
      await ctx.run({ process: "26.2", name: "reviewExecution", actor: CLOSER, input: { closing_id: closing.closing_id, documents, platform_hash: S(s.data["audit_trail_hash"]) }, detail: { sources: { session: src("entity", `signing_sessions:${s.id}:${s.version}`, "26.2"), documents: src("entity", `closing_documents:${docs.map((d) => d.id).join(",")}`, "26.1") } } });
      rec = await ctx.refresh();
    }
    if (rec.has("closing.execution_review.failed") && !rec.has("closing.execution_review.passed")) return { hold: { reason: "gate_closed", gate: "SM_O72_POST_SIGNING_REVIEW_4H", detail: { defects: (rec.last("closing.execution_review.failed")!.payload as Row)["defects"] ?? [] } } };
    return {};
  },
};

// ───────────────────────────── execution_reviewed → funding_authorized: the worksheet, the conditions, the advance (T7) ─────────────────────────────
const executionReviewed: StepDef = {
  name: "execution_reviewed",
  exit: (rec) => (rec.has("funding.authorized") && rec.has("warehouse.advance.approved") ? rec.last("warehouse.advance.approved") : null),
  entryWait: (rec) => (rec.has("rescission.period.started") && !rec.has("rescission.confirmed_not_rescinded") ? { status: "waiting_window", waiting_on: "REGZ_1026_23_RESCISSION_3SBD_GATE", clocked: false } : null),
  clocked: () => true,
  actions: async (ctx) => {
    const rec = ctx.rec; const now = ctx.now;
    const resc = rescissionFacts(rec, now);
    if (resc.started && !resc.confirmed) return { wait: { status: "waiting_window", waiting_on: "REGZ_1026_23_RESCISSION_3SBD_GATE", clocked: false } };
    const funding = rec.payload("funding.requested"); if (!funding) throw new RecordGap("funding.requested", "26.3 has not opened the funding calendar");
    if (civil(rec, now) < String(funding["disbursement_date"])) return { wait: { status: "waiting_window", waiting_on: "SM_O73_FUNDING_DATE", clocked: false } };
    return fundingChain(ctx, { stage: null, resc });
  },
};
/**
 * 26.3's worksheet from the consummated CD version (rule 7), the settlement agent's requested-net statement reconciled to it, 25.1's disbursement gate, the funding conditions with every fact
 * from the record (`stage: "pre_signing"` = the wet-state subset the day before the session — 26.3 rule 6 / open question 1), `requestWarehouseAdvance` → `funding.authorized`; 27.1's eligibility,
 * borrowing base and advance decision as `warehouse` → `warehouse.advance.approved`; 26.3 records the approval. Shared by the dry path (execution_reviewed) and the wet pre-signing chain (documents_released).
 */
export async function fundingChain(ctx: StepContext, o: { stage: "pre_signing" | null; resc: ReturnType<typeof rescissionFacts> }): Promise<StepOutcome> {
  {
    let rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now; const resc = o.resc;
    const funding = rec.payload("funding.requested"); if (!funding) throw new RecordGap("funding.requested", "26.3 has not opened the funding calendar");
    const fundingId = String(funding["funding_id"]); const terms = loanTerms(rec); const cd = cdRow(rec)!; const cdF = (cd.data["figures"] as Row | undefined) ?? {};
    const fees = (cdF["fees"] as Row[] | undefined) ?? []; const prepaid = cents(fees.find((f) => f["fee_code"] === "prepaid_interest")?.["amount_cents"] ?? rec.payload("funding.interest_mode.decided")?.["amount_cents"] ?? 0);
    const escrowDeposit = cents(cdF["initial_escrow_payment_cents"] ?? fees.find((f) => f["fee_code"] === "escrow_deposit")?.["amount_cents"] ?? 0); const lenderCredit = cents(cdF["lender_credits_cents"] ?? terms.lender_credit_cents.value);
    const disbursement = String(funding["disbursement_date"]); const cdSource = src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2");
    // 26.3: the worksheet from the consummated CD; the settlement agent's requested-net statement (FAKE) reconciled to it
    let ws = rec.entities("funding_worksheets", (d) => d["funding_id"] === fundingId).at(-1);
    if (!ws) { await ctx.run({ process: "26.3", name: "buildFundingWorksheet", actor: FUNDER, input: { funding_id: fundingId, version: 1, cd_version: Number(cd.data["cd_version"] ?? 1), gross_loan_cents: String(terms.loan_amount_cents.value), prepaid_interest_cents: String(prepaid), escrow_deposit_cents: String(escrowDeposit), lender_credits_cents: String(lenderCredit) }, detail: { sources: { cd: cdSource, gross_loan_cents: terms.loan_amount_cents.source, prepaid_interest: src("event", `funding.interest_mode.decided:${rec.last("funding.interest_mode.decided")?.id ?? ""}`, "26.3"), escrow_deposit: cdSource, lender_credits: cdSource } } }); rec = await ctx.refresh(); ws = rec.entities("funding_worksheets", (d) => d["funding_id"] === fundingId).at(-1)!; }
    if (!ws.data["reconciled"]) {
      const statement = ctx.fakes.settlementAgent.requestedNet(rec.app.id, { net_wire_cents: cents(ws.data["net_wire_cents"]), escrow_deposit_cents: escrowDeposit }, now);
      const docId = await storeDocument(ctx.rt.db, { kind: "settlement_statement", application_id: rec.app.id, loan_id: null, text: JSON.stringify({ statement_id: statement.statement_id, kind: statement.kind, requested_net_cents: String(statement.requested_net_cents), escrow_deposit_cents: String(statement.escrow_deposit_cents), received_at: statement.received_at }), retention_class: "life_of_loan_plus_4y", source: `FAKE settlement agent ${statement.statement_id}`, now, source_channel: "vendor_delivery" });
      const stmtSource = src("table", `documents:${docId} (FAKE settlement agent statement ${statement.statement_id})`, "35.2");
      if (statement.escrow_deposit_cents !== escrowDeposit) return { hold: { reason: "money_mismatch", detail: { field: "escrow_deposit_cents", statement_cents: String(statement.escrow_deposit_cents), cd_cents: String(escrowDeposit), statement_source: stmtSource, cd_source: cdSource, statement_document_id: docId } } };
      const r = await ctx.run<Row>({ process: "26.3", name: "reconcileToSettlementStatement", actor: FUNDER, input: { funding_id: fundingId, worksheet_id: ws.id, agent_requested_net_cents: String(statement.requested_net_cents), at: now }, detail: { sources: { worksheet: src("entity", `funding_worksheets:${ws.id}:${ws.version}`, "26.3"), statement: stmtSource }, statement_document_id: docId } });
      const wsOut = r["worksheet"] as Row | undefined;
      if (wsOut && wsOut["reconciled"] !== true) return { hold: { reason: "money_mismatch", detail: { field: "net_wire_cents", statement_cents: String(statement.requested_net_cents), cd_cents: String(ws.data["net_wire_cents"]), variance_cents: String(wsOut["variance_cents"] ?? ""), statement_source: stmtSource, cd_source: cdSource, statement_document_id: docId } } };
      rec = await ctx.refresh(); ws = rec.entities("funding_worksheets", (d) => d["funding_id"] === fundingId).at(-1)!;
    }
    // 25.1's disbursement checkpoint gate over the record (26.3's FC_COMPLIANCE_DISBURSE reads compliance.gate.opened{gate: disbursement})
    if (!rec.has("compliance.gate.opened", (p) => p["gate"] === "disbursement")) {
      const apr = rec.entities("apr_calculations", (d) => d["checkpoint"] === "cd").at(-1);
      if (apr) { await ctx.run({ process: "25.2", name: "assertGateOpen", actor: COMPLIANCE, input: { gate: "SM_O61_COMPLIANCE_PASS_DISBURSE_GATE", snapshot: recordSnapshot(rec, closing, now, terms, apr, cd) }, detail: { sources: { apr: src("entity", `apr_calculations:${apr.id}:${apr.version}`, "25.1"), cd: cdSource } } }); rec = await ctx.refresh(); }
    }
    // 26.3: the funding conditions with every fact from the record; then funding.authorized
    if (!rec.has("funding.authorized")) {
      const fc = fundingConditionFacts(rec, { as_of: now, funding_type: String(funding["funding_type"]), transaction_type: rec.app.transaction_type ?? "limited_cash_out", disbursement_date: disbursement, release_date: disbursement, note_date: S(funding["note_date"]) ?? closing.scheduled_note_date, authorized: false, loan_amount_cents: terms.loan_amount_cents.value, enote: closing.note_form === "enote", first_payment_date: S(funding["first_payment_date"]), rescission: resc.facts, rescission_source: resc.source, worksheet_reconciled: ws.data["reconciled"] === true, warehouse_advance_approved: null, ...(o.stage ? { stage: o.stage } : {}) });
      const conditions = await ctx.run<Row>({ process: "26.3", name: "evaluateFundingConditions", actor: FUNDER, input: { funding_id: fundingId, facts: fc.facts, ...(o.stage ? { op: o.stage } : {}) }, detail: { sources: fc.sources, ...(o.stage ? { subset: o.stage } : {}) } });
      if (conditions["passed"] !== true) { const pending = (conditions["pending_codes"] as string[] | undefined) ?? []; const blocking = (conditions["blocking_codes"] as string[] | undefined) ?? []; if (blocking.length) return { hold: { reason: "gate_closed", gate: String(blocking[0]), detail: { blocking, pending } } }; return { wait: { status: "open", waiting_on: pending[0] ?? "26.3", clocked: true } }; }
      // the wet-state pre-signing run happens the business day before the note date (26.3's SM_O73_CONDITIONS_EVAL_2BH wet anchor); 26.3 authorizes no funding before its earliest funding date (BEFORE_EARLIEST_FUNDING_DATE) — the advance and the wire follow on the funding morning, before the session
      const earliest = S(funding["earliest_funding_date"]) ?? disbursement;
      if (civil(rec, now) < earliest) return { wait: { status: "waiting_window", waiting_on: "SM_O73_FUNDING_DATE", clocked: false } };
      await ctx.run({ process: "26.3", name: "requestWarehouseAdvance", actor: FUNDER, input: { funding_id: fundingId, conditions, rescission: resc.facts, fraud_hold: fc.facts["fraud"], ptf: fc.facts["ptf"], cash_to_close: fc.facts["cash_to_close"], gifts: fc.facts["gifts"] ?? [], at: now }, detail: { sources: { conditions: src("event", `funding.conditions.evaluated:${String(conditions["event_id"] ?? "")}`, "26.3"), rescission: resc.source ?? src("derived", "not rescindable", "25.3") } } });
      rec = await ctx.refresh();
    }
    // 27.1: eligibility, the borrowing base and the advance decision as `warehouse`; 26.3 records the approval
    if (!rec.has("warehouse.advance.approved")) {
      const authorized = rec.last("funding.authorized")!; const req = authorized.payload["advance_request"] as Row; const commitment = rec.last("commitment.executed"); const cRow = rec.entities("commitments").at(-1);
      const fid = S(rec.entities("warehouse_facilities").at(-1)?.id) ?? FACILITY_FIXTURE.facility_id;
      const wh = warehouseFacts(rec, { funding_id: fundingId, advance_id: advanceIdOf(rec), facility_id: fid, requested_at: now, note_form: closing.note_form, closing_type: closing.closing_type, wet_dry: String(funding["funding_type"]), net_disbursement_cents: cents(req["net_disbursement_cents"]), note_date: String(req["note_date"] ?? funding["note_date"]), disbursement_date: disbursement, first_payment_date: String(funding["first_payment_date"]), rescission_gate_open: resc.confirmed ? true : resc.row ? false : null, note_amount_cents: cents(req["note_amount_cents"]), commitment_price: String(commitment?.payload["price"] ?? cRow?.data["commitment_price"] ?? "100.000"), commitment_id_fnma: String(commitment?.payload["commitment_id_fnma"] ?? cRow?.data["commitment_id_fnma"] ?? ""), commitment_expires_on: String(commitment?.payload["expires_on"] ?? cRow?.data["expires_on"] ?? ""), enote_registered_on: rec.last("enote.registered") ? civil(rec, rec.last("enote.registered")!.occurredAt) : null, secured_party_added_at: rec.last("enote.secured_party.set")?.occurredAt ?? null });
      await ctx.run({ process: "27.1", name: "evaluateEligibility", actor: WAREHOUSE, input: { facts: wh.facts, application_id: rec.app.id, facility_id: fid }, detail: { sources: wh.sources } });
      await ctx.run({ process: "27.1", name: "computeBorrowingBase", actor: WAREHOUSE, input: { as_of: rec.etDate(now), facility_id: fid }, detail: { facility_id: fid } });
      const approval = await ctx.run<Row>({ process: "27.1", name: "approveAdvance", actor: WAREHOUSE, input: { request: wh.request, facts: wh.facts, facility_id: fid }, detail: { sources: { ...wh.sources, funding_authorized: src("event", `funding.authorized:${authorized.id}`, "26.3") } } });
      if (approval["outcome"] !== "approved") return { hold: { reason: "warehouse_kickout", gate: String((approval["reasons"] as string[] | undefined)?.[0] ?? "advance_rejected"), detail: { reasons: approval["reasons"] ?? [] } } };
      await ctx.run({ process: "26.3", name: "requestWarehouseAdvance", actor: FUNDER, input: { funding_id: fundingId, op: "advance_approved", advance_id: String(approval["advance_id"]) }, detail: { sources: { approved: src("event", `warehouse.advance.approved:${String(approval["event_id"] ?? "")}`, "27.1") } } });
    }
    return {};
  }
}

// ───────────────────────────── funding_authorized → wire_released: the wire and the release (T8) ─────────────────────────────
const fundingAuthorized: StepDef = {
  name: "funding_authorized",
  exit: exitOn("funding.wire.accepted"),
  clocked: () => true,
  actions: (ctx) => wireChain(ctx),
};
/** 26.3 `prepareWire` as `funder` with 24.4's verified wire record → `funding.wire.prepared`; `waiting_human{funding_approver}` until a funding_approver's release (the pass never releases); the FAKE bank's acceptance → `funding.wire.accepted`. Shared by the dry path (funding_authorized) and the wet pre-signing chain. */
export async function wireChain(ctx: StepContext): Promise<StepOutcome> {
  {
    let rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now;
    const funding = rec.payload("funding.requested")!; const fundingId = String(funding["funding_id"]); const fundingRow = rec.entity("fundings", fundingId);
    const prepared = rec.last("funding.wire.prepared"); const released = rec.last("funding.wire.released");
    if (!prepared) {
      const wire = verifiedWireRecord(rec, closing.settlement_agent_party_id); const parties = await partyFacts(rec, closing); const ws = rec.entities("funding_worksheets", (d) => d["funding_id"] === fundingId).at(-1);
      const facility = rec.entities("warehouse_facilities").at(-1);
      await ctx.run({ process: "26.3", name: "prepareWire", actor: FUNDER, input: { funding_id: fundingId, wire_id: `W-${rec.app.id.slice(0, 8)}`, record: wire.value, instructions_hash: String(wire.value["instructions_hash"]), instructions_source: "verified_record", value_date: String(funding["disbursement_date"]), prepared_at: now, run_id: ctx.runId ? `sweep:${ctx.runId}` : "pass", editors: [], borrower_last_name: parties.borrower_names[0]?.split(" ").at(-1) ?? "", property_short: parties.property_address, funding_account_ref_hash: sha256(String(facility?.data["funding_account_ref"] ?? "sm-funding-account")), closing_documents: [] }, detail: { sources: { wire_verification: wire.source, worksheet: ws ? src("entity", `funding_worksheets:${ws.id}:${ws.version}`, "26.3") : src("derived", "no worksheet", "26.3"), funding: src("entity", `fundings:${fundingRow?.id ?? fundingId}`, "26.3") } } });
      return { wait: { status: "waiting_human", waiting_on: "funding_approver", clocked: true } };
    }
    if (!released) return { wait: { status: "waiting_human", waiting_on: "funding_approver", clocked: true } };
    // the bank's acceptance (FAKE funding bank) recorded by the funder
    const wireId = String(prepared.payload["wire_id"]);
    const bank = ctx.fakes.bank.poll(wireId, String(released.payload["released_at"] ?? released.occurredAt), now);
    if (bank.status === "pending") return { wait: { status: "waiting_vendor", waiting_on: "26.3.bank", clocked: true } };
    if (bank.status === "rejected") { await ctx.run({ process: "26.3", name: "prepareWire", actor: FUNDER, input: { funding_id: fundingId, op: "reject", wire_id: wireId, reason: bank.reason, at: now }, detail: { sources: { bank: src("platform", "FAKE funding bank", "35.6") } } }); return { hold: { reason: "gate_closed", gate: "WIRE_REJECTED", detail: { reason: bank.reason } } }; }
    await ctx.run({ process: "26.3", name: "prepareWire", actor: FUNDER, input: { funding_id: fundingId, op: "accept", wire_id: wireId, imad: bank.imad, accepted_at: bank.accepted_at }, detail: { sources: { bank: src("platform", `FAKE funding bank IMAD ${bank.imad}`, "35.6"), released: src("event", `funding.wire.released:${released.id}`, "26.3") } } });
    rec = await ctx.refresh();
    return {};
  }
}
/** 27.1 `prepareWire` books the advance behind the accepted funding wire — the warehouse wire package to the funding_approver (dual control; the FAKE approver in reviewers.ts) → `warehouse.advance.funded`; returns the wait while the approver has not acted, null once funded. */
export async function bookAdvance(ctx: StepContext): Promise<StepOutcome | null> {
  const rec = ctx.rec; const accepted = rec.last("funding.wire.accepted"); if (!accepted) return null;
  const advanceId = S(rec.payload("warehouse.advance.approved")?.["advance_id"]) ?? advanceIdOf(rec);
  if (rec.has("warehouse.advance.funded")) return null;
  if (!(await ctx.rt.db.query(`SELECT 1 FROM escalations WHERE application_id = $1 AND owner_role = 'funding_approver' AND completed_at IS NULL AND payload->'package'->>'advance_id' = $2`, [rec.app.id, advanceId])).length) {
    const fid = S(rec.entities("warehouse_facilities").at(-1)?.id) ?? FACILITY_FIXTURE.facility_id;
    // SM_WH_HAIRCUT_RESERVE_GATE reads the partner's haircut reserve as the ledger carries it: the balance of `partner_haircut_reserve` on THIS facility's reserve bank account (27.1's `haircut_reserve_account_ref`; 27.1's draws debit it, the partner's deposits credit it); no line at all is a gap the warehouse owner fills
    const facilityRow = rec.entities("warehouse_facilities", (d) => d["facility_id"] === fid).at(-1);
    const reserveRef = String(facilityRow?.data["haircut_reserve_account_ref"] ?? (fid === FACILITY_FIXTURE.facility_id ? FACILITY_FIXTURE.haircut_reserve_account_ref : ""));
    if (!reserveRef) throw new RecordGap("warehouse_facilities.haircut_reserve_account_ref", `facility ${fid} names no haircut reserve account (27.1)`);
    const reserve = (await ctx.rt.db.query<{ cents: string | null }>(`SELECT (-SUM(amount_cents))::text AS cents FROM ledger_lines WHERE account = 'partner_haircut_reserve' AND scope = 'custodial' AND custodial_account_id = $1`, [custodialAccountIdFor(reserveRef)]))[0]?.cents ?? null;
    if (reserve === null) throw new RecordGap("ledger:partner_haircut_reserve", `no partner_haircut_reserve line on the facility's reserve account ${reserveRef} (27.1 LSA haircut reserve; the partner's deposit is posted by 2.1 ledger.post)`);
    await ctx.run({ process: "27.1", name: "prepareWire", actor: WAREHOUSE, input: { advance_id: advanceId, facility_id: fid, partner_haircut_reserve_cents: reserve, partner_contribution_cents: String(rec.payload("warehouse.advance.approved")?.["partner_contribution_cents"] ?? "0") }, detail: { sources: { haircut_reserve: src("table", `ledger_lines:partner_haircut_reserve@${reserveRef} (balance)`, "27.1"), approved: src("event", `warehouse.advance.approved:${rec.last("warehouse.advance.approved")?.id ?? ""}`, "27.1"), accepted: src("event", `funding.wire.accepted:${accepted.id}`, "26.3") } } });
  }
  return { wait: { status: "waiting_human", waiting_on: "funding_approver", clocked: true } };
}
const wireReleased: StepDef = {
  name: "wire_released",
  exit: exitOn("loan.funded"),
  entryWait: () => ({ status: "waiting_human", waiting_on: "settlement_agent", clocked: true }),
  clocked: () => true,
  actions: async (ctx) => {
    let rec = ctx.rec; const now = ctx.now;
    const funding = rec.payload("funding.requested")!; const fundingId = String(funding["funding_id"]); const accepted = rec.last("funding.wire.accepted")!;
    // 27.1: the warehouse wire package to the funding_approver (dual control; the FAKE approver in reviewers.ts) → warehouse.advance.funded
    const booking = await bookAdvance(ctx); if (booking) return booking;
    // 26.3: the settlement agent's receipt confirmation (FAKE agent through the portal) and the final settlement statement → confirmDisbursement → loan.funded
    if (!rec.has("funding.agent_receipt.confirmed") && !rec.has("funding.funds_at_agent")) {
      const receipt = ctx.fakes.settlementAgent.receiptConfirmation(String(accepted.payload["accepted_at"] ?? accepted.occurredAt));
      await ctx.run({ process: "26.3", name: "notifySettlementAgent", actor: FUNDER, input: { funding_id: fundingId, op: "agent_receipt", funds_received_by_agent_at: receipt.funds_received_by_agent_at, channel: receipt.channel, confirmed_by: "settlement_agent" }, detail: { sources: { agent: src("platform", "FAKE settlement agent portal confirmation", "35.6"), accepted: src("event", `funding.wire.accepted:${accepted.id}`, "26.3") } } });
      rec = await ctx.refresh();
    }
    // 26.3 rule 6 (wet: table_funds_then_authorize): after 26.2's execution review the disbursement authorization (the funding number) goes to the agent through the verified channel — `funding.disbursement.authorized`; the agent disburses only on it
    if (String(funding["funding_type"]) === "wet" && !rec.has("funding.disbursement.authorized")) {
      const review = rec.last("closing.execution_review.passed"); if (!review) throw new RecordGap("closing.execution_review.passed", "26.2's execution review has not passed (the wet-state authorization cites it)");
      await ctx.run({ process: "26.3", name: "notifySettlementAgent", actor: FUNDER, input: { funding_id: fundingId, op: "disbursement_authorization", execution_review_passed_at: String(review.payload["reviewed_at"] ?? review.occurredAt), issued_at: now, channel: "portal", funding_number: `FN-${rec.app.id.slice(0, 8)}` }, detail: { sources: { review: src("event", `closing.execution_review.passed:${review.id}`, "26.2"), receipt: src("event", `funding.agent_receipt.confirmed:${rec.last("funding.agent_receipt.confirmed")?.id ?? ""}`, "26.3") } } });
      rec = await ctx.refresh();
    }
    const ws = rec.entities("funding_worksheets", (d) => d["funding_id"] === fundingId).at(-1);
    const cd = cdRow(rec)!; const cdF = (cd.data["figures"] as Row | undefined) ?? {};
    const escrowDeposit = cents(cdF["initial_escrow_payment_cents"] ?? 0);
    const final = ctx.fakes.settlementAgent.finalStatement(rec.app.id, { net_wire_cents: cents(ws?.data["net_wire_cents"] ?? 0), escrow_deposit_cents: escrowDeposit }, String(accepted.payload["accepted_at"] ?? accepted.occurredAt), now);
    if (!final) return { wait: { status: "waiting_human", waiting_on: "settlement_agent", clocked: true } };
    const docId = await storeDocument(ctx.rt.db, { kind: "final_settlement_statement", application_id: rec.app.id, loan_id: null, text: JSON.stringify({ statement_id: final.statement_id, kind: final.kind, requested_net_cents: String(final.requested_net_cents), escrow_deposit_cents: String(final.escrow_deposit_cents), received_at: final.received_at }), retention_class: "life_of_loan_plus_4y", source: `FAKE settlement agent ${final.statement_id}`, now, source_channel: "vendor_delivery" });
    if (final.escrow_deposit_cents !== escrowDeposit) return { hold: { reason: "money_mismatch", detail: { field: "escrow_deposit_cents", statement_cents: String(final.escrow_deposit_cents), cd_cents: String(escrowDeposit), statement_source: src("table", `documents:${docId}`, "35.2"), cd_source: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2") } } };
    await ctx.run({ process: "26.3", name: "confirmDisbursement", actor: FUNDER, input: { funding_id: fundingId, disbursement_date: String(funding["disbursement_date"]), confirmed_at: now, source: "final_settlement_statement", evidence_document_id: docId, escrow_deposit_cents: String(final.escrow_deposit_cents) }, detail: { sources: { statement: src("table", `documents:${docId} (FAKE settlement agent ${final.statement_id})`, "35.2"), cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2"), advance_funded: src("event", `warehouse.advance.funded:${rec.last("warehouse.advance.funded")?.id ?? ""}`, "27.1") } } });
    return {};
  },
};

export const closingSteps: readonly StepDef[] = [
  { name: "clear_to_close", exit: exitOn("closing.scheduled"), entryWait: () => ({ status: "waiting_borrower", waiting_on: "borrower", clocked: false }), clocked: () => false, idleWait: () => ({ status: "waiting_borrower", waiting_on: "borrower", clocked: false }) },
  closingScheduled, cdDelivered, documentsReleased, consummated, executionReviewed,
];
export const fundingSteps: readonly StepDef[] = [fundingAuthorized, wireReleased];

// ───────────────────────────── unwinding (T15): the owners' unwind in the owners' order ─────────────────────────────
export const unwindStep: StepDef = {
  name: "unwinding",
  exit: exitOn("funding.unwind.completed"),
  actions: async (ctx): Promise<StepOutcome> => {
    let rec = ctx.rec; const now = ctx.now; const closing = closingFacts(rec);
    const funding = rec.payload("funding.requested"); if (!funding) return { wait: { status: "unwinding", waiting_on: "26.3" } };
    const fundingId = String(funding["funding_id"]);
    const exercised = rec.last("rescission.exercised"); const cancelled = rec.last("funding.cancelled");
    if (!rec.entities("funding_unwinds", (d) => d["funding_id"] === fundingId).length && !cancelled) {
      // the trigger is the record's: 25.3's exercise (pre/post disbursement by `loan.funded`), the officer's `orchestration.unwind{reason}` when the reason is one of 26.3's triggers, 26.2's unrecoverable execution review; anything else is not an unwind this process may open
      const requested = rec.last("orchestration.unwind.requested"); const reviewFailed = rec.last("closing.execution_review.failed", executionReviewUnrecoverable);
      const requestedReason = S(requested?.payload["reason"]);
      const trigger: UnwindTrigger = exercised ? (rec.has("loan.funded") ? "rescission_exercised_post_disbursement" : "rescission_exercised_pre_disbursement") : requestedReason && UNWIND_TRIGGERS.includes(requestedReason as UnwindTrigger) ? (requestedReason as UnwindTrigger) : reviewFailed ? "conditions_failed" : ctx.halt({ hold: { reason: "gate_closed", gate: "UNWIND_TRIGGER", detail: { reason: requestedReason, message: `orchestration.unwind reason ${requestedReason ?? "(none)"} is not one of 26.3's unwind triggers (${UNWIND_TRIGGERS.join(", ")})` } } });
      await ctx.run({ process: "26.3", name: "openUnwind", actor: FUNDER, input: { funding_id: fundingId, op: "open", unwind_id: `UNW-${rec.app.id.slice(0, 8)}`, trigger, ...(exercised ? { exercise: { exercise_id: String(exercised.payload["exercise_id"]), refund_due_at: exercised.payload["refund_due_at"] ?? null } } : {}), enote: closing?.note_form === "enote", security_instrument_recorded: rec.has("recording.confirmed"), prior_lien_paid: rec.has("payoff.disbursed") || rec.has("payoff.wire.sent"), at: now }, detail: { sources: { trigger: exercised ? src("event", `rescission.exercised:${exercised.id}`, "25.3") : requested && UNWIND_TRIGGERS.includes(requestedReason as UnwindTrigger) ? src("event", `orchestration.unwind.requested:${requested.id}`, "35.6") : src("event", `closing.execution_review.failed:${reviewFailed?.id ?? ""}`, "26.2") } } });
      rec = await ctx.refresh();
    }
    // 26.4's MIN reversal (SM_O74_MIN_REVERSAL_2BD) for any note form whose MIN 26.4 registered; the eNote's own eRegistry registration is reversed by 26.2 when no 26.4 row carries it
    const sor = rec.entities("mers_registrations", (d) => d["status"] !== "reversed").at(-1);
    if (sor && !rec.has("mers.min.reversed", (p) => p["min"] === sor.data["min"])) await ctx.run({ process: "26.4", name: "registerMin", actor: POST_CLOSING, input: { op: "reverse", min: String(sor.data["min"]), reason: exercised ? "rescission_exercised" : "never_funded", submitted_at: now }, detail: { sources: { registration: src("entity", `mers_registrations:${sor.id}:${sor.version}`, "26.4") } } });
    else if (!sor && closing?.note_form === "enote" && rec.has("enote.registered") && !rec.has("enote.registration.reversed")) await ctx.run({ process: "26.2", name: "reverseRegistration", actor: CLOSER, input: { closing_id: closing.closing_id, reason: exercised ? "rescission_exercised" : "never_funded" }, detail: { sources: { registered: src("event", `enote.registered:${rec.last("enote.registered")?.id ?? ""}`, "26.2") } } });
    return { wait: { status: "unwinding", waiting_on: "26.3" } };
  },
};
export { plus, exitOn, DISCLOSURE, ESCROW, COMPLIANCE, S, civil, recordSnapshot };
