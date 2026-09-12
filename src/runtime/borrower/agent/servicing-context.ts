/**
 * The servicing record as the model may know it (32.16 Stage 4; docs/ux/17 §3.2, §1 principle 7): the figures and dates a serviced
 * loan's `borrower_record` carries — the balance, the next installment, the escrow balance and lines, autopay, MI, the hardship and
 * rate-watch blocks — and the 02 §1.5 history views (payments, escrow, statements, cases, lossmit) — projected to `{{token}}`s. The
 * model reads the keys and writes the tokens; the API fills them after the guard. Nothing here computes a date or a figure: every
 * value is a stored one, formatted (cents → USD, a date's civil day) the way agent/context.ts formats the origination record.
 *
 * Pure over its input (no table, no bus): `record.get` and `explain` in src/app/tools/section32-16.ts hand it the projection they read.
 * agent/context.ts (the Stage 3 owner's) still projects `record.numbers` through its own allow-list, which drops `next_payment` (an
 * object) — `servicingView` is the helper its `compactRecord` should merge for a serviced loan (see the report of this stage).
 */
import type { BorrowerRecord } from "../record.ts";

type P = Record<string, unknown>;
export interface ServicingView { readonly view: P; readonly tokens: Record<string, string> }
export type HistoryView = "payments" | "escrow" | "statements" | "cases" | "lossmit";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** A stored cents figure (bigint, a decimal string, a number) as USD; null for anything else — never a sum. */
export const usd = (v: unknown): string | null => { const s = v === undefined || v === null || v === "" ? null : typeof v === "bigint" ? v.toString() : /^-?\d+$/.test(String(v)) ? String(v) : null; return s === null ? null : USD.format(Number(BigInt(s)) / 100); };
const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const pct = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : /^-?\d+(\.\d+)?%?$/.test(String(v)) ? `${String(v).replace(/%$/, "")}%` : null);
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;

/** Put `value` under `key` as a token and return the placeholder; null values leave nothing. */
function tok(tokens: Record<string, string>, key: string, value: string | null): string | null { if (value === null) return null; tokens[key] = value; return `{{${key}}}`; }

/** The loan's own numbers and Loan-section facts: balance, next installment, escrow, autopay, MI, ARM, hardship, rate-watch — as tokens. */
export function servicingView(record: BorrowerRecord | null): ServicingView {
  const tokens: Record<string, string> = {}; const view: P = {};
  if (!record || !record.subject.loan_id) return { view, tokens };
  const n = (record.numbers ?? {}) as P; const loan = (record.loan ?? {}) as P;
  view["status"] = { badge: record.status.badge, one_liner: "{{status.one_liner}}" }; tokens["status.one_liner"] = record.status.one_liner;
  view["balance"] = tok(tokens, "numbers.upb", usd(n["upb_cents"]));
  view["escrow_balance"] = tok(tokens, "numbers.escrow_balance", usd(n["escrow_balance_cents"]));
  view["rate"] = tok(tokens, "numbers.rate", pct(n["note_rate"]));
  view["days_past_due"] = n["days_past_due"] !== undefined && n["days_past_due"] !== null ? tok(tokens, "numbers.days_past_due", String(n["days_past_due"])) : null;
  const next = n["next_payment"] as P | null | undefined;
  view["next_payment"] = next ? { amount: tok(tokens, "numbers.next_payment", usd(next["amount_cents"])), due_on: tok(tokens, "dates.next_payment_due", day(next["due_on"])), principal_and_interest: tok(tokens, "numbers.next_payment_pi", usd(next["pi_cents"])), escrow: tok(tokens, "numbers.next_payment_escrow", usd(next["escrow_cents"])) } : null;
  const paidOff = n["paid_off"] as P | null | undefined;
  if (paidOff) view["paid_off"] = { payoff_date: tok(tokens, "dates.payoff", day(paidOff["payoff_date"])), escrow_refund_pending: tok(tokens, "numbers.escrow_refund_pending", usd(paidOff["escrow_refund_pending_cents"])) };
  const arm = n["arm_estimate"] as P | null | undefined;
  if (arm) view["arm_estimate"] = { change_on: tok(tokens, "dates.arm_change", day(arm["change_on"])), estimated_rate: tok(tokens, "numbers.arm_estimated_rate", pct(arm["estimated_rate"])), estimated_payment: tok(tokens, "numbers.arm_estimated_pi", usd(arm["estimated_pi_cents"])), basis: arm["basis"] ?? null };
  const auto = loan["autodraft"] as P | null | undefined;
  view["autopay"] = auto ? { status: auto["status"] ?? "none", next_draft_on: tok(tokens, "loan.autodraft.next_draft_on", day(auto["next_draft_on"])), amount: tok(tokens, "loan.autodraft.amount", usd(auto["amount_cents"])), account_last4: tok(tokens, "loan.autodraft.account_last4", auto["account_last4"] ? `••••${String(auto["account_last4"])}` : null), draft_day: typeof auto["draft_day"] === "number" || /^\d+$/.test(String(auto["draft_day"] ?? "")) ? tok(tokens, "loan.autodraft.draft_day", ordinal(Number(auto["draft_day"]))) : null, amount_rule: auto["amount_rule"] ?? null } : { status: "none" };
  const lines = Array.isArray(loan["escrow_lines"]) ? (loan["escrow_lines"] as P[]) : [];
  view["escrow"] = { escrowed: loan["escrowed"] ?? null, balance: view["escrow_balance"], lines: lines.map((l) => { const t = String(l["type"] ?? "line"); return { type: t, payee: tok(tokens, `loan.escrow.${t}.payee`, l["payee"] ? String(l["payee"]) : null), annual: tok(tokens, `loan.escrow.${t}.annual`, usd(l["annual_cents"])), next_disbursement_on: tok(tokens, `loan.escrow.${t}.next_disbursement_on`, day(l["next_disbursement_on"])) }; }) };
  const mi = loan["mi"] as P | null | undefined;
  view["mortgage_insurance"] = mi ? { status: mi["status"] ?? "none", ends_on: tok(tokens, "loan.mi.projected_end_on", day(mi["projected_end_on"])), can_ask_to_cancel_from: tok(tokens, "loan.mi.cancellation_eligible_on", day(mi["cancellation_eligible_on"])) } : { status: "none" };
  const armBlock = loan["arm"] as P | null | undefined;
  if (armBlock) view["arm"] = { next_change_on: tok(tokens, "loan.arm.next_change_on", day(armBlock["next_change_on"])), notice_status: armBlock["notice_status"] ?? null };
  const h = loan["hardship"] as P | null | undefined;
  if (h) view["hardship"] = { status: h["status"] ?? null, ...(h["plan"] && typeof h["plan"] === "object" ? { plan: { kind: (h["plan"] as P)["kind"] ?? (h["plan"] as P)["plan_type"] ?? null, status: (h["plan"] as P)["status"] ?? null, through: tok(tokens, "loan.hardship.plan.through", day((h["plan"] as P)["term_end"] ?? (h["plan"] as P)["current_term_end"] ?? (h["plan"] as P)["through"])) } } : {}), ...(h["trial"] && typeof h["trial"] === "object" ? { trial: { n: (h["trial"] as P)["n"] ?? null, count: (h["trial"] as P)["count"] ?? null, amount: tok(tokens, "loan.hardship.trial.amount", usd((h["trial"] as P)["amount_cents"])), due_on: tok(tokens, "loan.hardship.trial.due_on", day((h["trial"] as P)["due_on"] ?? (h["trial"] as P)["due_date"])) } } : {}), cease: h["cease"] ?? null };
  const rw = loan["ratewatch"] as P | null | undefined;
  if (rw) view["rate_watch"] = { state: rw["state"] ?? "passive", state_copy_key: rw["state_copy_key"] ?? null, worth_it_copy_key: rw["worth_it_copy_key"] ?? null, current_rate: tok(tokens, "ratewatch.current_rate", pct(rw["current_rate"])), best_available_rate: tok(tokens, "ratewatch.best_available_rate", pct(rw["best_available_rate"])), offer_card_instance_id: rw["offer_card_instance_id"] ?? null };
  const year = loan["year_end"] as P | null | undefined;
  if (year) view["year_end"] = { form_1098: year["form_1098_status"] ?? null, tax_year: tok(tokens, "loan.year_end.tax_year", year["tax_year"] !== undefined && year["tax_year"] !== null ? String(year["tax_year"]) : null) };
  for (const k of ["first_payment_date", "maturity_date"]) { const v = tok(tokens, `loan.${k}`, day(loan[k])); if (v) view[k] = v; }
  if (loan["remaining_term_months"] !== undefined && loan["remaining_term_months"] !== null) view["remaining_term_months"] = tok(tokens, "loan.remaining_term_months", String(loan["remaining_term_months"]));
  view["servicer_loan_number_last4"] = tok(tokens, "loan.number_last4", loan["servicer_loan_number_last4"] ? `••••${String(loan["servicer_loan_number_last4"])}` : null);
  return { view, tokens };
}

/** The latest `loan_terms` facts a late-charge or autopay explanation names (read by the tool, formatted here): the grace period and the late-charge rate as stored. */
export function termsView(t: { grace_days: number; late_charge_pct_bps: number | null; pi_cents: bigint; escrow_cents: bigint } | null): ServicingView {
  const tokens: Record<string, string> = {}; const view: P = {};
  if (!t) return { view, tokens };
  view["grace_days"] = tok(tokens, "loan.grace_days", String(t.grace_days));
  view["late_charge_rate"] = t.late_charge_pct_bps === null ? null : tok(tokens, "loan.late_charge_pct", `${(t.late_charge_pct_bps / 1000).toString()}%`);
  view["installment"] = { principal_and_interest: tok(tokens, "loan.installment_pi", usd(t.pi_cents)), escrow: tok(tokens, "loan.installment_escrow", usd(t.escrow_cents)) };
  return { view, tokens };
}

const LIMIT = 6;
/** A 02 §1.5 history view as tokens: the newest `LIMIT` rows, every figure and date a placeholder (`payments.1.amount`, `escrow.analysis.1.shortage`, …). */
export function historyView(view: HistoryView, rows: readonly P[]): ServicingView {
  const tokens: Record<string, string> = {}; const out: P[] = [];
  const take = rows.slice(0, LIMIT);
  take.forEach((r, i) => {
    const k = i + 1;
    if (view === "payments") { const a = (r["allocation"] as P | undefined) ?? {}; out.push({ n: k, status: r["status"] ?? null, designation: r["designation"] ?? null, channel: r["channel"] ?? null, amount: tok(tokens, `payments.${k}.amount`, usd(r["amount_cents"])), received_on: tok(tokens, `payments.${k}.received_on`, day(r["received_on"])), credited_as_of: tok(tokens, `payments.${k}.credited_as_of`, day(r["credited_as_of"])), applied: r["status"] === "posted" ? { interest: tok(tokens, `payments.${k}.interest`, usd(a["interest_cents"])), principal: tok(tokens, `payments.${k}.principal`, usd(a["principal_cents"])), escrow: tok(tokens, `payments.${k}.escrow`, usd(a["escrow_cents"])), fees: tok(tokens, `payments.${k}.fees`, usd(a["fees_cents"])) } : null }); return; }
    if (view === "escrow") {
      if (r["kind"] === "analysis") out.push({ n: k, kind: "analysis", type: r["type"] ?? null, status: r["status"] ?? null, as_of: tok(tokens, `escrow.analysis.${k}.as_of`, day(r["as_of"])), new_payment: tok(tokens, `escrow.analysis.${k}.new_payment`, usd(r["new_payment_cents"])), effective_on: tok(tokens, `escrow.analysis.${k}.effective_on`, day(r["effective_on"])), shortage: tok(tokens, `escrow.analysis.${k}.shortage`, usd(r["shortage_cents"])), surplus: tok(tokens, `escrow.analysis.${k}.surplus`, usd(r["surplus_cents"])), deficiency: tok(tokens, `escrow.analysis.${k}.deficiency`, usd(r["deficiency_cents"])) });
      else if (r["kind"] === "election") out.push({ n: k, kind: "election", type: r["type"] ?? null, months: r["months"] ?? null, recorded_on: tok(tokens, `escrow.election.${k}.recorded_on`, day(r["recorded_on"])) });
      else out.push({ n: k, kind: "disbursement", type: r["type"] ?? null, status: r["status"] ?? null, payee: tok(tokens, `escrow.disbursement.${k}.payee`, r["payee"] ? String(r["payee"]) : null), amount: tok(tokens, `escrow.disbursement.${k}.amount`, usd(r["amount_cents"])), due_date: tok(tokens, `escrow.disbursement.${k}.date`, day(r["due_date"])) });
      return;
    }
    if (view === "statements") { out.push({ n: k, status: r["status"] ?? null, variant: r["variant"] ?? null, channel: r["channel"] ?? null, cycle_due_date: tok(tokens, `statements.${k}.cycle_due_date`, day(r["cycle_due_date"])), delivered_at: tok(tokens, `statements.${k}.delivered_on`, day(r["delivered_at"])), document_id: r["document_id"] ?? null }); return; }
    if (view === "cases") { const due = Array.isArray(r["due"]) ? (r["due"] as P[]) : []; out.push({ n: k, kind: r["kind"] ?? null, status: r["status"] ?? null, opened_on: tok(tokens, `cases.${k}.opened_on`, day(r["opened_at"] ?? r["receipt_date"])), due: due.map((d, j) => ({ timer_code: d["timer_code"] ?? null, status: d["status"] ?? null, due_date: tok(tokens, `cases.${k}.due.${j + 1}`, day(d["due_date"])) })) }); return; }
    out.push({ n: k, kind: r["kind"] ?? null, status: r["status"] ?? null, ...(r["plan_type"] ? { plan_type: r["plan_type"] } : {}), ...(r["option"] ? { option: r["option"] } : {}), received_on: tok(tokens, `lossmit.${k}.received_on`, day(r["received_date"] ?? r["start_date"] ?? r["started_at"])), due_on: tok(tokens, `lossmit.${k}.due_on`, day(r["due_at"] ?? r["accept_by"] ?? r["appeal_window_ends"] ?? r["current_term_end"] ?? r["reasonable_date"])), amount: tok(tokens, `lossmit.${k}.amount`, usd(r["installment_cents"])) });
  });
  return { view: { view, rows: out, more: rows.length > LIMIT }, tokens };
}
