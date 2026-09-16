/**
 * §35.6 record readers for the delivery steps (boarded … certified): 29.3's loan-file base, 29.4's delivery registration,
 * 23.4's delivery gate facts, 23.1's closing ULAD snapshot and the platform's approved warehouse wire instruction. Every
 * fact is the owner's event or row with its source (rule 2); nothing is typed here — a path the record cannot supply is a
 * RecordGap the row waits on (rule 6's discipline applied to delivery).
 */
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { EntityRecord } from "../../app/tools.ts";
import { type OrchRecord, type Source, src, RecordGap } from "./facts-35-6.ts";
import { closingFacts, partyFacts, loanTerms, escrowFacts, cdRow, productFacts, ltvPct, type ClosingFacts } from "./facts-35-6-b.ts";
import { FACILITY_FIXTURE } from "../warehouse/ops-27-1.ts";

type Row = Record<string, unknown>;
const S = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const cents = (v: unknown): bigint => (typeof v === "bigint" ? v : v === null || v === undefined || v === "" ? 0n : BigInt(String(v)));
const bpsToRate = (bps: number): string => (bps / 100).toFixed(3);

/** The platform's approved warehouse-lender wire instruction (29.4 `wire_instructions`, status active): SM's payee code, Receiver Type and Letter Type as Fannie Mae lists them. */
export function wireInstruction(rec: OrchRecord): { row: EntityRecord; wire: Row; source: Source } {
  const row = rec.entities("wire_instructions", (d) => d["status"] === "active" && d["receiver_type"] === "warehouse_lender").at(-1);
  if (!row) throw new RecordGap("wire_instructions", "no active warehouse-lender wire instruction on the platform (29.4 approveWarehouseWire; Fannie Mae Form 482)");
  return { row, wire: { ...row.data }, source: src("entity", `wire_instructions:${row.id}:${row.version}`, "29.4") };
}

/** 29.1's commitment as 29.4 and 29.3 read it: the executed best-efforts commitment on the lock lineage (its row, else 21.4's `commitment.executed`). */
export function commitmentFacts(rec: OrchRecord): { row: EntityRecord | null; event: DomainEvent | null; commitment_id: string; commitment_id_fnma: string; expires_on: string; price: string; pass_through_rate: string; servicing_fee_rate: string; remittance_type: string; type: string; status: string; source: Source } {
  const terms = loanTerms(rec); const row = terms.commitment; const ev = terms.commitment_event;
  if (!row && !ev) throw new RecordGap("commitment.executed", "no best-efforts commitment on the record (21.4 requestCommitment → 29.1)");
  const d = row?.data ?? {}; const p = ev?.payload ?? {};
  const fee = Number(d["servicing_fee_bps"] ?? p["servicing_fee_bps"] ?? 25);
  const rt = String(d["remittance_type"] ?? p["remittance_type"] ?? "actual_actual");
  return { row, event: ev, commitment_id: String(d["commitment_id"] ?? p["commitment_id"] ?? row?.id ?? ""), commitment_id_fnma: String(d["commitment_id_fnma"] ?? p["commitment_id_fnma"] ?? ""), expires_on: String(d["expires_on"] ?? p["expires_on"] ?? ""), price: String(d["commitment_price"] ?? p["price"] ?? ""),
    pass_through_rate: String(d["pass_through_rate"] ?? p["ptr"] ?? ""), servicing_fee_rate: bpsToRate(fee), remittance_type: rt === "aa" || rt === "A/A" ? "actual_actual" : rt, type: String(d["type"] ?? p["type"] ?? "best_efforts"), status: String(d["status"] ?? ""),
    source: row ? src("entity", `commitments:${row.id}:${row.version}`, "29.1") : src("event", `commitment.executed:${ev!.id}`, "29.1") };
}

/** 23.1's closing ULAD snapshot for the final-match assertion: the last findings submission's snapshot with the closing terms (the CD's amount, the lock's rate, 24.2's value) laid over it. */
export function closingUlad(rec: OrchRecord): { snapshot: Row; submission_number: number; casefile_id: string; sources: Record<string, Source> } {
  const subs = [...rec.entities("du_submissions", (d) => d["status"] === "findings_received")].sort((a, b) => Number(a.data["submission_number"]) - Number(b.data["submission_number"]));
  const last = subs.at(-1); if (!last) throw new RecordGap("du_submissions", "no DU submission with findings (23.1)");
  const base = last.data["snapshot"] as Row | undefined; if (!base) throw new RecordGap("du_submissions.snapshot", `submission ${last.id} carries no ULAD snapshot (23.1)`);
  const terms = loanTerms(rec); const cd = cdRow(rec); const cdF = (cd?.data["figures"] as Row | undefined) ?? {}; const loan = (cdF["loan"] as Row | undefined) ?? {};
  const appraisal = [...rec.entities("appraisals", (d) => d["review_status"] !== "rejected")].sort((a, b) => Number(a.data["version_no"] ?? 0) - Number(b.data["version_no"] ?? 0)).at(-1) ?? null;
  const snapshot: Row = { ...base, loan_amount_cents: String(loan["loan_amount_cents"] ?? terms.loan_amount_cents.value), note_rate_pct: terms.note_rate_pct.value, ...(appraisal ? { appraised_value_cents: String(appraisal.data["appraised_value_cents"]) } : {}) };
  return { snapshot, submission_number: Number(last.data["submission_number"]), casefile_id: String(last.data["casefile_id"]), sources: { submission: src("entity", `du_submissions:${last.id}:${last.version}`, "23.1"), lock: terms.note_rate_pct.source, ...(cd ? { cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2") } : {}), ...(appraisal ? { appraisal: src("entity", `appraisals:${appraisal.id}:${appraisal.version}`, "24.2") } : {}) } };
}

/** 23.4's delivery gate facts as 29.4 evaluates them on submitDelivery: the current QM determination, the HOEPA/state high-cost determination. */
export function deliveryGateFacts(rec: OrchRecord): { facts: Row; sources: Record<string, Source> } {
  const qm = rec.last("compliance.qm.determined"); const qmRow = [...rec.entities("qm_determinations")].at(-1) ?? null; const hc = rec.last("compliance.high_cost.determined");
  if (!qm) throw new RecordGap("compliance.qm.determined", "no QM determination on the record (23.4)");
  const p = qm.payload; const d = qmRow?.data ?? {};
  const stage = String(p["stage"] ?? "consummation");
  const facts: Row = { qm_type: String(p["qm_type"]), apr_test_pass: p["apr_test_pass"] === true, pf_pass: p["pf_pass"] === true, product_tests_pass: d["product_tests_pass"] !== undefined ? d["product_tests_pass"] === true : p["product_tests_pass"] !== false, consider_verify_complete: p["consider_verify_complete"] === true,
    consider_verify_missing: Array.isArray(d["consider_verify_missing"]) ? d["consider_verify_missing"] : [], stage, apor_stale: p["apor_stale"] === true, blocked_reason: p["blocked_reason"] ?? null, computed_from_final_cd: stage === "consummation",
    is_hoepa: hc ? hc.payload["is_hoepa"] === true : false, state_tests: hc ? ((hc.payload["state_tests"] as unknown[] | undefined) ?? []) : [] };
  return { facts, sources: { qm: src("event", `compliance.qm.determined:${qm.id}`, "23.4"), ...(qmRow ? { qm_row: src("entity", `qm_determinations:${qmRow.id}:${qmRow.version}`, "23.4") } : {}), high_cost: hc ? src("event", `compliance.high_cost.determined:${hc.id}`, "23.4") : src("derived", "no compliance.high_cost.determined (23.4): no HOEPA/state high-cost determination", "23.4") } };
}

/** 23.4's consummation-stage determination input (`runQmTests{op: stage, stage: consummation, computed_from_final_cd}` — the row 23.4's gates read on consummate/authorizeFunding/submitDelivery), every field from the record: 25.1's cd-checkpoint APR, 21.4's executed lock as the rate-set lock, 23.4's own `apor_tables` rows and the consider-and-verify evidence its LE-stage row carries, the consummated CD's fee lines, 21.4's product, 21.1's subject state/county, 26.2's note date, 30.3's escrow. */
export async function qmConsummationInput(rec: OrchRecord, i: { closing: ClosingFacts; loan_id: string; apr: EntityRecord; cd: EntityRecord }): Promise<{ input: Row; sources: Record<string, Source> }> {
  const terms = loanTerms(rec); const product = productFacts(rec, terms); const parties = await partyFacts(rec, i.closing); const lock = terms.lock;
  const apor = rec.entities("apor_tables"); if (!apor.length) throw new RecordGap("apor_tables", "no APOR table rows on the platform (23.4 reads the FFIEC tables it stored)");
  const prior = rec.entities("qm_determinations", (d) => d["status"] === "current" && Array.isArray(d["consider_verify"])).at(-1) ?? null;
  if (!prior) throw new RecordGap("qm_determinations.consider_verify", "no prior 23.4 determination carrying the consider-and-verify evidence (23.4 assembleAtrEvidence)");
  const consummated = rec.last("closing.consummated"); if (!consummated) throw new RecordGap("closing.consummated", "no closing.consummated (26.2)");
  const subject = rec.app.properties[0]; if (!subject) throw new RecordGap("application_properties", "no subject property (21.1)");
  const kindOf = (section: string): "public_official" | "third_party" | "creditor" => (section === "E_taxes_gov" ? "public_official" : section === "B_cannot_shop" || section === "C_can_shop" ? "third_party" : "creditor");
  const fee_items = ((i.cd.data["fees"] as Row[] | undefined) ?? []).filter((f) => f["fee_code"] !== "escrow_deposit" && String(f["section"] ?? "") !== "G_initial_escrow").map((f) => {
    const code = String(f["fee_code"]); const kind = kindOf(String(f["section"] ?? "")); const paidTo = kind === "creditor" ? parties.partner_legal_name : kind === "public_official" ? `${parties.county ?? subject.state} County Recorder` : parties.settlement_agent_name;
    return { fee_item_id: `${i.cd.id}:${code}`, service_code: code === "prepaid_interest" ? "interest_prepaid" : code, description: String(f["description"] ?? code), amount_cents: String(f["amount_cents"]), paid_to: paidTo, paid_to_kind: kind, payee: paidTo, ...(kind === "creditor" ? { retained_by_creditor: true } : {}), ...(kind === "third_party" ? { affiliate: rec.entities("settlement_agents").at(-1)?.data["affiliate"] === true, reasonable: true } : {}) };
  });
  const lockKind = ["initial", "extension", "relock", "float_down", "renegotiation"].includes(String(lock.payload["kind"])) ? String(lock.payload["kind"]) : "initial";
  const input: Row = { op: "stage", stage: "consummation", apr: String(i.apr.data["apr_disclosed_str"]), apr_calculation_id: String(i.apr.data["apr_calculation_id"] ?? i.apr.id), loan_amount_cents: String(terms.loan_amount_cents.value),
    locks: [{ lock_id: String(lock.payload["lock_id"]), kind: lockKind, locked_at: String(lock.payload["locked_at"] ?? lock.occurredAt), rate_pct: terms.note_rate_pct.value, product: product.amortization === "arm" ? "adjustable" : "fixed", term_years: Math.round(terms.term_months / 12) }],
    apor_tables: apor.map((r) => ({ ...r.data })), fee_items, product: { term_months: terms.term_months, amortization: product.balloon ? "balloon" : "fully_amortizing", substantially_equal_payments: !product.balloon, arm: null }, consider_verify: prior.data["consider_verify"],
    lien: product.lien_position, state: subject.state, county: parties.county, consummation_date: String(consummated.payload["note_date"]), escrow_established_before_consummation: escrowFacts(rec) !== null, computed_from_final_cd: true, loan_id: i.loan_id };
  return { input, sources: { apr: src("entity", `apr_calculations:${i.apr.id}:${i.apr.version}`, "25.1"), lock: terms.note_rate_pct.source, apor_tables: src("entity", apor.map((r) => `apor_tables:${r.id}:${r.version}`).join(","), "23.4"), consider_verify: src("entity", `qm_determinations:${prior.id}:${prior.version}`, "23.4"), fees: src("entity", `disclosures:${i.cd.id}:${i.cd.version}`, "25.2"), product: product.source, consummation: src("event", `closing.consummated:${consummated.id}`, "26.2") } };
}

export interface LoanFileBaseFacts { readonly base: Row; readonly sources: Record<string, Source> }
/** 29.3's LoanFileBase from the record: 30.2's loan row, 21.4's lock and product, 29.1's commitment, DU's final submission and spec file, 24.1/24.2's valuation, 24.5/24.6, 26.2's note and registration, 27.1's facility, 22.2's representative score, 23.4's spread and 28.3's ULI. */
export async function loanFileBase(rec: OrchRecord, i: { loan_id: string; seller_loan_number: string; closing: ClosingFacts; wire: Row }): Promise<LoanFileBaseFacts> {
  const sources: Record<string, Source> = {};
  const terms = loanTerms(rec); const parties = await partyFacts(rec, i.closing); const product = productFacts(rec, terms); const commitment = commitmentFacts(rec);
  const funded = rec.last("loan.funded"); if (!funded) throw new RecordGap("loan.funded", "no loan.funded (26.3)");
  const consummated = rec.last("closing.consummated");
  const noteTerms = ((rec.entities("closing_data_snapshots").at(-1)?.data["payload"] as Row | undefined)?.["note_terms"] as Row | undefined) ?? null;
  if (!noteTerms) throw new RecordGap("closing_data_snapshots.note_terms", "26.1's note terms are not on the record");
  const subject = rec.app.properties[0]; if (!subject) throw new RecordGap("application_properties", "no subject property (21.1)");
  const appraisal = [...rec.entities("appraisals", (d) => d["review_status"] !== "rejected")].sort((a, b) => Number(a.data["version_no"] ?? 0) - Number(b.data["version_no"] ?? 0)).at(-1) ?? null;
  if (!appraisal) throw new RecordGap("appraisals", "no 24.2 appraisal row");
  const valuation = rec.last("valuation.received", (p) => p["declined"] !== true);
  const finalSub = rec.last("du.final_submission.recorded"); const findings = rec.last("du.findings.received"); const casefileRec = rec.last("du.casefile_id.recorded"); const duDoc = rec.last("du.document.emitted");
  if (!finalSub) throw new RecordGap("du.final_submission.recorded", "23.1 has not recorded the final DU submission against the closing terms");
  if (!duDoc) throw new RecordGap("du.document.emitted", "no DU Spec file on the record (23.6)");
  const score = rec.last("credit.representative_score.computed", (p) => p["state"] === "usable"); if (!score) throw new RecordGap("credit.representative_score.computed", "no usable representative score (22.2)");
  const hpml = rec.last("compliance.hpml.determined"); const uli = rec.last("hmda.uli.assigned");
  if (!uli) throw new RecordGap("hmda.uli.assigned", "no ULI on the record (28.3 assignUli)");
  const registered = rec.last("enote.registered"); const lockRow = rec.entity("locks", String(terms.lock.payload["lock_id"]));
  const lockedOn = S(lockRow?.data["rate_set_date"]) ?? rec.civilDate(String(lockRow?.data["locked_at"] ?? terms.lock.occurredAt));
  const extensions = rec.all("lock.extended").map((e) => ({ on: rec.civilDate(e.occurredAt), rate_changed: e.payload["rate_changed"] === true }));
  const advanceFunded = rec.last("warehouse.advance.funded"); const repaid = rec.last("warehouse.advance.repaid");
  const custody = rec.last("custody.record.seeded"); const mi = rec.entities("mi_certificates", (d) => ["active", "activation_requested", "committed", "issued"].includes(String(d["status"]))).at(-1) ?? null;
  const scores = (score.payload["borrower_applicable_scores"] as Record<string, number | null> | undefined) ?? {};
  const usage = rec.app.occupancy === "second_home" ? "SecondHome" : rec.app.occupancy === "investment" ? "Investment" : "PrimaryResidence";
  const put = (k: string, s: Source) => { sources[k] = s; };
  put("loan", src("table", `loans:${i.loan_id}`, "30.2")); put("lock", terms.loan_amount_cents.source); put("product", product.source); put("commitment", commitment.source); put("funded", src("event", `loan.funded:${funded.id}`, "26.3"));
  put("note_terms", src("entity", `closing_data_snapshots:${rec.entities("closing_data_snapshots").at(-1)!.id}`, "26.1")); put("property", src("table", `application_properties:${subject.id}`, "21.1")); put("appraisal", src("entity", `appraisals:${appraisal.id}:${appraisal.version}`, "24.2"));
  put("du_final", src("event", `du.final_submission.recorded:${finalSub.id}`, "23.1")); put("du_document", src("event", `du.document.emitted:${duDoc.id}`, "23.6")); put("credit", src("event", `credit.representative_score.computed:${score.id}`, "22.2")); put("uli", src("event", `hmda.uli.assigned:${uli.id}`, "28.3"));
  if (hpml) put("rate_spread", src("event", `compliance.hpml.determined:${hpml.id}`, "23.4")); if (registered) put("enote", src("event", `enote.registered:${registered.id}`, "26.2")); if (advanceFunded) put("warehouse", src("event", `warehouse.advance.funded:${advanceFunded.id}`, "27.1")); if (custody) put("custody", src("event", `custody.record.seeded:${custody.id}`, "26.2"));
  const escrow = escrowFacts(rec);
  const base: Row = {
    application_id: rec.app.id, loan_id: i.loan_id, partner_id: rec.app.partner_party_id, seller_number: parties.partner_servicer_number ?? "", servicing_loan_number: i.seller_loan_number, purpose: rec.app.transaction_type ?? "limited_cash_out",
    loan_amount_cents: String(terms.loan_amount_cents.value), note_rate_pct: terms.note_rate_pct.value, term_months: terms.term_months, note_date: String(consummated?.payload["note_date"] ?? i.closing.scheduled_note_date), disbursement_date: String(funded.payload["disbursement_date"]), first_payment_date: String(noteTerms["first_payment_date"]), maturity_date: String(noteTerms["maturity_date"]),
    sales_price_cents: rec.app.transaction_type === "purchase" ? S(rec.payload("application.trid_received")?.["sales_price_cents"]) : null, appraised_value_cents: String(appraisal.data["appraised_value_cents"]),
    property: { property_id: subject.property_id ?? subject.id, street: subject.address_line1, city: subject.city, state: subject.state, zip: subject.postal_code, units: rec.subject?.units ?? 1, usage, type: (rec.propertyType() ?? "sfr") === "condo" ? "attached" : "detached" },
    escrowed: !!escrow, initial_escrow_deposit_cents: escrow ? String(escrow.initial_escrow_payment_cents) : null,
    // 29.3 R3(a)/(b): SID 322 = `du_casefiles.casefile_id` of the final submission (`du.final_submission.recorded{casefile_id}`); the UCD's `casefile_id_ucd` must equal it
    du: { casefile_id: String(finalSub.payload["casefile_id"] ?? casefileRec?.payload["casefile_id"] ?? ""), is_final: finalSub.payload["is_final"] !== false, recommendation: String(finalSub.payload["recommendation"] ?? findings?.payload["recommendation"] ?? ""), closed_loan_snapshot_hash: String(finalSub.payload["closed_loan_snapshot_hash"] ?? ""), du_spec_file_sha256: String(duDoc.payload["sha256"]), du_spec_document_id: String(duDoc.payload["document_id"]) },
    valuation: { method: String(valuation?.payload["method"] ?? appraisal.data["method"] ?? "traditional"), offer_date: null, property_data_id: null, special_feature_codes: [] },
    lock: { locked_on: lockedOn, extensions }, commitment: { commitment_id_fnma: commitment.commitment_id_fnma, expires_on: commitment.expires_on, type: commitment.type, remittance_type: commitment.remittance_type, pass_through_rate: commitment.pass_through_rate, servicing_fee_rate: commitment.servicing_fee_rate },
    warehouse: { advance_outstanding: !!advanceFunded && !repaid, payee_code: S(i.wire["payee_code"]), warehouse_lender_id: S(i.wire["warehouse_lender_org_id"]) ?? FACILITY_FIXTURE.fnma_warehouse_lender_id, custodian_fin: S(custody?.payload["custodian_fin"]), bailee_letter_name: S(i.wire["bailee_letter_name"]) ?? FACILITY_FIXTURE.bailee_letter_name },
    note: { form: i.closing.note_form, enote_registered_at: registered ? String(registered.payload["registered_at"] ?? registered.occurredAt) : null, min: S(registered?.payload["min"]) ?? S(rec.payload("closing.scheduled")?.["min"]), closing_type: i.closing.closing_type === "wet" ? "paper" : i.closing.closing_type },
    notarization_kind: i.closing.closing_type === "ron" ? "ron" : i.closing.closing_type === "ipen" ? "rin" : "in_person",
    // 22.2 B3-5.1-02: the representative score is the lowest applicable score across scored borrowers (each borrower's applicable score is the middle of three / lower of two) — MISMO CreditScoreImpairmentType-free; the selection method as ULDD names that rule
    credit: { borrowers: Object.keys(scores).filter((b) => scores[b] !== null).map((b) => ({ borrower_id: b, score_model: String(score.payload["score_model"] ?? "classic_fico") })), representative_score: Number(score.payload["representative_score"]), selection_method: "MiddleOrLowerThenLowest" },
    hmda: { rate_spread_pct: hpml ? S(hpml.payload["spread"]) : null, uli: String(uli.payload["uli"]) },
    subordinations: [], ...(mi ? { mi: { certificate_number: String(mi.data["certificate_number"] ?? ""), mi_company_code: String(mi.data["mi_company_code"] ?? ""), coverage_pct: String(mi.data["coverage_pct"] ?? ""), premium_plan: String(mi.data["premium_plan"] ?? ""), financed_premium_cents: String(mi.data["financed_premium_cents"] ?? "0"), status: String(mi.data["status"]), activated_at: S(mi.data["activated_at"]) } } : {}),
  };
  void cents; void ltvPct; void closingFacts;
  return { base, sources };
}
