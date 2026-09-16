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
import { escrowFacts, cdRow, loanTerms } from "./facts-35-6-b.ts";
import { exitOn, DISCLOSURE, ESCROW, S, civil } from "./steps-35-6-b.ts";
import { ORCH_ACTOR } from "./orchestration-35-6.ts";

type Row = Record<string, unknown>;
const BOARDING = { kind: "agent", id: "boarding" } as const;
const CLOSER = { kind: "agent", id: "title-closing" } as const;
/** 30.2's servicing loan for the application once the hand-off ran (applications.loan_id ↔ loans.origination_application_id). */
const loanIdOf = (rec: OrchRecord): string | null => rec.loanId ?? S(rec.payload("loan.boarded")?.["loan_id"]) ?? S(rec.payload("loan.staged")?.["loan_id"]) ?? null;

export const fundedStep: StepDef = {
  name: "funded",
  exit: exitOn("loan.boarded"),
  clocked: () => true,
  actions: async (ctx): Promise<StepOutcome> => {
    let rec = ctx.rec; const now = ctx.now;
    const funded = rec.last("loan.funded"); if (!funded) throw new RecordGap("loan.funded", "26.3's loan.funded is not on the record");
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
    if (!rec.has("post_closing.run.scheduled") && !rec.entities("post_closing_runs").length) {
      await ctx.run({ process: "25.4", name: "schedulePostClosingRun", actor: DISCLOSURE, scope: { loanId }, input: { application_id: rec.app.id, loan_id: loanId, run_id: `RUN-POST-${rec.app.id.slice(0, 8)}`, agent_run_id: ctx.runId ? `sweep:${ctx.runId}` : `pass:${civil(rec, now)}`, disbursement_date: disbursementDate, first_payment_date: firstPayment, escrow_statement_deferred: false, ...(cd ? { cd_disclosure_id: cd.id } : {}) }, detail: { sources: { funded: src("event", `loan.funded:${funded.id}`, "26.3"), note_terms: src("entity", `closing_data_snapshots:${rec.entities("closing_data_snapshots").at(-1)?.id ?? ""}`, "26.1"), lock: terms.loan_amount_cents.source } } });
      rec = await ctx.refresh();
    }
    // 30.4: the servicing hand-off opened on the boarded loan (HO items from boarded_at; the MI certificate when 24.6 issued one) — as `boarding`, on the loan
    const boarded = rec.last("loan.boarded");
    if (boarded && !rec.has("handoff.opened") && !rec.entities("servicing_handoffs").length) {
      const mi = rec.entities("mi_certificates", (d) => ["active", "activation_requested", "committed", "issued"].includes(String(d["status"]))).length > 0;
      await ctx.run({ process: "30.4", name: "openHandoff", actor: BOARDING, scope: { loanId }, input: { loan_id: loanId, application_id: rec.app.id, boarded_at: String(boarded.payload["boarded_at"] ?? boarded.occurredAt), first_payment_date: firstPayment, mi_certificates_present: mi, escrowed: !!escrow }, detail: { sources: { boarded: src("event", `loan.boarded:${boarded.id}`, "30.2"), mi: mi ? src("entity", `mi_certificates:${rec.entities("mi_certificates").at(-1)!.id}`, "24.6") : src("derived", "no active mi_certificates row", "24.6") } } });
    }
    return {};
  },
};
