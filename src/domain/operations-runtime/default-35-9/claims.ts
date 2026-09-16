/**
 * §35.9 rule 9 — "Claims open on the milestone, package on the clock, file through the sections." `claims.sweep{loan_id}` reads
 * the loan's timeline for a liquidation or completion milestone with no candidate of a kind, runs 15.2's `sweepClaimCandidates`
 * (its `claim.milestone.reached` arms the E-5-01 / F-1-06 clocks) and, MI-insured, 15.3's `routeMiClaim` (its `mi_claims.opened`
 * / `.routed` arm the master-policy and direct-file clocks), opens `claim_candidates{opened}` with `legal_due_on` read from those
 * 15.x clocks (the earliest armed instance of the kind's codes; the 15.x event's own deadline when a row is not armable) and
 * `package_due_on` = opened + 5 servicer business days, and emits `case.claim.candidate_opened` (SM_CLAIM_PACKAGE_5BD).
 * `claims.package{candidate_id}` runs 15.3's `computeShadowClaim` + `assembleMiPackage` or 15.2's `assembleClaim` (one line per
 * `advances` row, forwarded verbatim; the unearned hazard credit is 15.2's `unearnedPremiumCredit`) + `buildBulkPackage`, stores
 * the package through the documents port (`fnma_reporting_7y`) and emits `case.claim.package_built` (satisfies the clock).
 * Every figure is the 15.x tool's; this process asserts them, it does not compute them.
 */
import type { CommandContext } from "../../../app/commands.ts";
import type { ToolInput, ToolRuntime } from "../../../app/tools.ts";
import { addBusinessDays, servicer } from "../../../kernel/calendar/business.ts";
import { addDays, plainDate as D, type PlainDate } from "../../../kernel/calendar/date.ts";
import { unearnedPremiumCredit } from "../../reo/claims.ts";
import { ENGINE_ACTOR, EV, STEP_AGENTS } from "../default-35-9.ts";
import { asOfOf, need, portsFor, q, s } from "./commands.ts";
import { delegate } from "./delegate.ts";
import { caseUuid, loanRows, openForeclosure, str, type CurrentRow, type Row } from "./store.ts";
import { timelineOf } from "./timeline.ts";

export type ClaimKind = "expense_571" | "mi_claim" | "delinquency_advance_4828";
/** The 15.x clocks a candidate's `legal_due_on` is read from, per kind (rule 9; the earliest governs). */
export const LEGAL_CLOCKS: Readonly<Record<ClaimKind, readonly string[]>> = {
  mi_claim: ["MI_MP_CLAIM_FILE_60", "FNMA_F106_MI_DIRECT_FILE_30", "FNMA_F106_MICP_DOCS_10BD"],
  expense_571: ["FNMA_F106_MI_EXPENSE_FINAL_30", "FNMA_E501_EXPENSE_FINAL_60"],
  delinquency_advance_4828: [],
};
/** The timeline events that are liquidation / completion milestones, as 15.2's `milestoneReached` spells the producing event. */
const MILESTONE_OF_EVENT: Readonly<Record<string, { event_type: string; kind: string; liquidation_type: string | null }>> = {
  "foreclosure.sale.held": { event_type: "foreclosure.sale.held", kind: "foreclosure_sale", liquidation_type: "fcl_fnma" },
  "foreclosure.sale.completed": { event_type: "foreclosure.sale.held", kind: "foreclosure_sale", liquidation_type: "fcl_fnma" },
  "workout_plan.completed": { event_type: "lossmit.modification.completed", kind: "workout_completed", liquidation_type: null },
  "reo.disposed_by_fnma": { event_type: "reo.disposed_by_fnma", kind: "reo_disposition", liquidation_type: null },
  "mortgage_release.completed": { event_type: "mortgage_release.completed", kind: "mortgage_release", liquidation_type: "mortgage_release" },
};
export type CandidateRow = { readonly id: string; readonly loan_id: string; readonly case_id: string | null; readonly claim_kind: ClaimKind; readonly milestone_event_id: string; readonly milestone_kind: string; readonly milestone_date: string; readonly legal_due_on: string | null; readonly package_due_on: string; readonly status: string; readonly claim_id: string | null; readonly package_document_id: string | null; readonly opened_at: string };
const SEL = `id::text AS id, loan_id::text AS loan_id, case_id::text AS case_id, claim_kind, milestone_event_id::text AS milestone_event_id, milestone_kind, milestone_date::text AS milestone_date, legal_due_on::text AS legal_due_on, package_due_on::text AS package_due_on, status, claim_id, package_document_id::text AS package_document_id, opened_at::text AS opened_at`;
export const candidatesOf = (ctx: CommandContext, loanId: string): Promise<CandidateRow[]> => q(ctx).query<CandidateRow>(`SELECT ${SEL} FROM claim_candidates WHERE loan_id = $1::uuid ORDER BY opened_at, id`, [loanId]);

const loanFacts = (rt: ToolRuntime, loanId: string): Row => rt.store.get("loans", loanId)?.data ?? {};
const miPolicy = (rt: ToolRuntime, loanId: string): CurrentRow | null => rt.store.list("mi_policies", (d) => d["loan_id"] === loanId && (d["status"] === undefined || d["status"] === "active"))[0] ?? null;
/** The package bodies carry 15.x's figures as strings of cents (Data model: "figures as strings of cents, never document bytes"). */
const toJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const cents = (v: unknown): bigint => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const asDate = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? D(v.slice(0, 10)) : null);
/** The earliest armed instance's due date among the kind's 15.x codes (rule 9: "read from that row's timers instance — never computed here"). */
const legalDueFromClocks = (ctx: CommandContext, kind: ClaimKind): { on: PlainDate | null; code: string | null } => {
  let best: { on: PlainDate; code: string } | null = null;
  for (const code of LEGAL_CLOCKS[kind]) for (const t of ctx.timers.byCode(code)) {
    if (t.status !== "armed") continue;
    const on = t.dueDate ?? (t.dueAt !== undefined ? D(new Date(t.dueAt).toISOString().slice(0, 10)) : null);
    if (on && (!best || on < best.on)) best = { on, code };
  }
  return best ?? { on: null, code: null };
};

/** `claims.sweep{loan_id}` — rule 9's first sentence. */
export async function claimsSweep(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  const loanId = s(i, "loan_id") || ctx.loanId; need({ loan_id: loanId }, "loan_id");
  const asOf = asOfOf(ctx, i);
  const rows = await timelineOf(q(ctx), loanId);
  const existing = await candidatesOf(ctx, loanId);
  const opened: Row[] = [];
  const policy = miPolicy(rt, loanId);
  for (const r of rows) {
    const m = MILESTONE_OF_EVENT[r.event_type]; if (!m) continue;
    const milestoneDate = asDate(r.detail["sale_on"]) ?? asDate(r.detail["held_on"]) ?? asDate(r.detail["occurred_on"]) ?? asDate(r.detail["completed_on"]) ?? D(r.occurred_on);
    const kinds: ClaimKind[] = ["expense_571", ...(policy ? ["mi_claim" as ClaimKind] : [])];
    for (const kind of kinds) {
      if (existing.some((c) => c.milestone_event_id === r.event_id && c.claim_kind === kind)) continue;
      let claimId: string | null = null; let fallbackDue: PlainDate | null = null;
      if (kind === "expense_571") {
        const out = await delegate(rt, ctx, "15.2", "sweepClaimCandidates", { loan_id: loanId, milestones: [{ event_type: m.event_type, loan_id: loanId, milestone_date: milestoneDate, mi_insured: policy !== null, legal_date: milestoneDate }] }, { kind: "agent", id: STEP_AGENTS.claims });
        const reached = ((out.output as Row)["milestones"] as Row[] | undefined)?.[0];
        fallbackDue = asDate(reached?.["expense_final_due_at"]) ?? (policy ? addDays(milestoneDate, 30) : addDays(milestoneDate, 60));
      } else {
        const out = await delegate(rt, ctx, "15.3", "routeMiClaim", { loan_id: loanId, insurer_code: str(policy!.data, "insurer_code") || "FAKE-MI", liquidation_type: m.liquidation_type ?? "fcl_fnma", liquidation_date: milestoneDate, claim_anchor_date: milestoneDate, micp_participant: policy!.data["micp_participant"] === true }, { kind: "agent", id: STEP_AGENTS.claims });
        const routed = out.output as Row; claimId = `mic-${loanId}`;
        fallbackDue = asDate(routed["direct_file_due_at"]) ?? asDate(routed["micp_docs_due_at"]) ?? asDate(routed["claim_filing_deadline"]);
      }
      const clock = legalDueFromClocks(ctx, kind);
      const legalDue = clock.on ?? fallbackDue;
      const packageDue = addBusinessDays(asOf, 5, servicer);
      const fc = openForeclosure(await loanRows(q(ctx), "foreclosure_cases", loanId));
      const ins = await q(ctx).query<CandidateRow>(
        `INSERT INTO claim_candidates (loan_id, case_id, claim_kind, milestone_event_id, milestone_kind, milestone_date, legal_due_on, package_due_on, status, claim_id, opened_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::date, $7::date, $8::date, 'opened', $9, $10::timestamptz, $10::timestamptz, $10::timestamptz) ON CONFLICT (loan_id, claim_kind, milestone_event_id) DO NOTHING RETURNING ${SEL}`,
        [loanId, r.case_id ?? (fc ? caseUuid(fc.id) : null), kind, r.event_id, m.kind, milestoneDate, legalDue, packageDue, claimId, ctx.now]);
      const c = ins[0]; if (!c) continue;
      ctx.events.append({ type: EV.claimCandidateOpened, loanId, actor: ctx.actor, payload: { candidate_id: c.id, loan_id: loanId, claim_kind: kind, milestone_kind: m.kind, milestone_date: milestoneDate, legal_due_on: legalDue, legal_due_source: clock.code ?? "15.x event", package_due_on: packageDue, opened_at: ctx.now, claim_id: claimId } });
      opened.push({ candidate_id: c.id, claim_kind: kind, legal_due_on: legalDue, legal_due_source: clock.code, package_due_on: packageDue });
    }
  }
  return { loan_id: loanId, as_of_date: asOf, opened, candidates: existing.length + opened.length };
}

const LINE_KIND: Readonly<Record<string, string>> = { taxes: "taxes", hazard_premium: "hazard", hazard: "hazard", flood_premium: "flood", mi_premium: "mi_premium", inspection: "inspection", preservation: "preservation", attorney_fee: "attorney_fee", attorney_cost: "attorney_cost", technology_fee: "technology", technology: "technology", einvoice: "einvoice", hoa: "hoa" };
const MI_ADVANCE_KIND: Readonly<Record<string, string>> = { taxes: "taxes", hazard_premium: "hazard_premium", hazard: "hazard_premium", flood_premium: "flood_premium", inspection: "inspection", preservation: "preservation", attorney_fee: "attorney_fee", attorney_cost: "attorney_cost", eviction_cost: "eviction_cost", mi_premium: "mi_premium", technology_fee: "technology_fee", technology: "technology_fee", einvoice: "technology_fee", hoa: "hoa" };

/** `claims.package{candidate_id}` — rule 9's second sentence. */
export async function claimsPackage(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  need(i, "candidate_id");
  const c = (await q(ctx).query<CandidateRow>(`SELECT ${SEL} FROM claim_candidates WHERE id = $1::uuid`, [s(i, "candidate_id")]))[0];
  if (!c) throw new RangeError(`no claim candidate ${s(i, "candidate_id")}`);
  if (!["opened", "package_building"].includes(c.status)) return { candidate_id: c.id, status: c.status, already: true };
  const loanId = c.loan_id; const ports = portsFor(rt);
  await q(ctx).query(`UPDATE claim_candidates SET status = 'package_building', updated_at = $2::timestamptz WHERE id = $1::uuid`, [c.id, ctx.now]);
  const loan = loanFacts(rt, loanId); const fc = rt.store.list("foreclosure_cases", (d) => d["loan_id"] === loanId)[0] ?? null;
  const state = (str(loan, "state") || str(fc?.data ?? {}, "jurisdiction_state") || "TX").toUpperCase();
  const milestoneDate = D(c.milestone_date);
  const advances = rt.store.list("advances", (d) => d["loan_id"] === loanId);
  let claimId = c.claim_id; let figures: Row = {}; let packageBody: Row = {};
  if (c.claim_kind === "mi_claim") {
    const policy = miPolicy(rt, loanId); if (!policy) throw new RangeError("no MI policy on the loan");
    claimId = claimId ?? `mic-${loanId}`;
    const adv = advances.filter((a) => MI_ADVANCE_KIND[str(a.data, "kind")]).map((a) => ({ advance_id: a.id, kind: MI_ADVANCE_KIND[str(a.data, "kind")]!, amount_cents: cents(a.data["amount_cents"]) }));
    const shadow = (await delegate(rt, ctx, "15.3", "computeShadowClaim", { claim_id: claimId, upb_cents: cents(loan["upb_cents"] ?? loan["current_upb_cents"]), note_rate_pct: str(loan, "note_rate_pct"), interest_paid_to: str(loan, "interest_paid_to"), anchor: milestoneDate, coverage_pct: String(policy.data["coverage_pct"] ?? "30"), advances: adv, as_of: ctx.now.slice(0, 10), derived_by: "35.9 claims.package from loans / mi_policies / advances" }, { kind: "agent", id: STEP_AGENTS.claims })).output as Row;
    figures = { claim_amount_cents: String(shadow["claim_amount_cents"] ?? ""), benefit_cents: String(shadow["benefit_cents"] ?? ""), interest_cents: String(shadow["interest_cents"] ?? ""), calculation_id: `${claimId}-v${String(shadow["version"] ?? 1)}` };
    packageBody = { claim_id: claimId, kind: "mi_claim", route: "servicer_direct", liquidation_type: "fcl_fnma", milestone_date: milestoneDate, shadow: figures, advances: adv.map((a) => ({ ...a, amount_cents: a.amount_cents.toString() })) };
    const stored = await ports.documents.store(q(ctx), { loan_id: loanId, kind: "mi_claim_package", body: toJson(packageBody), mime_type: "application/json", retention_class: "fnma_reporting_7y", metadata: { candidate_id: c.id, claim_id: claimId }, now: ctx.now });
    const { mandatoryDocumentKinds } = await import("../../reo/ops-15-3.ts");
    const docs = mandatoryDocumentKinds("fcl_fnma", "servicer_direct").map((k) => ({ id: stored.document_id, doc_kind: k, sha256: stored.sha256 }));
    await delegate(rt, ctx, "15.3", "assembleMiPackage", { claim_id: claimId, loan_id: loanId, liquidation_type: "fcl_fnma", route: "servicer_direct", documents: docs }, { kind: "agent", id: STEP_AGENTS.claims });
    return finish(ctx, c, claimId, stored, { claim_amount_cents: figures["claim_amount_cents"], benefit_cents: figures["benefit_cents"] });
  }
  if (c.claim_kind === "expense_571") {
    const policy = miPolicy(rt, loanId);
    const lines = advances.filter((a) => LINE_KIND[str(a.data, "kind")]).map((a) => {
      const d = a.data; const kind = LINE_KIND[str(d, "kind")]!; const quantity = Number(d["quantity"] ?? 1); const unit = d["unit_price_cents"] !== undefined ? cents(d["unit_price_cents"]) : cents(d["amount_cents"]) / BigInt(quantity);
      return { advance_id: a.id, kind, unit_cents: unit, quantity, paid_on: asDate(d["paid_at"]), invoice: Boolean(d["invoice_document_id"]), ...(kind === "inspection" ? { inspection_type: str(d, "inspection_type") || "exterior", f105_inspection_type: str(d, "inspection_type") || "exterior" } : {}),
        ...(kind === "preservation" ? { preservation_code: str(d, "preservation_code") || "winterization", hometracker_bid_id: str(d, "hometracker_bid_id") || null } : {}), ...(kind === "einvoice" ? { einvoice_kind: "fcl" } : {}), ...(kind === "mi_premium" ? { service_start: asDate(d["service_start"]), service_end: asDate(d["service_end"]) } : {}), evidence_ids: d["invoice_document_id"] ? [String(d["invoice_document_id"])] : [] };
    });
    // the unearned hazard credit is 15.2's own function (claims.ts unearnedPremiumCredit) over the hazard advance's term; this process forwards the figure it returns
    const hazard = advances.find((a) => ["hazard_premium", "hazard"].includes(str(a.data, "kind")) && a.data["term_start"] && a.data["term_end"]);
    // 15.2's `unearnedPremiumCredit` earns the day it is given and counts the unearned term from the next day; the liquidation date itself is unearned (F-1-05: coverage from the sale date is refundable — worked example C counts 258 days from 2027-07-06), so the last earned day is the day before the milestone
    const credits = hazard ? [{ kind: "hazard_refund", amount_cents: unearnedPremiumCredit(cents(hazard.data["amount_cents"]), D(String(hazard.data["term_start"])), D(String(hazard.data["term_end"])), addDays(milestoneDate, -1)), received_at: milestoneDate, derived_by: "15.2 unearnedPremiumCredit (last earned day = the day before the liquidation)" }] : [];
    const track = str(fc?.data ?? {}, "method") === "non_judicial" ? "non_judicial" : str(fc?.data ?? {}, "method") === "judicial" ? "judicial" : "non_judicial";
    const defaultDate = asDate(loan["earliest_unpaid_due"]) ?? asDate(loan["interest_paid_to"]);
    const assembled = (await delegate(rt, ctx, "15.2", "assembleClaim", { loan_id: loanId, claim_id: claimId ?? undefined, claim_type: "571", milestone_kind: c.milestone_kind, milestone_date: milestoneDate, mi_insured: policy !== null, lines, credits, hazard_refund_expected: credits.length > 0, context: { state, track, event_date: milestoneDate, servicing_option: "special", legal_date: milestoneDate, ...(defaultDate ? { default_date: defaultDate } : {}), acquired_by_fnma: c.milestone_kind === "foreclosure_sale" }, today: ctx.now.slice(0, 10) }, { kind: "agent", id: STEP_AGENTS.claims })).output as Row;
    claimId = String(assembled["claim_id"]);
    figures = { gross_cents: String(assembled["gross"] ?? ""), net_cents: String(assembled["net"] ?? ""), status: assembled["status"], exceptions: assembled["exceptions"] };
    const built = (await delegate(rt, ctx, "15.2", "buildBulkPackage", { claim_id: claimId, op: "build", attachments: [], today: ctx.now.slice(0, 10) }, { kind: "agent", id: STEP_AGENTS.claims })).output as Row;
    packageBody = { claim_id: claimId, kind: "expense_571", milestone_kind: c.milestone_kind, milestone_date: milestoneDate, lines: lines.map((l) => ({ ...l, unit_cents: l.unit_cents.toString(), amount_cents: (l.unit_cents * BigInt(l.quantity)).toString() })), credits: credits.map((x) => ({ ...x, amount_cents: x.amount_cents.toString() })), figures, package: built["package"] ?? null, channel: built["channel"] ?? null };
    const stored = await ports.documents.store(q(ctx), { loan_id: loanId, kind: "expense_claim_package", body: toJson(packageBody), mime_type: "application/json", retention_class: "fnma_reporting_7y", metadata: { candidate_id: c.id, claim_id: claimId }, now: ctx.now });
    return finish(ctx, c, claimId, stored, { gross_cents: figures["gross_cents"], net_cents: figures["net_cents"], channel: built["channel"] ?? null });
  }
  throw new RangeError(`claim kind ${c.claim_kind} is 15.4's IRR package — not built by this process yet`);
}

async function finish(ctx: CommandContext, c: CandidateRow, claimId: string | null, stored: { document_id: string; sha256: string }, figs: Row): Promise<Row> {
  await q(ctx).query(`UPDATE claim_candidates SET status = 'package_built', claim_id = $2, package_document_id = $3::uuid, updated_at = $4::timestamptz WHERE id = $1::uuid`, [c.id, claimId, stored.document_id, ctx.now]);
  ctx.events.append({ type: EV.claimPackageBuilt, loanId: c.loan_id, actor: ctx.actor, payload: { candidate_id: c.id, claim_kind: c.claim_kind, claim_id: claimId, document_id: stored.document_id, sha256: stored.sha256, ...figs } });
  ctx.decide({ agent: STEP_AGENTS.claims, action: `claims.package:${c.claim_kind}`, rationale: `candidate ${c.id} (${c.milestone_kind} ${c.milestone_date}) packaged: claim ${claimId}, document ${stored.document_id} sha256 ${stored.sha256.slice(0, 12)}…; figures are 15.x's`, ruleSetVersion: "default-ops.v1", loanId: c.loan_id, subject: { kind: "candidate", id: c.id }, confidence: 1, modelVersion: "deterministic", promptVersion: "35.9-v1" });
  return { candidate_id: c.id, claim_id: claimId, document_id: stored.document_id, sha256: stored.sha256, ...figs };
}

/** rule 2 step (f): the claims sweep and the packages of the loan's open candidates (the daily unit; `claims_sweep_daily`). */
export async function claimsStep(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, asOf: string): Promise<Row> {
  const loanId = s(i, "loan_id") || ctx.loanId;
  const swept = await claimsSweep({ loan_id: loanId, as_of_date: asOf }, ctx, rt);
  const packaged: string[] = [];
  for (const c of await candidatesOf(ctx, loanId)) if (c.status === "opened") { await claimsPackage({ candidate_id: c.id }, ctx, rt); packaged.push(c.id); }
  return { opened: (swept["opened"] as Row[]).length, packaged };
}
export const claimsActor = ENGINE_ACTOR;
