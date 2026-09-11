/**
 * §25.4 process-owned tools — bus tools for 25.4 defined with `defineTools("25.4", "disclosure", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 25.4; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `disclosure` agent profile (spec "AI agent design"): composeClosingPackage, evaluateEscrowWaiver,
 * renderStateEscrowNotice, checkPrivacyNotice, runCdEscrowConsistency (25.2 check codes), deliverPackage (via 26.2),
 * recordPackageEvidence, schedulePostClosingRun, evaluateOwnershipTransfer, renderOwnershipNotice (op=render|send),
 * writeDecision. Guardrails encode the paragraph: never mark an item delivered without signing-session or manifest
 * evidence; never render the escrow statement from figures other than 30.3's approved analysis; never approve an escrow
 * waiver outside the partner's written policy or where B2-1.5-04/HPML forbid it (policy exceptions are the `officer`'s);
 * never send a §1026.39 notice in Fannie Mae's name without a written Fannie Mae instruction on file (and the decision
 * to send on Fannie Mae's behalf is the `officer`'s); never present autopay as a condition or pre-check enrollment;
 * never invent Fannie Mae contact details. State lives in the entity store (`closing_notice_runs`, `escrow_elections`,
 * `ownership_transfer_notices`, `tax_reporting_seeds`, `cd_consistency_checks`, `escrow_accounts` evidence fields);
 * events go through ops-25-4.ts so the 25.4 gates and clocks arm and close.
 */
import { defineTools, compute, decision, never, needsRole, str, num, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { composeClosingPackage, deliverPackage, recordPackageEvidence, evaluateEscrowWaiver, recordEscrowElection, renderStateEscrowNotice, checkPrivacyNotice, recordPrivacyGate, runCdEscrowConsistency, schedulePostClosingRun, completePostClosingRun, evaluateOwnershipTransfer, renderOwnershipNotice, sendOwnershipNotice, recordBorrowerReport, seedTaxReporting, handoffTaxReportingSeeds, decisionRecord,
  type ComposeInput, type ClosingNoticeRun, type PostClosingRun, type WaiverCriteria, type EscrowElectionKind, type BorrowerPrivacyFact, type StateNoticeRender, type ManifestEntry, type OwnershipTransferNotice, type CoveredPersonContact, type OwnershipNoticeInput, type JurisdictionEscrowRule, type EscrowElection } from "../../domain/compliance-disclosures/ops-25-4.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`25.4 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("25.4 tool needs application_id (every 25.4 event carries it so the gates arm under origination context)"); return a; };
const loanOf = (i: ToolInput, ctx: CommandContext): string | null => (i.loan_id as string | undefined) ?? ctx.loanId ?? null;
const dateIn = (i: Record<string, unknown>, k: string): PlainDate => { const v = i[k]; if (typeof v !== "string") throw new RangeError(`25.4 tool needs ${k} (ISO date)`); return D(v); };
const obj = (i: ToolInput, k: string): Record<string, unknown> => { const v = i[k]; if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError(`25.4 tool needs ${k} (object)`); return v as Record<string, unknown>; };
const list = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`25.4 tool needs ${k}[]`); return v as T[]; };
const bigints = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as unknown as T; };
const runOf = (rt: ToolRuntime, i: ToolInput): ClosingNoticeRun => { const r = rt.store.get("closing_notice_runs", str(i, "run_id")); if (!r) throw new RangeError(`no closing_notice_runs ${str(i, "run_id")}`); return r.data as unknown as ClosingNoticeRun; };
const persistRun = (rt: ToolRuntime, ctx: CommandContext, run: ClosingNoticeRun | PostClosingRun): void => { rt.store.put("closing_notice_runs", run.run_id, run as unknown as Record<string, unknown>, ctx.actor, ctx.now); };
const borrowersOf = (i: ToolInput): BorrowerPrivacyFact[] => list<Record<string, unknown>>(i, "borrowers").map((b) => ({ borrower_id: String(b.borrower_id ?? ""), privacy_delivered_at: typeof b.privacy_delivered_at === "string" ? b.privacy_delivered_at : null, customer: b.customer !== false }));
const rowOf = (i: ToolInput, rt: ToolRuntime): OwnershipTransferNotice => { if (typeof i.otn_id === "string" && i.row === undefined) { const r = rt.store.get("ownership_transfer_notices", i.otn_id); if (!r) throw new RangeError(`no ownership_transfer_notices ${i.otn_id}`); return r.data as unknown as OwnershipTransferNotice; } return obj(i, "row") as unknown as OwnershipTransferNotice; };

const NO_DELIVERY_WITHOUT_EVIDENCE = never("DELIVERED_NEEDS_EVIDENCE", "25.4 guardrails: never mark an item delivered without signing-session or manifest evidence", (i) => i.mark_delivered === true || i.force === true || i.without_evidence === true, "an item is marked delivered only from the signing-session audit trail or the signed paper manifest recorded through recordPackageEvidence");
const NO_AUTOPAY_CONDITION = (name: string) => never("REGE_1005_10E1_AUTOPAY_CONDITION", "12 CFR 1005.10(e)(1); 25.4 guardrails: never present autopay as a condition or pre-check enrollment", (i) => i.autopay_prechecked === true || i.autopay_required === true, `${name}: no person may condition an extension of credit on repayment by preauthorized electronic fund transfers; enrollment is optional and never pre-checked`);

export const TOOLS_25_4: readonly ToolDef[] = defineTools("25.4", "disclosure", [
  { name: "composeClosingPackage", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "run_id", "agent_run_id", "consummation_at", "property_state", "transaction_type", "cd");
      const cd = obj(i, "cd"); const cdEscrow = cd.escrow && typeof cd.escrow === "object" ? bigints(cd.escrow as ComposeInput["cd"]["escrow"] & object, ["initial_escrow_payment_cents", "monthly_escrow_cents", "escrowed_costs_year1_cents"]) : null;
      const ea = i.escrow_analysis && typeof i.escrow_analysis === "object" ? (i.escrow_analysis as Record<string, unknown>) : null;
      const escrow_analysis: ComposeInput["escrow_analysis"] = ea ? { analysis: bigints(ea.analysis as ComposeInput["escrow_analysis"] extends infer T ? T extends { analysis: infer A } ? A : never : never, ["target_at_start_cents", "base_payment_cents", "escrowed_costs_year1_cents"]), approved_on: typeof ea.approved_on === "string" ? D(ea.approved_on) : null, rendered_document_id: typeof ea.rendered_document_id === "string" ? ea.rendered_document_id : null } : null;
      const election = i.escrow_election_id ? (rt.store.get("escrow_elections", str(i, "escrow_election_id"))?.data as unknown as EscrowElection | undefined) ?? null : ((i.escrow_election as EscrowElection | undefined) ?? null);
      const state_notice = (i.state_notice as StateNoticeRender | undefined) ?? (i.state_notice_input ? renderStateEscrowNotice({ ...(obj(i, "state_notice_input") as unknown as Parameters<typeof renderStateEscrowNotice>[0]) }) : null);
      const run = composeClosingPackage(ctx.events, { application_id: appOf(i, ctx), loan_id: loanOf(i, ctx), run_id: str(i, "run_id"), agent_run_id: str(i, "agent_run_id"), now: ctx.now, consummation_at: str(i, "consummation_at"), property_state: str(i, "property_state"), transaction_type: str(i, "transaction_type") as "purchase" | "refinance",
        ...(typeof i.principal_dwelling_refinance === "boolean" ? { principal_dwelling_refinance: i.principal_dwelling_refinance } : {}), cd: { disclosure_id: String(cd.disclosure_id ?? ""), cd_version: Number(cd.cd_version ?? NaN), status: String(cd.status ?? ""), escrow: cdEscrow }, escrow_analysis, escrow_election: election,
        borrowers: Array.isArray(i.borrowers) ? borrowersOf(i) : [], hpa: (i.hpa as ComposeInput["hpa"]) ?? null, ...(typeof i.flood_ack_required === "boolean" ? { flood_ack_required: i.flood_ack_required } : {}), state_notice, state_notice_delivered_on: typeof i.state_notice_delivered_on === "string" ? D(i.state_notice_delivered_on) : null,
        ...(Array.isArray(i.jurisdiction_rules) ? { jurisdiction_rules: i.jurisdiction_rules as JurisdictionEscrowRule[] } : {}), ...(typeof i.payment_address_named_at_closing === "boolean" ? { payment_address_named_at_closing: i.payment_address_named_at_closing } : {}), actor: ctx.actor });
      persistRun(rt, ctx, run);
      if (run.status === "exception" && run.refusal) rt.escalations.open({ kind: run.refusal.escalate_to, ownerRole: "officer", applicationId: run.application_id, ...(run.loan_id ? { loanId: run.loan_id } : {}), severity: "sev2", payload: { reason: run.refusal.reason, code: run.refusal.code, citation: run.refusal.citation, state: run.refusal.state, action: "31.1 verification of the state escrow-election notice row required before originating there" } }, ctx.actor);
      return run; }),
    guardrails: [never("ESCROW_STMT_FIGURES_FROM_30_3_ONLY", "25.4 guardrails: never render the escrow statement from figures other than 30.3's approved analysis", (i) => i.escrow_statement_figures_override !== undefined || i.statement_figures !== undefined, "the initial escrow statement renders only from 30.3's frozen/approved analysis (escrow.initial_analysis.approved); ad-hoc figures are refused"), NO_DELIVERY_WITHOUT_EVIDENCE] },
  { name: "evaluateEscrowWaiver", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "election_requested", "criteria");
      const c = obj(i, "criteria");
      const criteria: WaiverCriteria = { ltv_pct: Number(c.ltv_pct ?? NaN), reserves_months_of_ti: Number(c.reserves_months_of_ti ?? 0), mortgage_lates_30_in_12m: Number(c.mortgage_lates_30_in_12m ?? 0), hpml: c.hpml === true, bpmi: c.bpmi === true, delinquent_tax_financed_refi: c.delinquent_tax_financed_refi === true, flood_required_escrow: c.flood_required_escrow === true, blanket_policy_unit: c.blanket_policy_unit === true, state: String(c.state ?? ""), ...(typeof c.state_prohibits_waiver === "boolean" ? { state_prohibits_waiver: c.state_prohibits_waiver } : {}) };
      const evaluation = evaluateEscrowWaiver({ election_requested: str(i, "election_requested") as EscrowElectionKind, criteria, ...(i.waiver_fee_cents !== undefined ? { waiver_fee_cents: cents(i.waiver_fee_cents) } : {}), ...(Array.isArray(i.jurisdiction_rules) ? { jurisdiction_rules: i.jurisdiction_rules as JurisdictionEscrowRule[] } : {}) });
      if (!flag(i, "record")) return evaluation;
      need(i, "election_id", "elected_at", "agent_run_id");
      const r = recordEscrowElection(ctx.events, { application_id: appOf(i, ctx), loan_id: loanOf(i, ctx), election_id: str(i, "election_id"), evaluation, elected_at: str(i, "elected_at"), election_evidence_document_id: typeof i.election_evidence_document_id === "string" ? i.election_evidence_document_id : null, agent_run_id: str(i, "agent_run_id"), actor: ctx.actor });
      rt.store.put("escrow_elections", r.row.election_id, r.row as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      return { evaluation, row: r.row }; }),
    guardrails: [never("WAIVER_OUTSIDE_POLICY", "25.4 guardrails: never approve an escrow waiver outside the partner's written policy or where B2-1.5-04/HPML forbid it", (i) => i.override_policy === true || i.force_waivable === true || i.ignore_hpml === true || i.ignore_bpmi === true, "the waiver decision is the partner's written policy plus B2-1.5-04's non-waivable cases and §1026.35(b)(1); the agent cannot override it"),
      needsRole("WAIVER_POLICY_EXCEPTION_OFFICER", "25.4 escalations: officer (waiver-policy exception requests)", (i) => i.policy_exception === true, ["officer"], "a policy exception request is decided by the partner officer, never by the agent")] },
  { name: "renderStateEscrowNotice", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "state", "election", "ltv_pct", "partner_name", "borrower_names", "property_address", "loan_number");
      const r = renderStateEscrowNotice({ state: str(i, "state"), election: str(i, "election") as EscrowElectionKind, ltv_pct: num(i, "ltv_pct"), partner_name: str(i, "partner_name"), borrower_names: list<string>(i, "borrower_names"), property_address: str(i, "property_address"), loan_number: str(i, "loan_number"), ...(typeof i.single_family_owner_occupied === "boolean" ? { single_family_owner_occupied: i.single_family_owner_occupied } : {}), ...(typeof i.transaction_type === "string" ? { transaction_type: i.transaction_type as "purchase" | "refinance" } : {}), ...(typeof i.cltv_over_80 === "boolean" ? { cltv_over_80: i.cltv_over_80 } : {}) });
      if (!r) return { state: str(i, "state"), required: false, basis: "not_applicable", reason: "no verified escrow-election notice row for the state (jurisdiction_rules)" };
      const notice = rt.notices && Array.isArray(i.recipients) && r.required ? rt.notices.render({ templateCode: r.code, ...(loanOf(i, ctx) ? { loanId: loanOf(i, ctx)! } : {}), recipients: i.recipients as never[], payload: r.payload, asOf: D(str(i, "as_of") || ctx.now.slice(0, 10)) }) : null;
      return { ...r, notice_id: notice?.id ?? null }; }) },
  { name: "checkPrivacyNotice", kind: "act", handler: compute((i, ctx) => {
      need(i, "borrowers", "consummation_at");
      const result = checkPrivacyNotice(borrowersOf(i), str(i, "consummation_at"));
      const app = (i.application_id as string | undefined) ?? ctx.applicationId;
      const event = app ? recordPrivacyGate(ctx.events, { application_id: app, loan_id: loanOf(i, ctx), result, consummation_at: str(i, "consummation_at"), actor: ctx.actor }) : null;
      return { ...result, event_id: event?.id ?? null }; }) },
  { name: "runCdEscrowConsistency", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "cd_version", "cd");
      const cd = bigints(obj(i, "cd") as unknown as Parameters<typeof runCdEscrowConsistency>[0]["cd"] & object, ["initial_escrow_payment_cents", "monthly_escrow_cents", "escrowed_costs_year1_cents"]);
      const analysis = i.analysis && typeof i.analysis === "object" ? bigints(i.analysis as NonNullable<Parameters<typeof runCdEscrowConsistency>[0]["analysis"]> & object, ["target_at_start_cents", "base_payment_cents", "escrowed_costs_year1_cents"]) : null;
      const r = runCdEscrowConsistency({ application_id: appOf(i, ctx), cd_version: num(i, "cd_version"), cd, analysis, now: ctx.now });
      rt.store.put("cd_consistency_checks", r.check.check_id, { ...r.check, blocks_gate: r.blocks_gate, gate: r.gate, corrected_cd: r.corrected_cd }, ctx.actor, ctx.now);
      return r; }),
    guardrails: [never("ESCROW_STMT_FIGURES_FROM_30_3_ONLY", "25.4 guardrails: never render the escrow statement from figures other than 30.3's approved analysis", (i) => i.analysis_override !== undefined, "the analysis side of the check is 30.3's approved analysis, never a substituted figure")] },
  { name: "deliverPackage", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "run_id", "channel", "delivered_at");
      const ch = str(i, "channel"); if (ch !== "signing_session" && ch !== "paper_manifest") throw new RangeError("channel must be signing_session (26.2) or paper_manifest (settlement_agent)");
      const run = deliverPackage(ctx.events, runOf(rt, i), { channel: ch, session_id: typeof i.session_id === "string" ? i.session_id : null, delivered_at: str(i, "delivered_at"), actor: ctx.actor });
      persistRun(rt, ctx, run); return run; }),
    guardrails: [NO_DELIVERY_WITHOUT_EVIDENCE] },
  { name: "recordPackageEvidence", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "run_id", "manifest", "manifest_document_id");
      const r = recordPackageEvidence(ctx.events, runOf(rt, i), { manifest: list<ManifestEntry>(i, "manifest"), manifest_document_id: str(i, "manifest_document_id"), ...(Array.isArray(i.borrowers) ? { borrowers: borrowersOf(i) } : {}), actor: ctx.actor });
      persistRun(rt, ctx, r.run);
      if (r.escrow_account && r.run.loan_id) rt.store.put("escrow_accounts", r.run.loan_id, { ...r.escrow_account }, ctx.actor, ctx.now);
      return { run: r.run, escrow_account: r.escrow_account, missing_required: r.missing_required, privacy_gate: r.privacy_gate, combined_ms2: r.combined_ms2 ? { timer: r.combined_ms2.timer, satisfied_at_settlement: true } : null }; }),
    guardrails: [NO_DELIVERY_WITHOUT_EVIDENCE] },
  { name: "schedulePostClosingRun", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "complete") {
        need(i, "run_id", "completed_on", "sent");
        const run = completePostClosingRun(ctx.events, runOf(rt, i) as unknown as PostClosingRun, { completed_on: dateIn(i, "completed_on"), sent: list<{ notice_code: string; sent_on: PlainDate; channel: "mail" | "edelivery"; manifest_id: string }>(i, "sent"), actor: ctx.actor });
        persistRun(rt, ctx, run); return run;
      }
      need(i, "run_id", "agent_run_id", "disbursement_date", "first_payment_date");
      const run = schedulePostClosingRun(ctx.events, { application_id: appOf(i, ctx), loan_id: loanOf(i, ctx), run_id: str(i, "run_id"), agent_run_id: str(i, "agent_run_id"), now: ctx.now, disbursement_date: dateIn(i, "disbursement_date"), first_payment_date: dateIn(i, "first_payment_date"), escrow_statement_deferred: flag(i, "escrow_statement_deferred"), ...(Array.isArray(i.state_post_closing_codes) ? { state_post_closing_codes: i.state_post_closing_codes as string[] } : {}), cd_disclosure_id: typeof i.cd_disclosure_id === "string" ? i.cd_disclosure_id : null, actor: ctx.actor });
      persistRun(rt, ctx, run); return run; }),
    guardrails: [NO_AUTOPAY_CONDITION("schedulePostClosingRun")] },
  { name: "evaluateOwnershipTransfer", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "borrower_report") {
        need(i, "otn_id", "reported_on", "channel");
        const r = recordBorrowerReport(ctx.events, { application_id: appOf(i, ctx), loan_id: loanOf(i, ctx), row: rowOf(i, rt), reported_on: dateIn(i, "reported_on"), channel: str(i, "channel") as "call" | "portal" | "chat", payment_sent_to_fnma: flag(i, "payment_sent_to_fnma"), payment_details: i.payment_details ? bigints(i.payment_details as { amount_cents: bigint; sent_on: PlainDate }, ["amount_cents"]) : null, actor: ctx.actor });
        rt.store.put("ownership_transfer_notices", r.row.otn_id, r.row as unknown as Record<string, unknown>, ctx.actor, ctx.now);
        return { row: r.row, script: r.script, misdirected_payment_case: r.misdirected_payment_case, on_time: r.on_time };
      }
      if (i.op === "seed_tax_reporting") {
        need(i, "loan_id", "note_date", "disbursement_date", "first_period_end", "principal_cents", "note_rate_pct", "points", "property_address_id", "payer_of_record_borrower_id", "source_cd_disclosure_id", "handed_off_at");
        const pts = bigints(obj(i, "points") as unknown as Parameters<typeof seedTaxReporting>[0]["points"], ["principal_cents", "borrower_paid_cents", "seller_paid_cents"]);
        const seeds = seedTaxReporting({ loan_id: str(i, "loan_id"), note_date: dateIn(i, "note_date"), disbursement_date: dateIn(i, "disbursement_date"), first_period_end: dateIn(i, "first_period_end"), principal_cents: cents(i.principal_cents), note_rate_pct: str(i, "note_rate_pct"), prepaid_interest_cents: i.prepaid_interest_cents !== undefined ? cents(i.prepaid_interest_cents) : null, points: pts, mi_premiums_paid_at_closing_cents: cents(i.mi_premiums_paid_at_closing_cents), property_address_id: str(i, "property_address_id"), payer_of_record_borrower_id: str(i, "payer_of_record_borrower_id"), source_cd_disclosure_id: str(i, "source_cd_disclosure_id") });
        const h = handoffTaxReportingSeeds(ctx.events, { application_id: appOf(i, ctx), loan_id: seeds.loan_id, seeds, handed_off_at: str(i, "handed_off_at"), actor: ctx.actor });
        rt.store.put("tax_reporting_seeds", h.seeds.loan_id, h.seeds as unknown as Record<string, unknown>, ctx.actor, ctx.now);
        return h.seeds;
      }
      need(i, "otn_id", "loan_id", "covered_person", "acquisition_date", "as_of");
      const cp = str(i, "covered_person"); if (cp !== "fannie_mae" && cp !== "sm_warehouse_assignee" && cp !== "other") throw new RangeError("covered_person must be fannie_mae | sm_warehouse_assignee | other");
      const r = evaluateOwnershipTransfer(ctx.events, { application_id: appOf(i, ctx), otn_id: str(i, "otn_id"), loan_id: str(i, "loan_id"), covered_person: cp, ...(typeof i.date_basis === "string" ? { date_basis: i.date_basis as "acquirer_books" | "transferor_books" } : {}), acquisition_date: dateIn(i, "acquisition_date"), transferor_books_date: typeof i.transferor_books_date === "string" ? D(i.transferor_books_date) : null,
        ...(typeof i.written_fnma_instruction_on_file === "boolean" ? { written_fnma_instruction_on_file: i.written_fnma_instruction_on_file } : {}), sold_on: typeof i.sold_on === "string" ? D(i.sold_on) : null, as_of: dateIn(i, "as_of"), ...(typeof i.repurchase_agreement === "boolean" ? { repurchase_agreement: i.repurchase_agreement } : {}), ...(typeof i.partial_interest_same_agent === "boolean" ? { partial_interest_same_agent: i.partial_interest_same_agent } : {}), ...(typeof i.warehouse_legal_form === "string" ? { warehouse_legal_form: i.warehouse_legal_form as "secured_loan_to_partner" | "assignment_at_funding" } : {}), actor: ctx.actor });
      rt.store.put("ownership_transfer_notices", r.row.otn_id, r.row as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      return r.row; }),
    guardrails: [needsRole("SEND_ON_BEHALF_IS_OFFICER_DECISION", "25.4 escalations: officer (any decision to send on Fannie Mae's behalf)", (i) => i.written_fnma_instruction_on_file === true, ["officer"], "flipping the row to sender=servicer_on_behalf is the partner officer's decision on the written Fannie Mae instruction")] },
  { name: "renderOwnershipNotice", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "send") {
        need(i, "otn_id", "notice_id", "sent_on", "channel");
        const r = sendOwnershipNotice(ctx.events, { application_id: appOf(i, ctx), loan_id: loanOf(i, ctx), row: rowOf(i, rt), notice_id: str(i, "notice_id"), sent_on: dateIn(i, "sent_on"), channel: str(i, "channel") as "mail" | "edelivery", esign_scope: typeof i.esign_scope === "string" ? i.esign_scope : null, actor: ctx.actor });
        rt.store.put("ownership_transfer_notices", r.row.otn_id, r.row as unknown as Record<string, unknown>, ctx.actor, ctx.now);
        return { row: r.row, on_time: r.on_time };
      }
      need(i, "covered_person_contact", "agent", "borrower_names", "property_address", "loan_number");
      const row = rowOf(i, rt);
      const r = renderOwnershipNotice({ row, covered_person_contact: obj(i, "covered_person_contact") as unknown as CoveredPersonContact, agent: obj(i, "agent") as unknown as OwnershipNoticeInput["agent"], mers_registered: i.mers_registered !== false, county_recorder: typeof i.county_recorder === "string" ? i.county_recorder : null, borrower_names: list<string>(i, "borrower_names"), property_address: str(i, "property_address"), loan_number: str(i, "loan_number"), ...(typeof i.written_fnma_instruction_on_file === "boolean" ? { written_fnma_instruction_on_file: i.written_fnma_instruction_on_file } : {}) });
      const notice = rt.notices && Array.isArray(i.recipients) ? rt.notices.render({ templateCode: r.template, ...(loanOf(i, ctx) ? { loanId: loanOf(i, ctx)! } : {}), recipients: i.recipients as never[], payload: r.payload, asOf: D(str(i, "as_of") || ctx.now.slice(0, 10)) }) : null;
      return { ...r, notice_id: notice?.id ?? null }; }),
    guardrails: [never("NO_FNMA_NAME_WITHOUT_INSTRUCTION", "25.4 guardrails: never send a §1026.39 notice in Fannie Mae's name without a written Fannie Mae instruction on file", (i) => { const row = (i.row as { covered_person?: string } | undefined); return (row?.covered_person === "fannie_mae" || i.covered_person === "fannie_mae") && i.written_fnma_instruction_on_file !== true; }, "Fannie Mae sends its own loan purchase letter; the platform records the expectation and never issues the fallback template in Fannie Mae's name without its written instruction"),
      never("NO_INVENTED_FNMA_CONTACT", "25.4 guardrails: never invent Fannie Mae contact details", (i) => { const c = i.covered_person_contact as { source?: string } | undefined; return !!c && c.source !== "fnma_written_instruction" && c.source !== "sm_legal_entity"; }, "(d)(1) contact details come from Fannie Mae's written instruction (or SM's own legal entity as assignee), never generated")] },
  { name: "writeDecision", kind: "write", handler: (i, ctx) => {
      if (i.package_decision && typeof i.package_decision === "object") { const p = i.package_decision as Record<string, unknown>; const rec = decisionRecord({ run_id: String(p.run_id ?? ""), cd_disclosure_id: typeof p.cd_disclosure_id === "string" ? p.cd_disclosure_id : null, items: Array.isArray(p.items) ? (p.items as never[]) : [], gates: (p.gates as Record<string, { open: boolean; reason?: string }>) ?? {}, consistency: (p.consistency as never) ?? null, escrow_election: (p.escrow_election as never) ?? null, ownership_transfer: (p.ownership_transfer as never) ?? null, seeds: (p.seeds as never) ?? null, rationale: str(i, "rationale"), model_version: str(i, "model_version"), prompt_version: str(i, "prompt_version"), ...(typeof i.confidence === "number" ? { confidence: i.confidence } : {}) }); return decision()({ ...i, rationale: JSON.stringify(rec) }, ctx); }
      return decision()(i, ctx); } },
]);
