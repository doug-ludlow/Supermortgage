/**
 * §35.6 State machine — the steps in order (spec "State machine"), each with the owning event that completes it (`exit`),
 * the guard the fold checks before entering it (`enter`), the wait it starts in (`entryWait`), and the owning tools the pass
 * runs while the row sits on it (`actions`). Every action runs an OWNING tool as the OWNING agent through the bus with inputs
 * derived from the record (facts-35-6.ts); the pass appends no owning event (OWNER_EMITS) and never performs a reserved act
 * (HUMAN_ACTS_STAY_HUMAN: the wire release, the Loan Delivery submission, reviewer-only conditions, waivers, unwinds are the
 * person's — the FAKE person's on nonprod — and the row waits `waiting_human{role}` until the role's event arrives).
 */
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { OrchRecord } from "./facts-35-6.ts";
import type { StepContext } from "./orchestration-35-6.ts";
import type { OrchStatus } from "./orchestration-35-6.ts";
import { creditOrderFacts, usableScore, identitiesVerified, creditReports, duFacts, ctcFacts, ctcFactsInput, ctcFactsSources, decisionIdFor, values, sources, cents } from "./facts-35-6.ts";
import { createCasefile } from "../underwriting/ops-23-1.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { newDecisionFile } from "../application/ops-21-6.ts";
import { closingSteps, fundingSteps, deliverySteps, unwindStep } from "./steps-35-6-b.ts";

type Row = Record<string, unknown>;
export interface Wait { readonly status: OrchStatus; readonly waiting_on?: string | null; readonly clocked?: boolean }
export interface StepOutcome { readonly wait?: Wait; readonly hold?: { readonly reason: string; readonly gate?: string; readonly detail?: Record<string, unknown> }; readonly retry?: boolean }
export interface StepDef {
  readonly name: string;
  /** The owning event that completes the step (the state machine's `→`). */
  readonly exit: (rec: OrchRecord) => DomainEvent | null;
  /** A wait the PREVIOUS step stays in while this one cannot be entered yet (the record lacks what this step's first command needs). */
  readonly enter?: (rec: OrchRecord, ctx: StepContext) => Wait | null;
  /** The wait the step starts in when entered (a borrower's slot, a statutory window). */
  readonly entryWait?: (rec: OrchRecord) => Wait | null;
  /** Whether SM_ORCH_STEP_STALLED_2BD arms for the entry (false while a borrower or a statutory window holds the step). */
  readonly clocked?: (rec: OrchRecord) => boolean;
  /** The wait a step without actions sits in. */
  readonly idleWait?: (rec: OrchRecord) => Wait | null;
  readonly actions?: (ctx: StepContext) => Promise<StepOutcome | void>;
  readonly onEnter?: (rec: OrchRecord) => Record<string, unknown>;
  readonly onComplete?: (rec: OrchRecord, ev: DomainEvent) => Record<string, unknown>;
  readonly terminal?: boolean;
}
export const VERIFICATION = { kind: "agent", id: "verification" } as const;
export const UNDERWRITER = { kind: "agent", id: "underwriter" } as const;

// ───────────────────────────── credit_ordered (T1) ─────────────────────────────
const creditOrdered: StepDef = {
  name: "credit_ordered",
  exit: (rec) => usableScore(rec),
  // the steps before clear_to_close are journaled on the same row but the orchestration proper — and its stall clock, a backstop behind the owners' own clocks — opens at clear_to_close (state machine; T3)
  clocked: () => false,
  actions: async (ctx) => {
    const rec = ctx.rec;
    if (creditReports(rec).length) return {};
    const f = await creditOrderFacts(rec);
    if (!f) return { wait: { status: "waiting_borrower", waiting_on: "borrower", clocked: false } };   // the LE receipt, the fee or a borrower's blanket authorization is still the borrower's
    const order = await ctx.run<{ report_id: string }>({ process: "22.2", name: "orderCreditReport", actor: VERIFICATION, input: { ...values({ permissible_purpose: f.permissible_purpose, certification_ref: f.certification_ref, borrower_authorization_ref: f.borrower_authorization_ref, subscriber_code: f.subscriber_code, borrower_ids: f.borrower_ids }), ...(f.joint_intent_facts ? { joint_intent_facts: f.joint_intent_facts.value } : {}), at: ctx.now }, detail: { sources: sources({ permissible_purpose: f.permissible_purpose, certification_ref: f.certification_ref, borrower_authorization_ref: f.borrower_authorization_ref, subscriber_code: f.subscriber_code, borrower_ids: f.borrower_ids }), consents: f.consents.map((c) => c.consent_id), fee_gate: f.fee_gate?.value ?? null } });
    await ctx.run({ process: "22.2", name: "parseCreditReport", actor: VERIFICATION, input: { report_id: order.report_id, at: ctx.now }, detail: { report_id: order.report_id } });
    return {};
  },
};

// ───────────────────────────── du_submitted (T2) ─────────────────────────────
const duSubmitted: StepDef = {
  name: "du_submitted",
  exit: (rec) => rec.last("decision.issued", (p) => p["kind"] === undefined || p["kind"] === "conditional_approval" || p["kind"] === "approval"),
  // the casefile carries every borrower's identity facts (SCIF, the 22.6 verification): DU is not submitted until 22.6 verified every borrower — the borrower's proofing
  enter: (rec) => (identitiesVerified(rec) ? null : { status: "waiting_borrower", waiting_on: "borrower", clocked: false }),
  clocked: () => false,
  actions: async (ctx) => {
    let rec = ctx.rec;
    const f = await duFacts(rec, ctx.now);
    const detail = { sources: { ulad: f.ulad.source, casefile: f.casefile.source, reports: f.reports.source, borrowers: f.borrowers.source, ...(f.projected_note_date ? { projected_note_date: f.projected_note_date.source } : {}) } };
    // 23.1 has no createCasefile tool: the casefile row is built with the section's constructor from the partner's facts and handed to associateCredit, which persists it (lifecycle.test.ts a9)
    let casefile = rec.entities("du_casefiles").at(-1);
    if (!casefile) {
      const cf0 = createCasefile(new MemoryEventStore(new FixedClock(ctx.now)), { ...(f.casefile.value as { application_id: string; seller_number: string; system_id_ref: string; tsp_product_ref: string; score_model: "classic_fico" }), created_at: ctx.now }).casefile;
      await ctx.run({ process: "23.1", name: "associateCredit", actor: UNDERWRITER, input: { casefile: cf0, reports: f.reports.value, borrowers: f.borrowers.value, app_score_model: (f.casefile.value as Row)["score_model"] }, detail });
      rec = await ctx.refresh(); casefile = rec.entities("du_casefiles").at(-1);
    }
    const casefileId = String(casefile!.data["casefile_id"] ?? casefile!.id);
    let submitted = rec.last("du.submitted");
    let requestHash: string | null = submitted ? String(submitted.payload["request_hash"]) : null;
    if (!submitted) {
      const built = await ctx.run<{ request: Row; request_hash: string; preflight: { passed: boolean; gate: string } }>({ process: "23.1", name: "buildDuRequest", actor: UNDERWRITER, input: { casefile_id: casefileId, submission_type: "credit_and_underwriting", reason: "initial", snapshot: f.ulad.value, built_at: ctx.now }, detail });
      requestHash = built.request_hash;
      if (!built.preflight.passed) return { hold: { reason: "gate_closed", gate: "SM_DU_PREFLIGHT_GATE", detail: { casefile_id: casefileId, preflight: built.preflight } } };
      await ctx.run({ process: "23.1", name: "submitCasefile", actor: UNDERWRITER, input: { casefile_id: casefileId, request: built.request, ...(f.projected_note_date ? { projected_note_date: f.projected_note_date.value } : {}), ...(f.scif_facts ? { scif_facts: f.scif_facts.value } : {}) }, detail });
      rec = await ctx.refresh(); submitted = rec.last("du.submitted");
    }
    const submissionNumber = Number(submitted!.payload["submission_number"] ?? 1);
    let findings = rec.last("du.findings.received", (p) => Number(p["submission_number"] ?? 1) === submissionNumber);
    if (!findings) {
      await ctx.run({ process: "23.1", name: "fetchFindings", actor: UNDERWRITER, input: { casefile_id: casefileId, submission_number: submissionNumber }, detail });
      rec = await ctx.refresh(); findings = rec.last("du.findings.received");
    }
    const recommendation = String(findings!.payload["recommendation"] ?? "");
    if (recommendation === "refer_with_caution" || recommendation === "ineligible" || recommendation === "out_of_scope") return { wait: { status: "waiting_human", waiting_on: "underwriting_reviewer" } };
    const submissionRow = rec.entities("du_submissions", (d) => Number(d["submission_number"]) === submissionNumber).at(-1);
    const submissionId = String(submissionRow?.data["submission_id"] ?? findings!.payload["submission_id"] ?? `${casefileId}:${submissionNumber}`);
    let interpreted = rec.last("du.findings.interpreted", (p) => p["submission_id"] === submissionId);
    if (!interpreted) {
      const fp = findings!.payload as Row;
      const f2 = await duFacts(rec, ctx.now);
      await ctx.run({ process: "23.2", name: "parseFindings", actor: UNDERWRITER, input: { op: "interpret", submission_id: submissionId, submission_number: submissionNumber, recommendation, messages: fp["messages"] ?? [], validation_results: fp["validation_results"] ?? [], value_acceptance_offer: fp["value_acceptance_offer"] ?? { offered: false, property_value_cents: null }, mi_requirement: fp["mi_requirement"] ?? { required: false, coverage_pct: null }, policy_generation: "2026_09_26", request_hash: requestHash, findings_received_at: findings!.occurredAt, facts: f2.application_facts.value }, detail: { sources: { findings: `du.findings.received:${findings!.id}`, facts: f2.application_facts.source } } });
      rec = await ctx.refresh(); interpreted = rec.last("du.findings.interpreted");
    }
    if (String((interpreted!.payload as Row)["policy_outcome"] ?? "proceed") !== "proceed") return { wait: { status: "waiting_human", waiting_on: "underwriting_reviewer" } };
    const decisionId = decisionIdFor(rec);
    // the risk input is read after 23.2's interpretation (eligibility outside DU's scope is its policy_outcome) — never the facts as they stood before the findings
    const fr = await duFacts(rec, ctx.now);
    if (!rec.entities("risk_assessments", (d) => d["decision_id"] === decisionId).length) await ctx.run({ process: "23.3", name: "assessRisk", actor: UNDERWRITER, input: { risk_input: fr.risk.value, decision_id: decisionId }, detail: { sources: { risk_input: fr.risk.source } } });
    const f3 = await duFacts(await ctx.refresh(), ctx.now);
    const file = newDecisionFile(f3.file.value as unknown as Parameters<typeof newDecisionFile>[0]);
    const evidence = rec.entities("documents", (d) => d["doc_class"] !== undefined && d["doc_class"] !== null).map((d) => d.id);
    const verifications = rec.entities("verifications").map((v) => v.id);
    await ctx.run({ process: "23.3", name: "issueConditionalApproval", actor: UNDERWRITER, input: { decision_id: decisionId, file, guard: f3.guard.value, validity: f3.validity.value, inputs: { ulad_snapshot_hash: requestHash, verification_ids: verifications, findings_hash: String((findings!.payload as Row)["findings_hash"] ?? `findings:${submissionId}`) }, du_submission_id: submissionId, interpretation_id: (interpreted!.payload as Row)["interpretation_id"] ?? null, evidence_document_ids: evidence, rationale: `DU ${recommendation} within policy; 22.x verifications, assets and liabilities reconcile to DU (35.6 pass, sources ${JSON.stringify(f3.risk.source)})`, confidence: 0.94 }, detail: { sources: { guard: f3.guard.source, validity: f3.validity.source, file: f3.file.source } } });
    return {};
  },
};

// ───────────────────────────── conditions_open (T3) ─────────────────────────────
const conditionsOpen: StepDef = {
  name: "conditions_open",
  exit: (rec) => rec.last("clear_to_close.issued", (p) => p["passed"] === true),
  clocked: () => false,
  actions: async (ctx) => {
    const rec = ctx.rec;
    const open = rec.entities("conditions", (d) => !["cleared", "waived", "superseded", "not_applicable"].includes(String(d["status"])));
    // rule 4: a reviewer-only item (satisfied_pending_review, requires_role) is the underwriting_reviewer's act — the FAKE reviewer's in reviewers.ts on nonprod — and the pass does nothing on the row until `condition.cleared` arrives; borrower-supplied ones are the borrower's through 32.6's cards
    if (open.length) return open.some((c) => c.data["status"] === "satisfied_pending_review" || c.data["requires_role"] === "underwriting_reviewer") ? { wait: { status: "waiting_human", waiting_on: "underwriting_reviewer" } } : { wait: { status: "waiting_borrower", waiting_on: "borrower", clocked: false } };
    const facts = ctcFacts(rec);
    const decisionId = decisionIdFor(rec);
    const checklist = await ctx.run<{ passed: boolean; items: { code: string; status: string }[] }>({ process: "23.3", name: "runCtcChecklist", actor: UNDERWRITER, input: { op: "ctc", decision_id: decisionId, facts: ctcFactsInput(facts) }, detail: { sources: ctcFactsSources(facts) } });
    if (!checklist.passed) { const failing = checklist.items.filter((i) => i.status === "fail").map((i) => i.code); return { wait: { status: failing.some((c) => c === "CTC_QC_PREFUNDING") ? "waiting_human" : "waiting_borrower", waiting_on: failing.some((c) => c === "CTC_QC_PREFUNDING") ? "qc_officer" : "borrower", clocked: false } }; }
    await ctx.run({ process: "23.3", name: "issueClearToClose", actor: UNDERWRITER, input: { decision_id: decisionId, checklist }, detail: { decision_id: decisionId } });
    return {};
  },
};

export const STEPS: readonly StepDef[] = [creditOrdered, duSubmitted, conditionsOpen, ...closingSteps, ...fundingSteps, ...deliverySteps, { name: "completed", exit: () => null, terminal: true }, unwindStep];
export const STEP_NAMES: readonly string[] = STEPS.map((s) => s.name);
export function stepIndex(name: string): number { const i = STEPS.findIndex((s) => s.name === name); if (i < 0) throw new RangeError(`35.6: unknown step ${name}`); return i; }
export { cents };
