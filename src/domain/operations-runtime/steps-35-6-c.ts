/**
 * §35.6 steps `funded` → `boarded` (group C): the hand-off snapshot (rule 6), 30.2's boarding through this process's own
 * `orchestration.snapshot` / `orchestration.fund` tools (one `loans` row; idempotent by application id), then the owners'
 * post-funding work in the owners' order as the owners' agents — 30.3 `buildEscrowLines{op: establish}` (the escrow account
 * at funding; REGX_1024_17C2's gate is 30.3's), 25.4 `schedulePostClosingRun` (the post-closing notices), 30.4 `openHandoff`
 * (the servicing hand-off items from `boarded_at`). Every fact the owners are handed is read from the record (facts-35-6*.ts);
 * `loan.staged` / `loan.boarded` are 30.2's events (never appended here) and `loan.boarded` exits the step.
 */
import type { StepDef, StepOutcome } from "./steps-35-6.ts";
import type { OrchRecord } from "./facts-35-6.ts";
import { RecordGap, src } from "./facts-35-6.ts";
import { escrowFacts, cdRow, loanTerms, closingFacts, partyFacts, type ClosingFacts } from "./facts-35-6-b.ts";
import { wireInstruction, commitmentFacts, closingUlad, deliveryGateFacts, loanFileBase, qmConsummationInput } from "./facts-35-6-c.ts";
import { exitOn, DISCLOSURE, ESCROW, COMPLIANCE, WAREHOUSE, S, civil, recordSnapshot } from "./steps-35-6-b.ts";
import { FANNIE_MAE_ORG_ID } from "../warehouse/ops-27-1.ts";
import { ORCH_ACTOR } from "./orchestration-35-6.ts";
import { storeDocument } from "./documents-port-35-6.ts";

type Row = Record<string, unknown>;
const BOARDING = { kind: "agent", id: "boarding" } as const;
const CLOSER = { kind: "agent", id: "title-closing" } as const;
export const SECONDARY = { kind: "agent", id: "secondary" } as const;
const UNDERWRITER = { kind: "agent", id: "underwriter" } as const;
/** Rule 4: the FAKE Loan Delivery operator acts after the delay as a human of the role (INTEGRATIONS=fake); a person's queue otherwise. */
const FAKE_OPERATOR = { kind: "human", id: "FAKE:fnma_portal_operator", role: "fnma_portal_operator" } as const;
export const deliveryIdOf = (rec: OrchRecord): string => `DLV-${rec.app.id.slice(0, 8)}`;
export function needClosing(rec: OrchRecord): ClosingFacts { const c = closingFacts(rec); if (!c) throw new RecordGap("closing.scheduled", "no closing on the record (26.2)"); return c; }
export async function servicingLoanNumber(ctx: Parameters<NonNullable<StepDef["actions"]>>[0], loanId: string): Promise<string> {
  const row = (await ctx.rt.db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [loanId]))[0];
  if (!row) throw new RecordGap("loans", `no loans row ${loanId} (30.2)`);
  return row.n;
}
/** 30.2's servicing loan for the application once the hand-off ran (applications.loan_id ↔ loans.origination_application_id). */
export const loanIdOf = (rec: OrchRecord): string | null => rec.loanId ?? S(rec.payload("loan.boarded")?.["loan_id"]) ?? S(rec.payload("loan.staged")?.["loan_id"]) ?? null;

/** The funded step exits on 30.2's `loan.boarded` only once the owners' post-funding work is on the record too (30.3's establishment when escrowed, 25.4's post-closing run, 30.4's hand-off) — a refusal after boarding never skips them (rule 10). */
const fundedComplete = (rec: OrchRecord) => {
  const boarded = rec.last("loan.boarded"); if (!boarded) return null;
  const escrowOk = !escrowFacts(rec) || rec.has("escrow.account.established");
  const postClosing = rec.has("notice.post_closing_run.scheduled") || rec.entities("closing_notice_runs", (d) => d["kind"] === "post_closing" || String(d["run_id"] ?? "").startsWith("RUN-POST-")).length > 0;
  const handoff = rec.has("servicing_handoff.opened") || rec.entities("servicing_handoffs").length > 0;
  return escrowOk && postClosing && handoff ? boarded : null;
};
export const fundedStep: StepDef = {
  name: "funded",
  exit: fundedComplete,
  clocked: () => true,
  actions: async (ctx): Promise<StepOutcome> => {
    let rec = ctx.rec; const now = ctx.now;
    const funded = rec.last("loan.funded"); if (!funded) throw new RecordGap("loan.funded", "26.3's loan.funded is not on the record");
    // 27.1 rule 7: the facility's wire fee per outbound advance (pass-through of the bank's cost; the payoff carries it as fees outstanding) — assessed once the advance wire is out, as `warehouse`
    const advanceOut = rec.last("warehouse.advance.funded");
    if (advanceOut && !rec.has("warehouse.fee.assessed", (p) => p["kind"] === "wire_out")) {
      await ctx.run({ process: "27.1", name: "assessFee", actor: WAREHOUSE, input: { advance_id: String(advanceOut.payload["advance_id"]), facility_id: String(advanceOut.payload["facility_id"]), kind: "wire_out", on: String(advanceOut.payload["advance_date"]) }, detail: { sources: { advance: src("event", `warehouse.advance.funded:${advanceOut.id}`, "27.1") } } });
      rec = await ctx.refresh();
    }
    // rule 6: the snapshot from the record (its sources and gaps stored), then 30.2's hand-off from that row — both this process's own tools, so the guardrails (SNAPSHOT_CITES_SOURCES, FIXTURE_REFUSED_IN_PRODUCTION, NO_CLIENT_STATE) and the decision record apply as on the hosted API
    if (!loanIdOf(rec) && !rec.has("loan.staged")) {
      const snap = await ctx.run<Row>({ process: "35.6", name: "orchestration.snapshot", actor: ORCH_ACTOR, input: { at: now }, detail: { sources: { funded: src("event", `loan.funded:${funded.id}`, "26.3") } } });
      if (snap["refused_code"]) return { hold: { reason: "gate_closed", gate: String(snap["refused_code"]), detail: { snapshot_id: snap["snapshot_id"], gaps: snap["gaps"], environment: snap["environment"] } } };
      await ctx.run({ process: "35.6", name: "orchestration.fund", actor: ORCH_ACTOR, input: { snapshot_id: String(snap["snapshot_id"]), at: now }, detail: { snapshot_id: snap["snapshot_id"], snapshot_hash: snap["snapshot_hash"], fixture_used: snap["fixture_used"], gaps: snap["gaps"] } });
      rec = await ctx.refresh();
    }
    const loanId = loanIdOf(rec); if (!loanId) throw new RecordGap("applications.loan_id", "30.2's hand-off left no servicing loan on the application");
    const terms = loanTerms(rec); const cd = cdRow(rec); const escrow = escrowFacts(rec);
    const disbursementDate = String(funded.payload["disbursement_date"]);
    const noteTerms = ((rec.entities("closing_data_snapshots").at(-1)?.data["payload"] as Row | undefined)?.["note_terms"] as Row | undefined) ?? null;
    const firstPayment = S(noteTerms?.["first_payment_date"]) ?? S(rec.payload("loan.boarded")?.["first_payment_date"]) ?? S(funded.payload["first_payment_date"]);
    if (!firstPayment) throw new RecordGap("closing_data_snapshots.note_terms.first_payment_date", "26.1's note terms carry no first payment date");
    // 24.5 rule 8: the verified origination rows become 9.1's insurance_policies and 9.6's flood row on the loan at loan.funded (`flood.lol.enrolled` when the LOL contract is linked; W-007 otherwise) — as title-closing, on the loan
    const floodRow = rec.entities("flood_determinations").at(-1) ?? null;
    if (floodRow && !rec.has("flood.lol.enrolled") && !rec.entities("flood_determinations", (d) => d["loan_id"] === loanId).length) {
      await ctx.run({ process: "24.5", name: "seedEscrowLines", actor: CLOSER, scope: { loanId }, input: { op: "handoff", application_id: rec.app.id, loan_id: loanId, funded_at: String(funded.payload["funded_at"] ?? funded.occurredAt), lol_contract_linked: floodRow.data["lol_contract_linked"] === true }, detail: { sources: { determination: src("entity", `flood_determinations:${floodRow.id}:${floodRow.version}`, "24.5"), funded: src("event", `loan.funded:${funded.id}`, "26.3") } } });
      rec = await ctx.refresh();
    }
    // 30.3 rule 6: the escrow account established at loan.funded from the frozen analysis (the refresh confirms or supersedes it) — as `escrow`, on the loan
    if (escrow && !rec.has("escrow.account.established")) {
      await ctx.run({ process: "30.3", name: "buildEscrowLines", actor: ESCROW, scope: { loanId }, input: { op: "establish", application_id: rec.app.id, loan_id: loanId, analysis_id: escrow.analysis.id, at: now }, detail: { sources: { analysis: escrow.source, funded: src("event", `loan.funded:${funded.id}`, "26.3") } } });
      rec = await ctx.refresh();
    }
    // 25.4: the post-closing notice run (first-payment letter, initial escrow statement follow-ups, state post-closing notices) from the disbursement and first payment dates — as `disclosure`, on the loan
    if (!rec.has("notice.post_closing_run.scheduled") && !rec.entities("closing_notice_runs", (d) => String(d["run_id"] ?? "").startsWith("RUN-POST-")).length) {
      await ctx.run({ process: "25.4", name: "schedulePostClosingRun", actor: DISCLOSURE, scope: { loanId }, input: { application_id: rec.app.id, loan_id: loanId, run_id: `RUN-POST-${rec.app.id.slice(0, 8)}`, agent_run_id: ctx.runId ? `sweep:${ctx.runId}` : `pass:${civil(rec, now)}`, disbursement_date: disbursementDate, first_payment_date: firstPayment, escrow_statement_deferred: false, ...(cd ? { cd_disclosure_id: cd.id } : {}) }, detail: { sources: { funded: src("event", `loan.funded:${funded.id}`, "26.3"), note_terms: src("entity", `closing_data_snapshots:${rec.entities("closing_data_snapshots").at(-1)?.id ?? ""}`, "26.1"), lock: terms.loan_amount_cents.source } } });
      rec = await ctx.refresh();
    }
    // 30.4: the servicing hand-off opened on the boarded loan (HO items from boarded_at; the MI certificate when 24.6 issued one) — as `boarding`, on the loan
    const boarded = rec.last("loan.boarded");
    if (boarded && !rec.has("servicing_handoff.opened") && !rec.entities("servicing_handoffs").length) {
      const mi = rec.entities("mi_certificates", (d) => ["active", "activation_requested", "committed", "issued"].includes(String(d["status"]))).length > 0;
      await ctx.run({ process: "30.4", name: "openHandoff", actor: BOARDING, scope: { loanId }, input: { loan_id: loanId, application_id: rec.app.id, boarded_at: String(boarded.payload["boarded_at"] ?? boarded.occurredAt), first_payment_date: firstPayment, mi_certificates_present: mi, escrowed: !!escrow }, detail: { sources: { boarded: src("event", `loan.boarded:${boarded.id}`, "30.2"), mi: mi ? src("entity", `mi_certificates:${rec.entities("mi_certificates").at(-1)!.id}`, "24.6") : src("derived", "no active mi_certificates row", "24.6") } } });
    }
    return {};
  },
};

// ───────────────────────────── boarded → package_frozen: 29.1's closed status, 23.1's final match, 29.3's package ─────────────────────────────
export const boardedStep: StepDef = {
  name: "boarded",
  exit: exitOn("delivery.package.frozen"),
  clocked: () => true,
  actions: async (ctx): Promise<StepOutcome> => {
    let rec = ctx.rec; const now = ctx.now; const closing = needClosing(rec);
    const loanId = loanIdOf(rec); if (!loanId) throw new RecordGap("applications.loan_id", "no servicing loan (30.2)");
    const funded = rec.last("loan.funded"); if (!funded) throw new RecordGap("loan.funded", "no loan.funded (26.3)");
    const sln = await servicingLoanNumber(ctx, loanId);
    const noteTerms = ((rec.entities("closing_data_snapshots").at(-1)?.data["payload"] as Row | undefined)?.["note_terms"] as Row | undefined) ?? null;
    // 27.1 rule 4 (eNote): the eRegistry's notification that SM was added as Secured Party at registration (26.2's enote.registered names SM as Delegatee) → `secured_control`, the collateral status 27.1 demands before a Transfer of Control — as `warehouse`
    const registeredNote = rec.last("enote.registered"); const advanceFunded = rec.last("warehouse.advance.funded");
    if (closing.note_form === "enote" && registeredNote && advanceFunded && !rec.has("warehouse.secured_party.added")) {
      await ctx.run({ process: "27.1", name: "trackCollateral", actor: WAREHOUSE, input: { op: "secured_party_added", advance_id: String(advanceFunded.payload["advance_id"]), facility_id: String(advanceFunded.payload["facility_id"]), min: String(registeredNote.payload["min"]), added_at: String(registeredNote.payload["registered_at"] ?? registeredNote.occurredAt), ...(S(registeredNote.payload["txn_id"]) ? { notification_id: String(registeredNote.payload["txn_id"]) } : {}) },
        detail: { sources: { enote: src("event", `enote.registered:${registeredNote.id}`, "26.2"), advance: src("event", `warehouse.advance.funded:${advanceFunded.id}`, "27.1") } } });
      rec = await ctx.refresh();
    }
    // 29.1: the best-efforts commitment moves to closed status once the loan is disbursed (PE–WL: closed = funds disbursed; FNMA_PEWL_CLOSED_STATUS_1BD) — as `secondary`
    const c = commitmentFacts(rec);
    if (c.row && c.status !== "closed" && !rec.has("commitment.closed_status.set") && !rec.has("commitment.closed")) {
      await ctx.run({ process: "29.1", name: "setClosedStatus", actor: SECONDARY, scope: { loanId }, input: { commitment_id: c.commitment_id, disbursement_date: String(funded.payload["disbursement_date"]), ...(noteTerms ? { first_payment_date: String(noteTerms["first_payment_date"]) } : {}), loan_id: loanId, funded: true, at: now }, detail: { sources: { commitment: c.source, funded: src("event", `loan.funded:${funded.id}`, "26.3") } } });
      rec = await ctx.refresh();
    }
    // 23.1: the final DU submission recorded against the closing terms (the closed-loan snapshot hash 29.3's DU Compare gate reads) — as `underwriter`
    if (!rec.has("du.final_submission.recorded")) {
      const u = closingUlad(rec);
      await ctx.run({ process: "23.1", name: "assertFinalSubmissionMatches", actor: UNDERWRITER, input: { op: "record_final", casefile_id: u.casefile_id, submission_number: u.submission_number, closing: u.snapshot, command: "submitDelivery" }, detail: { sources: u.sources, submission_number: u.submission_number } });
      rec = await ctx.refresh();
    }
    // 25.2: the UCD generated from the final CD and submitted to Fannie Mae's UCD collection (the FAKE collection over DI) — `ucd.accepted{is_final}` is 29.3's ucd_accepted prerequisite — as `disclosure`
    if (!rec.has("ucd.accepted")) {
      // 29.3 R3(a)/(b): SID 322 is `du_casefiles.casefile_id` of the final submission and `ucd_submissions.casefile_id_ucd` must equal it — the UCD is keyed by that id, never by a generated one
      const cd = cdRow(rec); const du = rec.last("du.final_submission.recorded"); if (!cd) throw new RecordGap("disclosures:cd", "no CD row (25.2)"); if (!du) throw new RecordGap("du.final_submission.recorded", "no final DU submission (23.1)");
      const ucdId = `UCD-${rec.app.id.slice(0, 8)}-1`;
      if (!rec.entities("ucd_submissions", (d) => d["ucd_submission_id"] === ucdId).length) await ctx.run({ process: "25.2", name: "generateUcd", actor: DISCLOSURE, input: { ucd_submission_id: ucdId, du_casefile_id: String(du.payload["casefile_id"]), disclosure_id: cd.id, loan_id: loanId }, detail: { sources: { cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2"), du: src("event", `du.final_submission.recorded:${du.id}`, "23.1") } } });
      const response = ctx.fakes.ucd.respond(ucdId, String(du.payload["casefile_id"]));
      await ctx.run({ process: "25.2", name: "submitUcd", actor: DISCLOSURE, input: { ucd_submission_id: ucdId, response, channel: "di", at: now }, detail: { fake: ctx.fakes.ucd.vendorName, ucd_submission_id: ucdId } });
      rec = await ctx.refresh();
    }
    // 23.4: the consummation-stage QM/HPML/HOEPA determination computed from the final CD (the row 23.4's qmDeterminationGate reads on submitDelivery: QM_CONSUMMATION_ROW_NOT_FROM_FINAL_CD otherwise) — as compliance-tester
    if (!rec.has("compliance.qm.determined", (p) => p["stage"] === "consummation")) {
      const cd = cdRow(rec); const apr = rec.entities("apr_calculations", (d) => d["checkpoint"] === "cd").at(-1);
      if (!cd) throw new RecordGap("disclosures:cd", "no CD row (25.2)"); if (!apr) throw new RecordGap("apr_calculations", "no 25.1 APR calculation for the CD");
      const q = await qmConsummationInput(rec, { closing, loan_id: loanId, apr, cd });
      await ctx.run({ process: "23.4", name: "runQmTests", actor: COMPLIANCE, input: q.input, detail: { sources: q.sources, stage: "consummation" } });
      rec = await ctx.refresh();
    }
    // 25.1's pre-delivery checkpoint through 25.2's gate (SM_O61_COMPLIANCE_PASS_DELIVERY_GATE; the owner's fresh run is reused, else re-derived over the record's snapshot) — as compliance-tester
    if (!rec.has("compliance.gate.opened", (p) => p["gate"] === "delivery")) {
      const terms = loanTerms(rec); const cd = cdRow(rec)!; const apr = rec.entities("apr_calculations", (d) => d["checkpoint"] === "cd").at(-1);
      if (!apr) throw new RecordGap("apr_calculations", "no 25.1 APR calculation for the CD");
      await ctx.run({ process: "25.2", name: "assertGateOpen", actor: COMPLIANCE, scope: { loanId: null }, input: { gate: "SM_O61_COMPLIANCE_PASS_DELIVERY_GATE", disclosure_id: cd.id, snapshot: recordSnapshot(rec, closing, now, terms, apr, cd) }, detail: { sources: { apr: src("entity", `apr_calculations:${apr.id}:${apr.version}`, "25.1"), cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2") } } });
      rec = await ctx.refresh();
    }
    // 29.3 as `secondary`: the loan file from the record, the SFCs, the ULDD build, the schema check, EarlyCheck over the build, the freeze (delivery.package.frozen exits the step)
    const wire = wireInstruction(rec); const deliveryId = deliveryIdOf(rec);
    const lf = await loanFileBase(rec, { loan_id: loanId, seller_loan_number: sln, closing, wire: wire.wire });
    const opened = await ctx.run<Row>({ process: "29.3", name: "collectPrerequisites", actor: SECONDARY, scope: { loanId }, input: { base: lf.base, delivery_id: deliveryId }, detail: { sources: { ...lf.sources, wire: wire.source }, delivery_id: deliveryId } });
    const missing = (opened["missing"] as string[] | undefined) ?? [];
    if (missing.length) throw new RecordGap(`29.3:${missing[0]}`, `29.3 prerequisites missing on the record: ${missing.join(", ")}`);
    await ctx.run({ process: "29.3", name: "assignSfcs", actor: SECONDARY, scope: { loanId }, input: { delivery_id: deliveryId }, detail: { delivery_id: deliveryId } });
    if (!rec.has("delivery.uldd.built")) {
      const built = await ctx.run<Row>({ process: "29.3", name: "buildUlddXml", actor: SECONDARY, scope: { loanId }, input: { delivery_id: deliveryId }, detail: { delivery_id: deliveryId } });
      if (built["status"] !== "built") return { hold: { reason: "gate_closed", gate: String(built["gate"] ?? "FNMA_C1_2_02_ULDD_BUILD"), detail: { reason: built["reason"] ?? null, mismatches: built["mismatches"] ?? null, escalation_id: built["escalation_id"] ?? null } } };
      rec = await ctx.refresh();
    }
    await ctx.run({ process: "29.3", name: "validateSchema", actor: SECONDARY, scope: { loanId }, input: { delivery_id: deliveryId }, detail: { delivery_id: deliveryId, read: true } });
    if (!rec.has("earlycheck.completed", (p) => p["file_kind"] !== "du_spec_3_4" && p["clean"] === true)) {
      const ec = await ctx.run<Row>({ process: "29.3", name: "runEarlyCheck", actor: SECONDARY, scope: { loanId }, input: { delivery_id: deliveryId }, detail: { delivery_id: deliveryId } });
      if (ec["clean"] !== true) return { hold: { reason: "gate_closed", gate: "FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE", detail: { run_id: ec["run_id"] ?? null, edits: ec["edits"] ?? null, completed: ec["completed"] ?? null } } };
      rec = await ctx.refresh();
    }
    if (!rec.has("delivery.package.frozen")) await ctx.run({ process: "29.3", name: "freezePackage", actor: SECONDARY, scope: { loanId }, input: { delivery_id: deliveryId }, detail: { delivery_id: deliveryId } });
    return {};
  },
};

// ───────────────────────────── package_frozen → delivered: 29.4's registration, the operator task, the eNote transfer, the operator's evidence ─────────────────────────────
export const packageFrozenStep: StepDef = {
  name: "package_frozen",
  exit: exitOn("delivery.submitted"),
  clocked: () => true,
  actions: async (ctx): Promise<StepOutcome> => {
    let rec = ctx.rec; const now = ctx.now; const closing = needClosing(rec);
    const loanId = loanIdOf(rec); if (!loanId) throw new RecordGap("applications.loan_id", "no servicing loan (30.2)");
    const frozen = rec.last("delivery.package.frozen"); if (!frozen) throw new RecordGap("delivery.package.frozen", "no frozen package (29.3)");
    const funded = rec.last("loan.funded")!; const deliveryId = S(frozen.payload["delivery_id"]) ?? deliveryIdOf(rec);
    const noteTerms = ((rec.entities("closing_data_snapshots").at(-1)?.data["payload"] as Row | undefined)?.["note_terms"] as Row | undefined) ?? null;
    const terms = loanTerms(rec); const c = commitmentFacts(rec); const wire = wireInstruction(rec); const registered = rec.last("enote.registered");
    // 29.4 register: the delivery with Supermortgage's approved wire instruction and payee code, 29.1's commitment, 30.2's loan — once
    let delivery = rec.entities("deliveries", (d) => d["delivery_id"] === deliveryId).at(-1) ?? null;
    if (!delivery) {
      await ctx.run({ process: "29.4", name: "openOperatorTask", actor: SECONDARY, scope: { loanId }, input: { op: "register", delivery_id: deliveryId, loan_id: loanId, application_id: rec.app.id, partner_id: rec.app.partner_party_id, seller_loan_number: await servicingLoanNumber(ctx, loanId), commitment_id_fnma: c.commitment_id_fnma, commitment_expires_on: c.expires_on, note_form: closing.note_form, enote_indicator: closing.note_form === "enote", ...(registered ? { min: String(registered.payload["min"]) } : {}),
        upb_cents: String(terms.loan_amount_cents.value), note_rate: terms.note_rate_pct.value, pass_through_rate: c.pass_through_rate, servicing_fee_rate: c.servicing_fee_rate, commitment_price: c.price, remittance_type: c.remittance_type, disbursement_date: String(funded.payload["disbursement_date"]), first_payment_date: String(noteTerms?.["first_payment_date"] ?? ""), wire_instruction_id: String(wire.wire["wire_instruction_id"]), payee_code: String(wire.wire["payee_code"]), commitment_closed: c.status === "closed" || rec.has("commitment.closed_status.set"), wire: wire.wire, at: now },
        detail: { sources: { commitment: c.source, wire: wire.source, funded: src("event", `loan.funded:${funded.id}`, "26.3"), lock: terms.loan_amount_cents.source, ...(registered ? { enote: src("event", `enote.registered:${registered.id}`, "26.2") } : {}) } } });
      rec = await ctx.refresh(); delivery = rec.entities("deliveries", (d) => d["delivery_id"] === deliveryId).at(-1) ?? null;
    }
    if (!delivery?.data["package_id"]) {
      await ctx.run({ process: "29.4", name: "openOperatorTask", actor: SECONDARY, scope: { loanId }, input: { op: "frozen", delivery_id: deliveryId, package_id: String(frozen.payload["package_id"]), sha256: String(frozen.payload["sha256"]), file_name: String(frozen.payload["file_name"] ?? `${String(frozen.payload["package_id"])}.xml`), frozen_at: frozen.occurredAt }, detail: { sources: { frozen: src("event", `delivery.package.frozen:${frozen.id}`, "29.3") } } });
      rec = await ctx.refresh(); delivery = rec.entities("deliveries", (d) => d["delivery_id"] === deliveryId).at(-1) ?? null;
    }
    // the import_and_submit task (SLA per 29.4's plan) with 23.4's delivery gate facts from the record
    let task = rec.entities("delivery_operator_tasks", (d) => d["delivery_id"] === deliveryId && d["kind"] === "import_and_submit").at(-1) ?? null;
    if (!task) {
      const g = deliveryGateFacts(rec); const fraud = rec.last("fraud.hold.applied") && !rec.last("fraud.hold.released");
      await ctx.run({ process: "29.4", name: "openOperatorTask", actor: SECONDARY, scope: { loanId }, input: { delivery_id: deliveryId, gate_facts: g.facts, fraud_hold: { fraud_hold: !!fraud }, at: now }, detail: { sources: g.sources } });
      rec = await ctx.refresh(); task = rec.entities("delivery_operator_tasks", (d) => d["delivery_id"] === deliveryId && d["kind"] === "import_and_submit").at(-1) ?? null;
    }
    // the eNote (C1-2-04 through 29.4's FNMA_C1_2_04_ENOTE_TRANSFER_SAME_DAY_GATE): eDelivered on the frozen day and the Transfer of Control and Location requested the same day with `effective_date = request_date`;
    // a request whose effective date is not the submission day is re-requested on that day (29.4's gate reason: "re-request with a new same-day effective date") — the partner's Delegatee for Transfers is on the registration
    const requestTransfer = async (): Promise<void> => {
      const latest = rec.last("enote.transfer_of_control.requested"); const today = rec.etDate(now);
      if (latest && String(latest.payload["effective_date"]) === today) return;
      await ctx.run({ process: "29.4", name: "requestEnoteTransfer", actor: SECONDARY, scope: { loanId }, input: { op: "transfer", delivery_id: deliveryId, effective_date: today, delegatee_on_file: registered!.payload["delegatee"] === "sm", at: now }, detail: { sources: { enote: src("event", `enote.registered:${registered!.id}`, "26.2") }, effective_date: today, re_request: latest !== null } });
      rec = await ctx.refresh();
    };
    if (closing.note_form === "enote" && registered) {
      if (!rec.has("enote.edelivered")) { await ctx.run({ process: "29.4", name: "requestEnoteTransfer", actor: SECONDARY, scope: { loanId }, input: { op: "edeliver", delivery_id: deliveryId, at: now }, detail: { sources: { enote: src("event", `enote.registered:${registered.id}`, "26.2") } } }); rec = await ctx.refresh(); }
      if (!rec.has("enote.transfer_of_control.requested")) await requestTransfer();
    }
    // rule 4: the import/submit is the fnma_portal_operator's act — the FAKE operator after the delay under INTEGRATIONS=fake, a person's queue otherwise
    if (task && !task.data["completed_at"]) {
      const fakes = ctx.fakes; const openedAt = String(task.data["opened_at"] ?? now);
      // a person's queue (FAKE_REVIEWERS=off): 29.4 records no "started" act, so the same-day request is kept current on each pass the task stays open (one re-request per day; 35.7's submit surface runs this step first)
      if (closing.note_form === "enote" && registered && (fakes.fills("fnma_portal_operator") ? fakes.operator.ready(openedAt, now) : true)) await requestTransfer();
      if (fakes.fills("fnma_portal_operator") && fakes.operator.ready(openedAt, now)) {
        const ev = fakes.operator.evidence(String(task.id), loanId, now);
        await ctx.run({ process: "29.4", name: "parseOperatorEvidence", actor: FAKE_OPERATOR, scope: { loanId }, input: { task_id: task.id, operator_id: FAKE_OPERATOR.id, evidence: ev.evidence, hash_confirmed: true, edits: [], captured_state: { fnma_loan_number: ev.fnma_loan_number, submitted_at: now, commitment_number: c.commitment_id_fnma, file_sha256: String(frozen.payload["sha256"]), loan_delivery_status: "Purchase Requested", certification_status: "Awaiting Certification" }, at: now }, detail: { sources: { task: src("entity", `delivery_operator_tasks:${task.id}:${task.version}`, "29.4"), frozen: src("event", `delivery.package.frozen:${frozen.id}`, "29.3") }, fake: fakes.operator.vendorName } });
        return {};
      }
      return { wait: { status: "waiting_human", waiting_on: "fnma_portal_operator", clocked: fakes.fills("fnma_portal_operator") } };
    }
    return {};
  },
};

// ───────────────────────────── delivered → certified: 29.4's custodian package and the certification ─────────────────────────────
export const deliveredStep: StepDef = {
  name: "delivered",
  exit: exitOn("custody.certified"),
  clocked: () => true,
  actions: async (ctx): Promise<StepOutcome> => {
    let rec = ctx.rec; const now = ctx.now; const closing = needClosing(rec);
    const loanId = loanIdOf(rec); if (!loanId) throw new RecordGap("applications.loan_id", "no servicing loan (30.2)");
    const submitted = rec.last("delivery.submitted"); if (!submitted) throw new RecordGap("delivery.submitted", "no submission (29.4)");
    const deliveryId = S(submitted.payload["delivery_id"]) ?? deliveryIdOf(rec);
    // 27.1 rule 4 (eNote): SM confirms the partner's Transfer of Control and Location (29.4's latest accepted same-day request) as Secured Party → `warehouse.secured_party.released{effective_date}`; the Funding Agreement governs until the proceeds — as `warehouse`
    const toc = rec.last("enote.transfer_of_control.requested", (p) => p["accepted"] !== false); const advanceFunded = rec.last("warehouse.advance.funded"); const registeredNote = rec.last("enote.registered");
    if (closing.note_form === "enote" && toc && advanceFunded && registeredNote && !rec.has("warehouse.secured_party.released")) {
      const parties = await partyFacts(rec, closing); const partnerOrg = parties.partner_mers_org_id ?? S(registeredNote.payload["controller_org_id"]);
      if (!partnerOrg) throw new RecordGap("parties.mers_org_id", "the partner's MERS org id is not on the record (20.2 / 26.2)");
      await ctx.run({ process: "27.1", name: "confirmTransferOfControl", actor: WAREHOUSE, input: { advance_id: String(advanceFunded.payload["advance_id"]), facility_id: String(advanceFunded.payload["facility_id"]), transfer: { transfer_id: String(toc.payload["transfer_id"]), min: String(toc.payload["min"]), from_controller_org_id: partnerOrg, to_controller_org_id: FANNIE_MAE_ORG_ID, effective_date: String(toc.payload["effective_date"]), initiated_by_org_id: partnerOrg } },
        detail: { sources: { transfer: src("event", `enote.transfer_of_control.requested:${toc.id}`, "29.4"), enote: src("event", `enote.registered:${registeredNote.id}`, "26.2"), advance: src("event", `warehouse.advance.funded:${advanceFunded.id}`, "27.1"), partner: parties.sources["partner"]! } } });
      rec = await ctx.refresh();
    }
    // C1-2-04: an eNote has no paper custodian package (29.4 answers evault_auto); a paper note's package (the endorsed note, the signing officer) is group C 3/3
    if (closing.note_form === "enote" && !rec.entities("custodian_certifications", (d) => d["delivery_id"] === deliveryId).length && !rec.has("custody.package.prepared")) {
      await ctx.run({ process: "29.4", name: "prepareCustodianPackage", actor: SECONDARY, scope: { loanId }, input: { delivery_id: deliveryId }, detail: { sources: { submitted: src("event", `delivery.submitted:${submitted.id}`, "29.4") }, note_form: closing.note_form } });
      rec = await ctx.refresh();
    }
    if (closing.note_form === "enote") {
      // C1-2-04: the eVault auto-certifies the eNote delivery the same day; the FAKE eVault's notice is a 35.2 document
      if (!ctx.fakes.evault.certifies(submitted.occurredAt, now)) return { wait: { status: "waiting_vendor", waiting_on: "evault", clocked: true } };
      const noticeDoc = await storeDocument(ctx.rt.db, { kind: "evault_auto_certification", application_id: rec.app.id, loan_id: loanId, text: JSON.stringify({ delivery_id: deliveryId, fnma_loan_number: submitted.payload["fnma_loan_number"] ?? null, certified_at: now, kind: "auto_certified_enote", vendor: ctx.fakes.evault.vendorName }), retention_class: "life_of_loan_plus_4y", source: `${ctx.fakes.evault.vendorName} eVault auto-certification (35.6 pass)`, now });
      await ctx.run({ process: "29.4", name: "trackShipment", actor: SECONDARY, scope: { loanId }, input: { op: "certified", delivery_id: deliveryId, certified_at: now, certification_kind: "auto_certified_enote", notice_document_id: noticeDoc, at: now }, detail: { sources: { submitted: src("event", `delivery.submitted:${submitted.id}`, "29.4"), notice: src("table", `documents:${noticeDoc}`, "35.2") }, fake: ctx.fakes.evault.vendorName } });
      return {};
    }
    // a paper note: the custodian's receipt and certification arrive with the carrier's scans (group C 3/3)
    return { wait: { status: "waiting_vendor", waiting_on: "custodian", clocked: true } };
  },
};
