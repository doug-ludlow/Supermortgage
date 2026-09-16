/**
 * §35.8 derivers (rule 2: "The person supplies a decision; the deriver supplies the state") — one exported function per
 * screen action, pure over the rows it reads through the command's transaction-bound view (35.1 rule 7), versioned by the
 * catalogue (screens.ts `deriver_version`). Each returns the exact input the owning section's tool receives (decision
 * fields plus derived fields) and the `sources` it read — sequence numbers, ledger ids and record versions, never row
 * contents — which work-35-8/act.ts hashes (rule 3) and stores through 35.2 as `work-derivation.json`.
 *
 *   payment_post.post / payment_reverse.reverse   2.x's LoanCashState and custodial ids as the runtime derives them from
 *                                                  loan_terms, loans, the ledger and the payment rows (src/runtime/servicing.ts
 *                                                  loanCashState — the same function the daily sweep uses; behind 35.5 once
 *                                                  `installments.read` lands), the payment the person chose from the projection.
 *   payoff_quote.quote                             16.1's components from the ledger (UPB, LPI, late charges, escrow balance) and
 *                                                  loan_terms (rate); the release recording fee from the state table
 *                                                  (RELEASE_RECORDING_FEE_CENTS — 16.1 marks the county amount [UNVERIFIED]).
 *   funding_release.release                        26.3's funding, wire and worksheet records; 26.3 `evaluateFundingConditions`
 *                                                  run here over the record's facts (the `funding_facts` record 26.x keeps) —
 *                                                  GATE_CLOSED{codes} before any release.
 *   conditions.clear / reopen / ctc                23.3's condition rows and their evidence documents; `evaluateClearance` and
 *                                                  `runCtcChecklist` run here from the record (never asserted by the person).
 *   lossmit_decision.decide / review / notify      12.2's evaluation record; the determinations from the person's disposition.
 *   bankruptcy_case.*                              14.1's case record (ledgers, plan, claim); the trustee cheque amount is the
 *                                                  one figure the person is the source of.
 * The remaining screens (le_review, cd_review, closing_schedule, escrow_analysis, foreclosure_case) derive their inputs from
 * the same records the owning tools keep; their tools' own validators decide.
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { EntityStore } from "../../app/tools.ts";
import type { Runtime } from "../../runtime/app.ts";
import { loanCashState, recipientsOf, servicingParties } from "../../runtime/servicing.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { evaluateFundingConditions, type ConditionFacts } from "../closing/ops-26-3.ts";
import { evaluateClearance, runCtcChecklist, CTC_ITEM_CODES, type CtcFacts, type EvidenceDoc, type ClearanceContext } from "../underwriting/ops-23-3.ts";
import type { Condition } from "../underwriting/ops-23-2.ts";
import type { WorkPorts } from "./work-35-8/ports.ts";
import { WorkRefused, obj, s, type Row, type Subject } from "./work-35-8/types.ts";

export interface DeriveContext { readonly rt: Runtime; readonly store: EntityStore; readonly q: Queryable; readonly now: string; readonly actor: Actor; readonly subject: Subject; readonly decision: Row; readonly ports: Required<WorkPorts>; readonly environment: string }
export interface Derived { readonly input: Row; readonly sources: Row }
export type Deriver = (c: DeriveContext) => Promise<Derived>;

const today = (iso: string): PlainDate => wallClock(Date.parse(iso), "America/New_York").date;
const str = (r: Row, k: string): string => s(r[k]);
const cs = (v: unknown): string => (typeof v === "bigint" ? v.toString() : s(v));

/** The sources every loan derivation names (rule 3): the log's high-water mark, the ledger's, 35.5's version, 35.1's snapshot, the record versions read. */
export async function loanSources(c: DeriveContext, loanId: string, kinds: readonly string[] = ["payments", "fees", "loan_terms"]): Promise<Row> {
  const [ev] = await c.q.query<{ seq: string | null }>(`SELECT max(sequence)::text AS seq FROM loan_events WHERE loan_id = $1`, [loanId]);
  const [ll] = await c.q.query<{ id: string | null }>(`SELECT id::text AS id FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [loanId]);
  const inst = await c.ports.installments.version(c.q, loanId);
  const [snap] = await c.q.query<{ id: string | null }>(`SELECT id::text AS id FROM service_snapshots WHERE loan_id = $1 ORDER BY created_at DESC LIMIT 1`, [loanId]).catch(() => [{ id: null }]);
  const records = await c.q.query<{ kind: string; id: string; version: string }>(`SELECT kind, id, max(version)::text AS version FROM entity_records WHERE loan_id = $1 AND kind = ANY($2::text[]) GROUP BY kind, id ORDER BY kind, id`, [loanId, [...kinds]]).catch(() => [] as { kind: string; id: string; version: string }[]);
  return { loan_events: { through_sequence: ev?.seq === null || ev?.seq === undefined ? 0 : Number(ev.seq) }, ledger_lines: { max_id: ll?.id ?? null }, loan_installments: { version: inst.version, rows: inst.rows, source: inst.source }, service_snapshots: { id: snap?.id ?? null }, entity_records: records.map((r) => ({ kind: r.kind, id: r.id, version: Number(r.version) })) };
}
export async function applicationSources(c: DeriveContext, applicationId: string, kinds: readonly string[]): Promise<Row> {
  const [ev] = await c.q.query<{ seq: string | null }>(`SELECT max(sequence)::text AS seq FROM loan_events WHERE application_id = $1`, [applicationId]);
  const records = await c.q.query<{ kind: string; id: string; version: string }>(`SELECT kind, id, max(version)::text AS version FROM entity_records WHERE application_id = $1 AND kind = ANY($2::text[]) GROUP BY kind, id ORDER BY kind, id`, [applicationId, [...kinds]]).catch(() => [] as { kind: string; id: string; version: string }[]);
  return { loan_events: { through_sequence: ev?.seq === null || ev?.seq === undefined ? 0 : Number(ev.seq) }, entity_records: records.map((r) => ({ kind: r.kind, id: r.id, version: Number(r.version) })) };
}
const loanOf = (c: DeriveContext): string => { if (c.subject.kind !== "loan") throw new WorkRefused(400, "SUBJECT_KIND", "this screen acts on a loan", { subject: c.subject }); return c.subject.id; };
const appOf = (c: DeriveContext): string => { if (c.subject.kind !== "application") throw new WorkRefused(400, "SUBJECT_KIND", "this screen acts on an application", { subject: c.subject }); return c.subject.id; };
const rec = (c: DeriveContext, kind: string, id: string): Row => { const r = c.store.get(kind, id); if (!r) throw new WorkRefused(404, "NOT_FOUND", `no ${kind} ${id} on this subject`, { kind, id }); return r.data; };

// ---------------------------------------------------------------- 2.1 (worked examples A and B)
export const derivePaymentPost: Deriver = async (c) => {
  const loanId = loanOf(c); const facts = await loanCashState(c.rt, loanId, today(c.now));
  if (!facts.custodial) throw new WorkRefused(409, "NO_CUSTODIAL_ACCOUNTS", "the partner has no clearing / P&I / T&I custodial accounts", { loan_id: loanId });
  const pid = str(c.decision, "payment_id");
  const pay = facts.received_payments.find((p) => String(p["payment_id"] ?? "") === pid);
  if (!pay) throw new WorkRefused(404, "NOT_FOUND", `no received payment ${pid} on this loan`, { payment_id: pid });
  const input: Row = { op: "post", id: pid, loan_id: loanId, state: facts.state, custodial: facts.custodial, days_delinquent: 0, ...(str(c.decision, "credited_as_of") ? { credited_as_of: str(c.decision, "credited_as_of") } : {}), ...(str(c.decision, "designation_override") ? { designation_override: str(c.decision, "designation_override"), reason: str(c.decision, "reason") } : {}) };
  return { input, sources: await loanSources(c, loanId) };
};
export const derivePaymentReverse: Deriver = async (c) => {
  const loanId = loanOf(c); const facts = await loanCashState(c.rt, loanId, today(c.now));
  if (!facts.custodial) throw new WorkRefused(409, "NO_CUSTODIAL_ACCOUNTS", "the partner has no clearing / P&I / T&I custodial accounts", { loan_id: loanId });
  const pid = str(c.decision, "payment_id");
  const pay = facts.store.get("payments", pid)?.data; if (!pay || pay["loan_id"] !== loanId) throw new WorkRefused(404, "NOT_FOUND", `no payment ${pid} on this loan`, { payment_id: pid });
  if (pay["status"] !== "posted") throw new WorkRefused(409, "NOT_POSTED", `payment ${pid} is ${s(pay["status"])}, not posted`, { payment_id: pid, status: s(pay["status"]) });
  const input: Row = { op: "reverse", id: pid, loan_id: loanId, state: facts.state, custodial: facts.custodial, reason: str(c.decision, "reason"), return_code: str(c.decision, "return_code") || null, nsf_fee: c.decision["nsf_fee"] === true,
    allocation: pay["allocation"] ?? null, ledger_entry_set_ids: pay["ledger_entry_set_ids"] ?? [] };
  return { input, sources: await loanSources(c, loanId) };
};

// ---------------------------------------------------------------- 16.1 (worked example C)
/** The county release recording fee by property state: the `jurisdiction_rules` record keyed by the state (`data.payoff.release_recording_fee_cents`, 16.x's data) when one is on the record, else this default (16.1 worked example A: Ohio **$34.00**, marked [UNVERIFIED] there). */
export const RELEASE_RECORDING_FEE_CENTS: Readonly<Record<string, bigint>> = { OH: 3_400n, TX: 2_600n, CA: 2_000n, FL: 1_850n, NY: 6_200n, NC: 2_600n, MA: 7_500n, AZ: 3_000n };
export function releaseRecordingFeeCents(store: EntityStore, state: string): { cents: bigint; source: string } {
  const rules = store.get("jurisdiction_rules", state)?.data ?? store.list("jurisdiction_rules", (d) => d["state"] === state).at(-1)?.data;
  const v = (rules?.["payoff"] as Row | undefined)?.["release_recording_fee_cents"];
  if (v !== undefined && v !== null && /^-?\d+$/.test(String(v))) return { cents: BigInt(String(v)), source: `jurisdiction_rules:${state}` };
  return { cents: RELEASE_RECORDING_FEE_CENTS[state] ?? 0n, source: "default:16.1-A" };
}
export const derivePayoffQuote: Deriver = async (c) => {
  const loanId = loanOf(c); const facts = await loanCashState(c.rt, loanId, today(c.now));
  const [prop] = await c.q.query<{ state: string | null }>(`SELECT pr.state FROM loans l JOIN properties pr ON pr.id = l.property_id WHERE l.id = $1`, [loanId]);
  const state = prop?.state ?? "OH";
  const lpi = facts.state.lpi_date ?? addMonths(facts.loan.first_payment_date, -1);
  const sources = await loanSources(c, loanId, ["payments", "fees", "loan_terms", "jurisdiction_rules"]);
  const maxId = (sources["ledger_lines"] as Row)["max_id"];
  const n = Number((await c.q.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_records WHERE loan_id = $1 AND kind = 'payoff_quotes'`, [loanId]).catch(() => [{ n: "0" }]))[0]?.n ?? 0);
  const delivery = str(c.decision, "delivery");
  const input: Row = { loan_id: loanId, quote_id: `pq-${loanId.slice(0, 8)}-${n + 1}`, request_id: `pr-${loanId.slice(0, 8)}-${n + 1}`, quote_type: "statement", written: true, channel: delivery === "portal" ? "portal" : delivery === "fax" ? "fax" : "mail", received_on: today(c.now),
    requester_type: str(c.decision, "requester_kind"), good_through: str(c.decision, "good_through"), delivery_channel_requested: delivery, state,
    upb_cents: facts.balances.principal, rate_pct: (facts.terms.note_rate_bps / 10_000).toFixed(3), lpi_due: lpi, late_charges_cents: facts.state.late_charges_due_cents, recording_fee_cents: releaseRecordingFeeCents(c.store, state).cents, recording_fee_source: releaseRecordingFeeCents(c.store, state).source,
    escrow_balance_cents: facts.balances.escrow, ledger_snapshot_id: `ledger-lines:${s(maxId ?? "0")}`, ...(facts.terms.escrow_version ? {} : {}) };
  return { input, sources };
};
export const derivePayoffStatement: Deriver = async (c) => {
  const loanId = loanOf(c); const quoteId = str(c.decision, "quote_id"); const q = rec(c, "payoff_quotes", quoteId);
  const wire = c.store.list("wire_instructions", (d) => d["loan_id"] === loanId || d["active"] === true).at(-1);
  const input: Row = { loan_id: loanId, quote_id: quoteId, active_wire_instruction_version_id: wire?.id ?? `wire-instructions:${c.environment}:v1`, delivery: str(c.decision, "delivery"), total_cents: cs(q["total_cents"]), figures: q["figures"] ?? null };
  return { input, sources: await loanSources(c, loanId, ["payoff_quotes", "wire_instructions"]) };
};

// ---------------------------------------------------------------- 26.3 (worked example D)
export const deriveFundingRelease: Deriver = async (c) => {
  const applicationId = appOf(c); const fundingId = str(c.decision, "funding_id"); const wireId = str(c.decision, "wire_id");
  const funding = rec(c, "fundings", fundingId); if (funding["application_id"] !== applicationId) throw new WorkRefused(404, "NOT_FOUND", `funding ${fundingId} is not this application's`, { funding_id: fundingId });
  const wire = rec(c, "funding_wires", wireId); if (wire["funding_id"] !== fundingId) throw new WorkRefused(404, "NOT_FOUND", `wire ${wireId} is not this funding's`, { wire_id: wireId });
  const orchestration = await c.ports.orchestration.forApplication(c.q, applicationId);
  const worksheet = c.store.list("funding_worksheets", (d) => d["funding_id"] === fundingId).at(-1)?.data ?? null;
  const factsRec = c.store.get("funding_facts", fundingId);
  if (!factsRec) throw new WorkRefused(409, "GATE_CLOSED", "no funding condition facts on the record (26.x has not verified the file)", { codes: ["FC_FACTS_MISSING"], funding_id: fundingId });
  const base = factsRec.data as unknown as ConditionFacts;
  const facts: ConditionFacts = { ...base, as_of: c.now, funding: { ...base.funding, authorized: base.funding?.authorized ?? String(funding["status"] ?? "").includes("authorized") }, warehouse_advance_approved: base.warehouse_advance_approved ?? String(funding["warehouse_status"] ?? funding["status"] ?? "").includes("approved"), worksheet: base.worksheet ?? { reconciled: worksheet?.["reconciled"] === true || worksheet?.["reconciled_to_cd"] === true } };
  const conditions = evaluateFundingConditions(fundingId, facts);
  if (!conditions.passed) throw new WorkRefused(409, "GATE_CLOSED", `funding conditions block the release: ${conditions.blocking_codes.join(", ")}`, { codes: [...conditions.blocking_codes], pending: [...conditions.pending_codes], funding_id: fundingId });
  // nothing of the clock in the derived input: the bank reference is the wire's, the release instant is the executing command's `now` (26.3 stamps it), and the checklist is named by its funding and outcome — a proposal re-derived at approval must hash the same when the record has not moved (rule 6)
  const input: Row = { op: "release", funding_id: fundingId, wire_id: wireId, bank_ref: `SM-${wireId}`, amount_cents: cs(wire["amount_cents"]),
    conditions: { passed: conditions.passed, blocking_codes: [...conditions.blocking_codes], pending_codes: [...conditions.pending_codes], item_codes: conditions.items.map((x) => `${x.code}:${x.status}`) }, rescission: base.rescission ?? null, ptf: base.ptf ?? null, cash_to_close: base.cash_to_close ?? null, orchestration_id: orchestration?.orchestration_id ?? null };
  const sources = { ...(await applicationSources(c, applicationId, ["fundings", "funding_wires", "funding_worksheets", "funding_facts", "funding_conditions"])), orchestration_id: orchestration?.orchestration_id ?? null, orchestration_step: orchestration?.step ?? null };
  return { input, sources };
};

// ---------------------------------------------------------------- 23.3
async function evidenceOf(c: DeriveContext, applicationId: string, cond: Condition, chosen: string | null): Promise<EvidenceDoc[]> {
  const rows = await c.q.query<Row>(`SELECT id::text AS id, kind, metadata, created_at::text AS created_at FROM documents WHERE application_id = $1 AND (kind = ANY($2::text[]) OR id::text = $3) ORDER BY created_at`, [applicationId, [...cond.evidence_kinds], chosen ?? ""]);
  return rows.map((r) => { const m = obj(r["metadata"]); return { document_id: String(r["id"]), kind: String(r["kind"]), document_date: typeof m["document_date"] === "string" ? D(m["document_date"]) : null, ...(m["tax_year"] !== undefined ? { tax_year: Number(m["tax_year"]) } : {}), classified_at: typeof m["classified_at"] === "string" ? m["classified_at"] : String(r["created_at"]), ...(typeof m["is_credit_document"] === "boolean" ? { is_credit_document: m["is_credit_document"] } : {}), verification_id: typeof m["verification_id"] === "string" ? m["verification_id"] : null }; });
}
const clearanceContext = (c: DeriveContext, applicationId: string): ClearanceContext => {
  const d = c.store.list("credit_decisions", (x) => x["application_id"] === applicationId).at(-1)?.data ?? {};
  const noteDate = typeof d["note_date"] === "string" ? d["note_date"] : typeof d["projected_note_date"] === "string" ? d["projected_note_date"] : addDays(today(c.now), 30);
  const big = (v: unknown): bigint | undefined => (v === undefined || v === null ? undefined : BigInt(String(v)));
  const du = obj(d["du_used"]); const ver = obj(d["verified"]);
  return { note_date: D(noteDate), du_used: { ...(big(du["qualifying_income_cents"]) !== undefined ? { qualifying_income_cents: big(du["qualifying_income_cents"])! } : {}), ...(big(du["funds_to_verify_cents"]) !== undefined ? { funds_to_verify_cents: big(du["funds_to_verify_cents"])! } : {}), ...(big(du["reserves_required_cents"]) !== undefined ? { reserves_required_cents: big(du["reserves_required_cents"])! } : {}) },
    verified: { ...(big(ver["income_cents"]) !== undefined ? { income_cents: big(ver["income_cents"])! } : {}), ...(big(ver["assets_cents"]) !== undefined ? { assets_cents: big(ver["assets_cents"])! } : {}), ...(big(ver["reserves_cents"]) !== undefined ? { reserves_cents: big(ver["reserves_cents"])! } : {}) } };
};
export const deriveConditionClear: Deriver = async (c) => {
  const applicationId = appOf(c); const condId = str(c.decision, "condition_id");
  const cond = rec(c, "conditions", condId) as unknown as Condition; if (cond.application_id !== applicationId) throw new WorkRefused(404, "NOT_FOUND", `condition ${condId} is not this application's`, { condition_id: condId });
  const evidence = await evidenceOf(c, applicationId, cond, str(c.decision, "evidence_document_id") || null);
  const evaluation = evaluateClearance(cond, evidence, clearanceContext(c, applicationId));
  const input: Row = { op: "clear", application_id: applicationId, condition: cond, condition_id: condId, evaluation, evidence: evidence.map((e) => e.document_id), notes: str(c.decision, "note") || null };
  return { input, sources: { ...(await applicationSources(c, applicationId, ["conditions", "credit_decisions"])), documents: evidence.map((e) => e.document_id) } };
};
export const deriveConditionReopen: Deriver = async (c) => {
  const applicationId = appOf(c); const condId = str(c.decision, "condition_id");
  const cond = rec(c, "conditions", condId) as unknown as Condition; if (cond.application_id !== applicationId) throw new WorkRefused(404, "NOT_FOUND", `condition ${condId} is not this application's`, { condition_id: condId });
  return { input: { application_id: applicationId, condition: cond, condition_id: condId, reason: str(c.decision, "note") }, sources: await applicationSources(c, applicationId, ["conditions"]) };
};
export const deriveCtc: Deriver = async (c) => {
  const applicationId = appOf(c);
  const decision = c.store.list("credit_decisions", (x) => x["application_id"] === applicationId).at(-1);
  if (!decision) throw new WorkRefused(409, "NO_DECISION", "no credit decision on this application (23.3 issueConditionalApproval first)", { application_id: applicationId });
  const conds = c.store.list("conditions", (x) => x["application_id"] === applicationId).map((r) => r.data as unknown as Condition);
  const openPtd = conds.filter((x) => x.stage === "ptd" && x.status !== "cleared" && x.status !== "waived" && x.status !== "superseded");
  const investigations = c.store.list("investigations", (x) => x["application_id"] === applicationId && x["status"] !== "closed");
  const docs = await c.q.query<Row>(`SELECT id::text AS id, metadata FROM documents WHERE application_id = $1 AND metadata ? 'ctc_item' ORDER BY created_at`, [applicationId]);
  const facts: Record<string, { status: "pass" | "fail" | "n/a"; evidence_ref?: string | null }> = {};
  for (const d of docs) { const code = String(obj(d["metadata"])["ctc_item"]); if ((CTC_ITEM_CODES as readonly string[]).includes(code)) facts[code] = { status: "pass", evidence_ref: String(d["id"]) }; }
  facts["CTC_PTD_ALL_CLEARED"] = openPtd.length ? { status: "fail", evidence_ref: null } : { status: "pass", evidence_ref: `conditions:${conds.length}` };
  facts["CTC_NO_OPEN_INVESTIGATION"] = investigations.length ? { status: "fail", evidence_ref: null } : { status: "pass", evidence_ref: "investigations:0" };
  facts["CTC_DECISION_VALID"] = facts["CTC_DECISION_VALID"] ?? (decision.data["status"] === "active" ? { status: "pass", evidence_ref: decision.id } : { status: "fail", evidence_ref: decision.id });
  facts["CTC_REGB_TIMING"] = facts["CTC_REGB_TIMING"] ?? { status: "n/a", evidence_ref: null };
  const checklist = runCtcChecklist({ application_id: applicationId, decision_id: String(decision.data["decision_id"] ?? decision.id), evaluated_at: c.now, facts: facts as CtcFacts, waived_by: c.actor.kind === "human" ? c.actor : null });
  return { input: { application_id: applicationId, decision: decision.data, checklist, facts }, sources: { ...(await applicationSources(c, applicationId, ["conditions", "credit_decisions", "investigations"])), documents: docs.map((d) => String(d["id"])) } };
};

// ---------------------------------------------------------------- 12.2
const evaluationOf = (c: DeriveContext, loanId: string, id: string): { id: string; data: Row } => { const r = id ? c.store.get("lossmit_evaluations", id) : c.store.list("lossmit_evaluations", (d) => d["loan_id"] === loanId).at(-1); if (!r || r.data["loan_id"] !== loanId) throw new WorkRefused(404, "NOT_FOUND", `no loss-mitigation evaluation ${id || "(latest)"} on this loan`, { request_id: id }); return { id: r.id, data: r.data }; };
export const deriveLossmitDecide: Deriver = async (c) => {
  const loanId = loanOf(c); const ev = evaluationOf(c, loanId, str(c.decision, "request_id"));
  const disposition = str(c.decision, "disposition"); const option = str(c.decision, "option_code") || s(ev.data["option"]) || "flex_mod";
  const reasons = Array.isArray(c.decision["denial_reasons"]) ? (c.decision["denial_reasons"] as unknown[]).map(String) : str(c.decision, "denial_reasons") ? [str(c.decision, "denial_reasons")] : [];
  const stored = Array.isArray(ev.data["determinations"]) ? (ev.data["determinations"] as Row[]) : null;
  const determinations: Row[] = disposition === "deny" ? (stored ?? [{ option, result: "denied", reason_codes: reasons }]).map((d) => (d["result"] === "denied" && !Array.isArray(d["reason_codes"]) ? { ...d, reason_codes: reasons } : d)) : disposition === "counter" ? [{ option, result: "offered" }, ...(stored ?? [])] : [{ option, result: "offered" }];
  const input: Row = { op: "draft", id: ev.id, loan_id: loanId, determinations, evaluator_run_owner: s(ev.data["evaluator_run_owner"]) || null, complete_on: s(ev.data["complete_at"] ?? ev.data["complete_on"]) || null, evaluation: { outcome: ev.data["outcome"] ?? null, option: ev.data["option"] ?? null, tier: ev.data["tier"] ?? null, state: ev.data["state"] ?? null } };
  return { input, sources: await loanSources(c, loanId, ["lossmit_evaluations", "lossmit_offers"]) };
};
export const deriveLossmitReview: Deriver = async (c) => {
  const loanId = loanOf(c); const ev = evaluationOf(c, loanId, str(c.decision, "request_id"));
  const input: Row = { op: "review", id: ev.id, loan_id: loanId, decision: str(c.decision, "decision"), reviewer: { id: c.actor.id, role: c.actor.role ?? "lossmit_reviewer" }, ...(str(c.decision, "reason") ? { reason: str(c.decision, "reason") } : {}), evaluation: { status: ev.data["status"] ?? null, has_denial: ev.data["has_denial"] ?? null } };
  return { input, sources: await loanSources(c, loanId, ["lossmit_evaluations"]) };
};
export const deriveLossmitNotify: Deriver = async (c) => {
  const loanId = loanOf(c); const ev = evaluationOf(c, loanId, str(c.decision, "request_id"));
  if (!ev.data["reviewer_approval_id"]) throw new WorkRefused(409, "DENIAL_NEEDS_REVIEWER", "12.2: no denial notice without the lossmit_reviewer's recorded decision", { request_id: ev.id });
  const parties = await servicingParties(c.rt, loanId);
  const dets = Array.isArray(ev.data["determinations"]) ? (ev.data["determinations"] as Row[]) : [];
  const denied = dets.filter((d) => d["result"] === "denied").map((d) => ({ name: s(d["option"]), reason: (Array.isArray(d["reason_codes"]) ? (d["reason_codes"] as unknown[]).map(String) : []).join(", ") || "not eligible", investor_name: "Fannie Mae", investor_requirement: (Array.isArray(d["reason_codes"]) ? (d["reason_codes"] as unknown[]).map(String) : []).join(", ") || null }));
  const state = s(ev.data["state"]) || null;
  // the servicer-side fields of the template (the SPOC, the addresses, the HUD lines, the appeal procedure) are the template version's own defaults until 12.x keeps a servicer profile; every borrower- and decision-side field is the record's
  const tv = c.rt.noticeRegistry.activeVersion("NTC_REGX_41C1_DENIAL", today(c.now)); const sample = tv?.samplePayload ?? {};
  const servicerSide = Object.fromEntries(Object.entries(sample).filter(([k]) => /^(spoc_|servicer_|exclusive_|hud_|hope_|appeal_how|ai_notice|next_steps|other_available)/.test(k)));
  const appealDays = state === "CA" ? 30 : 14;
  const input: Row = { template_code: "NTC_REGX_41C1_DENIAL", loan_id: loanId, option: s(ev.data["option"]) || denied[0]?.name || "modification", criterion: denied[0]?.reason ?? "not eligible", reviewer_approval_id: s(ev.data["reviewer_approval_id"]), recipients: recipientsOf(parties),
    payload: { ...servicerSide, complete_date: s(ev.data["complete_at"] ?? ev.data["complete_on"]) || today(c.now), denied, investor_based: denied.length > 0, investor_name: "Fannie Mae", not_evaluated_other_criteria: true, ...(state ? { state } : {}), state_block: null, credit_score_used: false, days_after_complete: 0, appeal_days: appealDays, appeal_by: addDays(today(c.now), appealDays), ai_notice_required: true, evaluation_id: ev.id, decided_on: today(c.now) } };
  return { input, sources: await loanSources(c, loanId, ["lossmit_evaluations"]) };
};

// ---------------------------------------------------------------- 14.1
const bkCase = (c: DeriveContext, loanId: string, caseId: string): { id: string; data: Row } => { const r = c.store.get("bankruptcy_cases", caseId) ?? c.store.list("bankruptcy_cases", (d) => d["case_id"] === caseId).at(-1); if (!r || r.data["loan_id"] !== loanId) throw new WorkRefused(404, "NOT_FOUND", `no bankruptcy case ${caseId} on this loan`, { case_id: caseId }); return { id: r.id, data: r.data }; };
const bkLedgerSnapshot = async (c: DeriveContext, loanId: string, kase: Row): Promise<Row> => {
  const facts = await loanCashState(c.rt, loanId, today(c.now));
  const l = obj(kase["ledgers"]);
  return { prepetition_arrearage_cents: cs(l["prepetition_arrearage_cents"] ?? "0"), postpetition: Array.isArray(l["postpetition"]) ? l["postpetition"] : [], postpetition_suspense_cents: cs(l["postpetition_suspense_cents"] ?? "0"), balances: { principal: cs(facts.balances.principal), escrow: cs(facts.balances.escrow), suspense_unapplied: cs(facts.balances.suspense_unapplied), late_charges: cs(facts.balances.late_charges) } };
};
export const deriveBkApplyTrustee: Deriver = async (c) => {
  const loanId = loanOf(c); const kase = bkCase(c, loanId, str(c.decision, "case_id")); const k = kase.data;
  const facts = await loanCashState(c.rt, loanId, today(c.now)); const ledger_snapshot = await bkLedgerSnapshot(c, loanId, k);
  const plan = obj(k["plan"]);
  const input: Row = { loan_id: loanId, case_id: kase.id, amount_cents: cs(c.decision["amount_cents"]), received_on: str(c.decision, "received_on"), received_at: `${str(c.decision, "received_on")}T12:00:00.000Z`, payer_type: "trustee",
    ledgers: { prepetition_arrearage_cents: ledger_snapshot["prepetition_arrearage_cents"], postpetition: ledger_snapshot["postpetition"], postpetition_suspense_cents: ledger_snapshot["postpetition_suspense_cents"] }, ledger_snapshot,
    plan, schedule: plan["schedule"] ?? [], note: plan["note"] ?? null, claim: k["claim"] ?? plan["claim"] ?? null, chapter: s(k["chapter"]) || "13", plan_designation: s(k["plan_designation"] ?? plan["designation"]) || null, conduit_district: k["conduit_district"] === true, case_number_full: s(k["case_number_full"]) || null, claim_no: s(k["claim_no"]) || null, designation: s(k["voucher_designation"]) || null,
    ...(facts.custodial ? { custodial: { pi_account_id: facts.custodial.pi, ti_account_id: facts.custodial.ti } } : {}),
    state: { upb_cents: cs(facts.state.upb_cents), lpi_date: facts.state.lpi_date, installments_due: facts.state.installments.filter((x) => x.status === "due").length } };
  return { input, sources: await loanSources(c, loanId, ["bankruptcy_cases", "payments", "fees", "loan_terms"]) };
};
export const deriveBkApplyPostpetition: Deriver = async (c) => {
  const loanId = loanOf(c); const kase = bkCase(c, loanId, str(c.decision, "case_id")); const ledger_snapshot = await bkLedgerSnapshot(c, loanId, kase.data);
  const input: Row = { loan_id: loanId, case_id: kase.id, amount_cents: cs(c.decision["amount_cents"]), received_on: str(c.decision, "received_on"), ledgers: { prepetition_arrearage_cents: ledger_snapshot["prepetition_arrearage_cents"], postpetition: ledger_snapshot["postpetition"], postpetition_suspense_cents: ledger_snapshot["postpetition_suspense_cents"] }, ledger_snapshot, counsel_directs_arrears: kase.data["counsel_directs_arrears"] === true };
  return { input, sources: await loanSources(c, loanId, ["bankruptcy_cases"]) };
};
export const deriveBkDocket: Deriver = async (c) => {
  const loanId = loanOf(c); const kase = bkCase(c, loanId, str(c.decision, "case_id")); const entryId = str(c.decision, "docket_entry_id");
  const entry = c.store.get("docket_entries", entryId)?.data ?? null; if (!entry) throw new WorkRefused(404, "NOT_FOUND", `no docket entry ${entryId}`, { docket_entry_id: entryId });
  return { input: { op: "apply", loan_id: loanId, case_id: kase.id, entry, docket_entry_id: entryId, case: { chapter: kase.data["chapter"], status: kase.data["status"] } }, sources: await loanSources(c, loanId, ["bankruptcy_cases", "docket_entries"]) };
};
export const deriveBkStatementMode: Deriver = async (c) => {
  const loanId = loanOf(c); const kase = bkCase(c, loanId, str(c.decision, "case_id"));
  return { input: { op: "statement_mode", loan_id: loanId, id: kase.id, case_id: kase.id, mode: str(c.decision, "mode"), case: { chapter: kase.data["chapter"], status: kase.data["status"] }, chapter: kase.data["chapter"] }, sources: await loanSources(c, loanId, ["bankruptcy_cases"]) };
};

// ---------------------------------------------------------------- 21.2 / 25.2 / 26.2 / 3.1 / 13.x (record-derived; the owning tools decide)
const appRecord = (c: DeriveContext, kind: string, id: string, applicationId: string): Row => { const r = rec(c, kind, id); if (r["application_id"] && r["application_id"] !== applicationId) throw new WorkRefused(404, "NOT_FOUND", `${kind} ${id} is not this application's`, { kind, id }); return r; };
export const deriveLeApprove: Deriver = async (c) => {
  const applicationId = appOf(c); const id = str(c.decision, "disclosure_id"); const le = appRecord(c, "loan_estimates", id, applicationId);
  return { input: { op: "approve", application_id: applicationId, disclosure_id: id, data_hash: le["data_hash"] ?? null, approved_data_hash: le["data_hash"] ?? null, release: true, ai_intake_mode: le["ai_intake_mode"] ?? "assisted", fees: le["fees"] ?? null, apr: le["apr"] ?? null, reason: str(c.decision, "reason") || null }, sources: await applicationSources(c, applicationId, ["loan_estimates"]) };
};
const consumerOf = async (c: DeriveContext, applicationId: string): Promise<string> => { const [b] = await c.q.query<{ party_id: string | null; id: string }>(`SELECT party_id::text AS party_id, id::text AS id FROM application_borrowers WHERE application_id = $1 ORDER BY created_at LIMIT 1`, [applicationId]); return b?.party_id ?? b?.id ?? applicationId; };
export const deriveCdDeliver: Deriver = async (c) => {
  const applicationId = appOf(c); const id = str(c.decision, "disclosure_id"); const cd = appRecord(c, "closing_disclosures", id, applicationId);
  const [consent] = await c.q.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents co JOIN application_borrowers ab ON ab.party_id = co.party_id WHERE ab.application_id = $1 AND co.kind = 'esign' AND co.status = 'active'`, [applicationId]).catch(() => [{ n: "0" }]);
  const channel = str(c.decision, "method") || (Number(consent?.n ?? 0) > 0 ? "electronic" : "mail");
  return { input: { application_id: applicationId, disclosure_id: id, consumer_id: await consumerOf(c, applicationId), channel, figures: cd["figures"] ?? null }, sources: await applicationSources(c, applicationId, ["closing_disclosures"]) };
};
export const deriveCdReceipt: Deriver = async (c) => {
  const applicationId = appOf(c); const id = str(c.decision, "disclosure_id"); appRecord(c, "closing_disclosures", id, applicationId);
  const at = str(c.decision, "received_on") ? `${str(c.decision, "received_on")}T12:00:00.000Z` : c.now;
  return { input: { application_id: applicationId, disclosure_id: id, consumer_id: await consumerOf(c, applicationId), evidence: str(c.decision, "evidence_document_id") ? "paper_receipt" : "acknowledged", at, evidence_document_id: str(c.decision, "evidence_document_id") || null }, sources: await applicationSources(c, applicationId, ["closing_disclosures", "cd_receipts"]) };
};
export const deriveCdCorrected: Deriver = async (c) => {
  const applicationId = appOf(c); const id = str(c.decision, "disclosure_id"); const cd = appRecord(c, "closing_disclosures", id, applicationId);
  return { input: { op: "record_event", application_id: applicationId, disclosure_id: id, event_on: today(c.now), info_received_on: today(c.now), description: str(c.decision, "reason"), figures: cd["figures"] ?? null }, sources: await applicationSources(c, applicationId, ["closing_disclosures"]) };
};
export const deriveClosingConfirm: Deriver = async (c) => {
  const applicationId = appOf(c); const id = str(c.decision, "closing_id"); const cl = appRecord(c, "closings", id, applicationId);
  const earliest = s(cl["earliest_consummation"]) || null; const slot = str(c.decision, "slot_at");
  if (earliest && slot.slice(0, 10) < earliest.slice(0, 10)) throw new WorkRefused(409, "BEFORE_EARLIEST_CONSUMMATION", `slot ${slot} precedes the earliest consummation ${earliest}`, { earliest_consummation: earliest, slot_at: slot });
  return { input: { op: "schedule", application_id: applicationId, closing_id: id, scheduled_at: slot, state: cl["state"] ?? null, settlement_agent_party_id: cl["settlement_agent_party_id"] ?? null, transaction_type: cl["transaction_type"] ?? null, earliest_consummation: earliest }, sources: await applicationSources(c, applicationId, ["closings"]) };
};
export const deriveAssignNotary: Deriver = async (c) => {
  const applicationId = appOf(c); const id = str(c.decision, "closing_id"); const cl = appRecord(c, "closings", id, applicationId); const notary = rec(c, "notaries", str(c.decision, "notary_id"));
  return { input: { application_id: applicationId, closing_id: id, notary_party_id: notary["party_id"] ?? str(c.decision, "notary_id"), commission_state: notary["commission_state"] ?? cl["state"] ?? null, physical_location_state: notary["physical_location_state"] ?? cl["state"] ?? null, commission_verified: notary["commission_verified"] === true }, sources: await applicationSources(c, applicationId, ["closings", "notaries"]) };
};
export const deriveOpenSession: Deriver = async (c) => {
  const applicationId = appOf(c); const id = str(c.decision, "closing_id"); const cl = appRecord(c, "closings", id, applicationId);
  const signers = await c.q.query<{ party_id: string | null }>(`SELECT party_id::text AS party_id FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY created_at`, [applicationId]);
  return { input: { application_id: applicationId, closing_id: id, signer_party_ids: signers.map((x) => x.party_id), notary: cl["notary"] ?? null }, sources: await applicationSources(c, applicationId, ["closings"]) };
};
export const deriveEscrowRun: Deriver = async (c) => {
  const loanId = loanOf(c); const facts = await loanCashState(c.rt, loanId, today(c.now));
  const year = str(c.decision, "analysis_year"); const effective = str(c.decision, "effective_on");
  const disb = c.store.list("escrow_disbursements", (d) => d["loan_id"] === loanId).map((r) => r.data); const bills = c.store.list("escrow_bills", (d) => d["loan_id"] === loanId).map((r) => r.data);
  return { input: { loan_id: loanId, analysis_id: `EA-${loanId.slice(0, 8)}-${year}`, analysis_type: "annual", year_start: `${year}-01-01`, as_of: today(c.now), effective_on: effective, cushion: { months: 2 }, disbursements: disb, bills, balances: { escrow_cents: cs(facts.balances.escrow) }, regx_days_delinquent: 0 }, sources: await loanSources(c, loanId, ["escrow_disbursements", "escrow_bills", "loan_terms"]) };
};
export const deriveEscrowApprove: Deriver = async (c) => {
  const loanId = loanOf(c); const id = str(c.decision, "analysis_id"); const a = rec(c, "escrow_analyses", id);
  return { input: { loan_id: loanId, analysis_id: id, anomalies: a["anomalies"] ?? [], payment_change_cents: cs(a["payment_change_cents"] ?? "0"), tolerance: a["tolerance"] ?? null }, sources: await loanSources(c, loanId, ["escrow_analyses"]) };
};
const fcCase = (c: DeriveContext, loanId: string, caseId: string): Row => { const r = c.store.get("foreclosure_cases", caseId) ?? c.store.list("foreclosure_cases", (d) => d["loan_id"] === loanId).at(-1); if (!r || r.data["loan_id"] !== loanId) throw new WorkRefused(404, "NOT_FOUND", `no foreclosure case ${caseId} on this loan`, { case_id: caseId }); return r.data; };
export const deriveForeclosureRefer: Deriver = async (c) => {
  const loanId = loanOf(c); const kase = c.store.get("foreclosure_cases", str(c.decision, "case_id"))?.data ?? null;
  return { input: { loan_id: loanId, step: "refer", case: kase, firm_id: str(c.decision, "firm_id") || null }, sources: await loanSources(c, loanId, ["foreclosure_cases", "delinquency_counters"]) };
};
export const deriveForeclosureInstruct: Deriver = async (c) => {
  const loanId = loanOf(c); const kase = fcCase(c, loanId, str(c.decision, "case_id"));
  return { input: { loan_id: loanId, kind: str(c.decision, "instruction_code"), case: kase, firm_id: str(c.decision, "firm_id") || kase["firm_id"] || null, gates: kase["gates"] ?? null }, sources: await loanSources(c, loanId, ["foreclosure_cases"]) };
};
export const deriveForeclosureHold: Deriver = async (c) => {
  const loanId = loanOf(c); const kase = fcCase(c, loanId, str(c.decision, "case_id"));
  return { input: { loan_id: loanId, kind: "HOLD", reason: str(c.decision, "hold_reason"), case: kase }, sources: await loanSources(c, loanId, ["foreclosure_cases"]) };
};
export const deriveForeclosureMilestone: Deriver = async (c) => {
  const loanId = loanOf(c); const kase = fcCase(c, loanId, str(c.decision, "case_id"));
  return { input: { loan_id: loanId, case_id: str(c.decision, "case_id"), milestone: str(c.decision, "milestone_code"), occurred_on: str(c.decision, "occurred_on"), case: kase, timeframe: kase["timeframe"] ?? null }, sources: await loanSources(c, loanId, ["foreclosure_cases"]) };
};

/** The derivers by the catalogue's `deriver` name. */
export const DERIVERS: Readonly<Record<string, Deriver>> = {
  derivePaymentPost, derivePaymentReverse, derivePayoffQuote, derivePayoffStatement, deriveFundingRelease, deriveConditionClear, deriveConditionReopen, deriveCtc,
  deriveLossmitDecide, deriveLossmitReview, deriveLossmitNotify, deriveBkApplyTrustee, deriveBkApplyPostpetition, deriveBkDocket, deriveBkStatementMode,
  deriveLeApprove, deriveCdDeliver, deriveCdReceipt, deriveCdCorrected, deriveClosingConfirm, deriveAssignNotary, deriveOpenSession, deriveEscrowRun, deriveEscrowApprove,
  deriveForeclosureRefer, deriveForeclosureInstruct, deriveForeclosureHold, deriveForeclosureMilestone,
};
