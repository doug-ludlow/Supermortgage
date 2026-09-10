/**
 * §11.4 process-owned operations — the FDCPA sub-engine's `gates.evaluate` ("called by every outbound command on the
 * loan", AI agent design) over an `EventStore`. 11.4 names no bus tools in spec/registry/agents.json (`tools: []`), so
 * — like ops-8-1.ts — the §11.2/11.3 tools (`edeliver.send`, `contact.log`, section11.ts) call these on a DC loan and
 * refuse on the gate code that fails. The code paths append the events the 11.4 gate rows arm on:
 *
 *   communication.outbound.requested{loan_id, channel, fdcpa_debt_collector, within_validation_period, initial_communication,
 *       template, disclosure_fragment_present, opt_out_statement_present, opt_out_fee, subject_clean, voicemail_template,
 *       demand_inconsistent_with_dispute_rights, pay_within_shorter_than_period, esign_consent_regf_validation, ref_date,
 *       validation_period_end_on}
 *     — every outbound communication on a DC loan ("any outbound communication command on a DC loan (gate checks)"):
 *       REGF_1006_18E_DISCLOSURE_GATE, REGF_1006_38_OVERSHADOW_GATE, REGF_1006_6E_OPTOUT_PRESENT,
 *       REGF_1006_2_LCM_ONLY_VOICEMAIL, REGF_1006_42_ESIGN_GATE key on it; the payload carries the facts their
 *       evaluators (src/app/evaluators.ts "11.4.*") read, computed here from the text, never self-reported.
 *   contact.attempt.requested{loan_id, direction=outbound, mode∈{voice, sms}, dial_mode, on, now, person, number_id,
 *       fdcpa_debt_collector, fdcpa_debt_collector_flag, workplace_flag, employer_prohibits, days_since_rnd_check,
 *       days_since_consumer_texted_from_number, counted_call_attempts_at}
 *     — the Contact Engine's pre-dial request for a DC-loan call/voicemail/SMS: REGF_1006_6B3_WORKPLACE_GATE,
 *       REGF_1006_6D5_SMS_RND_60 and 11.1's REGF_1006_14_CALL_CAP_7IN7 key on it. `mode` is the channel-level mode the
 *       registry rows condition on (`mode=voice` / `mode=sms` — the Reg F cap counts AI and human calls alike);
 *       `dial_mode` keeps the dialer's ai_voice/human_voice/sms. `fdcpa_debt_collector_flag` is the 1.1 boarding field
 *       name the 11.1 row keys on; `fdcpa_debt_collector` the §11 tool-input spelling the 11.4 rows key on.
 *
 * Gate facts (11.4 rules 4, 11, 12, 13; timer table): the §1006.18(e) fragment — initial ("attempting to collect a debt
 * … used for that purpose") vs subsequent ("this communication is from a debt collector") variant — is detected in the
 * text; overshadowing (§1006.38(b)) only inside the validation period (`ref_date ≤ validation_period_end_on`); the
 * opt-out statement / no fee (§1006.6(e)) and the debt-free subject line (rule 12) on email/SMS; the limited-content
 * message (§1006.2(j)) on voicemail; the RND freshness (§1006.6(d)(5)) on SMS; the workplace rule (§1006.6(b)(3)) and
 * the 7-in-7 cap (§1006.14(b)) on calls; the cease / dispute / attorney overlays (§1006.6(c), §1006.38, §1006.6(b)(2))
 * from `fdcpa.ts communicationAllowed`. Every input is validated (RangeError) before anything is appended; the request
 * event is appended whether or not the gates pass (the refusal is the caller's `command.refused`).
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { overshadows, communicationAllowed, type Overlay } from "./fdcpa.ts";
import { dcEmailCheck, voicemailCheck } from "./ops.ts";

export type OutboundChannel = "letter" | "statement" | "email" | "sms" | "voice" | "voicemail";
export type DialMode = "ai_voice" | "human_voice" | "sms";

export interface OutboundRequest {
  readonly loan_id: string;
  readonly channel: OutboundChannel;
  /** The loan's `fdcpa_status.debt_collector` (11.4 rule 1). Non-DC loans: no Reg F gate applies; nothing is appended. */
  readonly fdcpa_debt_collector: boolean;
  /** The communication's text: letter/statement body, email/SMS body, the call script or transcript, the voicemail message. */
  readonly text: string;
  /** Email subject line / SMS preview (rule 12: never references the debt). */
  readonly subject?: string;
  /** True for the initial communication (§1006.18(e)(1) full statement); false → the subsequent-communication variant. */
  readonly initial_communication?: boolean;
  readonly template?: string | null;
  /** The date the communication goes out (the overshadowing reference date). */
  readonly ref_date: PlainDate;
  /** `fdcpa_status.validation_period_end_on` (null before the validation notice is sent). */
  readonly validation_period_end_on?: PlainDate | null;
  /** §1006.6(e): no fee may be charged for the opt-out. */
  readonly opt_out_fee?: boolean;
  /** Electronic validation notice (B-1 by email): a valid E-SIGN consent for class `regf_validation` (§1006.42). */
  readonly esign_consent_regf_validation?: boolean;
  /** Voicemail: the limited-content message fields (§1006.2(j)). */
  readonly voicemail?: { readonly business_name: string; readonly agent_name: string; readonly phone: string };
  /** Calls/SMS: the Contact Engine facts the pre-dial gates read. */
  readonly dial?: { readonly mode: DialMode; readonly on: PlainDate; readonly now?: string; readonly person?: string | null; readonly number_id?: string | null;
    readonly workplace_flag?: boolean; readonly employer_prohibits?: boolean; readonly days_since_rnd_check?: number | null; readonly days_since_consumer_texted_from_number?: number | null; readonly counted_call_attempts_at?: readonly string[] };
  /** The loan's overlays (`overlayOf(fdcpa_status)`) and the communication's kind for the permitted-notice matrix (11.4-Q2). */
  readonly overlay?: Overlay;
  readonly kind?: string;
  /** A borrower-initiated response is answered fully even under a cease (11.4-T7; §1006.6(c)(1)–(3) safe harbours). */
  readonly borrower_initiated?: boolean;
  /** An "attempt to communicate" (§1006.2(b)): no information regarding the debt is conveyed (no answer, busy) — the §1006.18(e) and §1006.38(b) content gates do not attach; the pre-dial gates do. */
  readonly attempt_only?: boolean;
}
export interface GateEvaluation { readonly code: string; readonly evaluator: string | null; readonly open: boolean; readonly reason: string | null; readonly action: "refuse" | "mail_instead" | null; }
export interface OutboundGateResult {
  readonly allowed: boolean;
  /** Gate codes that failed, in evaluation order (the caller refuses on the first). */
  readonly refused_by: readonly string[];
  /** The gate whose failure is a channel fallback rather than a refusal (REGF_1006_42_ESIGN_GATE → mail). */
  readonly fallback: "mail" | null;
  readonly gates: readonly GateEvaluation[];
  readonly within_validation_period: boolean;
  readonly disclosure_fragment_present: boolean;
  readonly disclosure_variant: "initial" | "subsequent";
  readonly events: readonly DomainEvent[];
}
export interface GateContext { readonly events: EventStore; readonly actor: Actor; readonly now: string; readonly loanId?: string | undefined; }

const CHANNELS: readonly OutboundChannel[] = ["letter", "statement", "email", "sms", "voice", "voicemail"];
/** §1006.18(e)(1): "attempting to collect a debt and that any information obtained will be used for that purpose". */
const INITIAL_DISCLOSURE = /attempting to collect a debt and (that )?any information obtained will be used for that purpose/i;
/** §1006.18(e)(2): "this communication is from a debt collector". */
const SUBSEQUENT_DISCLOSURE = /communication is from a debt collector/i;
const EVALUATION_ORDER = ["REGF_1006_6C_CEASE_GATE", "REGF_1006_38_DISPUTE_CEASE_GATE", "REGF_1006_6B2_ATTORNEY_GATE", "REGF_1006_6B3_WORKPLACE_GATE", "REGF_1006_18E_DISCLOSURE_GATE", "REGF_1006_38_OVERSHADOW_GATE", "REGF_1006_6E_OPTOUT_PRESENT", "SM_REGF_SUBJECT_NO_DEBT_REFERENCE", "REGF_1006_6D5_SMS_RND_60", "REGF_1006_14_CALL_CAP_7IN7", "REGF_1006_2_LCM_ONLY_VOICEMAIL", "REGF_1006_42_ESIGN_GATE"] as const;

/** The §1006.18(e) disclosure present in `text` for the variant the communication needs (11.4 rule 11). */
export function disclosurePresent(text: string, initial: boolean): boolean { return initial ? INITIAL_DISCLOSURE.test(text) : SUBSEQUENT_DISCLOSURE.test(text); }
/** §1006.38(b): the validation period runs through `validation_period_end_on` (printed on the notice). */
export function withinValidationPeriod(refDate: PlainDate, end: PlainDate | null | undefined): boolean { return end !== null && end !== undefined && refDate <= end; }

function validate(r: OutboundRequest): void {
  if (!r.loan_id) throw new RangeError("loan_id is required");
  if (!CHANNELS.includes(r.channel)) throw new RangeError(`channel ${String(r.channel)} is not one of ${CHANNELS.join(", ")}`);
  if (typeof r.text !== "string") throw new RangeError("text is required (the communication's body, script or message)");
  if (!r.ref_date) throw new RangeError("ref_date is required");
  if ((r.channel === "voice" || r.channel === "voicemail" || r.channel === "sms") && !r.dial) throw new RangeError(`dial{mode, on} is required for a ${r.channel} request`);
  if (r.channel === "voicemail" && !r.voicemail) throw new RangeError("voicemail{business_name, agent_name, phone} is required for a voicemail request");
  if (r.dial && !["ai_voice", "human_voice", "sms"].includes(r.dial.mode)) throw new RangeError(`dial.mode ${String(r.dial.mode)} is not ai_voice/human_voice/sms`);
}

/**
 * `gates.evaluate`: appends the request event(s) for a DC loan and evaluates every Reg F gate the channel attracts through
 * the registry's evaluators. Returns the evaluation; the caller refuses (`command.refused{code}`) on `refused_by[0]`, or
 * falls back to mail on `fallback`. A non-DC loan is not gated by Reg F (11.4 edge cases: state overlays are the Contact
 * Engine's, 11.4-T16) — nothing is appended and the result is open.
 */
export function evaluateOutboundCommunication(ctx: GateContext, r: OutboundRequest): OutboundGateResult {
  validate(r);
  const initial = r.initial_communication === true;
  const variant: "initial" | "subsequent" = initial ? "initial" : "subsequent";
  if (!r.fdcpa_debt_collector) return { allowed: true, refused_by: [], fallback: null, gates: [], within_validation_period: false, disclosure_fragment_present: disclosurePresent(r.text, initial), disclosure_variant: variant, events: [] };
  const within = withinValidationPeriod(r.ref_date, r.validation_period_end_on);
  const electronic = r.channel === "email" || r.channel === "sms";
  const mail = dcEmailCheck({ subject: r.subject ?? "", body: r.text });
  const vm = r.channel === "voicemail" && r.voicemail ? voicemailCheck({ ...r.voicemail, text: r.text }) : null;
  // §1006.38(b): only inside the validation period; letters get the full template check (dispute statement included), other channels the demand/threat checks.
  const issues = within ? overshadows(r.text, r.validation_period_end_on as PlainDate, r.ref_date) : [];
  const payWithin = issues.some((s) => /within \d+ days/.test(s));
  const inconsistent = issues.some((s) => /threatens action/.test(s)) || (r.channel === "letter" && issues.some((s) => /dispute statement missing/.test(s)));
  const disclosure = r.channel === "voicemail" ? vm !== null && vm.allowed : disclosurePresent(r.text, initial);   // a limited-content message is not a "communication" (§1006.2(b), (j)); it carries no disclosure by design
  const events: DomainEvent[] = [];
  const loanId = r.loan_id;
  events.push(ctx.events.append({ type: "communication.outbound.requested", loanId, actor: ctx.actor, payload: {
    loan_id: loanId, channel: r.channel, fdcpa_debt_collector: true, within_validation_period: within, initial_communication: initial, template: r.template ?? null,
    disclosure_fragment_present: disclosure, disclosure_variant: variant, opt_out_statement_present: mail.opt_out_present, opt_out_fee: r.opt_out_fee === true, subject_clean: mail.subject_clean,
    voicemail_template: vm === null ? null : vm.allowed ? "limited_content" : "non_limited_content", demand_inconsistent_with_dispute_rights: inconsistent, pay_within_shorter_than_period: payWithin,
    esign_consent_regf_validation: r.esign_consent_regf_validation === true, ref_date: r.ref_date, validation_period_end_on: r.validation_period_end_on ?? null, kind: r.kind ?? null, borrower_initiated: r.borrower_initiated === true, attempt_only: r.attempt_only === true } }));
  const d = r.dial;
  if (d && (r.channel === "voice" || r.channel === "voicemail" || r.channel === "sms")) {
    events.push(ctx.events.append({ type: "contact.attempt.requested", loanId, actor: ctx.actor, payload: {
      loan_id: loanId, direction: "outbound", mode: r.channel === "sms" ? "sms" : "voice", dial_mode: d.mode, channel: r.channel, on: d.on, now: d.now ?? ctx.now, person: d.person ?? null, number_id: d.number_id ?? null,
      fdcpa_debt_collector: true, fdcpa_debt_collector_flag: true, workplace_flag: d.workplace_flag === true, employer_prohibits: d.employer_prohibits === true,
      days_since_rnd_check: d.days_since_rnd_check ?? null, days_since_consumer_texted_from_number: d.days_since_consumer_texted_from_number ?? null, counted_call_attempts_at: [...(d.counted_call_attempts_at ?? [])] } }));
  }
  // ---- the gates, in evaluation order ----
  const gates: GateEvaluation[] = [];
  const push = (code: string, evaluator: string | null, g: { open: boolean; reason?: string }, action: GateEvaluation["action"] = "refuse"): void => { gates.push({ code, evaluator, open: g.open, reason: g.open ? null : g.reason ?? code, action: g.open ? null : action }); };
  if (r.overlay) {
    const dir = r.borrower_initiated ? "borrower_initiated" : "outbound_collection";
    const kind = r.kind ?? (r.channel === "statement" ? "periodic_statement" : "collection");
    const a = communicationAllowed(r.overlay, kind, dir);
    // the overlay that closed the door, in fdcpa.ts communicationAllowed's order (stay → attorney → dispute → cease)
    const o = r.overlay; const code = dir === "borrower_initiated" ? null : o.bankruptcy_stay ? "BANKRUPTCY_STAY" : o.attorney_represented ? "REGF_1006_6B2_ATTORNEY_GATE" : o.dispute_open && !a.allowed ? "REGF_1006_38_DISPUTE_CEASE_GATE" : o.cease_active && !a.allowed ? "REGF_1006_6C_CEASE_GATE" : null;
    if (!a.allowed) push(code ?? "REGF_1006_6C_CEASE_GATE", null, { open: false, reason: a.reason ?? "overlay" });
    else if (o.cease_active || o.dispute_open || o.attorney_represented) push(o.cease_active ? "REGF_1006_6C_CEASE_GATE" : o.dispute_open ? "REGF_1006_38_DISPUTE_CEASE_GATE" : "REGF_1006_6B2_ATTORNEY_GATE", null, { open: true });
  }
  if (d) push("REGF_1006_6B3_WORKPLACE_GATE", "11.4.workplaceProhibited", evaluateGate("11.4.workplaceProhibited", { workplace_flag: d.workplace_flag === true, employer_prohibits: d.employer_prohibits === true }));
  const conveys = r.channel !== "voicemail" && r.attempt_only !== true;   // a limited-content message / an unanswered attempt conveys nothing about the debt (§1006.2(b), (j))
  if (conveys) push("REGF_1006_18E_DISCLOSURE_GATE", "11.4.disclosureFragmentPresent", evaluateGate("11.4.disclosureFragmentPresent", { disclosure_fragment_present: disclosure }));
  if (conveys && within) push("REGF_1006_38_OVERSHADOW_GATE", "11.4.noOvershadowing", evaluateGate("11.4.noOvershadowing", { demand_inconsistent_with_dispute_rights: inconsistent, pay_within_shorter_than_period: payWithin }));
  if (electronic) {
    push("REGF_1006_6E_OPTOUT_PRESENT", "11.4.optOutPresent", evaluateGate("11.4.optOutPresent", { opt_out_statement_present: mail.opt_out_present, opt_out_fee: r.opt_out_fee === true }));
    push("SM_REGF_SUBJECT_NO_DEBT_REFERENCE", null, mail.subject_clean ? { open: true } : { open: false, reason: "11.4 rule 12: subject lines/previews never reference the debt" });
  }
  if (d && r.channel === "sms") push("REGF_1006_6D5_SMS_RND_60", "11.4.reassignedNumberCheckFresh", evaluateGate("11.4.reassignedNumberCheckFresh", { days_since_rnd_check: d.days_since_rnd_check ?? null, days_since_consumer_texted_from_number: d.days_since_consumer_texted_from_number ?? null }));
  if (d && r.channel !== "sms") push("REGF_1006_14_CALL_CAP_7IN7", "11.1.callCap7in7", evaluateGate("11.1.callCap7in7", { now: d.now ?? ctx.now, counted_call_attempts_at: [...(d.counted_call_attempts_at ?? [])] }));
  if (r.channel === "voicemail") push("REGF_1006_2_LCM_ONLY_VOICEMAIL", "11.4.limitedContentMessageOnly", { ...evaluateGate("11.4.limitedContentMessageOnly", { voicemail_template: vm && vm.allowed ? "limited_content" : "non_limited_content" }), ...(vm && !vm.allowed ? { reason: `not a limited-content message: ${vm.violations.join("; ")}` } : {}) });
  if (r.channel === "email" && r.template === "NTC_REGF_1006_34_VALIDATION_B1") push("REGF_1006_42_ESIGN_GATE", "11.4.esignConsentForValidation", evaluateGate("11.4.esignConsentForValidation", { esign_consent_regf_validation: r.esign_consent_regf_validation === true }), "mail_instead");
  const ordered = [...gates].sort((a, b) => EVALUATION_ORDER.indexOf(a.code as (typeof EVALUATION_ORDER)[number]) - EVALUATION_ORDER.indexOf(b.code as (typeof EVALUATION_ORDER)[number]));
  const refused = ordered.filter((g) => !g.open && g.action === "refuse").map((g) => g.code);
  const fallback = ordered.some((g) => !g.open && g.action === "mail_instead") ? "mail" : null;
  return { allowed: refused.length === 0, refused_by: refused, fallback, gates: ordered, within_validation_period: within, disclosure_fragment_present: disclosure, disclosure_variant: variant, events };
}
