/**
 * §35.4 `close.attest` / `close.review` — the balance attestation to the cent (rule 3) and the tax-year attestation
 * (rule 10), the independent review (rule 6) and the officer approval under the flag (rule 7).
 *
 *   prepare (custodial-recon)   reads the statement of record, the items register and the ledger, computes the three
 *                               balances, writes the preparer decision (its id is the attestation's `preparer_decision_id`).
 *   close.review (qc-audit)     refuses the preparer's own run id or credentials (REVIEWER_NOT_INDEPENDENT); re-derives
 *                               cashbook and L12 with its own query, re-reads the closing ledger from the stored statement's
 *                               bytes (35.2 — BAI2 015), writes its own decision.
 *   approve (officer)           the approval record: an `agent_decisions` row by a human officer, action `close.attest.approve`,
 *                               naming the period and the account.
 *   attest (custodial-recon)    with a passed review and — while `custodial.form496.human_approval` is on, read from
 *                               configuration, never the request — the officer's record: one close_attestations row;
 *                               `attested` only at variance 0, L12 = cashbook, confidence ≥ 0.95 and evidence on both sides,
 *                               else `variance` with a qc_officer escalation and nothing else changed (rule 3).
 * Every figure is read (rule 12); no `*_cents` input exists (NO_PLUG at the bus, before any read).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import type { CommandContext } from "../../../app/commands.ts";
import type { ToolInput, ToolRuntime } from "../../../app/tools.ts";
import { str } from "../../../app/tools.ts";
import { parseBai2 } from "../../../infra/integrations/codecs/bai2.ts";
import { hasRole } from "../../../app/roles.ts";
import { closePorts, type ClosePorts } from "./ports.ts";
import { cashbook, composition, compositionSnapshot, forms1098, l12Of, reportableLoans, sectionIItems, statementOfRecord } from "./reads.ts";
import { IRS_1098_FILE_FLOOR } from "./figures.ts";
import { decisionById, journal, patchPeriod, patchStep, periodOf, recordOf, stepOf, stepsOf, writeCloseDecision, type DecisionRow } from "./store.ts";
import { piUnits } from "./open.ts";
import { CLOSE_REVIEWER_AGENT, CLOSE_RULE_SET_VERSION, CONFIDENCE_FLOOR, CloseRefused, periodAggregate, type ClosePeriodRow } from "./types.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { PortUnavailable } from "../../../app/tools.ts";

const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const txOf = (ctx: CommandContext): Queryable => { if (!ctx.q) throw new RangeError("35.4 tools run inside a database command (PgUnitOfWork): no transaction on this context"); return ctx.q; };
const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "";
const REMIT = (t: string): "aa" | "sa" | "ss_mbs" | "ss_mrs" => { const u = t.toUpperCase(); return u.startsWith("A/A") ? "aa" : u.startsWith("S/A") ? "sa" : /MRS|PORTFOLIO/.test(u) ? "ss_mrs" : "ss_mbs"; };

export interface Figures { readonly as_of: string; readonly custodial_account_id: string; readonly remittance_type: string; readonly bank_closing_ledger_cents: bigint | null; readonly deposits_in_transit_cents: bigint; readonly disbursements_in_transit_cents: bigint; readonly depository_adjustments_cents: bigint; readonly adjusted_depository_cents: bigint | null; readonly composition: Record<string, bigint>; readonly composition_l12_cents: bigint; readonly cashbook_cents: bigint; readonly variance_cents: bigint | null; readonly statement_document_id: string | null; readonly statement_source: string | null; readonly item_ids: readonly string[] }
/** Rule 3, every term read from typed rows: adjusted = bank + DIT − disbursements in transit + adjustments; cashbook = Σ custodial_pi_cash through as_of; L12 = Σ L1..L11; variance = adjusted − cashbook. */
export async function computeFigures(q: Queryable, unit: { custodial_account_id: string; remittance_type: string }, p: ClosePeriodRow): Promise<Figures> {
  const st = await statementOfRecord(q, unit.custodial_account_id, p.period_end);
  const items = await sectionIItems(q, unit.custodial_account_id, p.period_end);
  const comp = await composition(q, unit.custodial_account_id, p.period, unit.remittance_type);
  const cb = await cashbook(q, unit.custodial_account_id, p.period_end);
  const adjusted = st.closing_ledger_cents === null ? null : st.closing_ledger_cents + items.deposits_in_transit_cents - items.disbursements_in_transit_cents + items.depository_adjustments_cents;
  return { as_of: p.period_end, custodial_account_id: unit.custodial_account_id, remittance_type: unit.remittance_type, bank_closing_ledger_cents: st.closing_ledger_cents, ...items, adjusted_depository_cents: adjusted, composition: comp, composition_l12_cents: l12Of(comp), cashbook_cents: cb, variance_cents: adjusted === null ? null : adjusted - cb, statement_document_id: st.document_id, statement_source: st.source, item_ids: items.item_ids };
}
const wire = (f: Figures): Record<string, unknown> => ({ as_of: f.as_of, custodial_account_id: f.custodial_account_id, remittance_type: f.remittance_type, bank_closing_ledger_cents: f.bank_closing_ledger_cents?.toString() ?? null, deposits_in_transit_cents: f.deposits_in_transit_cents.toString(), disbursements_in_transit_cents: f.disbursements_in_transit_cents.toString(), depository_adjustments_cents: f.depository_adjustments_cents.toString(), adjusted_depository_cents: f.adjusted_depository_cents?.toString() ?? null, composition_snapshot: compositionSnapshot(f.composition), composition_l12_cents: f.composition_l12_cents.toString(), cashbook_cents: f.cashbook_cents.toString(), attestation_variance_cents: f.variance_cents?.toString() ?? null, statement_document_id: f.statement_document_id, statement_source: f.statement_source, item_ids: f.item_ids });

async function unitOf(q: Queryable, i: ToolInput, p: ClosePeriodRow): Promise<{ custodial_account_id: string; remittance_type: string }> {
  const units = await piUnits(q, p.period);
  const account = str(i, "custodial_account_id");
  const type = str(i, "remittance_type");
  if (account) {
    const u = units.find((x) => x.custodial_account_id === account && (!type || x.remittance_type === type));
    if (!u) throw new CloseRefused("UNKNOWN_UNIT", "35.4 rule 6: the attestation is per (P&I custodial account × remittance type) of the period", `${account}${type ? ` (${type})` : ""} is not a P&I unit of ${p.period}: ${units.map((x) => `${x.custodial_account_id} (${x.remittance_type})`).join(", ") || "none"}`);
    return u;
  }
  if (units.length === 1) return units[0]!;
  throw new RangeError(`custodial_account_id is required (${units.length} P&I units in ${p.period})`);
}
const unitSubject = (p: ClosePeriodRow, u: { custodial_account_id: string; remittance_type: string }): { kind: string; id: string } => ({ kind: "close_attestation_unit", id: `${p.id}:${u.custodial_account_id}:${u.remittance_type}` });
async function latestDecision(q: Queryable, action: string, subjectId: string, extra = ""): Promise<DecisionRow | undefined> {
  return (await q.query<DecisionRow>(`SELECT id::text AS id, agent, action, rationale, approved_by, approved_role, subject_kind, subject_id, created_at::text AS created_at FROM agent_decisions WHERE action = $1 AND subject_id = $2 ${extra} ORDER BY created_at DESC LIMIT 1`, [action, subjectId]))[0];
}

/** The evidence-pack document of an attestation (Outputs: "the attestation package per period … one PDF with SHA-256, corporate_7y"): the rows rendered as text with the statement hash and the decisions; the bytes go to 35.2's staged copy when its table exists. */
async function packageDocument(q: Queryable, p: ClosePeriodRow, attestationId: string, body: Record<string, unknown>, now: string): Promise<string> {
  const text = JSON.stringify({ process: "35.4", kind: "attestation_package", period: p.period, attestation_id: attestationId, rendered_at: now, ...body }, null, 1);
  const bytes = Buffer.from(text, "utf8"); const sha = createHash("sha256").update(bytes).digest("hex"); const id = randomUUID();
  await q.query(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata) VALUES ($1, 'close_attestation_package', $2, $3, $4, 'application/json', 'corporate_7y', $5::jsonb)`, [id, sha, bytes.length, `close-35-4://attestation/${attestationId}`, JSON.stringify({ close_period_id: p.id, attestation_id: attestationId, period: p.period })]);
  const blobs = (await q.query<{ r: string | null }>(`SELECT to_regclass('public.document_blobs')::text AS r`))[0]?.r;
  if (blobs) await q.query(`INSERT INTO document_blobs (document_id, sha256, byte_size, mime_type, content, staged_at) VALUES ($1, $2, $3, 'application/json', $4, $5)`, [id, sha, bytes.length, bytes, now]);   // never swallowed inside the transaction
  return id;
}

export async function attestTool(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const q = txOf(ctx); const runtime = runtimeOf(rt); const ports = closePorts(runtime);
  const servicer = await ports.servicer.servicerNumber(q);
  const period = str(i, "period"); const taxYear = has(i, "tax_year") ? Number(i["tax_year"]) : null;
  if (!period && taxYear === null) throw new RangeError("period (YYYY-MM or YYYY-TY) or tax_year is required");
  const p = await periodOf(q, { ...(period ? { period } : {}), tax_year: taxYear }, servicer, true);
  if (!p) throw new RangeError(`no close period ${period || taxYear}`);
  const op = str(i, "op") || "attest";
  if (p.kind === "tax_year") return taxYearAttest(q, ctx, rt, p, servicer);
  const unit = await unitOf(q, i, p);
  const subject = unitSubject(p, unit);
  if (op === "prepare") {
    const f = await computeFigures(q, unit, p);
    const confidence = typeof i["confidence"] === "number" ? i["confidence"] : 1;
    const evidence = [...(Array.isArray(i["evidence_document_ids"]) ? (i["evidence_document_ids"] as unknown[]).map(String) : []), ...(f.statement_document_id ? [f.statement_document_id] : [])];
    const id = await writeCloseDecision(ctx, { action: "close.attest.prepare", subject, record: { period: p.period, servicer_number: servicer, ...wire(f), action: "prepare", confidence, evidence_document_ids: evidence, composition_snapshot_id: null }, rationale: `prepared: adjusted ${f.adjusted_depository_cents?.toString() ?? "n/a"}, cashbook ${f.cashbook_cents}, L12 ${f.composition_l12_cents}, variance ${f.variance_cents?.toString() ?? "n/a"}`, confidence, evidenceDocumentIds: evidence });
    return { preparer_decision_id: id, ...wire(f), confidence, evidence_document_ids: evidence };
  }
  if (op === "approve") {
    if (!hasRole(ctx.actor, ["officer"])) throw new CloseRefused("ROLE_DENIED", "35.4 rule 7: the approval record is 'agent_decisions by a human actor with role officer, action close.attest.approve'", `${ctx.actor.kind}:${ctx.actor.id} is not an officer`);
    const id = await writeCloseDecision(ctx, { action: "close.attest.approve", subject, record: { period: p.period, servicer_number: servicer, custodial_account_id: unit.custodial_account_id, remittance_type: unit.remittance_type, action: "approve", approved_by: ctx.actor.id, rationale: str(i, "rationale") || "officer approval of the balance attestation" }, rationale: str(i, "rationale") || `officer ${ctx.actor.id} approves the ${p.period} attestation of ${unit.custodial_account_id} (${unit.remittance_type})`, approvedBy: ctx.actor });
    return { officer_approval_id: id, period: p.period, custodial_account_id: unit.custodial_account_id, remittance_type: unit.remittance_type };
  }
  if (op !== "attest") throw new RangeError("close.attest op is prepare | approve | attest");
  // FLAG_FROM_CONFIG: a request field `human_approval_on` is ignored, never read (discrepancy 3)
  const step = await stepOf(q, p.id, "balance_attestation"); if (!step) throw new RangeError(`period ${p.period} has no balance_attestation step`);
  // the state machine: an attestation is written on an open or reopened period whose step is planned or running — an attested or closed period is terminal until a reopen (rule 9: "the re-attestation is a new row with supersedes_attestation_id" only after `close.reopen`)
  if (!["open", "reopened"].includes(p.status) || !["planned", "running"].includes(step.status)) throw new CloseRefused("PERIOD_NOT_OPEN", "35.4 state machine: 'attested —(every remaining step completed or skipped)→ closed', terminal 'until a reopen'; rule 9: a re-attestation follows `close.reopen`", `${p.period} is ${p.status} and balance_attestation is ${step.status}: reopen the period (officer) before a new attestation`, { period_status: p.status, step_status: step.status });
  const all = await stepsOf(q, p.id); const byCode = new Map(all.map((x) => [x.code, x]));
  const missing = step.depends_on.filter((c) => { const x = byCode.get(c); return x ? !["completed", "skipped", "pre_reopen"].includes(x.status) : true; });
  if (missing.length) throw new CloseRefused("STEP_BLOCKED", "35.4 state machine: 'open —(close.attest: every step in balance_attestation.depends_on completed …)→ attested'", `balance_attestation is blocked on ${missing.join(", ")}`, { missing });
  const preparer = has(i, "preparer_decision_id") ? await decisionById(q, str(i, "preparer_decision_id")) : await latestDecision(q, "close.attest.prepare", subject.id);
  if (preparer && preparer.subject_id !== subject.id) throw new CloseRefused("PREPARER_DECISION_REQUIRED", "35.4 rule 7 / AI agent design: the decisions name the period and account — a decision for another period or unit is not this unit's", `preparer decision ${preparer.id} is for ${preparer.subject_id}, not ${subject.id}`);
  if (!preparer || preparer.action !== "close.attest.prepare") throw new CloseRefused("PREPARER_DECISION_REQUIRED", "35.4 AI agent design: 'the agent prepares the balance attestation … writes the preparer decision and calls close.attest'", `no preparer decision for ${p.period} ${unit.custodial_account_id} (${unit.remittance_type})`);
  const review = has(i, "reviewer_decision_id") ? await decisionById(q, str(i, "reviewer_decision_id")) : await latestDecision(q, "close.review", subject.id);
  const rr = review ? recordOf(review) : {};
  if (review && review.subject_id !== subject.id) throw new CloseRefused("REVIEW_REQUIRED", "35.4 rule 6: the review is of this unit's preparer decision — a review for another period or unit is not this unit's", `review ${review.id} is for ${review.subject_id}, not ${subject.id}`);
  if (!review || review.action !== "close.review" || rr["preparer_decision_id"] !== preparer.id) throw new CloseRefused("REVIEW_REQUIRED", "35.4 rule 6: 'qc-audit reviews before the attestation is written'", `no independent review of preparer decision ${preparer.id}`);
  if (rr["outcome"] !== "passed") throw new CloseRefused("REVIEW_FAILED", "35.4 rule 6: the reviewer 're-derives cashbook and composition_l12 … re-reads the statement's closing ledger from the stored document … and writes its own decision'", `the review ${review.id} did not pass: ${String(rr["reason"] ?? "figures differ")}`);
  const flag = await ports.config.humanApprovalOn(q, p.period, p.period_end);
  let approval: DecisionRow | undefined;
  if (flag) {
    approval = has(i, "officer_approval_id") ? await decisionById(q, str(i, "officer_approval_id")) : await latestDecision(q, "close.attest.approve", subject.id, "AND approved_role = 'officer'");
    if (approval && approval.subject_id !== subject.id) throw new CloseRefused("OFFICER_APPROVAL_REQUIRED", "35.4 rule 7: the approval record names 'the period and account'", `approval ${approval.id} is for ${approval.subject_id}, not ${subject.id}`);
    if (!approval || approval.action !== "close.attest.approve" || approval.approved_role !== "officer") throw new CloseRefused("OFFICER_APPROVAL_REQUIRED", "35.4 rule 7: 'when on, the attestation needs an officer approval record (agent_decisions by a human actor with role officer, action close.attest.approve, naming the period and account) or it is refused OFFICER_APPROVAL_REQUIRED'", `custodial.form496.human_approval is on for ${p.period} and no officer approval record exists for ${unit.custodial_account_id} (${unit.remittance_type})`);
  }
  const f = await computeFigures(q, unit, p);
  // rule 6: the reviewed figures are the written figures — a posting or a composition correction since the review makes it stale (the agent prepares again and qc-audit reviews again)
  const stale = [["cashbook_cents", f.cashbook_cents.toString()], ["composition_l12_cents", f.composition_l12_cents.toString()], ["closing_ledger_reread_cents", f.bank_closing_ledger_cents?.toString() ?? null]].filter(([k, v]) => String(rr[k as string] ?? null) !== String(v));
  if (stale.length) throw new CloseRefused("REVIEW_STALE", "35.4 rule 6: 'qc-audit reviews before the attestation is written' — the review re-derives the cashbook, L12 and the statement's closing ledger; the attestation writes the figures the review passed", `the book moved since review ${review.id}: ${stale.map(([k]) => k).join(", ")} differ`, { stale: stale.map(([k]) => k) });
  const prep = recordOf(preparer);
  const confidence = typeof prep["confidence"] === "number" ? (prep["confidence"] as number) : 0;
  const evidence = Array.isArray(prep["evidence_document_ids"]) ? (prep["evidence_document_ids"] as unknown[]).map(String) : [];
  const ties = f.variance_cents === 0n && f.composition_l12_cents === f.cashbook_cents;
  const reasons: string[] = [];
  if (f.adjusted_depository_cents === null) reasons.push("no statement of record for the period end");
  if (f.variance_cents !== 0n) reasons.push(`variance ${f.variance_cents?.toString() ?? "n/a"} cents`);
  if (f.composition_l12_cents !== f.cashbook_cents) reasons.push(`L12 ${f.composition_l12_cents} ≠ cashbook ${f.cashbook_cents}`);
  if (confidence < CONFIDENCE_FLOOR) reasons.push(`confidence ${confidence} < ${CONFIDENCE_FLOOR}`);
  if (evidence.length === 0) reasons.push("no evidence document on the preparer decision");
  const outcome: "attested" | "variance" = ties && reasons.length === 0 ? "attested" : "variance";
  const supersedes = p.status === "reopened" || p.reopen_count > 0 ? (await q.query<{ id: string }>(`SELECT id::text AS id FROM close_attestations WHERE close_period_id = $1 AND kind = 'balance' AND outcome = 'attested' AND custodial_account_id = $2 AND remittance_type = $3 ORDER BY created_at DESC LIMIT 1`, [p.id, unit.custodial_account_id, REMIT(unit.remittance_type)]))[0]?.id ?? null : null;
  const id = randomUUID();
  await q.query(`INSERT INTO close_attestations (id, close_period_id, kind, outcome, as_of, custodial_account_id, remittance_type, bank_closing_ledger_cents, deposits_in_transit_cents, disbursements_in_transit_cents, depository_adjustments_cents, adjusted_depository_cents, composition_snapshot, composition_l12_cents, cashbook_cents, variance_cents, confidence, evidence_document_ids, preparer_decision_id, reviewer_decision_id, officer_approval_id, human_approval_flag, attested_by, supersedes_attestation_id)
    VALUES ($1, $2, 'balance', $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17::uuid[], $18, $19, $20, $21, $22::jsonb, $23)`,
    [id, p.id, outcome, p.period_end, unit.custodial_account_id, REMIT(unit.remittance_type), f.bank_closing_ledger_cents, f.deposits_in_transit_cents, f.disbursements_in_transit_cents, f.depository_adjustments_cents, f.adjusted_depository_cents, JSON.stringify(compositionSnapshot(f.composition)), f.composition_l12_cents, f.cashbook_cents, f.variance_cents ?? (f.cashbook_cents * -1n), confidence, evidence.filter((x) => /^[0-9a-f-]{36}$/i.test(x)), preparer.id, review.id, approval?.id ?? null, flag, JSON.stringify(ctx.actor), supersedes]);
  const record = { period: p.period, servicer_number: servicer, ...wire(f), action: "attest", attestation_id: id, outcome, confidence, evidence_document_ids: evidence, reviewer_decision_id: review.id, officer_approval_id: approval?.id ?? null, human_approval_flag: flag, supersedes_attestation_id: supersedes, reasons };
  if (outcome === "variance") {
    const esc = rt.escalations.open({ kind: "qc_officer", ownerRole: "qc_officer", severity: "2", payload: { process: "35.4", period: p.period, custodial_account_id: unit.custodial_account_id, remittance_type: unit.remittance_type, attestation_id: id, variance_cents: f.variance_cents?.toString() ?? null, reasons } }, ctx.actor);
    ctx.events.append({ type: "close.attestation.variance", aggregate: periodAggregate(servicer, p.period), actor: ctx.actor, payload: { close_period_id: p.id, period: p.period, attestation_id: id, custodial_account_id: unit.custodial_account_id, remittance_type: unit.remittance_type, variance_cents: f.variance_cents?.toString() ?? null, reasons, escalation_id: esc.id } });
    await journal(q, { close_period_id: p.id, step_id: step.id, type: "close.attestation.variance", actor: ctx.actor, occurred_at: ctx.now, payload: { attestation_id: id, custodial_account_id: unit.custodial_account_id, variance_cents: f.variance_cents?.toString() ?? null, reasons, escalation_id: esc.id } });
    await writeCloseDecision(ctx, { action: "close.attest", subject, record: { ...record, escalation_id: esc.id }, rationale: `variance: ${reasons.join("; ")} — a variance row, never a plug; qc_officer escalation ${esc.id}`, confidence, evidenceDocumentIds: evidence });
    return { attestation_id: id, outcome, ...wire(f), escalation_id: esc.id, reasons, human_approval_flag: flag, period_status: p.status };
  }
  // attested: the period is attested when every P&I unit is (open question 6); the step completes with it
  const units = await piUnits(q, p.period);
  // the units attested since the last reopen (the journal's occurred_at is the command clock; a row's created_at is the wall clock) plus this one
  const attestedUnits = [...(await q.query<{ a: string; t: string }>(`SELECT payload->>'custodial_account_id' AS a, payload->>'remittance_type' AS t FROM close_period_events WHERE close_period_id = $1 AND type = 'close.period.attested' AND occurred_at >= coalesce((SELECT max(reopened_at) FROM close_reopens WHERE close_period_id = $1), '-infinity'::timestamptz)`, [p.id])), { a: unit.custodial_account_id, t: unit.remittance_type }];
  const allAttested = units.every((u) => attestedUnits.some((x) => x.a === u.custodial_account_id && x.t === u.remittance_type));
  const packageId = await packageDocument(q, p, id, { attestation: record, preparer_decision_id: preparer.id, reviewer_decision_id: review.id, officer_approval_id: approval?.id ?? null }, ctx.now);
  await journal(q, { close_period_id: p.id, step_id: step.id, type: "close.period.attested", actor: ctx.actor, occurred_at: ctx.now, payload: { attestation_id: id, custodial_account_id: unit.custodial_account_id, remittance_type: unit.remittance_type, variance_cents: "0", package_document_id: packageId, period_attested: allAttested } });
  if (allAttested) {
    const ev = ctx.events.append({ type: "close.period.attested", aggregate: periodAggregate(servicer, p.period), actor: ctx.actor, payload: { close_period_id: p.id, period: p.period, attestation_id: id, variance_cents: "0", custodial_account_id: unit.custodial_account_id, remittance_type: unit.remittance_type, package_document_id: packageId, supersedes_attestation_id: supersedes, units: units.length } });
    await patchStep(q, step.id, { status: "completed", started_at: step.started_at ?? ctx.now, completed_at: ctx.now, received: units.length, expected_receipts: units.length }, ctx.now);
    await journal(q, { close_period_id: p.id, step_id: step.id, type: "close.receipt.recorded", source_event_id: ev.id, actor: ctx.actor, occurred_at: ctx.now, payload: { step: "balance_attestation", unit: `${unit.custodial_account_id}:${unit.remittance_type}`, event_type: "close.period.attested", event_occurred_at: ctx.now, units: units.length } });   // the step's receipt is this process's own event, journaled like every other receipt (the planner's later scan finds it recorded)
    await journal(q, { close_period_id: p.id, step_id: step.id, type: "close.step.completed", actor: ctx.actor, occurred_at: ctx.now, payload: { period: p.period, step: "balance_attestation", attestation_id: id } });
    await patchPeriod(q, p.id, { status: "attested", attested_at: ctx.now, current_attestation_id: id }, ctx.now);
  } else if (step.status !== "running") {
    await patchStep(q, step.id, { status: "running", started_at: step.started_at ?? ctx.now }, ctx.now);
  }
  await writeCloseDecision(ctx, { action: "close.attest", subject, record: { ...record, package_document_id: packageId }, rationale: `attested at variance $0.00: adjusted ${f.adjusted_depository_cents} = cashbook ${f.cashbook_cents} = L12 ${f.composition_l12_cents}${allAttested ? "; period attested" : "; other P&I units pending"}`, confidence, evidenceDocumentIds: [...evidence, packageId] });
  return { attestation_id: id, outcome, ...wire(f), human_approval_flag: flag, officer_approval_id: approval?.id ?? null, preparer_decision_id: preparer.id, reviewer_decision_id: review.id, supersedes_attestation_id: supersedes, package_document_id: packageId, period_status: allAttested ? "attested" : p.status };
}

/** Rule 6 — the reviewer's own derivation, its own SQL text (not reads.ts's), its own read of the bytes. */
async function reviewerCashbook(q: Queryable, account: string, asOf: string): Promise<bigint> {
  const r = await q.query<{ s: string }>(`SELECT coalesce(sum(ll.amount_cents), 0)::text AS s FROM ledger_lines ll WHERE ll.scope = 'custodial' AND ll.account = 'custodial_pi_cash' AND ll.custodial_account_id = $1 AND ll.set_id IN (SELECT id FROM ledger_entry_sets WHERE effective_date <= $2::date)`, [account, asOf]);
  return BigInt(r[0]?.s ?? "0");
}
async function reviewerL12(q: Queryable, account: string, period: string, type: string): Promise<bigint> {
  const r = await q.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM remittance_components WHERE custodial_account_id = $1 AND period = $2 AND remittance_type = $3 AND component_code ~ '^L([1-9]|1[01])_'`, [account, period, type]);
  return BigInt(r[0]?.s ?? "0");
}
/** BAI2 015 (closing ledger) of the statement bytes; the first account's when the file carries one. */
export function closingLedgerFromBai2(bytes: Buffer): bigint | null {
  const file = parseBai2(bytes.toString("utf8"));
  for (const g of file.groups) for (const a of g.accounts) { const s = a.summaries.find((x) => x.typeCode === "015"); if (s && s.amountCents !== null) return s.amountCents; }
  return null;
}

export async function reviewTool(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const q = txOf(ctx); const runtime = runtimeOf(rt); const ports = closePorts(runtime);
  const preparerId = str(i, "preparer_decision_id"); if (!preparerId) throw new RangeError("preparer_decision_id is required");
  const preparer = await decisionById(q, preparerId);
  if (!preparer || preparer.action !== "close.attest.prepare") throw new RangeError(`no preparer decision ${preparerId}`);
  const prep = recordOf(preparer);
  const prepActor = prep["actor"] as { kind?: string; id?: string } | undefined;
  const sameRun = !!ctx.run?.runId && ctx.run.runId === prep["run_id"];
  const sameCredentials = !!prepActor && prepActor.kind === ctx.actor.kind && prepActor.id === ctx.actor.id;
  const sameSession = has(i, "run_id") && str(i, "run_id") === prep["run_id"];
  if (sameRun || sameCredentials || sameSession) throw new CloseRefused("REVIEWER_NOT_INDEPENDENT", "35.4 rule 6: 'Same run id, same credentials or same model session as the preparer → REVIEWER_NOT_INDEPENDENT'", `the review must run under credentials disjoint from the preparer's (${prepActor?.kind}:${prepActor?.id}, run ${String(prep["run_id"])})`);
  if (ctx.actor.kind === "agent" && ctx.actor.id !== CLOSE_REVIEWER_AGENT) throw new CloseRefused("REVIEWER_NOT_INDEPENDENT", "35.4 rule 6: 'close.review must be run by qc-audit under credentials disjoint from the preparer's (35.7 reviewer_roles)'", `${ctx.actor.id} is not the qc-audit reviewer`);
  const servicer = await ports.servicer.servicerNumber(q);
  const p = await periodOf(q, { period: String(prep["period"]) }, servicer); if (!p) throw new RangeError(`no close period ${String(prep["period"])}`);
  const account = String(prep["custodial_account_id"]); const type = String(prep["remittance_type"]);
  const cb = await reviewerCashbook(q, account, p.period_end);
  const l12 = await reviewerL12(q, account, p.period, type);
  const docId = prep["statement_document_id"] ? String(prep["statement_document_id"]) : (Array.isArray(prep["evidence_document_ids"]) ? String((prep["evidence_document_ids"] as unknown[])[0] ?? "") : "");
  const bytes = docId ? await ports.documents.read(q, docId) : null;
  const reread = bytes ? closingLedgerFromBai2(bytes) : null;
  const sha = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
  const preparerCashbook = BigInt(String(prep["cashbook_cents"] ?? "0")); const preparerL12 = BigInt(String(prep["composition_l12_cents"] ?? "0"));
  const preparerLedger = prep["bank_closing_ledger_cents"] === null || prep["bank_closing_ledger_cents"] === undefined ? null : BigInt(String(prep["bank_closing_ledger_cents"]));
  const reasons: string[] = [];
  if (cb !== preparerCashbook) reasons.push(`cashbook re-derived ${cb} ≠ preparer ${preparerCashbook}`);
  if (l12 !== preparerL12) reasons.push(`L12 re-derived ${l12} ≠ preparer ${preparerL12}`);
  if (reread === null) reasons.push(bytes ? "the stored statement carries no 015 closing ledger" : `no stored statement bytes to re-read (${docId || "no document"})`);
  else if (preparerLedger !== reread) reasons.push(`closing ledger re-read ${reread} ≠ preparer ${preparerLedger?.toString() ?? "n/a"}`);
  const outcome = reasons.length ? "failed" : "passed";
  const subject = { kind: "close_attestation_unit", id: `${p.id}:${account}:${type}` };
  const id = await writeCloseDecision(ctx, { action: "close.review", subject, record: { period: p.period, servicer_number: servicer, custodial_account_id: account, remittance_type: type, action: "review", preparer_decision_id: preparer.id, outcome, cashbook_cents: cb.toString(), composition_l12_cents: l12.toString(), closing_ledger_reread_cents: reread?.toString() ?? null, statement_document_id: docId || null, statement_sha256: sha, reasons, rule_set_version: CLOSE_RULE_SET_VERSION }, rationale: outcome === "passed" ? `independent review passed: cashbook ${cb}, L12 ${l12}, closing ledger ${reread} re-read from ${docId}` : `independent review failed: ${reasons.join("; ")}` }, CLOSE_REVIEWER_AGENT);
  return { reviewer_decision_id: id, outcome, cashbook_cents: cb.toString(), composition_l12_cents: l12.toString(), closing_ledger_reread_cents: reread?.toString() ?? null, statement_sha256: sha, reasons };
}

/** Rule 10's tax-year attestation: furnished = reportable (7.1 furnishes below $600 too), filed = loans with box 1 ≥ $600.00, Σ box 1 = the ledger interest sum, variance 0. */
async function taxYearAttest(q: Queryable, ctx: CommandContext, rt: ToolRuntime, p: ClosePeriodRow, servicer: string): Promise<unknown> {
  const ty = p.tax_year!;
  const close = (await q.query<{ reportable_loans: number; ledger_interest_sum_cents: string }>(`SELECT reportable_loans, ledger_interest_sum_cents::text AS ledger_interest_sum_cents FROM tax_year_closes WHERE tax_year = $1`, [ty]))[0];
  if (!close) throw new CloseRefused("TAX_YEAR_NOT_CLOSED", "35.4 rule 10: the tax-year attestation follows close.tax_year", `tax year ${ty} has no tax_year_closes row`);
  const loans = await reportableLoans(q, ty); const forms = await forms1098(q, ty);
  const ledgerSum = loans.reduce((a, l) => a + l.interest_cents, 0n);
  const expectedFiled = loans.filter((l) => l.interest_cents >= IRS_1098_FILE_FLOOR).length;
  const variance = forms.box1_sum_cents - ledgerSum;
  const missing = loans.map((l) => l.loan_id).filter((id) => !forms.furnished_loan_ids.includes(id));
  const reasons: string[] = [];
  if (forms.furnished !== close.reportable_loans) reasons.push(`furnished_count ${forms.furnished} ≠ reportable ${close.reportable_loans}${missing.length ? ` (unfurnished: ${missing.join(", ")})` : ""}`);
  if (forms.filed !== expectedFiled) reasons.push(`filed_count ${forms.filed} ≠ loans with box 1 ≥ $600.00 (${expectedFiled})`);
  if (variance !== 0n) reasons.push(`box1_sum ${forms.box1_sum_cents} ≠ ledger interest sum ${ledgerSum}`);
  if (BigInt(close.ledger_interest_sum_cents) !== ledgerSum) reasons.push(`ledger interest sum moved since the close: ${close.ledger_interest_sum_cents} → ${ledgerSum}`);
  const outcome: "attested" | "variance" = reasons.length ? "variance" : "attested";
  const id = randomUUID();
  await q.query(`INSERT INTO close_attestations (id, close_period_id, kind, outcome, as_of, variance_cents, reportable_loans, furnished_count, filed_count, box1_sum_cents, ledger_interest_sum_cents, confidence, human_approval_flag, attested_by) VALUES ($1, $2, 'tax_year', $3, $4::date, $5, $6, $7, $8, $9, $10, 1, false, $11::jsonb)`,
    [id, p.id, outcome, p.period_end, variance, close.reportable_loans, forms.furnished, forms.filed, forms.box1_sum_cents, ledgerSum, JSON.stringify(ctx.actor)]);
  const subject = { kind: "close_period", id: p.id };
  const record = { period: p.period, servicer_number: servicer, tax_year: ty, action: "attest", attestation_id: id, outcome, reportable_loans: close.reportable_loans, furnished_count: forms.furnished, filed_count: forms.filed, box1_sum_cents: forms.box1_sum_cents.toString(), ledger_interest_sum_cents: ledgerSum.toString(), attestation_variance_cents: variance.toString(), reasons };
  if (outcome === "variance") {
    const esc = rt.escalations.open({ kind: "officer", ownerRole: "officer", severity: "2", payload: { process: "35.4", period: p.period, tax_year: ty, attestation_id: id, unfurnished_loan_ids: missing, reasons } }, ctx.actor);
    ctx.events.append({ type: "close.attestation.variance", aggregate: periodAggregate(servicer, p.period), actor: ctx.actor, payload: { close_period_id: p.id, period: p.period, tax_year: ty, attestation_id: id, variance_cents: variance.toString(), unfurnished_loan_ids: missing, reasons, escalation_id: esc.id } });
    await journal(q, { close_period_id: p.id, type: "close.attestation.variance", actor: ctx.actor, occurred_at: ctx.now, payload: { attestation_id: id, tax_year: ty, reasons, escalation_id: esc.id } });
    await writeCloseDecision(ctx, { action: "close.attest", subject, record: { ...record, escalation_id: esc.id }, rationale: `tax-year ${ty} variance: ${reasons.join("; ")}; officer escalation ${esc.id}` });
    return { ...record, escalation_id: esc.id, period_status: p.status };
  }
  ctx.events.append({ type: "close.period.attested", aggregate: periodAggregate(servicer, p.period), actor: ctx.actor, payload: { close_period_id: p.id, period: p.period, tax_year: ty, attestation_id: id, variance_cents: "0" } });
  await journal(q, { close_period_id: p.id, type: "close.period.attested", actor: ctx.actor, occurred_at: ctx.now, payload: { attestation_id: id, tax_year: ty, variance_cents: "0" } });
  await patchPeriod(q, p.id, { status: "attested", attested_at: ctx.now, current_attestation_id: id }, ctx.now);
  await writeCloseDecision(ctx, { action: "close.attest", subject, record, rationale: `tax-year ${ty} attested: furnished ${forms.furnished} = reportable ${close.reportable_loans}, filed ${forms.filed}, Σ box 1 ${forms.box1_sum_cents} = ledger ${ledgerSum}` });
  return { ...record, period_status: "attested" };
}
export type { ClosePorts };
