/**
 * §32.18 process-owned tool — the DU moment (spec/sections/32-borrower-experience/32-18-the-du-moment-assets-credit-and-the-underwriting-run-from-the-conversation.md
 * "AI agent design"), defined with `defineTools("32.18", "borrower-app", defs)` and spread by ./index.ts.
 *
 *   underwriting.run   rule 3 as one bus command: the ULAD snapshot projected from the application tables (rule 4), then — through the same
 *                      delegation 32.2 uses, each under its owner's guardrails — 23.1's casefile, `associateCredit` for every borrower's usable
 *                      report, `buildDuRequest{credit_and_underwriting, initial}` with the asset verification report(s) as
 *                      `validation_report_refs`, `submitCasefile`, `fetchFindings` and 23.2's `parseFindings{op=interpret}`. On the FAKE
 *                      vendors the whole moment is one settlement (du.casefile.created … du.findings.interpreted). Idempotent: an
 *                      application with a casefile answers {ran: false}. An incomplete snapshot is refused (DU_SNAPSHOT_INCOMPLETE);
 *                      nothing is submitted. The 32.16 turn never calls this — the flow does, on the last prerequisite.
 *                      `reassemble: true` on an application that already has a casefile (rule 7: a gap card resolved) re-runs 23.6's
 *                      assembly and 23.7's preflight over the graph as it now stands — a further du.document.emitted — and submits
 *                      nothing: the resubmission is 23.1's (rule 6).
 */
import { defineTools, compute, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { createCasefile, type DuCasefile, type UladSnapshot } from "../../domain/underwriting/ops-23-1.ts";
import { monthlyPI } from "../../domain/verification/ops-22-4.ts";
import { delegate } from "./section32-2.ts";

type P = Record<string, unknown>;
const PROCESS_32_18 = "32.18"; const BORROWER_APP = "borrower-app";
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const cents = (v: unknown): bigint | null => { if (typeof v === "bigint") return v; if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v)); if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim()); return null; };

export class DuSnapshotIncomplete extends Error { readonly code = "DU_SNAPSHOT_INCOMPLETE"; readonly missing: readonly string[]; constructor(missing: readonly string[]) { super(`the DU snapshot is missing ${missing.join(", ")}`); this.name = "DuSnapshotIncomplete"; this.missing = missing; } }

/** The partner's DU identifiers (23.1 CreateCasefileInput) — partner configuration; FAKE values in nonprod (32.18 operational prerequisites). */
export const DU_PARTNER = { seller_number: process.env["FNMA_SELLER_NUMBER"] ?? "123456789", system_id_ref: process.env["DU_SYSTEM_ID_REF"] ?? "SYS-PARTNER-01", tsp_product_ref: process.env["DU_TSP_PRODUCT_REF"] ?? "SM-TSP" } as const;

const LOAN_PURPOSE: Readonly<Record<string, UladSnapshot["loan_purpose"]>> = { limited_cash_out: "limited_cash_out_refinance", cash_out: "cash_out_refinance", purchase: "purchase", rate_term: "limited_cash_out_refinance" } as unknown as Readonly<Record<string, UladSnapshot["loan_purpose"]>>;
const OCCUPANCY: Readonly<Record<string, string>> = { primary: "principal_residence", principal_residence: "principal_residence", second_home: "second_home", investment: "investment" };
const PRODUCT: Readonly<Record<string, { product: string; amortization: string; loan_term: number }>> = { FRM30: { product: "fixed_30", amortization: "fixed", loan_term: 360 }, FRM30_CONV: { product: "fixed_30", amortization: "fixed", loan_term: 360 }, FRM15: { product: "fixed_15", amortization: "fixed", loan_term: 180 }, FRM20: { product: "fixed_20", amortization: "fixed", loan_term: 240 } };
const PROPERTY_TYPE: Readonly<Record<string, string>> = { sfr: "sfr_detached", sfr_detached: "sfr_detached", single_family: "sfr_detached", condo: "condo", townhouse: "pud", pud: "pud", "2-4": "two_to_four_units", manufactured: "manufactured" };

/** 32.18 rule 4: the ULAD snapshot from the application tables — what a hand-built object was in every fixture. */
export async function uladSnapshotOf(rt: ToolRuntime, application_id: string): Promise<{ snapshot: UladSnapshot; sources: P }> {
  const db = dbOf(rt);
  const intake = (rt.store.get("applications", application_id)?.data ?? {}) as P;
  const app = (await db.query<P>(`SELECT transaction_type, occupancy, product_code, six_items FROM applications WHERE id = $1`, [application_id]))[0] ?? {};
  const property = (await db.query<P>(`SELECT property_type, units, estimated_value_cents::text AS estimated_value_cents FROM application_properties WHERE application_id = $1 AND is_subject ORDER BY created_at DESC LIMIT 1`, [application_id]))[0];
  // the borrowers: the intake record's ids are the ones the credit report names (22.2 orders by them); the application_borrowers rows (same order) carry the last four
  const rows = await db.query<{ id: string; legal_name: string; tin_last4: string | null }>(`SELECT id::text AS id, legal_name, tin_last4 FROM application_borrowers WHERE application_id = $1 AND borrower_role IN ('borrower', 'co_borrower', 'non_occupant_co_borrower') ORDER BY created_at`, [application_id]);
  const intakeBorrowers = ((intake["borrowers"] as P[] | undefined) ?? []).filter((b) => ["borrower", "co_borrower", "non_occupant_co_borrower", undefined].includes(b["borrower_role"] as string | undefined));
  const borrowers = rows.map((r, k) => { const ib = intakeBorrowers.find((b) => b["id"] === r.id) ?? intakeBorrowers.find((b) => String(b["legal_name"] ?? "") === r.legal_name) ?? intakeBorrowers[k]; return { id: typeof ib?.["id"] === "string" ? String(ib["id"]) : r.id, legal_name: r.legal_name, tin_last4: r.tin_last4 }; });
  const income = await db.query<{ total: string | null }>(`SELECT sum(monthly_amount_cents)::text AS total FROM (SELECT DISTINCT ON (application_borrower_id, source_kind) monthly_amount_cents FROM application_income WHERE application_id = $1 AND qualifying ORDER BY application_borrower_id, source_kind, version DESC, created_at DESC) x`, [application_id]);
  const debts = await db.query<{ total: string | null }>(`SELECT coalesce(sum(monthly_payment_cents), 0)::text AS total FROM application_liabilities WHERE application_id = $1 AND NOT paid_at_closing AND liability_kind <> 'mortgage'`, [application_id]);
  const transaction = String(intake["transaction_type"] ?? app["transaction_type"] ?? "limited_cash_out");
  const loan_purpose = LOAN_PURPOSE[transaction] ?? ("limited_cash_out_refinance" as UladSnapshot["loan_purpose"]);
  const occupancy = OCCUPANCY[String(intake["occupancy"] ?? app["occupancy"] ?? "primary")] ?? "principal_residence";
  const productCode = String(intake["product_code"] ?? app["product_code"] ?? "FRM30").toUpperCase(); const product = PRODUCT[productCode] ?? PRODUCT["FRM30"]!;
  const value = cents(intake["property_value_estimate_cents"]); const amount = cents(intake["loan_amount_sought_cents"]);
  const qualifying = cents(income[0]?.total) ?? cents(intake["income_monthly_cents"]);
  const missing: string[] = [];
  if (value === null || value <= 0n) missing.push("property_value_estimate_cents"); if (amount === null || amount <= 0n) missing.push("loan_amount_sought_cents");
  if (qualifying === null || qualifying <= 0n) missing.push("qualifying_income_cents"); if (!borrowers.length) missing.push("borrowers");
  for (const b of borrowers) if (!b.tin_last4) missing.push(`ssn_last4:${b.id}`);
  if (missing.length) throw new DuSnapshotIncomplete(missing);
  // the note rate: the newest pricing quote for the application, else the newest published sheet's par rate for the product, else 6.500 (rule 4)
  const quote = rt.store.list("pricing_quotes", (d) => d["application_id"] === application_id && typeof d["note_rate_pct"] === "string").map((r) => r.data as P).sort((a, b) => String(a["quoted_at"] ?? a["created_at"] ?? "").localeCompare(String(b["quoted_at"] ?? b["created_at"] ?? ""))).at(-1);
  let note_rate_pct = typeof quote?.["note_rate_pct"] === "string" && /^\d+(\.\d+)?$/.test(String(quote["note_rate_pct"])) ? String(quote["note_rate_pct"]) : ""; let rateSource = note_rate_pct ? "pricing_quote" : "";
  if (!note_rate_pct) {
    const sheet = rt.store.list("rate_sheets", (d) => typeof d["published_at"] === "string").map((r) => r.data as P).sort((a, b) => String(a["published_at"]).localeCompare(String(b["published_at"]))).at(-1);
    const prices = ((sheet?.["prices"] as P[] | undefined) ?? []).filter((x) => String(x["product_code"] ?? "").toUpperCase() === productCode || String(x["product_code"] ?? "").toUpperCase() === "FRM30");
    // 20.4 stores the sheet's rate as a fraction (`note_rate` 0.06125); the snapshot carries a percentage string ("6.125")
    const rateOf = (x: P): string => { const raw = String(x["note_rate_pct"] ?? x["rate_pct"] ?? x["note_rate"] ?? x["rate"] ?? ""); if (!/^\d+(\.\d+)?$/.test(raw)) return ""; const n = Number(raw); return n < 1 ? (Math.round(n * 100_000) / 1000).toFixed(3) : raw; };
    const par = prices.map((x) => ({ rate: rateOf(x), dist: Math.abs(Number(x["price"] ?? x["price_pct"] ?? NaN) - 100) })).filter((x) => /^\d+(\.\d+)?$/.test(x.rate) && Number.isFinite(x.dist)).sort((a, b) => a.dist - b.dist)[0];
    if (par) { note_rate_pct = par.rate; rateSource = "rate_sheet_par"; }
  }
  if (!note_rate_pct) { note_rate_pct = "6.500"; rateSource = "default"; }
  // 22.4's level payment takes the annual rate as a fraction (0.06125); the snapshot carries the percentage string ("6.125")
  const pi = monthlyPI(amount!, (Number(note_rate_pct) / 100).toFixed(8), product.loan_term);
  const total_obligations_cents = (cents(debts[0]?.total) ?? 0n) + pi;
  const snapshot: UladSnapshot = {
    application_id, loan_purpose, occupancy, product: product.product, amortization: product.amortization, loan_term: product.loan_term,
    property_type: PROPERTY_TYPE[String(property?.["property_type"] ?? "sfr").toLowerCase()] ?? "sfr_detached",
    sales_price_cents: loan_purpose === "purchase" ? value! : null, appraised_value_cents: value!, loan_amount_cents: amount!, note_rate_pct,
    qualifying_income_cents: qualifying!, total_obligations_cents,
    borrowers: borrowers.map((b) => ({ borrower_id: b.id, last_name: b.legal_name.trim().split(/\s+/).at(-1) ?? b.legal_name, suffix: null, ssn_last4: b.tin_last4! })),
    max_ltv_pct: loan_purpose === "purchase" ? "97.00" : "95.00",
    // DELTA-37: the cash-out purpose the amount card collected (21.1 captureField{cash_out_purpose}); absent on the record → absent on the deal, and 23.6 names LOAN/REFINANCE/RefinancePrimaryPurposeType as the gap on a cash-out file
    cash_out_purpose: typeof intake["cash_out_purpose"] === "string" && intake["cash_out_purpose"] !== "" ? String(intake["cash_out_purpose"]) : null,
  };
  return { snapshot, sources: { product_code: productCode, rate_source: rateSource, pi_cents: pi.toString(), other_debts_cents: (cents(debts[0]?.total) ?? 0n).toString(), income_rows: income[0]?.total ?? null } };
}

/** The snapshot as the bus carries it: the bigint figures as digit strings. */
const snapshotWire = (snapshot: UladSnapshot): P => ({ ...snapshot, sales_price_cents: snapshot.sales_price_cents === null ? null : snapshot.sales_price_cents.toString(), appraised_value_cents: snapshot.appraised_value_cents.toString(), loan_amount_cents: snapshot.loan_amount_cents.toString(), qualifying_income_cents: snapshot.qualifying_income_cents.toString(), total_obligations_cents: snapshot.total_obligations_cents.toString() });
/** The asset verification reports on the request (32.18 rule 3 / B3-2-02): every `verifications{kind=assets}` row. */
const assetReportRefs = (rt: ToolRuntime, application_id: string): { supplier_type: string; identifier: string; report_type: string }[] =>
  rt.store.list("verifications", (d) => d["application_id"] === application_id && d["kind"] === "assets").map((r) => r.data as P).map((v) => ({ supplier_type: String(v["supplier_code"] ?? "plaid").toLowerCase(), identifier: String(v["report_reference_id"]), report_type: `asset_verification_${String(v["report_days"] ?? 365)}d` }));
const intakeTransaction = (rt: ToolRuntime, application_id: string): string => String(((rt.store.get("applications", application_id)?.data ?? {}) as P)["transaction_type"] ?? "limited_cash_out");

export const TOOLS_32_18: readonly ToolDef[] = defineTools(PROCESS_32_18, BORROWER_APP, [
  { name: "underwriting.run", kind: "act", handler: compute(async (i, ctx: CommandContext, rt) => {
    need(i, "application_id"); const application_id = str(i, "application_id");
    const existing = rt.store.list("du_casefiles", (d) => d["application_id"] === application_id).map((r) => r.data as unknown as DuCasefile).filter((c) => c.status !== "superseded" && c.status !== "archived");
    if (existing.length) {
      if (i["reassemble"] !== true) return { ran: false, reason: "casefile_exists", casefile_id: existing[0]!.casefile_id };
      // 32.18 rule 7: a gap card resolved on an application that already has a casefile — the assembly re-runs over the graph as it now stands (23.6's build
      // and 23.7's preflight on the same emission: a further du.document.emitted with its own required_missing, the gaps that remain re-sent by the flow),
      // and the resubmission itself stays 23.1's (rule 6 / evaluateResubmission): nothing is transmitted here
      const casefile = existing[0]!;
      const { snapshot } = await uladSnapshotOf(rt, application_id);
      const built = await delegate(rt, ctx, "23.1", "buildDuRequest", { application_id, casefile_id: casefile.casefile_id, casefile, submission_type: "credit_and_underwriting", reason: "data_change", snapshot: snapshotWire(snapshot), validation_report_refs: assetReportRefs(rt, application_id) }) as P;
      return { ran: false, reason: "reassembled", reassembled: true, casefile_id: casefile.casefile_id, du_document_id: built["du_document_id"], request_hash: built["request_hash"], required_missing: built["required_missing"], preflight: built["preflight"] };
    }
    const reports = rt.store.list("credit_reports", (d) => d["application_id"] === application_id && d["state"] === "usable").map((r) => r.data as P);
    if (!reports.length) throw new DuSnapshotIncomplete(["credit_report"]);
    const { snapshot, sources } = await uladSnapshotOf(rt, application_id);
    const score_model = String(reports[reports.length - 1]!["score_model"] ?? "classic_fico");
    // the casefile (23.1 R1: a constructor, not a bus tool — the fixtures do the same); its events ride on this command's own store
    const created = createCasefile(ctx.events, { application_id, ...DU_PARTNER, score_model: score_model as DuCasefile["score_model"], created_at: ctx.now }, ctx.actor);
    rt.store.put("du_casefiles", created.casefile.casefile_id, created.casefile as unknown as Record<string, unknown>, ctx.actor, ctx.now);
    // every borrower's report — the newest usable report that names the borrower
    const named = snapshot.borrowers.map((b) => reports.filter((r) => (r["borrower_ids"] as string[] | undefined)?.includes(b.borrower_id)).at(-1)).filter((r): r is P => !!r);
    const uniq = [...new Map(named.map((r) => [String(r["report_id"]), r])).values()];
    const assoc = await delegate(rt, ctx, "23.1", "associateCredit", { application_id, casefile: created.casefile, reports: uniq, borrowers: snapshot.borrowers, app_score_model: score_model }) as P;
    const casefile = assoc["casefile"] as DuCasefile;
    // the asset verification reports on the request (32.18 rule 3 / B3-2-02)
    const validation_report_refs = assetReportRefs(rt, application_id);
    const built = await delegate(rt, ctx, "23.1", "buildDuRequest", { application_id, casefile_id: casefile.casefile_id, casefile, submission_type: "credit_and_underwriting", reason: "initial", snapshot: snapshotWire(snapshot), validation_report_refs }) as P;
    // SCIF presented (21.1 gate): the profile card's resolution, else the application's receipt
    const db = dbOf(rt);
    const profile = (await db.query<{ at: string | null }>(`SELECT to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM card_instances WHERE subject_application_id = $1 AND kind = 'ProfileCard' AND status = 'resolved' ORDER BY resolved_at DESC LIMIT 1`, [application_id]))[0]?.at;
    const received = ctx.events.ofType("application.received").filter((e) => e.applicationId === application_id || (e.payload as P)["application_id"] === application_id).at(-1)?.occurredAt ?? ctx.now;
    const scif_facts = { borrowers: snapshot.borrowers.map((b) => ({ id: b.borrower_id, scif_presented_at: profile ?? received })) };
    const submitted = await delegate(rt, ctx, "23.1", "submitCasefile", { application_id, casefile_id: casefile.casefile_id, casefile, request: built["request"], projected_note_date: null, scif_facts, agent_run_id: ctx.run?.runId ?? null }) as P;
    const submission = submitted["submission"] as P;
    const findings = await delegate(rt, ctx, "23.1", "fetchFindings", { application_id, casefile_id: casefile.casefile_id, casefile: submitted["casefile"], submission_number: submission["submission_number"] }) as P;
    const sub = findings["submission"] as P;
    // 23.2's interpretation: the conditions, the relief on the validated components, the offer and the MI requirement to their owners — its application facts from the snapshot
    const ltv_x100 = Number((snapshot.loan_amount_cents * 10000n) / snapshot.appraised_value_cents);
    const closing = new Date(Date.parse(ctx.now) + 45 * 86_400_000).toISOString().slice(0, 10);
    const facts = { transaction_type: String(intakeTransaction(rt, application_id)), product: "standard", term_months: snapshot.loan_term, ltv_x100, loan_amount_cents: snapshot.loan_amount_cents.toString(), units: 1, county_limit_cents: null, score_model, borrower_ids: snapshot.borrowers.map((b) => b.borrower_id), all_occupying_first_time: false, all_borrowers_first_time: false, du_no_tradelines: uniq.every((r) => !Array.isArray(r["tradelines"]) || (r["tradelines"] as unknown[]).length === 0), closing_date: closing };
    const interp = await delegate(rt, ctx, "23.2", "parseFindings", { application_id, op: "interpret", facts, submission_id: sub["submission_id"], submission_number: sub["submission_number"], recommendation: sub["recommendation"], messages: sub["messages"], validation_results: sub["validation_results"] ?? [], value_acceptance_offer: sub["value_acceptance_offer"] ?? null, mi_requirement: sub["mi_requirement"] ?? null, du_release: String(sub["du_release_applied"] ?? sub["du_release"] ?? "").replace(/_/g, "-") || undefined, /* 23.1 stamps the release 2026_09_25; the 23.2 catalog is keyed 2026-09-25 */ policy_generation: casefile.policy_generation, request_hash: built["request_hash"], findings_received_at: sub["findings_received_at"] ?? ctx.now }) as P;
    return { ran: true, casefile_id: casefile.casefile_id, submission_id: sub["submission_id"], submission_number: sub["submission_number"], recommendation: sub["recommendation"], request_hash: built["request_hash"], validation_results: sub["validation_results"] ?? [], validation_report_refs, conditions: interp["conditions"], interpretation_id: (interp["interpretation"] as P | undefined)?.["interpretation_id"] ?? null, snapshot: { loan_purpose: snapshot.loan_purpose, product: snapshot.product, loan_term: snapshot.loan_term, note_rate_pct: snapshot.note_rate_pct, ...sources } };
  }) },
]);
