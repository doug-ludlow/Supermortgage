/**
 * §23.4 ATR/QM, HPML, HOEPA and state high-cost determinations — pure rule functions the `compliance-tester` agent
 * runs at each stage (`le` → `lock` → `cd` → `consummation` → `post_closing`). One small function per rule / T-id.
 *
 * Seam with 25.1 (src/domain/compliance-disclosures/ops-25-1.ts): the versioned rule sets (`regz.qm.general.2021`
 * v2026, `regz.hoepa` v2026, `regz.hpml` v2026), the Appendix J APR engine, the §1026.4 finance-charge classifier, the
 * bona fide discount-point benchmark and determineQm / determineHpml / determineHoepa are IMPORTED and reused — never
 * re-implemented. 23.4 owns what the spec's data model adds on top: the stage rows (`qm_determinations`,
 * `hpml_determinations`, `high_cost_determinations`), the APOR snapshot selection and staleness rule
 * (`apor_tables`; consumes 25.1's `apor.table.ingested{table_date}`), the §1026.32(b)(1) itemization with exclusion
 * reason codes, the §1026.32(b)(4)(i) total loan amount, the 2026 tier names, the product tests, the eight-factor
 * consider-and-verify map, the state tests, the Fannie Mae eligibility flag and the events:
 *   compliance.qm.determined{stage, qm_type}            compliance.hpml.determined{stage, is_hpml, appraisal_rules_apply}
 *   compliance.high_cost.determined{stage, is_hoepa, is_state_high_cost}
 *   compliance.test.passed / compliance.test.failed{test ∈ {qm, hpml, hoepa, state_high_cost}, stage}
 *   compliance.pf_cure.required{cure_required_cents, consummated_on_or_before_2021_01_10=false} / compliance.pf_cure.paid
 *   restructure.proposed{kind=fee_change} (23.2's loop, opened from here when the CD-stage row is `not_qm`)
 * Every event carries `applicationId` so the 23.4 gates arm under origination context (src/kernel/timers/engine.ts).
 *
 * Rounding (rule 3): cents; percentages at four decimals; the QM cap is floor(total_loan_amount_cents × pct / 100) for the
 * percentage tiers. 25.1's determineQm rounds the same cap HALF_UP (one cent looser on a .5+ fraction) — the spec's
 * floor rule wins here and the 25.1 figure is kept on the row as `cap_cents_25_1` for the audit.
 */
import { Decimal } from "../../kernel/money/decimal.ts";
import { type Cents, centsToDecimal, sumCents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { ruleSet, ruleSetVersions, classifyFinanceCharges, excludableDiscountPoints, totalLoanAmount, determineQm, determineHpml, determineHoepa, aporAsOf, pctOf,
  type AporTable, type FeeItemInput, type FeeBenchmark, type FcClassificationRow, type QmRuleSet, type HpmlRuleSet, type HoepaRuleSet, type DeterminationInput, type QmDetermination, type HpmlDetermination, type HoepaDetermination } from "../compliance-disclosures/ops-25-1.ts";
import { hpmlMinCancelDate } from "../orig-boarding/ops-30-3.ts";
import { evaluateWaiver, type WaiverRequest, type WaiverDecision } from "../escrow/waiver.ts";

export const AGENT_23_4: Actor = { kind: "agent", id: "compliance-tester" };
const HUNDRED = Decimal.fromInt(100);
const dec = (v: string | number): Decimal => Decimal.parse(String(v));
const need = (cond: unknown, msg: string): void => { if (!cond) throw new RangeError(msg); };
const isDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** `pct` percent of `base` in cents, floored (rule 3: "the cap is floor(total_loan_amount_cents × 3 / 100)"). */
export const floorPct = (base: Cents, pct: string): Cents => centsToDecimal(base).mul(Decimal.parse(pct)).div(HUNDRED).toCents("FLOOR");
/** `pct` percent of `base` in cents, half-up (HOEPA / state thresholds — the spec's worked figures $27,810.98 and $20,213.73). */
export const roundPct = (base: Cents, pct: string): Cents => centsToDecimal(base).mul(Decimal.parse(pct)).div(HUNDRED).toCents("HALF_UP");
const r3 = (d: Decimal): number => Number(d.toFixed(3, "HALF_UP"));
const r4 = (d: Decimal): number => Number(d.toFixed(4, "HALF_UP"));

// ============================================================ stages and the rate-set date (rule 1)
export type Stage = "le" | "lock" | "cd" | "consummation" | "post_closing";
export const STAGES: readonly Stage[] = ["le", "lock", "cd", "consummation", "post_closing"];
export type LockKind = "initial" | "extension" | "relock" | "float_down" | "renegotiation";
export interface LockRow { readonly lock_id: string; readonly kind: LockKind; readonly locked_at: string; readonly rate_pct: string; readonly product: "fixed" | "adjustable"; readonly term_years: number; readonly initial_fixed_years?: number | null; }
/** The date the interest rate was (last) set on or before `as_of`: an extension keeps the prior rate-set date; a relock, float-down or renegotiation resets it (§1026.35(a)(1); comment 35(a)(2)-3 [PARTIALLY VERIFIED]). */
export function rateSetDate(locks: readonly LockRow[], as_of: PlainDate): { rate_set_date: PlainDate | null; lock: LockRow | null; superseded_lock_ids: string[] } {
  const setting = locks.filter((l) => l.kind !== "extension" && plainDate(l.locked_at.slice(0, 10)) <= as_of).sort((a, b) => (a.locked_at < b.locked_at ? -1 : 1));
  const last = setting.at(-1) ?? null;
  return { rate_set_date: last ? plainDate(last.locked_at.slice(0, 10)) : null, lock: last, superseded_lock_ids: setting.slice(0, -1).map((l) => l.lock_id) };
}

// ============================================================ APOR (apor_tables; FFIEC weekly tables)
export interface AporTableRow { readonly table_id: string; readonly published_on: PlainDate; readonly effective_week: PlainDate; readonly type: "fixed" | "adjustable"; readonly rows: Readonly<Record<string, string>>; readonly source_url: string; readonly fetched_at: string; readonly hash: string; }
export type AporSource = "ffiec_table" | "rate_spread_api";
export interface AporSelection { readonly table: AporTableRow | null; readonly table_id: string | null; readonly apor_pct: string | null; readonly table_date: PlainDate | null; readonly source: AporSource; readonly age_days: number | null; readonly current_week: boolean; readonly apor_stale: boolean; readonly blocked: boolean; readonly reason: string | null; readonly as_25_1: AporTable | null; }
export const APOR_STALE_DAYS = 14;
/** The APOR row for the loan's term and amortization type from the table current on the rate-set date (the FFIEC table effective the Monday of that week; 25.1 aporAsOf), else the last ingested table flagged `apor_stale`. A table older than 14 days at a `lock`/`cd`/`consummation` determination blocks (`FFIEC_APOR_TABLE_REFRESH_WEEKLY` breach action). */
export function selectApor(tables: readonly AporTableRow[], i: { rate_set_date: PlainDate; term_years: number; product: "fixed" | "adjustable"; stage: Stage; requested_on: PlainDate }): AporSelection {
  need(isDate(i.rate_set_date) && isDate(i.requested_on), "rate_set_date and requested_on must be ISO dates");
  const key = String(i.term_years);
  const candidates = tables.filter((t) => t.type === i.product && t.rows[key] !== undefined && t.effective_week <= i.rate_set_date).sort((a, b) => (a.effective_week < b.effective_week ? -1 : 1));
  const as251: AporTable[] = candidates.map((t) => ({ table_date: t.effective_week, term_years: i.term_years, product: t.type, apor_pct: t.rows[key]! }));
  const exact = aporAsOf(as251, i.rate_set_date, i.term_years, i.product);
  const table = exact ? candidates.find((t) => t.effective_week === exact.table_date)! : candidates.at(-1) ?? null;
  if (!table) return { table: null, table_id: null, apor_pct: null, table_date: null, source: "ffiec_table", age_days: null, current_week: false, apor_stale: true, blocked: true, reason: `apor_missing: no ${i.product} ${i.term_years}-year APOR table on or before ${i.rate_set_date}`, as_25_1: null };
  // the APOR is fixed "as of the date the interest rate is set": the table's age is measured at the rate-set date (a cd/consummation re-run keeps the lock-stage
  // snapshot unless the rate was re-set — rule 1); a table more than 14 days old there is `apor_stale` and blocks the lock/cd/consummation-stage determination
  const age_days = daysBetween(table.effective_week, i.rate_set_date);
  const apor_stale = age_days > APOR_STALE_DAYS;
  const blocked = apor_stale && (i.stage === "lock" || i.stage === "cd" || i.stage === "consummation");
  return { table, table_id: table.table_id, apor_pct: table.rows[key]!, table_date: table.effective_week, source: "ffiec_table", age_days, current_week: exact !== null, apor_stale, blocked,
    reason: blocked ? `apor_stale: table ${table.table_id} (effective ${table.effective_week}) is ${age_days} days old at the rate-set date ${i.rate_set_date} for the ${i.stage}-stage determination requested ${i.requested_on} (> ${APOR_STALE_DAYS}); blocked until FFIEC_APOR_TABLE_REFRESH_WEEKLY ingests a newer table` : null,
    as_25_1: { table_date: table.effective_week, term_years: i.term_years, product: table.type, apor_pct: table.rows[key]! } };
}

// ============================================================ points and fees — §1026.32(b)(1) itemization (rule 3)
export type PfCategory = "b1_i_finance_charge" | "b1_ii_lo_comp" | "b1_iii_real_estate" | "b1_iv_credit_ins" | "b1_v_ppp_max" | "b1_vi_ppp_refi";
export type PfExclusion = "interest" | "agency_mi" | "pmi_at_or_below_fha" | "pmi_after_consummation" | "bona_fide_third_party" | "bona_fide_discount_2" | "bona_fide_discount_1" | "creditor_employee_comp" | "reasonable_no_comp_not_affiliate" | "not_finance_charge" | null;
export type LoCompKind = "creditor_to_employee" | "consumer_to_broker" | "broker_to_employee" | "creditor_to_broker" | "retailer_to_employee" | "other";
/** A `fee_items` row (21.2/21.5) with the payee / affiliate / retained / bona-fide flags the fee taxonomy carries (operational prerequisites). */
export interface FeeItem23 extends FeeItemInput {
  readonly payee?: string; readonly affiliate?: boolean; readonly retained_by_creditor?: boolean; readonly creditor_compensated?: boolean; readonly reasonable?: boolean | null;
  readonly discount_points?: number; readonly mi_kind?: "agency" | "private"; readonly paid_at?: "consummation" | "after_consummation"; readonly fha_upfront_equivalent_cents?: Cents;
  readonly lo_comp_kind?: LoCompKind; readonly ppp_max_cents?: Cents; readonly same_creditor_refinance?: boolean;
}
export interface PfItem { readonly fee_item_id: string; readonly description: string; readonly amount_cents: Cents; readonly payee: string; readonly category: PfCategory | null; readonly included: boolean; readonly included_cents: Cents; readonly exclusion: PfExclusion; readonly basis: string; readonly finance_charge: FcClassificationRow["classification"]; readonly financed: boolean; }
export interface BonaFideDiscount { readonly undiscounted_rate_pct: string | null; readonly apor_pct: string | null; readonly undiscounted_minus_apor: number | null; readonly max_excludable_points: 0 | 1 | 2; readonly exclusion: "bona_fide_discount_2" | "bona_fide_discount_1" | null; readonly basis: string; readonly evidence: string | null; }
/** §1026.32(b)(1)(i)(E)/(F): up to 2 bona fide points if the undiscounted rate ≤ APOR + 1; up to 1 if ≤ APOR + 2; none otherwise — and none without the pricing engine's undiscounted-rate evidence (20.4 `pricing_quotes`). Benchmark arithmetic is 25.1's excludableDiscountPoints. */
export function evaluateBonaFideDiscount(i: { undiscounted_rate_pct?: string | null; apor_pct?: string | null; buydown_evidence_ref?: string | null }): BonaFideDiscount {
  const und = i.undiscounted_rate_pct ?? null, apor = i.apor_pct ?? null;
  if (!und || !apor) return { undiscounted_rate_pct: und, apor_pct: apor, undiscounted_minus_apor: null, max_excludable_points: 0, exclusion: null, basis: "no exclusion: the undiscounted rate (20.4 pricing_quotes) and the APOR are both required before any discount point is excluded", evidence: i.buydown_evidence_ref ?? null };
  const max = excludableDiscountPoints("federal_1026_32", { undiscounted_rate_pct: und, apor_pct: apor }) as 0 | 1 | 2;
  const diff = r3(dec(und).sub(dec(apor)));
  const exclusion = max === 2 ? "bona_fide_discount_2" : max === 1 ? "bona_fide_discount_1" : null;
  return { undiscounted_rate_pct: und, apor_pct: apor, undiscounted_minus_apor: diff, max_excludable_points: max, exclusion, evidence: i.buydown_evidence_ref ?? null,
    basis: max === 2 ? `§1026.32(b)(1)(i)(E): undiscounted ${und} − APOR ${apor} = ${diff} ≤ 1.00 → up to 2 bona fide points excluded` : max === 1 ? `§1026.32(b)(1)(i)(F): undiscounted ${und} − APOR ${apor} = ${diff} ≤ 2.00 → up to 1 bona fide point excluded` : `not excludable: undiscounted ${und} − APOR ${apor} = ${diff} > 2.00` };
}
export interface Classification23 { readonly items: readonly PfItem[]; readonly pf_cents: Cents; readonly prepaid_finance_charges_cents: Cents; readonly bona_fide_discount_points_excluded_cents: Cents; readonly bona_fide: BonaFideDiscount; readonly exclusions: readonly PfExclusion[]; }
const THIRD_PARTY_SERVICES = new Set<FeeItemInput["service_code"]>(["credit_report", "appraisal", "flood_determination", "flood_life_of_loan", "tax_service", "mers_registration", "courier"]);
/** One row per fee item with its §1026.32(b)(1) category, inclusion and exclusion reason code. Finance-charge status is 25.1's §1026.4 classification (a creditor-retained charge is a finance charge whatever its label — §1026.4(a); the (c)(7) exclusion covers third-party fees). */
export function classifyFeeItems(items: readonly FeeItem23[], ctx: { as_of: PlainDate; undiscounted_rate_pct?: string | null; apor_pct?: string | null; state?: string; county?: string | null; benchmarks?: readonly FeeBenchmark[]; buydown_evidence_ref?: string | null }): Classification23 {
  const fc = new Map(classifyFinanceCharges(items, { as_of: ctx.as_of, ...(ctx.state ? { state: ctx.state } : {}), county: ctx.county ?? null, benchmarks: ctx.benchmarks ?? [] }).map((r) => [r.fee_item_id, r] as const));
  const bona_fide = evaluateBonaFideDiscount({ undiscounted_rate_pct: ctx.undiscounted_rate_pct ?? null, apor_pct: ctx.apor_pct ?? null, buydown_evidence_ref: ctx.buydown_evidence_ref ?? null });
  let pointsLeft = bona_fide.max_excludable_points, excludedPts = 0n, pfc = 0n;
  const out: PfItem[] = [];
  for (const it of items) {
    const cls = fc.get(it.fee_item_id)!;
    const creditorSide = it.paid_to_kind === "creditor" || it.retained_by_creditor === true || it.creditor_retains_portion === true;
    const affiliate = it.affiliate === true || it.paid_to_kind === "affiliate";
    const financed = it.financed === true;
    let fcClass = cls.classification;
    if (creditorSide && /^excluded_c7|^conditional_a2/.test(fcClass)) fcClass = "prepaid_finance_charge";
    const row = (category: PfCategory | null, included_cents: Cents, exclusion: PfExclusion, basis: string): PfItem => ({ fee_item_id: it.fee_item_id, description: it.description ?? it.service_code, amount_cents: it.amount_cents, payee: it.payee ?? it.paid_to, category, included: included_cents > 0n, included_cents, exclusion, basis, finance_charge: fcClass, financed });
    let r: PfItem;
    switch (it.service_code) {
      case "interest_prepaid": pfc += it.amount_cents; r = row("b1_i_finance_charge", 0n, "interest", "§1026.32(b)(1)(i)(A) interest excluded (a prepaid finance charge, §1026.4(b)(1))"); break;
      case "recording": case "mortgage_tax": case "property_taxes": case "escrow_deposit": case "hazard_premium": case "late_charge": case "seller_points":
        r = fcClass === "finance_charge" || fcClass === "prepaid_finance_charge" ? row("b1_i_finance_charge", it.amount_cents, null, `${cls.basis_citation}: finance charge included`) : row(null, 0n, "not_finance_charge", `${cls.basis_citation}: not a finance charge (${cls.rationale})`); break;
      case "mi_premium_monthly": r = row("b1_i_finance_charge", 0n, "pmi_after_consummation", "§1026.32(b)(1)(i)(C): private MI premiums payable after consummation excluded entirely"); break;
      case "mi_premium_upfront": {
        if (it.mi_kind === "agency") r = row("b1_i_finance_charge", 0n, "agency_mi", "§1026.32(b)(1)(i)(B): federal/state agency MI premium excluded");
        else if (it.paid_at === "after_consummation") r = row("b1_i_finance_charge", 0n, "pmi_after_consummation", "§1026.32(b)(1)(i)(C): PMI payable after consummation excluded");
        else { const fha = it.fha_upfront_equivalent_cents ?? 0n; const excess = it.amount_cents > fha ? it.amount_cents - fha : 0n; r = row("b1_i_finance_charge", excess, excess === 0n ? "pmi_at_or_below_fha" : null, excess === 0n ? "§1026.32(b)(1)(i)(C): at-consummation PMI ≤ the FHA §203(c)(2)(A) amount excluded" : `§1026.32(b)(1)(i)(C): ${excess} cents above the FHA amount included`); }
        break;
      }
      case "discount_points": {
        const pts = it.discount_points ?? it.bona_fide_discount_points ?? 0;
        const excl = Math.min(pts, pointsLeft);
        const exclCents = pts > 0 && excl > 0 ? centsToDecimal(it.amount_cents).mul(Decimal.parse(String(excl))).div(Decimal.parse(String(pts))).toCents("HALF_UP") : 0n;
        pointsLeft -= excl; excludedPts += exclCents; pfc += it.amount_cents;
        r = row("b1_i_finance_charge", it.amount_cents - exclCents, excl > 0 ? bona_fide.exclusion : null, excl > 0 ? `${excl} of ${pts} point(s) excluded (${bona_fide.basis}); ${it.amount_cents - exclCents} cents included` : `${pts} point(s) included — ${bona_fide.basis}`);
        break;
      }
      case "broker_compensation": {
        const kind = it.lo_comp_kind ?? "other";
        if (kind === "creditor_to_employee") r = row("b1_ii_lo_comp", 0n, "creditor_employee_comp", "§1026.32(b)(1)(ii)(C): compensation paid by the creditor to its employee loan originator excluded");
        else if (kind === "broker_to_employee" || kind === "retailer_to_employee") r = row("b1_ii_lo_comp", 0n, null, "§1026.32(b)(1)(ii)(B)/(D): broker-to-employee / retailer-to-employee compensation not counted twice");
        else { r = row("b1_ii_lo_comp", it.amount_cents, null, "§1026.32(b)(1)(ii): loan originator compensation attributable to the transaction included"); if (fcClass === "prepaid_finance_charge") pfc += it.amount_cents; }
        break;
      }
      case "credit_insurance_premium": r = row("b1_iv_credit_ins", it.amount_cents, null, "§1026.32(b)(1)(iv): credit-insurance premium payable at or before consummation included"); if (fcClass === "prepaid_finance_charge" || fcClass === "finance_charge") pfc += it.amount_cents; break;
      default: {
        if (fcClass === "prepaid_finance_charge" || fcClass === "finance_charge") {
          if (!creditorSide && !affiliate && THIRD_PARTY_SERVICES.has(it.service_code)) r = row("b1_i_finance_charge", 0n, "bona_fide_third_party", `§1026.32(b)(1)(i)(D): bona fide third-party charge paid to ${it.payee ?? it.paid_to}, not retained by the creditor, originator or affiliate`);
          else r = row("b1_i_finance_charge", it.amount_cents, null, `${cls.basis_citation}: ${creditorSide ? "creditor-retained" : "finance charge"} — included`);
          if (fcClass === "prepaid_finance_charge") pfc += it.amount_cents;
        } else if (THIRD_PARTY_SERVICES.has(it.service_code) && !affiliate && !creditorSide) r = row("b1_i_finance_charge", 0n, "bona_fide_third_party", `§1026.32(b)(1)(i)(D): bona fide third-party charge (${cls.basis_citation}) paid to ${it.payee ?? it.paid_to}, not retained`);
        else {
          // §1026.4(c)(7) real-estate-related fee: counted unless reasonable, no creditor compensation, and not paid to an affiliate
          const reasonable = it.reasonable ?? cls.reasonable ?? true;
          const fails: string[] = []; if (!reasonable) fails.push("not reasonable"); if (it.creditor_compensated === true) fails.push("creditor receives compensation"); if (affiliate) fails.push("paid to an affiliate");
          r = fails.length ? row("b1_iii_real_estate", it.amount_cents, null, `§1026.32(b)(1)(iii): real-estate-related charge included (${fails.join("; ")})`) : row("b1_iii_real_estate", 0n, "reasonable_no_comp_not_affiliate", `§1026.32(b)(1)(iii): reasonable, no creditor compensation, paid to unaffiliated ${it.payee ?? it.paid_to} — excluded`);
        }
      }
    }
    out.push(r);
  }
  const pf = sumCents(out.map((x) => x.included_cents));
  return { items: out, pf_cents: pf, prepaid_finance_charges_cents: pfc, bona_fide_discount_points_excluded_cents: excludedPts, bona_fide, exclusions: [...new Set(out.map((x) => x.exclusion).filter((x): x is Exclude<PfExclusion, null> => x !== null))] };
}

// ============================================================ total loan amount — §1026.32(b)(4)(i)
export interface TotalLoanAmount { readonly loan_amount_cents: Cents; readonly prepaid_finance_charges_cents: Cents; readonly amount_financed_cents: Cents; readonly financed_pf_items_cents: Cents; readonly total_loan_amount_cents: Cents; }
/** amount financed (§1026.18(b): loan amount − prepaid finance charges) less every (b)(1)(iii)/(iv)/(vi) item that is both included in points and fees and financed. */
export function computeTotalLoanAmount(i: { loan_amount_cents: Cents; prepaid_finance_charges_cents: Cents; pf_items?: readonly PfItem[] }): TotalLoanAmount {
  need(i.loan_amount_cents > 0n, "loan_amount_cents must be positive");
  need(i.prepaid_finance_charges_cents >= 0n && i.prepaid_finance_charges_cents < i.loan_amount_cents, "prepaid finance charges must be ≥ 0 and below the loan amount");
  const amount_financed_cents = i.loan_amount_cents - i.prepaid_finance_charges_cents;
  const financed = sumCents((i.pf_items ?? []).filter((p) => p.included && p.financed && (p.category === "b1_iii_real_estate" || p.category === "b1_iv_credit_ins" || p.category === "b1_vi_ppp_refi")).map((p) => p.included_cents));
  return { loan_amount_cents: i.loan_amount_cents, prepaid_finance_charges_cents: i.prepaid_finance_charges_cents, amount_financed_cents, financed_pf_items_cents: financed, total_loan_amount_cents: totalLoanAmount(amount_financed_cents, financed) };
}

// ============================================================ 2026 tiers (rule 2 / rule 3; rule-set parameters, never constants)
export type AprTier = "first_lien_ge_137958" | "first_lien_82775_137957" | "first_lien_lt_82775" | "mh_lt_137958" | "sub_ge_82775" | "sub_lt_82775";
export type PfTier = "pct3_ge_137958" | "usd4139_82775_137957" | "pct5_27592_82774" | "usd1380_17245_27591" | "pct8_lt_17245";
export type Lien = "first" | "subordinate";
export function aprTier(loan_amount_cents: Cents, lien: Lien, manufactured_home: boolean, rs: QmRuleSet): { apr_tier: AprTier; apr_threshold_pts: number } {
  if (lien === "subordinate") return loan_amount_cents >= rs.apr_tier_2_min_cents ? { apr_tier: "sub_ge_82775", apr_threshold_pts: Number(rs.apr_spread_tier_2) } : { apr_tier: "sub_lt_82775", apr_threshold_pts: Number(rs.apr_spread_tier_3) };
  if (manufactured_home && loan_amount_cents < rs.apr_tier_1_min_cents) return { apr_tier: "mh_lt_137958", apr_threshold_pts: Number(rs.apr_spread_tier_3) };
  if (loan_amount_cents >= rs.apr_tier_1_min_cents) return { apr_tier: "first_lien_ge_137958", apr_threshold_pts: Number(rs.apr_spread_tier_1) };
  if (loan_amount_cents >= rs.apr_tier_2_min_cents) return { apr_tier: "first_lien_82775_137957", apr_threshold_pts: Number(rs.apr_spread_tier_2) };
  return { apr_tier: "first_lien_lt_82775", apr_threshold_pts: Number(rs.apr_spread_tier_3) };
}
const PF_TIER_NAMES: readonly PfTier[] = ["pct3_ge_137958", "usd4139_82775_137957", "pct5_27592_82774", "usd1380_17245_27591", "pct8_lt_17245"];
export function pfTier(total_loan_amount_cents: Cents, rs: QmRuleSet): { pf_tier: PfTier; cap_cents: Cents; cap_basis: string } {
  for (let k = 0; k < rs.pf_tiers.length; k++) {
    const t = rs.pf_tiers[k]!;
    if (total_loan_amount_cents >= t.min_cents) return t.pct ? { pf_tier: PF_TIER_NAMES[k]!, cap_cents: floorPct(total_loan_amount_cents, t.pct), cap_basis: `floor(${t.pct}% × total loan amount ${total_loan_amount_cents})` } : { pf_tier: PF_TIER_NAMES[k]!, cap_cents: t.dollar_cents!, cap_basis: `$${(t.dollar_cents! / 100n).toString()} (2026 indexed)` };
  }
  throw new RangeError("no points-and-fees tier matched");
}

// ============================================================ product tests (§1026.43(e)(2)(i)–(iv)) and consider-and-verify (rule 4)
export interface ProductTerms { readonly term_months: number; readonly amortization: "fully_amortizing" | "interest_only" | "negative_amortization" | "balloon"; readonly substantially_equal_payments: boolean; readonly arm?: { initial_fixed_months: number; underwritten_at_max_rate_5y: boolean } | null; }
export type ProductTest = "term_le_30y" | "no_negam" | "no_io" | "no_balloon" | "substantially_equal" | "max_rate_5y_underwriting";
export function productTests(p: ProductTerms, rs: QmRuleSet): Record<ProductTest, boolean> {
  return { term_le_30y: p.term_months <= rs.max_term_months, no_negam: p.amortization !== "negative_amortization", no_io: p.amortization !== "interest_only", no_balloon: p.amortization !== "balloon", substantially_equal: p.substantially_equal_payments, max_rate_5y_underwriting: !p.arm || p.arm.initial_fixed_months > 60 || p.arm.underwritten_at_max_rate_5y };
}
export const ATR_FACTORS = ["income_or_assets", "employment_status", "monthly_payment_covered_transaction", "simultaneous_loan_payment", "mortgage_related_obligations", "debt_obligations_alimony_child_support", "dti_or_residual_income", "credit_history"] as const;
export type AtrFactor = (typeof ATR_FACTORS)[number];
export interface EvidenceRef { readonly kind: string; readonly id: string; readonly source_process: string; }
export interface ConsiderVerifyFactor { readonly factor: AtrFactor; readonly value: unknown; readonly evidence_refs: readonly EvidenceRef[]; readonly verification_standard_ref: string | null; }
const NOT_THIRD_PARTY = new Set(["du_findings", "du_message", "borrower_statement"]);
/** Complete when all eight (c)(2) factors carry a value, a third-party record reference and the manual-edition standard applied. DU findings are never evidence (they are not third-party records). */
export function considerVerifyStatus(map: readonly ConsiderVerifyFactor[]): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const f of ATR_FACTORS) {
    const row = map.find((m) => m.factor === f);
    if (!row) { missing.push(`${f}: absent`); continue; }
    const refs = row.evidence_refs.filter((r) => !NOT_THIRD_PARTY.has(r.kind));
    if (row.value === null || row.value === undefined) missing.push(`${f}: no value`);
    if (!refs.length) missing.push(`${f}: no third-party evidence reference${f === "credit_history" ? " (22.2 credit report id)" : ""}`);
    if (!row.verification_standard_ref) missing.push(`${f}: no verification_standard_ref`);
  }
  return { complete: missing.length === 0, missing };
}
export interface AtrEvidenceInputs {
  readonly income: { monthly_cents: Cents; evidence: readonly EvidenceRef[]; standard_ref: string };                          // 22.3
  readonly employment: { status: string; evidence: readonly EvidenceRef[]; standard_ref: string };                           // 22.3
  readonly payment: { pi_cents: Cents; basis: "note_rate_fully_amortizing" | "arm_max_rate_first_5y"; evidence: readonly EvidenceRef[] };   // 25.2 / 20.4
  readonly simultaneous_loans: { monthly_cents: Cents; evidence: readonly EvidenceRef[]; standard_ref: string };            // 22.5
  readonly mortgage_obligations: { monthly_cents: Cents; evidence: readonly EvidenceRef[]; standard_ref: string };          // 30.3 / 24.5
  readonly debts: { monthly_cents: Cents; alimony_child_support_cents: Cents; evidence: readonly EvidenceRef[]; standard_ref: string };   // 22.5
  readonly dti: { pct: string; evidence: readonly EvidenceRef[]; standard_ref: string };                                     // 22.5
  readonly credit_history: { report_id: string | null; pulled_at: PlainDate | null; standard_ref: string };                 // 22.2
}
/** The eight-factor map from the processes that hold each fact; a DU-findings reference offered as evidence is refused (guardrail: "never treat DU findings as ATR evidence"). */
export function assembleAtrEvidence(i: AtrEvidenceInputs): ConsiderVerifyFactor[] {
  const all = [i.income.evidence, i.employment.evidence, i.payment.evidence, i.simultaneous_loans.evidence, i.mortgage_obligations.evidence, i.debts.evidence, i.dti.evidence].flat();
  need(!all.some((r) => NOT_THIRD_PARTY.has(r.kind)), "DU findings are not third-party records under §1026.43(c)(4) — cite the underlying record (paystub, W-2, financial-institution record, employer record)");
  return [
    { factor: "income_or_assets", value: i.income.monthly_cents.toString(), evidence_refs: i.income.evidence, verification_standard_ref: i.income.standard_ref },
    { factor: "employment_status", value: i.employment.status, evidence_refs: i.employment.evidence, verification_standard_ref: i.employment.standard_ref },
    { factor: "monthly_payment_covered_transaction", value: i.payment.pi_cents.toString(), evidence_refs: i.payment.evidence, verification_standard_ref: `§1026.43(c)(5)/${i.payment.basis}` },
    { factor: "simultaneous_loan_payment", value: i.simultaneous_loans.monthly_cents.toString(), evidence_refs: i.simultaneous_loans.evidence, verification_standard_ref: i.simultaneous_loans.standard_ref },
    { factor: "mortgage_related_obligations", value: i.mortgage_obligations.monthly_cents.toString(), evidence_refs: i.mortgage_obligations.evidence, verification_standard_ref: i.mortgage_obligations.standard_ref },
    { factor: "debt_obligations_alimony_child_support", value: (i.debts.monthly_cents + i.debts.alimony_child_support_cents).toString(), evidence_refs: i.debts.evidence, verification_standard_ref: i.debts.standard_ref },
    { factor: "dti_or_residual_income", value: i.dti.pct, evidence_refs: i.dti.evidence, verification_standard_ref: i.dti.standard_ref },
    { factor: "credit_history", value: i.credit_history.pulled_at, evidence_refs: i.credit_history.report_id ? [{ kind: "credit_report", id: i.credit_history.report_id, source_process: "22.2" }] : [], verification_standard_ref: i.credit_history.standard_ref },
  ];
}

// ============================================================ QM determination row (qm_determinations)
export type QmType = "general_safe_harbor" | "general_rebuttable" | "not_qm";
export interface QmInput {
  readonly application_id: string; readonly stage: Stage; readonly apr_calculation_id: string; readonly apr: string | number; readonly rate_set_date: PlainDate; readonly apor: AporSelection;
  readonly loan_amount_cents: Cents; readonly total: TotalLoanAmount; readonly fees: Classification23; readonly product: ProductTerms; readonly consider_verify: readonly ConsiderVerifyFactor[];
  readonly lien: Lien; readonly manufactured_home?: boolean; readonly as_of: PlainDate; readonly computed_from_final_cd?: boolean; readonly determined_at: string; readonly agent_decision_id?: string | null;
}
export interface QmRow {
  readonly determination_id: string; readonly application_id: string; readonly stage: Stage; readonly status: "current" | "superseded"; readonly apr_calculation_id: string; readonly apr: number; readonly rate_set_date: PlainDate;
  readonly apor_table_id: string | null; readonly apor_source: AporSource; readonly apor: number | null; readonly apor_stale: boolean; readonly blocked_reason: string | null; readonly spread: number | null;
  readonly loan_amount_cents: Cents; readonly amount_financed_cents: Cents; readonly total_loan_amount_cents: Cents;
  readonly apr_tier: AprTier; readonly apr_threshold_pts: number; readonly apr_test_pass: boolean | null; readonly pf_tier: PfTier; readonly cap_cents: Cents; readonly cap_cents_25_1: Cents; readonly pf_cents: Cents; readonly pf_pass: boolean; readonly pf_pct: number;
  readonly pf_items: readonly PfItem[]; readonly bona_fide_discount_points_excluded_cents: Cents; readonly undiscounted_rate: number | null;
  readonly product_tests: Record<ProductTest, boolean>; readonly product_tests_pass: boolean; readonly consider_verify: readonly ConsiderVerifyFactor[]; readonly consider_verify_complete: boolean; readonly consider_verify_missing: readonly string[];
  readonly hpct: boolean | null; readonly hpct_threshold_pts: number; readonly qm_type: QmType | null; readonly fnma_spread_ok: boolean | null;
  readonly cure_required_cents: Cents | null; readonly cure_deadline: PlainDate | null; readonly cure_paid_at: string | null; readonly computed_from_final_cd: boolean;
  readonly determined_at: string; readonly rule_set_versions: Record<string, string>; readonly agent_decision_id: string | null; readonly engine_25_1: QmDetermination;
}
export const FNMA_MAX_SPREAD = "2.25";   // B2-1.5-02: "The spread may not exceed 2.25%" (23.4-Q3: the QM tier for smaller loans)
/** Rule 2: `apr_test_pass = spread < tier` ("2.25 or more" fails); `hpct = spread ≥ 1.5` (3.5 subordinate); `qm_type` from the four tests. Spread, tiers and HPCT are 25.1's determineQm; 23.4 adds the product tests, the consider-and-verify completeness, the tier names, the floored cap and the not_qm consequences. */
export function runQmTests(i: QmInput): QmRow {
  const rsv = ruleSet<QmRuleSet>("regz.qm.general.2021", i.as_of), rs = rsv.content;
  const apr = Number(dec(i.apr).toFixed(3, "HALF_UP"));
  const tier = aprTier(i.loan_amount_cents, i.lien, i.manufactured_home === true, rs);
  const pt = pfTier(i.total.total_loan_amount_cents, rs);
  const pf_pass = i.fees.pf_cents <= pt.cap_cents;
  const product = productTests(i.product, rs), product_tests_pass = Object.values(product).every(Boolean);
  const cv = considerVerifyStatus(i.consider_verify);
  const det: DeterminationInput = { apr: i.apr, apor: i.apor.as_25_1, rate_set_date: i.rate_set_date, as_of: i.as_of, loan_amount_cents: i.loan_amount_cents, total_loan_amount_cents: i.total.total_loan_amount_cents, points_and_fees_cents: i.fees.pf_cents, lien_position: i.lien, term_months: i.product.term_months };
  const e = determineQm(det);
  const hpct_threshold_pts = Number(i.lien === "first" ? rs.hpct_spread_first_lien : rs.hpct_spread_subordinate);
  const blocked = i.apor.blocked || e.result === "error";
  const qm = !blocked && e.apr_test_pass === true && pf_pass && product_tests_pass && cv.complete;
  const qm_type: QmType | null = blocked ? null : !qm ? "not_qm" : e.hpct ? "general_rebuttable" : "general_safe_harbor";
  const post = i.stage === "post_closing" && qm_type === "not_qm" && !pf_pass;
  return {
    determination_id: `qm-${i.application_id}-${i.stage}-${i.determined_at}`, application_id: i.application_id, stage: i.stage, status: "current", apr_calculation_id: i.apr_calculation_id, apr, rate_set_date: i.rate_set_date,
    apor_table_id: i.apor.table_id, apor_source: i.apor.source, apor: i.apor.apor_pct === null ? null : Number(i.apor.apor_pct), apor_stale: i.apor.apor_stale, blocked_reason: i.apor.blocked ? i.apor.reason : e.result === "error" ? e.message : null, spread: e.spread,
    loan_amount_cents: i.loan_amount_cents, amount_financed_cents: i.total.amount_financed_cents, total_loan_amount_cents: i.total.total_loan_amount_cents,
    apr_tier: tier.apr_tier, apr_threshold_pts: tier.apr_threshold_pts, apr_test_pass: e.apr_test_pass, pf_tier: pt.pf_tier, cap_cents: pt.cap_cents, cap_cents_25_1: e.cap_cents, pf_cents: i.fees.pf_cents, pf_pass, pf_pct: pctOf(i.fees.pf_cents, i.total.total_loan_amount_cents, 4),
    pf_items: i.fees.items, bona_fide_discount_points_excluded_cents: i.fees.bona_fide_discount_points_excluded_cents, undiscounted_rate: i.fees.bona_fide.undiscounted_rate_pct === null ? null : Number(i.fees.bona_fide.undiscounted_rate_pct),
    product_tests: product, product_tests_pass, consider_verify: i.consider_verify, consider_verify_complete: cv.complete, consider_verify_missing: cv.missing,
    hpct: e.hpct, hpct_threshold_pts, qm_type, fnma_spread_ok: e.spread === null ? null : dec(e.spread).cmp(dec(FNMA_MAX_SPREAD)) <= 0,
    cure_required_cents: post ? i.fees.pf_cents - pt.cap_cents : null, cure_deadline: null, cure_paid_at: null, computed_from_final_cd: i.computed_from_final_cd === true,
    determined_at: i.determined_at, rule_set_versions: ruleSetVersions(i.as_of), agent_decision_id: i.agent_decision_id ?? null, engine_25_1: e,
  };
}

// ============================================================ HPML determination row (hpml_determinations; rule 5)
export interface HpmlInput {
  readonly application_id: string; readonly stage: Stage; readonly apr: string | number; readonly rate_set_date: PlainDate; readonly apor: AporSelection; readonly loan_amount_cents: Cents; readonly lien: Lien;
  readonly principal_dwelling: boolean; readonly qm_type: QmType | null; readonly consummation_date?: PlainDate | null; readonly escrow_established_before_consummation?: boolean | null; readonly escrow_waiver_elected?: boolean;
  readonly flip_check?: Record<string, unknown> | null; readonly as_of: PlainDate; readonly determined_at: string;
}
export interface HpmlRow {
  readonly determination_id: string; readonly application_id: string; readonly stage: Stage; readonly apr: number; readonly apor: number | null; readonly rate_set_date: PlainDate; readonly spread: number | null; readonly lien: Lien; readonly above_conforming: boolean; readonly threshold_pts: number;
  readonly is_hpml: boolean | null; readonly principal_dwelling: boolean; readonly escrow_required: boolean; readonly escrow_established_before_consummation: boolean | null; readonly escrow_waiver_elected: boolean; readonly escrow_min_cancel_date: PlainDate | null;
  readonly appraisal_rules_apply: boolean; readonly flip_check: Record<string, unknown> | null; readonly small_creditor_exempt: false; readonly determined_at: string; readonly rule_set_versions: Record<string, string>; readonly engine_25_1: HpmlDetermination;
}
export function runHpmlTests(i: HpmlInput): HpmlRow {
  const rs = ruleSet<HpmlRuleSet>("regz.hpml", i.as_of).content;
  const e = determineHpml({ apr: i.apr, apor: i.apor.as_25_1, rate_set_date: i.rate_set_date, as_of: i.as_of, loan_amount_cents: i.loan_amount_cents, total_loan_amount_cents: i.loan_amount_cents, points_and_fees_cents: 0n, lien_position: i.lien, ...(i.escrow_established_before_consummation === true ? { escrow_established: true } : {}) });
  const is_hpml = e.is_hpml;
  const escrow_required = is_hpml === true && i.lien === "first" && i.principal_dwelling;
  return {
    determination_id: `hpml-${i.application_id}-${i.stage}-${i.determined_at}`, application_id: i.application_id, stage: i.stage, apr: Number(dec(i.apr).toFixed(3, "HALF_UP")), apor: i.apor.apor_pct === null ? null : Number(i.apor.apor_pct), rate_set_date: i.rate_set_date, spread: e.spread,
    lien: i.lien, above_conforming: i.loan_amount_cents > rs.conforming_limit_cents, threshold_pts: Number(e.threshold ?? (i.lien === "subordinate" ? rs.spread_subordinate : i.loan_amount_cents > rs.conforming_limit_cents ? rs.spread_jumbo : rs.spread_first_lien)),
    is_hpml, principal_dwelling: i.principal_dwelling, escrow_required, escrow_established_before_consummation: i.escrow_established_before_consummation ?? null, escrow_waiver_elected: i.escrow_waiver_elected === true,
    escrow_min_cancel_date: escrow_required && i.consummation_date ? hpmlMinCancelDate(i.consummation_date) : null,
    appraisal_rules_apply: is_hpml === true && i.qm_type === "not_qm" && i.loan_amount_cents > rs.appraisal_exemption_cents, flip_check: i.flip_check ?? null, small_creditor_exempt: false,
    determined_at: i.determined_at, rule_set_versions: ruleSetVersions(i.as_of), engine_25_1: e,
  };
}
/** The fragment 26.2 stamps on `closing.scheduled` / `closing.consummated` so `REGZ_1026_35B1_HPML_ESCROW_GATE` and `REGZ_1026_35_HPML_ESCROW_5Y` arm on `is_hpml=true` (and 24.2 reads `appraisal_rules_apply`). */
export const HPML_CLOSING_EVENTS = ["closing.scheduled", "closing.consummated"] as const;
export function hpmlClosingPayload(h: HpmlRow): { is_hpml: boolean; escrow_required: boolean; appraisal_rules_apply: boolean; escrow_min_cancel_date: PlainDate | null } {
  return { is_hpml: h.is_hpml === true, escrow_required: h.escrow_required, appraisal_rules_apply: h.appraisal_rules_apply, escrow_min_cancel_date: h.escrow_min_cancel_date };
}
/** Servicing 3.8's `cancelEscrow` request against the §1026.35(b)(3) floor: refused before consummation + 5 years (`HPML_LT_5Y`), otherwise it proceeds to the < 80 % UPB / not-delinquent tests — the same evaluateWaiver 3.8 runs. */
export function cancelEscrowRequest(r: WaiverRequest, decided_on: PlainDate = r.requested_on): { refused: boolean; before_floor: boolean; floor: PlainDate | null; decision: WaiverDecision } {
  const decision = evaluateWaiver(r, decided_on);
  const floor = r.hpml && r.consummation_date ? hpmlMinCancelDate(r.consummation_date) : null;
  const before_floor = decision.reasons.includes("HPML_LT_5Y");
  return { refused: decision.decision === "denied", before_floor, floor, decision };
}

// ============================================================ HOEPA (rule 6) and state tests (rule 7) — high_cost_determinations
export interface HoepaJson { readonly apr_test: { threshold_pts: number; spread: number | null; fail: boolean | null }; readonly pf_test: { base_cents: Cents; threshold_cents: Cents; pf_cents: Cents; fail: boolean }; readonly ppp_test: { fail: boolean }; }
export interface HoepaInput { readonly apr: string | number; readonly rate_set_date: PlainDate; readonly apor: AporSelection; readonly loan_amount_cents: Cents; readonly total_loan_amount_cents: Cents; readonly pf_cents: Cents; readonly lien: Lien; readonly personal_property_dwelling_lt_50k?: boolean; readonly prepayment_penalty?: { months: number; max_pct: string } | null; readonly as_of: PlainDate; }
export function runHoepaTests(i: HoepaInput): { hoepa: HoepaJson; is_hoepa: boolean; engine_25_1: HoepaDetermination } {
  const rs = ruleSet<HoepaRuleSet>("regz.hoepa", i.as_of).content;
  const lien: Lien = i.personal_property_dwelling_lt_50k ? "subordinate" : i.lien;   // (a)(1)(i): 8.5 for a first lien on a personal-property dwelling < $50,000 — the subordinate threshold
  const e = determineHoepa({ apr: i.apr, apor: i.apor.as_25_1, rate_set_date: i.rate_set_date, as_of: i.as_of, loan_amount_cents: i.loan_amount_cents, total_loan_amount_cents: i.total_loan_amount_cents, points_and_fees_cents: i.pf_cents, lien_position: lien, prepayment_penalty: i.prepayment_penalty ?? null });
  const spread = typeof e.evidence.spread === "number" ? e.evidence.spread : null;
  return { hoepa: { apr_test: { threshold_pts: Number(lien === "first" ? rs.apr_spread_first_lien : rs.apr_spread_subordinate), spread, fail: e.apr_trigger }, pf_test: { base_cents: i.total_loan_amount_cents, threshold_cents: e.pf_threshold_cents, pf_cents: i.pf_cents, fail: e.pf_trigger }, ppp_test: { fail: e.ppp_trigger } }, is_hoepa: e.is_high_cost === true, engine_25_1: e };
}

export type ReferenceSeries = "treasury_yield" | "apor" | "pmms_ne" | "hoepa_ref";
export interface StateDefinition {
  readonly state: string; readonly statute: string; readonly definition: string; readonly verified: boolean; readonly fnma_ineligible_if_fail: boolean;
  readonly size_cap: { kind: "none" } | { kind: "conforming_limit" } | { kind: "fixed"; cents: Cents } | { kind: "min_conforming_fixed"; cents: Cents };
  readonly reference_rate_series: ReferenceSeries;
  /** APR trigger over the reference (null when the statute adopts the HOEPA result). `gt` = "exceeds"/"more than"; `gte` = "equals or exceeds". */
  readonly apr: { first_lien_pts: string; subordinate_pts: string; comparator: "gt" | "gte" } | null;
  readonly pf: { pct: string; min_total_loan_amount_cents: Cents; small: { pct: string; floor_cents: Cents | null; cap_cents: Cents | null; lesser: boolean } | null };
  readonly pf_definition: "regz_1026_32" | "state_specific";
}
const usd = (d: string): Cents => Decimal.parse(d).toCents();
/** Verified-requirement statutes: the Fannie Mae B2-1.5-02 table entries with quoted thresholds (NY § 6-l and § 6-m, NJ, MA, NC, GA, IL); AZ / OH have none (`state_tests = []`). */
export const STATE_HIGH_COST_DEFINITIONS: readonly StateDefinition[] = [
  { state: "NY", statute: "N.Y. Banking Law § 6-l", definition: "high-cost home loan", verified: true, fnma_ineligible_if_fail: true, size_cap: { kind: "conforming_limit" }, reference_rate_series: "treasury_yield", apr: { first_lien_pts: "8", subordinate_pts: "9", comparator: "gt" }, pf: { pct: "5", min_total_loan_amount_cents: usd("50000"), small: { pct: "6", floor_cents: usd("1500"), cap_cents: null, lesser: false } }, pf_definition: "state_specific" },
  { state: "NY", statute: "N.Y. Banking Law § 6-m", definition: "subprime home loan", verified: true, fnma_ineligible_if_fail: true, size_cap: { kind: "conforming_limit" }, reference_rate_series: "pmms_ne", apr: { first_lien_pts: "1.75", subordinate_pts: "3.75", comparator: "gt" }, pf: { pct: "100", min_total_loan_amount_cents: 0n, small: null }, pf_definition: "regz_1026_32" },
  { state: "NJ", statute: "N.J.S.A. 46:10B-24", definition: "high-cost home loan", verified: true, fnma_ineligible_if_fail: true, size_cap: { kind: "fixed", cents: usd("350000") }, reference_rate_series: "hoepa_ref", apr: null, pf: { pct: "4.5", min_total_loan_amount_cents: usd("40000"), small: { pct: "6", floor_cents: null, cap_cents: usd("1000"), lesser: true } }, pf_definition: "state_specific" },
  { state: "MA", statute: "M.G.L. c. 183C § 2", definition: "high cost home mortgage loan", verified: true, fnma_ineligible_if_fail: true, size_cap: { kind: "none" }, reference_rate_series: "treasury_yield", apr: { first_lien_pts: "8", subordinate_pts: "9", comparator: "gt" }, pf: { pct: "5", min_total_loan_amount_cents: 0n, small: null }, pf_definition: "state_specific" },
  { state: "NC", statute: "N.C.G.S. § 24-1.1E", definition: "high-cost home loan", verified: true, fnma_ineligible_if_fail: true, size_cap: { kind: "min_conforming_fixed", cents: usd("300000") }, reference_rate_series: "hoepa_ref", apr: null, pf: { pct: "5", min_total_loan_amount_cents: usd("20000"), small: { pct: "8", floor_cents: null, cap_cents: usd("1000"), lesser: true } }, pf_definition: "state_specific" },
  { state: "GA", statute: "O.C.G.A. § 7-6A-2", definition: "high-cost home loan", verified: false, fnma_ineligible_if_fail: true, size_cap: { kind: "conforming_limit" }, reference_rate_series: "hoepa_ref", apr: null, pf: { pct: "5", min_total_loan_amount_cents: usd("20000"), small: { pct: "8", floor_cents: null, cap_cents: usd("1000"), lesser: true } }, pf_definition: "state_specific" },
  { state: "IL", statute: "815 ILCS 137/10", definition: "high risk home loan", verified: false, fnma_ineligible_if_fail: true, size_cap: { kind: "none" }, reference_rate_series: "apor", apr: { first_lien_pts: "6", subordinate_pts: "8", comparator: "gt" }, pf: { pct: "5", min_total_loan_amount_cents: usd("20000"), small: { pct: "8", floor_cents: null, cap_cents: usd("1000"), lesser: true } }, pf_definition: "state_specific" },
];
export interface StateTest {
  readonly state: string; readonly statute: string; readonly definition: string; readonly applies_by_size: boolean; readonly size_cap_cents: Cents | null; readonly reference_rate_series: ReferenceSeries;
  readonly apr_test: { threshold: string | null; reference_value: string | null; spread: number | null; fail: boolean | null }; readonly pf_test: { threshold_pct: string | null; threshold_cents: Cents | null; pf_cents: Cents; fail: boolean };
  readonly other_tests: Record<string, unknown>; readonly result: "not_applicable" | "pass" | "fail"; readonly fnma_ineligible_if_fail: boolean; readonly state_pf_definition_unverified: boolean;
}
export interface StateInput { readonly state: string; readonly loan_amount_cents: Cents; readonly total_loan_amount_cents: Cents; readonly pf_cents: Cents; readonly apr: string | number; readonly lien: Lien; readonly hoepa_apr_fail: boolean | null; readonly reference_rates?: { treasury_yield_pct?: string | null; pmms_ne_pct?: string | null; apor_pct?: string | null }; readonly conforming_limit_cents?: Cents; readonly as_of: PlainDate; readonly definitions?: readonly StateDefinition[]; }
/** Rule 7: every definition for the property state — size scope, reference series, APR and points-and-fees triggers; a fail under a Fannie Mae-listed definition makes the loan ineligible (B2-1.5-02). */
export function runStateHighCostTests(i: StateInput): StateTest[] {
  const conforming = i.conforming_limit_cents ?? ruleSet<HpmlRuleSet>("regz.hpml", i.as_of).content.conforming_limit_cents;
  const defs = (i.definitions ?? STATE_HIGH_COST_DEFINITIONS).filter((d) => d.state === i.state.toUpperCase());
  return defs.map((d) => {
    const cap = d.size_cap.kind === "none" ? null : d.size_cap.kind === "conforming_limit" ? conforming : d.size_cap.kind === "fixed" ? d.size_cap.cents : (conforming < d.size_cap.cents ? conforming : d.size_cap.cents);
    const applies_by_size = cap === null || i.loan_amount_cents <= cap;
    const base = { state: d.state, statute: d.statute, definition: d.definition, applies_by_size, size_cap_cents: cap, reference_rate_series: d.reference_rate_series, fnma_ineligible_if_fail: d.fnma_ineligible_if_fail, state_pf_definition_unverified: !d.verified, other_tests: {} };
    if (!applies_by_size) return { ...base, apr_test: { threshold: null, reference_value: null, spread: null, fail: null }, pf_test: { threshold_pct: null, threshold_cents: null, pf_cents: i.pf_cents, fail: false }, result: "not_applicable" as const };
    // APR trigger
    let apr_test: StateTest["apr_test"];
    if (d.apr === null) apr_test = { threshold: "HOEPA §1026.32(a)(1)(i)", reference_value: null, spread: null, fail: i.hoepa_apr_fail };
    else {
      const ref = d.reference_rate_series === "treasury_yield" ? i.reference_rates?.treasury_yield_pct : d.reference_rate_series === "pmms_ne" ? i.reference_rates?.pmms_ne_pct : i.reference_rates?.apor_pct;
      const pts = i.lien === "first" ? d.apr.first_lien_pts : d.apr.subordinate_pts;
      if (!ref) apr_test = { threshold: pts, reference_value: null, spread: null, fail: null };
      else { const spread = dec(i.apr).sub(dec(ref)); const c = spread.cmp(dec(pts)); apr_test = { threshold: pts, reference_value: ref, spread: r3(spread), fail: d.apr.comparator === "gt" ? c > 0 : c >= 0 }; }
    }
    // points-and-fees trigger ("exceed" — equality passes)
    let threshold_cents: Cents, threshold_pct: string;
    if (i.total_loan_amount_cents >= d.pf.min_total_loan_amount_cents || !d.pf.small) { threshold_pct = d.pf.pct; threshold_cents = roundPct(i.total_loan_amount_cents, d.pf.pct); }
    else { threshold_pct = d.pf.small.pct; const p = roundPct(i.total_loan_amount_cents, d.pf.small.pct); threshold_cents = d.pf.small.lesser ? (d.pf.small.cap_cents !== null && p > d.pf.small.cap_cents ? d.pf.small.cap_cents : p) : (d.pf.small.floor_cents !== null && p < d.pf.small.floor_cents ? d.pf.small.floor_cents : p); }
    const pf_fail = i.pf_cents > threshold_cents;
    const fail = apr_test.fail === true || pf_fail;
    return { ...base, apr_test, pf_test: { threshold_pct, threshold_cents, pf_cents: i.pf_cents, fail: pf_fail }, other_tests: { prepayment_penalty: "none (A3-2-02)" }, result: fail ? "fail" as const : "pass" as const };
  });
}
export interface HighCostRow { readonly determination_id: string; readonly application_id: string; readonly stage: Stage; readonly hoepa: HoepaJson; readonly is_hoepa: boolean; readonly state_tests: readonly StateTest[]; readonly is_state_high_cost: boolean; readonly fnma_eligible: boolean; readonly fnma_ineligibility_reasons: readonly string[]; readonly determined_at: string; readonly rule_set_versions: Record<string, string>; }
/** Fannie Mae eligibility (B2-1.5-02, A3-2-02): not HOEPA, no state-listed high-cost fail, spread ≤ 2.25 and points and fees within the QM cap. */
export function fnmaEligibility(q: Pick<QmRow, "fnma_spread_ok" | "pf_pass" | "spread">, is_hoepa: boolean, state_tests: readonly StateTest[]): { fnma_eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (is_hoepa) reasons.push("HOEPA high-cost mortgage (B2-1.5-02: not eligible for delivery)");
  for (const s of state_tests) if (s.result === "fail" && s.fnma_ineligible_if_fail) reasons.push(`${s.state} ${s.definition} (${s.statute}) — B2-1.5-02 state higher-priced loan`);
  if (q.fnma_spread_ok === false) reasons.push(`APR − APOR spread ${q.spread} exceeds ${FNMA_MAX_SPREAD} (B2-1.5-02)`);
  if (!q.pf_pass) reasons.push("points and fees exceed the §1026.43(e)(3) cap (B2-1.5-02)");
  return { fnma_eligible: reasons.length === 0, reasons };
}

// ============================================================ a whole stage in one call (the compliance-tester agent's run)
export interface StageRunInput {
  readonly application_id: string; readonly stage: Stage; readonly as_of: PlainDate; readonly determined_at: string; readonly apr_calculation_id: string; readonly apr: string | number;
  readonly locks: readonly LockRow[]; readonly apor_tables: readonly AporTableRow[]; readonly loan_amount_cents: Cents; readonly fee_items: readonly FeeItem23[]; readonly undiscounted_rate_pct?: string | null; readonly buydown_evidence_ref?: string | null;
  readonly product: ProductTerms; readonly consider_verify: readonly ConsiderVerifyFactor[]; readonly lien: Lien; readonly manufactured_home?: boolean; readonly principal_dwelling: boolean; readonly state: string; readonly county?: string | null; readonly benchmarks?: readonly FeeBenchmark[];
  readonly consummation_date?: PlainDate | null; readonly escrow_established_before_consummation?: boolean | null; readonly escrow_waiver_elected?: boolean; readonly flip_check?: Record<string, unknown> | null;
  readonly reference_rates?: StateInput["reference_rates"]; readonly personal_property_dwelling_lt_50k?: boolean; readonly computed_from_final_cd?: boolean; readonly agent_decision_id?: string | null;
}
export interface StageRun { readonly qm: QmRow; readonly hpml: HpmlRow; readonly high_cost: HighCostRow; readonly apor: AporSelection; readonly rate_set: ReturnType<typeof rateSetDate>; readonly fees: Classification23; readonly total: TotalLoanAmount; }
export function runDeterminations(i: StageRunInput): StageRun {
  const rate_set = rateSetDate(i.locks, i.as_of);
  const lock = rate_set.lock, rate_set_date = rate_set.rate_set_date;
  if (lock === null || rate_set_date === null) throw new RangeError(`no lock on or before ${i.as_of}: the ${i.stage}-stage determination needs a rate-set date (LE stage uses the estimated rate — pass the pricing quote as an initial lock row)`);
  const apor = selectApor(i.apor_tables, { rate_set_date, term_years: lock.term_years, product: lock.product, stage: i.stage, requested_on: i.as_of });
  const fees = classifyFeeItems(i.fee_items, { as_of: i.as_of, undiscounted_rate_pct: i.undiscounted_rate_pct ?? null, apor_pct: apor.apor_pct, state: i.state, county: i.county ?? null, benchmarks: i.benchmarks ?? [], buydown_evidence_ref: i.buydown_evidence_ref ?? null });
  const total = computeTotalLoanAmount({ loan_amount_cents: i.loan_amount_cents, prepaid_finance_charges_cents: fees.prepaid_finance_charges_cents, pf_items: fees.items });
  const qm = runQmTests({ application_id: i.application_id, stage: i.stage, apr_calculation_id: i.apr_calculation_id, apr: i.apr, rate_set_date, apor, loan_amount_cents: i.loan_amount_cents, total, fees, product: i.product, consider_verify: i.consider_verify, lien: i.lien, manufactured_home: i.manufactured_home === true, as_of: i.as_of, computed_from_final_cd: i.computed_from_final_cd === true, determined_at: i.determined_at, agent_decision_id: i.agent_decision_id ?? null });
  const hpml = runHpmlTests({ application_id: i.application_id, stage: i.stage, apr: i.apr, rate_set_date, apor, loan_amount_cents: i.loan_amount_cents, lien: i.lien, principal_dwelling: i.principal_dwelling, qm_type: qm.qm_type, consummation_date: i.consummation_date ?? null, escrow_established_before_consummation: i.escrow_established_before_consummation ?? null, escrow_waiver_elected: i.escrow_waiver_elected === true, flip_check: i.flip_check ?? null, as_of: i.as_of, determined_at: i.determined_at });
  const hoepa = runHoepaTests({ apr: i.apr, rate_set_date, apor, loan_amount_cents: i.loan_amount_cents, total_loan_amount_cents: total.total_loan_amount_cents, pf_cents: fees.pf_cents, lien: i.lien, personal_property_dwelling_lt_50k: i.personal_property_dwelling_lt_50k === true, prepayment_penalty: null, as_of: i.as_of });
  const state_tests = runStateHighCostTests({ state: i.state, loan_amount_cents: i.loan_amount_cents, total_loan_amount_cents: total.total_loan_amount_cents, pf_cents: fees.pf_cents, apr: i.apr, lien: i.lien, hoepa_apr_fail: hoepa.hoepa.apr_test.fail, ...(i.reference_rates ? { reference_rates: i.reference_rates } : {}), as_of: i.as_of });
  const el = fnmaEligibility(qm, hoepa.is_hoepa, state_tests);
  const high_cost: HighCostRow = { determination_id: `hc-${i.application_id}-${i.stage}-${i.determined_at}`, application_id: i.application_id, stage: i.stage, hoepa: hoepa.hoepa, is_hoepa: hoepa.is_hoepa, state_tests, is_state_high_cost: state_tests.some((s) => s.result === "fail"), fnma_eligible: el.fnma_eligible, fnma_ineligibility_reasons: el.reasons, determined_at: i.determined_at, rule_set_versions: ruleSetVersions(i.as_of) };
  return { qm, hpml, high_cost, apor, rate_set, fees, total };
}
/** A relock / float-down after a stored `lock`-stage row: the earlier row stays on file as `superseded` (each stage row is immutable; the current determination is the latest). */
export function supersede(rows: readonly QmRow[], next: QmRow): QmRow[] {
  return [...rows.map((r) => (r.stage === next.stage && r.application_id === next.application_id && r.status === "current" ? { ...r, status: "superseded" as const } : r)), next];
}

// ============================================================ gates (pure; wrapped by evaluators-23-4.ts)
export type GatedCommand = "issueCD" | "consummate" | "authorizeFunding" | "submitDelivery";
export interface GateOutcome { readonly open: boolean; readonly blocking_codes: readonly string[]; readonly reason: string | null; }
/** REGZ_1026_43_QM_DETERMINATION_GATE: current-stage `qm_type ∈ {general_safe_harbor, general_rebuttable}` with apr_test_pass, pf within cap, product tests pass, consider_verify complete; at consummation the row must be computed from the final CD. */
export function qmDeterminationGate(q: Pick<QmRow, "qm_type" | "apr_test_pass" | "pf_pass" | "product_tests_pass" | "consider_verify_complete" | "consider_verify_missing" | "stage" | "apor_stale" | "blocked_reason" | "computed_from_final_cd">, command: GatedCommand): GateOutcome {
  const codes: string[] = [];
  if (q.blocked_reason) codes.push(q.apor_stale ? "APOR_STALE" : "QM_DETERMINATION_ERROR");
  if (q.apr_test_pass !== true) codes.push("QM_APR_TEST_FAIL");
  if (!q.pf_pass) codes.push("QM_POINTS_FEES_OVER_CAP");
  if (!q.product_tests_pass) codes.push("QM_PRODUCT_TEST_FAIL");
  if (!q.consider_verify_complete) codes.push("QM_CONSIDER_VERIFY_INCOMPLETE");
  if ((command === "consummate" || command === "authorizeFunding" || command === "submitDelivery") && (q.stage !== "consummation" && q.stage !== "post_closing" || !q.computed_from_final_cd)) codes.push("QM_CONSUMMATION_ROW_NOT_FROM_FINAL_CD");
  if (q.qm_type !== "general_safe_harbor" && q.qm_type !== "general_rebuttable" && !codes.length) codes.push("QM_NOT_QM");
  return { open: codes.length === 0, blocking_codes: codes, reason: codes.length ? `REGZ_1026_43_QM_DETERMINATION_GATE blocks ${command}: ${codes.join(", ")}${q.consider_verify_missing.length ? ` (${q.consider_verify_missing.join("; ")})` : ""}${q.blocked_reason ? ` — ${q.blocked_reason}` : ""}` : null };
}
export function hoepaGate(is_hoepa: boolean, command: GatedCommand): GateOutcome {
  return is_hoepa ? { open: false, blocking_codes: ["HOEPA_HIGH_COST"], reason: `REGZ_1026_32_HOEPA_GATE blocks ${command}: HOEPA high-cost mortgage — never made (B2-1.5-02; partner policy)` } : { open: true, blocking_codes: [], reason: null };
}
export function stateHighCostGate(tests: readonly StateTest[], command: GatedCommand, officer_accepted_state_risk = false): GateOutcome {
  const codes: string[] = [];
  for (const t of tests) {
    if (t.result === "fail") codes.push(t.fnma_ineligible_if_fail ? `STATE_HIGH_COST_${t.state}_FNMA_INELIGIBLE` : officer_accepted_state_risk ? "" : `STATE_HIGH_COST_${t.state}_COUNSEL_DECISION`);
    else if (t.result === "pass" && t.apr_test.fail === null && t.reference_rate_series !== "hoepa_ref") codes.push(`STATE_${t.state}_REFERENCE_RATE_MISSING`);
    if (t.result !== "not_applicable" && t.state_pf_definition_unverified && !officer_accepted_state_risk) codes.push(`STATE_${t.state}_PF_DEFINITION_UNVERIFIED`);
  }
  const c = codes.filter(Boolean);
  return { open: c.length === 0, blocking_codes: c, reason: c.length ? `STATE_HIGH_COST_GATE blocks ${command}: ${c.join(", ")}` : null };
}
/** REGZ_1026_35B1_HPML_ESCROW_GATE: an HPML first lien on a principal dwelling consummates only with an escrow account established before consummation (30.3's `escrow.initial_analysis.approved{hpml=true}`); a borrower's waiver election is refused. */
export function hpmlEscrowGate(h: Pick<HpmlRow, "is_hpml" | "lien" | "principal_dwelling" | "escrow_established_before_consummation" | "escrow_waiver_elected">): GateOutcome {
  if (h.is_hpml !== true || h.lien !== "first" || !h.principal_dwelling) return { open: true, blocking_codes: [], reason: null };
  const codes: string[] = [];
  if (h.escrow_waiver_elected) codes.push("HPML_ESCROW_WAIVER_REFUSED");
  if (h.escrow_established_before_consummation !== true) codes.push("HPML_ESCROW_NOT_ESTABLISHED");
  return { open: codes.length === 0, blocking_codes: codes, reason: codes.length ? `REGZ_1026_35B1_HPML_ESCROW_GATE blocks consummate: ${codes.join(", ")} — §1026.35(b)(1) "may not extend a higher-priced mortgage loan … unless an escrow account is established before consummation"` : null };
}
/** REGZ_1026_35C_HPML_APPRAISAL_COPY_3BD (24.2 owns the mechanics): every written HPML appraisal copy provided ≥ 3 business days (creditor calendar) before consummation; no waiver. */
export function hpmlAppraisalCopyGate(i: { appraisal_rules_apply: boolean; consummation_date: PlainDate; copies: readonly { appraisal_id: string; delivered_on: PlainDate | null }[] }): GateOutcome {
  if (!i.appraisal_rules_apply) return { open: true, blocking_codes: [], reason: null };
  const latest = addBusinessDays(i.consummation_date, -3, creditor);
  const late = i.copies.filter((c) => c.delivered_on === null || c.delivered_on > latest).map((c) => c.appraisal_id);
  if (!i.copies.length) late.push("no appraisal copy recorded");
  return { open: late.length === 0, blocking_codes: late.length ? ["HPML_APPRAISAL_COPY_LT_3BD"] : [], reason: late.length ? `REGZ_1026_35C_HPML_APPRAISAL_COPY_3BD: copies not provided by ${latest} (3 business days before consummation ${i.consummation_date}; §1026.35(c)(6)(ii)(A), no waiver): ${late.join(", ")}` : null };
}

// ============================================================ events (compliance.*.determined, compliance.test.passed/failed, cure, restructure)
export interface EventCtx { readonly application_id: string; readonly loan_id?: string | null; readonly actor?: Actor; readonly at?: string; }
const keys = (c: EventCtx) => ({ applicationId: c.application_id, ...(c.loan_id ? { loanId: c.loan_id } : {}), actor: c.actor ?? AGENT_23_4, ...(c.at ? { occurredAt: c.at } : {}) });
/** Write the three stage rows' facts to the log: one `compliance.<x>.determined` per row plus `compliance.test.passed/failed{test}` for qm, hpml, hoepa and state_high_cost. */
export function recordDeterminations(events: EventStore, c: EventCtx, r: StageRun): DomainEvent[] {
  const out: DomainEvent[] = [];
  const stage = r.qm.stage;
  const test = (name: "qm" | "hpml" | "hoepa" | "state_high_cost", pass: boolean, detail: Record<string, unknown>) => out.push(events.append({ type: pass ? "compliance.test.passed" : "compliance.test.failed", ...keys(c), payload: { application_id: c.application_id, test: name, stage, source: "origination", ...detail } }));
  out.push(events.append({ type: "compliance.qm.determined", ...keys(c), payload: { application_id: c.application_id, determination_id: r.qm.determination_id, stage, qm_type: r.qm.qm_type, spread: r.qm.spread, apr_tier: r.qm.apr_tier, apr_test_pass: r.qm.apr_test_pass, pf_cents: r.qm.pf_cents.toString(), cap_cents: r.qm.cap_cents.toString(), pf_pass: r.qm.pf_pass, hpct: r.qm.hpct, apor_stale: r.qm.apor_stale, blocked_reason: r.qm.blocked_reason, consider_verify_complete: r.qm.consider_verify_complete, source: "origination" } }));
  test("qm", r.qm.qm_type === "general_safe_harbor" || r.qm.qm_type === "general_rebuttable", { qm_type: r.qm.qm_type, blocked_reason: r.qm.blocked_reason });
  out.push(events.append({ type: "compliance.hpml.determined", ...keys(c), payload: { application_id: c.application_id, determination_id: r.hpml.determination_id, stage, is_hpml: r.hpml.is_hpml, spread: r.hpml.spread, threshold_pts: r.hpml.threshold_pts, escrow_required: r.hpml.escrow_required, escrow_min_cancel_date: r.hpml.escrow_min_cancel_date, appraisal_rules_apply: r.hpml.appraisal_rules_apply, source: "origination" } }));
  test("hpml", r.hpml.engine_25_1.result !== "fail" && r.hpml.is_hpml !== null, { is_hpml: r.hpml.is_hpml, escrow_required: r.hpml.escrow_required });
  out.push(events.append({ type: "compliance.high_cost.determined", ...keys(c), payload: { application_id: c.application_id, determination_id: r.high_cost.determination_id, stage, is_hoepa: r.high_cost.is_hoepa, is_state_high_cost: r.high_cost.is_state_high_cost, fnma_eligible: r.high_cost.fnma_eligible, state_tests: r.high_cost.state_tests.map((s) => ({ state: s.state, statute: s.statute, result: s.result })), source: "origination" } }));
  test("hoepa", !r.high_cost.is_hoepa, { is_hoepa: r.high_cost.is_hoepa });
  test("state_high_cost", !r.high_cost.is_state_high_cost, { is_state_high_cost: r.high_cost.is_state_high_cost, states: r.high_cost.state_tests.map((s) => s.state) });
  return out;
}
/** A `not_qm` CD-stage row opens 23.2's restructure loop: `restructure.proposed{kind=fee_change}` (reduce points/fees, re-price, bona fide discount analysis); the underwriting_reviewer owns the decline consequence. */
export function proposeFeeRestructure(events: EventStore, c: EventCtx, q: QmRow): DomainEvent {
  need(q.qm_type === "not_qm", "a restructure is proposed only from a not_qm determination");
  const excess = q.pf_pass ? 0n : q.pf_cents - q.cap_cents;
  return events.append({ type: "restructure.proposed", ...keys(c), payload: { application_id: c.application_id, kind: "fee_change", source_process: "23.4", determination_id: q.determination_id, stage: q.stage, qm_type: q.qm_type, excess_pf_cents: excess.toString(), apr_test_pass: q.apr_test_pass, spread: q.spread, options: [...(excess > 0n ? [`remove or reduce points/fees by ${excess} cents`] : []), ...(q.apr_test_pass === false ? ["re-price below the APR tier"] : []), "bona fide discount analysis (20.4 undiscounted rate)"], source: "origination" } });
}
export interface EscalationOpener { open(input: { kind: string; ownerRole?: string; loanId?: string; applicationId?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { id: string }; }
export const CURE_SUNSET = "2021-01-10" as PlainDate;   // §1026.43(e)(3)(iii): "For covered transactions consummated on or before January 10, 2021"
/** Post-consummation points-and-fees excess (post_closing re-test): `not_qm` permanently; `compliance.pf_cure.required` queues a remediation refund (excess + interest at the contract rate) for `officer` approval and opens 28.4's self-report evaluation. No REGZ_1026_43_E3III_PF_CURE_210 clock arms — the row's trigger condition `consummated_on_or_before_2021_01_10=true` is never met by a platform loan. */
export function recordPfCureRequired(events: EventStore, c: EventCtx, i: { qm: QmRow; consummation_date: PlainDate; discovered_on: PlainDate; note_rate_pct: string; escalations?: EscalationOpener }): { event: DomainEvent; cure_required_cents: Cents; interest_cents: Cents; officer_escalation_id: string | null; self_report_escalation_id: string | null; timer_created: false } {
  const cure = i.qm.cure_required_cents;
  if (i.qm.stage !== "post_closing" || i.qm.qm_type !== "not_qm" || cure === null || cure <= 0n) throw new RangeError("a cure is queued only from a post_closing not_qm row with a points-and-fees excess");
  const days = daysBetween(i.consummation_date, i.discovered_on);
  const interest_cents = centsToDecimal(cure).mul(Decimal.parse(i.note_rate_pct)).div(HUNDRED).mul(Decimal.fromInt(days)).div(Decimal.fromInt(365)).toCents("HALF_UP");
  const officer = i.escalations?.open({ kind: "officer", ownerRole: "officer", applicationId: c.application_id, ...(c.loan_id ? { loanId: c.loan_id } : {}), severity: "sev1", payload: { reason: "points_and_fees_remediation_refund", cure_required_cents: cure.toString(), interest_cents: interest_cents.toString(), determination_id: i.qm.determination_id, basis: "remediation refund — not a §1026.43(e)(3)(iii) cure (sunset for loans consummated after 2021-01-10)" } }, c.actor ?? AGENT_23_4)?.id ?? null;
  const qc = i.escalations?.open({ kind: "qc_officer", ownerRole: "qc_officer", applicationId: c.application_id, ...(c.loan_id ? { loanId: c.loan_id } : {}), severity: "sev1", payload: { reason: "qm_representation_breach_self_report_evaluation", process: "28.4", determination_id: i.qm.determination_id, representation: "A2-2-07 compliance with laws / QM" } }, c.actor ?? AGENT_23_4)?.id ?? null;
  const event = events.append({ type: "compliance.pf_cure.required", ...keys(c), payload: { application_id: c.application_id, determination_id: i.qm.determination_id, stage: i.qm.stage, qm_type: i.qm.qm_type, cure_required_cents: cure.toString(), interest_cents: interest_cents.toString(), consummation_at: i.consummation_date, discovered_on: i.discovered_on, consummated_on_or_before_2021_01_10: i.consummation_date <= CURE_SUNSET, cure_available: false, remediation: "refund_excess_plus_interest", officer_escalation_id: officer, self_report_evaluation: "28.4", self_report_escalation_id: qc, source: "origination" } });
  return { event, cure_required_cents: cure, interest_cents, officer_escalation_id: officer, self_report_escalation_id: qc, timer_created: false };
}
/** The officer-approved remediation refund paid: `compliance.pf_cure.paid` (cure ledger); `qm_type` stays `not_qm`. */
export function recordPfCurePaid(events: EventStore, c: EventCtx, i: { determination_id: string; paid_cents: Cents; paid_on: PlainDate; approved_by: Actor; ledger_entry_set_id?: string | null }): DomainEvent {
  need(i.approved_by.kind === "human" && i.approved_by.role === "officer", "a points-and-fees remediation refund is approved by an officer");
  need(i.paid_cents > 0n && isDate(i.paid_on), "paid_cents and paid_on are required");
  return events.append({ type: "compliance.pf_cure.paid", ...keys(c), payload: { application_id: c.application_id, determination_id: i.determination_id, paid_cents: i.paid_cents.toString(), paid_on: i.paid_on, approved_by: i.approved_by.id, ledger_entry_set_id: i.ledger_entry_set_id ?? null, qm_type_after: "not_qm", source: "origination" } });
}
/** The decision record every compliance-tester act carries (AI agent design): deterministic results plus the narrative; the LLM never overrides a computed result. */
export function decisionRecord23_4(r: StageRun, meta: { model_version: string; prompt_version: string; rationale: string; confidence?: number }): Record<string, unknown> {
  return { application_id: r.qm.application_id, stage: r.qm.stage, apr_calculation_id: r.qm.apr_calculation_id, apor_table_id: r.qm.apor_table_id, rate_set_date: r.qm.rate_set_date, spread: r.qm.spread, tiers: { apr_tier: r.qm.apr_tier, apr_threshold_pts: r.qm.apr_threshold_pts, pf_tier: r.qm.pf_tier, cap_cents: r.qm.cap_cents.toString() },
    pf_items: r.qm.pf_items.filter((p) => p.included).map((p) => p.fee_item_id), excluded_items: r.qm.pf_items.filter((p) => !p.included).map((p) => ({ fee_item_id: p.fee_item_id, exclusion: p.exclusion })), bona_fide_analysis: r.fees.bona_fide, product_tests: r.qm.product_tests, consider_verify: r.qm.consider_verify.map((f) => f.factor),
    qm_type: r.qm.qm_type, hpml: { is_hpml: r.hpml.is_hpml, escrow_required: r.hpml.escrow_required, appraisal_rules_apply: r.hpml.appraisal_rules_apply }, hoepa: r.high_cost.hoepa, state_tests: r.high_cost.state_tests.map((s) => ({ state: s.state, statute: s.statute, result: s.result })), fnma_eligible: r.high_cost.fnma_eligible,
    rule_set_versions: r.qm.rule_set_versions, model_version: meta.model_version, prompt_version: meta.prompt_version, rationale: meta.rationale, confidence: meta.confidence ?? 1 };
}
/** Near-threshold report flags (Outputs): spread within 0.25 of 1.5 or 2.25; points and fees within 10 % of the cap. */
export function nearThreshold(q: Pick<QmRow, "spread" | "pf_cents" | "cap_cents">): { spread_near: boolean; pf_near: boolean } {
  const near = (x: number, t: number) => Math.abs(x - t) <= 0.25;
  return { spread_near: q.spread !== null && (near(q.spread, 1.5) || near(q.spread, 2.25)), pf_near: q.cap_cents > 0n && q.pf_cents * 10n >= q.cap_cents * 9n };
}
export const REGZ_ATR_RETENTION = "regz_atr_3y";
export { addDays, r4 as pct4 };
