/**
 * §11.1 process-owned operating rules on top of ./ops.ts, ./plan.ts and ./windows.ts:
 *
 *  - the pre-dial gate (`preDialGate`): the channel-selection matrix (rule 7 — TCPA consent, line type, landline
 *    3-in-30, skip-trace / human-only), quiet hours in every candidate time zone (rule 8), the Reg F 7-in-7 counter or
 *    the state/policy cap (rule 9), the post-conversation cooling-off, the D2-2-02 pre-sale stop (rule 11), the
 *    cease / bankruptcy / attorney / workplace flags — computed from facts, never self-reported;
 *  - the dial request (`requestDial`): appends `contact.attempt.requested` — the trigger of the gate timers
 *    `REGF_1006_14_CALL_CAP_7IN7`, `REGF_1006_6B1_QUIET_HOURS`, `TCPA_64_1200_A1_CELL_CONSENT_GATE` and
 *    `TCPA_64_1200_A3_LANDLINE_AI_3IN30` (timers.ts / timers-11-1.ts) — with the fields their patterns condition on
 *    (`direction`, `mode`, `channel`, `line_type`, `written_consent`, `fdcpa_debt_collector_flag`) and the facts the
 *    evaluators `11.1.callCap7in7` / `11.1.quietHours` / `11.1.tcpaConsentUnrevoked` / `11.1.landlineAi3in30` read;
 *    a refused request is still recorded (the Compliance Sentinel counts refusals) and never becomes an attempt;
 *  - the inbound-SMS ingestion (`ingestInboundSms`): a STOP-family keyword (47 CFR 64.1200(a)(10)) commits
 *    `consent.revoked` — the trigger of `TCPA_64_1200_A10_REVOCATION_HONOR_10BD` — and `consent.revocation.honored`
 *    (its satisfier) at receipt, and queues the single confirmation text allowed within five minutes;
 *  - the bankruptcy-resume reaction (`attachBankruptcyResumeHooks_11_1` / `resumeWindowsAfterBankruptcy`): 14.3's
 *    rule-6 decision `bankruptcy.early_intervention.evaluated{trigger=resume, required=true}` (published by the 14.3
 *    bus tool, src/app/tools/section14-3.ts) is the platform's spelling of the spec's `bankruptcy.dismissed/closed/
 *    reaffirmed`; the reaction validates the record and re-opens the §1024.39(a) windows from `resume_from_due_date`
 *    (windows.ts resumeAfterBankruptcy) — appending `regx.ei_windows.resume_after_bk{next_due_date}` (the trigger of
 *    `REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE`) and `loan.delinquency.window_opened{after_bk_resume=true}` (its satisfier);
 *  - the live-contact rule (`liveContactOf`): comment 39(a)-2 / design item 2 — `live_contact=true` is accepted only on a
 *    spoken two-way outcome, never on the caller's flag alone.
 * The 11.3 `contact.log` tool (src/app/tools/section11.ts) records the request for every outbound attempt it logs;
 * ./11-1.spec.test.ts drives the TimerEngine with these events.
 */
import { type PlainDate, addDays, plainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { SYSTEM, type EventStore, type DomainEvent, type Actor } from "../../kernel/events/index.ts";
import { selectChannel, quietHoursCheck, regfDialCheck, postConversationGate, preSaleStop, stateOverlay, smsRevocation, type CallAttempt } from "./ops.ts";
import { dialRequest, type ContactPlan, type PlanAttempt, type PreDialChecks } from "./plan.ts";
import { resumeAfterBankruptcy } from "./windows.ts";

export interface EmittedEvent { readonly type: string; readonly payload: Record<string, unknown>; }
export type DialMode = PlanAttempt["mode"];
export type DialChannel = "voice" | "sms" | "email" | "mail";
export type LineType = "mobile" | "landline" | "voip" | "unknown";
const MODES: readonly DialMode[] = ["ai_voice", "human_voice", "sms", "email", "letter"];
const DAY = 86_400_000;

/** The facts the dial-time matrix is evaluated on (the `pre_dial_facts` the contact.log tool receives — same keys). */
export interface DialFacts {
  readonly loan_id: string;
  readonly mode: DialMode;
  /** ISO instant of the request (the dial time the quiet-hours and trailing counters are measured at). */
  readonly dial_at: string;
  readonly person?: string | null;
  readonly number_id?: string | null;
  readonly line_type?: LineType;
  /** `tcpa_voice_written` for the number (landline AI voice unlimited with it, 47 CFR 64.1200(a)(3)). */
  readonly written_consent?: boolean;
  readonly tcpa_voice_consent_active?: boolean;
  readonly tcpa_sms_consent_active?: boolean;
  readonly human_only?: boolean;
  /** `phone_numbers.source` — a skip-traced number is human dial only until confirmed (rule 7). */
  readonly source?: string;
  readonly fdcpa_debt_collector: boolean;
  readonly state?: string;
  /** Candidate time zones: property address, mailing address, phone area code (rule 8). */
  readonly time_zones?: readonly string[];
  /** ISO instants of the counted outbound voice attempts to this person about this loan (rule 9). */
  readonly counted_call_attempts_at?: readonly string[];
  /** ISO instants of the AI-voice attempts to this number (landline 3-in-30). */
  readonly ai_voice_attempts_at?: readonly string[];
  readonly days_since_conversation?: number | null;
  readonly callback_consent_within_7d?: boolean;
  readonly days_until_sale?: number | null;
  readonly judicial?: boolean;
  readonly contact_required_through_sale?: boolean;
  readonly bk_active?: boolean;
  readonly cease_active?: boolean;
  readonly attorney_represented?: boolean;
  readonly to_counsel?: boolean;
  readonly workplace_flag?: boolean;
  readonly employer_prohibits?: boolean;
}

export interface DialGate {
  readonly checks: PreDialChecks;
  readonly allowed: boolean;
  /** Gate / timer codes that refused, in matrix order. */
  readonly refused_by: readonly string[];
  /** Where a consent refusal sends the attempt (spec: "route to `human_voice` (manual dial) or mail"). */
  readonly route: "ai_voice" | "human_manual_dial" | null;
  readonly channel: DialChannel;
  readonly on: PlainDate;
  readonly detail: Record<string, unknown>;
}

export const channelOf = (mode: DialMode): DialChannel => (mode === "sms" ? "sms" : mode === "email" ? "email" : mode === "letter" ? "mail" : "voice");
const count = (at: readonly string[] | undefined, nowMs: number, days: number): number => (at ?? []).filter((t) => { const ms = Date.parse(t); return Number.isFinite(ms) && ms <= nowMs && nowMs - ms < days * DAY; }).length;
const localTimes = (ms: number, zones: readonly string[]): { tz: string; time: string }[] => zones.map((tz) => { const w = wallClock(ms, tz); return { tz, time: `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}` }; });

function validate(f: DialFacts): number {
  if (!f.loan_id) throw new RangeError("loan_id is required");
  if (!MODES.includes(f.mode)) throw new RangeError(`mode ${String(f.mode)} is not one of ${MODES.join("/")}`);
  const ms = Date.parse(f.dial_at ?? "");
  if (!Number.isFinite(ms)) throw new RangeError("dial_at must be an ISO instant");
  return ms;
}

/** Rules 7–9 and 11 plus the overlay flags, evaluated at dial time. Every check is computed from `f`; nothing is taken on the caller's word. */
export function preDialGate(f: DialFacts): DialGate {
  const dialMs = validate(f);
  const channel = channelOf(f.mode);
  const zones = f.time_zones ?? [];
  const on = wallClock(dialMs, zones[0] ?? "America/New_York").date;
  const refused: string[] = [];
  // rule 7 — channel selection (TCPA consent / line type / landline 3-in-30 / skip-trace / human-only)
  const sel = selectChannel({ line_type: f.line_type ?? "unknown", tcpa_voice_consent: f.tcpa_voice_consent_active === true, tcpa_sms_consent: f.tcpa_sms_consent_active === true, written_consent: f.written_consent === true, ai_voice_attempts_30d: count(f.ai_voice_attempts_at, dialMs, 30), human_only: f.human_only === true, ...(f.source !== undefined ? { source: f.source } : {}) });
  const consent = f.mode === "ai_voice" ? sel.ai_voice : f.mode === "sms" ? sel.sms : true;
  if (!consent) refused.push(f.mode === "sms" && sel.refused_by === null ? "TCPA_64_1200_A1_CELL_CONSENT_GATE" : sel.refused_by ?? "TCPA_64_1200_A1_CELL_CONSENT_GATE");
  // rule 8 — quiet hours in every candidate time zone (mail has no send time)
  const local = localTimes(dialMs, zones);
  const quiet = channel === "mail" ? { permitted: true, refused_for: [] as readonly { tz: string; local: string }[], window: "n/a (mail)" } : zones.length === 0 ? { permitted: false, refused_for: [], window: "no candidate time zone" } : quietHoursCheck({ dial_at_ms: dialMs, time_zones: zones, mode: channel });
  if (!quiet.permitted) refused.push("REGF_1006_6B1_QUIET_HOURS");
  // rule 9 — the Reg F 7-in-7 cap on debt-collector loans, the state/policy cap elsewhere (voice only)
  const person = f.person ?? "borrower";
  const overlay = stateOverlay({ state: f.state ?? "", debt_collector: f.fdcpa_debt_collector });
  const attempts: CallAttempt[] = (f.counted_call_attempts_at ?? []).map((t) => ({ at_ms: Date.parse(t), person, outcome: "no_answer" })).filter((a) => Number.isFinite(a.at_ms));
  const cap = f.fdcpa_debt_collector ? { cap: 7, cap_code: "REGF_1006_14_CALL_CAP_7IN7" } : { cap: overlay.contact_engine.call_cap_7d ?? 5, cap_code: overlay.contact_engine.cap_code };
  const regf = channel === "voice" ? regfDialCheck(attempts, person, dialMs, { callback_consent_at_ms: f.callback_consent_within_7d ? dialMs : null, ...cap }) : null;
  if (regf && !regf.allowed) refused.push(regf.refused_by ?? cap.cap_code);
  // rule 9 — no call within 7 days after a conversation (day of conversation = day 1) unless the consumer asked for the callback
  const post = channel === "voice" && f.days_since_conversation !== undefined && f.days_since_conversation !== null ? postConversationGate(addDays(on, -Math.max(0, Math.floor(f.days_since_conversation))), on, { callback_consent: f.callback_consent_within_7d === true }) : null;
  if (post && !post.allowed) refused.push(post.refused_by ?? "REGF_1006_14_POST_CONVERSATION_7");
  // rule 11 — the D2-2-02 pre-sale stop
  const sale = f.days_until_sale !== undefined && f.days_until_sale !== null ? preSaleStop({ sale_date: addDays(on, Math.floor(f.days_until_sale)), judicial: f.judicial === true, contact_required_through_sale: f.contact_required_through_sale === true }).attemptAllowed(on) : null;
  if (sale && !sale.allowed) refused.push(sale.refused_by ?? "FNMA_D2202_CEASE_PRE_SALE_60J");
  // overlays — cease (Reg F §1006.6(c)), bankruptcy (§1024.39(c)(1)(i) / stay), counsel (§1006.6(b)(2)), workplace (§1006.6(b)(3))
  const cease = f.cease_active !== true; if (!cease) refused.push("REGF_1006_6C_CEASE_GATE");
  const bk = f.bk_active !== true; if (!bk) refused.push("BANKRUPTCY_STAY");
  const attorney = f.attorney_represented !== true || f.to_counsel === true; if (!attorney) refused.push("REGF_1006_6B2_REPRESENTED");
  const workplace = !(f.workplace_flag === true && f.employer_prohibits === true); if (!workplace) refused.push("REGF_1006_6B3_WORKPLACE_GATE");
  const checks: PreDialChecks = { consent, quiet_hours: quiet.permitted, regf_count: regf?.allowed ?? true, post_conversation: post?.allowed ?? true, pre_sale: sale?.allowed ?? true, cease_flags: cease, bk_flag: bk, attorney_flag: attorney, workplace };
  return { checks, allowed: refused.length === 0, refused_by: refused, route: !consent ? sel.route : refused.length === 0 ? (f.mode === "ai_voice" ? "ai_voice" : "human_manual_dial") : null, channel, on,
    detail: { consumer_local_times: local, quiet_window: quiet.window, consent_route: sel.route, consent_refused_by: sel.refused_by, cap: cap.cap, cap_code: cap.cap_code, regf_count_after: regf?.count_after ?? null, regf_exclusion: regf?.regf_exclusion ?? null, post_conversation_permitted_from: post?.permitted_from ?? null, pre_sale_basis: sale?.logged_basis ?? null, overlays: overlay.overlays } };
}

/**
 * The `contact.attempt.requested` event for a dial request: the gate timers' trigger, carrying the fields their
 * registry patterns condition on and the facts the 11.1 evaluators read (`now`, `mode`, `consumer_local_time`,
 * `counted_call_attempts_at`, `ai_voice_attempts_at`, `tcpa_*_consent_active`).
 */
export function attemptRequestedEvent(f: DialFacts, gate: DialGate = preDialGate(f)): EmittedEvent {
  const local = gate.detail.consumer_local_times as readonly { tz: string; time: string }[];
  return { type: "contact.attempt.requested", payload: {
    loan_id: f.loan_id, direction: "outbound", mode: f.mode, channel: gate.channel, on: gate.on, now: f.dial_at, person: f.person ?? null, number_id: f.number_id ?? null,
    line_type: f.line_type ?? "unknown", written_consent: f.written_consent === true, fdcpa_debt_collector_flag: f.fdcpa_debt_collector,
    tcpa_voice_consent_active: f.tcpa_voice_consent_active === true, tcpa_sms_consent_active: f.tcpa_sms_consent_active === true,
    consumer_local_time: local[0]?.time ?? null, consumer_local_times: local, time_zones: [...(f.time_zones ?? [])],
    counted_call_attempts_at: [...(f.counted_call_attempts_at ?? [])], ai_voice_attempts_at: [...(f.ai_voice_attempts_at ?? [])],
    days_since_conversation: f.days_since_conversation ?? null, callback_consent_within_7d: f.callback_consent_within_7d === true,
    days_until_sale: f.days_until_sale ?? null, judicial: f.judicial === true, contact_required_through_sale: f.contact_required_through_sale === true,
    pre_dial_checks: gate.checks, allowed: gate.allowed, refused_by: [...gate.refused_by], route: gate.route } };
}

const asMode = (m: string): DialMode => (MODES.includes(m as DialMode) ? (m as DialMode) : /sms|text/i.test(m) ? "sms" : /email/i.test(m) ? "email" : /letter|mail/i.test(m) ? "letter" : /ai/i.test(m) ? "ai_voice" : "human_voice");
/**
 * The request event the 11.3 `contact.log` tool records for every outbound attempt it logs: with `pre_dial_facts`
 * the gate is recomputed here from the facts; without them (human dialer console) the caller's `pre_dial_checks`
 * booleans are carried as self-reported and the event says so (`pre_dial_source`).
 */
export function attemptRequestedForTool(loanId: string, mode: string, preDialFacts: unknown, o: { now: string; checks: PreDialChecks; computed: boolean; person?: string | null; number_id?: string | null; fdcpa_debt_collector?: boolean; line_type?: string }): EmittedEvent {
  const pf = (preDialFacts && typeof preDialFacts === "object" ? preDialFacts : {}) as Record<string, unknown>;
  const lt = String(pf.line_type ?? o.line_type ?? "unknown"); const lineType: LineType = lt === "mobile" || lt === "landline" || lt === "voip" ? lt : "unknown";
  const f: DialFacts = { ...(pf as Partial<DialFacts>), loan_id: loanId, mode: asMode(mode), dial_at: typeof pf.dial_at === "string" && Number.isFinite(Date.parse(pf.dial_at)) ? pf.dial_at : o.now, line_type: lineType,
    fdcpa_debt_collector: pf.fdcpa_debt_collector === true || o.fdcpa_debt_collector === true, person: o.person ?? (typeof pf.person === "string" ? pf.person : null), number_id: o.number_id ?? (typeof pf.number_id === "string" ? pf.number_id : null),
    cease_active: pf.cease_active === true || pf.written_cease === true || pf.dispute_collection_ceased === true };
  if (o.computed) { const ev = attemptRequestedEvent(f); return { type: ev.type, payload: { ...ev.payload, pre_dial_source: "pre_dial_facts" } }; }
  const failing = (Object.keys(o.checks) as (keyof PreDialChecks)[]).filter((k) => o.checks[k] !== true);
  const gate: DialGate = { checks: o.checks, allowed: failing.length === 0, refused_by: failing.map((k) => `PRE_DIAL_CHECK:${k}`), route: null, channel: channelOf(f.mode), on: wallClock(Date.parse(f.dial_at), (f.time_zones ?? [])[0] ?? "America/New_York").date, detail: { consumer_local_times: localTimes(Date.parse(f.dial_at), f.time_zones ?? []), source: "self_reported" } };
  const ev = attemptRequestedEvent(f, gate); return { type: ev.type, payload: { ...ev.payload, pre_dial_source: "self_reported" } };
}

export interface DialRequestResult { readonly allowed: boolean; readonly refused_by: readonly string[]; readonly route: DialGate["route"]; readonly checks: PreDialChecks; readonly gate: DialGate; readonly request: DomainEvent; readonly refusal: DomainEvent | null; }
/**
 * `dial.request`: records the request (the gate timers arm on it), refuses when the plan is not `active` or any
 * pre-dial check fails (11.1 guardrail: "no dial without every pre-dial check passing"); the caller places the
 * attempt — and logs `contact.attempted` — only when `allowed`.
 */
export function requestDial(events: EventStore, actor: Actor, plan: ContactPlan | null, f: DialFacts): DialRequestResult {
  const gate = preDialGate(f);
  const planVerdict = plan ? dialRequest(plan, { on: gate.on, mode: f.mode, checks: gate.checks, ...(f.person ? { person: f.person } : {}), number_id: f.number_id ?? null }) : null;
  const refused = planVerdict && planVerdict.refused_by === "PLAN_NOT_ACTIVE" ? ["PLAN_NOT_ACTIVE", ...gate.refused_by] : [...gate.refused_by];
  const ev = attemptRequestedEvent(f, gate);
  const request = events.append({ type: ev.type, loanId: f.loan_id, actor, occurredAt: f.dial_at, payload: { ...ev.payload, allowed: refused.length === 0, refused_by: refused, plan_state: planVerdict?.reason ?? null } });
  const refusal = refused.length ? events.append({ type: "contact.attempt.refused", loanId: f.loan_id, actor, occurredAt: f.dial_at, causationId: request.id, payload: { loan_id: f.loan_id, mode: f.mode, channel: gate.channel, person: f.person ?? null, number_id: f.number_id ?? null, refused_by: refused, route: gate.route, reason: planVerdict?.reason ?? null } }) : null;
  return { allowed: refused.length === 0, refused_by: refused, route: gate.route, checks: gate.checks, gate, request, refusal };
}

// ---- inbound SMS: TCPA revocation at receipt (47 CFR 64.1200(a)(10)–(12)) ----------------------------------------

export interface InboundSms { readonly loan_id: string; readonly phone_number_id: string; readonly party_id?: string | null; readonly text: string; /** ISO instant of receipt. */ readonly received_at: string; }
export interface SmsIngestion { readonly revoked: boolean; readonly keyword: string | null; readonly committed_by: string; readonly blocked: readonly string[]; readonly confirmation: { readonly count: 1; readonly send_by: string } | null; readonly legal_due: PlainDate; readonly events: readonly DomainEvent[]; }
/**
 * Validates the carrier's inbound record and, for a STOP/QUIT/END/REVOKE/OPT OUT/CANCEL/UNSUBSCRIBE text, commits
 * `consent.revoked` (arms `TCPA_64_1200_A10_REVOCATION_HONOR_10BD`, legal due +10 federal business days) and
 * `consent.revocation.honored` (satisfies it) at receipt — AI voice and SMS to the number are blocked at commit —
 * and queues the one confirmation text allowed within five minutes. Any other text is logged, nothing revoked.
 */
export function ingestInboundSms(events: EventStore, actor: Actor, i: InboundSms): SmsIngestion {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (!i.phone_number_id) throw new RangeError("phone_number_id is required");
  if (typeof i.text !== "string" || !i.text.trim()) throw new RangeError("text is required");
  const ms = Date.parse(i.received_at ?? "");
  if (!Number.isFinite(ms)) throw new RangeError("received_at must be an ISO instant");
  const receivedOn = wallClock(ms, "America/New_York").date;
  const r = smsRevocation({ received_at_ms: ms, text: i.text, received_on: receivedOn });
  const out: DomainEvent[] = [];
  const iso = (t: number): string => new Date(t).toISOString();
  const base = { loan_id: i.loan_id, phone_number_id: i.phone_number_id, party_id: i.party_id ?? null, received_at: i.received_at };
  out.push(events.append({ type: "contact.inbound.sms_received", loanId: i.loan_id, actor, occurredAt: i.received_at, payload: { ...base, text: i.text, revocation: r.revoked } }));
  if (r.revoked) {
    const revoked = events.append({ type: "consent.revoked", loanId: i.loan_id, actor, occurredAt: i.received_at, causationId: out[0]!.id, payload: { ...base, ...r.events[0]!.payload, commit_by: iso(r.committed_by_ms), legal_due: r.timer.legal_due } });
    const honored = events.append({ type: "consent.revocation.honored", loanId: i.loan_id, actor, occurredAt: i.received_at, causationId: revoked.id, payload: { ...base, ...r.events[1]!.payload, honored_at: i.received_at, blocked: [...r.blocked] } });
    const confirmation = events.append({ type: "sms.confirmation.queued", loanId: i.loan_id, actor, occurredAt: i.received_at, causationId: revoked.id, payload: { ...base, kind: "revocation_confirmation", count: 1, send_by: iso(r.confirmation_text!.send_by_ms) } });
    out.push(revoked, honored, confirmation);
  }
  return { revoked: r.revoked, keyword: r.revoked ? String(r.events[0]!.payload.keyword) : null, committed_by: iso(r.committed_by_ms), blocked: r.blocked, confirmation: r.confirmation_text ? { count: 1, send_by: iso(r.confirmation_text.send_by_ms) } : null, legal_due: r.timer.legal_due, events: out };
}

// ---- live contact (comment 39(a)-2; design item 2) -----------------------------------------------------------------

/** Outcomes in which the borrower (or agent) actually spoke: "speaking on the telephone or conducting an in-person meeting … but not leaving a recorded phone message" (comment 39(a)-2). */
export const LIVE_CONTACT_OUTCOMES: readonly string[] = ["answered_verified", "conversation", "qrpc"];
export type LiveContactBasis = "ai_voice_flag" | "human_voice" | "in_person" | "borrower_initiated" | "authorized_agent";
export interface LiveContactInput { readonly direction: string; readonly mode: string; readonly outcome: string; readonly live_contact: boolean; readonly basis?: string | null; readonly party_id?: string | null; }
/**
 * `live_contact` for a `contacts` row: the caller's flag is honored only on a spoken two-way outcome — a one-way script
 * with no borrower response is `answered_unverified` (not live contact), a voicemail / no-answer / `human_transferred`
 * AI leg never is (11.1-T19: the human leg decides). An inconsistent record is refused (RangeError), never downgraded
 * silently. The basis defaults from the record: inbound → `borrower_initiated`, `human_voice` → `human_voice`,
 * AI voice → `ai_voice_flag`; an agent party → `authorized_agent` (comment 39(a)-5).
 */
export function liveContactOf(i: LiveContactInput): { readonly live: boolean; readonly basis: LiveContactBasis | null } {
  if (!i.live_contact) return { live: false, basis: null };
  if (!LIVE_CONTACT_OUTCOMES.includes(i.outcome)) throw new RangeError(`live_contact=true requires a spoken outcome (${LIVE_CONTACT_OUTCOMES.join("/")}), not ${i.outcome || "(missing)"} (comment 39(a)-2; a one-way script with no borrower response is answered_unverified)`);
  const given = i.basis ?? null;
  const basis: LiveContactBasis = given === "in_person" || given === "authorized_agent" ? given : i.party_id === "agent" || i.party_id === "authorized_agent" ? "authorized_agent" : i.direction === "inbound" ? "borrower_initiated" : i.mode === "human_voice" ? "human_voice" : i.mode === "in_person" ? "in_person" : "ai_voice_flag";
  return { live: true, basis };
}

// ---- bankruptcy resume: §1024.39(c)(2)(i) — windows re-open from the next payment due date after the event -------------

/** The 14.3 rule-6 decision the §11 reaction subscribes to (src/domain/bankruptcy/ops-14-3.ts EI_EVENT). */
export const BK_EI_RESUME_PATTERN = "bankruptcy.early_intervention.evaluated{trigger=resume, required=true}";
const BK_RESUME_STATUSES = ["dismissed", "closed", "reaffirmed"] as const;
export interface BankruptcyResumeRecord { readonly loan_id: string; readonly status: (typeof BK_RESUME_STATUSES)[number]; readonly event_on: PlainDate; readonly resume_from_due_date: PlainDate; /** Further unpaid due dates on/after the resume date (each re-opens `after_bk_resume=true`). */ readonly due_dates?: readonly PlainDate[]; readonly principal_residence?: boolean; }
export interface BankruptcyResumeResult { readonly resume_from: PlainDate | null; readonly events: readonly DomainEvent[]; }
const dateOf = (v: unknown, what: string): PlainDate => { if (typeof v !== "string") throw new RangeError(`${what} must be an ISO date`); try { return plainDate(v); } catch { throw new RangeError(`${what} must be an ISO date, not ${JSON.stringify(v)}`); } };

/** Validates the 14.3 decision's payload as a resume record (RangeError on a malformed one). */
export function bankruptcyResumeRecord(loanId: string | undefined, p: Record<string, unknown>): BankruptcyResumeRecord {
  if (!loanId) throw new RangeError("loan_id is required");
  const status = String(p.status ?? "");
  if (!(BK_RESUME_STATUSES as readonly string[]).includes(status)) throw new RangeError(`status ${status || "(missing)"} is not one of ${BK_RESUME_STATUSES.join("/")} (§1024.39(c)(2)(i))`);
  const eventOn = dateOf(p.event_on, "event_on"); const from = dateOf(p.resume_from_due_date, "resume_from_due_date");
  if (!(from > eventOn)) throw new RangeError(`resume_from_due_date ${from} must follow the ${status} date ${eventOn} (the next payment due date after the event)`);
  const extra = Array.isArray(p.due_dates) ? p.due_dates.map((d, k) => dateOf(d, `due_dates[${k}]`)) : [];
  return { loan_id: loanId, status: status as BankruptcyResumeRecord["status"], event_on: eventOn, resume_from_due_date: from, due_dates: extra, ...(typeof p.principal_residence === "boolean" ? { principal_residence: p.principal_residence } : {}) };
}

/**
 * Re-opens the §1024.39(a) windows from the resume date: appends `regx.ei_windows.resume_after_bk{next_due_date}` and one
 * `loan.delinquency.window_opened{after_bk_resume=true}` per due date on/after it (windows.ts resumeAfterBankruptcy).
 * A discharge without reaffirmation never reaches here (14.3 publishes `required=false`; §1024.39(c)(2)(ii)).
 */
export function resumeWindowsAfterBankruptcy(events: EventStore, actor: Actor, r: BankruptcyResumeRecord, o: { causationId?: string; occurredAt?: string } = {}): BankruptcyResumeResult {
  const dues = [...new Set([r.resume_from_due_date, ...(r.due_dates ?? [])])].filter((d) => d >= r.resume_from_due_date).sort();
  const w = resumeAfterBankruptcy(r.event_on, dues, { bankruptcy_event: r.status });
  const out: DomainEvent[] = [];
  for (const e of w.events) out.push(events.append({ type: e.type, loanId: r.loan_id, actor, ...(o.occurredAt ? { occurredAt: o.occurredAt } : {}), ...(o.causationId ? { causationId: o.causationId } : {}), payload: { ...e.payload, loan_id: r.loan_id, ...(e.type === "loan.delinquency.window_opened" && r.principal_residence === false ? { principal_residence: false } : {}) } }));
  return { resume_from: w.resume_from, events: out };
}

/**
 * Ingestion subscription (the 10.4 `attachDisclosureHooks_10_4` pattern; wired by ./spec-harness.ts): on 14.3's
 * `bankruptcy.early_intervention.evaluated{trigger=resume, required=true}` the windows re-open from
 * `resume_from_due_date`; a malformed decision is recorded as `regx.ei_windows.resume_after_bk.rejected{reason}` and
 * opens nothing. Returns the detach function.
 */
export function attachBankruptcyResumeHooks_11_1(deps: { events: EventStore; actor?: Actor }): () => void {
  const actor = deps.actor ?? SYSTEM;
  return deps.events.subscribe(BK_EI_RESUME_PATTERN, (e) => {
    let rec: BankruptcyResumeRecord;
    try { rec = bankruptcyResumeRecord(e.loanId, e.payload); }
    catch (err) { deps.events.append({ type: "regx.ei_windows.resume_after_bk.rejected", ...(e.loanId ? { loanId: e.loanId } : {}), actor, occurredAt: e.occurredAt, causationId: e.id, payload: { source_event_id: e.id, reason: err instanceof Error ? err.message : String(err) } }); return; }
    resumeWindowsAfterBankruptcy(deps.events, actor, rec, { causationId: e.id, occurredAt: e.occurredAt });
  });
}
