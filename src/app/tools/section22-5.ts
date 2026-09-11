/**
 * §22.5 process-owned tools — bus tools for 22.5 defined with `defineTools("22.5", "verification", defs)` from
 * ../tools.ts. Every tool string is one spec/registry/agents.json names for 22.5; src/app/tools.test.ts refuses the
 * rest. Spread by ./index.ts. The handlers are thin: the rules live in src/domain/verification/ops-22-5.ts; the store
 * keeps `application_liabilities` (0057, extended by 0082), `qualifying_payments`, `dti_calculations`,
 * `debt_payoff_plans` (0082) and `conditions`. Guardrails encode the AI-design sentences: never exclude a debt without
 * the Guide-named evidence; never use a bought-down rate, a HELOC imputed payment, or a non-applicant exclusion without
 * documentation; never apply the alimony income-reduction to child support; never "optimize" the payment basis beyond
 * what the Guide permits (the student-loan choice is recorded with both figures); never change income or assets — those
 * belong to 22.3/22.4. Escalations: `underwriting_reviewer` for a DTI outcome that drives a counteroffer/denial/NOIA
 * (21.6) and for payoff-to-qualify plans above the Q1 threshold; `human_agent` on request.
 */
import { defineTools, compute, decision, never, cents, str, flag, num, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { scheduledNoteDate } from "../../domain/verification/ops-22-1.ts";
import {
  LiabilityRefused, RULE_SET_VERSION, alimonyTreatments, applyBasis, checkDuCap, computeDti, computeQualifyingPayment, declareLiability, decisionRecord, electIncomeReduction, evaluateExclusion, evidencePayoff, finalizeLiabilities, includeLiability, irsAgreementGate, legalDocGate, matchTradelines, notifyTolerance, payoffFundsGate, planPayoff, recordDti, recordExclusion, recordQualifyingPayment, selectPaymentBasis,
  type BasisEvidence, type DebtPayoffPlan, type DtiCalculation, type DtiStage, type ExclusionEvidence, type ExclusionReason, type Liability, type LiabilitySource, type LiabilityType, type PayoffMode, type Product, type PropertyRole, type QualifyingPayment, type Tradeline,
} from "../../domain/verification/ops-22-5.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "application_id") || ctx.applicationId || ""; if (!id) throw new RangeError("application_id is required"); return id; };
const at = (i: ToolInput, k: string, ctx: CommandContext): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const optCents = (i: Record<string, unknown>, k: string): bigint | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : cents(i[k]));
const optNum = (i: Record<string, unknown>, k: string): number | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : Number(i[k]));
const optStr = (i: Record<string, unknown>, k: string): string | null => (typeof i[k] === "string" && i[k] !== "" ? String(i[k]) : null);
const optDate = (i: Record<string, unknown>, k: string): PlainDate | null => (typeof i[k] === "string" && i[k] !== "" ? D(String(i[k])) : null);
const strs = (i: Record<string, unknown>, k: string): string[] => (Array.isArray(i[k]) ? (i[k] as unknown[]).map(String) : []);
const C = (v: unknown): bigint => (v === null || v === undefined || v === "" ? 0n : cents(v));
const CN = (v: unknown): bigint | null => (v === null || v === undefined || v === "" ? null : cents(v));
// ---- store rows (cents as strings, like 22.2's liabilities) ----
const liabilityRow = (l: Liability): Record<string, unknown> => ({ ...l, balance_cents: String(l.balance_cents), reported_payment_cents: l.reported_payment_cents === null ? null : String(l.reported_payment_cents), qualifying_payment_cents: String(l.qualifying_payment_cents), payoff_amount_cents: l.payoff_amount_cents === null ? null : String(l.payoff_amount_cents) });
const liabilityOf = (d: Record<string, unknown>): Liability => ({ ...(d as unknown as Liability), balance_cents: C(d.balance_cents), reported_payment_cents: CN(d.reported_payment_cents), qualifying_payment_cents: C(d.qualifying_payment_cents), payoff_amount_cents: CN(d.payoff_amount_cents), borrower_ids: strs(d, "borrower_ids"), exclusion_evidence_document_ids: strs(d, "exclusion_evidence_document_ids"), du_message_ids: strs(d, "du_message_ids") });
const putLiability = (rt: ToolRuntime, l: Liability, ctx: CommandContext): void => { rt.store.put("application_liabilities", l.liability_id, liabilityRow(l), ctx.actor, ctx.now); };
const getLiability = (rt: ToolRuntime, i: ToolInput, k = "liability_id"): Liability => { need(i, k); return liabilityOf(rt.store.require("application_liabilities", str(i, k)).data); };
const liabilitiesOf = (rt: ToolRuntime, app: string): Liability[] => rt.store.list("application_liabilities", (d) => d.application_id === app).map((r) => liabilityOf(r.data));
const qpRow = (q: QualifyingPayment): Record<string, unknown> => Object.fromEntries(Object.entries(q).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v]));
const qpOf = (d: Record<string, unknown>): QualifyingPayment => ({ ...(d as unknown as QualifyingPayment), loan_amount_cents: C(d.loan_amount_cents), pi_cents: C(d.pi_cents), bought_down_pi_cents: CN(d.bought_down_pi_cents), mi_cents: C(d.mi_cents), taxes_cents: C(d.taxes_cents), hazard_cents: C(d.hazard_cents), flood_cents: C(d.flood_cents), hoa_cents: C(d.hoa_cents), coop_fee_cents: C(d.coop_fee_cents), ground_rent_cents: C(d.ground_rent_cents), special_assessment_cents: C(d.special_assessment_cents), subordinate_payment_cents: C(d.subordinate_payment_cents), pitia_cents: C(d.pitia_cents) });
const latestQp = (rt: ToolRuntime, i: ToolInput, app: string): QualifyingPayment => {
  if (typeof i.qp_id === "string" && i.qp_id) return qpOf(rt.store.require("qualifying_payments", i.qp_id).data);
  const q = rt.store.list("qualifying_payments", (d) => d.application_id === app && (d.property_role === "subject_primary" || d.property_role === "subject_second_home" || d.property_role === "subject_investment")).map((r) => qpOf(r.data)).sort((a, b) => b.version - a.version)[0];
  if (!q) throw new RangeError("no qualifying payment on file for the application (computeQualifyingPayment first, or qp_id)");
  return q;
};
const dtiRow = (c: DtiCalculation): Record<string, unknown> => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v]));
const dtiOf = (d: Record<string, unknown>): DtiCalculation => ({ ...(d as unknown as DtiCalculation), qualifying_income_cents: C(d.qualifying_income_cents), income_reductions_cents: C(d.income_reductions_cents), income_cents: C(d.income_cents), pitia_cents: C(d.pitia_cents), other_reo_cents: C(d.other_reo_cents), liabilities_cents: C(d.liabilities_cents), obligations_cents: C(d.obligations_cents), liability_ids: strs(d, "liability_ids") });
const getDti = (rt: ToolRuntime, id: string): DtiCalculation => dtiOf(rt.store.require("dti_calculations", id).data);
const dtisOf = (rt: ToolRuntime, app: string): DtiCalculation[] => rt.store.list("dti_calculations", (d) => d.application_id === app).map((r) => dtiOf(r.data)).sort((a, b) => a.version - b.version);
const planRow = (p: DebtPayoffPlan): Record<string, unknown> => ({ ...p, amount_cents: String(p.amount_cents) });
const planOf = (d: Record<string, unknown>): DebtPayoffPlan => ({ ...(d as unknown as DebtPayoffPlan), amount_cents: C(d.amount_cents) });
/** 22.3's `income.finalized{total_qualifying_cents}` for the application (input overrides for what-if computations never change income — guardrail). */
const qualifyingIncome = (i: ToolInput, ctx: CommandContext, app: string): bigint => {
  if (i.qualifying_income_cents !== undefined && i.qualifying_income_cents !== null && i.qualifying_income_cents !== "") return cents(i.qualifying_income_cents);
  const e = ctx.events.ofType("income.finalized").filter((x) => x.applicationId === app || (x.payload as Record<string, unknown>).application_id === app).at(-1);
  if (!e) throw new RangeError("qualifying_income_cents is required (no income.finalized from 22.3 on file)");
  return cents((e.payload as Record<string, unknown>).total_qualifying_cents);
};
const noteDate = (i: ToolInput, ctx: CommandContext, app: string): PlainDate | null => optDate(i, "scheduled_note_date") ?? scheduledNoteDate(ctx.events, app);
const basisEvidence = (i: ToolInput): BasisEvidence => { const e = (i.evidence as Record<string, unknown> | undefined) ?? i; return {
  creditor_statement_payment_cents: optCents(e, "creditor_statement_payment_cents"), supplemental_statement_payment_cents: optCents(e, "supplemental_statement_payment_cents"), payment_letter_cents: optCents(e, "payment_letter_cents"), idr_statement_document_id: optStr(e, "idr_statement_document_id"), idr_payment_cents: optCents(e, "idr_payment_cents"),
  amortizing_payment_cents: optCents(e, "amortizing_payment_cents"), amortizing_terms: e.amortizing_terms && typeof e.amortizing_terms === "object" ? { rate_bps: Number((e.amortizing_terms as Record<string, unknown>).rate_bps), term_months: Number((e.amortizing_terms as Record<string, unknown>).term_months) } : null, heloc_required_payment_cents: optCents(e, "heloc_required_payment_cents"),
  legal_agreement_document_id: optStr(e, "legal_agreement_document_id"), legal_agreement_payment_cents: optCents(e, "legal_agreement_payment_cents"), irs_agreement_document_id: optStr(e, "irs_agreement_document_id"), irs_agreement_status: (optStr(e, "irs_agreement_status") as "approved" | "pending" | null), irs_agreement_payment_cents: optCents(e, "irs_agreement_payment_cents"), irs_paid_in_full: e.irs_paid_in_full === true, irs_payment_evidence_document_id: optStr(e, "irs_payment_evidence_document_id"),
  bridge_payment_cents: optCents(e, "bridge_payment_cents"), deferred_5y_or_more: e.deferred_5y_or_more === true, scheduled_payment_cents: optCents(e, "scheduled_payment_cents"), pitia_cents: optCents(e, "pitia_cents"), rental_net_loss_cents: optCents(e, "rental_net_loss_cents") }; };
const exclusionEvidence = (i: ToolInput): ExclusionEvidence => { const e = (i.evidence as Record<string, unknown> | undefined) ?? i; return {
  evidence_document_ids: strs(e, "evidence_document_ids"), canceled_checks_months: optNum(e, "canceled_checks_months") ?? 0, payer_delinquencies_12m: optNum(e, "payer_delinquencies_12m") ?? 0, company_checks_months: optNum(e, "company_checks_months") ?? 0, cash_flow_deducted: e.cash_flow_deducted === true,
  loan_instrument_document_id: optStr(e, "loan_instrument_document_id"), court_order_document_id: optStr(e, "court_order_document_id"), executed_sales_contract_document_id: optStr(e, "executed_sales_contract_document_id"), contingencies_cleared: e.contingencies_cleared === true, settlement_statement_document_id: optStr(e, "settlement_statement_document_id"),
  remaining_months: optNum(e, "remaining_months"), note_date: optDate(e, "note_date"), last_payment_month: optDate(e, "last_payment_month"), qualifying_income_cents: optCents(e, "qualifying_income_cents"), revolving_utilization_pct: optNum(e, "revolving_utilization_pct"), deferred_5y_or_more: e.deferred_5y_or_more === true, rental_offset_income_id: optStr(e, "rental_offset_income_id") }; };
const condition = (rt: ToolRuntime, ctx: CommandContext, app: string, id: string, text: string, kind: "ptd" | "ptf"): void => { rt.store.put("conditions", id, { application_id: app, source: "22.5", kind, text, status: "open", opened_at: ctx.now }, ctx.actor, ctx.now); };
/** ops-22-5 refusals surface as CommandRefused with the same code and citation. */
const refusing = (defs: readonly Omit<ToolDef, "process" | "agent">[]): Omit<ToolDef, "process" | "agent">[] => defs.map((d) => ({ ...d, handler: async (i, ctx, rt) => { try { return await d.handler(i, ctx, rt); } catch (e) { if (e instanceof LiabilityRefused) throw new CommandRefused(d.name, e.code, e.citation, e.message); throw e; } } }));

const NO_INCOME_ASSET_CHANGE = never("NEVER_CHANGE_INCOME_OR_ASSETS", "22.5 guardrail (income belongs to 22.3, assets to 22.4)", (i) => i.override_income_cents !== undefined || i.adjust_income === true || i.adjust_assets === true || i.override_assets_cents !== undefined, "22.5 never changes income or assets — those belong to 22.3/22.4");
const NO_BASIS_OPTIMIZATION = never("NO_BASIS_OPTIMIZATION", "22.5 guardrail; B3-6-05 (the Guide's permitted bases only; the student-loan choice is recorded with both figures)", (i) => i.force_basis !== undefined || i.force_payment_cents !== undefined || i.override_basis !== undefined, "never \"optimize\" the payment basis beyond what the Guide permits");

export const TOOLS_22_5: readonly ToolDef[] = defineTools("22.5", "verification", refusing([
  // Inputs: declared liabilities (URLA 2c / credit report) and discovered ones (22.2 UDM alerts and inquiry answers, DU messages, 22.4 deposit sourcing); op=list reads the set; op=ingest_undisclosed consumes `credit.undisclosed_debt.found`.
  { name: "buildLiabilitySet", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "declare"; const app = appOf(i, ctx);
      if (op === "list") return { application_id: app, liabilities: liabilitiesOf(rt, app), included_liability_ids: liabilitiesOf(rt, app).filter((l) => l.include_in_dti).map((l) => l.liability_id) };
      if (op === "ingest_undisclosed") {
        need(i, "borrower_id", "creditor_name", "monthly_payment_cents");
        const source: LiabilitySource = str(i, "source") === "inquiry_review" ? "borrower_disclosure" : ((str(i, "source") || "udm_alert") as LiabilitySource);
        const r = declareLiability(ctx.events, { application_id: app, borrower_ids: [str(i, "borrower_id")], liability_type: (str(i, "liability_kind") || str(i, "liability_type") || "installment") as LiabilityType, creditor_name: str(i, "creditor_name"), source, balance_cents: C(i.balance_cents), reported_payment_cents: cents(i.monthly_payment_cents), remaining_months: optNum(i, "remaining_months"), ...(typeof i.liability_id === "string" && i.liability_id ? { liability_id: i.liability_id } : {}) }, at(i, "at", ctx), ctx.actor);
        const b = applyBasis(ctx.events, r.liability, selectPaymentBasis(r.liability, basisEvidence(i)), at(i, "at", ctx), ctx.actor); putLiability(rt, b.liability, ctx);
        return { liability: b.liability, events: [r.event.type, b.event.type], next: "computeDti then notifyTolerance (23.1 B3-2-10)" };
      }
      need(i, "liability_type", "creditor_name", "balance_cents");
      const borrower_ids = strs(i, "borrower_ids").length ? strs(i, "borrower_ids") : typeof i.borrower_id === "string" && i.borrower_id ? [i.borrower_id] : [];
      const r = declareLiability(ctx.events, { application_id: app, borrower_ids, liability_type: str(i, "liability_type") as LiabilityType, creditor_name: str(i, "creditor_name"), account_last4: optStr(i, "account_last4"), source: (str(i, "source") || "application") as LiabilitySource, credit_tradeline_id: optStr(i, "credit_tradeline_id"), balance_cents: cents(i.balance_cents), reported_payment_cents: optCents(i, "reported_payment_cents"), remaining_months: optNum(i, "remaining_months"), paid_at_closing: flag(i, "paid_at_closing"), tax_lien_indicated: flag(i, "tax_lien_indicated"), du_message_ids: strs(i, "du_message_ids"), ...(typeof i.liability_id === "string" && i.liability_id ? { liability_id: i.liability_id } : {}) }, at(i, "at", ctx), ctx.actor);
      putLiability(rt, r.liability, ctx);
      return { liability: r.liability, liability_id: r.liability.liability_id, event: r.event.type }; }),
    guardrails: [NO_INCOME_ASSET_CHANGE] },
  // B3-6-01: tradeline ↔ application match; unmatched significant debts need separate credit verification; undisclosed tradelines need the borrower's reasonable explanation; authorized-user lines are not the borrower's.
  { name: "matchTradelines", kind: "write", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); if (!Array.isArray(i.tradelines)) throw new RangeError("tradelines[] are required (22.2 report tradelines)");
      const lines = (i.tradelines as Record<string, unknown>[]).map((t): Tradeline => ({ tradeline_id: String(t.tradeline_id), borrower_id: String(t.borrower_id), creditor_name: String(t.creditor_name ?? ""), account_last4: optStr(t, "account_last4"), balance_cents: C(t.balance_cents), payment_cents: CN(t.payment_cents), remaining_months: optNum(t, "remaining_months"), opened_on: optDate(t, "opened_on"), authorized_user: t.authorized_user === true, ...(typeof t.liability_type === "string" ? { liability_type: t.liability_type as LiabilityType } : {}) }));
      const m = matchTradelines(ctx.events, liabilitiesOf(rt, app), lines, at(i, "at", ctx), ctx.actor);
      for (const l of m.liabilities) putLiability(rt, l, ctx);
      for (const l of m.unmatched_significant) condition(rt, ctx, app, `${l.liability_id}-verify`, `separate credit verification for ${l.creditor_name} (declared, not on the credit report — B3-6-01)`, "ptd");
      return { matched: m.matched, unmatched_significant: m.unmatched_significant.map((l) => l.liability_id), unmatched_minor: m.unmatched_minor.map((l) => l.liability_id), undisclosed: m.undisclosed, authorized_user: m.authorized_user.map((t) => t.tradeline_id),
        borrower_questions: m.undisclosed.map((t) => ({ tradeline_id: t.tradeline_id, question: `Your credit report shows an account with ${t.creditor_name} that is not on your application. Could you tell us what it is? (Fannie Mae asks lenders to obtain a reasonable explanation for each undisclosed debt.)` })) }; }) },
  // R3: the cheapest permitted evidence path per B3-6-05; conditions open for the missing document; the student-loan choice records both figures.
  { name: "selectPaymentBasis", kind: "write", handler: compute((i, ctx, rt) => {
      const l = getLiability(rt, i); const s = selectPaymentBasis(l, basisEvidence(i));
      const b = applyBasis(ctx.events, l, s, at(i, "at", ctx), ctx.actor); putLiability(rt, b.liability, ctx);
      if (s.condition) condition(rt, ctx, l.application_id, `${l.liability_id}-basis`, s.condition, "ptd");
      return { liability_id: l.liability_id, qualifying_payment_cents: s.qualifying_payment_cents, payment_basis: s.payment_basis, alternatives: s.alternatives, condition: s.condition, rationale: s.rationale, formula_version: s.formula_version }; }),
    guardrails: [NO_BASIS_OPTIMIZATION, never("NO_HELOC_IMPUTED_PAYMENT", "B3-6-05 (a HELOC that requires no payment has no recurring obligation; the lender does not develop an equivalent payment)", (i) => flag(i, "impute_heloc_payment"), "never impute a HELOC payment")] },
  // R2: qualifying rate by product (B3-6-04), P&I at that rate and the PITIA; buydowns are never the qualifying rate.
  { name: "computeQualifyingPayment", kind: "write", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); need(i, "loan_amount_cents", "note_rate_bps", "product");
      const version = Number(i.version ?? rt.store.list("qualifying_payments", (d) => d.application_id === app).length + 1);
      const buy = i.temporary_buydown && typeof i.temporary_buydown === "object" ? { year1_rate_bps: Number((i.temporary_buydown as Record<string, unknown>).year1_rate_bps), kind: String((i.temporary_buydown as Record<string, unknown>).kind ?? "temporary") } : null;
      const hpml = i.hpml_or_hpct !== undefined ? flag(i, "hpml_or_hpct") : ctx.events.ofType("compliance.hpml.determined").filter((e) => e.applicationId === app).some((e) => (e.payload as Record<string, unknown>).is_hpml === true);
      const qp = computeQualifyingPayment({ application_id: app, version, property_role: (str(i, "property_role") || "subject_primary") as PropertyRole, loan_amount_cents: cents(i.loan_amount_cents), note_rate_bps: num(i, "note_rate_bps"), term_months: Number(i.term_months ?? 360), product: str(i, "product") as Product,
        index_bps: optNum(i, "index_bps"), margin_bps: optNum(i, "margin_bps"), first_cap_bps: optNum(i, "first_cap_bps"), max_rate_first_5y_bps: optNum(i, "max_rate_first_5y_bps"), hpml_or_hpct: hpml, temporary_buydown: buy, du_arm_qualifying_rate_bps: optNum(i, "du_arm_qualifying_rate_bps"),
        mi_cents: C(i.mi_cents), taxes_cents: C(i.taxes_cents), hazard_cents: C(i.hazard_cents), flood_cents: C(i.flood_cents), hoa_cents: C(i.hoa_cents), coop_fee_cents: C(i.coop_fee_cents), ground_rent_cents: C(i.ground_rent_cents), special_assessment_cents: C(i.special_assessment_cents), subordinate_payment_cents: C(i.subordinate_payment_cents), ...(typeof i.qp_id === "string" && i.qp_id ? { qp_id: i.qp_id } : {}) });
      rt.store.put("qualifying_payments", qp.qp_id, qpRow(qp), ctx.actor, ctx.now); const e = recordQualifyingPayment(ctx.events, qp, at(i, "at", ctx), ctx.actor);
      return { qp_id: qp.qp_id, version: qp.version, qualifying_rate_bps: qp.qualifying_rate_bps, qualifying_rate_basis: qp.qualifying_rate_basis, fully_indexed_bps: qp.fully_indexed_bps, buydown_ignored: qp.buydown_ignored, pi_cents: qp.pi_cents, bought_down_pi_cents: qp.bought_down_pi_cents, pitia_cents: qp.pitia_cents, event: e.type }; }),
    guardrails: [never("NO_BOUGHT_DOWN_RATE", "B3-6-04 (\"Loans subject to temporary interest rate buydowns must be qualified without consideration of the bought-down rate\")", (i) => flag(i, "use_bought_down_rate") || flag(i, "qualify_at_buydown_rate"), "never use a bought-down rate as the qualifying rate"), NO_INCOME_ASSET_CHANGE] },
  // R1: the immutable DTI version — subject PITIA + other REO + Σ included qualifying payments over 22.3's qualifying income less elected reductions; arms FNMA_B3_6_02_DU_DTI_50_GATE.
  { name: "computeDti", kind: "write", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const qp = latestQp(rt, i, app); const income = qualifyingIncome(i, ctx, app);
      const liabilities = Array.isArray(i.liability_ids) ? strs(i, "liability_ids").map((id) => liabilityOf(rt.store.require("application_liabilities", id).data)) : liabilitiesOf(rt, app);
      const version = Number(i.version ?? dtisOf(rt, app).length + 1);
      const note = noteDate(i, ctx, app);
      const c = computeDti({ application_id: app, version, stage: (str(i, "stage") || "application") as DtiStage, qualifying_income_cents: income, income_snapshot_id: optStr(i, "income_snapshot_id"), qp, other_reo_cents: C(i.other_reo_cents), liabilities, b3_2_10_check_id: optStr(i, "b3_2_10_check_id"), du_submission_id: optStr(i, "du_submission_id"), scheduled_note_date: note, remaining_months_recomputed: flag(i, "remaining_months_recomputed"), agent_run_id: ctx.run?.runId ?? null, ...(typeof i.dti_id === "string" && i.dti_id ? { dti_id: i.dti_id } : {}) });
      rt.store.put("dti_calculations", c.dti_id, dtiRow(c), ctx.actor, ctx.now); const e = recordDti(ctx.events, c, at(i, "at", ctx), ctx.actor);
      return { dti_id: c.dti_id, version: c.version, stage: c.stage, obligations_cents: c.obligations_cents, income_cents: c.income_cents, income_reductions_cents: c.income_reductions_cents, dti_bps: c.dti_bps, dti_tenths: c.dti_tenths, dti_display_pct: c.dti_display_pct, du_cap_ok: c.du_cap_ok, liability_ids: c.liability_ids, event: e.type }; }),
    guardrails: [NO_INCOME_ASSET_CHANGE] },
  // B3-6-05 exclusions with the Guide-named evidence (op=exclude), inclusion (op=include; the IRS-agreement inclusion satisfies FNMA_B3_6_05_IRS_AGREEMENT_GATE), the alimony election (op=elect_income_reduction — never for child support) and its two computations (op=alimony_treatments).
  { name: "evaluateExclusion", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "exclude"; const l = getLiability(rt, i); const when = at(i, "at", ctx);
      if (op === "include") { const r = includeLiability(ctx.events, l, when, ctx.actor, str(i, "why") || undefined); putLiability(rt, r.liability, ctx); return { liability_id: l.liability_id, include_in_dti: true, payment_basis: r.liability.payment_basis, event: r.event.type }; }
      if (op === "alimony_treatments") { need(i, "obligations_without_cents", "income_cents"); return alimonyTreatments(l, { obligations_without_cents: cents(i.obligations_without_cents), income_cents: cents(i.income_cents) }); }
      if (op === "elect_income_reduction") {
        const r = electIncomeReduction(ctx.events, l, i.elect !== false, { at: when, legal_agreement_document_id: optStr(i, "legal_agreement_document_id"), rationale: str(i, "rationale") || "lower DTI; permitted for alimony / equalization / separate maintenance (Q2)" }, ctx.actor); putLiability(rt, r.liability, ctx);
        return { liability_id: l.liability_id, income_reduction_elected: r.liability.income_reduction_elected, include_in_dti: r.liability.include_in_dti, exclusion_reason: r.liability.exclusion_reason, event: r.event?.type ?? null, du_submitted_as: r.liability.income_reduction_elected ? "income reduced, not the liability" : "liability" };
      }
      need(i, "reason");
      const r = evaluateExclusion(l, str(i, "reason") as ExclusionReason, { ...exclusionEvidence(i), ...(i.qualifying_income_cents === undefined ? {} : { qualifying_income_cents: cents(i.qualifying_income_cents) }) });
      putLiability(rt, r.liability, ctx); const e = recordExclusion(ctx.events, r, when, ctx.actor);
      return { liability_id: l.liability_id, include_in_dti: r.include_in_dti, exclusion_reason: r.exclusion_reason, remaining_months: r.liability.remaining_months, significantly_affects: r.liability.significantly_affects, why: r.why, funds_to_verify_delta_cents: r.funds_to_verify_delta_cents, citation: r.citation, event: e.type }; }),
    guardrails: [never("NO_NON_APPLICANT_EXCLUSION_WITHOUT_DOCS", "B3-6-05 (\"the lender may provide supporting documentation to validate this\")", (i) => str(i, "reason") === "non_applicant_documented" && !strs((i.evidence as Record<string, unknown> | undefined) ?? i, "evidence_document_ids").length, "never a non-applicant exclusion without documentation"),
      never("NO_INCOME_REDUCTION_FOR_CHILD_SUPPORT", "B3-6-05 (the option covers alimony, equalization payments and separate maintenance — child support has no income-reduction option)", (i) => str(i, "op") === "elect_income_reduction" && i.elect !== false && (str(i, "liability_type") === "child_support" || str(i, "liability_type") === "garnishment"), "never apply the alimony income-reduction to child support")] },
  // R5 / B3-6-07: payoff or paydown to qualify — funds verified in addition (22.4 funds_to_verify += payoff), no account closure, the B3-6-07 credit-use rationale, Q1 reviewer threshold; arms FNMA_B3_6_07_PAYOFF_FUNDS_GATE.
  { name: "planPayoff", kind: "write", handler: compute((i, ctx, rt) => {
      const l = getLiability(rt, i); need(i, "mode", "credit_use_rationale"); const app = l.application_id;
      const income = qualifyingIncome(i, ctx, app);
      const excluded = liabilitiesOf(rt, app).filter((x) => x.paid_at_closing && x.liability_id !== l.liability_id).reduce((a, x) => a + x.qualifying_payment_cents, 0n);
      const r = planPayoff(ctx.events, l, { mode: str(i, "mode") as PayoffMode, funds_source_asset_id: optStr(i, "funds_source_asset_id"), funds_verified_in_addition: flag(i, "funds_verified_in_addition"), scheduled_note_date: noteDate(i, ctx, app), qualifying_income_cents: income, post_closing_liquid_cents: optCents(i, "post_closing_liquid_cents"), excluded_payments_cents: excluded, credit_use_rationale: str(i, "credit_use_rationale"), at: at(i, "at", ctx), ...(typeof i.plan_id === "string" && i.plan_id ? { plan_id: i.plan_id } : {}) }, ctx.actor);
      rt.store.put("debt_payoff_plans", r.plan.plan_id, planRow(r.plan), ctx.actor, ctx.now); putLiability(rt, r.liability, ctx);
      if (r.reviewer_required) rt.escalations.open({ kind: "underwriting_reviewer", loanId: ctx.loanId, applicationId: app, payload: { application_id: app, plan_id: r.plan.plan_id, liability_id: l.liability_id, reason: "payoff-to-qualify above the Q1 threshold (excluded payments > 10% of qualifying income or payoff > 50% of post-closing liquid assets) — B3-6-07 careful evaluation" } }, ctx.actor);
      return { plan_id: r.plan.plan_id, mode: r.plan.mode, payoff_amount_cents: r.plan.amount_cents, funds_to_verify_delta_cents: r.funds_to_verify_delta_cents, excluded_payment_cents: l.qualifying_payment_cents, exclusion_reason: r.liability.exclusion_reason, account_closure_condition: r.account_closure_condition, reviewer_required: r.reviewer_required, status: r.plan.status, event: r.event.type }; }),
    guardrails: [NO_INCOME_ASSET_CHANGE] },
  // B3-6-07 evidence: the settlement-statement line (or a pre-closing payoff / zero-balance statement) → debt_payoff.evidenced; omitted → debt_payoff.failed, the liability re-included and the DTI to be recomputed; op=gate evaluates the gate facts.
  { name: "evidencePayoff", kind: "write", handler: compute((i, ctx, rt) => {
      if (str(i, "op") === "gate") return payoffFundsGate((i.facts as Record<string, unknown> | undefined) ?? i);
      need(i, "plan_id"); const plan = planOf(rt.store.require("debt_payoff_plans", str(i, "plan_id")).data); const l = liabilityOf(rt.store.require("application_liabilities", plan.liability_id).data);
      const r = evidencePayoff(ctx.events, plan, l, { settlement_statement_document_id: optStr(i, "settlement_statement_document_id"), settlement_statement_shows_payoff: flag(i, "settlement_statement_shows_payoff"), payoff_statement_document_id: optStr(i, "payoff_statement_document_id"), zero_balance_document_id: optStr(i, "zero_balance_document_id"), creditor_letter_document_id: optStr(i, "creditor_letter_document_id"), verified_funds_in_addition_cents: optCents(i, "verified_funds_in_addition_cents"), at: at(i, "at", ctx) }, ctx.actor);
      rt.store.put("debt_payoff_plans", plan.plan_id, planRow(r.plan), ctx.actor, ctx.now); putLiability(rt, r.liability, ctx);
      return { plan_id: plan.plan_id, status: r.plan.status, evidence: r.plan.evidence, gate: r.gate, re_included: r.re_included, blocks: r.blocks, event: r.event.type, next: r.re_included ? "computeDti with the payment included, then notifyTolerance (23.1)" : null }; }) },
  // FNMA_B3_6_02_DU_DTI_50_GATE: above 50.00 % → dti.du_cap.exceeded (23.2 restructure loop) and the underwriting_reviewer for a counteroffer/denial via 21.6.
  { name: "checkDuCap", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "dti_id"); const c = getDti(rt, str(i, "dti_id")); const r = checkDuCap(ctx.events, c, at(i, "at", ctx), ctx.actor);
      if (r.escalate) rt.escalations.open({ kind: r.escalate, loanId: ctx.loanId, applicationId: c.application_id, payload: { application_id: c.application_id, dti_id: c.dti_id, dti_bps: c.dti_bps, reason: r.gate.reason } }, ctx.actor);
      return { dti_id: c.dti_id, dti_bps: c.dti_bps, du_cap_ok: r.du_cap_ok, cap_bps: r.cap_bps, gate: r.gate, hand_off: r.hand_off, escalated_to: r.escalate, event: r.event?.type ?? null }; }) },
  // B3-2-10 (23.1's rule through 22.2's calculators): liabilities.changed{dti_before, dti_after, tolerance_result} — a required resubmission arms SM_DU_RESUBMIT_SLA_1BD.
  { name: "notifyTolerance", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "dti_after_id"); const after = getDti(rt, str(i, "dti_after_id"));
      const before = typeof i.dti_before_id === "string" && i.dti_before_id ? getDti(rt, i.dti_before_id) : dtisOf(rt, after.application_id).filter((c) => c.version < after.version).at(-1);
      if (!before) throw new RangeError("dti_before_id is required (no earlier version on file)");
      const r = notifyTolerance(ctx.events, before, after, { at: at(i, "at", ctx), trigger: str(i, "trigger") || "liability change", liability_id: optStr(i, "liability_id") }, ctx.actor);
      rt.store.put("dti_calculations", after.dti_id, { tolerance_result: r.tolerance.result, tolerance_rule_code: r.tolerance.rule_code, delta_bps: r.tolerance.delta_bps }, ctx.actor, ctx.now);
      return { ...r.tolerance, check_23_1: r.tolerance.check_23_1, resubmission_for: r.tolerance.result === "resubmission_required" ? "23.1" : null, event: r.event.type }; }) },
  // Terminal: the final DTI version equals the final DU submission's liability set and the CD-final P&I; the legal-document, IRS and payoff gates are open; du_cap_ok → liabilities.finalized (23.1 / 23.3 / 23.4 / 28.3).
  { name: "finalizeLiabilities", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "dti_id", "cd_final_pi_cents"); const c = getDti(rt, str(i, "dti_id")); const app = c.application_id; const qp = latestQp(rt, { ...i, qp_id: c.qp_id }, app); const liabilities = liabilitiesOf(rt, app);
      const legal = liabilities.filter((l) => ["alimony", "child_support", "separate_maintenance", "equalization_payment", "garnishment"].includes(l.liability_type)).map((l) => legalDocGate({ liability_type: l.liability_type, legal_agreement_document_id: l.exclusion_evidence_document_ids[0] ?? optStr(i, `legal_agreement_document_id`) ?? ((i.legal_documents as Record<string, string> | undefined)?.[l.liability_id] ?? null), amount_confirmed: true })).find((g) => !g.open) ?? { open: true };
      const irs = liabilities.filter((l) => l.liability_type === "irs_installment").map((l) => irsAgreementGate({ ...((i.irs_facts as Record<string, unknown> | undefined) ?? {}), tax_lien_indicated: l.tax_lien_indicated, include_in_dti: l.include_in_dti, payment_basis: l.payment_basis })).find((g) => !g.open) ?? { open: true };
      const plans = rt.store.list("debt_payoff_plans", (d) => d.application_id === app).map((r) => planOf(r.data));
      const payoff = plans.length ? payoffFundsGate({ plans: plans.map((p) => ({ payoff_amount_cents: String(p.amount_cents), funds_verified_in_addition: p.funds_verified_in_addition, settlement_statement_shows_payoff: p.evidence === "settlement_statement_line", payoff_statement_document_id: p.evidence === "payoff_statement_before_closing" ? p.evidence_document_id : null, zero_balance_document_id: p.evidence === "zero_balance_statement" ? p.evidence_document_id : null, creditor_letter_document_id: p.evidence === "creditor_letter_remaining_payments" ? p.evidence_document_id : null })) }) : { open: true };
      const r = finalizeLiabilities(ctx.events, { calc: c, liabilities, qp, du_final_liability_ids: strs(i, "du_final_liability_ids"), cd_final_pi_cents: cents(i.cd_final_pi_cents), legal_doc_gate: legal, irs_gate: irs, payoff_gate: payoff, last_change_at: optStr(i, "last_change_at"), at: at(i, "at", ctx) }, ctx.actor);
      for (const l of r.liabilities) putLiability(rt, l, ctx); rt.store.put("dti_calculations", c.dti_id, { finalized: true, hmda_reported: c.stage === "decision_of_record" || flag(i, "hmda_reported") }, ctx.actor, ctx.now);
      return { dti_id: c.dti_id, version: c.version, dti_bps: c.dti_bps, du_cap_ok: c.du_cap_ok, liability_ids: c.liability_ids, gates: { legal_doc: legal, irs: irs, payoff }, event: r.event.type }; }),
    guardrails: [NO_INCOME_ASSET_CHANGE] },
  // The agent's decision record: {application_id, dti_version, liabilities[] with basis/evidence/exclusion, qualifying_payment inputs, dti_bps, du_cap_ok, tolerance_result, rule_set_version, formula_version, model_version, rationale, confidence}.
  { name: "writeDecision", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "action", "rationale");
      const rec = typeof i.dti_id === "string" && i.dti_id ? (() => { const c = getDti(rt, i.dti_id); const qp = latestQp(rt, { ...i, qp_id: c.qp_id }, c.application_id); return decisionRecord({ application_id: c.application_id, calc: c, liabilities: liabilitiesOf(rt, c.application_id), qp, tolerance_result: (optStr(i, "tolerance_result") as "resubmission_required" | "within_tolerance" | null), rationale: str(i, "rationale"), confidence: Number(i.confidence ?? 1), model_version: ctx.run?.modelVersion ?? str(i, "model_version") ?? "n/a", prompt_version: ctx.run?.promptVersion ?? str(i, "prompt_version") ?? "n/a" }); })() : null;
      decision()({ ...i, rule_set_version: str(i, "rule_set_version") || RULE_SET_VERSION, ...(rec ? { subject: { kind: "dti_calculation", id: String(rec.dti_id) } } : {}) }, ctx);
      return { recorded: true, record: rec }; }) },
]));
