/**
 * §14.1 tools — bankruptcy monitoring & proof of claim (`bankruptcy-ops`). Every tool
 * string is the spec's Agents paragraph verbatim, via `defineTools("14.1", "bankruptcy-ops", defs)`
 * from ../tools.ts (see section13.ts). Spread by ./section14.ts. Guardrails encode the
 * paragraph's sentences: no court paper leaves without `attorney` acceptance (and a
 * `signing_officer` signature where the form carries a declaration); the agent may not
 * release a stay gate without a docket order or counsel's written confirmation; money
 * figures come only from `bk.claim.compute`/ledger services; docket classifications below
 * 0.90 (and every dismissal/discharge/relief) are human-verified before they change state;
 * no outbound collection communication to a debtor while gates are on (template allowlist
 * in `notice.send`); Form 20 and repurchase decisions require `officer`.
 *
 * The case lifecycle runs through these handlers: each `op` validates its inbound record in
 * src/domain/bankruptcy/ops-14-1.ts and appends the events the §14.1 timer rows (timers-14-1.ts)
 * are armed and satisfied by — `bk.case.read/write` (notice ingestion, verification, prior filings,
 * conversion, discharge, dismissal, post-sale, POC filed/package/supplement, docket sync, trustee
 * confirmation, SOI performance, co-debtor relief, adequate protection, MFR review, the relief-order
 * gate), `docket.classify{op=apply}` (typed docket events), `attorney.send_package/request` (the
 * referral and every E-2.1-04 counsel exchange), `fnma.form20.prepare` (Form 20 prepared / submitted
 * by the officer), `smdu.package.prepare` (cramdown reporting, workout submission, Fannie Mae's
 * decision) and `bk.ledger.apply_trustee` (vouchers, incl. the orphan trustee payment).
 */
import { defineTools, escalate, compute, never, needsRole, read, write, timerOps, noticeOps, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { proofOfClaim, unpaidSplits, applyVoucher, type Ledgers, type UnpaidInstallment, type Chapter } from "../../domain/bankruptcy/case.ts";
import { pclMatch, ingestNotice, verifyNotice, serialFilerStay, convertCase, dischargeMode, dismissalReversion, postSaleIdentified, pocFiled, pocPackageReady, pocSupplementFiled, docketSyncCompleted, trusteeStatusConfirmed, soiPerformed, codebtorReliefRequested, codebtorReliefResolved, adequateProtectionCheck, mfrReferral, reliefOrderGate, referralPackage, referralAcknowledged, documentRequest, documentRequestFulfilled, workoutProposal, workoutProposalReviewed, fnmaWorkoutDecision, attorneyNotified, agreedOrderNoticed, docketEventReceived, docketClassification, cramdownRequest, form20Submitted, expenseClaim, applyDebtorPayment, applyTrusteeVoucher, orphanTrusteePayment, normalizeDesignation, breachLetterPayload, RULE_SET_VERSION,
  type PclParty, type PriorCase, type NoticeSource, type BkFeeKind, type ClaimMilestone, type PlanModification, type EmittedEvent, type ReferralType, type SerialFilerClass, type WorkoutKind, type WorkoutRecommendation, type SoiAction, type CodebtorGround, type DocketRecord, type PostpetitionScheduleEntry, type ClaimComponent } from "../../domain/bankruptcy/ops-14-1.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => list<unknown>(v).map((x) => String(x));
const AGENT = "bankruptcy-ops";
const CASES = "bankruptcy_cases";
const RELEASED_STAY = /^(not_in_effect_362c4|terminated_362c3|relief_granted|annulled|ended_discharge|ended_dismissal|ended_closed)$/;
const HUMAN_VERIFIED_STATUS = /^(dismissed|discharged|relief_granted|stay_relief_granted|closed|converted)$/;
const HUMAN_VERIFIED_OPS = /^(discharge|dismiss|convert)$/;
const TERMINAL_STATUS = /^(closed|closed_no_case|dismissed|transferred_out)$/;
const INFORMATIONAL_TEMPLATES = /^(NTC_BK_PAYMENT_INSTRUCTIONS|NTC_BK_STATUS_INFO|NTC_BK_BREACH_INFORMATIONAL|NTC_REGX_39C_EARLY_INTERVENTION_BK|NTC_REGX_39CD_EARLY_INTERVENTION_BK_FDCPA|NTC_REGZ_41_STMT_BK7_11|NTC_REGZ_41_STMT_BK12_13)$/;
/** Spec escalations: `signing_officer` — Forms 410/410A/410S-1/410S-2/410C13-*, MFR declarations, reaffirmation execution — the court papers that carry a declaration; fixed by the form, not by the caller. */
const DECLARATION_FORMS = /^(CRT_B410|CRT_B410A|CRT_B410S1|CRT_B410S2|CRT_B410C13_[A-Z0-9_]+|CRT_MFR_DECL|CRT_REAFFIRM_2400A)$/;
export const carriesDeclaration = (templateCode: string): boolean => DECLARATION_FORMS.test(templateCode);
const changes = (i: ToolInput): Record<string, unknown> => ({ ...rec(i.data), ...rec(i.changes) });
/** Money fields of `bankruptcy_cases` (`*_cents` anywhere in the written record, incl. `plan`/`part2`/`part3`/`cramdown` jsonb) — written only from a `bk.claim.compute`/ledger computation log. */
const hasMoneyField = (v: unknown, depth = 0): boolean => { if (!v || typeof v !== "object" || depth > 4) return false; if (Array.isArray(v)) return v.some((x) => hasMoneyField(x, depth + 1)); return Object.entries(v as Record<string, unknown>).some(([k, x]) => /_cents$/.test(k) || /^(part2|part3|part4|cramdown)$/.test(k) || hasMoneyField(x, depth + 1)); };
/** A `stay_gates` write that opens a gate is a stay-gate release exactly as a `stay_status` change is. */
const releasesGate = (c: Record<string, unknown>): boolean => { const g = rec(c.stay_gates); return RELEASED_STAY.test(str(c, "stay_status")) || g.foreclosure_blocked === false || g.collections_blocked === false; };
const ledgersOf = (v: unknown): Ledgers => { const l = rec(v); return { prepetition_arrearage_cents: cents(l.prepetition_arrearage_cents), postpetition: list<Record<string, unknown>>(l.postpetition).map((p) => ({ due: D(String(p.due)), amount_cents: cents(p.amount_cents), paid_cents: cents(p.paid_cents) })), postpetition_suspense_cents: cents(l.postpetition_suspense_cents) }; };
const today = (ctx: CommandContext): PlainDate => wallClock(Date.parse(ctx.now), "America/New_York").date;
const at = (i: ToolInput, k: string, ctx: CommandContext): string => str(i, k) || ctx.now;
/** Append the events an ops function produced — the timer triggers/satisfiers — to the unit of work's event store. */
const emitAll = (ctx: CommandContext, loanId: string, events: readonly EmittedEvent[]): number => { for (const e of events) ctx.events.append({ type: e.type, loanId, actor: ctx.actor, occurredAt: e.occurred_at, payload: e.payload }); return events.length; };
const openCase = (rt: ToolRuntime, loanId: string): Record<string, unknown> | null => rt.store.list(CASES, (d) => d.loan_id === loanId && !TERMINAL_STATUS.test(str(d, "status"))).map((r) => r.data)[0] ?? null;
const putCase = (rt: ToolRuntime, ctx: CommandContext, loanId: string, caseId: string, patch: Record<string, unknown>): Record<string, unknown> => rt.store.put(CASES, caseId, { loan_id: loanId, case_id: caseId, ...patch }, ctx.actor, ctx.now).data;
const putGates = (rt: ToolRuntime, ctx: CommandContext, loanId: string, caseId: string, gates: Record<string, unknown>): void => { rt.store.put("stay_gates", loanId, { loan_id: loanId, case_id: caseId, ...gates }, ctx.actor, ctx.now); };
const priorCases = (v: unknown): PriorCase[] => list<Record<string, unknown>>(v).map((p) => ({ case_number_full: String(p.case_number_full), chapter: String(p.chapter) as Chapter, filed_on: D(String(p.filed_on)), disposition: String(p.disposition) as PriorCase["disposition"], disposed_on: p.disposed_on ? D(String(p.disposed_on)) : null }));
const part3Of = (v: unknown) => { const p = rec(v); return { principal_due_cents: cents(p.principal_due_cents), interest_due_cents: cents(p.interest_due_cents), prepetition_fees_due_cents: cents(p.prepetition_fees_due_cents), escrow_deficiency_cents: cents(p.escrow_deficiency_cents), funds_on_hand_cents: cents(p.funds_on_hand_cents), total_prepetition_arrearage_cents: cents(p.total_prepetition_arrearage_cents) }; };
const CASE_OPS = ["read", "write", "ingest_notice", "verify", "prior_filings", "convert", "discharge", "dismiss", "post_sale", "poc_filed", "poc_package_ready", "poc_supplement_filed", "docket_sync", "trustee_status_confirmed", "soi_performed", "codebtor_relief_resolved", "adequate_protection", "mfr_review", "relief_order_gate", "orphan_payment_resolved"] as const;
const ATTORNEY_OPS = ["send_package", "request", "acknowledged", "document_request", "document_fulfilled", "workout_proposal", "workout_reviewed", "notify", "agreed_order_noticed", "codebtor_relief_requested"] as const;

export const TOOLS_14_1: readonly ToolDef[] = defineTools("14.1", AGENT, [
  { name: "bk.case.read/write", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "read";
      if (op === "read") return read(CASES)(i, ctx, rt);
      if (op === "write") return write(CASES, "bankruptcy.case.written")(i, ctx, rt);
      need(i, "loan_id"); const loan = str(i, "loan_id"); const open = openCase(rt, loan); const caseId = str(i, "case_id") || str(open ?? {}, "case_id") || `bkcase-${loan}`;
      switch (op) {
        case "ingest_notice": {   // rule 1: gates immediately, in the ingesting transaction; verification runs in parallel (SM_BK_VERIFY_1BD)
          need(i, "source", "received_at");
          const r = ingestNotice({ source: str(i, "source") as NoticeSource, received_at: str(i, "received_at"), loan_id: loan, chapter: (str(i, "chapter") || null) as Chapter | null, case_number_full: str(i, "case_number_full") || null, scheduled_contacts: list(i.scheduled_contacts), now: ctx.now });
          emitAll(ctx, loan, r.events); putGates(rt, ctx, loan, caseId, { ...r.gates });
          putCase(rt, ctx, loan, caseId, { status: "verifying", stay_status: "pending_verification", case_number_full: str(i, "case_number_full") || null, chapter: str(i, "chapter") || null, notice_id: str(i, "notice_id") || null, notice_source: r.events[0]!.payload.source, verification_due: r.verification.due });
          if (r.sla.escalation) rt.escalations.open({ kind: "officer", loanId: loan, severity: "sev1", payload: { reason: r.sla.escalation.reason, timer: r.satisfies } }, ctx.actor);
          return r;
        }
        case "verify": {   // rule 1: PCL/vendor/EBN cross-check — case opened (the verified petition and its clocks) or the notice rejected with a decision record and gates released
          need(i, "notice_id", "borrower"); const b = rec(i.borrower);
          const r = verifyNotice({ notice_id: str(i, "notice_id"), loan_id: loan, borrower: { last_name: str(b, "last_name"), ssn4: str(b, "ssn4"), first_name: str(b, "first_name"), property_address: str(b, "property_address") }, hits: list<PclParty>(i.hits), case_number_from_notice: str(i, "case_number_from_notice") || null, verified_at: ctx.now, prior_cases: priorCases(i.prior_cases), abusive_pattern: flag(i, "abusive_pattern"), fnma_delinquency_days_at_filing: Number(i.fnma_delinquency_days_at_filing ?? 0), open_foreclosure: flag(i, "open_foreclosure") });
          emitAll(ctx, loan, r.events); ctx.decide({ agent: ctx.actor.id, action: "verify", rationale: r.decision.rationale, ruleSetVersion: RULE_SET_VERSION.guide, loanId: loan, ruleCode: "14.1:rule1" });
          putGates(rt, ctx, loan, caseId, { ...r.gates });
          const p = r.event.payload;
          putCase(rt, ctx, loan, caseId, r.case_opened ? { status: "active", stay_status: "in_effect", case_number_full: r.case_number_full, chapter: p.chapter, petition_date: p.petition_date, order_for_relief_date: p.order_for_relief_date, serial_filer_class: r.serial_filer_class, referral: { type: r.referral }, verification: { notice_id: str(i, "notice_id"), verified_at: ctx.now, verified_by: `${ctx.actor.kind}:${ctx.actor.id}` } } : { status: "closed_no_case", stay_status: "pending_verification", verification: { notice_id: str(i, "notice_id"), verified_at: ctx.now, result: "rejected", evidence: p.evidence } });
          return r;
        }
        case "prior_filings": {   // rule 2 (E-2.1-02/E-2.3-01; §362(c)(3)–(4)) — FNMA_E2_1_02_PRIOR_FILING_CHECK_14, USC_362C3_SERIAL_STAY_30, USC_362C4_NO_STAY_CONFIRM_5BD
          need(i, "petition_on", "chapter");
          const r = serialFilerStay({ loan_id: loan, petition_on: date(i, "petition_on"), chapter: str(i, "chapter") as Chapter, prior_cases: priorCases(i.prior_cases), abusive_pattern: flag(i, "abusive_pattern"), today: today(ctx), extension_order_on: optDate(i, "extension_order_on"), counsel_written_confirmation_on: optDate(i, "counsel_written_confirmation_on"), counsel_confirmation_document_id: str(i, "counsel_confirmation_document_id") || null });
          emitAll(ctx, loan, r.events); ctx.decide({ agent: ctx.actor.id, action: "prior_filing_class", rationale: r.stay.basis, ruleSetVersion: RULE_SET_VERSION.guide, loanId: loan, ruleCode: "14.1:rule2" });
          putCase(rt, ctx, loan, caseId, { serial_filer_class: r.serial_filer_class, stay_status: r.stay.status, prior_cases: r.prior_dismissed_within_1y.map((p) => p.case_number_full) }); putGates(rt, ctx, loan, caseId, { ...r.gates });
          if (r.escalation) rt.escalations.open({ kind: "attorney", loanId: loan, ...(r.escalation.severity ? { severity: r.escalation.severity } : {}), payload: { reason: r.escalation.reason, serial_filer_class: r.serial_filer_class } }, ctx.actor);
          return r;
        }
        case "convert": {   // rule 10: petition date kept, chapter and gates switch, Chapter 13 ledgers frozen, a new 70-day claims window (FRBP_3002C_POC_BAR_70)
          need(i, "petition_on", "chapter_from", "chapter_to", "conversion_on", "ledgers");
          const r = convertCase({ loan_id: loan, case_number_full: str(i, "case_number_full") || str(open ?? {}, "case_number_full") || null, petition_on: date(i, "petition_on"), chapter_from: str(i, "chapter_from") as Chapter, chapter_to: str(i, "chapter_to") as Chapter, conversion_on: date(i, "conversion_on"), ledgers: ledgersOf(i.ledgers) });
          emitAll(ctx, loan, r.emitted); putCase(rt, ctx, loan, caseId, { status: "converted", chapter: r.chapter, converted_from_chapter: r.converted_from_chapter, conversion_date: r.conversion_date, bar_date: r.poc_bar, referral: { type: "conversion" } });
          rt.escalations.open({ kind: "attorney", loanId: loan, payload: { reason: `case converted ${r.converted_from_chapter} → ${r.chapter} on ${r.conversion_date}: new referral type conversion; claim due ${r.poc_bar} (Rule 3002(c))` } }, ctx.actor);
          return r;
        }
        case "discharge": {   // rule 10: discharge-injunction mode (§524(a)(2)); the phase event completes the E-2.2-01/-04 timelines
          need(i, "chapter", "discharge_on");
          const r = dischargeMode({ loan_id: loan, chapter: str(i, "chapter") as Chapter, discharge_on: date(i, "discharge_on"), reaffirmed: flag(i, "reaffirmed"), ...(i.cured_and_maintained !== undefined ? { cured_and_maintained: flag(i, "cured_and_maintained") } : {}), fnma_delinquency_days: Number(i.fnma_delinquency_days ?? 0) });
          emitAll(ctx, loan, r.emitted); putCase(rt, ctx, loan, caseId, { status: "discharged", stay_status: r.stay_status, discharge_at: str(i, "discharge_on"), debt_discharged: r.debt_discharged }); putGates(rt, ctx, loan, caseId, { ...r.gates, contact_route: r.contact_route, statement_mode: r.statement_mode });
          return r;
        }
        case "dismiss": {   // rule 10: contract-terms view becomes the ledger of record; suspended late charges waived (2.7); 13.x resumes with the breach letter
          need(i, "dismissed_on", "prepetition_installments");
          const r = dismissalReversion({ loan_id: loan, case_number_full: str(i, "case_number_full") || str(open ?? {}, "case_number_full") || null, dismissed_on: date(i, "dismissed_on"), cured_cents: cents(i.cured_cents), prepetition_installments: list<Record<string, unknown>>(i.prepetition_installments).map((x) => ({ due: D(String(x.due)), pi_cents: cents(x.pi_cents), escrow_cents: cents(x.escrow_cents) })), suspended_late_charges_cents: cents(i.suspended_late_charges_cents), ...(i.counsel_confirmed_stay_ended !== undefined ? { counsel_confirmed_stay_ended: flag(i, "counsel_confirmed_stay_ended") } : {}), dismissal_with_prejudice: flag(i, "dismissal_with_prejudice") });
          emitAll(ctx, loan, r.events); ctx.decide({ agent: ctx.actor.id, action: "dismissal_close", rationale: `dismissed ${str(i, "dismissed_on")}: ${r.cured_installments.length} installments cured FIFO, ${r.late_charges.waived_cents} cents of suspended late charges waived (2.7 default)`, ruleSetVersion: RULE_SET_VERSION.guide, loanId: loan, ruleCode: "14.1:rule10" });
          putCase(rt, ctx, loan, caseId, { status: "dismissed", stay_status: r.stay_status, dismissal_at: str(i, "dismissed_on"), dismissal_with_prejudice: flag(i, "dismissal_with_prejudice") }); putGates(rt, ctx, loan, caseId, { ...r.gates });
          return r;
        }
        case "post_sale": {   // rule 12 (E-2.3-06): gates on, counsel the same day, the Bankruptcy Notification Template within 2 BD (FNMA_E2_3_06_POST_SALE_NOTIFY_2BD)
          need(i, "sale_held_on", "petition_on");
          const learned = today(ctx); const r = postSaleIdentified({ sale_held_on: date(i, "sale_held_on"), petition_on: date(i, "petition_on"), learned_on: learned, learned_at: ctx.now });
          if (r.post_sale) {
            emitAll(ctx, loan, [{ type: "bankruptcy.post_sale.identified", occurred_at: ctx.now, payload: { loan_id: loan, sale_held_on: str(i, "sale_held_on"), petition_date: str(i, "petition_on"), learned_at: ctx.now, learned_on: learned, template_due: r.template!.due } }, { type: "bankruptcy.gates.applied", occurred_at: ctx.now, payload: { loan_id: loan, ...r.gates } }]);
            putGates(rt, ctx, loan, caseId, { ...r.gates }); putCase(rt, ctx, loan, caseId, { status: "post_sale_void_review", stay_status: "in_effect", petition_date: str(i, "petition_on") });
            rt.escalations.open({ kind: "attorney", loanId: loan, severity: "sev1", payload: { reason: r.counsel!.escalation.reason, template_due: r.template!.due } }, ctx.actor);
          }
          return r;
        }
        case "poc_filed": {   // E-2.1-07 / Rule 3002(c): the filed claim; without complete writings the 120-day supplement clock arms (FRBP_3002C7_POC_SUPPLEMENT_120)
          need(i, "order_for_relief_on", "filed_on", "bar_date");
          const r = pocFiled({ loan_id: loan, order_for_relief_on: date(i, "order_for_relief_on"), filed_on: date(i, "filed_on"), bar_date: date(i, "bar_date"), writings_complete: flag(i, "writings_complete"), docket_no: str(i, "docket_no") || null, claim_no: str(i, "claim_no") || null });
          emitAll(ctx, loan, [r.event]); putCase(rt, ctx, loan, caseId, { claim: { status: r.status, filed_at: str(i, "filed_on"), claim_no: str(i, "claim_no") || null, timely: r.timely, supplement_due: r.supplement?.due ?? null } });
          return r;
        }
        case "poc_package_ready": {   // SM_BK_POC_PACKAGE_T35: the package is ready only when its content rules hold
          need(i, "order_for_relief_on", "part3");
          const r = pocPackageReady({ loan_id: loan, order_for_relief_on: date(i, "order_for_relief_on"), ready_at: at(i, "ready_at", ctx), part3: part3Of(i.part3), part5_first_default_anchor: flag(i, "part5_first_default_anchor"), part5_ledger_tie: flag(i, "part5_ledger_tie"), form_410a_present: flag(i, "form_410a_present"), escrow_statement_present: flag(i, "escrow_statement_present"), redaction_checked: flag(i, "redaction_checked"), writings_complete: flag(i, "writings_complete"), claim_document_id: str(i, "claim_document_id") || null });
          emitAll(ctx, loan, [r.event]); putCase(rt, ctx, loan, caseId, { claim: { status: "package_ready", package_ready_at: r.event.payload.ready_at, claim_document_id: str(i, "claim_document_id") || null } });
          return r;
        }
        case "poc_supplement_filed": {   // Rule 3002(c)(7): the 3001(c)(1)/(d) writings filed as a supplement — satisfies FRBP_3002C7_POC_SUPPLEMENT_120
          need(i, "order_for_relief_on", "writings"); const w = rec(i.writings);
          const r = pocSupplementFiled({ loan_id: loan, order_for_relief_on: date(i, "order_for_relief_on"), filed_at: at(i, "filed_at", ctx), writings: { note: str(w, "note") || null, lost_note_affidavit: str(w, "lost_note_affidavit") || null, mortgage: str(w, "mortgage") || null, assignments: str(w, "assignments") || null, perfection_evidence: str(w, "perfection_evidence") || null }, docket_no: str(i, "docket_no") || null, claim_no: str(i, "claim_no") || null });
          emitAll(ctx, loan, [r.event]); putCase(rt, ctx, loan, caseId, { claim: { status: "supplement_filed", supplement_filed_at: r.event.payload.filed_at, writing_documents: r.documents } });
          return r;
        }
        case "docket_sync": {   // SM_BK_DOCKET_SYNC_1BD: the daily docket lookup for an open case
          need(i, "case_number_full", "source");
          const r = docketSyncCompleted({ loan_id: loan, case_number_full: str(i, "case_number_full"), synced_at: at(i, "synced_at", ctx), source: str(i, "source") as "vendor" | "pcl", entries_seen: Number(i.entries_seen ?? 0), last_docket_no: str(i, "last_docket_no") || null, pcl_report_id: str(i, "pcl_report_id") || null });
          emitAll(ctx, loan, [r.event]); putCase(rt, ctx, loan, caseId, { monitor: { last_docket_sync_at: r.event.payload.synced_at, source_of_truth: str(i, "source") } });
          return r;
        }
        case "trustee_status_confirmed": {   // E-2.2-04 conduit districts: FNMA_E2_2_04_TRUSTEE_STATUS_CONFIRM_5BD
          need(i, "case_number_full", "day_60", "trustee_name", "plan_payment_status");
          const r = trusteeStatusConfirmed({ loan_id: loan, case_number_full: str(i, "case_number_full"), day_60: date(i, "day_60"), confirmed_at: at(i, "confirmed_at", ctx), trustee_name: str(i, "trustee_name"), plan_payment_status: str(i, "plan_payment_status") as "current" | "delinquent" | "no_record", last_disbursement_on: optDate(i, "last_disbursement_on"), arrearage_paid_cents: cents(i.arrearage_paid_cents), postpetition_paid_cents: cents(i.postpetition_paid_cents) });
          emitAll(ctx, loan, [r.event]); return r;
        }
        case "soi_performed": {   // §521(a)(2)(B): USC_521A2_SOI_PERFORM_30
          need(i, "action", "meeting_341_first_set_at");
          const r = soiPerformed({ loan_id: loan, action: str(i, "action") as SoiAction, performed_at: at(i, "performed_at", ctx), meeting_341_first_set_at: date(i, "meeting_341_first_set_at"), document_id: str(i, "document_id") || null });
          emitAll(ctx, loan, [r.event]); putCase(rt, ctx, loan, caseId, { soi: { intent: str(i, "action") === "ride_through" ? "retain_ride_through" : str(i, "action") === "surrender_relief" ? "surrender" : "retain_reaffirm", performed_at: r.event.payload.performed_at } });
          return r;
        }
        case "codebtor_relief_resolved": {   // §1301(d): USC_1301D_CODEBTOR_RELIEF_20
          need(i, "filed_at", "result", "on");
          const r = codebtorReliefResolved({ loan_id: loan, filed_at: date(i, "filed_at"), result: str(i, "result") as "objection_docketed" | "auto_terminated", on: date(i, "on"), docket_no: str(i, "docket_no") || null });
          emitAll(ctx, loan, [r.event]); putCase(rt, ctx, loan, caseId, { codebtor_stay_status: str(i, "result") === "auto_terminated" ? "relief_granted_1301d" : "objection_pending" });
          return r;
        }
        case "adequate_protection": {   // E-2.1-06: FNMA_E2_1_06_ADEQUATE_PROTECTION_45 — resolved by counsel's instruction or by confirmation
          need(i, "meeting_341_on");
          const r = adequateProtectionCheck({ loan_id: loan, meeting_341_on: date(i, "meeting_341_on"), conduit_district: flag(i, "conduit_district"), plan_confirmed_on: optDate(i, "plan_confirmed_on"), attorney_instructed_on: optDate(i, "attorney_instructed_on"), today: today(ctx) });
          if (r.resolution) emitAll(ctx, loan, [r.resolution]);
          if (r.instruct_counsel) rt.escalations.open({ kind: "attorney", loanId: loan, payload: { reason: `confirmation more than 45 days after the 341 meeting (${str(i, "meeting_341_on")}) in a conduit district: consider requesting interim payments by filing a Motion for Adequate Protection Payments (E-2.1-06)`, due: r.due } }, ctx.actor);
          return r;
        }
        case "mfr_review": {   // rule 8: post-petition delinquency on the post-petition ledger → FNMA_E2_1_08_POSTPETITION_60DPD_REFERRAL_14 and the MFR package the same day
          need(i, "ledgers", "chapter", "petition_on");
          const r = mfrReferral({ loan_id: loan, ledgers: ledgersOf(i.ledgers), today: optDate(i, "today") ?? today(ctx), chapter: str(i, "chapter") as Chapter, petition_on: date(i, "petition_on"), conduit_district: flag(i, "conduit_district"), plan_confirmed: flag(i, "plan_confirmed"), fnma_delinquency_days_at_filing: Number(i.fnma_delinquency_days_at_filing ?? 0), open_foreclosure: flag(i, "open_foreclosure"), referral_sent_on: optDate(i, "referral_sent_on"), agreed_order_cure_months: i.agreed_order_cure_months === undefined ? null : Number(i.agreed_order_cure_months), debtor_otherwise_performing: flag(i, "debtor_otherwise_performing"), investment_property: flag(i, "investment_property"), investment_property_no_equity: flag(i, "investment_property_no_equity"), soi_surrender: flag(i, "soi_surrender"), counsel_recommends_dismissal: flag(i, "counsel_recommends_dismissal"), meeting_341_on: optDate(i, "meeting_341_on"), firm_id: str(i, "firm_id") });
          emitAll(ctx, loan, r.events);
          if (r.fired) { ctx.decide({ agent: ctx.actor.id, action: "mfr_path", rationale: r.path_scoring!.rationale, ruleSetVersion: RULE_SET_VERSION.guide, loanId: loan, ruleCode: "14.1:rule8" }); rt.escalations.open({ kind: "attorney", loanId: loan, payload: { reason: r.package!.escalation.reason, path: r.path, companions: r.path_scoring!.companions, referral_due: r.referral_due } }, ctx.actor); }
          if (r.referral?.escalation) rt.escalations.open({ kind: "officer", loanId: loan, severity: "sev1", payload: { reason: r.referral.escalation.reason } }, ctx.actor);
          return r;
        }
        case "relief_order_gate": {   // rule 8: the daily stay-gate recomputation after a relief order — emits the Rule 4001(a)(3) expiry once (FRBP_4001A3_ORDER_STAY_14)
          need(i, "entered_on");
          const r = reliefOrderGate({ loan_id: loan, entered_on: date(i, "entered_on"), waived_stay: flag(i, "waived_stay"), today: today(ctx) });
          const already = ctx.events.byLoan(loan).some((e) => e.type === "bankruptcy.stay.relief_effective");
          if (!already) emitAll(ctx, loan, r.emitted.filter((e) => e.type === "bankruptcy.stay.relief_effective"));
          putGates(rt, ctx, loan, caseId, { foreclosure_blocked: r.foreclosure_blocked, collections_blocked: r.collections_blocked, contact_route: r.contact_route, stay_status: r.stay_status });
          return r;
        }
        case "orphan_payment_resolved": {   // SM_BK_ORPHAN_TRUSTEE_PAYMENT_2BD: case opened or payment resolved
          need(i, "result", "received_at", "amount_cents");
          const r = orphanTrusteePayment({ loan_id: loan, received_at: str(i, "received_at"), amount_cents: cents(i.amount_cents), payer_type: "trustee", open_case: false, case_number_on_voucher: str(i, "case_number_full") || null });
          const resolved = r.resolve(str(i, "result") as "case_opened" | "resolved", ctx.now); emitAll(ctx, loan, [resolved]); return { ...r, resolved };
        }
        default: throw new RangeError(`bk.case.read/write op ${op} is not one of ${CASE_OPS.join("/")}`);
      }
    }),
    guardrails: [never("NO_GATE_RELEASE_WITHOUT_ORDER", "14.1 guardrail: the agent may not release a stay gate without a docket order or counsel's written confirmation", (i) => i.op === "write" && releasesGate(changes(i)) && !str(i, "docket_order_document_id") && !str(i, "counsel_written_confirmation_document_id"), "attach the docket order or counsel's written confirmation"),
      needsRole("DISMISSAL_DISCHARGE_RELIEF_HUMAN_VERIFIED", "14.1 guardrail: dismissal/discharge/relief always human-verified by counsel or human_agent against the PDF", (i) => ((i.op === "write" && HUMAN_VERIFIED_STATUS.test(str(changes(i), "status"))) || HUMAN_VERIFIED_OPS.test(str(i, "op"))) && !flag(i, "human_verified_against_pdf"), ["attorney", "human_agent", "officer"], "verify the order against the PDF"),
      never("LOW_CONFIDENCE_NO_STATE_CHANGE", "14.1 guardrail: docket classifications below confidence 0.90 are human-verified before they change state", (i) => i.op === "write" && i.classifier_confidence !== undefined && !docketClassification({ event_type: str(i, "event_type") || str(changes(i), "status"), confidence: Number(i.classifier_confidence) }).state_change_allowed && !flag(i, "human_verified_against_pdf"), "open the verification task; the case record consumes the classified event only after a human verifies it"),
      never("MONEY_FIELDS_FROM_COMPUTATION_LOG_ONLY", "14.1 guardrail: money figures come only from bk.claim.compute/ledger services with a reproducible computation log", (i) => i.op === "write" && hasMoneyField(changes(i)) && !str(i, "computation_log_id"), "write plan/claim/ledger money fields only from a bk.claim.compute or ledger service result, citing its computation_log_id — the LLM never computes money")] },
  { name: "pcl.search", kind: "read", handler: compute(async (i, _c, rt) => { need(i, "last_name"); if (!str(i, "ssn4") && !str(i, "ssn")) throw new RangeError("ssn4 or ssn is required with last_name — PCL rejects SSN-only queries");
      const pacer = rt.ports.pacer as unknown as { partiesFind?: (q: Record<string, unknown>) => Promise<{ reportId: string }> } | undefined;
      const query = { jurisdictionType: "bk", role: ["db"], lastName: str(i, "last_name"), ssn4: str(i, "ssn4") || null, dateFiledFrom: str(i, "date_filed_from") || null };
      const report = pacer?.partiesFind ? await pacer.partiesFind(query) : null;
      const borrower = { last_name: str(i, "last_name"), ssn4: str(i, "ssn4"), first_name: str(i, "first_name"), property_address: str(i, "property_address") };
      return { query, report_id: report?.reportId ?? null, matches: list<PclParty>(i.hits).map((h) => ({ case_number_full: h.case_number_full, ...pclMatch(borrower, h) })) }; }) },
  { name: "ebn.inbox.read", kind: "read", handler: read("ebn_notices") },
  { name: "bkvendor.*", kind: "act", handler: compute((i, ctx, rt) => { const op = str(i, "op") || "alerts";
      switch (op) {
        case "alerts": return read("bkvendor_alerts")(i, ctx, rt);
        case "coversheet": need(i, "case_number_full"); return rt.store.get("bkvendor_coversheets", str(i, "case_number_full"))?.data ?? null;
        case "add_monitoring": case "suspend_monitoring": case "resume_monitoring": { need(i, "loan_id"); const r = rt.store.put("bkvendor_monitoring", str(i, "loan_id"), { loan_id: str(i, "loan_id"), status: op === "suspend_monitoring" ? "suspended" : "active", vendor_case_id: str(i, "vendor_case_id") || null }, ctx.actor, ctx.now); ctx.events.append({ type: `bkvendor.monitoring.${op.replace("_monitoring", "")}`, loanId: str(i, "loan_id"), actor: ctx.actor, payload: { status: r.data.status } }); return r.data; }
        default: throw new RangeError(`bkvendor op ${op} is not one of alerts/coversheet/add_monitoring/suspend_monitoring/resume_monitoring`);
      } }) },
  { name: "docket.classify", kind: "act", handler: compute(async (i, ctx, rt) => {
      const op = str(i, "op") || "classify";
      if (op === "apply") {   // the verified docket entry changes state: `bankruptcy.docket.event.received{kind, …}` plus the derived case events (rules 8/10; the docket-keyed timer rows)
        need(i, "loan_id", "case_number_full", "chapter", "source", "kind", "event_date");
        const loan = str(i, "loan_id"); const open = openCase(rt, loan); const caseId = str(i, "case_id") || str(open ?? {}, "case_id") || `bkcase-${loan}`;
        const record: DocketRecord = { loan_id: loan, case_number_full: str(i, "case_number_full"), chapter: str(i, "chapter") as Chapter, source: str(i, "source") as DocketRecord["source"], kind: str(i, "kind"), event_date: date(i, "event_date"), entered_at: at(i, "entered_at", ctx), docket_no: str(i, "docket_no") || null, document_id: str(i, "document_id") || null, parsed: rec(i.parsed), classifier_confidence: Number(i.confidence ?? i.classifier_confidence ?? 0), verified_by: (str(i, "verified_by") || null) as Exclude<DocketRecord["verified_by"], undefined>, individual_debtor: i.individual_debtor === undefined ? true : flag(i, "individual_debtor"), conduit_district: flag(i, "conduit_district"), plan_confirmed: flag(i, "plan_confirmed"), petition_date: optDate(i, "petition_date") };
        const r = docketEventReceived(record);
        emitAll(ctx, loan, [r.event, ...r.derived]);
        rt.store.put("bankruptcy_docket_events", str(i, "id") || `dk-${loan}-${record.kind}-${record.event_date}`, { case_id: caseId, ...record, applied_at: ctx.now, verified_by: r.verified_by }, ctx.actor, ctx.now);
        const p = r.event.payload; const patch: Record<string, unknown> = {};
        if (record.kind === "meeting_341_scheduled") patch.meeting_341_at = p.meeting_341_at;
        if (record.kind === "bar_date_notice" && record.chapter === "11") patch.bar_date = p.bar_date;
        if (record.kind === "plan_confirmed") patch.plan = { status: "confirmed", confirmed_at: record.event_date };
        if (record.kind === "relief_order_entered") { patch.stay_status = "relief_granted"; putGates(rt, ctx, loan, caseId, { foreclosure_blocked: true, collections_blocked: true, contact_route: "counsel_only", stay_status: "relief_granted", relief_order_entered_on: record.event_date, opens_on: p.opens_on }); }
        if (record.kind === "noa_filed") patch.referral = { ...rec(open?.referral), noa_filed_on: record.event_date };
        if (Object.keys(patch).length) putCase(rt, ctx, loan, caseId, patch);
        return { ...r, docket_event_id: str(i, "id") || `dk-${loan}-${record.kind}-${record.event_date}` };
      }
      need(i, "document_id");
      const ai = rt.services.documentAi as { classifyDocket?: (id: string) => Promise<{ event_type: string; confidence: number; parsed: Record<string, unknown> }> } | undefined;
      const c = ai?.classifyDocket ? await ai.classifyDocket(str(i, "document_id")) : { event_type: str(i, "event_type"), confidence: Number(i.confidence ?? 0), parsed: rec(i.parsed) };
      const gate = docketClassification({ event_type: c.event_type, confidence: c.confidence });
      const esc = gate.human_verification_required ? rt.escalations.open({ kind: gate.verifier === "attorney_or_human_agent" ? "attorney" : "human_agent", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { document_id: str(i, "document_id"), event_type: c.event_type, confidence: c.confidence, reason: gate.reason } }, ctx.actor) : null;
      return { ...c, ...gate, verification_task: esc }; }),
    guardrails: [never("LOW_CONFIDENCE_NO_STATE_CHANGE", "14.1 guardrail: docket classifications below confidence 0.90 are human-verified before they change state (dismissal/discharge/relief always human-verified by counsel or human_agent against the PDF)", (i) => (flag(i, "apply_to_case") || str(i, "op") === "apply") && !docketClassification({ event_type: str(i, "kind") || str(i, "event_type"), confidence: Number(i.confidence ?? i.classifier_confidence ?? 0) }).state_change_allowed && !/^(human_agent|attorney)$/.test(str(i, "verified_by")), "open the verification task; the case record consumes the event only after a human verifies it against the PDF")] },
  { name: "ledger.snapshot", kind: "read", handler: read("bankruptcy_ledger_views") },
  { name: "bk.claim.compute", kind: "read", handler: compute((i) => { need(i, "ib_upb_cents", "pi_cents", "escrow_monthly_cents", "escrow_balance_at_petition_cents");
      const unpaid: UnpaidInstallment[] = Array.isArray(i.unpaid) ? list<Record<string, unknown>>(i.unpaid).map((u) => ({ due: D(String(u.due)), interest_cents: cents(u.interest_cents), principal_cents: cents(u.principal_cents), late_charge_cents: cents(u.late_charge_cents) }))
        : (need(i, "upb_after_last_paid_cents", "rate_pct", "first_unpaid_due", "petition_on"), unpaidSplits(cents(i.upb_after_last_paid_cents), str(i, "rate_pct"), cents(i.pi_cents), date(i, "first_unpaid_due"), date(i, "petition_on"), cents(i.late_charge_cents), Number(i.grace_days ?? 15)));
      if (!unpaid.length) throw new RangeError("no unpaid pre-petition installments — nothing to claim");
      const poc = proofOfClaim({ ib_upb_cents: cents(i.ib_upb_cents), nib_cents: cents(i.nib_cents), unpaid, other_prepetition_fees_cents: cents(i.other_prepetition_fees_cents), escrow_balance_at_petition_cents: cents(i.escrow_balance_at_petition_cents), funds_on_hand_cents: cents(i.funds_on_hand_cents), pi_cents: cents(i.pi_cents), escrow_monthly_cents: cents(i.escrow_monthly_cents), ...(i.pmi_cents !== undefined ? { pmi_cents: cents(i.pmi_cents) } : {}) });
      return { ...poc, unpaid, computation_log: { rule: "14.1 rule 5 (Rule 3001(c)(2); Form 410A rev. 12/23)", rule_set_version: "frbp.2025-12", part3: "principal_due + interest_due + prepetition_fees + escrow_deficiency − funds_on_hand", part2: "ib_upb + nib + interest_due + fees + escrow_deficiency − funds_on_hand", interest: "scheduled interest of unpaid installments only (14.1-Q4)" } }; }),
    guardrails: [never("MONEY_FROM_LEDGER_SERVICE_ONLY", "14.1 guardrail: money figures come only from bk.claim.compute/ledger services with a reproducible computation log", (i) => i.override_total_cents !== undefined || i.override_part3_cents !== undefined, "the LLM never computes money; correct the ledger inputs instead")] },
  { name: "bk.ledger.apply_trustee", kind: "write", moneyFields: ["amount_cents"], handler: compute((i, ctx, rt) => { need(i, "loan_id", "amount_cents");
      const loan = str(i, "loan_id"); const open = openCase(rt, loan);
      // detection source (h): a trustee payment on a loan with no open case is itself a detection trigger (SM_BK_ORPHAN_TRUSTEE_PAYMENT_2BD) — nothing is applied until the case is opened or the payment resolved
      if (!open && !flag(i, "open_case")) {
        const r = orphanTrusteePayment({ loan_id: loan, received_at: at(i, "received_at", ctx), amount_cents: cents(i.amount_cents), payer_type: str(i, "payer_type") || "trustee", open_case: false, case_number_on_voucher: str(i, "case_number_full") || null });
        if (!r.orphan) throw new RangeError(`payer_type ${str(i, "payer_type")} on a loan with no open bankruptcy case is not a trustee voucher — post it through 2.1`);
        emitAll(ctx, loan, r.events);
        rt.escalations.open({ kind: "human_agent", loanId: loan, severity: "sev2", payload: { reason: `trustee payment ${cents(i.amount_cents)} cents received with no open bankruptcy case (voucher case ${str(i, "case_number_full") || "unknown"}): open the case or resolve the payment by ${r.due}`, timer: r.timer, due: r.due } }, ctx.actor);
        return { orphan: true, applied: false, due: r.due, timer: r.timer, events: r.events.map((e) => e.type) };
      }
      need(i, "ledgers");
      const designation = normalizeDesignation(str(i, "designation")); const plan = str(i, "plan_designation"); const conduit = flag(i, "conduit_district");
      if (plan && plan !== "post-petition" && plan !== "arrearage") throw new RangeError(`plan_designation ${plan} is not post-petition/arrearage`);
      const l = ledgersOf(i.ledgers);
      if (i.schedule !== undefined && i.note !== undefined && i.claim !== undefined) {   // rule 6(a) in full: plan-terms split, clearing legs posted, the reminder for a short installment
        const note = rec(i.note); const claim = rec(i.claim); const pc = i.payment_change === undefined ? null : rec(i.payment_change);
        const r = applyTrusteeVoucher({ loan_id: loan, ledgers: l, schedule: list<Record<string, unknown>>(i.schedule).map((s) => ({ due: D(String(s.due)), payment_number: Number(s.payment_number), pi_cents: cents(s.pi_cents), escrow_cents: cents(s.escrow_cents), amount_cents: cents(s.amount_cents) })) as PostpetitionScheduleEntry[], note: { original_upb_cents: cents(note.original_upb_cents), rate_pct: str(note, "rate_pct"), term_months: Number(note.term_months), pi_cents: cents(note.pi_cents) },
          voucher: { amount_cents: cents(i.amount_cents), designation: str(i, "designation") || null, received_on: optDate(i, "received_on") ?? today(ctx), case_number_full: str(i, "case_number_full") || null, claim_no: str(i, "claim_no") || null, memo: str(i, "memo") || null }, conduit_district: conduit, plan_designation: (plan || null) as "post-petition" | "arrearage" | null,
          claim: { total_cents: cents(claim.total_cents), components: list<Record<string, unknown>>(claim.components).map((c) => ({ component: String(c.component) as ClaimComponent["component"], installment_due: c.installment_due ? D(String(c.installment_due)) : null, cents: cents(c.cents) })) },
          payment_change: pc ? { prior_amount_cents: cents(pc.prior_amount_cents), new_amount_cents: cents(pc.new_amount_cents), effective_due_date: D(String(pc.effective_due_date)), form_410s1_filed_on: pc.form_410s1_filed_on ? D(String(pc.form_410s1_filed_on)) : null, form_410s1_docket_no: pc.form_410s1_docket_no ? String(pc.form_410s1_docket_no) : null } : null, chapter: (str(i, "chapter") || "13") as Chapter });
        ctx.ledger.post(r.receipt_postings, ctx.now); ctx.ledger.post(r.postings, ctx.now);
        ctx.decide({ agent: ctx.actor.id, action: "payment_application", rationale: r.decision.rationale, ruleSetVersion: RULE_SET_VERSION.guide, loanId: loan, ruleCode: "14.1:rule6a" });
        emitAll(ctx, loan, r.events);
        return { ...r, ledgers: l };
      }
      const applied: "post-petition" | "arrearage" = designation === "arrearage" ? "arrearage" : designation === "unlabelled" ? ((plan as "post-petition" | "arrearage" | "") || (conduit ? "post-petition" : "arrearage")) : "post-petition";
      const r = applyVoucher(l, { amount_cents: cents(i.amount_cents), designation: applied === "arrearage" ? "arrearage" : "post-petition", conduit_district: conduit });
      const rationale = `voucher designation "${designation}" → ${applied}${designation === "unlabelled" ? ` first (${plan ? "confirmed plan designation" : conduit ? "conduit district" : "non-conduit district"})` : ""}: ${r.applied_postpetition_cents} post-petition, ${r.applied_arrearage_cents} arrearage`;
      ctx.decide({ agent: ctx.actor.id, action: "payment_application", rationale, ruleSetVersion: RULE_SET_VERSION.guide, loanId: loan, ruleCode: "14.1:rule6a" });
      ctx.events.append({ type: "bankruptcy.trustee_payment.received", loanId: loan, actor: ctx.actor, payload: { amount_cents: cents(i.amount_cents), designation, designation_applied: applied, applied_postpetition_cents: r.applied_postpetition_cents, applied_arrearage_cents: r.applied_arrearage_cents, short: r.short, clearing_account: "bk_trustee_clearing" } });
      return { ...r, designation, designation_applied: applied, decision: { decision_type: "payment_application", rationale }, ledgers: l, clearing_account: "bk_trustee_clearing" }; }),
    guardrails: [never("NO_EDIT_POSTED_VOUCHER", "14.1 edge case: a mis-posted trustee voucher is reversed by new entries, never edited", (i) => flag(i, "edit_posted"), "post reversing entries linked to the original")] },
  { name: "bk.ledger.apply_postpetition", kind: "write", moneyFields: ["amount_cents"], handler: compute((i, ctx) => { need(i, "loan_id", "ledgers", "amount_cents", "received_on");
      const l = ledgersOf(i.ledgers); const r = applyDebtorPayment(l, cents(i.amount_cents), date(i, "received_on"), flag(i, "counsel_directs_arrears"));
      ctx.events.append({ type: "bankruptcy.postpetition.payment.applied", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { amount_cents: cents(i.amount_cents), applied: r.applied, suspense_cents: r.suspense_cents, hold: r.hold } });
      return { ...r, ledgers: l }; }),
    guardrails: [never("NO_ARREARAGE_FROM_DIRECT_PAY", "14.1 rule 6(b): debtor direct payments never touch the pre-petition arrearage unless the debtor's counsel directs it in writing", (i) => flag(i, "counsel_directs_arrears") && !str(i, "counsel_direction_document_id"), "attach counsel's written direction")] },
  { name: "documents.render/search", kind: "act", handler: compute((i, ctx, rt) => { const op = str(i, "op") || "search";
      if (op === "search") return rt.store.list("documents").filter((r) => (!str(i, "loan_id") || r.data.loan_id === str(i, "loan_id")) && (!str(i, "kind") || r.data.kind === str(i, "kind"))).map((r) => r.data);
      if (op !== "render") throw new RangeError(`documents.render/search op ${op} is not one of search/render`);
      need(i, "loan_id", "template_code");
      const r = rt.store.put("documents", str(i, "id") || `doc-${str(i, "loan_id")}-${str(i, "template_code")}-${ctx.now}`, { loan_id: str(i, "loan_id"), template_code: str(i, "template_code"), kind: /^CRT_/.test(str(i, "template_code")) ? "court_paper" : "document", status: flag(i, "release") ? "released" : "drafting", payload_hash: str(i, "payload_hash") || null, ...(flag(i, "release") ? { attorney_accepted: flag(i, "attorney_accepted"), signing_officer_signed: flag(i, "signing_officer_signed") } : {}) }, ctx.actor, ctx.now);
      ctx.events.append({ type: "document.rendered", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { document_id: r.id, template_code: str(i, "template_code"), status: r.data.status } }); return r.data; }),
    // every op other than `search` is a render (unknown ops are refused by the handler), so the release guardrail keys on "not a search", never on one literal op name
    guardrails: [never("COURT_PAPER_NEEDS_ATTORNEY_AND_SIGNATURE", "14.1 guardrail: no court paper leaves without attorney acceptance and, where the form carries a declaration (Forms 410/410A/410S-1/410S-2/410C13-*, MFR declarations, reaffirmation execution), a signing_officer signature", (i) => (str(i, "op") || "search") !== "search" && /^CRT_/.test(str(i, "template_code")) && flag(i, "release") && !(flag(i, "attorney_accepted") && (!(carriesDeclaration(str(i, "template_code")) || flag(i, "carries_declaration")) || flag(i, "signing_officer_signed"))), "route the package to the attorney (and the signing officer for declarations) before release")] },
  { name: "timer.*", kind: "act", handler: timerOps() },
  { name: "attorney.send_package/request", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "firm_id", "op"); const loan = str(i, "loan_id"); const firm = str(i, "firm_id"); const op = str(i, "op");
      switch (op) {
        case "send_package": {   // rule 3: the referral package (E-1.1-02) — `bankruptcy.referral.sent` with the referral type, the "repeat filer" label and the E-2.2-01/-04 completion date (FNMA_F2_01_BK_REFERRAL_14, FNMA_E2_1_08_…, FNMA_E2_1_04_LAWFIRM_ACK_2BD, the completion clocks)
          need(i, "type", "chapter", "petition_on");
          const r = referralPackage({ loan_id: loan, chapter: str(i, "chapter") as Chapter, petition_on: date(i, "petition_on"), sent_on: optDate(i, "sent_on") ?? today(ctx), type: str(i, "type") as ReferralType, firm_id: firm, fnma_delinquency_days_at_filing: Number(i.fnma_delinquency_days_at_filing ?? 0), open_foreclosure: flag(i, "open_foreclosure"), day_60_on: optDate(i, "day_60_on"), serial_filer_class: (str(i, "serial_filer_class") || "none") as SerialFilerClass, plan_confirmed: flag(i, "plan_confirmed") });
          const id = str(i, "id") || `ref-${loan}-${str(i, "type")}-${ctx.now}`;
          const stored = rt.store.put("bankruptcy_referrals", id, { loan_id: loan, firm_id: firm, type: str(i, "type"), chapter: str(i, "chapter"), label: r.label, full: r.full, package_document_id: str(i, "package_document_id") || null, contents: [...r.contents], sent_at: r.event.payload.sent_at, ack_due: r.ack_due, status: "sent" }, ctx.actor, ctx.now);
          emitAll(ctx, loan, [{ ...r.event, payload: { ...r.event.payload, referral_id: id } }]);
          ctx.decide({ agent: ctx.actor.id, action: "referral", rationale: `${str(i, "type")} referral to ${firm}${r.label ? ` marked "${r.label}"` : ""}${r.due ? `; due ${r.due} (${r.timer})` : " (immediate)"}${r.completion.due ? `; completion ${r.completion.timer} ${r.completion.due}` : ""}`, ruleSetVersion: RULE_SET_VERSION.guide, loanId: loan, ruleCode: "14.1:rule3" });
          if (r.escalation) rt.escalations.open({ kind: "officer", loanId: loan, severity: "sev1", payload: { reason: r.escalation.reason } }, ctx.actor);
          return { ...r, referral_id: id, referral: stored.data };
        }
        case "request": { need(i, "subject"); return ctx.events.append({ type: "attorney.request.sent", loanId: loan, actor: ctx.actor, payload: { firm_id: firm, subject: str(i, "subject"), kind: str(i, "kind") || "instruction" } }); }
        case "acknowledged": {   // E-2.1-04 (2 BD): satisfies FNMA_E2_1_04_LAWFIRM_ACK_2BD; arms FNMA_E2_1_05_NOA_FILED_10BD
          need(i, "referral_id"); const ref = rt.store.get("bankruptcy_referrals", str(i, "referral_id"))?.data ?? null;
          const r = referralAcknowledged({ loan_id: loan, referral_id: str(i, "referral_id"), firm_id: firm, sent_at: optDate(i, "sent_at") ?? D(String(ref?.sent_at ?? "")), acknowledged_at: at(i, "acknowledged_at", ctx), acknowledged_by: str(i, "acknowledged_by") || null });
          emitAll(ctx, loan, [r.event]); rt.store.put("bankruptcy_referrals", str(i, "referral_id"), { acknowledged_at: r.event.payload.acknowledged_at, status: "acknowledged", noa_due: r.noa.due }, ctx.actor, ctx.now);
          return r;
        }
        case "document_request": {   // E-2.1-04 (3 BD): arms FNMA_E2_1_04_DOCS_TO_FIRM_3BD (T17)
          need(i, "request_id", "items");
          const r = documentRequest({ loan_id: loan, firm_id: firm, request_id: str(i, "request_id"), request_at: at(i, "request_at", ctx), items: strs(i.items) });
          emitAll(ctx, loan, [r.event]); rt.store.put("attorney_document_requests", str(i, "request_id"), { loan_id: loan, firm_id: firm, request_at: r.event.payload.request_at, items: strs(i.items), due: r.due.due, status: "open" }, ctx.actor, ctx.now);
          return r;
        }
        case "document_fulfilled": {   // satisfies FNMA_E2_1_04_DOCS_TO_FIRM_3BD — only when every requested item is provided
          need(i, "request_id", "document_ids"); const req = rt.store.get("attorney_document_requests", str(i, "request_id"))?.data ?? null;
          const r = documentRequestFulfilled({ loan_id: loan, request_id: str(i, "request_id"), request_at: str(i, "request_at") || String(req?.request_at ?? ""), fulfilled_at: at(i, "fulfilled_at", ctx), items_requested: i.items_requested !== undefined ? strs(i.items_requested) : strs(req?.items), items_provided: i.items_provided !== undefined ? strs(i.items_provided) : (i.items_requested !== undefined ? strs(i.items_requested) : strs(req?.items)), document_ids: strs(i.document_ids) });
          emitAll(ctx, loan, [r.event]); rt.store.put("attorney_document_requests", str(i, "request_id"), { fulfilled_at: r.event.payload.fulfilled_at, document_ids: strs(i.document_ids), status: "fulfilled", in_time: r.in_time }, ctx.actor, ctx.now);
          return r;
        }
        case "workout_proposal": {   // E-2.1-04 (5 BD review; 10 BD submission where approval is required): arms FNMA_E2_1_04_WORKOUT_REVIEW_5BD / FNMA_E2_1_04_WORKOUT_SUBMIT_10BD
          need(i, "proposal_id", "kind");
          const r = workoutProposal({ loan_id: loan, firm_id: firm, proposal_id: str(i, "proposal_id"), received_at: at(i, "received_at", ctx), kind: str(i, "kind") as WorkoutKind, terms: rec(i.terms), delegated_authority: flag(i, "delegated_authority") });
          emitAll(ctx, loan, [r.event]); rt.store.put("bankruptcy_workout_proposals", str(i, "proposal_id"), { loan_id: loan, firm_id: firm, kind: str(i, "kind"), received_at: r.event.payload.received_at, approval_required: r.approval_required, review_due: r.review.due, submit_due: r.submit?.due ?? null, status: "received" }, ctx.actor, ctx.now);
          return r;
        }
        case "workout_reviewed": {   // satisfies FNMA_E2_1_04_WORKOUT_REVIEW_5BD
          need(i, "proposal_id", "recommendation", "rationale"); const prop = rt.store.get("bankruptcy_workout_proposals", str(i, "proposal_id"))?.data ?? null;
          const r = workoutProposalReviewed({ loan_id: loan, proposal_id: str(i, "proposal_id"), received_at: str(i, "received_at") || String(prop?.received_at ?? ""), reviewed_at: at(i, "reviewed_at", ctx), recommendation: str(i, "recommendation") as WorkoutRecommendation, rationale: str(i, "rationale"), reviewer: `${ctx.actor.kind}:${ctx.actor.id}` });
          emitAll(ctx, loan, [r.event]); ctx.decide({ agent: ctx.actor.id, action: "plan_review", rationale: str(i, "rationale"), ruleSetVersion: RULE_SET_VERSION.guide, loanId: loan, ruleCode: "14.1:E-2.1-04" });
          rt.store.put("bankruptcy_workout_proposals", str(i, "proposal_id"), { reviewed_at: r.event.payload.reviewed_at, recommendation: str(i, "recommendation"), status: "reviewed" }, ctx.actor, ctx.now);
          return r;
        }
        case "notify": {   // E-2.1-04 (5 BD): the decision relayed to counsel — satisfies FNMA_E2_1_04_DECISION_TO_FIRM_5BD
          need(i, "subject", "regarding");
          const r = attorneyNotified({ loan_id: loan, firm_id: firm, notified_at: at(i, "notified_at", ctx), subject: str(i, "subject"), regarding: str(i, "regarding") as "fnma_workout_decision" | "adequate_protection" | "instruction" | "status", proposal_id: str(i, "proposal_id") || null, decision: str(i, "decision") || null, document_id: str(i, "document_id") || null, decision_received_at: str(i, "decision_received_at") || null });
          emitAll(ctx, loan, [r.event]); return r;
        }
        case "agreed_order_noticed": {   // Rule 4001(d) (+9006(f)); policy 14.1-Q7 — arms FRBP_4001D_AGREED_ORDER_OBJ_14
          need(i, "mailed_at", "cure_months", "postpetition_default_cents");
          const r = agreedOrderNoticed({ loan_id: loan, mailed_at: date(i, "mailed_at"), served_by_mail: flag(i, "served_by_mail"), cure_months: Number(i.cure_months), postpetition_default_cents: cents(i.postpetition_default_cents), debtor_otherwise_performing: flag(i, "debtor_otherwise_performing"), document_id: str(i, "document_id") || null });
          emitAll(ctx, loan, [r.event]); ctx.decide({ agent: ctx.actor.id, action: "agreed_order", rationale: r.escalation.reason, ruleSetVersion: RULE_SET_VERSION.guide, loanId: loan, ruleCode: "14.1:Q7" });
          rt.escalations.open({ kind: "attorney", loanId: loan, payload: { reason: r.escalation.reason, objection_deadline: r.objection_deadline } }, ctx.actor);
          return r;
        }
        case "codebtor_relief_requested": {   // §1301(c)/(d) — arms USC_1301D_CODEBTOR_RELIEF_20 for a (c)(2) request
          need(i, "filed_at", "ground", "codebtor_ids");
          const r = codebtorReliefRequested({ loan_id: loan, filed_at: date(i, "filed_at"), ground: str(i, "ground") as CodebtorGround, codebtor_ids: strs(i.codebtor_ids), document_id: str(i, "document_id") || null });
          emitAll(ctx, loan, [r.event]); return r;
        }
        default: throw new RangeError(`attorney.send_package/request op ${op} is not one of ${ATTORNEY_OPS.join("/")}`);
      } }),
    guardrails: [never("NO_LEGAL_STRATEGY_TO_FIRM", "14.1 escalations: strategy on cramdowns, contested matters and ambiguous orders is the attorney's (and Fannie Mae's) domain", (i) => flag(i, "legal_strategy"), "route to the attorney; Fannie Mae must be consulted on cramdown strategy (E-2.3-03)")] },
  { name: "escalation.file", kind: "act", handler: escalate("attorney") },
  { name: "notice.send", kind: "act", handler: compute((i, ctx, rt) => noticeOps("render_send")(str(i, "template_code") === "NTC_BK_BREACH_INFORMATIONAL" ? { ...i, payload: breachLetterPayload(rec(i.payload)) } : i, ctx, rt)),   // the breach letter's cure period is derived from its dates (E-2.2-01: at least 30 days), never self-reported
    guardrails: [never("INFORMATIONAL_TEMPLATES_ONLY", "14.1 guardrail: no outbound collection communication to a debtor while gates are on (template allowlist enforced in notice.send)", (i) => !INFORMATIONAL_TEMPLATES.test(str(i, "template_code")), "only the informational bankruptcy templates may be sent by bankruptcy-ops")] },
  { name: "smdu.package.prepare", kind: "act", handler: compute((i, ctx, rt) => { const op = str(i, "op") || "prepare"; need(i, "loan_id"); const loan = str(i, "loan_id");
      if (op === "submit_workout") {   // E-2.1-04: the workout submitted to Fannie Mae through SMDU (12.x) — satisfies FNMA_E2_1_04_WORKOUT_SUBMIT_10BD
        need(i, "proposal_id", "workout"); const submittedOn = optDate(i, "submitted_on") ?? today(ctx);
        const ev = ctx.events.append({ type: "smdu.case.submitted", loanId: loan, actor: ctx.actor, payload: { workout: str(i, "workout"), proposal_id: str(i, "proposal_id"), submitted_on: submittedOn, submitted_at: ctx.now, case_id: str(i, "smdu_case_id") || null, bankruptcy: true } });
        rt.store.put("bankruptcy_workout_proposals", str(i, "proposal_id"), { loan_id: loan, submitted_on: submittedOn, status: "submitted_to_fannie_mae" }, ctx.actor, ctx.now);
        return { submitted_on: submittedOn, event: ev.type, proposal_id: str(i, "proposal_id") };
      }
      if (op === "decision_received") {   // Fannie Mae's decision (SMDU) — arms FNMA_E2_1_04_DECISION_TO_FIRM_5BD
        need(i, "proposal_id", "decision");
        const r = fnmaWorkoutDecision({ loan_id: loan, proposal_id: str(i, "proposal_id"), received_at: at(i, "received_at", ctx), decision: str(i, "decision") as "approved" | "declined" | "countered", smdu_case_id: str(i, "smdu_case_id") || null, conditions: strs(i.conditions) });
        emitAll(ctx, loan, [r.event]); rt.store.put("bankruptcy_workout_proposals", str(i, "proposal_id"), { loan_id: loan, fnma_decision: str(i, "decision"), decision_received_at: r.event.payload.received_at, relay_due: r.relay.due, status: "decided" }, ctx.actor, ctx.now);
        return r;
      }
      if (op !== "prepare") throw new RangeError(`smdu.package.prepare op ${op} is not one of prepare/submit_workout/decision_received`);
      need(i, "pre_upb_cents", "post_upb_cents", "secured_cents", "unsecured_cents", "plan_order_document_id");
      const pkg = { loan_id: loan, pre_cramdown_upb_cents: cents(i.pre_upb_cents), post_cramdown_upb_cents: cents(i.post_upb_cents), lpi: str(i, "lpi") || null, secured_cents: cents(i.secured_cents), unsecured_cents: cents(i.unsecured_cents), rate_pct: str(i, "rate_pct") || null, term_months: Number(i.term_months ?? 0) || null, payment_cents: cents(i.payment_cents), plan_order_document_id: str(i, "plan_order_document_id"), plan_terms_view: "pending_fnma_booking" };
      const task = rt.escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", loanId: loan, payload: { portal: "SMDU UI", purpose: "cramdown reporting", package: pkg } }, ctx.actor);
      return { package: pkg, task }; }),
    guardrails: [never("SMDU_ONLY_AFTER_CONFIRMATION", "14.1 rule 9: the SMDU reporting task is created only after confirmation; the plan-terms view is held pending Fannie Mae booking", (i) => (str(i, "op") || "prepare") === "prepare" && !flag(i, "plan_confirmed"), "wait for the confirmation order")] },
  { name: "p360.claim.prepare", kind: "act", handler: compute((i) => { need(i, "milestone", "milestone_on", "chapter", "lines");
      return expenseClaim({ milestone: str(i, "milestone") as ClaimMilestone, milestone_on: date(i, "milestone_on"), chapter: str(i, "chapter") as Chapter, lines: list<Record<string, unknown>>(i.lines).map((l) => ({ kind: String(l.kind) as BkFeeKind, invoiced_cents: cents(l.invoiced_cents) })) }); }),
    guardrails: [needsRole("EXCESS_FEE_APPROVAL_OFFICER", "14.1 escalations: excess-fee approvals over policy limits are officer decisions (Excess Attorney Fee/Cost Guidelines)", (i) => flag(i, "approve_excess"), ["officer"], "the agent matches lines to the exhibit; the officer approves excess")] },
  { name: "fnma.form20.prepare", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id"); const loan = str(i, "loan_id"); const op = str(i, "op") || (flag(i, "submit") ? "submit" : "prepare");
      if (op === "submit") {   // the officer submits Form 20 to Fannie Mae Legal (F-4-02 contact) — satisfies FNMA_E2_3_03_FORM20_IMMEDIATE_1BD
        need(i, "cause", "required_at", "package_document_id", "fnma_contact");
        const r = form20Submitted({ loan_id: loan, cause: str(i, "cause") as "cramdown" | "chapter_11", required_at: str(i, "required_at"), submitted_at: at(i, "submitted_at", ctx), submitted_by: { kind: ctx.actor.kind, id: ctx.actor.id, ...(ctx.actor.role ? { role: ctx.actor.role } : {}) }, channel: (str(i, "channel") || "email") as "email" | "upload", package_document_id: str(i, "package_document_id"), fnma_contact: str(i, "fnma_contact") });
        emitAll(ctx, loan, [r.event]); rt.store.put("form20_packages", str(i, "package_id") || `f20-${loan}`, { loan_id: loan, status: "submitted", submitted_at: r.event.payload.submitted_at, submitted_by: r.event.payload.submitted_by, cause: str(i, "cause") }, ctx.actor, ctx.now);
        return r;
      }
      if (op !== "prepare") throw new RangeError(`fnma.form20.prepare op ${op} is not one of prepare/submit`);
      need(i, "claim_cents", "requested_on");
      const r = cramdownRequest({ claim_cents: cents(i.claim_cents), secured_value_cents: i.secured_value_cents === undefined ? null : cents(i.secured_value_cents), bifurcates: flag(i, "bifurcates"), modifies: list<PlanModification>(i.modifies), principal_residence: flag(i, "principal_residence"), short_term_or_balloon: flag(i, "short_term_or_balloon"), requested_on: date(i, "requested_on"), recourse_or_indemnification: flag(i, "recourse_or_indemnification"), confirmed_on: optDate(i, "confirmed_on") });
      // rule 9: `bankruptcy.cramdown.requested` and the Form 20 clock's trigger `bankruptcy.form20.required{cause=cramdown}` (E-2.3-03 "must immediately be reported")
      emitAll(ctx, loan, r.emitted.map((e) => ({ ...e, payload: { ...e.payload, loan_id: loan, form20_due: r.form20?.due ?? null } })));
      for (const e of r.escalations) rt.escalations.open({ kind: e.kind === "fnma_portal_operator" ? "human_portal_task" : e.kind, loanId: loan, ...(e.severity ? { severity: e.severity } : {}), payload: { reason: e.reason } }, ctx.actor);   // the SMDU/DRA portal work is the app's human_portal_task (owner role fnma_portal_operator)
      const pkg = r.form20 ? rt.store.put("form20_packages", str(i, "id") || `f20-${loan}-${str(i, "requested_on")}`, { loan_id: loan, ...r.form20, form_3179_created: false, required_at: `${str(i, "requested_on")}T12:00:00.000Z` }, ctx.actor, ctx.now).data : null;
      return { ...r, package: pkg }; }),
    guardrails: [needsRole("FORM20_SUBMIT_OFFICER", "14.1 guardrail: Form 20 and repurchase decisions require officer", (i) => flag(i, "submit") || str(i, "op") === "submit" || flag(i, "decide_repurchase"), ["officer"], "the agent prepares the package; the officer submits Form 20 and decides the voluntary repurchase"),
      never("NO_FORM_3179_IN_CRAMDOWN", "14.1 rule 9(c): a cramdown never modifies the note or files a Form 3179; late charges are never capitalized (Cramdown FAQ Q2)", (i) => flag(i, "create_form_3179") || flag(i, "capitalize_late_charges"), "separate accounting for secured/unsecured portions with no change to the note (E-2.3-03)")] },
]);
