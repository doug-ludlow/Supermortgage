/**
 * §11 tools — early intervention and collections. 11.2 (`default-collections`)
 * runs the written-notice pipeline; 11.3 (`borrower-comms`) runs the QRPC
 * conversation. 11.1, 11.4 and 11.5 name no tool strings of their own in
 * the registry (their Agents paragraphs describe engines whose commands are
 * the 11.2/11.3 tools plus §2/§4/§12 tools). Guardrails encode the
 * "never"/"cannot" sentences.
 */
import { defineTools, escalate, compute, never, needsRole, noticeOps, port, read, write, log, decision, cents, str, num, flag, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { formatCents } from "../../kernel/money/cents.ts";
import { noticeCycle, nextNoticeDue, variantFor, type Cycle } from "../../domain/early-intervention/windows.ts";
import { qrpcCompleteness, promiseToPay, thirdPartyAuthorization, reasonCode, type Conversation } from "../../domain/early-intervention/qrpc.ts";
import { eiRenderGate, eiChannel, dcLoanEiNotice, validateExtraction, licensedNegotiationGate, thirdPartyCall } from "../../domain/early-intervention/ops.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const RETENTION_OPTIONS = ["repayment plan", "payment deferral", "forbearance", "loan modification (Flex Modification)"];
const DISPOSITION_OPTIONS = ["short sale", "Mortgage Release (deed-in-lieu)"];
const ELIGIBILITY_WORDS = /\b(you (will )?qualify|you are (approved|eligible)|guaranteed|we will approve)\b/i;
const THREAT_WORDS = /\b(we will (sue|foreclose (tomorrow|next week))|arrest|garnish|legal action will)\b/i;
const CHECKLIST_KEYS = ["encouragement_statement", "assigned_contact_phone", "mailing_address", "lossmit_examples_retention", "lossmit_examples_disposition", "apply_instructions_or_how_to_learn_more", "counselor_website", "hud_phone", "continuity_block_present", "exclusive_noe_rfi_address"];

// ---- 11.2 written early intervention notice ----------------------------------
const p112 = defineTools("11.2", "default-collections", [
  { name: "windows.list", kind: "read", handler: read("regx_ei_windows") },
  { name: "cycle.compute", kind: "read", handler: compute((i) => { const provided = date(i, "provided_on"); const variant = (str(i, "variant") || "standard") as Cycle["variant"]; const c = noticeCycle(provided, variant, str(i, "id") || `cycle-${provided}`);
      return { ...c, next: nextNoticeDue(c, num(i, "regx_days_delinquent_at_cycle_end") || 0, optDate(i, "earliest_unpaid_due")) }; }) },
  { name: "bk.status", kind: "read", handler: read("bankruptcy_cases") },
  { name: "fdcpa.status", kind: "read", handler: read("fdcpa_status") },
  { name: "continuity.assignment.get", kind: "read", handler: read("contact_assignments") },
  { name: "lossmit.options.list", kind: "read", handler: compute((i) => ({ retention: RETENTION_OPTIONS, disposition: DISPOSITION_OPTIONS, qualifier: "Not all borrowers qualify.", variant: variantFor({ bk_active: flag(i, "bk_active"), debt_collector: flag(i, "debt_collector"), cease_active: flag(i, "cease_active") }) })) },
  { name: "notice.render", kind: "act", handler: noticeOps("render"),
    guardrails: [never("NO_STATE_PREFORECLOSURE_COMBO", "11.2 guardrail: never combine with a state pre-foreclosure notice unless the jurisdiction flag allows", (i) => flag(i, "combine_with_state_preforeclosure_notice") && !flag(i, "ei_combined_mailing_allowed"), "jurisdiction_rules.ei_combined_mailing_allowed is false"),
      never("BK_ONCE_PER_CASE", "11.2 guardrail: never send a second bk notice in the same case", (i) => str(i, "variant").startsWith("bk") && flag(i, "bk_notice_sent_for_case"), "comment 39(c)(2)-1: one modified notice per case, reopened cases included"),
      never("NO_PAYMENT_REQUEST_IN_MODIFIED", "11.2 guardrail: never send a payment request in bk/fdcpa variants", (i) => /^(bk|fdcpa)/.test(str(i, "variant")) && ((i.payload as Record<string, unknown> | undefined)?.amount_due_cents !== undefined), "modified variants carry no amount due")] },
  { name: "checklist.verify", kind: "read", handler: compute((i) => { const c = (i.checklist as Record<string, unknown> | undefined) ?? {}; const failing = CHECKLIST_KEYS.filter((k) => c[k] !== true); const gate = eiRenderGate({ assigned_contact_block_present: c.continuity_block_present === true, exclusive_address_present: c.exclusive_noe_rfi_address === true });
      const dc = flag(i, "fdcpa_debt_collector") ? dcLoanEiNotice({ text: str(i, "rendered_text"), validation_end: optDate(i, "validation_period_end_on") ?? D("2000-01-01"), ref_date: optDate(i, "ref_date") ?? D("2000-01-01"), in_validation_period: flag(i, "in_validation_period") }) : null;
      return { passed: failing.length === 0 && (dc === null || dc.accepted), failing, action: gate.action, dc }; }) },
  { name: "print.request", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "notice_id"); const r = await port(rt, "printMail").submit({ jobId: str(i, "job_id") || `job-${str(i, "notice_id")}`, noticeId: str(i, "notice_id"), pdf: str(i, "pdf") || "", recipient: str(i, "recipient") || "" } as unknown as Parameters<ReturnType<typeof port<"printMail">>["submit"]>[0], ctx.now);
      ctx.events.append({ type: "notice.print.requested", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { notice_id: str(i, "notice_id") } }); return r; }),
    guardrails: [never("CHECKLIST_BEFORE_PRINT", "11.2 timer table: SM_EI_NOTICE_CONTENT_CHECKLIST — send refused while any item is false", (i) => flag(i, "checklist_failed"), "the checklist blocks the send")] },
  { name: "edeliver.send", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "notice_id", "address"); const ch = eiChannel({ esign_consent_regx_ei: flag(i, "esign_consent_regx_ei") }); if (ch.channel === "mail") return { sent: false, fallback: "mail", reason: "no esign consent for class regx_ei" };
      const r = await port(rt, "edelivery").send({ messageId: str(i, "message_id") || `msg-${str(i, "notice_id")}`, noticeId: str(i, "notice_id"), address: str(i, "address"), subject: str(i, "subject") || "Important information about your mortgage", body: str(i, "body") || "" } as unknown as Parameters<ReturnType<typeof port<"edelivery">>["send"]>[0], ctx.now);
      ctx.events.append({ type: "notice.edelivery.sent", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { notice_id: str(i, "notice_id") } }); return r; }),
    guardrails: [never("ESIGN_CONSENT_REQUIRED", "11.2 guardrail: never send electronically without consent (§1024.32(a)(1); E-SIGN)", (i) => !flag(i, "esign_consent_regx_ei"), "electronic delivery needs an unrevoked esign consent for class regx_ei")] },
  { name: "fnma.action.emit", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "action"); const a = str(i, "action"); if (!["Borrower Solicitation Package", "Outbound Contact Attempted", "Quality Right Party Contact"].includes(a)) throw new RangeError(`servicer action ${a} is not a §5.7 action type`);
      return ctx.events.append({ type: "delinquency.servicer_action", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { action: a, effective_on: str(i, "effective_on") || null } }); }) },
  { name: "decision.record", kind: "write", handler: decision() },
  { name: "escalate", kind: "act", handler: escalate("officer") },
]);

// ---- 11.3 QRPC ----------------------------------------------------------------
const p113 = defineTools("11.3", "borrower-comms", [
  { name: "identity.verify", kind: "read", handler: compute((i) => { const provided = (i.factors as Record<string, unknown> | undefined) ?? {}; const expected = (i.expected as Record<string, unknown> | undefined) ?? {}; const matched = Object.keys(expected).filter((k) => provided[k] !== undefined && String(provided[k]).toLowerCase() === String(expected[k]).toLowerCase());
      const ok = matched.length >= 2 && !("voiceprint" in provided); return { verified: ok, factors_matched: matched, account_details_allowed: ok, third_party: thirdPartyCall({ claimed_relation: str(i, "claimed_relation"), authorization_valid: flag(i, "authorization_valid") }) }; }),
    guardrails: [never("NO_VOICEPRINT", "11.1 design item 3: no voiceprints (Illinois BIPA)", (i) => (i.factors as Record<string, unknown> | undefined)?.voiceprint !== undefined, "voice biometrics are not an identity factor")] },
  { name: "disclosure.play", kind: "act", handler: compute((i, ctx) => { const dc = flag(i, "fdcpa_debt_collector"); const initial = flag(i, "initial_communication"); const script = [`I'm an automated assistant for Supermortgage; say "representative" at any time to reach a person.`, "This call is recorded.", ...(dc ? [initial ? "Supermortgage is a debt collector. We are attempting to collect a debt and any information obtained will be used for that purpose." : "This communication is from a debt collector."] : []), ...(str(i, "state_script") ? [str(i, "state_script")] : [])];
      ctx.events.append({ type: "contact.disclosure.played", loanId: ctx.loanId, actor: ctx.actor, payload: { ai_at: ctx.now, recording_at: ctx.now, fdcpa_at: dc ? ctx.now : null } }); return { script, ai_disclosure_at: ctx.now, recording_disclosure_at: ctx.now, fdcpa_disclosure_at: dc ? ctx.now : null }; }) },
  { name: "ledger.balances", kind: "read", handler: compute((i) => { need(i, "past_due_installments"); const inst = i.past_due_installments as { due_date: string; amount_cents: unknown }[]; const lc = Array.isArray(i.late_charges) ? (i.late_charges as { amount_cents: unknown }[]) : []; const fees = cents(i.fees_cents);
      const total = inst.reduce((a, x) => a + cents(x.amount_cents), 0n) + lc.reduce((a, x) => a + cents(x.amount_cents), 0n) + fees; return { as_of: str(i, "as_of"), total_delinquent_cents: total, stated: `${formatCents(total, { symbol: true, grouping: true })} as of ${str(i, "as_of")}`, source: "ledger" }; }),
    guardrails: [never("BALANCES_FROM_LEDGER_ONLY", "11.1 guardrail: no balance not read from the ledger", (i) => typeof i.model_stated_total === "string" || typeof i.model_stated_total === "number", "the AI never computes balances itself")] },
  { name: "payments.history", kind: "read", handler: read("payments") },
  { name: "lossmit_facts.get", kind: "read", handler: read("lossmit_facts") },
  { name: "qrpc.capture", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "contact_id"); const conv = (i.conversation as Conversation | undefined) ?? { verified_party: "unverified" as const }; const elements = (i.elements as Record<string, { value: unknown; evidence_span: string | null }> | undefined) ?? {};
      const ev = validateExtraction(elements); const c = qrpcCompleteness(conv); const status = !ev.valid || !c.complete ? "conversation_only" : flag(i, "ai_voice_counts") ? "qrpc_complete" : "pending_human_verification";
      const rec = rt.store.put("qrpc_records", str(i, "id") || `qrpc-${str(i, "contact_id")}`, { loan_id: str(i, "loan_id"), contact_id: str(i, "contact_id"), status, missing: c.missing, missing_evidence: ev.missing_evidence, fnma_reason_code: conv.reason_primary ? reasonCode(conv.reason_primary) : null, conducted_by: str(i, "conducted_by") || "ai_agent" }, ctx.actor, ctx.now);
      if (status === "qrpc_complete") ctx.events.append({ type: "contact.qrpc.established", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { qrpc_id: rec.id, reason_code: rec.data.fnma_reason_code } });
      return { id: rec.id, status, missing: c.missing, missing_evidence: ev.missing_evidence }; }),
    guardrails: [never("EVIDENCE_SPANS_REQUIRED", "11.3 guardrail: the extractor must cite transcript evidence for every element", (i) => { const e = (i.elements as Record<string, { value: unknown; evidence_span: string | null }> | undefined) ?? {}; return flag(i, "mark_qrpc") && !validateExtraction(e).valid; }, "hallucinated elements downgrade the call to conversation_only"),
      never("NO_QRPC_FROM_ONE_WAY", "11.3 guardrail: QRPC is never marked from a voicemail, SMS-only exchange or chatbot session without a verified two-way dialog", (i) => ["voicemail", "sms"].includes(str(i, "channel")), "QRPC needs a verified two-way dialog"),
      never("NO_UNVERIFIED_THIRD_PARTY", "11.3 guardrail: no discussion with unverified/unauthorized third parties", (i) => (i.conversation as Conversation | undefined)?.verified_party === "unverified", "verify the party or obtain an authorization first")] },
  { name: "promise.record", kind: "write", moneyFields: ["amount_cents"], handler: compute((i, ctx, rt) => { need(i, "loan_id", "amount_cents", "due_on", "recorded_on", "total_delinquent_cents"); const p = promiseToPay(cents(i.amount_cents), date(i, "due_on"), date(i, "recorded_on"), cents(i.total_delinquent_cents));
      const rec = rt.store.put("promises", str(i, "id") || `ptp-${str(i, "loan_id")}-${str(i, "due_on")}`, { loan_id: str(i, "loan_id"), amount_cents: cents(i.amount_cents), due_on: str(i, "due_on"), covers: p.covers, status: "open" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "borrower.promise_to_pay.recorded", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { promise_id: rec.id, plan: p.plan } }); return { id: rec.id, ...p }; }) },
  { name: "payment.schedule", kind: "act", moneyFields: ["amount_cents"], handler: compute((i, ctx) => { need(i, "loan_id", "amount_cents", "debit_on", "reg_e_authorization_id"); return ctx.events.append({ type: "payment.ach.scheduled", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { amount_cents: cents(i.amount_cents), debit_on: str(i, "debit_on"), authorization_id: str(i, "reg_e_authorization_id") } }); }),
    guardrails: [never("REG_E_AUTHORIZATION", "11.3 rule 3: in-call ACH needs a Reg E authorization", (i) => !i.reg_e_authorization_id, "record the Reg E authorization first")] },
  { name: "lossmit.request.create", kind: "write", handler: write("cases", "lossmit.assistance.requested") },
  { name: "lossmit.streamlined.evaluate", kind: "read", handler: compute((i) => { const kind = str(i, "kind"); const months = num(i, "term_months"); if (kind === "forbearance") return { delegated: months <= 3, limit: "≤3-month increments (LL-2026-01)", in_call_offer_allowed: months <= 3 && !flag(i, "mlo_licensing_for_lossmit") }; if (kind === "repayment_plan") return { delegated: months <= 12, limit: "≤12 months (D2-3.2-02)", in_call_offer_allowed: months <= 12 && !flag(i, "mlo_licensing_for_lossmit") }; throw new RangeError(`kind ${kind} is not forbearance/repayment_plan`); }),
    guardrails: [never("NO_ADVERSE_IN_CALL", "11.3 design item 5: adverse outcomes are never announced in-call", (i) => flag(i, "announce_denial"), "adverse outcomes go through lossmit_reviewer (12.x)")] },
  { name: "authorization.record", kind: "write", handler: compute((i, ctx, rt) => { need(i, "party_id", "kind", "on"); const a = thirdPartyAuthorization(str(i, "kind") as "written" | "oral_three_way", date(i, "on")); const rec = rt.store.put("party_authorizations", str(i, "id") || `auth-${str(i, "party_id")}`, { party_id: str(i, "party_id"), ...a, recorded_document_id: (i.recorded_document_id as string | undefined) ?? null }, ctx.actor, ctx.now); return rec.data; }),
    guardrails: [never("ORAL_NEEDS_VERIFIED_BORROWER", "11.3 rule 4: an oral three-way authorization requires the verified borrower on the call", (i) => str(i, "kind") === "oral_three_way" && !flag(i, "borrower_verified"), "verify the borrower first")] },
  { name: "preference.set", kind: "write", handler: write("contact_preferences", "contact.preference.set") },
  { name: "dispute.intake", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "received_on"); const rec = rt.store.put("cases", str(i, "id") || `noe-${str(i, "loan_id")}-${str(i, "received_on")}`, { loan_id: str(i, "loan_id"), case_type: "noe", received_on: str(i, "received_on"), source: "qrpc_dispute", status: "open" }, ctx.actor, ctx.now); ctx.events.append({ type: "case.noe.opened", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { case_id: rec.id } }); return rec.data; }) },
  { name: "human.transfer", kind: "act", handler: compute((i, ctx) => { need(i, "reason"); const target = str(i, "target") || "human_agent"; return ctx.events.append({ type: "contact.human_transfer.started", loanId: ctx.loanId, actor: ctx.actor, payload: { reason: str(i, "reason"), target, start_within_s: 10 } }); }) },
  { name: "contact.log", kind: "write", handler: log("contacts", "contact.logged") },
  { name: "decision.record", kind: "write", handler: decision(),
    guardrails: [never("NO_ELIGIBILITY_STATEMENTS", "11.3 guardrail: no eligibility or approval statements", (i) => ELIGIBILITY_WORDS.test(JSON.stringify(i.statements_made ?? "")), "the AI never states eligibility or approval"),
      never("NO_THREATS", "11.3 guardrail: no threats (§1006.18(c))", (i) => THREAT_WORDS.test(JSON.stringify(i.statements_made ?? "")), "no threat of action not intended or unlawful"),
      never("NO_NEGOTIATION_WHERE_LICENSED", "11.3 guardrail: no negotiation where licensed", (i) => licensedNegotiationGate({ question: str(i, "borrower_question"), mlo_licensing_for_lossmit: flag(i, "mlo_licensing_for_lossmit"), licensed_specialist_on_call: flag(i, "licensed_specialist_on_call") }).decline_quote && flag(i, "terms_quoted"), "warm-transfer to a licensed specialist")] },
]);

export const SECTION_11_TOOLS: readonly ToolDef[] = [...p112, ...p113];
export const officerRole = needsRole;
