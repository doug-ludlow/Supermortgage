/**
 * §11 tools — early intervention and collections. 11.2 (`default-collections`)
 * runs the written-notice pipeline; 11.3 (`borrower-comms`) runs the QRPC
 * conversation. The registry (spec/registry/agents.json) names no tool
 * strings for 11.1, 11.4 and 11.5 — their engines run on the 11.2/11.3 bus
 * tools plus §2/§4/§12 tools — and src/app/tools.test.ts refuses any tool a
 * process row does not name, so the 11.1/11.4/11.5 guardrail sentences are
 * enforced on the tools those engines actually call:
 *   - 11.1 "no dial without every pre-dial check passing" (the checks are
 *     computed at the boundary from `pre_dial_facts` through the section's
 *     evaluators and the store's cease/dispute state), "no more than one
 *     voicemail per number per 7 days", "no option, deadline or foreclosure
 *     statement not present in `lossmit_facts`", "never contacts a
 *     represented consumer directly" (11.4) → `contact.log` / `decision.record`;
 *   - 11.1 "terminate and mark human_only on borrower request" → `preference.set`;
 *   - 11.3 "no financial-detail demands" → `qrpc.capture` / `decision.record`;
 *   - 11.4 "the AI never states that a debt is 'not disputed'" → `decision.record`;
 *     "never sends an email/SMS without the opt-out line" → `edeliver.send`;
 *     "never adds a fee" → `payment.schedule`; "never mentions the debt to an
 *     unverified party" → `disclosure.play`; the §1006.38 dispute cease and the
 *     §1006.6(c) written cease refuse an outbound `contact.log` from the store;
 *   - 11.5 "no credit pull without a recorded permissible purpose", "no terms
 *     quoted before SMDU's decision", "no outbound solicitation below 30 days
 *     delinquent" → `lossmit.request.create` and `print.request` (solicitation).
 * The tools are also the producers of the section's events (`contact.attempted`,
 * `contact.completed`, `contact.live.established` + the canonical
 * `regx.ei_window.live.satisfied`, `contact.qrpc.captured` / `.reviewed` /
 * `.established`, `contact.plan.ceased` (cancels the D2-2-02 cadence clocks),
 * `consent.revoked` / `consent.revocation.honored`, `fdcpa.dispute.received`,
 * `solicitation_package.send_requested` / `.sent`, `notice.sent` for a notice the
 * Notice Registry did not send itself, `lossmit.evaluation_notice.sent`).
 */
import { defineTools, escalate, compute, never, guard, humanWhen, noticeOps, port, read, write, decision, cents, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { evaluateGate } from "../evaluators.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { formatCents } from "../../kernel/money/cents.ts";
import { noticeCycle, nextNoticeDue, variantFor, liveSatisfiedEvent, type Cycle } from "../../domain/early-intervention/windows.ts";
import { qrpcCompleteness, extractHardship, cessationOnQrpc, thirdPartyAuthorization, reasonCode, promiseToPay, type Conversation, type CommitmentKind } from "../../domain/early-intervention/qrpc.ts";
import { eiRenderGate, eiChannel, dcLoanEiNotice, dcEmailCheck, validateExtraction, licensedNegotiationGate, thirdPartyCall, delinquencySnapshot, stateOverlay, type LedgerFacts } from "../../domain/early-intervention/ops.ts";
import { ALL_CHECKS_PASS, FNMA_CADENCE_TIMERS, type PreDialChecks } from "../../domain/early-intervention/plan.ts";
import { cancelEarlyInterventionTimers } from "../../domain/early-intervention/timers.ts";
import { attemptRequestedForTool, liveContactOf } from "../../domain/early-intervention/ops-11-1.ts";
import { evaluateOutboundCommunication, type OutboundChannel } from "../../domain/early-intervention/ops-11-4.ts";
import { thirdPartyConversation, modificationTermsDiscussed, buildQrpcInvestorEvent, qrpcReasonType, THIRD_PARTY_ROLES } from "../../domain/early-intervention/ops-11-3.ts";
import { requestWrittenEiNotice } from "./section11-2.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const RETENTION_OPTIONS = ["repayment plan", "payment deferral", "forbearance", "loan modification (Flex Modification)"];
const DISPOSITION_OPTIONS = ["short sale", "Mortgage Release (deed-in-lieu)"];
const ELIGIBILITY_WORDS = /\b(you (will )?qualify|you are (approved|eligible)|guaranteed|we will approve)\b/i;
const THREAT_WORDS = /\b(we will (sue|foreclose (tomorrow|next week))|arrest|garnish|legal action will)\b/i;
/** 11.4 guardrail: the AI never states that a debt is "not disputed" (Reg F §1006.18; a consumer's failure to dispute is not an admission, §1006.38(e)). */
const NOT_DISPUTED_WORDS = /\b(not disputed|undisputed|is not in dispute|(no|don'?t have a|cannot|can'?t) (right|basis|grounds) to dispute|(too late|no longer able) to dispute)\b/i;
/** 11.3 guardrail: no financial-detail demands (figures are volunteered; the BRP is the documented path — 11.3-Q5). */
const FINANCIAL_DEMAND_WORDS = /\b(must|need to|have to|required to|require you to|before we can help)\b[^.]{0,40}\b(provide|give|send|submit|tell|disclose)\b[^.]{0,30}\b(income|pay ?stubs?|bank statements?|tax returns?|financial (details|information|statement)|assets|expenses|savings)\b/i;
/** 11.1 guardrail: option, deadline and foreclosure statements come from `lossmit_facts` (4.3), never from model memory. */
const OPTION_OR_DEADLINE_WORDS = /\b(foreclos|sale date|deadline|you have until|must (pay|respond|apply) by|within \d+ days|repayment plan|forbearance|deferral|modification|short sale|deed[- ]in[- ]lieu|mortgage release)/i;
const CHECKLIST_KEYS = ["encouragement_statement", "assigned_contact_phone", "mailing_address", "lossmit_examples_retention", "lossmit_examples_disposition", "apply_instructions_or_how_to_learn_more", "counselor_website", "hud_phone", "continuity_block_present", "exclusive_noe_rfi_address"];
const EVALUATION_TEMPLATES = ["NTC_FNMA_EVAL_NOTICE_STREAMLINED", "NTC_FNMA_D23206_TPP_OFFER", "NTC_FNMA_D23204_DEFERRAL_OFFER", "NTC_FNMA_D23205_DISASTER_DEFERRAL_OFFER", "NTC_FNMA_A42106_FORM182_ADVERSE_ACTION"];
const SOLICITATION_TEMPLATES: Record<string, "bsp" | "form745_letter"> = { NTC_FNMA_D2204_SOLICITATION_PACKAGE: "bsp", NTC_FNMA_D2204_SOLICITATION_LETTER_745: "form745_letter" };
/** The §1024.39(b) notice templates and their variant (11.2 rule 1); a print of one opens an `ei_notice_cycles` row. */
const EI_TEMPLATES: Record<string, Cycle["variant"]> = { NTC_REGX_39B_EARLY_INTERVENTION: "standard", NTC_REGX_39D_EARLY_INTERVENTION_FDCPA: "fdcpa", NTC_REGX_39C_EARLY_INTERVENTION_BK: "bk", NTC_REGX_39CD_EARLY_INTERVENTION_BK_FDCPA: "bk_fdcpa" };
const VERIFICATION_TEMPLATES = ["NTC_REGF_1006_38_VERIFICATION", "NTC_REGF_1006_38_DUPLICATIVE"];
const PRE_DIAL_KEYS = Object.keys(ALL_CHECKS_PASS) as (keyof PreDialChecks)[];
const statements = (i: ToolInput): string[] => { const s = i.statements_made ?? i.transcript ?? ""; return Array.isArray(s) ? s.map(String) : typeof s === "string" ? [s] : [JSON.stringify(s)]; };
const refuse = (ctx: CommandContext, loanId: string | undefined, command: string, code: string, citation: string, reason: string, subjectId?: string): never => {
  ctx.events.append({ type: "command.refused", ...(loanId ? { loanId } : {}), actor: ctx.actor, payload: { command, code, citation, reason, subject_id: subjectId ?? null } });
  throw new CommandRefused(command, code, citation, reason);
};

/**
 * 11.1 guardrail "no dial without every pre-dial check passing". With `pre_dial_facts` the checks are computed here
 * through the section's evaluators — TCPA consent / landline 3-in-30 (`consent`), quiet hours in every candidate time
 * zone (`quiet_hours`), the Reg F 7-in-7 cap on DC loans or the state/policy cap elsewhere (`regf_count`), the
 * post-conversation cooling-off, the pre-sale stop, the workplace rule — and the cease/bankruptcy/attorney flags.
 * Without facts the caller's `pre_dial_checks` booleans are used and recorded as self-reported (human dialer console).
 */
export function preDialChecks(i: ToolInput): { checks: PreDialChecks; computed: boolean; detail: Record<string, unknown> } {
  const f = i.pre_dial_facts as Record<string, unknown> | undefined;
  if (!f) { const c = (i.pre_dial_checks as Partial<Record<keyof PreDialChecks, unknown>> | undefined) ?? {}; return { checks: Object.fromEntries(PRE_DIAL_KEYS.map((k) => [k, c[k] === true])) as unknown as PreDialChecks, computed: false, detail: { source: "self_reported" } }; }
  const mode = str(i, "mode"); const channel = mode === "sms" ? "sms" : mode === "email" ? "email" : "voice";
  const dialAt = typeof f.dial_at === "string" ? f.dial_at : ""; const dialMs = Date.parse(dialAt);
  const tzs = Array.isArray(f.time_zones) ? (f.time_zones as string[]) : [];
  const lineType = String(f.line_type ?? "unknown"); const dc = f.fdcpa_debt_collector === true;
  const local = tzs.map((tz) => { const w = wallClock(dialMs, tz); return { tz, time: `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}` }; });
  const quiet = Number.isFinite(dialMs) && local.length > 0 && local.every((l) => evaluateGate("11.1.quietHours", { mode: channel, consumer_local_time: l.time }).open);
  let consent = true; let consentDetail = "n/a (human dial / mail)";
  if (mode === "ai_voice" || mode === "sms") {
    if (lineType === "landline" && mode === "ai_voice") { const g = f.written_consent === true ? { open: true } : evaluateGate("11.1.landlineAi3in30", { now: dialAt, ai_voice_attempts_at: f.ai_voice_attempts_at ?? [] }); consent = g.open; consentDetail = g.open ? "landline: within 3 AI-voice attempts in 30 days" : String((g as { reason?: string }).reason); }
    else { const g = evaluateGate("11.1.tcpaConsentUnrevoked", { mode: channel === "sms" ? "sms" : "voice", tcpa_voice_consent_active: f.tcpa_voice_consent_active === true, tcpa_sms_consent_active: f.tcpa_sms_consent_active === true }); consent = g.open; consentDetail = g.open ? "TCPA consent active" : String(g.reason); }
  }
  const attempts = Array.isArray(f.counted_call_attempts_at) ? (f.counted_call_attempts_at as string[]) : [];
  const overlay = stateOverlay({ state: String(f.state ?? ""), debt_collector: dc });
  const regf = channel !== "voice" ? { open: true, reason: "n/a" } : dc ? evaluateGate("11.1.callCap7in7", { now: dialAt, counted_call_attempts_at: attempts }) : (() => { const cnt = attempts.filter((t) => dialMs - Date.parse(t) < 7 * 86_400_000 && Date.parse(t) <= dialMs).length; const cap = overlay.contact_engine.call_cap_7d ?? 5; return cnt + 1 <= cap ? { open: true } : { open: false, reason: `${overlay.contact_engine.cap_code}: ${cnt + 1} > ${cap}` }; })();
  const post = channel !== "voice" ? { open: true } : evaluateGate("11.1.postConversationCooloff", { days_since_conversation: f.days_since_conversation ?? 999, callback_consent_within_7d: f.callback_consent_within_7d === true });
  const sale = evaluateGate("11.1.preSaleContactAllowed", { days_until_sale: f.days_until_sale ?? 9999, judicial: f.judicial === true, contact_required_through_sale: f.contact_required_through_sale === true });
  const workplace = evaluateGate("11.4.workplaceProhibited", { workplace_flag: f.workplace_flag === true, employer_prohibits: f.employer_prohibits === true });
  const checks: PreDialChecks = { consent, quiet_hours: quiet, regf_count: regf.open, post_conversation: post.open, pre_sale: sale.open, cease_flags: f.cease_active !== true && f.written_cease !== true && f.dispute_collection_ceased !== true, bk_flag: f.bk_active !== true, attorney_flag: f.attorney_represented !== true || flag(i, "to_counsel"), workplace: workplace.open };
  return { checks, computed: true, detail: { source: "pre_dial_facts", evaluators: ["11.1.quietHours", "11.1.tcpaConsentUnrevoked", "11.1.landlineAi3in30", "11.1.callCap7in7", "11.1.postConversationCooloff", "11.1.preSaleContactAllowed", "11.4.workplaceProhibited"], consumer_local_times: local, consent: consentDetail, frequency: regf, overlay: overlay.overlays, cap: overlay.contact_engine.call_cap_7d, post_conversation: post, pre_sale: sale, workplace } };
}
/** 11.1 decision record `pre_dial_checks{…}`: every named check must be true (computed from facts, else self-reported). */
const preDialChecksPass = (i: ToolInput): boolean => { const { checks } = preDialChecks(i); return PRE_DIAL_KEYS.every((k) => checks[k] === true); };
/** 11.1 guardrail: an option, deadline or foreclosure statement must appear in `lossmit_facts` (4.3), and `options_informed` must cite its source version. */
const outsideLossmitFacts = (i: ToolInput): boolean => {
  const facts = i.lossmit_facts as { version?: string; statements?: string[]; options?: string[]; deadlines?: string[]; foreclosure?: string[] } | undefined;
  const permitted = facts ? [...(facts.statements ?? []), ...(facts.options ?? []), ...(facts.deadlines ?? []), ...(facts.foreclosure ?? [])].map((s) => String(s).toLowerCase()) : [];
  const offending = statements(i).filter((s) => OPTION_OR_DEADLINE_WORDS.test(s) && !permitted.some((p) => s.toLowerCase().includes(p) || p.includes(s.toLowerCase())));
  const oi = i.options_informed as { text?: string; source_version?: string } | undefined;
  const unsourced = !!oi && (!oi.source_version || (facts?.version !== undefined && oi.source_version !== facts.version));
  return offending.length > 0 || unsourced;
};

// ---- 11.2 written early intervention notice ----------------------------------
const p112 = defineTools("11.2", "default-collections", [
  { name: "windows.list", kind: "read", handler: read("regx_ei_windows") },
  { name: "cycle.compute", kind: "read", handler: compute((i) => { const provided = date(i, "provided_on"); const variant = (str(i, "variant") || "standard") as Cycle["variant"]; const c = noticeCycle(provided, variant, str(i, "id") || `cycle-${provided}`);
      return { ...c, next: nextNoticeDue(c, num(i, "regx_days_delinquent_at_cycle_end") || 0, optDate(i, "earliest_unpaid_due")) }; }) },
  { name: "bk.status", kind: "read", handler: read("bankruptcy_cases") },
  { name: "fdcpa.status", kind: "read", handler: read("fdcpa_status") },
  { name: "continuity.assignment.get", kind: "read", handler: read("contact_assignments") },
  { name: "lossmit.options.list", kind: "read", handler: compute((i) => ({ retention: RETENTION_OPTIONS, disposition: DISPOSITION_OPTIONS, qualifier: "Not all borrowers qualify.", variant: variantFor({ bk_active: flag(i, "bk_active"), debt_collector: flag(i, "debt_collector"), cease_active: flag(i, "cease_active") }) })) },
  { name: "notice.render", kind: "act", handler: compute((i, ctx, rt) => {
      // 11.2 guardrail "never send a second bk notice in the same case" (comment 39(c)(2)-1): the store's `ei_notice_cycles` for the case is consulted, not the caller's flag.
      const loanId = (i.loan_id as string | undefined) ?? ctx.loanId; const variant = str(i, "variant") || EI_TEMPLATES[str(i, "template_code")] || "";
      if (variant.startsWith("bk")) { const caseId = str(i, "bk_case_id"); const prior = rt.store.list("ei_notice_cycles", (d) => d.loan_id === loanId && String(d.variant).startsWith("bk") && (!caseId || d.bk_case_id === caseId))[0];
        if (prior) refuse(ctx, loanId, "notice.render", "BK_ONCE_PER_CASE", "comment 39(c)(2)-1: one modified notice per case, reopened cases included", `a ${String(prior.data.variant)} notice ${String(prior.data.notice_id)} was already provided in case ${String(prior.data.bk_case_id)} on ${String(prior.data.provided_at)}`, String(prior.data.notice_id)); }
      // REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE (4.3 gate, 11.2-T9): an EI-variant render is first a written-notice request — the step in ./section11-2.ts
      // appends `notice.early_intervention_written.requested`, carries the assigned team's block, auto-assigns (4.3) with a `default_team`, or refuses the send.
      return noticeOps("render")({ ...i, payload: requestWrittenEiNotice(i, ctx, rt) }, ctx, rt); }),
    guardrails: [never("NO_STATE_PREFORECLOSURE_COMBO", "11.2 guardrail: never combine with a state pre-foreclosure notice unless the jurisdiction flag allows", (i) => flag(i, "combine_with_state_preforeclosure_notice") && !flag(i, "ei_combined_mailing_allowed"), "jurisdiction_rules.ei_combined_mailing_allowed is false"),
      never("BK_ONCE_PER_CASE", "11.2 guardrail: never send a second bk notice in the same case", (i) => (str(i, "variant") || EI_TEMPLATES[str(i, "template_code")] || "").startsWith("bk") && flag(i, "bk_notice_sent_for_case"), "comment 39(c)(2)-1: one modified notice per case, reopened cases included"),
      never("NO_PAYMENT_REQUEST_IN_MODIFIED", "11.2 guardrail: never send a payment request in bk/fdcpa variants", (i) => /^(bk|fdcpa)/.test(str(i, "variant") || EI_TEMPLATES[str(i, "template_code")] || "") && ((i.payload as Record<string, unknown> | undefined)?.amount_due_cents !== undefined), "modified variants carry no amount due")] },
  { name: "checklist.verify", kind: "read", handler: compute((i, _c, rt) => { const c = (i.checklist as Record<string, unknown> | undefined) ?? {}; const failing = CHECKLIST_KEYS.filter((k) => c[k] !== true); const gate = eiRenderGate({ assigned_contact_block_present: c.continuity_block_present === true, exclusive_address_present: c.exclusive_noe_rfi_address === true });
      const dc = flag(i, "fdcpa_debt_collector") ? dcLoanEiNotice({ text: str(i, "rendered_text"), validation_end: optDate(i, "validation_period_end_on") ?? D("2000-01-01"), ref_date: optDate(i, "ref_date") ?? D("2000-01-01"), in_validation_period: flag(i, "in_validation_period") }) : null;
      // The machine check: when the notice was rendered through the Notice Registry its template checklist result is authoritative.
      const n = rt.notices && typeof i.notice_id === "string" ? rt.notices.get(str(i, "notice_id")) : null;
      const registry = n ? { passed: n.checklist.passed, blocking: n.checklist.blocking.map((r) => r.rule_id), held: n.status === "held" } : null;
      return { passed: failing.length === 0 && (dc === null || dc.accepted) && (registry === null || (registry.passed && !registry.held)), failing: [...failing, ...(registry?.blocking ?? [])], action: gate.action, dc, registry }; }) },
  { name: "print.request", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "notice_id"); const noticeId = str(i, "notice_id"); const loanId = (i.loan_id as string | undefined) ?? ctx.loanId;
      // SM_EI_NOTICE_CONTENT_CHECKLIST: a notice the registry holds (a failing block rule) is never printed — checked against the notice, not the caller's flag.
      const n = rt.notices ? (() => { try { return rt.notices!.get(noticeId); } catch { return null; } })() : null;
      if (n && (n.status === "held" || !n.checklist.passed)) refuse(ctx, loanId, "print.request", "SM_EI_NOTICE_CONTENT_CHECKLIST", "11.2 timer table: send refused while any checklist item is false", `notice ${noticeId} is held: ${n.heldReason ?? n.checklist.blocking.map((r) => r.rule_id).join(", ")}`, noticeId);
      const template = str(i, "template") || n?.templateCode || "";
      const solicitation = SOLICITATION_TEMPLATES[template] ?? (str(i, "solicitation_kind") as "bsp" | "form745_letter" | "");
      if (solicitation) ctx.events.append({ type: "solicitation_package.send_requested", loanId, actor: ctx.actor, payload: { notice_id: noticeId, kind: solicitation, regx_days_delinquent: num(i, "regx_days_delinquent"), imminent_default_requested: flag(i, "imminent_default_requested") } });
      // The send: through the Notice Registry when it rendered the notice (NoticeService emits `notice.sent{template}` — the event every §11 notice timer keys on); otherwise the print port directly, with the same event.
      let r: unknown;
      if (n && rt.notices) r = await rt.notices.send(noticeId, ((i.channel_context as Parameters<NonNullable<ToolRuntime["notices"]>["send"]>[1] | undefined) ?? {}));
      else { r = await port(rt, "printMail").submit({ jobId: str(i, "job_id") || `job-${noticeId}`, noticeId, pdf: str(i, "pdf") || "", template: template || "", recipient: { name: str(i, "recipient_name") || str(i, "recipient") || "", address: str(i, "recipient_address") || str(i, "recipient") || "" }, pages: 1, separateDocument: true } as unknown as Parameters<ReturnType<typeof port<"printMail">>["submit"]>[0], ctx.now);
        ctx.events.append({ type: "notice.sent", loanId, actor: ctx.actor, payload: { notice_id: noticeId, template: template || null, channels: [{ party_id: str(i, "party_id") || null, channel: "mail", satisfies_timer: true }], sent_at: ctx.now } }); }
      ctx.events.append({ type: "notice.print.requested", loanId, actor: ctx.actor, payload: { notice_id: noticeId, template: template || null } });
      const sentOn = ctx.now.slice(0, 10);
      if (solicitation) { ctx.events.append({ type: "solicitation_package.sent", loanId, actor: ctx.actor, payload: { notice_id: noticeId, kind: solicitation, trigger: str(i, "trigger") || null, sent_at: ctx.now, hope_hotline_present: true, fnma_action: "Borrower Solicitation Package" } });
        rt.store.put("solicitation_packages", str(i, "package_id") || `sp-${noticeId}`, { loan_id: loanId ?? null, notice_id: noticeId, kind: solicitation, trigger: str(i, "trigger") || null, sent_at: ctx.now, hope_hotline_present: true, includes_4506c: flag(i, "includes_4506c") }, ctx.actor, ctx.now); }
      if (EVALUATION_TEMPLATES.includes(template)) ctx.events.append({ type: "lossmit.evaluation_notice.sent", loanId, actor: ctx.actor, payload: { notice_id: noticeId, template, sent_on: sentOn } });
      const variant = EI_TEMPLATES[template];
      if (variant) { const c = noticeCycle(D(sentOn), variant, str(i, "cycle_id") || `cycle-${noticeId}`); rt.store.put("ei_notice_cycles", c.id, { loan_id: loanId ?? null, notice_id: noticeId, template, variant, provided_at: sentOn, cycle_end_at: c.cycle_end_at, bk_case_id: str(i, "bk_case_id") || null, status: "active" }, ctx.actor, ctx.now); }
      // §1006.38: the verification (or duplicative-dispute) notice lifts the collection cease on the loan's open written disputes.
      if (VERIFICATION_TEMPLATES.includes(template)) for (const d of rt.store.list("fdcpa_disputes", (x) => x.loan_id === loanId && x.status === "open")) rt.store.put("fdcpa_disputes", d.id, { ...d.data, status: template === "NTC_REGF_1006_38_VERIFICATION" ? "verification_sent" : "duplicative_notified", collection_resumed_at: sentOn, verification_notice_id: noticeId }, ctx.actor, ctx.now);
      return r; }),
    guardrails: [never("CHECKLIST_BEFORE_PRINT", "11.2 timer table: SM_EI_NOTICE_CONTENT_CHECKLIST — send refused while any item is false", (i) => flag(i, "checklist_failed"), "the checklist blocks the send"),
      guard("FNMA_D2101_NO_SOLICIT_LT30", "11.5 guardrail: no outbound solicitation below 30 days delinquent (D2-1-01)", (i) => { const kind = SOLICITATION_TEMPLATES[str(i, "template")] ?? str(i, "solicitation_kind"); if (!kind) return undefined; const g = evaluateGate("11.2.delinquentAtLeast30OrImminentDefault", { regx_days_delinquent: num(i, "regx_days_delinquent"), imminent_default_requested: flag(i, "imminent_default_requested") || flag(i, "borrower_requested") }); return g.open ? undefined : g.reason; })] },
  { name: "edeliver.send", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "notice_id", "address"); const ch = eiChannel({ esign_consent_regx_ei: flag(i, "esign_consent_regx_ei") }); if (ch.channel === "mail") return { sent: false, fallback: "mail", reason: "no esign consent for class regx_ei" };
      // 11.4 `gates.evaluate` on a DC loan (ops-11-4.ts): the §1006.18(e) fragment, §1006.38(b) overshadowing inside the validation period, the §1006.6(e) opt-out and the debt-free subject, the SMS RND check, the B-1 E-SIGN class — appends `communication.outbound.requested` and refuses on the first failing gate.
      if (flag(i, "fdcpa_debt_collector")) { const loanId = (i.loan_id as string | undefined) ?? ctx.loanId ?? ""; const st = rt.store.get("fdcpa_status", loanId)?.data; const end = optDate(i, "validation_period_end_on") ?? (typeof st?.validation_period_end_on === "string" ? D(st.validation_period_end_on) : null);
        const channel = (str(i, "channel") === "sms" ? "sms" : "email") as OutboundChannel; const dialOn = D(ctx.now.slice(0, 10));
        const g = evaluateOutboundCommunication(ctx, { loan_id: loanId, channel, fdcpa_debt_collector: true, text: str(i, "body"), subject: str(i, "subject") || "Important information about your mortgage", initial_communication: flag(i, "initial_communication"), template: str(i, "template") || null, ref_date: dialOn, validation_period_end_on: end, opt_out_fee: flag(i, "opt_out_fee"), esign_consent_regf_validation: flag(i, "esign_consent_regf_validation"),
          ...(channel === "sms" ? { dial: { mode: "sms" as const, on: dialOn, now: ctx.now, person: str(i, "party_id") || null, number_id: str(i, "phone_number_id") || null, days_since_rnd_check: typeof i.days_since_rnd_check === "number" ? i.days_since_rnd_check : null, days_since_consumer_texted_from_number: typeof i.days_since_consumer_texted_from_number === "number" ? i.days_since_consumer_texted_from_number : null, workplace_flag: flag(i, "workplace_flag"), employer_prohibits: flag(i, "employer_prohibits") } } : {}) });
        if (!g.allowed) { const f = g.gates.find((x) => x.code === g.refused_by[0])!; refuse(ctx, loanId, "edeliver.send", f.code, "11.4 timer table: send refused (Reg F §1006.6(d)–(e), §1006.18(e), §1006.38(b))", f.reason ?? f.code, str(i, "notice_id")); }
        if (g.fallback === "mail") return { sent: false, fallback: "mail", reason: "REGF_1006_42_ESIGN_GATE: no E-SIGN consent for class regf_validation — mail instead (§1006.42)", gates: g.gates }; }
      const r = await port(rt, "edelivery").send({ messageId: str(i, "message_id") || `msg-${str(i, "notice_id")}`, noticeId: str(i, "notice_id"), address: str(i, "address"), subject: str(i, "subject") || "Important information about your mortgage", body: str(i, "body") || "" } as unknown as Parameters<ReturnType<typeof port<"edelivery">>["send"]>[0], ctx.now);
      ctx.events.append({ type: "notice.edelivery.sent", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { notice_id: str(i, "notice_id") } }); return r; }),
    guardrails: [never("ESIGN_CONSENT_REQUIRED", "11.2 guardrail: never send electronically without consent (§1024.32(a)(1); E-SIGN)", (i) => !flag(i, "esign_consent_regx_ei"), "electronic delivery needs an unrevoked esign consent for class regx_ei"),
      never("OPT_OUT_LINE_REQUIRED", "11.4 guardrail: never sends an email/SMS without the opt-out line (Reg F §1006.6(e)); subject lines never reference the debt (11.4 rule 12)", (i) => flag(i, "fdcpa_debt_collector") && !dcEmailCheck({ subject: str(i, "subject") || "Important information about your mortgage", body: str(i, "body") }).compliant, "DC-loan email/SMS needs a clear no-fee opt-out statement and a debt-free subject line")] },
  { name: "fnma.action.emit", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "action"); const a = str(i, "action"); if (!["Borrower Solicitation Package", "Outbound Contact Attempted", "Quality Right Party Contact"].includes(a)) throw new RangeError(`servicer action ${a} is not a §5.7 action type`);
      return ctx.events.append({ type: "delinquency.servicer_action", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { action: a, effective_on: str(i, "effective_on") || null, reason_type: str(i, "reason_type") || null, reason_code: str(i, "reason_code") || null } }); }) },
  { name: "decision.record", kind: "write", handler: decision() },
  { name: "escalate", kind: "act", handler: escalate("officer") },
]);

// ---- 11.3 QRPC ----------------------------------------------------------------
/**
 * `SM_THIRD_PARTY_AUTH_GATE` at verification (ops-11-3.ts): a caller who is not the borrower/co-borrower/successor
 * (`party_role` ∈ {trusted_advisor, authorized_third_party}, or any `claimed_relation`) starts a third-party conversation —
 * `contact.started` carries the authorization facts the gate is evaluated on; closed → NPI withheld, general information and
 * the authorization form only, no QRPC (11.3-T5). `authorization` {id, scope, expires_on} is the record on file; the legacy
 * `authorization_valid` flag stands for an unexpired one; `in_call_consent_recorded` is the verified borrower's recorded consent.
 */
const thirdPartyOnCall = (i: ToolInput, ctx: CommandContext) => {
  const role = str(i, "party_role"); const relation = str(i, "claimed_relation");
  if (!THIRD_PARTY_ROLES.has(role) && !relation) return null;
  const auth = (i.authorization as { id: string; scope?: string | null; expires_on?: string | null } | undefined) ?? null;
  return thirdPartyConversation(ctx, { loan_id: str(i, "loan_id") || ctx.loanId, contact_id: str(i, "contact_id") || null, party_role: role === "authorized_third_party" ? "authorized_third_party" : "trusted_advisor", claimed_relation: relation || null,
    authorization: auth ? { id: auth.id, scope: auth.scope ?? null, expires_on: auth.expires_on ? D(auth.expires_on) : null } : flag(i, "authorization_valid") ? { id: str(i, "authorization_id") || "on-file", scope: "discuss_only", expires_on: null } : null,
    in_call_consent_recorded: flag(i, "in_call_consent_recorded"), on: optDate(i, "on") ?? D(ctx.now.slice(0, 10)) });
};
const p113 = defineTools("11.3", "borrower-comms", [
  { name: "identity.verify", kind: "read", handler: compute((i, ctx) => { const provided = (i.factors as Record<string, unknown> | undefined) ?? {}; const expected = (i.expected as Record<string, unknown> | undefined) ?? {}; const matched = Object.keys(expected).filter((k) => provided[k] !== undefined && String(provided[k]).toLowerCase() === String(expected[k]).toLowerCase());
      const ok = matched.length >= 2 && !("voiceprint" in provided); const tp = thirdPartyOnCall(i, ctx); return { verified: ok, factors_matched: matched, account_details_allowed: ok && (tp === null || tp.disclose_account_details), third_party: tp ?? thirdPartyCall({ claimed_relation: str(i, "claimed_relation"), authorization_valid: flag(i, "authorization_valid") }) }; }),
    guardrails: [never("NO_VOICEPRINT", "11.1 design item 3: no voiceprints (Illinois BIPA)", (i) => (i.factors as Record<string, unknown> | undefined)?.voiceprint !== undefined, "voice biometrics are not an identity factor")] },
  { name: "disclosure.play", kind: "act", handler: compute((i, ctx) => { const dc = flag(i, "fdcpa_debt_collector"); const initial = flag(i, "initial_communication"); const verified = i.identity_verified !== false;
      // 11.3 design item 1: the §1006.18(e) statement only after verification; before, limited-content wording only.
      const script = [`I'm an automated assistant for Supermortgage; say "representative" at any time to reach a person.`, "This call is recorded.", ...(dc && verified ? [initial ? "Supermortgage is a debt collector. We are attempting to collect a debt and any information obtained will be used for that purpose." : "This communication is from a debt collector."] : []), ...(str(i, "state_script") ? [str(i, "state_script")] : [])];
      ctx.events.append({ type: "contact.disclosure.played", loanId: ctx.loanId, actor: ctx.actor, payload: { ai_at: ctx.now, recording_at: ctx.now, fdcpa_at: dc && verified ? ctx.now : null } }); return { script, ai_disclosure_at: ctx.now, recording_disclosure_at: ctx.now, fdcpa_disclosure_at: dc && verified ? ctx.now : null, limited_content_only: dc && !verified }; }),
    guardrails: [never("NO_DEBT_MENTION_TO_UNVERIFIED", "11.4 guardrail: never mentions the debt to an unverified party (Reg F §1006.6(d)(1))", (i) => flag(i, "fdcpa_debt_collector") && i.identity_verified === false && flag(i, "include_debt_disclosure"), "verify identity before any debt reference; use limited-content wording")] },
  { name: "ledger.balances", kind: "read", handler: compute((i) => {
      // 11.1 rule 13: amounts are read from the FIFO projection and the fee engine at call time, never computed by the model.
      if (i.ledger) { const facts = i.ledger as LedgerFacts; need(i, "as_of"); const s = delinquencySnapshot(facts, date(i, "as_of")); return { as_of: s.as_of, total_delinquent_cents: s.total_delinquent_cents, past_due_cents: s.past_due_cents, late_charge_cents: s.late_charge_cents, unapplied_cents: s.unapplied_cents, regx_days_delinquent: s.regx_days_delinquent, stated: s.stated, source: "ledger" }; }
      need(i, "past_due_installments"); const inst = i.past_due_installments as { due_date: string; amount_cents: unknown }[]; const lc = Array.isArray(i.late_charges) ? (i.late_charges as { amount_cents: unknown }[]) : []; const fees = cents(i.fees_cents);
      const total = inst.reduce((a, x) => a + cents(x.amount_cents), 0n) + lc.reduce((a, x) => a + cents(x.amount_cents), 0n) + fees; return { as_of: str(i, "as_of"), total_delinquent_cents: total, stated: `${formatCents(total, { symbol: true, grouping: true })} as of ${str(i, "as_of")}`, source: "ledger" }; }),
    guardrails: [never("BALANCES_FROM_LEDGER_ONLY", "11.1 guardrail: no balance not read from the ledger", (i) => typeof i.model_stated_total === "string" || typeof i.model_stated_total === "number", "the AI never computes balances itself")] },
  { name: "payments.history", kind: "read", handler: read("payments") },
  { name: "lossmit_facts.get", kind: "read", handler: compute((i, ctx, rt) => { const facts = read("lossmit_facts")(i, ctx, rt); const q = str(i, "borrower_question"); if (!q) return facts;
      // 11.3 design item 5 / `SM_LICENSED_NEGOTIATION_GATE` (ops-11-3.ts): a question about modification terms in a state where offering/negotiating terms is licensed activity stops at intake — terms withheld, warm transfer to `licensed_specialist` (11.3-T10).
      const g = modificationTermsDiscussed(ctx, { loan_id: str(i, "loan_id") || ctx.loanId, contact_id: str(i, "contact_id") || null, question: q, mlo_licensing_for_lossmit: flag(i, "mlo_licensing_for_lossmit"), licensed_specialist_on_call: flag(i, "licensed_specialist_on_call"), state: str(i, "state") || null });
      return { facts: g.decline_quote ? null : facts, terms_withheld: g.decline_quote, gate: g.gate, open: g.open, asks_terms: g.asks_terms, decline_quote: g.decline_quote, warm_transfer: g.warm_transfer, response: g.response, terms_quoted: g.terms_quoted }; }) },
  { name: "qrpc.capture", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "contact_id"); const loanId = str(i, "loan_id"); const contactId = str(i, "contact_id");
      if (i.op === "human_verify") {
        // 11.3 rule 6 / T7: a human_agent reviews the transcript and schema; only `qrpc_verified` emits `contact.qrpc.established`.
        need(i, "id", "outcome", "reviewer_id"); const outcome = str(i, "outcome") as "qrpc_verified" | "qrpc_rejected"; const prev = rt.store.require("qrpc_records", str(i, "id"));
        const rec = rt.store.put("qrpc_records", str(i, "id"), { ...prev.data, status: outcome, human_verified_by: str(i, "reviewer_id"), human_verified_at: ctx.now, ...(outcome === "qrpc_rejected" ? { rejected_elements: i.rejected_elements ?? [] } : {}) }, ctx.actor, ctx.now);
        ctx.events.append({ type: "contact.qrpc.reviewed", loanId, actor: ctx.actor, payload: { qrpc_id: rec.id, contact_id: contactId, outcome, reviewer_id: str(i, "reviewer_id") } });
        if (outcome === "qrpc_verified") { rt.store.put("contacts", contactId, { qrpc: true }, ctx.actor, ctx.now); const priorBsp = rt.store.list("solicitation_packages", (d) => d.loan_id === loanId && d.kind === "bsp")[0];
          ctx.events.append({ type: "contact.qrpc.established", loanId, actor: ctx.actor, payload: { qrpc_id: rec.id, contact_id: contactId, reason_code: prev.data.fnma_reason_code ?? null, commitment_kind: prev.data.commitment_kind ?? null, resolution_status: prev.data.resolution_status ?? "none", prior_bsp_id: priorBsp?.id ?? null, achieved_at: prev.data.achieved_at ?? ctx.now, verified_by: str(i, "reviewer_id") } });
          // rule 7: the verified record is reported to 5.7 like a flag-on QRPC — AW + reason code, event-rail action with its reason type (FNMA_LL202605_QRPC_REASON_REQUIRED at build).
          buildQrpcInvestorEvent(ctx, { loan_id: loanId, qrpc_id: rec.id, contact_id: contactId, reason_primary: (prev.data.reason_primary as string | null) ?? null, reason_type: (prev.data.fnma_reason_type as string | null) ?? null, reason_code: (prev.data.fnma_reason_code as string | null) ?? null, achieved_on: String(prev.data.achieved_at ?? ctx.now).slice(0, 10) }); }
        else rt.escalations.open({ kind: "human_agent", loanId, payload: { task: "human_call", qrpc_id: rec.id, rejected_elements: i.rejected_elements ?? [] } }, ctx.actor);
        return { id: rec.id, status: outcome, task: outcome === "qrpc_rejected" ? "human_call" : null };
      }
      const given = (i.conversation as Conversation | undefined) ?? { verified_party: "unverified" as const };
      const narrative = str(i, "narrative"); const spokenOn = optDate(i, "spoken_on") ?? D(ctx.now.slice(0, 10));
      const hardship = narrative && !given.reason_primary ? extractHardship(narrative, spokenOn, { ...(str(i, "narrative_evidence_span") ? { evidence_span: str(i, "narrative_evidence_span") } : {}) }) : null;
      const conv: Conversation = hardship ? { ...given, reason_primary: hardship.reason_primary, hardship_nature: hardship.hardship_nature } : given;
      const elements = (i.elements as Record<string, { value: unknown; evidence_span: string | null }> | undefined) ?? {};
      const ev = validateExtraction(elements); const c = qrpcCompleteness(conv);
      const verificationRequired = !flag(i, "ai_voice_counts") || flag(i, "sampled");
      const status = !ev.valid || !c.complete ? "conversation_only" : verificationRequired ? "pending_human_verification" : "qrpc_complete";
      const commitment = (conv.commitment_kind ?? null) as CommitmentKind | null;
      const cessation = commitment ? cessationOnQrpc(commitment, { ...(i.promise_valid !== undefined ? { promise_valid: flag(i, "promise_valid") } : {}) }) : null;
      const resolution = cessation?.plan_status === "ptp_pending" ? "ptp_pending" : cessation?.plan_status === "qrpc_workout" ? "workout_in_progress" : "none";
      const rec = rt.store.put("qrpc_records", str(i, "id") || `qrpc-${contactId}`, { loan_id: loanId, contact_id: contactId, status, missing: c.missing, missing_evidence: ev.missing_evidence, reason_primary: conv.reason_primary ?? null, fnma_reason_code: conv.reason_primary ? reasonCode(conv.reason_primary) : null, fnma_reason_type: qrpcReasonType(conv.reason_primary ?? null, { explicit: str(i, "reason_type") || null, fema_ia_county: flag(i, "fema_ia_county") }), hardship_nature: conv.hardship_nature ?? null, hardship_started_on: hardship?.hardship_started_on ?? (i.hardship_started_on as string | undefined) ?? null, reason_narrative: hardship?.reason_narrative ?? narrative ?? null, commitment_kind: commitment, resolution_status: resolution, achieved_at: status === "conversation_only" ? null : ctx.now, conducted_by: str(i, "conducted_by") || "ai_agent", live_contact_counted: flag(i, "ai_voice_counts") }, ctx.actor, ctx.now);
      ctx.events.append({ type: "contact.qrpc.captured", loanId, actor: ctx.actor, payload: { qrpc_id: rec.id, contact_id: contactId, status, human_verification_required: status === "pending_human_verification", ai_voice_counts: flag(i, "ai_voice_counts"), sampled: flag(i, "sampled"), achieved_at: ctx.now, missing: c.missing } });
      let fnma: ReturnType<typeof buildQrpcInvestorEvent> | null = null;
      if (status === "qrpc_complete") {
        rt.store.put("contacts", contactId, { qrpc: true }, ctx.actor, ctx.now);
        // D2-2-04: "if a Borrower Solicitation Package has not previously been sent" — the store's `solicitation_packages` decide `prior_bsp_id` (FNMA_D2204_BSP_AFTER_QRPC_3BD arms only when null).
        const priorBsp = rt.store.list("solicitation_packages", (d) => d.loan_id === loanId && d.kind === "bsp")[0];
        ctx.events.append({ type: "contact.qrpc.established", loanId, actor: ctx.actor, payload: { qrpc_id: rec.id, contact_id: contactId, reason_code: rec.data.fnma_reason_code, commitment_kind: commitment, resolution_status: resolution, plan_status: cessation?.plan_status ?? "active", prior_bsp_id: priorBsp?.id ?? null, achieved_at: ctx.now } });
        // rule 7 / FNMA_LL202605_QRPC_REASON_REQUIRED (ops-11-3.ts): the 5.7 QRPC action event is built with its reason type — `investor_events.building{family=qrpc}` then `delinquency.servicer_action{Quality Right Party Contact}`, or refused at build (11.3-T11: disaster exclusivity on the event rail).
        fnma = buildQrpcInvestorEvent(ctx, { loan_id: loanId, qrpc_id: rec.id, contact_id: contactId, reason_primary: conv.reason_primary ?? null, reason_type: str(i, "reason_type") || null, reason_code: (rec.data.fnma_reason_code as string | null) ?? null, fema_ia_county: flag(i, "fema_ia_county"), achieved_on: ctx.now.slice(0, 10) });
        // FNMA_D2202_CESSATION_ON_QRPC: a cadence-ceasing commitment ceases the plan and cancels the D2-2-02 clocks at the command boundary.
        if (cessation && cessation.plan_status !== "active") { const reason = cessation.plan_status; ctx.events.append({ type: "contact.plan.ceased", loanId, actor: ctx.actor, payload: { loan_id: loanId, reason, on: ctx.now.slice(0, 10), qrpc_id: rec.id, cancel_timers: [...FNMA_CADENCE_TIMERS] } }); cancelEarlyInterventionTimers(ctx.timers, loanId, FNMA_CADENCE_TIMERS, `contact.plan.ceased{${reason}}`, ctx.actor); }
      }
      return { id: rec.id, status, missing: c.missing, next_attempt_targets: c.missing.filter((m) => m !== "verified_party" && m !== "payment_importance"), missing_evidence: ev.missing_evidence, hardship, plan_status: status === "qrpc_complete" ? cessation?.plan_status ?? "active" : null, contacts_qrpc: status === "qrpc_complete", fnma_reason_type: fnma?.reason_type ?? (rec.data.fnma_reason_type as string | null) ?? null, fnma_reported: fnma?.built ?? false, fnma_refused_by: fnma?.refused_by ?? null }; }),
    guardrails: [never("EVIDENCE_SPANS_REQUIRED", "11.3 guardrail: the extractor must cite transcript evidence for every element", (i) => { const e = (i.elements as Record<string, { value: unknown; evidence_span: string | null }> | undefined) ?? {}; return flag(i, "mark_qrpc") && !validateExtraction(e).valid; }, "hallucinated elements downgrade the call to conversation_only"),
      never("NO_QRPC_FROM_ONE_WAY", "11.3 guardrail: QRPC is never marked from a voicemail, SMS-only exchange or chatbot session without a verified two-way dialog", (i) => i.op !== "human_verify" && ["voicemail", "sms"].includes(str(i, "channel")), "QRPC needs a verified two-way dialog"),
      never("NO_UNVERIFIED_THIRD_PARTY", "11.3 guardrail: no discussion with unverified/unauthorized third parties", (i) => i.op !== "human_verify" && (i.conversation as Conversation | undefined)?.verified_party === "unverified", "verify the party or obtain an authorization first"),
      never("NO_FINANCIAL_DETAIL_DEMANDS", "11.3 guardrail: no financial-detail demands (figures are volunteered; the BRP is the documented path — 11.3-Q5)", (i) => statements(i).some((s) => FINANCIAL_DEMAND_WORDS.test(s)), "the AI never requires income, asset or expense figures for QRPC"),
      humanWhen("HUMAN_VERIFICATION_IS_HUMAN", "11.3 rule 6: a human_agent verifies or rejects an AI QRPC record", (i) => i.op === "human_verify", "qrpc_verified / qrpc_rejected is a human act")] },
  { name: "promise.record", kind: "write", moneyFields: ["amount_cents"], handler: compute((i, ctx, rt) => { need(i, "loan_id", "amount_cents", "due_on", "recorded_on", "total_delinquent_cents"); const p = promiseToPay(cents(i.amount_cents), date(i, "due_on"), date(i, "recorded_on"), cents(i.total_delinquent_cents));
      const rec = rt.store.put("promises", str(i, "id") || `ptp-${str(i, "loan_id")}-${str(i, "due_on")}`, { loan_id: str(i, "loan_id"), amount_cents: cents(i.amount_cents), due_on: str(i, "due_on"), covers: p.covers, status: "open" }, ctx.actor, ctx.now);
      // `due_on` is the promise date FNMA_D2202_PTP_FOLLOWUP_30 anchors on (offset 0; checked 00:05 the next day — 11.1-T17).
      ctx.events.append({ type: "borrower.promise_to_pay.recorded", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { promise_id: rec.id, plan: p.plan, recorded_on: str(i, "recorded_on"), due_on: str(i, "due_on"), amount_cents: cents(i.amount_cents), covers: p.covers } }); return { id: rec.id, ...p }; }) },
  { name: "payment.schedule", kind: "act", moneyFields: ["amount_cents"], handler: compute((i, ctx) => { need(i, "loan_id", "amount_cents", "debit_on", "reg_e_authorization_id"); return ctx.events.append({ type: "payment.ach.scheduled", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { amount_cents: cents(i.amount_cents), debit_on: str(i, "debit_on"), authorization_id: str(i, "reg_e_authorization_id") } }); }),
    guardrails: [never("REG_E_AUTHORIZATION", "11.3 rule 3: in-call ACH needs a Reg E authorization", (i) => !i.reg_e_authorization_id, "record the Reg E authorization first"),
      never("NO_PAY_TO_PAY_FEE", "11.4 guardrail: never adds a fee — no convenience/pay-to-pay fees; only fees expressly authorized by the agreement or permitted by law (Reg F §1006.22; 11.4 rule 10)", (i) => cents(i.convenience_fee_cents) > 0n || (cents(i.fee_cents) > 0n && !flag(i, "fdcpa_authorized")), "no fee may be added to an in-call payment")] },
  { name: "lossmit.request.create", kind: "write", handler: write("cases", "lossmit.assistance.requested"),
    guardrails: [never("CREDIT_PULL_PERMISSIBLE_PURPOSE", "11.5 guardrail: no credit pull without a recorded permissible purpose (FCRA)", (i) => flag(i, "credit_pull") && !str(i, "permissible_purpose"), "record the FCRA permissible purpose (account review) before any pull"),
      never("NO_TERMS_BEFORE_SMDU", "11.5 guardrail: no terms quoted to the borrower before SMDU's decision", (i) => flag(i, "terms_quoted") && !str(i, "smdu_decision_id"), "eligibility is computed by code and terms come from SMDU's decision"),
      never("NO_SOLICITATION_LT30", "11.5 guardrail: no outbound solicitation below 30 days delinquent (D2-1-01)", (i) => str(i, "source") === "outbound_solicitation" && num(i, "regx_days_delinquent") < 30 && !flag(i, "borrower_requested"), "the evaluation is borrower-initiated below 30 days delinquent")] },
  { name: "lossmit.streamlined.evaluate", kind: "read", handler: compute((i) => { const kind = str(i, "kind"); const months = num(i, "term_months"); if (kind === "forbearance") return { delegated: months <= 3, limit: "≤3-month increments (LL-2026-01)", in_call_offer_allowed: months <= 3 && !flag(i, "mlo_licensing_for_lossmit") }; if (kind === "repayment_plan") return { delegated: months <= 12, limit: "≤12 months (D2-3.2-02)", in_call_offer_allowed: months <= 12 && !flag(i, "mlo_licensing_for_lossmit") }; throw new RangeError(`kind ${kind} is not forbearance/repayment_plan`); }),
    guardrails: [never("NO_ADVERSE_IN_CALL", "11.3 design item 5: adverse outcomes are never announced in-call", (i) => flag(i, "announce_denial"), "adverse outcomes go through lossmit_reviewer (12.x)")] },
  { name: "authorization.record", kind: "write", handler: compute((i, ctx, rt) => { need(i, "party_id", "kind", "on"); const a = thirdPartyAuthorization(str(i, "kind") as "written" | "oral_three_way", date(i, "on")); const rec = rt.store.put("party_authorizations", str(i, "id") || `auth-${str(i, "party_id")}`, { party_id: str(i, "party_id"), ...a, recorded_document_id: (i.recorded_document_id as string | undefined) ?? null }, ctx.actor, ctx.now);
      // rule 4 / 11.3-T6: the verified borrower's recorded oral consent on a three-way call opens the third-party conversation with the advisor — `SM_THIRD_PARTY_AUTH_GATE` (ops-11-3.ts) arms on `contact.started{party_role=trusted_advisor, in_call_consent_recorded=true}` and is open, so the advisor may complete QRPC.
      const conv = str(i, "kind") === "oral_three_way" ? thirdPartyConversation(ctx, { loan_id: str(i, "loan_id") || ctx.loanId, contact_id: str(i, "contact_id") || null, party_role: "trusted_advisor", claimed_relation: str(i, "party") || null, authorization: { id: rec.id, scope: a.scope, expires_on: a.expires_on }, in_call_consent_recorded: true, on: date(i, "on") }) : null;
      return { ...rec.data, id: rec.id, conversation: conv ? { gate: conv.gate, open: conv.open, party_role: "trusted_advisor", in_call_consent_recorded: conv.in_call_consent_recorded, disclose_account_details: conv.disclose_account_details, may_complete_qrpc: conv.qrpc_recorded_allowed, outcome: conv.outcome } : null }; }),
    guardrails: [never("ORAL_NEEDS_VERIFIED_BORROWER", "11.3 rule 4: an oral three-way authorization requires the verified borrower on the call", (i) => str(i, "kind") === "oral_three_way" && !flag(i, "borrower_verified"), "verify the borrower first")] },
  { name: "preference.set", kind: "write", handler: compute((i, ctx, rt) => { need(i, "party_id"); const loanId = (i.loan_id as string | undefined) ?? ctx.loanId;
      const revoke = Array.isArray(i.revoke_channels) ? (i.revoke_channels as string[]) : [];
      const humanOnly = flag(i, "human_only") || flag(i, "borrower_requested_human");
      const rec = rt.store.put("contact_preferences", str(i, "id") || `pref-${str(i, "party_id")}`, { party_id: str(i, "party_id"), ...(i.preferred_channel !== undefined ? { preferred_channel: i.preferred_channel } : {}), ...(i.preferred_windows !== undefined ? { preferred_windows: i.preferred_windows } : {}), ...(i.language !== undefined ? { language: i.language } : {}), human_only: humanOnly, do_not_call_reason: str(i, "do_not_call_reason") || (revoke.length ? "borrower revocation" : null), set_by: str(i, "set_by") || (ctx.actor.kind === "agent" ? "agent" : "borrower"), set_at: ctx.now }, ctx.actor, ctx.now);
      ctx.events.append({ type: "contact.preference.set", loanId, actor: ctx.actor, payload: { party_id: str(i, "party_id"), human_only: humanOnly, revoked_channels: revoke } });
      if (revoke.length) {
        // TCPA revocation "using any reasonable method" is honored at commit (47 CFR 64.1200(a)(10)); the legal 10-BD clock is satisfied immediately.
        ctx.events.append({ type: "consent.revoked", loanId, actor: ctx.actor, payload: { party_id: str(i, "party_id"), channels: revoke, method: str(i, "revocation_method") || "oral", receipt: ctx.now } });
        ctx.events.append({ type: "consent.revocation.honored", loanId, actor: ctx.actor, payload: { party_id: str(i, "party_id"), channels: revoke, honored_at: ctx.now, latency_ms: 0, timer: "TCPA_64_1200_A10_REVOCATION_HONOR_10BD" } });
      }
      if (flag(i, "borrower_requested_human")) ctx.events.append({ type: "contact.human_only.marked", loanId, actor: ctx.actor, payload: { party_id: str(i, "party_id"), terminated_ai_session: true } });
      return { ...rec.data, revoked_channels: revoke }; }),
    guardrails: [never("HUMAN_ONLY_ON_REQUEST", "11.1 guardrail: terminate and mark human_only on borrower request", (i) => flag(i, "borrower_requested_human") && i.human_only === false, "a borrower's request for a person always sets human_only")] },
  { name: "dispute.intake", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "received_on"); const loanId = str(i, "loan_id"); const rec = rt.store.put("cases", str(i, "id") || `noe-${loanId}-${str(i, "received_on")}`, { loan_id: loanId, case_type: "noe", received_on: str(i, "received_on"), source: "qrpc_dispute", status: "open", written: flag(i, "written") }, ctx.actor, ctx.now); ctx.events.append({ type: "case.noe.opened", loanId, actor: ctx.actor, payload: { case_id: rec.id } });
      // 11.4 rule 5: on a DC loan a written dispute inside the validation period is also a Reg F dispute — collection ceases until verification (recorded in `fdcpa_disputes`; contact.log refuses outbound collection calls while it is open).
      if (flag(i, "fdcpa_debt_collector")) { const st = rt.store.get("fdcpa_status", loanId)?.data; const end = optDate(i, "validation_period_end_on") ?? (typeof st?.validation_period_end_on === "string" ? D(st.validation_period_end_on) : null); const within = end !== null && date(i, "received_on") <= end; const written = flag(i, "written"); const kind = str(i, "kind") === "original_creditor_request" ? "original_creditor_request" : "dispute";
        ctx.events.append({ type: kind === "original_creditor_request" ? "fdcpa.original_creditor.requested" : "fdcpa.dispute.received", loanId, actor: ctx.actor, payload: { case_id: rec.id, on: str(i, "received_on"), written, within_validation_period: within, collection_ceased: written && within } });
        if (written && within) { rt.store.put("fdcpa_disputes", str(i, "dispute_id") || `dispute-${rec.id}`, { loan_id: loanId, case_id: rec.id, kind, received_on: str(i, "received_on"), written, within_validation_period: true, status: "open", collection_ceased_at: str(i, "received_on"), collection_resumed_at: null }, ctx.actor, ctx.now);
          rt.store.put("fdcpa_status", loanId, { ...(st ?? { loan_id: loanId }), dispute_open: true, collection_ceased_at: str(i, "received_on") }, ctx.actor, ctx.now); }
        return { ...rec.data, regf: { written, within_validation_period: within, collection_ceased: written && within } }; }
      return rec.data; }) },
  { name: "human.transfer", kind: "act", handler: compute((i, ctx) => { need(i, "reason"); const target = str(i, "target") || "human_agent"; return ctx.events.append({ type: "contact.human_transfer.started", loanId: ctx.loanId, actor: ctx.actor, payload: { reason: str(i, "reason"), target, start_within_s: 10 } }); }) },
  { name: "contact.log", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "mode", "direction", "outcome"); const loanId = str(i, "loan_id"); const direction = str(i, "direction"); const outcome = str(i, "outcome"); const on = str(i, "on") || ctx.now.slice(0, 10);
      // 11.1 live contact (ops-11-1.ts liveContactOf): comment 39(a)-2 / design item 2 — the flag is honored only on a spoken two-way outcome (answered_verified / conversation / qrpc); a one-way script, voicemail, no-answer or the AI leg of a `human_transferred` call is never live contact (11.1-T19: the human leg decides).
      const lc = liveContactOf({ direction, mode: str(i, "mode"), outcome, live_contact: flag(i, "live_contact"), basis: str(i, "live_contact_basis") || null, party_id: str(i, "party_id") || null }); const live = lc.live;
      if (direction === "outbound" && !flag(i, "borrower_initiated_response")) {
        // §1006.38(c)-(d): an open written dispute in the validation period ceases collection (11.4-T5); §1006.6(c): a written cease is permanent unless withdrawn (11.4-T7) — both read from the store, never from the caller.
        const open = rt.store.list("fdcpa_disputes", (d) => d.loan_id === loanId && d.status === "open" && d.collection_ceased_at !== null && d.collection_ceased_at !== undefined)[0];
        if (open) refuse(ctx, loanId, "contact.log", "REGF_1006_38_DISPUTE_CEASE_GATE", "Reg F §1006.38(c)-(d): collection ceases on a timely written dispute until verification is sent", `collection ceased since ${String(open.data.collection_ceased_at)} on written dispute ${open.id}; statements and legally required notices continue`, open.id);
        const st = rt.store.get("fdcpa_status", loanId)?.data; if (st && st.cease_scope === "written_full" && !st.cease_withdrawn_at) refuse(ctx, loanId, "contact.log", "REGF_1006_6C_CEASE_GATE", "Reg F §1006.6(c): no further communication after a written cease (permitted notices only)", `written cease received ${String(st.cease_received_at ?? "")}`);
      }
      const pd = preDialChecks(i);
      // 11.1 dial request (ops-11-1.ts): every outbound attempt records `contact.attempt.requested` — the trigger of the 11.1 gate timers (quiet hours, TCPA consent / landline 3-in-30, Reg F 7-in-7) — with the facts the gates were computed from.
      if (direction === "outbound") { const req = attemptRequestedForTool(loanId, str(i, "mode"), i.pre_dial_facts, { now: ctx.now, checks: pd.checks, computed: pd.computed, person: str(i, "party_id") || null, number_id: str(i, "phone_number_id") || null, fdcpa_debt_collector: flag(i, "fdcpa_debt_collector"), ...(typeof i.line_type === "string" ? { line_type: i.line_type } : {}) }); ctx.events.append({ type: req.type, loanId, actor: ctx.actor, payload: req.payload }); }
      // 11.4 `gates.evaluate` on a DC-loan outbound call/voicemail/SMS (ops-11-4.ts): appends `contact.attempt.requested` (+ `communication.outbound.requested`) with the Contact Engine facts and refuses on the first failing Reg F gate — workplace (§1006.6(b)(3)), 7-in-7 (§1006.14(b)), the §1006.18(e) fragment on a conversation script, the LCM template on a voicemail (§1006.2(j)), the RND check on SMS (§1006.6(d)(5)).
      if (direction === "outbound" && flag(i, "fdcpa_debt_collector")) { const f = (i.pre_dial_facts as Record<string, unknown> | undefined) ?? {}; const mode = str(i, "mode"); const vmail = /voicemail/.test(outcome); const channel = (mode === "sms" ? "sms" : vmail ? "voicemail" : "voice") as OutboundChannel; const conversation = outcome === "conversation" || outcome === "qrpc";
        const st = rt.store.get("fdcpa_status", loanId)?.data; const end = optDate(i, "validation_period_end_on") ?? (typeof st?.validation_period_end_on === "string" ? D(st.validation_period_end_on) : null); const vm = (i.voicemail as { business_name?: string; agent_name?: string; phone?: string; text?: string } | undefined) ?? {};
        const g = evaluateOutboundCommunication(ctx, { loan_id: loanId, channel, fdcpa_debt_collector: true, text: vmail ? String(vm.text ?? "") : str(i, "script") || str(i, "transcript") || str(i, "body"), attempt_only: !vmail && !conversation && channel !== "sms", subject: str(i, "subject"), initial_communication: flag(i, "initial_communication"), template: str(i, "template") || null, ref_date: D(on), validation_period_end_on: end,
          ...(vmail ? { voicemail: { business_name: String(vm.business_name ?? "Supermortgage"), agent_name: String(vm.agent_name ?? ""), phone: String(vm.phone ?? "") } } : {}),
          dial: { mode: (mode === "sms" ? "sms" : mode === "human_voice" ? "human_voice" : "ai_voice"), on: D(on), now: typeof f.dial_at === "string" ? f.dial_at : ctx.now, person: str(i, "party_id") || null, number_id: str(i, "phone_number_id") || null, workplace_flag: f.workplace_flag === true, employer_prohibits: f.employer_prohibits === true, days_since_rnd_check: typeof f.days_since_rnd_check === "number" ? f.days_since_rnd_check : typeof i.days_since_rnd_check === "number" ? i.days_since_rnd_check : null, days_since_consumer_texted_from_number: typeof f.days_since_consumer_texted_from_number === "number" ? f.days_since_consumer_texted_from_number : typeof i.days_since_consumer_texted_from_number === "number" ? i.days_since_consumer_texted_from_number : null, counted_call_attempts_at: Array.isArray(f.counted_call_attempts_at) ? (f.counted_call_attempts_at as string[]) : [] } });
        if (!g.allowed) { const x = g.gates.find((y) => y.code === g.refused_by[0])!; refuse(ctx, loanId, "contact.log", x.code, "11.4 timer table: refused (Reg F §1006.2(j), §1006.6(b)(3), §1006.6(d)(5), §1006.14(b), §1006.18(e))", x.reason ?? x.code); } }
      const rec = rt.store.put("contacts", str(i, "id") || `ct-${loanId}-${rt.store.list("contacts").length + 1}`, { loan_id: loanId, direction, mode: str(i, "mode"), outcome, live_contact: live, live_contact_basis: lc.basis, party_id: str(i, "party_id") || null, phone_number_id: str(i, "phone_number_id") || null, attempted_at: ctx.now, on, pre_dial_checks: direction === "outbound" ? pd.checks : null, pre_dial_checks_computed: direction === "outbound" ? pd.computed : null, pre_dial_detail: direction === "outbound" ? pd.detail : null, regf_counted: direction === "outbound" && /voice/.test(str(i, "mode")) && outcome !== "busy_or_failed", quiet_hours_check: i.quiet_hours_check ?? (pd.computed ? pd.detail.consumer_local_times : null) }, ctx.actor, ctx.now);
      ctx.events.append({ type: "contact.logged", loanId, actor: ctx.actor, payload: { id: rec.id, version: rec.version, direction, mode: str(i, "mode"), outcome } });
      if (direction === "outbound") ctx.events.append({ type: "contact.attempted", loanId, actor: ctx.actor, payload: { contact_id: rec.id, direction: "outbound", mode: str(i, "mode"), outcome, on, live_contact: live, person: str(i, "party_id") || null, fdcpa_debt_collector: flag(i, "fdcpa_debt_collector"), pre_dial_checks_computed: pd.computed } });
      else ctx.events.append({ type: "contact.inbound.received", loanId, actor: ctx.actor, payload: { contact_id: rec.id, direction: "inbound", outcome, on } });
      if (outcome === "conversation" || outcome === "qrpc") ctx.events.append({ type: "contact.completed", loanId, actor: ctx.actor, payload: { contact_id: rec.id, outcome, on, fdcpa_debt_collector: flag(i, "fdcpa_debt_collector"), person: str(i, "party_id") || null } });
      if (live) { ctx.events.append({ type: "contact.live.established", loanId, actor: ctx.actor, payload: { contact_id: rec.id, on, basis: rec.data.live_contact_basis, direction } }); const canonical = liveSatisfiedEvent(null, "contact.live.established", D(on), { contact_id: rec.id }); ctx.events.append({ type: canonical.type, loanId, actor: ctx.actor, payload: { ...canonical.payload, live_contact_basis: rec.data.live_contact_basis } }); }
      return rec.data; }),
    guardrails: [never("PRE_DIAL_CHECKS_REQUIRED", "11.1 guardrail: no dial without every pre-dial check passing (consent, line type, tz window, Reg F count, landline 30-day cap, cease/bk/attorney/scra flags, pre-sale gate)", (i) => str(i, "direction") === "outbound" && !preDialChecksPass(i), "an outbound attempt is logged only when every pre-dial check passes — computed from pre_dial_facts through the 11.1/11.4 evaluators, or pre_dial_checks{consent, quiet_hours, regf_count, post_conversation, pre_sale, cease_flags, bk_flag, attorney_flag, workplace} all true"),
      never("ONE_VOICEMAIL_PER_NUMBER_7D", "11.1 guardrail: no more than one voicemail per number per 7 days (policy; 11.1-Q3)", (i) => /voicemail/.test(str(i, "outcome")) && num(i, "voicemails_to_number_7d") >= 1, "a voicemail was already left on this number in the last 7 days"),
      never("NO_DIRECT_CONTACT_WHEN_REPRESENTED", "11.4 guardrail: never contacts a represented consumer directly (Reg F §1006.6(b)(2))", (i) => str(i, "direction") === "outbound" && flag(i, "attorney_represented") && !flag(i, "to_counsel"), "route the communication to counsel")] },
  { name: "decision.record", kind: "write", handler: decision(),
    guardrails: [never("NO_ELIGIBILITY_STATEMENTS", "11.3 guardrail: no eligibility or approval statements", (i) => statements(i).some((s) => ELIGIBILITY_WORDS.test(s)), "the AI never states eligibility or approval"),
      never("NO_THREATS", "11.3 guardrail: no threats (§1006.18(c))", (i) => statements(i).some((s) => THREAT_WORDS.test(s)), "no threat of action not intended or unlawful"),
      never("NO_NOT_DISPUTED_STATEMENT", "11.4 guardrail: the AI never states that a debt is \"not disputed\" (Reg F §1006.18(a); §1006.38(e): failure to dispute is not an admission)", (i) => statements(i).some((s) => NOT_DISPUTED_WORDS.test(s)), "a debt is never described as undisputed or beyond dispute"),
      never("NO_FINANCIAL_DETAIL_DEMANDS", "11.3 guardrail: no financial-detail demands (11.3-Q5)", (i) => statements(i).some((s) => FINANCIAL_DEMAND_WORDS.test(s)), "the AI never requires income, asset or expense figures for QRPC"),
      never("LOSSMIT_FACTS_ONLY", "11.1 guardrail: no option, deadline or foreclosure statement not present in `lossmit_facts` (4.3); `options_informed` cites its source version", outsideLossmitFacts, "option, deadline and foreclosure statements are read from lossmit_facts, never from model memory"),
      never("NO_NEGOTIATION_WHERE_LICENSED", "11.3 guardrail: no negotiation where licensed", (i) => licensedNegotiationGate({ question: str(i, "borrower_question"), mlo_licensing_for_lossmit: flag(i, "mlo_licensing_for_lossmit"), licensed_specialist_on_call: flag(i, "licensed_specialist_on_call") }).decline_quote && flag(i, "terms_quoted"), "warm-transfer to a licensed specialist")] },
]);

export const SECTION_11_TOOLS: readonly ToolDef[] = [...p112, ...p113];
