/**
 * §26.1 Closing document generation and closing instructions — the pure rules of the `closer` runtime (the
 * `title-closing` agent) over `closing_document_sets` / `closing_documents` / `closing_data_snapshots` /
 * `document_templates` / `document_qc_checks` / `closing_instructions` / `tx_home_equity_reviews` /
 * `buydown_agreements` / `cema_packages` (migration 0073). One small function per rule / T-id; every emitter appends
 * its event with `applicationId` so the origination timers arm (src/kernel/timers/engine.ts isOriginationContext).
 *
 * Events (subject = the application):
 *   closing.document_set.opened{set_id, application_id}                              [arms SM_O71_DOC_GEN_GATE]
 *   closing.data_snapshot.taken{set_id, snapshot_id, payload_hash, cd_version}        [satisfies SM_O71_DOC_GEN_GATE]
 *   closing.documents.generated{set_id, profile, closing_type, note_date, templates}  [arms SM_O71_TEMPLATE_VERSION_GATE, SM_O71_DOC_QC_PASS_GATE]
 *   closing.document_qc.check{set_id, rule_code, result}                              [per rule; DQC_TEMPLATE_VERSION=pass satisfies SM_O71_TEMPLATE_VERSION_GATE]
 *   closing.document_qc.passed{set_id} | closing.document_qc.failed{set_id, failed}   [passed satisfies SM_O71_DOC_QC_PASS_GATE]
 *   closing.documents.released{set_id, released_to, released_to_party_id}             [satisfies SM_O71_DOCS_TO_AGENT_1BD (26.2's closing.scheduled arms it)]
 *   closing.documents.redrawn{set_id, superseded_by_set_id, redraw_reason}
 *   closing.instructions.sent{set_id, instruction_id, version}                        [arms SM_O71_INSTRUCTIONS_ACK_GATE]
 *   closing.instructions.acknowledged{set_id, instruction_id, acknowledged_by}        [satisfies it]
 *   tx.home_equity_review.opened{application_id, is_50a6, f2_refinance, application_date, prior_50a6_closing_date}   [arms TX_50A6_ONE_YEAR_GATE / TX_50F2_NOTICE_3BD / TX_50F2_ONE_YEAR_GATE]
 *   tx.notice_12day.delivered{channel, delivered_on, notice_provided_date, t0, earliest_closing_date}   [arms TX_50A6_12DAY_CLOSING_GATE]
 *   tx.itemization.delivered{source, received_on, earliest_itemization_closing_date}  [arms TX_50A6_ITEMIZATION_1BD_GATE]
 *   tx.f2_notice.delivered{channel, notice_provided_date, earliest_closing_date}      [satisfies TX_50F2_NOTICE_3BD; arms TX_50F2_12DAY_CLOSING_GATE]
 *   rescission.period.expired{basis=tx_50a6, tx=true, expires_on}                     [satisfies TX_50A6_RESCISSION_3D_GATE]
 *   buydown.agreement.executed{application_id, total_subsidy_cents, sfc}
 *   document.template.activated{template_id} · document.template.retired{template_id}
 * Consumed (never re-emitted): `disclosure.cd.delivered` / `disclosure.cd.received` / `disclosure.cd.corrected` (25.2),
 * `closing.scheduled` / `closing.consummated` (26.2), `decision.issued` (23.3).
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, addMonths, addYears, parts, ymd, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, regzSpecific } from "../../kernel/calendar/business.ts";
import { type Cents, levelPayment, monthlyInterest, ratePercent, formatCents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { makeMin, isValidMin, luhnCheckDigit } from "../boarding/min.ts";
import { noteTermsHash } from "../orig-boarding/ops-30-2.ts";

export const CLOSER: Actor = { kind: "agent", id: "title-closing" };
export const RULE_SET_VERSION_26_1 = "fnma.uniform_instruments.2021-07+tx.const.xvi.50+ny.tax.255.v1";
export const UNIFORM_REVISION = "07/2021";
export const UNIFORM_FAMILY = "2021";
export const NOTICE_CLOSING_INSTRUCTIONS = "NTC_SM_CLOSING_INSTRUCTIONS";
export const NOTICE_TX_ITEMIZATION = "NTC_TX_50A6_ITEMIZATION";
export const NOTICE_TX_F2_REFI = "NTC_TX_50F2_REFI_NOTICE";
export const NOTICE_TX_12DAY = "NTC_TX_50A6_12DAY";        // 21.3's package carries it; 26.1 sets the timer
export const NOTICE_H8 = "NTC_REGZ_1026_23_H8";            // 25.3 owns; two copies per consumer in the set
export const RETENTION_LOAN_FILE = "fnma_loan_file_life_plus_4y";
/** B8-7-01: MERS Rider (Form 3158) states; post-closing assignments to MERS are prohibited there. */
export const MERS_RIDER_STATES: readonly string[] = ["MT", "OR", "WA"];
/** B8-7-01: Maine uses the MERS Mortgage Assignment (Form 3749), executed at closing and recorded promptly after the mortgage. */
export const MERS_ASSIGNMENT_STATES: readonly string[] = ["ME"];
/** B8-8-01 products that cannot be eMortgages. */
export const EMORTGAGE_EXCLUDED = ["tx_50a6", "ny_cema", "puerto_rico", "homestyle_renovation", "single_close_ctp", "coop_share"] as const;
/** Dry-funding states (record/disburse only on the funder's written authorization); wet states fund at the table (26.3). */
export const DRY_FUNDING_STATES: readonly string[] = ["AK", "AZ", "CA", "HI", "ID", "NV", "NM", "OR", "WA"];
/** §1002.7(d)(4) community-property / spousal-signature states: the non-borrowing spouse signs the security instrument only. */
export const SPOUSAL_SIGNATURE_STATES: readonly string[] = ["AZ", "CA", "ID", "LA", "NV", "NM", "TX", "WA", "WI"];
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** Canonical JSON (sorted keys, bigint as decimal string) → SHA-256: `closing_data_snapshots.payload_hash`. */
export function canonicalJson(v: unknown): string {
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export const payloadHash = (payload: unknown): string => sha256(canonicalJson(payload));
const D = plainDate;

// ============================================================ jurisdiction rules (late charge; witness; recording) — counsel matrix, 0002 jurisdiction_rules
export interface JurisdictionRule { readonly late_charge_cap_pct: string; readonly late_charge_min_days: number; readonly witness_count: number; readonly verified: boolean; readonly citation: string; }
/** B8-3-02 default 5%/15 days capped by the state row; NY RPL §254-b 2%/15 days (verified); AZ/CA/OH unverified → default until counsel confirms (open question 2). */
export const JURISDICTION_RULES: Record<string, JurisdictionRule> = {
  NY: { late_charge_cap_pct: "2.00", late_charge_min_days: 15, witness_count: 0, verified: true, citation: "NY RPL §254-b" },
  CT: { late_charge_cap_pct: "5.00", late_charge_min_days: 15, witness_count: 2, verified: true, citation: "Conn. Gen. Stat. §47-5" },
  FL: { late_charge_cap_pct: "5.00", late_charge_min_days: 15, witness_count: 2, verified: true, citation: "Fla. Stat. §689.01" },
  GA: { late_charge_cap_pct: "5.00", late_charge_min_days: 15, witness_count: 2, verified: true, citation: "O.C.G.A. §44-14-33" },
  LA: { late_charge_cap_pct: "5.00", late_charge_min_days: 15, witness_count: 2, verified: true, citation: "La. Civ. Code art. 1833" },
  SC: { late_charge_cap_pct: "5.00", late_charge_min_days: 15, witness_count: 2, verified: true, citation: "S.C. Code §30-5-30" },
};
export const DEFAULT_JURISDICTION_RULE: JurisdictionRule = { late_charge_cap_pct: "5.00", late_charge_min_days: 15, witness_count: 0, verified: false, citation: "B8-3-02 default (5%/15 days) pending the counsel matrix" };
export const jurisdictionRule = (state: string): JurisdictionRule => JURISDICTION_RULES[state] ?? DEFAULT_JURISDICTION_RULE;

// ============================================================ document_templates (the versioned uniform-instrument library)
export type TemplateFamily = "note" | "enote" | "security_instrument" | "rider" | "addendum" | "special_purpose" | "affidavit" | "notice" | "closing_instruction" | "closing_receipt" | "allonge" | "urla";
export interface DocumentTemplate {
  readonly template_id: string; readonly form_number: string; readonly family: TemplateFamily; readonly state: string | null;
  readonly product_scope: readonly string[]; readonly revision_date: string; /** the uniform-instrument family the footer belongs to (07/2021 comprehensive update = "2021"); mixing families is a nonstandard document. */
  readonly revision_family: string; readonly mandatory_from: PlainDate | null; readonly retired_after: PlainDate | null;
  readonly authorized_changes_applied: readonly string[]; readonly smart_doc_profile: "none" | "v1_0_2_cat1_closing_dtd_2_3_1";
  readonly status: "draft" | "approved" | "active" | "retired"; readonly counsel_approval_id: string | null;
}
const STATES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"] as const;
/** Fannie Mae numbers the state security instruments 3001…3051 alphabetically (AZ 3003, CA 3005, FL 3010, NY 3033, OH 3036, TX 3044, VA 3047), Puerto Rico 3053. */
export function securityInstrumentForm(state: string): string { if (state === "PR") return "3053"; const i = (STATES as readonly string[]).indexOf(state); if (i < 0) throw new RangeError(`no uniform security instrument for state ${state}`); return String(3001 + i); }
/** B8-3-01: state-specific fixed-rate notes exist only for these states (Notes library, fetched 2026-09-10); otherwise Form 3200. */
export const STATE_NOTE_FORMS: Record<string, string> = { AK: "3202", FL: "3210", ME: "3220", NH: "3230", NY: "3233", PA: "3239", VT: "3246", VA: "3247", WV: "3249", WI: "3250", PR: "3253" };
export const DEED_OF_TRUST_STATES: readonly string[] = ["AK", "AZ", "CA", "CO", "DC", "ID", "MD", "MS", "MO", "MT", "NE", "NV", "NM", "NC", "OR", "TN", "TX", "UT", "VA", "WA", "WV"];
export const securityInstrumentName = (state: string): string => state === "GA" ? "Security Deed" : DEED_OF_TRUST_STATES.includes(state) ? "Deed of Trust" : "Mortgage";
const T = (o: Partial<DocumentTemplate> & Pick<DocumentTemplate, "template_id" | "form_number" | "family">): DocumentTemplate => ({ state: null, product_scope: ["fixed"], revision_date: UNIFORM_REVISION, revision_family: UNIFORM_FAMILY, mandatory_from: D("2023-01-01"), retired_after: null, authorized_changes_applied: [], smart_doc_profile: "none", status: "active", counsel_approval_id: "CA-2026-09-uniform", ...o });
/** The library as transcribed from the Fannie Mae Legal Documents site: 07/2021 family, with the dated state revisions (VA 3047 2026-07-01, CA 3005 2027-01-01, MD 3021 2025-10-01). */
export const DEFAULT_TEMPLATE_LIBRARY: readonly DocumentTemplate[] = [
  T({ template_id: "3200:2021-07", form_number: "3200", family: "note" }),
  T({ template_id: "3200e:2021-07", form_number: "3200e", family: "enote", smart_doc_profile: "v1_0_2_cat1_closing_dtd_2_3_1" }),
  T({ template_id: "3441:2021-07", form_number: "3441", family: "note", product_scope: ["arm_sofr"] }), T({ template_id: "3442:2021-07", form_number: "3442", family: "note", product_scope: ["arm_sofr_fixed_period"] }),
  T({ template_id: "3441e:2021-07", form_number: "3441e", family: "enote", product_scope: ["arm_sofr"], smart_doc_profile: "v1_0_2_cat1_closing_dtd_2_3_1" }),
  T({ template_id: "3244.1:2021-07", form_number: "3244.1", family: "note", state: "TX", product_scope: ["home_equity_tx"] }), T({ template_id: "3442.44:2021-07", form_number: "3442.44", family: "note", state: "TX", product_scope: ["home_equity_tx_arm"] }),
  T({ template_id: "3044.1:2021-07", form_number: "3044.1", family: "security_instrument", state: "TX", product_scope: ["home_equity_tx"] }),
  T({ template_id: "3185:2021-07", form_number: "3185", family: "affidavit", state: "TX", product_scope: ["home_equity_tx"] }),
  T({ template_id: "3172:2021-07", form_number: "3172", family: "special_purpose", state: "NY", product_scope: ["cema_ny"] }),
  T({ template_id: "3140:2021-07", form_number: "3140", family: "rider" }), T({ template_id: "3150:2021-07", form_number: "3150", family: "rider" }), T({ template_id: "3170:2021-07", form_number: "3170", family: "rider" }), T({ template_id: "3890:2021-07", form_number: "3890", family: "rider" }),
  T({ template_id: "3141:2021-07", form_number: "3141", family: "rider", product_scope: ["arm_sofr"] }), T({ template_id: "3142:2021-07", form_number: "3142", family: "rider", product_scope: ["arm_sofr_fixed_period"] }),
  T({ template_id: "3158:2021-07", form_number: "3158", family: "rider", product_scope: ["fixed", "arm_sofr"] }), T({ template_id: "3749:2021-07", form_number: "3749", family: "special_purpose", state: "ME" }),
  ...Object.entries(STATE_NOTE_FORMS).map(([state, form]) => T({ template_id: `${form}:2021-07`, form_number: form, family: "note", state })),
  ...(STATES as readonly string[]).filter((s) => !["VA", "CA", "MD"].includes(s)).map((state) => T({ template_id: `${securityInstrumentForm(state)}:2021-07`, form_number: securityInstrumentForm(state), family: "security_instrument", state })),
  T({ template_id: "3053:2021-07", form_number: "3053", family: "security_instrument", state: "PR" }),
  // May 2026 archive entry: VA 3047 and CA 3005 revised for divorce-related assumptions — effective July 1, 2026 (VA) / January 1, 2027 (CA); the prior revision retires the day before.
  T({ template_id: "3047:2021-07", form_number: "3047", family: "security_instrument", state: "VA", retired_after: D("2026-06-30") }),
  T({ template_id: "3047:2026-05", form_number: "3047", family: "security_instrument", state: "VA", revision_date: "05/2026", mandatory_from: D("2026-07-01"), authorized_changes_applied: ["divorce-related assumption paragraph (May 2026)"] }),
  T({ template_id: "3005:2021-07", form_number: "3005", family: "security_instrument", state: "CA", retired_after: D("2026-12-31") }),
  T({ template_id: "3005:2026-05", form_number: "3005", family: "security_instrument", state: "CA", revision_date: "05/2026", mandatory_from: D("2027-01-01"), status: "approved" }),
  T({ template_id: "3021:2025-06", form_number: "3021", family: "security_instrument", state: "MD", revision_date: "06/2025", mandatory_from: D("2025-10-01"), authorized_changes_applied: ["Paragraph 30 (June 2025)"] }),
  T({ template_id: "URLA_1003_FINAL:2021-01", form_number: "URLA_1003_FINAL", family: "urla", revision_date: "1/2021", mandatory_from: D("2021-03-01") }),
  T({ template_id: "SM_CLOSING_INSTRUCTIONS:2026-09", form_number: "SM_CLOSING_INSTRUCTIONS", family: "closing_instruction", revision_date: "2026-09", mandatory_from: D("2026-09-01") }),
  T({ template_id: "SM_TX_FMV_ACK:2026-09", form_number: "SM_TX_FMV_ACK", family: "special_purpose", state: "TX", revision_date: "2026-09", mandatory_from: D("2026-09-01") }),
  T({ template_id: "SM_TX_CLOSING_RECEIPT:2026-09", form_number: "SM_TX_CLOSING_RECEIPT", family: "closing_receipt", state: "TX", revision_date: "2026-09", mandatory_from: D("2026-09-01") }),
  T({ template_id: "SM_NY_255_AFFIDAVIT:2026-09", form_number: "SM_NY_255_AFFIDAVIT", family: "affidavit", state: "NY", revision_date: "2026-09", mandatory_from: D("2026-09-01") }),
  T({ template_id: "SM_BUYDOWN_AGREEMENT:2026-09", form_number: "SM_BUYDOWN_AGREEMENT", family: "special_purpose", revision_date: "2026-09", mandatory_from: D("2026-09-01") }),
];
/** The active template for a form on a note date (the most recent revision whose mandatory/retired window contains the date). */
export function activeTemplate(library: readonly DocumentTemplate[], form_number: string, note_date: PlainDate): DocumentTemplate | null {
  const live = library.filter((t) => t.form_number === form_number && t.status !== "retired" && t.status !== "draft" && (t.mandatory_from === null || t.mandatory_from <= note_date) && (t.retired_after === null || t.retired_after >= note_date));
  return live.sort((a, b) => (b.mandatory_from ?? "") < (a.mandatory_from ?? "") ? -1 : 1)[0] ?? null;
}
export type TemplateVersionReason = "revision_mix" | "not_yet_mandatory" | "retired" | "not_approved" | "missing_template";
export interface TemplateVersionResult { readonly result: "pass" | "fail"; readonly reason: TemplateVersionReason | null; readonly detail: string | null; readonly families: readonly string[]; readonly per_template: readonly { template_id: string; form_number: string; ok: boolean; reason: TemplateVersionReason | null }[]; }
/** SM_O71_TEMPLATE_VERSION_GATE / DQC_TEMPLATE_VERSION: every template's `mandatory_from ≤ note_date`, `retired_after` null or ≥ note_date, status active/approved, and one revision family across the set (Fact Sheet Jan 2023: "These updated instruments cannot be used with prior versions of any instrument"). */
export function templateVersionCheck(templates: readonly DocumentTemplate[], note_date: PlainDate): TemplateVersionResult {
  const per = templates.map((t) => {
    const reason: TemplateVersionReason | null = t.status === "retired" || (t.retired_after !== null && t.retired_after < note_date) ? "retired" : t.mandatory_from !== null && t.mandatory_from > note_date ? "not_yet_mandatory" : t.status === "draft" ? "not_approved" : null;
    return { template_id: t.template_id, form_number: t.form_number, ok: reason === null, reason };
  });
  const families = [...new Set(templates.map((t) => t.revision_family))];
  if (families.length > 1) return { result: "fail", reason: "revision_mix", detail: `revision families mixed: ${families.join(" / ")} (${templates.map((t) => `${t.form_number} ${t.revision_date}`).join(", ")})`, families, per_template: per };
  const bad = per.find((p) => !p.ok);
  if (bad) return { result: "fail", reason: bad.reason, detail: `${bad.form_number} (${bad.template_id}) ${bad.reason} for note date ${note_date}`, families, per_template: per };
  return { result: "pass", reason: null, detail: null, families, per_template: per };
}

// ============================================================ the closing data snapshot (closing_data_snapshots.payload)
export type Capacity = "borrower" | "trustee" | "settlor" | "non_borrower_title_holder" | "spouse_waiver" | "attorney_in_fact" | "guardian" | "lender_officer" | "witness" | "cosigner";
export interface SnapshotBorrower { readonly party_id: string; readonly legal_name: string; readonly credit_used: boolean; readonly on_title: boolean; readonly capacities: readonly Capacity[]; readonly spouse_of?: string | null; readonly trust?: { readonly name: string; readonly dated: PlainDate } | null; readonly attorney_in_fact?: string | null; }
export interface BuydownInput { readonly kind: "2-1" | "1-0" | "3-2-1" | "1-1"; readonly provider_type: "seller" | "builder" | "lender" | "borrower" | "other_interested_party"; readonly provider_party_id: string; readonly sales_price_cents: Cents | null; readonly cltv_pct: string; }
export interface ArmTerms { readonly plan: string; readonly index: "30_day_average_sofr"; readonly margin_pct: string; readonly first_change_months: number; readonly caps: { first: string; periodic: string; life: string }; }
export interface ClosingSnapshotInput {
  readonly application_id: string; readonly cd_version: number; readonly du_submission_number: string; readonly lock_id: string;
  readonly partner: { readonly legal_name: string; readonly nmlsr_id: string; readonly mers_org_id: string; readonly dba?: string | null };
  readonly mlo_of_record: { readonly name: string; readonly nmlsr_id: string };
  readonly servicer: { readonly name: string; readonly payment_address: string };
  readonly state: string; readonly county: string; readonly property_address: string; readonly unit_number?: string | null; readonly legal_description: string;
  readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out"; readonly occupancy: "primary" | "second_home" | "investment";
  readonly property_type: "sfr" | "condo" | "pud" | "2_4_unit" | "manufactured" | "coop"; readonly units: number; readonly leasehold?: boolean;
  readonly vesting: "individual" | "trust"; readonly vesting_text: string; readonly borrowers: readonly SnapshotBorrower[];
  readonly loan_amount_cents: Cents; readonly note_rate_pct: string; readonly term_months: number; readonly product: "fixed" | "arm"; readonly arm?: ArmTerms | null;
  readonly note_date: PlainDate; readonly scheduled_disbursement_date: PlainDate; readonly scheduled_closing_date: PlainDate;
  readonly escrowed: boolean; readonly rescindable: boolean; readonly buydown?: BuydownInput | null;
  readonly tx_50a6?: boolean; readonly tx_f2_refinance?: boolean; readonly ny_cema?: { readonly prior_liens: readonly { lender: string; recorded_at: PlainDate; instrument_no: string; unpaid_principal_cents: Cents; assignment_received: boolean }[]; readonly new_money_cents: Cents } | null;
  readonly homestyle?: boolean; readonly single_close_ctp?: boolean;
  readonly enote_default: boolean; readonly partner_emortgage_approved: boolean; readonly ron_authorized_state: boolean; readonly settlement_agent_eclosing_eligible: boolean; readonly borrower_declined_electronic: boolean;
  readonly poa?: { readonly agent_name: string; readonly principal_party_id: string; readonly poa_document_id: string } | null;
  readonly min?: string | null;
}
export interface ClosingSnapshot { readonly snapshot_id: string; readonly application_id: string; readonly cd_version: number; readonly du_submission_number: string; readonly lock_id: string; readonly taken_at: string; readonly payload: ClosingSnapshotInput & { readonly note_terms: NoteTerms; readonly min: string }; readonly payload_hash: string; }

// ============================================================ note terms (rule "Note terms (`computeNoteTerms`)")
export interface NoteTermsInput { readonly principal_cents: Cents; readonly note_rate_pct: string; readonly term_months: number; readonly scheduled_disbursement_date: PlainDate; readonly state: string; readonly product?: "fixed" | "arm"; readonly arm?: ArmTerms | null; }
export interface NoteTerms {
  readonly principal_cents: Cents; readonly note_rate_pct: string; readonly term_months: number; readonly first_payment_date: PlainDate; readonly maturity_date: PlainDate; readonly payment_day: 1;
  readonly pi_cents: Cents; readonly late_charge_pct: string; readonly late_charge_days: number; readonly late_charge_on_pi_cents: Cents; readonly prepayment_charge: "none";
  readonly first_month_interest_cents: Cents; readonly first_month_principal_cents: Cents; /** residual after `term_months` rounded payments (negative = overpaid; the servicer adjusts the final payment — not a note term). */ readonly amortization_residual_cents: Cents;
  readonly arm: ArmTerms | null; readonly data_hash: string; readonly jurisdiction_rule: JurisdictionRule;
}
/** First payment = the first day of the second month after the disbursement month when disbursement is after the 1st (a first-of-month disbursement pays the next month). */
export function firstPaymentDate(disbursement: PlainDate): PlainDate { const { y, m, d } = parts(disbursement); return addMonths(ymd(y, m, 1), d > 1 ? 2 : 1); }
export const maturityDate = (first_payment: PlainDate, term_months: number): PlainDate => addMonths(first_payment, term_months - 1);
const pct2 = (s: string): string => Decimal.parse(s).toFixed(2);
const pct3 = (s: string): string => Decimal.parse(s).toFixed(3);
/** Late charge B8-3-02: min(5%, state cap) of the overdue P&I after max(15, state grace) days; 5% of $3,402.62 = $170.13 (half-up). */
export function lateCharge(state: string): { pct: string; days: number } { const jr = jurisdictionRule(state); const cap = Decimal.parse(jr.late_charge_cap_pct); const five = Decimal.parse("5"); return { pct: pct2(cap.cmp(five) < 0 ? cap.toFixed(2) : "5"), days: Math.max(15, jr.late_charge_min_days) }; }
export function computeNoteTerms(i: NoteTermsInput): NoteTerms {
  if (i.principal_cents <= 0n) throw new RangeError("principal_cents must be positive");
  if (!/^\d+(\.\d{1,3})?$/.test(i.note_rate_pct)) throw new RangeError(`note_rate_pct ${i.note_rate_pct} is not a 3-decimal percentage`);
  if (!Number.isInteger(i.term_months) || i.term_months <= 0) throw new RangeError("term_months must be a positive integer");
  const rate = ratePercent(i.note_rate_pct);
  const pi_cents = levelPayment(i.principal_cents, rate, i.term_months);
  const first_payment_date = firstPaymentDate(i.scheduled_disbursement_date);
  const maturity_date = maturityDate(first_payment_date, i.term_months);
  const lc = lateCharge(i.state);
  const late_charge_on_pi_cents = divRound(pi_cents * BigInt(Decimal.parse(lc.pct).mul(Decimal.fromInt(100)).toFixed(0)), 10_000n, "HALF_UP");
  const first_month_interest_cents = monthlyInterest(i.principal_cents, rate);
  let bal = i.principal_cents; for (let n = 0; n < i.term_months; n++) bal -= pi_cents - monthlyInterest(bal, rate);
  const note_rate_pct = pct3(i.note_rate_pct);
  const data_hash = noteTermsHash({ amount_cents: i.principal_cents, note_rate_pct, term_months: i.term_months, first_payment_date, maturity_date, late_charge_pct: lc.pct, late_charge_grace_days: lc.days });
  return { principal_cents: i.principal_cents, note_rate_pct, term_months: i.term_months, first_payment_date, maturity_date, payment_day: 1, pi_cents, late_charge_pct: lc.pct, late_charge_days: lc.days, late_charge_on_pi_cents, prepayment_charge: "none",
    first_month_interest_cents, first_month_principal_cents: pi_cents - first_month_interest_cents, amortization_residual_cents: bal, arm: i.product === "arm" ? (i.arm ?? null) : null, data_hash, jurisdiction_rule: jurisdictionRule(i.state) };
}

// ============================================================ MIN (B8-7-01; MERS Procedures: the member generates component 3)
export interface Min { readonly min: string; readonly org_id: string; readonly sequence: string; readonly check_digit: number; readonly valid: boolean; }
export function generateMin(org_id: string, sequence: string): Min {
  if (!/^\d{7}$/.test(org_id)) throw new RangeError("MERS Org ID is 7 digits");
  if (!/^\d{1,10}$/.test(sequence)) throw new RangeError("MIN sequence is up to 10 digits");
  const min = makeMin(org_id, sequence);
  return { min, org_id, sequence: sequence.padStart(10, "0"), check_digit: luhnCheckDigit(min.slice(0, 17)), valid: isValidMin(min) };
}

// ============================================================ document-set profile selection (`selectDocumentSet`)
export type ClosingType = "ron" | "ipen" | "hybrid" | "wet";
export type DocumentKind = "note" | "enote" | "security_instrument" | "rider_condo" | "rider_pud" | "rider_1_4_family" | "rider_second_home" | "rider_arm" | "rider_mers" | "rider_trust" | "rider_leasehold_cross_default" | "addendum_note" | "poa_copy" | "trust_certification" | "buydown_agreement" | "tx_notice_12day" | "tx_itemization" | "tx_fmv_acknowledgment" | "tx_affidavit_3185" | "tx_closing_receipt" | "tx_f2_notice" | "ny_cema_3172" | "ny_cema_exhibit" | "ny_255_affidavit" | "final_1003" | "closing_instructions" | "closing_receipt" | "name_affidavit" | "rescission_notice_h8" | "mers_assignment_3749" | "other_state";
export type SignatureMethod = "wet" | "esign" | "esign_ron" | "esign_ipen";
export interface Signer { readonly party_id: string; readonly legal_name: string; readonly capacity: Capacity; readonly signature_line: string; readonly signature_method: SignatureMethod; readonly required: boolean; }
export interface SelectedDocument { readonly kind: DocumentKind; readonly form_number: string; readonly revision_date: string | null; readonly template_id: string | null; readonly copies_per_consumer?: number; readonly notarized: boolean; readonly recordable: boolean; readonly executed_by?: "signing_officer" | null; readonly note?: string; }
export type EnoteRefusal = "product_excluded_emortgage" | "partner_not_emortgage_approved" | "enote_not_elected" | "borrower_declined_electronic";
export interface DocumentSetSelection {
  readonly profile: string; readonly closing_type: ClosingType; readonly closing_type_reasons: readonly string[]; readonly enote: boolean; readonly enote_refusal: EnoteRefusal | null;
  readonly note_form: string; readonly security_instrument_form: string; readonly riders: readonly string[]; readonly documents: readonly SelectedDocument[];
  readonly note_signers: readonly Signer[]; readonly security_instrument_signers: readonly Signer[]; readonly nonstandard_document_review: boolean;
  readonly excluded_product: (typeof EMORTGAGE_EXCLUDED)[number] | null; readonly sfc: readonly string[];
}
/** B8-8-01 product exclusions: the eNote reason `product_excluded_emortgage` (TX 50(a)(6), NY CEMA, PR, HomeStyle, single-close C-to-P, co-op). */
export function emortgageExclusion(s: Pick<ClosingSnapshotInput, "state" | "tx_50a6" | "ny_cema" | "homestyle" | "single_close_ctp" | "property_type">): (typeof EMORTGAGE_EXCLUDED)[number] | null {
  if (s.tx_50a6) return "tx_50a6"; if (s.ny_cema) return "ny_cema"; if (s.state === "PR") return "puerto_rico"; if (s.homestyle) return "homestyle_renovation"; if (s.single_close_ctp) return "single_close_ctp"; if (s.property_type === "coop") return "coop_share"; return null;
}
const trustLine = (b: SnapshotBorrower): string => `${b.legal_name}, as Trustee of the ${b.trust!.name} Trust under trust instrument dated ${b.trust!.dated}`;
/** E-2-04 / B8-3-03 / B8-2-03 signature lines: trustee-and-applicant "individually and as Trustee …"; attorney-in-fact "by [agent], as attorney-in-fact"; a name variance needs a name affidavit (never a retyped name). */
export function signatureLine(b: SnapshotBorrower, instrument: "note" | "security_instrument"): string {
  if (b.attorney_in_fact) return `${b.legal_name}, by ${b.attorney_in_fact}, as attorney-in-fact`;
  if (b.trust && b.capacities.includes("trustee")) return b.credit_used && instrument === "note" ? `${b.legal_name}, individually and as Trustee of the ${b.trust.name} Trust under trust instrument dated ${b.trust.dated}` : trustLine(b);
  return b.legal_name;
}
const method = (ct: ClosingType, kind: DocumentKind): SignatureMethod => (kind === "note" ? "wet" : ct === "ron" ? "esign_ron" : ct === "ipen" ? "esign_ipen" : ct === "hybrid" ? "esign" : "wet");
export function noteSigners(s: ClosingSnapshotInput, ct: ClosingType, enote: boolean): Signer[] {
  return s.borrowers.filter((b) => b.credit_used || b.capacities.includes("cosigner")).map((b) => ({ party_id: b.party_id, legal_name: b.legal_name, capacity: b.attorney_in_fact ? "attorney_in_fact" : b.trust && b.capacities.includes("trustee") ? "trustee" : b.capacities.includes("cosigner") && !b.on_title ? "cosigner" : "borrower", signature_line: signatureLine(b, "note"), signature_method: enote ? (ct === "ron" ? "esign_ron" : "esign_ipen") : "wet", required: true }));
}
export function securityInstrumentSigners(s: ClosingSnapshotInput, ct: ClosingType): Signer[] {
  const out: Signer[] = [];
  for (const b of s.borrowers) {
    if (b.on_title || (b.trust && b.capacities.includes("trustee"))) out.push({ party_id: b.party_id, legal_name: b.legal_name, capacity: b.attorney_in_fact ? "attorney_in_fact" : b.trust && b.capacities.includes("trustee") ? "trustee" : b.credit_used ? "borrower" : "non_borrower_title_holder", signature_line: signatureLine(b, "security_instrument"), signature_method: method(ct, "security_instrument"), required: true });
    if (b.capacities.includes("settlor")) out.push({ party_id: b.party_id, legal_name: b.legal_name, capacity: "settlor", signature_line: `${b.legal_name}, Settlor of the ${b.trust?.name ?? ""} Trust`, signature_method: method(ct, "security_instrument"), required: true });
    if (!b.on_title && !b.credit_used && b.spouse_of && SPOUSAL_SIGNATURE_STATES.includes(s.state)) out.push({ party_id: b.party_id, legal_name: b.legal_name, capacity: "spouse_waiver", signature_line: b.legal_name, signature_method: method(ct, "security_instrument"), required: true });
  }
  return out;
}
/** Rules (1)–(8) of "Document-set profile selection": forms, riders, eNote eligibility, closing type and signers from the snapshot; 26.2 executes the closing type chosen here. */
export function selectDocumentSet(s: ClosingSnapshotInput, library: readonly DocumentTemplate[] = DEFAULT_TEMPLATE_LIBRARY): DocumentSetSelection {
  const excluded = emortgageExclusion(s);
  const reasons: string[] = [];
  let enote = false; let enote_refusal: EnoteRefusal | null = null;
  if (excluded) enote_refusal = "product_excluded_emortgage"; else if (s.borrower_declined_electronic) enote_refusal = "borrower_declined_electronic"; else if (!s.partner_emortgage_approved) enote_refusal = "partner_not_emortgage_approved"; else if (!s.enote_default) enote_refusal = "enote_not_elected"; else enote = true;
  let closing_type: ClosingType;
  if (s.tx_50a6) { closing_type = "wet"; reasons.push("product_excluded_esign:tx_50a6 (B5-4.1-03; A2-4.1-03/-04: not eligible for electronic signing, RON or remote ink)"); }
  else if (s.borrower_declined_electronic) { closing_type = "wet"; reasons.push("borrower_declined_electronic_records (A2-4.1-03)"); }
  else if (enote) { if (s.ron_authorized_state && s.settlement_agent_eclosing_eligible) { closing_type = "ron"; reasons.push("enote_eligible+ron_authorized_state+agent_eclosing_eligible"); } else { closing_type = "ipen"; reasons.push(s.ron_authorized_state ? "enote_eligible;agent_not_eclosing_eligible" : "enote_eligible;state_not_ron_authorized"); } }
  else if (s.settlement_agent_eclosing_eligible) { closing_type = "hybrid"; reasons.push(`paper_note_required:${enote_refusal} (hybrid: paper note wet-signed, other documents electronic)`); }
  else { closing_type = "wet"; reasons.push(`paper_note_required:${enote_refusal};agent_not_eclosing_eligible`); }
  const armForm = s.product === "arm" ? (s.tx_50a6 ? "3442.44" : "3442") : null;
  const note_form = s.tx_50a6 ? (armForm ?? "3244.1") : enote ? (armForm ? `${armForm}e` : "3200e") : (armForm ?? STATE_NOTE_FORMS[s.state] ?? "3200");
  const security_instrument_form = s.tx_50a6 ? "3044.1" : securityInstrumentForm(s.state);
  const riders: string[] = [];
  if (s.property_type === "condo") riders.push("3140"); if (s.property_type === "pud") riders.push("3150");
  if (s.occupancy === "investment" || s.units >= 2) riders.push("3170"); if (s.occupancy === "second_home") riders.push("3890");
  if (s.product === "arm") riders.push("3141"); if (MERS_RIDER_STATES.includes(s.state)) riders.push("3158");
  const tpl = (form: string): { template_id: string | null; revision_date: string | null } => { const t = activeTemplate(library, form, s.note_date); return { template_id: t?.template_id ?? null, revision_date: t?.revision_date ?? null }; };
  const riderKind: Record<string, DocumentKind> = { "3140": "rider_condo", "3150": "rider_pud", "3170": "rider_1_4_family", "3890": "rider_second_home", "3141": "rider_arm", "3158": "rider_mers" };
  const docs: SelectedDocument[] = [];
  docs.push({ kind: enote ? "enote" : "note", form_number: note_form, ...tpl(note_form), notarized: false, recordable: false });
  docs.push({ kind: "security_instrument", form_number: security_instrument_form, ...tpl(security_instrument_form), notarized: true, recordable: true });
  for (const r of riders) docs.push({ kind: riderKind[r]!, form_number: r, ...tpl(r), notarized: false, recordable: true });
  if (s.leasehold) docs.push({ kind: "rider_leasehold_cross_default", form_number: "SM_LEASEHOLD_RIDER", template_id: null, revision_date: null, notarized: false, recordable: true, note: "B8-4-01: no standard rider — counsel-drafted; nonstandard-document review (officer)" });
  if (MERS_ASSIGNMENT_STATES.includes(s.state)) docs.push({ kind: "mers_assignment_3749", form_number: "3749", ...tpl("3749"), notarized: true, recordable: true, executed_by: "signing_officer", note: "B8-7-01 Maine: MERS Mortgage Assignment executed at closing by the signing_officer; recorded promptly after the mortgage (Nov 2025 instruction change) — 26.4 trailing document" });
  if (s.vesting === "trust") docs.push({ kind: "trust_certification", form_number: "SM_TRUST_CERTIFICATION", template_id: null, revision_date: null, notarized: false, recordable: false });
  if (s.poa) docs.push({ kind: "poa_copy", form_number: "POA_COPY", template_id: null, revision_date: null, notarized: true, recordable: true, note: "B8-5-05: notarized, references the subject property, dated to be valid at execution; original to the custodian where applicable law requires" });
  if (s.buydown) docs.push({ kind: "buydown_agreement", form_number: "SM_BUYDOWN_AGREEMENT", ...tpl("SM_BUYDOWN_AGREEMENT"), notarized: false, recordable: false, executed_by: "signing_officer", note: "B2-1.4-04 written agreement; eDelivered with the eNote (B8-8-01 supplemental)" });
  if (s.tx_50a6) {
    docs.push({ kind: "tx_affidavit_3185", form_number: "3185", ...tpl("3185"), notarized: true, recordable: true });
    docs.push({ kind: "tx_fmv_acknowledgment", form_number: "SM_TX_FMV_ACK", ...tpl("SM_TX_FMV_ACK"), notarized: false, recordable: false, executed_by: "signing_officer", note: "§50(a)(6)(Q)(ix): owners and the partner's signing_officer; appraisal attached (B5-4.1-03)" });
    docs.push({ kind: "tx_closing_receipt", form_number: "SM_TX_CLOSING_RECEIPT", ...tpl("SM_TX_CLOSING_RECEIPT"), notarized: false, recordable: false, note: "§50(a)(6)(Q)(v) / B5-4.1-03: itemizes every document received at closing" });
    docs.push({ kind: "tx_notice_12day", form_number: NOTICE_TX_12DAY, template_id: null, revision_date: null, notarized: false, recordable: false, note: "§50(g) notice on file with receipt evidence" });
  }
  if (s.tx_f2_refinance) docs.push({ kind: "tx_f2_notice", form_number: NOTICE_TX_F2_REFI, template_id: null, revision_date: null, notarized: false, recordable: false });
  if (s.ny_cema) {
    docs.push({ kind: "ny_cema_3172", form_number: "3172", ...tpl("3172"), notarized: true, recordable: true });
    docs.push({ kind: "ny_cema_exhibit", form_number: "3172-EXHIBITS", template_id: null, revision_date: null, notarized: false, recordable: true, note: "Exhibit A prior notes/mortgages; Exhibit B consolidated note; Exhibit C consolidated mortgage terms; Exhibit D legal description" });
    docs.push({ kind: "ny_255_affidavit", form_number: "SM_NY_255_AFFIDAVIT", ...tpl("SM_NY_255_AFFIDAVIT"), notarized: true, recordable: true });
  }
  docs.push({ kind: "final_1003", form_number: "URLA_1003_FINAL", ...tpl("URLA_1003_FINAL"), notarized: false, recordable: false });
  if (s.rescindable) docs.push({ kind: "rescission_notice_h8", form_number: NOTICE_H8, template_id: null, revision_date: null, copies_per_consumer: 2, notarized: false, recordable: false, note: "25.3 NTC_REGZ_1026_23_H8: two copies to each consumer (TX: each owner and spouse)" });
  docs.push({ kind: "closing_instructions", form_number: "SM_CLOSING_INSTRUCTIONS", ...tpl("SM_CLOSING_INSTRUCTIONS"), notarized: false, recordable: false });
  const sfc: string[] = []; if (s.tx_50a6) sfc.push("304"); if (s.vesting === "trust") sfc.push("168"); if (enote) sfc.push("508");
  const profile = `${s.state}_${s.transaction_type === "purchase" ? "PURCH" : "REFI"}_${s.product.toUpperCase()}_${s.tx_50a6 ? "50A6_WET" : s.ny_cema ? "CEMA_PAPER" : enote ? "ENOTE" : "PAPER"}`;
  return { profile, closing_type, closing_type_reasons: reasons, enote, enote_refusal, note_form, security_instrument_form, riders, documents: docs,
    note_signers: noteSigners(s, closing_type, enote), security_instrument_signers: securityInstrumentSigners(s, closing_type), nonstandard_document_review: !!s.leasehold, excluded_product: excluded, sfc };
}

// ============================================================ rendering (`renderDocument`) — deterministic text from the snapshot; idempotent by (set_id, template_id, data_hash)
export interface RenderedDocument {
  readonly document_id: string; readonly kind: DocumentKind; readonly form_number: string; readonly template_id: string | null; readonly template_revision_date: string | null;
  /** = noteTermsHash for the note/eNote (30.2's OB-002 comparator); = the snapshot payload_hash for every other artifact. */ readonly data_hash: string; readonly snapshot_hash: string; readonly render_hash: string;
  readonly text: string; readonly signers: readonly Signer[]; readonly notarized: boolean; readonly witness_count: number; readonly recordable: boolean; readonly retention_class: typeof RETENTION_LOAN_FILE; readonly execution_status: "unsigned";
  readonly nmlsr_block: { org_name: string; org_nmlsr_id: string; mlo_name: string; mlo_nmlsr_id: string } | null; readonly min_present: boolean;
}
const nmlsrBlock = (s: ClosingSnapshotInput) => ({ org_name: s.partner.legal_name, org_nmlsr_id: s.partner.nmlsr_id, mlo_name: s.mlo_of_record.name, mlo_nmlsr_id: s.mlo_of_record.nmlsr_id });
const nmlsrText = (s: ClosingSnapshotInput): string => `Loan Originator Organization: ${s.partner.legal_name}${s.partner.dba ? ` dba ${s.partner.dba}` : ""}, NMLSR ID ${s.partner.nmlsr_id}. Individual Loan Originator: ${s.mlo_of_record.name}, NMLSR ID ${s.mlo_of_record.nmlsr_id}.`;
const longDate = (d: PlainDate): string => { const M = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]; const { y, m, d: dd } = parts(d); return `${M[m - 1]} ${dd}, ${y}`; };
const lender = (s: ClosingSnapshotInput): string => s.partner.dba ? `${s.partner.legal_name}, dba ${s.partner.dba}` : s.partner.legal_name;
/** E-2-04 settlor acknowledgment paragraph on the security instrument. */
export const settlorAcknowledgment = (trust: { name: string; dated: PlainDate }): string => `BY SIGNING BELOW, the undersigned, Settlor(s) of the ${trust.name} Trust under trust instrument dated ${trust.dated}, acknowledges all of the terms and covenants contained in this Security Instrument and any rider(s) thereto and agrees to be bound thereby.`;
/** E-2-07 eNote clause (Section 11 of the fixed-rate eNote, Section 12 for ARM eNotes). */
export const ENOTE_CLAUSE = `The only copy of this Electronic Note that is the Authoritative Copy is the copy identified by the Note Holder named in the Note Holder Registry. This Electronic Note will be registered in the Note Holder Registry operated by MERSCORP Holdings, Inc., a Delaware corporation. I agree that the Note Holder has the right, at any time to transfer the registration of this Electronic Note to another Note Holder Registry. I agree that the Note Holder has the right, at any time, to convert this Electronic Note into a Paper Note.`;
export function renderDocument(sel: SelectedDocument, s: ClosingSnapshotInput, terms: NoteTerms, min: string, snapshot_hash: string, selection: DocumentSetSelection, extra: { buydown?: BuydownAgreement | null; cema?: CemaPackage | null; instructions?: ClosingInstructionsContent | null } = {}): RenderedDocument {
  const jr = jurisdictionRule(s.state); const parties = s.borrowers;
  const trust = parties.find((b) => b.trust && b.capacities.includes("trustee"))?.trust ?? null;
  const settlor = parties.find((b) => b.capacities.includes("settlor"));
  const lines: string[] = [];
  let signers: readonly Signer[] = []; let notarized = sel.notarized; let min_present = false; let nmlsr = false;
  switch (sel.kind) {
    case "note": case "enote": {
      const e = sel.kind === "enote";
      if (e) lines.push("Note (For Electronic Signature)");
      lines.push(`${s.tx_50a6 ? "TEXAS HOME EQUITY NOTE" : "NOTE"}  ${longDate(s.note_date)}  ${s.property_address}${s.unit_number ? `, Unit ${s.unit_number}` : ""}`);
      if (e) { lines.push(`MIN ${min}`); min_present = true; }
      lines.push(`1. BORROWER'S PROMISE TO PAY. In return for a loan in the amount of U.S. ${formatCents(terms.principal_cents)} (the "Principal") that I have received, I promise to pay Principal plus interest to the order of the Lender. The Lender is ${lender(s)}. The Lender or anyone who takes this Note by transfer and who is entitled to receive payments under this Note is called the "Note Holder."`);
      lines.push(`2. INTEREST. Interest will be charged on unpaid Principal until the full amount of Principal has been paid. I will pay interest at a yearly rate of ${terms.note_rate_pct}%.`);
      lines.push(`3. PAYMENTS. (A) I will make my Monthly Payment on the 1st day of each month beginning on ${longDate(terms.first_payment_date)}. If, on ${longDate(terms.maturity_date)}, I still owe amounts under this Note, I will pay those amounts on that date, which is called the "Maturity Date." (B) My Monthly Payment will be in the amount of U.S. ${formatCents(terms.pi_cents)}.`);
      lines.push("4. BORROWER'S RIGHT TO PREPAY. I may make a full Prepayment or partial Prepayments without paying a Prepayment charge.");
      lines.push(`6. (A) LATE CHARGE FOR OVERDUE PAYMENTS. If the Note Holder has not received the full amount of any Monthly Payment by the end of ${terms.late_charge_days} calendar days after the date it is due, I will pay a late charge to the Note Holder. The amount of the charge will be ${terms.late_charge_pct}% of my overdue Monthly Payment. (B) DEFAULT. If I do not pay the full amount of each Monthly Payment on the date it is due, I will be in default.`);
      if (terms.arm) lines.push(`ADJUSTABLE RATE. Index: 30-day Average SOFR; Margin ${terms.arm.margin_pct}%; first Change Date after ${terms.arm.first_change_months} months; caps ${terms.arm.caps.first}/${terms.arm.caps.periodic}/${terms.arm.caps.life} (plan ${terms.arm.plan}).`);
      lines.push("10. UNIFORM SECURED NOTE. This Note is a uniform instrument with limited variations in some jurisdictions.");
      if (e) lines.push(`11. ELECTRONIC NOTE. ${ENOTE_CLAUSE}`);
      lines.push(nmlsrText(s)); nmlsr = true;
      lines.push("WITNESS THE HAND(S) AND SEAL(S) OF THE UNDERSIGNED. [Sign Original Only]");
      signers = selection.note_signers; for (const sg of signers) lines.push(`Signature line: ${sg.signature_line}`);
      lines.push(e ? `MULTISTATE FIXED RATE eNOTE--Single Family -- Fannie Mae/Freddie Mac Uniform Instrument Form ${sel.form_number}` : `${s.tx_50a6 ? "TEXAS HOME EQUITY" : sel.form_number === "3200" ? "MULTISTATE" : s.state} FIXED RATE NOTE—Single Family—Fannie Mae/Freddie Mac UNIFORM INSTRUMENT Form ${sel.form_number} ${sel.revision_date ?? ""}`);
      break;
    }
    case "security_instrument": {
      lines.push(`${s.tx_50a6 ? "TEXAS HOME EQUITY SECURITY INSTRUMENT (First Lien)" : securityInstrumentName(s.state).toUpperCase()}  MIN ${min}`); min_present = true;
      lines.push(`"MERS" is Mortgage Electronic Registration Systems, Inc. MERS is a separate corporation that is acting solely as a nominee for Lender and Lender's successors and assigns. MERS is the ${DEED_OF_TRUST_STATES.includes(s.state) ? "beneficiary" : "mortgagee"} under this Security Instrument. "Lender" is ${lender(s)}.`);
      lines.push(`Borrower: ${s.vesting_text}. Property: ${s.property_address}${s.unit_number ? `, Unit ${s.unit_number}` : ""}, ${s.county} County, ${s.state}. Legal description: ${s.legal_description}. Note dated ${longDate(s.note_date)} in the principal amount of U.S. ${formatCents(terms.principal_cents)}; Maturity Date ${longDate(terms.maturity_date)}.`);
      lines.push(`Riders: ${selection.riders.length ? selection.riders.join(", ") : "none"}. Electronic Note Signed with Borrower's Electronic Signature covenant included.`);
      if (settlor && trust) lines.push(settlorAcknowledgment(trust));
      lines.push(nmlsrText(s)); nmlsr = true;
      signers = selection.security_instrument_signers; for (const sg of signers) lines.push(`Signature line: ${sg.signature_line}`);
      lines.push(`Acknowledgment (${s.state}) — ${selection.closing_type === "ron" ? "notarial certificate indicating the use of communication technology" : "in-person notarial acknowledgment"}; witnesses required: ${jr.witness_count}.`);
      lines.push(`${s.state}—Single Family—Fannie Mae/Freddie Mac UNIFORM INSTRUMENT ${selection.riders.includes("3158") ? "(MERS Rider)" : "(MERS)"} Form ${sel.form_number} ${sel.revision_date ?? ""}`);
      break;
    }
    case "rider_condo": case "rider_pud": case "rider_1_4_family": case "rider_second_home": case "rider_arm": case "rider_mers": case "rider_trust": case "rider_leasehold_cross_default": {
      lines.push(`RIDER Form ${sel.form_number} ${sel.revision_date ?? ""}  MIN ${min}  incorporated into the Security Instrument dated ${longDate(s.note_date)}.`); min_present = true;
      if (sel.kind === "rider_mers") lines.push("MERS RIDER (Form 3158): MERS is appointed as the Nominee for Lender; post-closing assignments to MERS are prohibited in this state (B8-7-01).");
      signers = selection.security_instrument_signers.filter((x) => x.capacity !== "spouse_waiver"); break;
    }
    case "mers_assignment_3749": { lines.push(`MERS MORTGAGE ASSIGNMENT (Maine) Form 3749 ${sel.revision_date ?? ""}  MIN ${min}. ${lender(s)} assigns the Mortgage dated ${longDate(s.note_date)} to Mortgage Electronic Registration Systems, Inc., as nominee for Lender. Executed at closing by the Lender's authorized signing officer; to be recorded promptly after the Mortgage.`); min_present = true;
      signers = [{ party_id: "signing_officer", legal_name: "Lender authorized signer", capacity: "lender_officer", signature_line: `${lender(s)}, by its authorized signing officer`, signature_method: "wet", required: true }]; break; }
    case "final_1003": { lines.push(`Uniform Residential Loan Application (Form 1003, 1/2021) — FINAL. Loan amount ${formatCents(terms.principal_cents)}; note rate ${terms.note_rate_pct}%; term ${terms.term_months} months; ${s.transaction_type}; ${s.occupancy}. Section 9 Loan Originator Information: ${nmlsrText(s)}`); nmlsr = true;
      signers = s.borrowers.filter((b) => b.credit_used).map((b) => ({ party_id: b.party_id, legal_name: b.legal_name, capacity: "borrower" as const, signature_line: b.attorney_in_fact ? `${b.legal_name}, by ${b.attorney_in_fact}, as attorney-in-fact (B1-1-01)` : b.legal_name, signature_method: selection.closing_type === "wet" ? "wet" as const : "esign" as const, required: true })); break; }
    case "tx_affidavit_3185": { lines.push(`TEXAS HOME EQUITY AFFIDAVIT AND AGREEMENT (First Lien) Form 3185 ${sel.revision_date ?? ""}. The extension of credit is secured by the homestead; the owners and Lender affirm the requirements of Section 50(a)(6), Article XVI, Texas Constitution. To be recorded.`); signers = selection.security_instrument_signers; break; }
    case "tx_fmv_acknowledgment": { lines.push(`ACKNOWLEDGMENT AS TO FAIR MARKET VALUE OF HOMESTEAD PROPERTY (§50(a)(6)(Q)(ix)). The owner(s) of the homestead and the Lender acknowledge the fair market value of the homestead property on the date the extension of credit is made; the appraisal is attached (B5-4.1-03).`);
      signers = [...selection.security_instrument_signers, { party_id: "signing_officer", legal_name: "Lender authorized signer", capacity: "lender_officer", signature_line: `${lender(s)}, by its authorized signing officer`, signature_method: "wet", required: true }]; break; }
    case "tx_closing_receipt": { lines.push(`CLOSING RECEIPT (§50(a)(6)(Q)(v); B5-4.1-03). The owner acknowledges receipt of a copy of the final loan application and of every executed document signed at closing: ${selection.documents.map((d) => d.form_number).join("; ")}.`); signers = selection.security_instrument_signers; break; }
    case "tx_notice_12day": lines.push(`${NOTICE_TX_12DAY}: NOTICE CONCERNING EXTENSIONS OF CREDIT DEFINED BY SECTION 50(a)(6), ARTICLE XVI, TEXAS CONSTITUTION — on file with receipt evidence (21.3 package; 26.1 sets the timer).`); break;
    case "tx_f2_notice": lines.push(`${NOTICE_TX_F2_REFI}: §50(f)(2)(D) refinance notice — separate document, delivered within three business days of application and at least 12 days before closing.`); break;
    case "ny_cema_3172": { const c = extra.cema!; lines.push(`CONSOLIDATION, EXTENSION AND MODIFICATION AGREEMENT Form 3172 ${sel.revision_date ?? ""}. Prior notes and mortgages (Exhibit A) with unpaid principal ${formatCents(c.prior_unpaid_principal_cents)} and the new money note of ${formatCents(c.new_money_cents)} are consolidated into a single lien of ${formatCents(c.consolidated_amount_cents)} (Exhibit B consolidated note; Exhibit C consolidated mortgage terms; Exhibit D legal description).`); signers = selection.security_instrument_signers; break; }
    case "ny_cema_exhibit": { const c = extra.cema!; lines.push(`Form 3172 Exhibits: A — ${c.prior_liens.map((p) => `${p.lender} recorded ${p.recorded_at} instrument ${p.instrument_no} unpaid ${formatCents(p.unpaid_principal_cents)}`).join("; ")}. B — consolidated note ${formatCents(c.consolidated_amount_cents)}. C — consolidated mortgage. D — legal description: ${s.legal_description}.`); break; }
    case "ny_255_affidavit": { const c = extra.cema!; lines.push(`AFFIDAVIT UNDER SECTION 255 OF THE TAX LAW. The consolidated mortgage secures principal of ${formatCents(c.consolidated_amount_cents)} of which ${formatCents(c.prior_unpaid_principal_cents)} is the unpaid principal of mortgages on which mortgage recording tax was previously paid; new money ${formatCents(c.new_money_cents)} is the only new or further indebtedness, and mortgage recording tax of ${formatCents(c.mortgage_tax_on_new_money_cents)} is paid on the new money only.`); signers = selection.security_instrument_signers; notarized = true; break; }
    case "buydown_agreement": { const b = extra.buydown!; lines.push(b.agreement_text); signers = b.signers; break; }
    case "closing_instructions": { const ci = extra.instructions; lines.push(`CLOSING INSTRUCTIONS (${NOTICE_CLOSING_INSTRUCTIONS}) from ${lender(s)}; fulfillment contact ${s.servicer.name}. ${ci ? ci.text : ""}`); break; }
    case "rescission_notice_h8": lines.push(`${NOTICE_H8} — Notice of Right to Cancel (model form H-8), two copies to each consumer (25.3).`); break;
    case "trust_certification": lines.push(`Certification of Trust — ${trust?.name ?? ""} under trust instrument dated ${trust?.dated ?? ""} (B2-2-05; 24.4 trust_reviews).`); break;
    case "poa_copy": lines.push(`Power of Attorney copy — agent ${s.poa?.agent_name ?? ""}; references ${s.property_address}; notarized; valid at execution (B8-5-05).`); break;
    default: lines.push(`${sel.kind} ${sel.form_number}`);
  }
  const text = lines.join("\n");
  const data_hash = sel.kind === "note" || sel.kind === "enote" ? terms.data_hash : snapshot_hash;
  return { document_id: `DOC-${sha256(`${s.application_id}|${sel.kind}|${sel.form_number}|${data_hash}`).slice(0, 16)}`, kind: sel.kind, form_number: sel.form_number, template_id: sel.template_id, template_revision_date: sel.revision_date, data_hash, snapshot_hash, render_hash: sha256(text), text,
    signers, notarized, witness_count: sel.recordable ? jr.witness_count : 0, recordable: sel.recordable, retention_class: RETENTION_LOAN_FILE, execution_status: "unsigned", nmlsr_block: nmlsr ? nmlsrBlock(s) : null, min_present };
}

// ============================================================ SMART Doc eNote (`buildSmartDocENote`) — B8-8-02 / eMortgage Technical Requirements v3.2
export interface SmartDocENote { readonly ok: true; readonly profile: "v1_0_2_cat1_closing_dtd_2_3_1"; readonly min: string; readonly data: Record<string, string>; readonly view_hash: string; readonly arcs: readonly { data_point: string; view_ref: string }[]; readonly tamper_seal_algorithm: "SHA-256"; readonly seal: string; readonly form: string; readonly lender_legal_entity: string; }
export interface SmartDocRefusal { readonly ok: false; readonly reason: EnoteRefusal; readonly detail: string; }
export function buildSmartDocENote(s: ClosingSnapshotInput, terms: NoteTerms, min: string, note: RenderedDocument): SmartDocENote | SmartDocRefusal {
  const excluded = emortgageExclusion(s);
  if (excluded) return { ok: false, reason: "product_excluded_emortgage", detail: `B8-8-01: ${excluded} loans cannot be sold as eMortgages — a paper note (${STATE_NOTE_FORMS[s.state] ?? "3200"}) is required; paper notes may not be converted into eNotes (A2-4.1-03)` };
  if (s.borrower_declined_electronic) return { ok: false, reason: "borrower_declined_electronic", detail: "A2-4.1-03: the borrower may not be required to use electronic records" };
  if (!s.partner_emortgage_approved) return { ok: false, reason: "partner_not_emortgage_approved", detail: "B8-8-01: eMortgage approval under the eMortgage Addendum precedes the first eNote" };
  if (!isValidMin(min)) throw new RangeError(`MIN ${min} fails the check digit`);
  const data: Record<string, string> = { NoteAmount: terms.principal_cents.toString(), NoteRatePercent: terms.note_rate_pct, LoanMaturityDate: terms.maturity_date, ScheduledFirstPaymentDate: terms.first_payment_date, PrincipalAndInterestPaymentAmount: terms.pi_cents.toString(), LateChargeGracePeriodDays: String(terms.late_charge_days), LateChargeRatePercent: terms.late_charge_pct, MIN: min, LenderLegalEntityName: s.partner.legal_name, NoteDate: s.note_date, PropertyAddress: s.property_address };
  const arcs = Object.keys(data).map((k) => ({ data_point: k, view_ref: `view:${k}` }));
  const seal = sha256(`${note.render_hash}|${canonicalJson(data)}`);
  return { ok: true, profile: "v1_0_2_cat1_closing_dtd_2_3_1", min, data, view_hash: note.render_hash, arcs, tamper_seal_algorithm: "SHA-256", seal, form: note.form_number, lender_legal_entity: s.partner.dba ? `${s.partner.legal_name}, dba ${s.partner.dba}` : s.partner.legal_name };
}

// ============================================================ Texas §50(a)(6) / §50(f)(2) (`runTxHomeEquityReview`)
/** 7 TAC §153.51 / §153.45 mailing presumption: three calendar days not including Sundays and federal legal public holidays (= `business_days_regz_specific`). */
export const mailedNoticePresumedProvided = (mailed_on: PlainDate): PlainDate => addBusinessDays(mailed_on, 3, regzSpecific);
export interface Tx12DayResult { readonly application_submitted_date: PlainDate; readonly notice_provided_date: PlainDate; readonly t0: PlainDate; readonly day1: PlainDate; readonly earliest_closing_date: PlainDate; }
/** §50(a)(6)(M)(i) / 7 TAC §153.12: T0 = later of submission and notice provided; day 1 = T0 + 1; closing on or after day 12 = T0 + 12 calendar days. */
export function tx12DayEarliestClosing(i: { application_submitted_date: PlainDate; notice_delivered_on: PlainDate; channel: "electronic" | "in_person" | "mailed" }): Tx12DayResult {
  const notice_provided_date = i.channel === "mailed" ? mailedNoticePresumedProvided(i.notice_delivered_on) : i.notice_delivered_on;
  const t0 = notice_provided_date > i.application_submitted_date ? notice_provided_date : i.application_submitted_date;
  return { application_submitted_date: i.application_submitted_date, notice_provided_date, t0, day1: addDays(t0, 1), earliest_closing_date: addDays(t0, 12) };
}
export type TxConsent = "bona_fide_emergency" | "good_cause" | "de_minimis_good_cause";
export interface TxItemizationChange { readonly delivered_on: PlainDate; readonly delta_cents: Cents; readonly description: string; readonly consent: TxConsent | null; }
export interface TxItemizationResult { readonly anchor_receipt_date: PlainDate; readonly earliest_itemization_closing_date: PlainDate; readonly re_anchored_by: readonly PlainDate[]; readonly de_minimis_threshold_cents: Cents; readonly consents_applied: readonly { delivered_on: PlainDate; consent: TxConsent; within_de_minimis: boolean }[]; readonly closing_date_ok: boolean | null; }
/** §153.13(6)(B): de minimis = aggregate and per-item change ≤ the greater of $100 or 0.125% of the principal amount. */
export const txDeMinimisThreshold = (principal_cents: Cents): Cents => { const pct = divRound(principal_cents * 125n, 100_000n, "HALF_UP"); return pct > 10_000n ? pct : 10_000n; };
/** §50(a)(6)(M)(ii) / 7 TAC §153.13: not before one §153.1(A) business day (`business_days_regz_specific`) after receipt of the later of the itemization (CD) and the loan-application copy; a change after receipt re-anchors unless an executed §153.13(5) or (6) consent covers it. */
export function txItemizationGate(i: { itemization_received_on: PlainDate; application_copy_received_on: PlainDate; principal_cents: Cents; changes?: readonly TxItemizationChange[]; scheduled_closing_date?: PlainDate | null }): TxItemizationResult {
  const threshold = txDeMinimisThreshold(i.principal_cents);
  let anchor = i.itemization_received_on > i.application_copy_received_on ? i.itemization_received_on : i.application_copy_received_on;
  const re: PlainDate[] = []; const consents: { delivered_on: PlainDate; consent: TxConsent; within_de_minimis: boolean }[] = [];
  const abs = (c: Cents): Cents => (c < 0n ? -c : c);
  let aggregate = 0n;
  for (const ch of [...(i.changes ?? [])].sort((a, b) => (a.delivered_on < b.delivered_on ? -1 : 1))) {
    aggregate += abs(ch.delta_cents);
    const within = abs(ch.delta_cents) <= threshold && aggregate <= threshold;
    if (ch.consent === "bona_fide_emergency" || ch.consent === "good_cause" || (ch.consent === "de_minimis_good_cause" && within)) { consents.push({ delivered_on: ch.delivered_on, consent: ch.consent, within_de_minimis: within }); continue; }
    if (ch.delivered_on > anchor) anchor = ch.delivered_on; re.push(ch.delivered_on);
  }
  const earliest = addBusinessDays(anchor, 1, regzSpecific);
  return { anchor_receipt_date: anchor, earliest_itemization_closing_date: earliest, re_anchored_by: re, de_minimis_threshold_cents: threshold, consents_applied: consents, closing_date_ok: i.scheduled_closing_date ? i.scheduled_closing_date >= earliest : null };
}
export type TxFeeKind = "origination" | "processing" | "underwriting" | "doc_prep" | "erecording" | "flood_cert" | "credit_report" | "tax_service" | "amc_fee" | "third_party_origination" | "appraisal_third_party" | "survey" | "title_base_premium" | "title_endorsement_t42" | "title_exam" | "escrow_deposit" | "prepaid_hazard" | "bona_fide_discount_points" | "prepaid_interest" | "recording_fee";
export interface TxFeeItem { readonly fee_item_id: string; readonly kind: TxFeeKind; readonly amount_cents: Cents; readonly title_base_premium_cents?: Cents; }
export interface TxFeeTest { readonly items: readonly { fee_item_id: string; counted: boolean; reason: string }[]; readonly total_counted_cents: Cents; readonly cap_cents: Cents; readonly headroom_cents: Cents; readonly pass: boolean; }
/** §50(a)(6)(E) / 7 TAC §153.5: counted fees ≤ 2% of the original principal; appraisal (third-party appraiser), survey, state base title premium with endorsements, title exam below the base premium, escrow deposits, hazard premiums, bona fide discount points and interest are excluded; AMC fees and third-party origination charges are counted. */
export function txFeeTest(loan_amount_cents: Cents, items: readonly TxFeeItem[]): TxFeeTest {
  const EXCLUDED: Partial<Record<TxFeeKind, string>> = { appraisal_third_party: "(E)(i) third-party appraiser", survey: "(E)(ii) licensed surveyor", title_base_premium: "(E)(iii) state base premium", title_endorsement_t42: "(E)(iii) endorsements", escrow_deposit: "§153.5 escrow funds are not fees", prepaid_hazard: "§153.5 insurance premiums", bona_fide_discount_points: "§153.5 bona fide discount points are interest", prepaid_interest: "interest" };
  const rows = items.map((it) => {
    if (it.kind === "title_exam") { const base = it.title_base_premium_cents ?? 0n; const excluded = it.amount_cents < base; return { fee_item_id: it.fee_item_id, counted: !excluded, reason: excluded ? "(E)(iv) title examination below the state base premium" : "title examination at or above the base premium is counted" }; }
    const ex = EXCLUDED[it.kind]; return { fee_item_id: it.fee_item_id, counted: !ex, reason: ex ?? (it.kind === "amc_fee" ? "§153.5 appraisal management fees are counted" : "fee necessary to originate/evaluate/maintain/record/insure/service") };
  });
  const total = items.filter((_, k) => rows[k]!.counted).reduce((a, it) => a + it.amount_cents, 0n);
  const cap = divRound(loan_amount_cents * 2n, 100n, "HALF_UP");
  return { items: rows, total_counted_cents: total, cap_cents: cap, headroom_cents: cap - total, pass: total <= cap };
}
/** §50(a)(6)(B) / B5-4.1-03: principal + other encumbrances ≤ 80% of the fair market value (new appraisal; value acceptance not permitted). */
export function txLtv80(loan_amount_cents: Cents, other_liens_cents: Cents, fmv_cents: Cents): { cap_cents: Cents; ok: boolean } { const cap = divRound(fmv_cents * 80n, 100n, "DOWN"); return { cap_cents: cap, ok: loan_amount_cents + other_liens_cents <= cap }; }
/** §50(a)(6)(M)(iii): not before the first anniversary of the prior 50(a)(6) closing on the same homestead. */
export function txOneYearRule(prior_50a6_closing_date: PlainDate | null, closing_date: PlainDate): { anniversary: PlainDate | null; ok: boolean } { if (!prior_50a6_closing_date) return { anniversary: null, ok: true }; const a = addYears(prior_50a6_closing_date, 1); return { anniversary: a, ok: closing_date >= a }; }
/** 7 TAC §153.25: three calendar days after closing; if day 3 is a Sunday or federal legal public holiday, the right extends to the next day that is neither. */
export function txRescissionExpiry(closing_date: PlainDate): PlainDate { let d = addDays(closing_date, 3); while (!regzSpecific.isBusinessDay(d)) d = addDays(d, 1); return d; }
/** §50(f)(2)(D) / 7 TAC §153.45: due the third business day after submission — the legal unit is §153.1(B)'s general definition (`business_days_creditor`); SM schedules by `business_days_regz_specific` whenever it yields the earlier date. */
export function txF2NoticeDue(application_date: PlainDate): { legal_due: PlainDate; scheduled_due: PlainDate } { const legal = addBusinessDays(application_date, 3, creditor); const specific = addBusinessDays(application_date, 3, regzSpecific); return { legal_due: legal, scheduled_due: specific < legal ? specific : legal }; }
/** §50(f)(2)(D) / §153.45: the refinance closes no earlier than 12 days after the notice (mailed: the §153.45 presumption). */
export function txF2EarliestClosing(i: { notice_delivered_on: PlainDate; channel: "electronic" | "in_person" | "mailed" }): { notice_provided_date: PlainDate; earliest_closing_date: PlainDate } { const p = i.channel === "mailed" ? mailedNoticePresumedProvided(i.notice_delivered_on) : i.notice_delivered_on; return { notice_provided_date: p, earliest_closing_date: addDays(p, 12) }; }
export type TxClosingLocation = "lender_office" | "attorney_office" | "title_company";
/** §50(a)(6)(N) / 7 TAC §153.15: closed only at a permanent physical office of the lender, an attorney at law or a title company — never the homestead, never remote. */
export function txClosingLocationOk(location_type: string | null, permanent_physical_address: boolean): boolean { return (location_type === "lender_office" || location_type === "attorney_office" || location_type === "title_company") && permanent_physical_address; }
export interface TxHomeEquityReview {
  readonly application_id: string; readonly is_50a6: boolean; readonly f2_refinance: boolean; readonly classification_basis: string; readonly prior_50a6_closing_date: PlainDate | null; readonly one_year_ok: boolean;
  readonly fmv_cents: Cents | null; readonly ltv_80_ok: boolean | null; readonly fee_test: TxFeeTest | null; readonly application_submitted_at: PlainDate; readonly notice_12day_delivered_at: PlainDate | null; readonly notice_12day_channel: string | null; readonly notice_12day_presumed_received_at: PlainDate | null;
  readonly earliest_closing_date: PlainDate | null; readonly itemization_received_at: PlainDate | null; readonly itemization_source: "cd" | "separate" | null; readonly application_copy_received_at: PlainDate | null; readonly earliest_itemization_closing_date: PlainDate | null; readonly emergency_consent_document_id: string | null;
  readonly closing_location_type: TxClosingLocation | null; readonly closing_location_ok: boolean | null; readonly f2_notice_due: PlainDate | null; readonly f2_notice_delivered_at: PlainDate | null; readonly f2_earliest_closing_date: PlainDate | null; readonly result: "eligible" | "ineligible" | "pending"; readonly reasons: readonly string[];
}
export function openTxHomeEquityReview(events: EventStore, i: { application_id: string; is_50a6: boolean; f2_refinance: boolean; classification_basis: string; application_submitted_at: PlainDate; prior_50a6_closing_date: PlainDate | null; scheduled_closing_date: PlainDate | null }): { review: TxHomeEquityReview; event: DomainEvent } {
  const one = txOneYearRule(i.prior_50a6_closing_date, i.scheduled_closing_date ?? i.application_submitted_at);
  const f2 = i.f2_refinance ? txF2NoticeDue(i.application_submitted_at) : null;
  const review: TxHomeEquityReview = { application_id: i.application_id, is_50a6: i.is_50a6, f2_refinance: i.f2_refinance, classification_basis: i.classification_basis, prior_50a6_closing_date: i.prior_50a6_closing_date, one_year_ok: one.ok, fmv_cents: null, ltv_80_ok: null, fee_test: null, application_submitted_at: i.application_submitted_at, notice_12day_delivered_at: null, notice_12day_channel: null, notice_12day_presumed_received_at: null, earliest_closing_date: null, itemization_received_at: null, itemization_source: null, application_copy_received_at: null, earliest_itemization_closing_date: null, emergency_consent_document_id: null, closing_location_type: null, closing_location_ok: null, f2_notice_due: f2?.scheduled_due ?? null, f2_notice_delivered_at: null, f2_earliest_closing_date: null, result: one.ok ? "pending" : "ineligible", reasons: one.ok ? [] : [`§50(a)(6)(M)(iii): closing before the first anniversary ${one.anniversary} of the prior home-equity loan`] };
  const event = events.append({ type: "tx.home_equity_review.opened", applicationId: i.application_id, actor: CLOSER, payload: { application_id: i.application_id, is_50a6: i.is_50a6, f2_refinance: i.f2_refinance, application_date: i.application_submitted_at, prior_50a6_closing_date: i.prior_50a6_closing_date, one_year_ok: one.ok, f2_notice_due: f2?.scheduled_due ?? null, f2_notice_legal_due: f2?.legal_due ?? null } });
  return { review, event };
}
export function recordTx12DayNotice(events: EventStore, r: TxHomeEquityReview, i: { delivered_on: PlainDate; channel: "electronic" | "in_person" | "mailed"; receipt_evidence_id: string | null }): { review: TxHomeEquityReview; result: Tx12DayResult; event: DomainEvent } {
  const result = tx12DayEarliestClosing({ application_submitted_date: r.application_submitted_at, notice_delivered_on: i.delivered_on, channel: i.channel });
  const review: TxHomeEquityReview = { ...r, notice_12day_delivered_at: i.delivered_on, notice_12day_channel: i.channel, notice_12day_presumed_received_at: result.notice_provided_date, earliest_closing_date: result.earliest_closing_date };
  const event = events.append({ type: "tx.notice_12day.delivered", applicationId: r.application_id, actor: CLOSER, payload: { application_id: r.application_id, notice: NOTICE_TX_12DAY, channel: i.channel, delivered_on: i.delivered_on, notice_provided_date: result.notice_provided_date, t0: result.t0, earliest_closing_date: result.earliest_closing_date, receipt_evidence_id: i.receipt_evidence_id } });
  return { review, result, event };
}
export function recordTxItemization(events: EventStore, r: TxHomeEquityReview, i: { received_on: PlainDate; source: "cd" | "separate"; application_copy_received_on: PlainDate; principal_cents: Cents; changes?: readonly TxItemizationChange[]; scheduled_closing_date?: PlainDate | null; emergency_consent_document_id?: string | null }): { review: TxHomeEquityReview; result: TxItemizationResult; event: DomainEvent } {
  const result = txItemizationGate({ itemization_received_on: i.received_on, application_copy_received_on: i.application_copy_received_on, principal_cents: i.principal_cents, ...(i.changes ? { changes: i.changes } : {}), scheduled_closing_date: i.scheduled_closing_date ?? null });
  const review: TxHomeEquityReview = { ...r, itemization_received_at: i.received_on, itemization_source: i.source, application_copy_received_at: i.application_copy_received_on, earliest_itemization_closing_date: result.earliest_itemization_closing_date, emergency_consent_document_id: i.emergency_consent_document_id ?? null };
  const event = events.append({ type: "tx.itemization.delivered", applicationId: r.application_id, actor: CLOSER, payload: { application_id: r.application_id, source: i.source, notice: i.source === "cd" ? "NTC_REGZ_1026_38_CD" : NOTICE_TX_ITEMIZATION, received_on: result.anchor_receipt_date, itemization_received_on: i.received_on, application_copy_received_on: i.application_copy_received_on, earliest_itemization_closing_date: result.earliest_itemization_closing_date, re_anchored_by: result.re_anchored_by } });
  return { review, result, event };
}
export function recordTxF2Notice(events: EventStore, r: TxHomeEquityReview, i: { delivered_on: PlainDate; channel: "electronic" | "in_person" | "mailed"; document_id: string | null }): { review: TxHomeEquityReview; event: DomainEvent; earliest_closing_date: PlainDate } {
  const e = txF2EarliestClosing({ notice_delivered_on: i.delivered_on, channel: i.channel });
  const review: TxHomeEquityReview = { ...r, f2_notice_delivered_at: i.delivered_on, f2_earliest_closing_date: e.earliest_closing_date };
  const event = events.append({ type: "tx.f2_notice.delivered", applicationId: r.application_id, actor: CLOSER, payload: { application_id: r.application_id, notice: NOTICE_TX_F2_REFI, channel: i.channel, delivered_on: i.delivered_on, notice_provided_date: e.notice_provided_date, earliest_closing_date: e.earliest_closing_date, document_id: i.document_id, late: r.f2_notice_due !== null && i.delivered_on > r.f2_notice_due } });
  return { review, event, earliest_closing_date: e.earliest_closing_date };
}
/** TX_50A6_RESCISSION_3D_GATE sweep: once the §153.25 period has run, `disburse` may proceed when 25.3's TILA period has also expired (26.3 waits for the later). */
export function expireTxRescission(events: EventStore, application_id: string, closing_date: PlainDate, now: PlainDate): { expires_on: PlainDate; expired: boolean; event: DomainEvent | null } {
  const expires_on = txRescissionExpiry(closing_date);
  if (now <= expires_on) return { expires_on, expired: false, event: null };
  const event = events.append({ type: "rescission.period.expired", applicationId: application_id, actor: CLOSER, payload: { application_id, basis: "tx_50a6", tx: true, closing_date, expires_on, citation: "7 TAC §153.25; Tex. Const. art. XVI §50(a)(6)(Q)(viii)" } });
  return { expires_on, expired: true, event };
}
/** Consummation-date check the 26.2 `consummate` command runs against the TX gates (all must be open). */
export function txConsummationCheck(r: TxHomeEquityReview, closing_date: PlainDate, location: { type: TxClosingLocation | null; permanent_physical_address: boolean }): { ok: boolean; refusals: readonly string[] } {
  const refusals: string[] = [];
  if (r.is_50a6) {
    if (!r.earliest_closing_date) refusals.push("TX_50A6_12DAY_CLOSING_GATE: §50(g) notice not on file"); else if (closing_date < r.earliest_closing_date) refusals.push(`TX_50A6_12DAY_CLOSING_GATE: ${closing_date} < ${r.earliest_closing_date}`);
    if (!r.earliest_itemization_closing_date) refusals.push("TX_50A6_ITEMIZATION_1BD_GATE: itemization/application copy not received"); else if (closing_date < r.earliest_itemization_closing_date) refusals.push(`TX_50A6_ITEMIZATION_1BD_GATE: ${closing_date} < ${r.earliest_itemization_closing_date}`);
    if (!txOneYearRule(r.prior_50a6_closing_date, closing_date).ok) refusals.push("TX_50A6_ONE_YEAR_GATE");
    if (!txClosingLocationOk(location.type, location.permanent_physical_address)) refusals.push("§153.15: closing location must be a permanent office of the lender, an attorney or a title company");
  }
  if (r.f2_refinance) { if (!r.f2_earliest_closing_date) refusals.push("TX_50F2_12DAY_CLOSING_GATE: §50(f)(2)(D) notice not delivered"); else if (closing_date < r.f2_earliest_closing_date) refusals.push(`TX_50F2_12DAY_CLOSING_GATE: ${closing_date} < ${r.f2_earliest_closing_date}`); }
  return { ok: refusals.length === 0, refusals };
}

// ============================================================ temporary buydowns (`draftBuydownAgreement`) — B2-1.4-04
export interface BuydownYear { readonly year: number; readonly bought_down_rate_pct: string; readonly borrower_payment_cents: Cents; readonly subsidy_cents_per_month: Cents; readonly subsidy_cents_per_year: Cents; }
export interface BuydownAgreement {
  readonly application_id: string; readonly kind: BuydownInput["kind"]; readonly provider_type: BuydownInput["provider_type"]; readonly provider_party_id: string; readonly note_rate_pct: string; readonly note_pi_cents: Cents;
  readonly schedule: readonly BuydownYear[]; readonly total_subsidy_cents: Cents; readonly classification: "moderate" | "significant"; readonly sfc: "009" | "014"; readonly ipc_counted_cents: Cents; readonly ipc_cap_cents: Cents | null; readonly ipc_ok: boolean | null;
  readonly custodial_account: "t_and_i_custodial"; readonly return_on_payoff_to: "credit_to_payoff"; readonly agreement_text: string; readonly signers: readonly Signer[]; readonly eligible: boolean; readonly ineligibility: string | null;
}
export const NOT_RELIEVED_CLAUSE = "The Borrower is not relieved of the obligation to make the mortgage payments required by the terms of the mortgage note if the buydown funds are unavailable for any reason.";
const BUYDOWN_STEPS: Record<BuydownInput["kind"], readonly number[]> = { "2-1": [2, 1], "1-0": [1], "3-2-1": [3, 2, 1], "1-1": [1, 1] };
/** B3-4.1-02 IPC cap for principal residences: 3% when CLTV > 90%… the spec's worked example applies 3% at 90% CLTV — the conservative reading SM uses (a 6% cap at ≤ 90% only widens the room). */
export function ipcCapPct(cltv_pct: string): string { const c = Number(cltv_pct); return c >= 90 ? "3" : c > 75 ? "6" : "9"; }
export function buydownSchedule(i: { loan_amount_cents: Cents; note_rate_pct: string; term_months: number; kind: BuydownInput["kind"] }): { note_pi_cents: Cents; schedule: BuydownYear[]; total_subsidy_cents: Cents } {
  const note_pi_cents = levelPayment(i.loan_amount_cents, ratePercent(i.note_rate_pct), i.term_months);
  const schedule = BUYDOWN_STEPS[i.kind].map((pts, k) => {
    const rate = Decimal.parse(i.note_rate_pct).sub(Decimal.fromInt(pts)).toFixed(3);
    const pay = levelPayment(i.loan_amount_cents, ratePercent(rate), i.term_months);
    const sub = note_pi_cents - pay;
    return { year: k + 1, bought_down_rate_pct: rate, borrower_payment_cents: pay, subsidy_cents_per_month: sub, subsidy_cents_per_year: sub * 12n };
  });
  return { note_pi_cents, schedule, total_subsidy_cents: schedule.reduce((a, y) => a + y.subsidy_cents_per_year, 0n) };
}
export function draftBuydownAgreement(s: ClosingSnapshotInput, b: BuydownInput, terms: NoteTerms): BuydownAgreement {
  const steps = BUYDOWN_STEPS[b.kind]; const maxPts = Math.max(...steps); const years = steps.length;
  const ineligible = s.transaction_type === "cash_out" ? "B2-1.4-04 / B2-1.3-03: cash-out refinances are ineligible for temporary buydowns" : s.occupancy === "investment" ? "B2-1.4-04: principal residences or second homes only" : s.tx_50a6 ? "B5-4.1-02: TX 50(a)(6) loans with temporary buydowns are ineligible" : maxPts > 3 ? "B2-1.4-04: rate reduction may not exceed 3%" : years > 3 ? "B2-1.4-04: buydown period not greater than 3 years" : steps.some((p, k) => k > 0 && steps[k - 1]! - p > 1) ? "B2-1.4-04: rate increase may not exceed 1% per year" : null;
  const sch = buydownSchedule({ loan_amount_cents: s.loan_amount_cents, note_rate_pct: terms.note_rate_pct, term_months: terms.term_months, kind: b.kind });
  const moderate = maxPts <= 2 && years <= 2;
  const ipc_cap = b.provider_type === "seller" || b.provider_type === "builder" || b.provider_type === "other_interested_party" ? (b.sales_price_cents !== null ? divRound(b.sales_price_cents * BigInt(ipcCapPct(b.cltv_pct)), 100n, "HALF_UP") : null) : null;
  const ipc_counted = ipc_cap !== null ? sch.total_subsidy_cents : 0n;
  const text = [`TEMPORARY BUYDOWN AGREEMENT (${b.kind}) between ${b.provider_type} ${b.provider_party_id} (the "Provider") and the Borrower(s); Lender ${lender(s)}.`,
    `The Note bears interest at ${terms.note_rate_pct}% with a Monthly Payment of ${formatCents(terms.pi_cents)}; the mortgage instruments reflect the permanent payment terms and nothing in this Agreement changes the terms of the Note.`,
    ...sch.schedule.map((y) => `Year ${y.year}: effective rate ${y.bought_down_rate_pct}%, Borrower pays ${formatCents(y.borrower_payment_cents)}, subsidy ${formatCents(y.subsidy_cents_per_month)} per month (${formatCents(y.subsidy_cents_per_year)} per year).`),
    `Total buydown funds ${formatCents(sch.total_subsidy_cents)} deposited by the Provider at closing into the servicer's T&I custodial account (SVC-2026-02); funds may not be used for past-due payments or to reduce the mortgage amount for LTV purposes.`,
    NOT_RELIEVED_CLAUSE,
    "At payoff, remaining buydown funds are credited to the total amount required to pay off the mortgage; on foreclosure they reduce the mortgage debt. All terms of this plan are disclosed to Fannie Mae, the mortgage insurer and the property appraiser; the Borrower was qualified at the Note rate.",
  ].join("\n");
  const signers: Signer[] = [{ party_id: b.provider_party_id, legal_name: `Provider (${b.provider_type})`, capacity: "witness", signature_line: `Provider: ${b.provider_party_id}`, signature_method: "esign", required: true }, ...s.borrowers.filter((x) => x.credit_used).map((x) => ({ party_id: x.party_id, legal_name: x.legal_name, capacity: "borrower" as const, signature_line: x.legal_name, signature_method: "esign" as const, required: true })), ...(b.provider_type === "lender" ? [{ party_id: "signing_officer", legal_name: "Lender authorized signer", capacity: "lender_officer" as const, signature_line: `${lender(s)}, by its authorized signing officer`, signature_method: "wet" as const, required: true }] : [])];
  return { application_id: s.application_id, kind: b.kind, provider_type: b.provider_type, provider_party_id: b.provider_party_id, note_rate_pct: terms.note_rate_pct, note_pi_cents: sch.note_pi_cents, schedule: sch.schedule, total_subsidy_cents: sch.total_subsidy_cents, classification: moderate ? "moderate" : "significant", sfc: moderate ? "009" : "014", ipc_counted_cents: ipc_counted, ipc_cap_cents: ipc_cap, ipc_ok: ipc_cap === null ? null : ipc_counted <= ipc_cap, custodial_account: "t_and_i_custodial", return_on_payoff_to: "credit_to_payoff", agreement_text: text, signers, eligible: ineligible === null, ineligibility: ineligible };
}
export function executeBuydownAgreement(events: EventStore, a: BuydownAgreement, i: { signed_document_id: string; funded_at: string | null }): DomainEvent {
  if (!a.eligible) throw new RangeError(a.ineligibility!);
  return events.append({ type: "buydown.agreement.executed", applicationId: a.application_id, actor: CLOSER, payload: { application_id: a.application_id, kind: a.kind, provider_type: a.provider_type, total_subsidy_cents: a.total_subsidy_cents.toString(), sfc: a.sfc, classification: a.classification, signed_document_id: i.signed_document_id, funded_at: i.funded_at, custodial_account: a.custodial_account } });
}

// ============================================================ NY CEMA (`buildCemaPackage`) — B8-2-02, NY Tax Law §255
export interface CemaPackage { readonly application_id: string; readonly prior_liens: NonNullable<ClosingSnapshotInput["ny_cema"]>["prior_liens"]; readonly prior_unpaid_principal_cents: Cents; readonly new_money_cents: Cents; readonly consolidated_amount_cents: Cents; readonly new_money_security_instrument_form: "3033" | null; readonly mortgage_tax_on_new_money_cents: Cents; readonly mortgage_tax_rate_pct: string; readonly enote: false; readonly closing_type_forced: null; readonly status: "buildable" | "blocked"; readonly blocker: string | null; readonly dqc_cema_sum: "pass" | "fail"; }
/** Form 3172 consolidates Σ unpaid principal of the prior notes + new money; §255: tax on the new money only; the CEMA cannot be built until every prior lender has assigned (edge case → new mortgage with full tax). */
export function buildCemaPackage(s: ClosingSnapshotInput, o: { mortgage_tax_rate_pct?: string } = {}): CemaPackage {
  const c = s.ny_cema; if (!c) throw new RangeError("not a NY CEMA transaction");
  const prior = c.prior_liens.reduce((a, p) => a + p.unpaid_principal_cents, 0n);
  const consolidated = prior + c.new_money_cents;
  const rate = o.mortgage_tax_rate_pct ?? "1.80";
  const tax = divRound(c.new_money_cents * BigInt(Decimal.parse(rate).mul(Decimal.fromInt(100)).toFixed(0)), 10_000n, "HALF_UP");
  const refusing = c.prior_liens.filter((p) => !p.assignment_received);
  return { application_id: s.application_id, prior_liens: c.prior_liens, prior_unpaid_principal_cents: prior, new_money_cents: c.new_money_cents, consolidated_amount_cents: consolidated, new_money_security_instrument_form: c.new_money_cents > 0n ? "3033" : null, mortgage_tax_on_new_money_cents: tax, mortgage_tax_rate_pct: rate, enote: false, closing_type_forced: null, status: refusing.length ? "blocked" : "buildable", blocker: refusing.length ? `prior lender(s) ${refusing.map((p) => p.lender).join(", ")} have not assigned — fall back to a new mortgage with full mortgage tax (21.5/25.2 re-issue)` : null, dqc_cema_sum: consolidated === s.loan_amount_cents ? "pass" : "fail" };
}

// ============================================================ data-to-document QC (`runDocumentQc`)
export type QcRuleCode = "DQC_NOTE_CD_AMOUNT" | "DQC_NOTE_CD_RATE" | "DQC_NOTE_CD_PI" | "DQC_NOTE_SI_DATE" | "DQC_SI_VESTING_TITLE" | "DQC_SI_LEGAL_TITLE" | "DQC_NMLSR_36G" | "DQC_1003_FINAL_TERMS" | "DQC_RIDERS_REQUIRED" | "DQC_TEMPLATE_VERSION" | "DQC_LATE_CHARGE_STATE" | "DQC_MIN_CHECK_DIGIT" | "DQC_ENOTE_ARC_VIEW" | "DQC_TX_2PCT" | "DQC_TX_80LTV" | "DQC_CEMA_SUM" | "DQC_NAME_VARIANCE";
export interface QcCheck { readonly rule_code: QcRuleCode; readonly severity: "hard" | "soft"; readonly result: "pass" | "fail" | "waived"; readonly expected: string; readonly actual: string; readonly reason: string | null; readonly evidence_document_ids: readonly string[]; }
export interface QcUpstream {
  readonly cd: { loan_amount_cents: Cents; note_rate_pct: string; pi_cents: Cents; org_nmlsr_id: string; mlo_nmlsr_id: string; first_payment_date?: PlainDate | null };
  readonly du: { loan_amount_cents: Cents; note_rate_pct: string; term_months: number }; readonly lock: { note_rate_pct: string };
  readonly title: { vesting_text: string; legal_description: string }; readonly urla_1003: { org_nmlsr_id: string; mlo_nmlsr_id: string; loan_amount_cents: Cents; note_rate_pct: string; term_months: number };
  readonly templates: readonly DocumentTemplate[]; readonly note_date: PlainDate; readonly tx?: { fee_test: TxFeeTest; ltv_80_ok: boolean } | null; readonly cema?: CemaPackage | null; readonly enote?: SmartDocENote | SmartDocRefusal | null; readonly name_variances?: readonly string[];
}
export function runDocumentQc(s: ClosingSnapshotInput, terms: NoteTerms, selection: DocumentSetSelection, docs: readonly RenderedDocument[], up: QcUpstream, waivers: readonly { rule_code: QcRuleCode; waived_by_role: string; reason: string }[] = []): { checks: QcCheck[]; passed: boolean; hard_failures: QcRuleCode[]; soft_failures: QcRuleCode[] } {
  const note = docs.find((d) => d.kind === "note" || d.kind === "enote"); const si = docs.find((d) => d.kind === "security_instrument"); const urla = docs.find((d) => d.kind === "final_1003");
  const ids = (...ds: (RenderedDocument | undefined)[]): string[] => ds.filter((d): d is RenderedDocument => !!d).map((d) => d.document_id);
  const C = (rule_code: QcRuleCode, ok: boolean, expected: string, actual: string, reason: string | null, ev: string[], severity: "hard" | "soft" = "hard"): QcCheck => {
    const w = waivers.find((x) => x.rule_code === rule_code);
    if (!ok && w && (severity === "soft" || w.waived_by_role === "officer")) return { rule_code, severity, result: "waived", expected, actual, reason: `waived by ${w.waived_by_role}: ${w.reason}`, evidence_document_ids: ev };
    return { rule_code, severity, result: ok ? "pass" : "fail", expected, actual, reason: ok ? null : reason, evidence_document_ids: ev };
  };
  const checks: QcCheck[] = []; const min = s.min ?? "";
  checks.push(C("DQC_NOTE_CD_AMOUNT", terms.principal_cents === up.cd.loan_amount_cents && up.du.loan_amount_cents === terms.principal_cents, formatCents(up.cd.loan_amount_cents), formatCents(terms.principal_cents), "note principal ≠ CD loan amount / DU final", ids(note)));
  checks.push(C("DQC_NOTE_CD_RATE", pct3(terms.note_rate_pct) === pct3(up.cd.note_rate_pct) && pct3(up.lock.note_rate_pct) === pct3(terms.note_rate_pct) && pct3(up.du.note_rate_pct) === pct3(terms.note_rate_pct), pct3(up.cd.note_rate_pct), terms.note_rate_pct, "note rate ≠ CD / lock / DU final", ids(note)));
  checks.push(C("DQC_NOTE_CD_PI", terms.pi_cents === up.cd.pi_cents, formatCents(up.cd.pi_cents), formatCents(terms.pi_cents), "note P&I ≠ CD projected payment", ids(note)));
  checks.push(C("DQC_NOTE_SI_DATE", !!si && si.text.includes(longDate(s.note_date)) && (!up.cd.first_payment_date || up.cd.first_payment_date === terms.first_payment_date), `${s.note_date} / first payment ${terms.first_payment_date}`, `${si ? "present" : "missing"} / ${up.cd.first_payment_date ?? terms.first_payment_date}`, "security instrument note date / first payment date mismatch", ids(note, si)));
  checks.push(C("DQC_SI_VESTING_TITLE", s.vesting_text === up.title.vesting_text, up.title.vesting_text, s.vesting_text, "vesting ≠ title commitment Schedule A", ids(si)));
  checks.push(C("DQC_SI_LEGAL_TITLE", sha256(s.legal_description) === sha256(up.title.legal_description), sha256(up.title.legal_description).slice(0, 12), sha256(s.legal_description).slice(0, 12), "legal description ≠ title commitment", ids(si)));
  const nm = [note, si, urla].filter((d): d is RenderedDocument => !!d).map((d) => d.nmlsr_block!);
  const nmlsrOk = nm.length === 3 && nm.every((b) => b && b.org_nmlsr_id === up.cd.org_nmlsr_id && b.mlo_nmlsr_id === up.cd.mlo_nmlsr_id && b.org_nmlsr_id === up.urla_1003.org_nmlsr_id && b.mlo_nmlsr_id === up.urla_1003.mlo_nmlsr_id);
  checks.push(C("DQC_NMLSR_36G", nmlsrOk, `org ${up.cd.org_nmlsr_id} / MLO ${up.cd.mlo_nmlsr_id} (CD)`, nm.map((b) => `${b?.org_nmlsr_id}/${b?.mlo_nmlsr_id}`).join("; "), "§1026.36(g): NMLSR organization/individual IDs differ across 1003/LE/CD/note/security instrument", ids(note, si, urla)));
  checks.push(C("DQC_1003_FINAL_TERMS", up.urla_1003.loan_amount_cents === terms.principal_cents && pct3(up.urla_1003.note_rate_pct) === terms.note_rate_pct && up.urla_1003.term_months === terms.term_months, `${formatCents(terms.principal_cents)} ${terms.note_rate_pct}% ${terms.term_months}m`, `${formatCents(up.urla_1003.loan_amount_cents)} ${up.urla_1003.note_rate_pct}% ${up.urla_1003.term_months}m`, "B1-1-01: final 1003 must reflect the final loan terms", ids(urla)));
  const rendered = docs.filter((d) => d.kind.startsWith("rider_")).map((d) => d.form_number).sort();
  checks.push(C("DQC_RIDERS_REQUIRED", JSON.stringify(rendered) === JSON.stringify([...selection.riders].sort()), selection.riders.join(",") || "none", rendered.join(",") || "none", "riders required ≠ riders rendered", ids(si)));
  const tv = templateVersionCheck(up.templates, up.note_date);
  checks.push(C("DQC_TEMPLATE_VERSION", tv.result === "pass", `one revision family, mandatory ≤ ${up.note_date}`, tv.detail ?? `families ${tv.families.join("/")}`, tv.reason, ids(note, si)));
  const lc = lateCharge(s.state);
  checks.push(C("DQC_LATE_CHARGE_STATE", terms.late_charge_pct === lc.pct && terms.late_charge_days === lc.days && Number(terms.late_charge_pct) <= 5 && terms.late_charge_days >= 15, `${lc.pct}% / ${lc.days} days (${jurisdictionRule(s.state).citation})`, `${terms.late_charge_pct}% / ${terms.late_charge_days} days`, "late charge above the state cap or 5%/15 days", ids(note)));
  const recordables = docs.filter((d) => d.recordable && d.kind !== "poa_copy" && d.kind !== "tx_affidavit_3185" && !d.kind.startsWith("ny_") && d.kind !== "rider_leasehold_cross_default");
  checks.push(C("DQC_MIN_CHECK_DIGIT", isValidMin(min) && recordables.every((d) => d.min_present), `valid 18-digit MIN on the security instrument and each rider`, `${min || "none"}; on ${recordables.filter((d) => d.min_present).length}/${recordables.length} recordable instruments`, "MIN check digit invalid or MIN missing from a recordable instrument", ids(si)));
  if (selection.enote) {
    // The SMART Doc under test: the one 26.2's platform validated (`up.enote`) or, before that, the one the closer builds from the rendered eNote.
    let enote = up.enote ?? null; if (enote === null && note) { try { enote = buildSmartDocENote(s, terms, min, note); } catch { enote = null; } }
    checks.push(C("DQC_ENOTE_ARC_VIEW", !!enote && enote.ok && enote.arcs.length === Object.keys(enote.data).length && enote.tamper_seal_algorithm === "SHA-256" && enote.profile === "v1_0_2_cat1_closing_dtd_2_3_1", "every DATA point has an ARC to VIEW; SHA-256 seal; v1.0.2 Category One", enote ? (enote.ok ? `${enote.arcs.length} ARCs; ${enote.tamper_seal_algorithm}` : enote.reason) : "no SMART Doc (MIN invalid or note missing)", "SMART Doc ARC/VIEW validation failed", ids(note)));
  }
  if (s.tx_50a6) { checks.push(C("DQC_TX_2PCT", !!up.tx && up.tx.fee_test.pass, up.tx ? `≤ ${formatCents(up.tx.fee_test.cap_cents)}` : "fee test", up.tx ? formatCents(up.tx.fee_test.total_counted_cents) : "missing", "§50(a)(6)(E): counted fees exceed 2% of the principal", [])); checks.push(C("DQC_TX_80LTV", !!up.tx && up.tx.ltv_80_ok, "≤ 80% of fair market value", up.tx ? String(up.tx.ltv_80_ok) : "missing", "§50(a)(6)(B): exceeds 80% LTV/CLTV", [])); }
  if (s.ny_cema) checks.push(C("DQC_CEMA_SUM", !!up.cema && up.cema.dqc_cema_sum === "pass" && up.cema.status === "buildable", up.cema ? formatCents(up.cema.consolidated_amount_cents) : "CEMA", formatCents(s.loan_amount_cents), "consolidated amount ≠ Σ unpaid principal + new money, or a prior lender has not assigned", []));
  if (up.name_variances?.length) checks.push(C("DQC_NAME_VARIANCE", false, "signature names match the typed names", up.name_variances.join("; "), "B8-3-03: name affidavit required for a significant variance", ids(note), "soft"));
  const hard = checks.filter((c) => c.result === "fail" && c.severity === "hard").map((c) => c.rule_code); const soft = checks.filter((c) => c.result === "fail" && c.severity === "soft").map((c) => c.rule_code);
  return { checks, passed: hard.length === 0, hard_failures: hard, soft_failures: soft };
}

// ============================================================ closing instructions (`draftClosingInstructions`) — NTC_SM_CLOSING_INSTRUCTIONS
export interface ClosingInstructionsContent {
  readonly set_id: string; readonly version: number; readonly lender_name: string; readonly fulfillment_contact: string; readonly settlement_agent_party_id: string; readonly documents: readonly { kind: DocumentKind; form_number: string; signers: readonly string[]; notarized: boolean; witness_count: number; recordable: boolean; executed_by: string | null }[];
  readonly no_changes_rule: string; readonly funding_conditions: readonly string[]; readonly wire_verification_id: string; readonly wire_instructions_typed: false; readonly recording_instructions: readonly string[]; readonly document_return: readonly string[]; readonly eclosing: { closing_type: ClosingType; platform: string | null; session_id: string | null; ron_provider: string | null; notary_commission_state: string | null } | null;
  readonly tx_items: readonly string[]; readonly cpl_requirement: string; readonly disbursement_rule: string; readonly acknowledgment_sla: string; readonly signing_officer_signature_required: boolean; readonly post_closing_assignment_to_mers_prohibited: boolean; readonly text: string;
}
export function draftClosingInstructions(s: ClosingSnapshotInput, selection: DocumentSetSelection, docs: readonly RenderedDocument[], i: { set_id: string; version: number; settlement_agent_party_id: string; wire_verification_id: string; wire_verification_match_result: string; platform?: string | null; session_id?: string | null; ron_provider?: string | null; notary_commission_state?: string | null; state_requires_wet_lender_signature?: boolean }): ClosingInstructionsContent {
  if (i.wire_verification_match_result !== "verified") throw new RangeError("24.4 wire_verifications.match_result must be 'verified' — wire instructions are referenced, never typed into the letter");
  const dry = DRY_FUNDING_STATES.includes(s.state); const mersRider = MERS_RIDER_STATES.includes(s.state); const maine = MERS_ASSIGNMENT_STATES.includes(s.state);
  const funding = ["Every document executed exactly as instructed; no alterations, interlineations or handwritten changes to any document (call the re-draw hotline).", "Closing Protection Letter naming the Lender (and the servicer per the facility) received and dated before funding (SM_CPL_BEFORE_FUNDING_GATE).", "Title date-down clear of intervening matters.", dry ? "DRY-FUNDING STATE: do not record or disburse until the funder's written disbursement authorization (26.3); record then fund." : "WET-FUNDING STATE: funds are wired for the closing date; disburse only on the funder's written authorization after the execution review (26.3).", ...(s.rescindable ? ["Rescindable transaction: no disbursement before the rescission period expires (25.3; TX 50(a)(6): the later of the TILA and 7 TAC §153.25 periods)."] : []), "Settlement statement reconciled to the final Closing Disclosure before funding (26.3 FC_FIGURES_RECONCILED)."];
  const recording = [`Record the ${securityInstrumentName(s.state)} (Form ${selection.security_instrument_form}) first, with every rider attached, showing MIN ${s.min ?? ""}; then any affidavit (${s.tx_50a6 ? "Form 3185" : "none"}).`, ...(mersRider ? ["MERS Rider (Form 3158) attached; a post-closing assignment to MERS is prohibited in this state (B8-7-01)."] : []), ...(maine ? ["Maine: record the MERS Mortgage Assignment (Form 3749), executed at closing by the Lender's signing officer, promptly after the Mortgage."] : []), "eRecord through the Lender's eRecording vendor where the county accepts it; paper fallback with tracking otherwise (26.2)."];
  const ret = ["Original wet-signed note (paper closings) to the warehouse document custodian by overnight courier within one business day of signing (26.4 SM_O74_NOTE_PICKUP_SCAN_1BD).", "Recorded security instrument and the final ALTA 2021 loan policy as trailing documents (26.4: recorded instrument within the eRecording timer; final policy within 60 days).", "Executed closing instructions acknowledgment returned before the signing session opens."];
  const tx = s.tx_50a6 ? ["Closing only at the settlement agent's permanent physical office (7 TAC §153.15) — never at the homestead, never by RON or remote ink.", "Title policy with the T-42 Equity Loan Mortgage Endorsement and T-42.1 Supplemental Coverage, no deletions to paragraphs 2(a)–(e), with 2(f).", "Form 3185 Texas Home Equity Affidavit and Agreement recorded; fair-market-value acknowledgment with the appraisal attached, executed by the owners and the Lender's signing officer.", "Closing receipt itemizing every document delivered to the owner; a copy of the final loan application and all executed documents to the owner (§50(a)(6)(Q)(v)).", "Acknowledgment of these instructions by the title company is mandatory before the signing (B5-4.1-03)."] : [];
  const eclosing = selection.closing_type === "wet" ? null : { closing_type: selection.closing_type, platform: i.platform ?? null, session_id: i.session_id ?? null, ron_provider: i.ron_provider ?? null, notary_commission_state: i.notary_commission_state ?? null };
  const documents = docs.map((d) => ({ kind: d.kind, form_number: d.form_number, signers: d.signers.map((x) => x.signature_line), notarized: d.notarized, witness_count: d.witness_count, recordable: d.recordable, executed_by: selection.documents.find((x) => x.kind === d.kind)?.executed_by ?? null }));
  const text = [`Transaction: application ${s.application_id}, set ${i.set_id} v${i.version}; property ${s.property_address}, ${s.state}; note date ${s.note_date}; closing type ${selection.closing_type}.`, `Documents: ${documents.map((d) => `${d.form_number} (${d.kind}${d.notarized ? "; notarize" : ""}${d.witness_count ? `; ${d.witness_count} witnesses` : ""}${d.executed_by ? `; executed by ${d.executed_by}` : ""})`).join("; ")}.`, "NO CHANGES TO ANY DOCUMENT.", `Funding conditions: ${funding.join(" ")}`, `Wire instructions: per the verified wire record ${i.wire_verification_id} (24.4 wire_verifications.match_result=verified) — not restated here; never accept instructions by e-mail.`, `Recording: ${recording.join(" ")}`, `Document return: ${ret.join(" ")}`, eclosing ? `eClosing: ${eclosing.closing_type} on ${eclosing.platform ?? "the platform"}; session ${eclosing.session_id ?? "tba"}; RON provider ${eclosing.ron_provider ?? "n/a"}; notary commission ${eclosing.notary_commission_state ?? "n/a"}.` : "Paper (wet) closing.", ...(tx.length ? [`Texas 50(a)(6): ${tx.join(" ")}`] : []), "Please acknowledge these instructions within the SLA (same day)."].join("\n");
  return { set_id: i.set_id, version: i.version, lender_name: lender(s), fulfillment_contact: s.servicer.name, settlement_agent_party_id: i.settlement_agent_party_id, documents, no_changes_rule: "No changes to any document; re-draw hotline on any discrepancy.", funding_conditions: funding, wire_verification_id: i.wire_verification_id, wire_instructions_typed: false, recording_instructions: recording, document_return: ret, eclosing, tx_items: tx, cpl_requirement: "CPL naming the Lender (and the servicer per the facility) dated before funding", disbursement_rule: "No disbursement before the funder's written authorization (26.3 gates)", acknowledgment_sla: s.tx_50a6 ? "before the signing session opens (mandatory)" : "same day", signing_officer_signature_required: !!i.state_requires_wet_lender_signature, post_closing_assignment_to_mers_prohibited: mersRider, text };
}

// ============================================================ the document set aggregate + emitters (closing_document_sets)
export type SetStatus = "pending_data" | "snapshot_taken" | "generated" | "qc_failed" | "qc_passed" | "released" | "executed" | "closed" | "superseded" | "voided";
export type RedrawReason = "cd_corrected" | "rate_change" | "date_change" | "vesting_change" | "template_retired" | "qc_defect_found" | "borrower_request";
export interface ClosingDocumentSet {
  readonly set_id: string; readonly application_id: string; readonly closing_id: string | null; readonly snapshot_id: string | null; readonly snapshot_hash: string | null; readonly closing_type: ClosingType | null; readonly document_set_profile: string | null; readonly status: SetStatus;
  readonly cd_version_required: number | null; readonly cd_received_on: PlainDate | null; readonly scheduled_signing_at: string | null; readonly generated_at: string | null; readonly qc_passed_at: string | null; readonly released_at: string | null; readonly released_to_party_id: string | null; readonly superseded_by_set_id: string | null; readonly redraw_reason: RedrawReason | null;
  readonly documents: readonly RenderedDocument[]; readonly qc: readonly QcCheck[]; readonly instructions: { instruction_id: string; version: number; sent_at: string; acknowledged_at: string | null; acknowledged_by: string | null } | null; readonly template_version: TemplateVersionResult | null;
}
export function openDocumentSet(events: EventStore, i: { set_id: string; application_id: string; at: string }): { set: ClosingDocumentSet; event: DomainEvent } {
  const set: ClosingDocumentSet = { set_id: i.set_id, application_id: i.application_id, closing_id: null, snapshot_id: null, snapshot_hash: null, closing_type: null, document_set_profile: null, status: "pending_data", cd_version_required: null, cd_received_on: null, scheduled_signing_at: null, generated_at: null, qc_passed_at: null, released_at: null, released_to_party_id: null, superseded_by_set_id: null, redraw_reason: null, documents: [], qc: [], instructions: null, template_version: null };
  const event = events.append({ type: "closing.document_set.opened", applicationId: i.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: i.application_id, set_id: i.set_id, status: "pending_data" } });
  return { set, event };
}
/** Consumer of 25.2's and 26.2's events (never re-emitted): the CD version to match, receipt date for the 3-business-day gate, corrections re-open the set, the scheduled signing anchors SM_O71_DOCS_TO_AGENT_1BD. */
export function applyUpstreamEvent(set: ClosingDocumentSet, e: DomainEvent): ClosingDocumentSet {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "disclosure.cd.delivered": return { ...set, cd_version_required: Number(p.version ?? p.cd_version ?? set.cd_version_required ?? 1) };
    case "disclosure.cd.received": return { ...set, cd_version_required: Number(p.version ?? p.cd_version ?? set.cd_version_required ?? 1), cd_received_on: D(String(p.effective_receipt_date ?? p.received_on ?? e.occurredAt.slice(0, 10))) };
    case "disclosure.cd.corrected": return set.status === "released" || set.status === "executed" ? { ...set, status: "superseded", redraw_reason: "cd_corrected" } : { ...set, status: "pending_data", cd_version_required: Number(p.version ?? p.cd_version ?? (set.cd_version_required ?? 0) + 1) };
    case "closing.scheduled": return { ...set, closing_id: String(p.closing_id ?? set.closing_id ?? ""), scheduled_signing_at: String(p.scheduled_at ?? e.occurredAt) };
    case "closing.consummated": return set.status === "released" ? { ...set, status: "executed" } : set;
    default: return set;
  }
}
export interface DocGenGateFacts { readonly final_cd_delivered: boolean; readonly approval_ptd_cleared: boolean; readonly trust_poa_gate_open: boolean; readonly compliance_pass_cd_gate_open: boolean; readonly lock_status: string; readonly lock_expires_on: PlainDate | null; readonly closing_date: PlainDate | null; }
/** SM_O71_DOC_GEN_GATE: final CD delivered, approval with PTD conditions cleared, 24.4 trust/POA gate and 25.1 compliance gate open, lock active through the closing date. */
export function docGenGate(f: DocGenGateFacts): { open: boolean; reason?: string } {
  const missing: string[] = [];
  if (!f.final_cd_delivered) missing.push("final CD not delivered (disclosure.cd.delivered)"); if (!f.approval_ptd_cleared) missing.push("decision.issued{approval} with PTD conditions cleared (23.3)"); if (!f.trust_poa_gate_open) missing.push("SM_TRUST_POA_REVIEW_GATE closed (24.4)"); if (!f.compliance_pass_cd_gate_open) missing.push("SM_O61_COMPLIANCE_PASS_CD_GATE closed (25.1)");
  if (f.lock_status !== "active") missing.push(`lock status ${f.lock_status} ≠ active`); else if (f.lock_expires_on && f.closing_date && f.lock_expires_on < f.closing_date) missing.push(`lock expires ${f.lock_expires_on} before the closing ${f.closing_date}`);
  return missing.length ? { open: false, reason: missing.join("; ") } : { open: true };
}
export function takeClosingSnapshot(events: EventStore, set: ClosingDocumentSet, input: ClosingSnapshotInput, i: { snapshot_id: string; at: string; gate: DocGenGateFacts; min_sequence?: string }): { set: ClosingDocumentSet; snapshot: ClosingSnapshot; terms: NoteTerms; event: DomainEvent } {
  const g = docGenGate(i.gate); if (!g.open) throw new RangeError(`SM_O71_DOC_GEN_GATE closed: ${g.reason}`);
  if (set.status !== "pending_data") throw new RangeError(`set ${set.set_id} is ${set.status}; a snapshot is taken from pending_data (re-draw opens a new set)`);
  if (set.cd_version_required !== null && input.cd_version !== set.cd_version_required) throw new RangeError(`snapshot cd_version ${input.cd_version} ≠ the delivered CD version ${set.cd_version_required}`);
  const terms = computeNoteTerms({ principal_cents: input.loan_amount_cents, note_rate_pct: input.note_rate_pct, term_months: input.term_months, scheduled_disbursement_date: input.scheduled_disbursement_date, state: input.state, product: input.product, arm: input.arm ?? null });
  const min = input.min ?? generateMin(input.partner.mers_org_id, i.min_sequence ?? "1").min;
  const payload = { ...input, note_terms: terms, min };
  const snapshot: ClosingSnapshot = { snapshot_id: i.snapshot_id, application_id: input.application_id, cd_version: input.cd_version, du_submission_number: input.du_submission_number, lock_id: input.lock_id, taken_at: i.at, payload, payload_hash: payloadHash(payload) };
  const event = events.append({ type: "closing.data_snapshot.taken", applicationId: input.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: input.application_id, set_id: set.set_id, snapshot_id: i.snapshot_id, payload_hash: snapshot.payload_hash, cd_version: input.cd_version, du_submission_number: input.du_submission_number, lock_id: input.lock_id, min, note_terms_hash: terms.data_hash } });
  return { set: { ...set, status: "snapshot_taken", snapshot_id: i.snapshot_id, snapshot_hash: snapshot.payload_hash }, snapshot, terms, event };
}
export function generateDocuments(events: EventStore, set: ClosingDocumentSet, snap: ClosingSnapshot, i: { at: string; library?: readonly DocumentTemplate[]; buydown?: BuydownAgreement | null; cema?: CemaPackage | null }): { set: ClosingDocumentSet; selection: DocumentSetSelection; documents: RenderedDocument[]; templates: DocumentTemplate[]; event: DomainEvent } {
  if (set.status !== "snapshot_taken" && set.status !== "qc_failed") throw new RangeError(`generateDocuments needs snapshot_taken (set is ${set.status})`);
  const lib = i.library ?? DEFAULT_TEMPLATE_LIBRARY; const s = snap.payload;
  const selection = selectDocumentSet(s, lib);
  const cema = i.cema ?? (s.ny_cema ? buildCemaPackage(s) : null); const buydown = i.buydown ?? (s.buydown ? draftBuydownAgreement(s, s.buydown, s.note_terms) : null);
  const documents = selection.documents.filter((d) => d.kind !== "closing_instructions").map((d) => renderDocument(d, s, s.note_terms, s.min, snap.payload_hash, selection, { buydown, cema }));
  const templates = selection.documents.map((d) => (d.template_id ? lib.find((t) => t.template_id === d.template_id) ?? null : null)).filter((t): t is DocumentTemplate => t !== null);
  const event = events.append({ type: "closing.documents.generated", applicationId: s.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: s.application_id, set_id: set.set_id, profile: selection.profile, closing_type: selection.closing_type, enote: selection.enote, note_date: s.note_date, snapshot_hash: snap.payload_hash, templates: templates.map((t) => t.template_id), documents: documents.map((d) => ({ document_id: d.document_id, kind: d.kind, form_number: d.form_number, data_hash: d.data_hash, render_hash: d.render_hash })) } });
  return { set: { ...set, status: "generated", generated_at: i.at, closing_type: selection.closing_type, document_set_profile: selection.profile, documents }, selection, documents, templates, event };
}
export function recordDocumentQc(events: EventStore, set: ClosingDocumentSet, qc: ReturnType<typeof runDocumentQc>, at: string): { set: ClosingDocumentSet; events: DomainEvent[] } {
  const out: DomainEvent[] = [];
  for (const c of qc.checks) out.push(events.append({ type: "closing.document_qc.check", applicationId: set.application_id, actor: CLOSER, occurredAt: at, payload: { application_id: set.application_id, set_id: set.set_id, rule_code: c.rule_code, result: c.result, severity: c.severity, expected: c.expected, actual: c.actual, reason: c.reason } }));
  const tv = qc.checks.find((c) => c.rule_code === "DQC_TEMPLATE_VERSION");
  const template_version: TemplateVersionResult | null = tv ? { result: tv.result === "fail" ? "fail" : "pass", reason: (tv.reason?.split(":")[0] as TemplateVersionReason | undefined) ?? null, detail: tv.actual, families: [], per_template: [] } : null;
  if (qc.passed) { out.push(events.append({ type: "closing.document_qc.passed", applicationId: set.application_id, actor: CLOSER, occurredAt: at, payload: { application_id: set.application_id, set_id: set.set_id, checks: qc.checks.length, waived: qc.checks.filter((c) => c.result === "waived").map((c) => c.rule_code), soft_failures: qc.soft_failures } })); return { set: { ...set, status: "qc_passed", qc_passed_at: at, qc: qc.checks, template_version }, events: out }; }
  out.push(events.append({ type: "closing.document_qc.failed", applicationId: set.application_id, actor: CLOSER, occurredAt: at, payload: { application_id: set.application_id, set_id: set.set_id, failed: qc.hard_failures, reasons: qc.checks.filter((c) => c.result === "fail").map((c) => `${c.rule_code}: ${c.reason}`) } }));
  return { set: { ...set, status: "qc_failed", qc: qc.checks, template_version }, events: out };
}
export interface ReleaseGateFacts { readonly qc_pass_gate_open: boolean; readonly template_version_gate_open: boolean; readonly tx_gates_open: boolean; readonly instructions_acknowledged: boolean; readonly tx_50a6: boolean; }
export type ReleaseRefusal = "SM_O71_DOC_QC_PASS_GATE_CLOSED" | "SM_O71_TEMPLATE_VERSION_GATE_CLOSED" | "TX_GATES_CLOSED" | "SET_NOT_QC_PASSED";
export class ReleaseRefused extends RangeError { readonly code: ReleaseRefusal; readonly escalation_kind: "officer" | null; constructor(code: ReleaseRefusal, why: string, escalation_kind: "officer" | null) { super(`release refused [${code}]: ${why}`); this.name = "ReleaseRefused"; this.code = code; this.escalation_kind = escalation_kind; } }
/** State-machine guard: `released` only from `qc_passed` with the QC, template-version and TX gates open; a waiver request (officer-only) is an escalation, never a bypass. */
export function releaseDecision(set: ClosingDocumentSet, f: ReleaseGateFacts, waiver_requested: boolean): { ok: true } | { ok: false; code: ReleaseRefusal; why: string; escalate_to: "officer" | null } {
  const esc = waiver_requested ? "officer" as const : null;
  if (!f.qc_pass_gate_open || set.status === "qc_failed") return { ok: false, code: "SM_O71_DOC_QC_PASS_GATE_CLOSED", why: "a hard document_qc_checks rule failed and no officer waiver is recorded", escalate_to: esc };
  if (set.status !== "qc_passed") return { ok: false, code: "SET_NOT_QC_PASSED", why: `set is ${set.status}`, escalate_to: esc };
  if (!f.template_version_gate_open) return { ok: false, code: "SM_O71_TEMPLATE_VERSION_GATE_CLOSED", why: "a template is retired/not yet mandatory or the revision families are mixed", escalate_to: esc };
  if (f.tx_50a6 && !f.tx_gates_open) return { ok: false, code: "TX_GATES_CLOSED", why: "TX 12-day / itemization / one-year gate closed", escalate_to: esc };
  return { ok: true };
}
export function releaseDocumentSet(events: EventStore, set: ClosingDocumentSet, i: { at: string; released_to: "eclosing_platform" | "settlement_agent"; released_to_party_id: string; facts: ReleaseGateFacts; waiver_requested?: boolean }): { set: ClosingDocumentSet; event: DomainEvent } {
  const d = releaseDecision(set, i.facts, !!i.waiver_requested); if (!d.ok) throw new ReleaseRefused(d.code, d.why, d.escalate_to);
  const event = events.append({ type: "closing.documents.released", applicationId: set.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: set.application_id, set_id: set.set_id, released_to: i.released_to, released_to_party_id: i.released_to_party_id, closing_type: set.closing_type, documents: set.documents.map((x) => x.document_id), scheduled_signing_at: set.scheduled_signing_at } });
  return { set: { ...set, status: "released", released_at: i.at, released_to_party_id: i.released_to_party_id }, event };
}
/** SM_O71_DOCS_TO_AGENT_1BD: the package is due one creditor business day before the signing start (26.2's `closing.scheduled` arms it). */
export function docsToAgentDue(signing_date: PlainDate): PlainDate { return addBusinessDays(signing_date, -1, creditor); }
export function sendClosingInstructions(events: EventStore, set: ClosingDocumentSet, content: ClosingInstructionsContent, i: { instruction_id: string; at: string; pdf_document_id: string | null }): { set: ClosingDocumentSet; event: DomainEvent } {
  const event = events.append({ type: "closing.instructions.sent", applicationId: set.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: set.application_id, set_id: set.set_id, instruction_id: i.instruction_id, version: content.version, settlement_agent_party_id: content.settlement_agent_party_id, notice: NOTICE_CLOSING_INSTRUCTIONS, pdf_document_id: i.pdf_document_id, signing_officer_signature_required: content.signing_officer_signature_required, wire_instructions_typed: false } });
  return { set: { ...set, instructions: { instruction_id: i.instruction_id, version: content.version, sent_at: i.at, acknowledged_at: null, acknowledged_by: null } }, event };
}
export function acknowledgeClosingInstructions(events: EventStore, set: ClosingDocumentSet, i: { at: string; acknowledged_by: string }): { set: ClosingDocumentSet; event: DomainEvent } {
  if (!set.instructions) throw new RangeError("no closing instructions have been sent for this set");
  const event = events.append({ type: "closing.instructions.acknowledged", applicationId: set.application_id, actor: { kind: "external", id: i.acknowledged_by }, occurredAt: i.at, payload: { application_id: set.application_id, set_id: set.set_id, instruction_id: set.instructions.instruction_id, acknowledged_by: i.acknowledged_by, acknowledged_at: i.at } });
  return { set: { ...set, instructions: { ...set.instructions, acknowledged_at: i.at, acknowledged_by: i.acknowledged_by } }, event };
}
export function scheduleRedraw(events: EventStore, set: ClosingDocumentSet, i: { at: string; reason: RedrawReason; new_set_id: string; signing_begun: boolean; note_terms_changed: boolean }): { superseded: ClosingDocumentSet; next: ClosingDocumentSet; events: DomainEvent[]; enote_reversal_required: boolean } {
  const out: DomainEvent[] = [];
  const superseded: ClosingDocumentSet = { ...set, status: "superseded", superseded_by_set_id: i.new_set_id, redraw_reason: i.reason };
  out.push(events.append({ type: "closing.documents.redrawn", applicationId: set.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: set.application_id, set_id: set.set_id, superseded_by_set_id: i.new_set_id, redraw_reason: i.reason, signing_begun: i.signing_begun, note_terms_changed: i.note_terms_changed, corrected_cd_question_to: i.reason === "cd_corrected" || i.note_terms_changed ? "25.2" : null } }));
  const opened = openDocumentSet(events, { set_id: i.new_set_id, application_id: set.application_id, at: i.at }); out.push(opened.event);
  return { superseded, next: { ...opened.set, cd_version_required: set.cd_version_required, cd_received_on: set.cd_received_on, closing_id: set.closing_id, scheduled_signing_at: set.scheduled_signing_at }, events: out, enote_reversal_required: i.note_terms_changed && set.closing_type !== "wet" && set.documents.some((d) => d.kind === "enote") };
}
export function activateTemplate(events: EventStore, t: DocumentTemplate, at: string): { template: DocumentTemplate; event: DomainEvent } {
  if (!t.counsel_approval_id) throw new RangeError("a template is activated only with counsel approval (template_approvals)");
  return { template: { ...t, status: "active" }, event: events.append({ type: "document.template.activated", actor: CLOSER, occurredAt: at, payload: { template_id: t.template_id, form_number: t.form_number, revision_date: t.revision_date, mandatory_from: t.mandatory_from, source: "origination" } }) };
}
export function retireTemplate(events: EventStore, t: DocumentTemplate, i: { at: string; retired_after: PlainDate; reason: string }): { template: DocumentTemplate; event: DomainEvent } {
  return { template: { ...t, status: "retired", retired_after: i.retired_after }, event: events.append({ type: "document.template.retired", actor: CLOSER, occurredAt: i.at, payload: { template_id: t.template_id, form_number: t.form_number, retired_after: i.retired_after, reason: i.reason, source: "origination" } }) };
}
/** Gate facts for the evaluators (evaluators-26-1.ts) from the set and the TX review. */
export function setGateFacts(set: ClosingDocumentSet, tx: TxHomeEquityReview | null, note_date: PlainDate, templates: readonly DocumentTemplate[]): Record<string, unknown> {
  return { status: set.status, checks: set.qc.map((c) => ({ rule_code: c.rule_code, result: c.result })), templates, note_date, acknowledged_at: set.instructions?.acknowledged_at ?? null, tx_50a6: !!tx?.is_50a6, cd_received_on: set.cd_received_on, closing_date: set.scheduled_signing_at ? set.scheduled_signing_at.slice(0, 10) : null };
}
export const money = formatCents;
