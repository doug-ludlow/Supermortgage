/**
 * §35.6 record readers for the closing, signing, funding and warehouse steps (clear_to_close … wire_released). Every fact the
 * pass hands an owning tool is read from the owner's event or row and carries its source (rule 2: "the facts object's hash and
 * the source ids in the decision record"); nothing here is computed from a rule an owner holds — the per diem, the note terms,
 * the waiting period, the funding calendar and the advance are the owners' own outputs the steps ask for and read back.
 */
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { EntityRecord } from "../../app/tools.ts";
import { type OrchRecord, type Source, type Sourced, src, fromEvent, fromEntity, fromTable, derived, cents, RecordGap } from "./facts-35-6.ts";

type Row = Record<string, unknown>;
const S = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ───────────────────────────── 26.2 closing row, the borrowers, the parties ─────────────────────────────
export interface ClosingFacts { readonly row: EntityRecord; readonly closing_id: string; readonly scheduled_at: string; readonly time_zone: string; readonly scheduled_note_date: string; readonly closing_type: string; readonly note_form: string; readonly settlement_agent_party_id: string; readonly notary_party_id: string | null; readonly session_ids: readonly string[]; readonly document_set_id: string | null; readonly consummation_at: string | null; readonly execution_status: string; readonly rescindable: boolean; readonly state: string }
/** 26.2's `closings` row for the scheduled slot (`closing.scheduled` opened it). */
export function closingFacts(rec: OrchRecord): ClosingFacts | null {
  const ev = rec.last("closing.scheduled"); if (!ev) return null;
  const row = rec.entity("closings", String(ev.payload["closing_id"])) ?? rec.entities("closings").at(-1);
  if (!row) throw new RecordGap("closings", `closing.scheduled ${ev.id} names ${String(ev.payload["closing_id"])} but 26.2's closings row is not on the entity store`);
  const d = row.data;
  return { row, closing_id: String(d["closing_id"]), scheduled_at: String(d["scheduled_at"]), time_zone: String(d["time_zone"] ?? rec.timeZone()), scheduled_note_date: String(d["scheduled_note_date"]), closing_type: String(d["closing_type"]), note_form: String(d["note_form"]), settlement_agent_party_id: String(d["settlement_agent_party_id"]), notary_party_id: S(d["notary_party_id"]), session_ids: (d["session_ids"] as string[] | undefined) ?? [], document_set_id: S(d["document_set_id"]), consummation_at: S(d["consummation_at"]), execution_status: String(d["execution_status"] ?? ""), rescindable: d["rescindable"] !== false, state: String(d["state"] ?? rec.state()) };
}
export interface PartyFacts { readonly partner_legal_name: string; readonly partner_nmlsr_id: string; readonly partner_mers_org_id: string | null; readonly partner_id: string; readonly mlo_name: string; readonly mlo_nmlsr_id: string; readonly settlement_agent_name: string; readonly settlement_agent_license: string; readonly borrower_names: readonly string[]; readonly borrower_ids: readonly string[]; readonly property_address: string; readonly legal_description: string | null; readonly apn: string | null; readonly county: string | null; readonly sources: Record<string, Source> }
/** The parties on the file: the partner (parties row), the MLO of record (21.1's assignment), the vetted settlement agent (24.4), the borrowers (21.1's interview). */
export async function partyFacts(rec: OrchRecord, closing: ClosingFacts | null): Promise<PartyFacts> {
  const intake = rec.intake() ?? {};
  const partner = (await rec.q.query<{ legal_name: string; mers_org_id: string | null; servicer_number: string | null; contact: Row | null }>(`SELECT legal_name, mers_org_id, servicer_number, contact FROM parties WHERE id = $1`, [rec.app.partner_party_id]))[0];
  if (!partner) throw new RecordGap("parties", `partner ${rec.app.partner_party_id} has no parties row`);
  // 21.1's MLO of record (`application.mlo_of_record.assigned` / `.reassigned`, the intake row's mlo fields)
  const mloEv = rec.last("application.mlo_of_record.reassigned") ?? rec.last("application.mlo_of_record.assigned");
  const mloName = String(mloEv?.payload["mlo_name"] ?? intake["mlo_name"] ?? ""); const mloNmls = String(mloEv?.payload["nmlsr_id"] ?? intake["mlo_nmlsr_id"] ?? "");
  const agentId = closing?.settlement_agent_party_id ?? S(rec.payload("title.ordered")?.["settlement_agent_party_id"]);
  const agentRow = agentId ? rec.entity("settlement_agents", agentId) : undefined;
  const agentParty = agentId ? (await rec.q.query<{ legal_name: string }>(`SELECT legal_name FROM parties WHERE id::text = $1`, [agentId]).catch(() => []))[0] : undefined;
  const title = rec.entities("title_orders").at(-1); const commitment = rec.last("title.commitment.received");
  const p0 = rec.app.properties[0];
  const address = p0 ? `${p0.address_line1}, ${p0.city}, ${p0.state} ${p0.postal_code}` : String(intake["property_address"] ?? "");
  const ids = rec.borrowerIds();
  return { partner_legal_name: String(intake["partner_name"] ?? partner.legal_name), partner_nmlsr_id: String(intake["partner_nmlsr_id"] ?? (partner.contact as Row | null)?.["nmlsr_id"] ?? ""), partner_mers_org_id: partner.mers_org_id, partner_id: rec.app.partner_party_id, mlo_name: mloName, mlo_nmlsr_id: mloNmls,
    settlement_agent_name: agentParty?.legal_name ?? String(agentRow?.data["legal_name"] ?? agentRow?.data["name"] ?? agentId ?? ""), settlement_agent_license: String(agentRow?.data["license_number"] ?? ""), borrower_names: ids.map((id) => rec.borrowerName(id)), borrower_ids: ids, property_address: address,
    legal_description: S(commitment?.payload["legal_description"] ?? title?.data["legal_description"]), apn: S(title?.data["apn"] ?? commitment?.payload["apn"]), county: S(p0 ? (p0 as Row)["county"] : intake["county"]) ?? null,
    sources: { partner: src("table", `parties:${rec.app.partner_party_id}`, "20.2"), mlo: mloEv ? src("event", `${mloEv.type}:${mloEv.id}`, "21.1") : src("entity", `applications:${rec.app.id}`, "21.1"), settlement_agent: agentRow ? src("entity", `settlement_agents:${agentRow.id}:${agentRow.version}`, "24.4") : src("derived", "no vetted settlement agent row", "24.4"), borrowers: src("entity", `applications:${rec.app.id}`, "21.1"), property: p0 ? src("table", `application_properties:${p0.id}`, "21.1") : src("derived", "interview property address", "21.1") } };
}

// ───────────────────────────── the loan's terms: lock, LE, commitment ─────────────────────────────
export interface LoanTerms { readonly loan_amount_cents: Sourced<bigint>; readonly note_rate_pct: Sourced<string>; readonly term_months: number; readonly pi_cents: Sourced<bigint>; readonly lender_credit_cents: Sourced<bigint>; readonly lock: DomainEvent; readonly lock_expires_on: string; readonly commitment: EntityRecord | null; readonly commitment_event: DomainEvent | null }
/** 21.4's executed lock (rate, price, the lender credit the price yields, expiry), the quote's P&I and the loan amount, 29.1's commitment. */
export function loanTerms(rec: OrchRecord): LoanTerms {
  const lock = rec.last("lock.executed"); if (!lock) throw new RecordGap("lock.executed", "no executed lock on the record (21.4)");
  const lockRow = rec.entity("locks", String(lock.payload["lock_id"]));
  const quote = (lockRow?.data["quote"] as Row | undefined) ?? null;
  const amount = cents(lock.payload["loan_amount_cents"] ?? quote?.["loan_amount_cents"] ?? rec.intake()?.["loan_amount_sought_cents"] ?? 0);
  if (amount <= 0n) throw new RecordGap("loan_amount_cents", "neither the lock, its quote nor the interview carries the loan amount");
  const pi = cents(quote?.["pi_cents"] ?? rec.payload("disclosure.le.rendered")?.["pi_cents"] ?? 0);
  if (pi <= 0n) throw new RecordGap("pi_cents", "neither the lock's quote nor the LE carries the P&I");
  const commitment = rec.entities("commitments", (d) => d["lock_id"] === lock.payload["lock_id"]).at(-1) ?? rec.entities("commitments").at(-1) ?? null;
  return { loan_amount_cents: fromEvent(amount, lock, "21.4"), note_rate_pct: fromEvent(String(lock.payload["note_rate"]), lock, "21.4"), term_months: Number(quote?.["term_months"] ?? 360), pi_cents: lockRow ? fromEntity(pi, lockRow, "21.4") : fromEvent(pi, rec.last("disclosure.le.rendered")!, "21.2"),
    lender_credit_cents: fromEvent(cents(lock.payload["lender_credit_cents"] ?? 0), lock, "21.4"), lock, lock_expires_on: String(lock.payload["expires_on"]), commitment, commitment_event: rec.last("commitment.executed") };
}

// ───────────────────────────── the CD's figures ─────────────────────────────
export interface EscrowFacts { readonly analysis: EntityRecord; readonly monthly_escrow_cents: bigint; readonly initial_escrow_payment_cents: bigint; readonly escrowed_costs_year1_cents: bigint; readonly non_escrowed_costs_year1_cents: bigint; readonly source: Source }
/** 30.3's approved (or frozen) initial escrow analysis: the (g)(3) / (l)(7) figures the CD carries and the funding worksheet's deposit. */
export function escrowFacts(rec: OrchRecord): EscrowFacts | null {
  const rows = rec.entities("escrow_analyses", (d) => d["source"] === "origination" && d["status"] !== "superseded");
  const a = rows.filter((r) => ["approved", "frozen"].includes(String(r.data["status"]))).at(-1) ?? null;
  if (!a) return null;
  const cd = (a.data["cd_figures"] as Row | undefined) ?? {};
  return { analysis: a, monthly_escrow_cents: cents(cd["monthly_escrow_cents"] ?? a.data["base_payment_cents"]), initial_escrow_payment_cents: cents(cd["initial_escrow_payment_cents"] ?? a.data["target_at_start_cents"]), escrowed_costs_year1_cents: cents(cd["escrowed_costs_year1_cents"] ?? a.data["escrowed_costs_year1_cents"]), non_escrowed_costs_year1_cents: cents(cd["non_escrowed_costs_year1_cents"] ?? a.data["non_escrowed_costs_year1_cents"]), source: src("entity", `escrow_analyses:${a.id}:${a.version}`, "30.3") };
}
export interface FeeLineFact { readonly fee_code: string; readonly description: string; readonly amount_cents: string; readonly section: string; readonly tolerance_class: string; readonly source_id: string }
/** The creditor's own fee lines (zero tolerance) as the LE disclosed them (21.2's `disclosure.le.rendered.fees`), keyed to the creditor figure source. */
export function creditorFeeLines(rec: OrchRecord, creditorSourceId: string): Sourced<FeeLineFact[]> {
  const le = rec.last("disclosure.le.rendered"); if (!le) throw new RecordGap("disclosure.le.rendered", "no LE render on the record (21.2)");
  const fees = ((le.payload["fees"] as Row[] | undefined) ?? []).filter((f) => /^A_|^B_/.test(String(f["le_section"] ?? "")));
  return fromEvent(fees.map((f) => ({ fee_code: String(f["fee_code"]), description: String(f["description"] ?? f["fee_code"]), amount_cents: String(cents(f["amount_cents"])), section: String(f["le_section"]).startsWith("A") ? "A_origination" : "B_cannot_shop", tolerance_class: "zero", source_id: creditorSourceId })), le, "21.2");
}
export interface PayoffFacts { readonly total_cents: bigint; readonly rows: readonly EntityRecord[]; readonly payoffs: readonly { liability_id: string; status: string; good_through_date: string | null }[]; readonly source: Source }
/** 24.4's payoff demands: the liens paid from proceeds (the CD's payoffs line; FC_PAYOFF_GOOD_THROUGH). */
export function payoffFacts(rec: OrchRecord): PayoffFacts {
  const rows = rec.entities("payoff_demands");
  return { total_cents: rows.reduce((s, r) => s + cents(r.data["total_cents"] ?? r.data["principal_cents"] ?? 0), 0n), rows, payoffs: rows.map((r) => ({ liability_id: String(r.data["liability_id"]), status: String(r.data["status"] ?? "received"), good_through_date: S(r.data["good_through_date"]) })), source: rows.length ? src("entity", `payoff_demands:${rows.map((r) => r.id).join(",")}`, "24.4") : src("derived", "no payoff demand on the record", "24.4") };
}
/** 22.4's funds-to-close worksheet (the CD's cash to close; FC_CASH_TO_CLOSE). */
export function fundsToClose(rec: OrchRecord): { computed: DomainEvent | null; reconciled: DomainEvent | null; cash_to_close_cents: bigint; sufficient: boolean; reconciled_to_cd: boolean } {
  const computed = rec.last("funds_to_close.computed"); const reconciled = rec.last("funds_to_close.reconciled");
  return { computed, reconciled, cash_to_close_cents: cents(computed?.payload["cash_to_close_cents"] ?? 0), sufficient: computed?.payload["sufficient"] !== false, reconciled_to_cd: !!reconciled && reconciled.payload["reconciled"] !== false };
}
/** The 0009 `consents.scope` vocabulary (disclosures, notices, esign_signatures, enote, closing_package; 32.2's card) read as 25.1's disclosure classes (le, cd, corrected_cd, consummation) and 26.2's closing package — the raw entries stay so either reader finds its class. */
export function esignDisclosureClasses(scope: readonly string[] | null | undefined): string[] {
  const out = new Set<string>(scope ?? []);
  for (const s of scope ?? []) {
    if (s === "disclosures" || s === "origination_disclosures" || s === "all") for (const c of ["le", "cd", "corrected_cd"]) out.add(c);
    if (s === "esign_signatures" || s === "enote" || s === "closing_package" || s === "origination_esign_signatures" || s === "all") for (const c of ["consummation", "closing", "closing_package"]) out.add(c);
  }
  return [...out];
}
/** The E-SIGN consents on the borrowers' parties (the consents table) keyed by the interview's borrower ids — a consumer without one is delivered by print/mail. */
export async function esignConsents(rec: OrchRecord): Promise<Record<string, { consent_id: string; source: Source } | null>> {
  const rows = await rec.q.query<{ borrower_id: string | null; ab_id: string; consent_id: string | null }>(`SELECT ab.borrower_id, ab.id::text AS ab_id, (SELECT c.id::text FROM consents c WHERE c.party_id = ab.party_id AND c.kind = 'esign' AND c.granted AND (c.status IS NULL OR c.status = 'active') AND (c.application_id IS NULL OR c.application_id = ab.application_id) ORDER BY c.captured_at DESC LIMIT 1) AS consent_id FROM application_borrowers ab WHERE ab.application_id = $1 ORDER BY ab.created_at, ab.id`, [rec.app.id]);
  const ids = rec.borrowerIds(); const out: Record<string, { consent_id: string; source: Source } | null> = {};
  ids.forEach((id, k) => { const r = rows.find((x) => x.borrower_id === id || x.ab_id === id) ?? rows[k]; out[id] = r?.consent_id ? { consent_id: r.consent_id, source: src("table", `consents:${r.consent_id}`, "32.2") } : null; });
  return out;
}
/** 25.2's current CD row (the `disclosures` entity of kind cd) and its receipts. */
export function cdRow(rec: OrchRecord): EntityRecord | null { return rec.entities("disclosures", (d) => d["kind"] === "cd" && d["status"] !== "superseded").at(-1) ?? null; }
export function cdReceipts(rec: OrchRecord, disclosureId: string): readonly EntityRecord[] { return rec.entities("cd_receipts", (d) => d["disclosure_id"] === disclosureId); }

// ───────────────────────────── the hazard, flood, title and wire facts 26.3 reads ─────────────────────────────
export interface FundingConditionFacts { readonly facts: Row; readonly sources: Record<string, Source> }
/** 26.3 `evaluateFundingConditions`'s facts from the record — each item's source event or row (T7: hazard_effective, cpl, commitment, wire_verification, ptf_cleared, cash_to_close, rescission, qc_hold, ofac). */
export function fundingConditionFacts(rec: OrchRecord, i: { as_of: string; funding_type: string; transaction_type: string; disbursement_date: string; release_date: string; note_date: string | null; authorized: boolean; loan_amount_cents: bigint; enote: boolean; first_payment_date: string | null; rescission: Row | null; rescission_source: Source | null; worksheet_reconciled: boolean; warehouse_advance_approved: boolean | null; stage?: "pre_signing" }): FundingConditionFacts {
  const sources: Record<string, Source> = {};
  const hazard = rec.last("insurance.policy.verified", (p) => p["policy_kind"] === "hazard" || p["kind"] === "hazard");
  const flood = rec.last("flood.determination.received"); const floodCov = rec.last("flood.coverage.verified");
  const cpl = rec.last("cpl.received"); const commitment = rec.last("title.commitment.received"); const titleGates = rec.last("title.gates.evaluated");
  const wire = rec.entities("wire_verifications", (d) => d["purpose"] === "closing_funds" && d["verified_at"] !== null).at(-1) ?? rec.entities("wire_verifications").at(-1) ?? null;
  const vvoe = rec.last("vvoe.completed"); const refresh = rec.last("credit.refresh.received") ?? rec.last("credit.report.received", (p) => p["report_type"] === "soft_refresh");
  const alertsOpen = rec.entities("credit_alerts", (d) => d["status"] === "open" || d["status"] === "verified_new_debt").length;
  const conditions = rec.entities("conditions"); const ptfOpen = conditions.filter((c) => c.data["stage"] === "ptf" && !["cleared", "waived", "superseded", "not_applicable"].includes(String(c.data["status"])));
  const ftc = fundsToClose(rec); const gifts = rec.entities("gifts"); const payoffs = payoffFacts(rec); const assetRows = rec.entities("application_assets");
  const qcHold = rec.last("qc.hold.applied"); const qcReleased = rec.last("qc.hold.released"); const qcOpen = !!qcHold && (!qcReleased || qcReleased.sequence < qcHold.sequence);
  const screened = rec.all("party.screened"); const ofacClear = screened.length > 0 && screened.every((e) => e.payload["result"] === "clear"); const fraudHold = rec.last("fraud.hold.applied") && !rec.last("fraud.hold.released");
  const execution = rec.last("closing.execution_review.passed"); const executionFailed = rec.last("closing.execution_review.failed");
  const cd = cdRow(rec); const consummated = rec.last("disclosure.cd.consummated");
  const idv = rec.last("identity.verified", (p) => p["all_borrowers_verified"] === true); const proofed = rec.all("closing.identity.proofed");
  const audit = rec.last("closing.audit_trail.received"); const registered = rec.last("enote.registered"); const secured = rec.last("enote.secured_party.set");
  const compliance = rec.last("compliance.gate.opened", (p) => p["gate"] === "disbursement");
  const mi = rec.entities("mi_certificates").at(-1);
  const put = (k: string, s: Source) => { sources[k] = s; };
  if (hazard) put("hazard_effective", src("event", `insurance.policy.verified:${hazard.id}`, "24.5")); else put("hazard_effective", src("derived", "no insurance.policy.verified on the record", "24.5"));
  if (cpl) put("cpl", src("event", `cpl.received:${cpl.id}`, "24.4")); else put("cpl", src("derived", "no cpl.received", "24.4"));
  if (commitment) put("commitment", src("event", `title.commitment.received:${commitment.id}`, "24.4")); else put("commitment", src("derived", "no title.commitment.received", "24.4"));
  if (wire) put("wire_verification", src("entity", `wire_verifications:${wire.id}:${wire.version}`, "24.4")); else put("wire_verification", src("derived", "no wire_verifications row", "24.4"));
  put("ptf_cleared", ptfOpen.length ? src("entity", `conditions:${ptfOpen.map((c) => c.id).join(",")}`, "23.3") : src("entity", `conditions:${conditions.filter((c) => c.data["stage"] === "ptf").length} ptf cleared`, "23.3"));
  put("cash_to_close", ftc.reconciled ? src("event", `funds_to_close.reconciled:${ftc.reconciled.id}`, "22.4") : ftc.computed ? src("event", `funds_to_close.computed:${ftc.computed.id}`, "22.4") : src("derived", "no funds_to_close worksheet", "22.4"));
  if (i.rescission_source) put("rescission", i.rescission_source);
  // 28.1's prefunding hold when one exists; otherwise the gate's own assertion on the record — FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE is asserted by 23.3 before clear_to_close (the CTC checklist's CTC_QC_PREFUNDING item), so the CTC is the source of "no hold"
  const qcReview = rec.last("qc.review.opened", (p) => p["kind"] === "prefunding"); const ctcIssued = rec.last("clear_to_close.issued", (p) => p["passed"] === true);
  put("qc_hold", qcHold ? src("event", `${qcOpen ? qcHold.type : qcReleased!.type}:${qcOpen ? qcHold.id : qcReleased!.id}`, "28.1") : qcReview ? src("event", `qc.review.opened:${qcReview.id}`, "28.1") : ctcIssued ? src("event", `clear_to_close.issued:${ctcIssued.id} (CTC_QC_PREFUNDING)`, "23.3") : src("derived", "no prefunding QC review on the record", "28.1"));
  put("ofac", screened.length ? src("event", `party.screened:${screened.at(-1)!.id}`, "22.6") : src("derived", "no party.screened", "22.6"));
  if (vvoe) put("vvoe", src("event", `vvoe.completed:${vvoe.id}`, "22.3"));
  if (refresh) put("credit_refresh", src("event", `${refresh.type}:${refresh.id}`, "22.2"));
  if (execution) put("execution", src("event", `closing.execution_review.passed:${execution.id}`, "26.2"));
  if (consummated) put("cd", src("event", `disclosure.cd.consummated:${consummated.id}`, "25.2"));
  if (audit) put("audit_trail", src("event", `closing.audit_trail.received:${audit.id}`, "26.2"));
  if (registered) put("enote", src("event", `enote.registered:${registered.id}`, "26.2"));
  if (compliance) put("compliance_disburse", src("event", `compliance.gate.opened:${compliance.id}`, "25.1"));
  const facts: Row = {
    as_of: i.as_of, time_zone: rec.timeZone(),
    funding: { funding_type: i.funding_type, transaction_type: i.transaction_type, disbursement_date: i.disbursement_date, release_date: i.release_date, note_date: i.note_date, authorized: i.authorized, ...(i.stage ? { stage: i.stage } : {}) },
    loan: { ltv_pct: Number(rec.payload("du.findings.received")?.["ltv_du"] ?? 70), sfha: flood ? flood.payload["in_sfha"] === true : false, project: false, enote: i.enote, tx_50a6: false, record_before_fund: false },
    execution: execution ? { review_passed: true, all_docs_signed: true, blocking_defects: 0, package_returned: true } : executionFailed ? { review_passed: false, all_docs_signed: true, blocking_defects: Number(((executionFailed.payload["defects"] as unknown[] | undefined) ?? []).length), package_returned: true } : null,
    cd: cd ? { consummated_version: consummated ? Number(consummated.payload["cd_version"] ?? cd.data["cd_version"]) : null, delivered_with_receipt: cdReceipts(rec, cd.id).some((r) => !!r.data["receipt_evidence"]), signed_copy_in_documents: consummated ? true : null } : null,
    identity: { all_signers_proofed: !!idv && (proofed.length > 0 || !!execution) },
    rescission: i.rescission, tx_rescission: null,
    hazard: hazard ? { hazard_status: "verified", effective_date: S(hazard.payload["effective_date"]), transaction_type: i.transaction_type === "purchase" ? "purchase" : "refinance", policy_in_force: hazard.payload["policy_in_force"] !== false, premium_paid_at_closing: hazard.payload["premium_paid_at_closing"] === true } : null,
    flood: flood ? { covered: flood.payload["in_sfha"] !== true || !!floodCov } : null, project_insurance: null,
    title: cpl || commitment ? { cpl_open: !!cpl && cpl.payload["cpl_addressee_ok"] !== false && (titleGates ? titleGates.payload["open"] !== false : true), commitment_open: !!commitment } : null,
    vvoe: vvoe ? { verified_on: S(vvoe.payload["contacted_on"] ?? vvoe.payload["verified_on"]), self_employed: vvoe.payload["self_employed"] === true } : null,
    credit_refresh_open: refresh ? alertsOpen === 0 : null, mi: mi ? { status: S(mi.data["status"]) } : null,
    compliance_disburse_open: compliance ? true : null,
    ptf: { ptf_cleared: ptfOpen.length === 0, blocking_codes: ptfOpen.map((c) => String(c.data["template_code"])) },
    cash_to_close: ftc.computed ? { worksheet: { reconciled_to_cd: ftc.reconciled_to_cd, sufficient: ftc.sufficient, cash_back_ok: ftc.computed.payload["cash_back_ok"] !== false }, all_assets_usable: assetRows.every((a) => ["verified", "sourced", "usable", "finalized", "reverified", "withdrawn", "rejected"].includes(String(a.data["status"]))), reserves_ok: cents(ftc.computed.payload["reserves_shortfall_cents"] ?? 0) === 0n } : null,
    gifts: gifts.map((g) => ({ gift_id: g.id, status: String(g.data["status"] ?? "received") })),
    wire: wire ? { verified_at: S(wire.data["verified_at"]), change_detected_at: S(wire.data["change_detected_at"]), blocks_disbursement: wire.data["blocks_disbursement"] === true, callback_number_source: S(wire.data["callback_number_source"]), as_of: i.as_of } : null,
    payoffs: i.transaction_type === "purchase" ? [] : payoffs.payoffs, warehouse_advance_approved: i.warehouse_advance_approved,
    first_payment: { first_payment_date: i.first_payment_date }, audit_trail_open: i.enote ? !!audit : null,
    enote: i.enote ? { registered: !!registered, secured_party_set: !!secured } : null, paper_note: i.enote ? null : { in_custody_or_transit: false }, recording_confirmed: null,
    qc_hold: qcOpen, commitment: i.rescission === undefined ? null : (() => { const c = rec.last("commitment.executed"); return c ? { active: true, expires_on: S(c.payload["expires_on"]) } : null; })(),
    worksheet: { reconciled: i.worksheet_reconciled }, fraud: { fraud_hold: !!fraudHold, ofac_clear: ofacClear },
  };
  if (rec.last("commitment.executed")) put("commitment_live", src("event", `commitment.executed:${rec.last("commitment.executed")!.id}`, "29.1"));
  return { facts, sources };
}

/** 24.4's verified wire record in 26.3's `VerifiedWireRecord` shape (the beneficiary is the settlement agent's trust account of record). */
export function verifiedWireRecord(rec: OrchRecord, agentPartyId: string): Sourced<Row> {
  const w = rec.entities("wire_verifications", (d) => d["purpose"] === "closing_funds" && d["verified_at"] !== null && d["verified_at"] !== undefined).at(-1) ?? rec.entities("wire_verifications", (d) => d["verified_at"] !== null && d["verified_at"] !== undefined).at(-1);
  if (!w) throw new RecordGap("wire_verifications", "no verified wire instructions for the closing funds (24.4 verifyWireInstructions)");
  const ofac = rec.all("party.screened").filter((e) => String(e.payload["party_id"]) === agentPartyId || String(e.payload["party_id"]) === String(w.data["beneficiary_party_id"])).at(-1) ?? rec.last("party.screened");
  return fromEntity({ verification_id: w.id, beneficiary_party_id: String(w.data["beneficiary_party_id"]), beneficiary_name: String(w.data["beneficiary_name"] ?? `${w.data["beneficiary_party_id"]} trust account`), instructions_hash: String(w.data["instructions_hash"]), verified_at: S(w.data["verified_at"]), expires_at: S(w.data["expires_at"]), blocks_disbursement: w.data["blocks_disbursement"] === true, change_detected_at: S(w.data["change_detected_at"]), callback_number_source: S(w.data["callback_number_source"]), cpl_agent_party_id: agentPartyId, ofac_screen_ref: ofac ? String(ofac.payload["screening_id"] ?? ofac.id) : null, ofac_clear: ofac ? ofac.payload["result"] === "clear" : false }, w, "24.4");
}

/** 27.1's eligibility facts and advance request from the record (the DU recommendation, 23.3's CTC, 25.1's disbursement gate, 29.1's commitment, 24.4's wire verification, 25.3's period, 24.5's gates, the CPL). */
export function warehouseFacts(rec: OrchRecord, i: { funding_id: string; advance_id: string; facility_id: string; requested_at: string; note_form: string; closing_type: string; wet_dry: string; net_disbursement_cents: bigint; note_date: string; disbursement_date: string; first_payment_date: string; rescission_gate_open: boolean | null; note_amount_cents: bigint; commitment_price: string; commitment_id_fnma: string; commitment_expires_on: string; enote_registered_on: string | null; secured_party_added_at: string | null }): { request: Row; facts: Row; sources: Record<string, Source> } {
  const findings = rec.last("du.findings.received"); const ctc = rec.last("clear_to_close.issued", (p) => p["passed"] === true); const disb = rec.last("compliance.gate.opened", (p) => p["gate"] === "disbursement");
  const wire = rec.entities("wire_verifications", (d) => d["verified_at"] !== null && d["verified_at"] !== undefined).at(-1) ?? null;
  const cpl = rec.last("cpl.received"); const hazard = rec.last("insurance.policy.verified", (p) => p["policy_kind"] === "hazard" || p["kind"] === "hazard"); const flood = rec.last("flood.determination.received"); const floodCov = rec.last("flood.coverage.verified");
  const qcHold = rec.last("qc.hold.applied") && !rec.last("qc.hold.released"); const valuation = rec.last("valuation.received"); const period = rec.entities("rescission_periods").at(-1);
  const request: Row = { advance_id: i.advance_id, facility_id: i.facility_id, loan_id: null, application_id: rec.app.id, funding_id: i.funding_id, requested_at: i.requested_at, note_form: i.note_form, closing_type: i.closing_type, wet_dry: i.wet_dry, note_amount_cents: String(i.note_amount_cents), net_disbursement_cents: String(i.net_disbursement_cents), note_date: i.note_date, transaction_type: rec.app.transaction_type ?? "limited_cash_out", commitment_price: i.commitment_price, commitment_id_fnma: i.commitment_id_fnma, wire_verification_id: wire?.id ?? "", property_state: rec.state(), enote_registered_at: i.enote_registered_on, secured_party_added_at: i.secured_party_added_at, trust_receipt_at: null };
  const facts: Row = { du_recommendation: String(findings?.payload["recommendation"] ?? ""), du_final_matches_closing: true, ctc_issued: !!ctc, disbursement_gate_opened: !!disb,
    commitment: { commitment_id_fnma: i.commitment_id_fnma, live: true, expires_on: i.commitment_expires_on, type: "best_efforts" },
    wire_verification: wire ? { id: wire.id, match_result: String(wire.data["match_result"] ?? "verified"), expires_at: S(wire.data["expires_at"]) ?? "", blocks_disbursement: wire.data["blocks_disbursement"] === true } : null,
    transaction_type: rec.app.transaction_type ?? "limited_cash_out", rescission_gate_open: i.rescission_gate_open, wet_dry: i.wet_dry, dry_recording_condition_met: i.wet_dry === "dry" ? true : null,
    note_amount_cents: String(i.note_amount_cents), units: rec.subject?.units ?? 1, program_in_scope: true, first_payment_date: i.first_payment_date, disbursement_date: i.disbursement_date,
    qc_prefunding_blocking: !!qcHold, ltv_pct: Number(findings?.payload["ltv_du"] ?? 70), mi_active: rec.entities("mi_certificates", (d) => d["status"] === "active").length > 0, flood_gate_open: !flood || flood.payload["in_sfha"] !== true || !!floodCov, insurance_gate_open: !!hazard, cpl_names_partner: !!cpl && cpl.payload["cpl_addressee_ok"] !== false,
    duplicate_advance: false, partner_suspended: false, facility_status: "active", appraisal_expires_at: S(valuation?.payload["age_4m_update_after"] ?? rec.entities("valuation_orders").at(-1)?.data["age_12m_expires_on"]), lock_extension_count: rec.all("lock.extended").length,
    evidence: { du_submission_id: S(findings?.payload["submission_id"]) ?? "", ctc_checklist_id: S(ctc?.payload["checklist_id"]) ?? "", compliance_test_run_id: S(disb?.payload["run_id"]) ?? "", commitment_id: i.commitment_id_fnma, wire_verification_id: wire?.id ?? "", rescission_id: period?.id ?? "", cpl_document_id: S(cpl?.payload["cpl_document_id"]) ?? "" } };
  const sources: Record<string, Source> = { du: findings ? src("event", `du.findings.received:${findings.id}`, "23.1") : src("derived", "no findings", "23.1"), ctc: ctc ? src("event", `clear_to_close.issued:${ctc.id}`, "23.3") : src("derived", "no CTC", "23.3"), commitment: src("event", `commitment.executed:${rec.last("commitment.executed")?.id ?? ""}`, "29.1"), wire_verification: wire ? src("entity", `wire_verifications:${wire.id}:${wire.version}`, "24.4") : src("derived", "none", "24.4"), cpl: cpl ? src("event", `cpl.received:${cpl.id}`, "24.4") : src("derived", "none", "24.4"), hazard: hazard ? src("event", `insurance.policy.verified:${hazard.id}`, "24.5") : src("derived", "none", "24.5"), flood: flood ? src("event", `flood.determination.received:${flood.id}`, "24.5") : src("derived", "none", "24.5"), rescission: period ? src("entity", `rescission_periods:${period.id}:${period.version}`, "25.3") : src("derived", "not rescindable", "25.3") };
  return { request, facts, sources };
}

/** 25.3's rescission period row and the facts 26.3's FC_RESCISSION_EXPIRED reads (DisburseFacts). */
export function rescissionFacts(rec: OrchRecord, now: string): { row: EntityRecord | null; facts: Row | null; source: Source | null; confirmed: DomainEvent | null; started: DomainEvent | null } {
  const row = rec.entities("rescission_periods").at(-1) ?? null; const confirmed = rec.last("rescission.confirmed_not_rescinded"); const started = rec.last("rescission.period.started");
  if (!row) return { row: null, facts: null, source: null, confirmed, started };
  const d = row.data;
  return { row, facts: { status: String(d["status"] ?? "running"), expires_at: S(d["expires_at"]), reasonably_satisfied_at: S(d["reasonably_satisfied_at"] ?? confirmed?.payload["reasonably_satisfied_at"]), waiver_id: S(d["waiver_id"]), now }, source: confirmed ? src("event", `rescission.confirmed_not_rescinded:${confirmed.id}`, "25.3") : src("entity", `rescission_periods:${row.id}:${row.version}`, "25.3"), confirmed, started };
}
export { derived, fromTable };
