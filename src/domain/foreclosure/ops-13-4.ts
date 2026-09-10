/**
 * §13.4 process-owned operations — the event-emitting side of the prereferral review, called by the 13.4 tools in
 * src/app/tools/section13.ts (`notices.search{op=start_review}`, the item tools' first entry, `complete_review`,
 * `lossmit.case.get{op=pr_prohibitions|e3204_ladder|record_plan_payment}`, `disaster.lookup{op=submit_request|
 * record_response}`, `title.status.get{op=record_mortgagee_of_record}`).
 *
 *  - The scheduler's `prereferral.review.due` (13.4 Inputs: "fired at `referral_required_on − 15 calendar days`",
 *    re-fired on input changes inside the window) — the event `FNMA_E3201_PREREFERRAL_REVIEW_15` arms on, anchored
 *    on `referral_required_on` (window [−15, 0]); `reviewWindow` (referral.ts) is rule 1's arithmetic.
 *  - `prereferral.review.started{state, …}` — "review start", the trigger of the three start gates
 *    (`FNMA_E3201_PRECONDITIONS_GATE`, `SM_DMDC_VERIFY_PRE_REFERRAL_30`, `FNMA_F108_MA_LEAD_PAINT_SEARCH_GATE{state=MA}`);
 *    the E-3.2-01 preconditions (breach letter and solicitation deadline expired) are read from the 11.x notices and
 *    recorded as the `BREACH_EXPIRED` / `SOLICITATION_EXPIRED` checklist items when they can be determined.
 *  - `prereferral.review.completed{outcome, disaster_impacted, valid_for_referral}` — satisfies the review window,
 *    arms `FNMA_D1301_DISASTER_FC_REQUEST_5` when disaster-impacted (rule 2: "the review is 'complete' for the 5-day
 *    clock even though referral is held") and the daily re-review on any `hold_*`.
 *  - The five principal-residence "must not refer" items (E-3.2-01) and the E-3.2-04 non-principal-residence ladder
 *    item (rule 2: "an inquiry (not a BRP) never postpones").
 *  - The workout-plan first-payment ingestion (`workout_plan.payment.received{first}`) that ends
 *    `FNMA_E3204_NONPR_FIRST_PAYMENT_EOM` ("first payment received → hold until breach").
 *  - The D1-3-01 disaster prior-approval request to hazard_loss@ (`disaster_fc_approval_requests.submitted`, all
 *    five content elements validated) and Fannie Mae's reply (`fnma.disaster_fc.responded{response}`).
 *  - The E-1.1-02 mortgagee-of-record identification the `TITLE_MORTGAGEE_OF_RECORD` item evidences
 *    (`foreclosure.prep.mortgagee_of_record.identified`).
 *
 * Money is bigint cents; dates are PlainDate; every write is a new row version or an appended event.
 */
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { plainDate as D, addDays, daysBetween, endOfMonth, type PlainDate } from "../../kernel/calendar/date.ts";
import { reviewWindow } from "./referral.ts";
import { nonPrLadder } from "./ops.ts";

type Row = Record<string, unknown>;
/** Structural subset of the app's EntityStore (versioned put; append-only history). */
export interface ReviewStore {
  get(kind: string, id: string): { readonly id: string; readonly data: Row } | undefined;
  put(kind: string, id: string, data: Row, by: Actor, now: string): { readonly id: string; readonly data: Row };
  list(kind: string, where?: (d: Row) => boolean): readonly { readonly id: string; readonly data: Row }[];
}
export interface ReviewDeps { readonly events: EventStore; readonly store: ReviewStore; readonly actor: Actor; readonly now: string; }

export type ReviewWindow = { opens: PlainDate; referral_on: PlainDate; rule: "refer_by" | "refer_no_earlier_than" };
export type ItemResult = "pass" | "fail" | "n_a";
export interface ReviewItem { readonly item_code: string; readonly result: ItemResult; readonly evidence_ids: readonly string[]; readonly reason: string; }

const todayOf = (now: string): PlainDate => D(now.slice(0, 10));
const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? D(v.slice(0, 10)) : null);
const rowsFor = (store: ReviewStore, kind: string, loanId: string) => store.list(kind, (d) => d.loan_id === loanId);

// ---- rule 1: the window and the scheduler's due event ----------------------------------------------------------

/** Rule 1 window arithmetic: non-PR `D + 120` (window opens `D + 105`), PR `D + 121` (opens `D + 106`). */
export function windowFor(earliestUnpaidDue: PlainDate | null, principalResidence: boolean | null): ReviewWindow | null {
  return earliestUnpaidDue && principalResidence !== null ? reviewWindow(earliestUnpaidDue, principalResidence) : null;
}

/**
 * Rule 1: "A review completed before the window (e.g., day 100) is not valid for referral; it must be re-run inside
 * the window". Valid iff completed on/after the window opens and within the 15 days before the referral date
 * (E-3.2-01: "within 15 days prior to the date the servicer is required to refer"); a hold that pushes the referral
 * past `referral_required_on` moves the 15-day look-back with it (13.4-T2: re-review at expiry → refer).
 */
export function reviewValidForReferral(completedOn: PlainDate, w: ReviewWindow, referralOn: PlainDate): { valid: boolean; reason: string | null } {
  if (completedOn < w.opens) return { valid: false, reason: `review completed ${completedOn} is before the window opens ${w.opens} (referral ${w.rule === "refer_by" ? "by" : "no earlier than"} ${w.referral_on}) — re-run inside the window (E-3.2-01; FNMA_E3201_PREREFERRAL_REVIEW_15)` };
  if (completedOn > referralOn) return { valid: false, reason: `review completed ${completedOn} is after the referral date ${referralOn}` };
  if (daysBetween(completedOn, referralOn) > 15) return { valid: false, reason: `review completed ${completedOn} is more than 15 days before the referral date ${referralOn} — inputs may have changed; re-run (E-3.2-01)` };
  return { valid: true, reason: null };
}

/**
 * The scheduler's firing: `prereferral.review.due` when today is inside [opens, referral_required_on] and no due event
 * for the same `referral_required_on` was appended today (re-fired on input changes inside the window, at most once a
 * day per loan). Returns the window and the event (null outside the window).
 */
export function reviewDue(deps: ReviewDeps, i: { loan_id: string; earliest_unpaid_due: PlainDate; principal_residence: boolean; reason?: string }): { window: ReviewWindow; in_window: boolean; event: DomainEvent | null } {
  const today = todayOf(deps.now); const w = reviewWindow(i.earliest_unpaid_due, i.principal_residence);
  const inWindow = today >= w.opens && today <= w.referral_on;
  if (!inWindow) return { window: w, in_window: false, event: null };
  const already = deps.events.byLoan(i.loan_id).some((e) => e.type === "prereferral.review.due" && e.payload.referral_required_on === w.referral_on && e.occurredAt.slice(0, 10) === today);
  if (already) return { window: w, in_window: true, event: null };
  const event = deps.events.append({ type: "prereferral.review.due", loanId: i.loan_id, actor: deps.actor, payload: { referral_required_on: w.referral_on, window_opens_on: w.opens, earliest_unpaid_due_date: i.earliest_unpaid_due, principal_residence: i.principal_residence, day: daysBetween(i.earliest_unpaid_due, today), reason: i.reason ?? "window_open" } });
  return { window: w, in_window: true, event };
}

// ---- review start (preconditions) ------------------------------------------------------------------------------

export interface StartReviewInput {
  readonly loan_id: string; readonly review_id: string; readonly case_id?: string | null;
  readonly state?: string | null; readonly principal_residence?: boolean | null; readonly earliest_unpaid_due?: PlainDate | null;
  readonly breach_letter_expires_on?: PlainDate | null; readonly solicitation_respond_by?: PlainDate | null;
  readonly latest_dmdc_certificate_date?: PlainDate | null;
}
export interface StartedReview {
  readonly review_id: string; readonly started_at: string; readonly window: ReviewWindow | null; readonly in_window: boolean | null;
  readonly preconditions: { breach_letter_expired: boolean | null; solicitation_deadline_expired: boolean | null; breach_letter_expires_on: PlainDate | null; solicitation_respond_by: PlainDate | null };
  readonly items: ReviewItem[]; readonly row: Row; readonly event: DomainEvent;
}

/** The 11.x notice rows that evidence the E-3.2-01 preconditions: the breach/acceleration letter (`expires_on`) and the Borrower Solicitation Package (`respond_by`). */
function noticeDeadlines(store: ReviewStore, loanId: string): { breach: { id: string; expires_on: PlainDate } | null; solicitation: { id: string; respond_by: PlainDate } | null } {
  const notices = rowsFor(store, "notices", loanId);
  const pick = (re: RegExp, field: string) => { for (const n of [...notices].reverse()) { const code = String(n.data.template_code ?? n.data.template ?? ""); const d = dateOf(n.data[field]); if (re.test(code) && d) return { id: n.id, on: d }; } return null; };
  const b = pick(/BREACH|ACCEL/i, "expires_on"); const s = pick(/SOLICIT|BSP/i, "respond_by");
  return { breach: b ? { id: b.id, expires_on: b.on } : null, solicitation: s ? { id: s.id, respond_by: s.on } : null };
}

/**
 * Review start: opens (or re-opens) the `prereferral_reviews` attempt with its window, records the precondition items
 * where the 11.x notices (or the caller's dates) determine them, fires the scheduler's due event when inside the
 * window and appends `prereferral.review.started{state, principal_residence, window_opens_on, referral_required_on,
 * in_window, breach_letter_expired, solicitation_deadline_expired, latest_dmdc_certificate_date}`.
 */
export function startReview(deps: ReviewDeps, i: StartReviewInput): StartedReview {
  if (!i.loan_id) throw new RangeError("loan_id is required"); if (!i.review_id) throw new RangeError("review_id is required");
  const today = todayOf(deps.now); const loan = deps.store.get("loans", i.loan_id)?.data ?? {};
  const state = (i.state ?? (loan.state as string | undefined) ?? null)?.toUpperCase() ?? null;
  const pr = typeof i.principal_residence === "boolean" ? i.principal_residence : typeof loan.principal_residence === "boolean" ? loan.principal_residence : null;
  const eu = i.earliest_unpaid_due ?? dateOf(loan.earliest_unpaid_due_date) ?? dateOf(loan.earliest_unpaid_due) ?? null;
  const w = windowFor(eu, pr);
  const inWindow = w ? today >= w.opens && today <= w.referral_on : null;
  if (w && eu && pr !== null && inWindow) reviewDue(deps, { loan_id: i.loan_id, earliest_unpaid_due: eu, principal_residence: pr, reason: "review_started" });
  const nd = noticeDeadlines(deps.store, i.loan_id);
  const breachOn = i.breach_letter_expires_on ?? nd.breach?.expires_on ?? null; const solOn = i.solicitation_respond_by ?? nd.solicitation?.respond_by ?? null;
  const breachExpired = breachOn ? breachOn < today : null; const solExpired = solOn ? solOn < today : null;
  const items: ReviewItem[] = [];
  if (breachExpired !== null) items.push({ item_code: "BREACH_EXPIRED", result: breachExpired ? "pass" : "fail", evidence_ids: nd.breach ? [nd.breach.id] : [], reason: breachExpired ? `breach/acceleration letter expired ${breachOn}` : `breach/acceleration letter expires ${breachOn} — not yet expired (E-3.2-01 precondition)` });
  if (solExpired !== null) items.push({ item_code: "SOLICITATION_EXPIRED", result: solExpired ? "pass" : "fail", evidence_ids: nd.solicitation ? [nd.solicitation.id] : [], reason: solExpired ? `Borrower Solicitation Package deadline ${solOn} expired without affirmative response` : `Borrower Solicitation Package response deadline ${solOn} has not expired (E-3.2-01 precondition)` });
  const prev = deps.store.get("prereferral_reviews", i.review_id)?.data;
  const checklist = [...((prev?.checklist as Row[] | undefined) ?? []), ...items.map((it) => ({ ...it, evidence_ids: [...it.evidence_ids], evaluated_at: deps.now, evaluator: "rule" }))];
  const started_at = (prev?.started_at as string | undefined) ?? deps.now;
  const row = deps.store.put("prereferral_reviews", i.review_id, { loan_id: i.loan_id, case_id: i.case_id ?? prev?.case_id ?? null, status: "in_progress", started_at, window_opens_on: w?.opens ?? null, referral_required_on: w?.referral_on ?? null, principal_residence: pr, state, in_window: inWindow, checklist, outcome: prev?.outcome ?? null, completed_at: prev?.completed_at ?? null }, deps.actor, deps.now).data;
  const event = deps.events.append({ type: "prereferral.review.started", loanId: i.loan_id, actor: deps.actor, payload: { review_id: i.review_id, state, principal_residence: pr, window_opens_on: w?.opens ?? null, referral_required_on: w?.referral_on ?? null, in_window: inWindow, breach_letter_expired: breachExpired, solicitation_deadline_expired: solExpired, latest_dmdc_certificate_date: i.latest_dmdc_certificate_date ?? null } });
  return { review_id: i.review_id, started_at, window: w, in_window: inWindow, preconditions: { breach_letter_expired: breachExpired, solicitation_deadline_expired: solExpired, breach_letter_expires_on: breachOn, solicitation_respond_by: solOn }, items, row, event };
}

// ---- completion ------------------------------------------------------------------------------------------------

export const HOLD_OUTCOMES: readonly string[] = ["hold_lossmit", "hold_bankruptcy", "hold_scra", "hold_disaster_approval", "hold_environmental", "hold_title", "hold_litigation", "hold_occupancy_unresolved", "hold_sii"];

/**
 * Completion: `prereferral.review.completed{review_id, outcome, items, disaster_impacted, valid_for_referral,
 * completed_on, window_opens_on, referral_required_on}` (+ `prereferral.hold.opened{kind}` on any `hold_*`), and the
 * referral verdict the review itself carries — a completion outside the window is recorded but is not valid for
 * referral (rule 1; 13.4-T1).
 */
export function completeReview(deps: ReviewDeps, i: { loan_id: string; review_id: string; outcome: string; items: number; window: ReviewWindow | null; referral_on?: PlainDate | null }): { valid_for_referral: boolean | null; referral: { ok: boolean; refusal: string | null }; event: DomainEvent } {
  const completedOn = todayOf(deps.now);
  const validity = i.window ? reviewValidForReferral(completedOn, i.window, i.referral_on ?? (i.window.referral_on > completedOn ? i.window.referral_on : completedOn)) : null;
  const refer = i.outcome === "refer" || i.outcome === "refer_expedited";
  const refusal = !refer ? `review outcome ${i.outcome} — referral held` : validity && !validity.valid ? validity.reason : null;
  const event = deps.events.append({ type: "prereferral.review.completed", loanId: i.loan_id, actor: deps.actor, payload: { review_id: i.review_id, outcome: i.outcome, items: i.items, disaster_impacted: i.outcome === "hold_disaster_approval", valid_for_referral: validity?.valid ?? null, completed_on: completedOn, window_opens_on: i.window?.opens ?? null, referral_required_on: i.window?.referral_on ?? null } });
  if (HOLD_OUTCOMES.includes(i.outcome) || i.outcome === "postpone_e3204") deps.events.append({ type: "prereferral.hold.opened", loanId: i.loan_id, actor: deps.actor, causationId: event.id, payload: { review_id: i.review_id, kind: i.outcome } });
  return { valid_for_referral: validity?.valid ?? null, referral: { ok: refer && (validity?.valid ?? true), refusal }, event };
}

// ---- E-3.2-01 principal-residence prohibitions and the E-3.2-04 ladder ----------------------------------------

export interface PrFacts {
  readonly today: PlainDate; readonly principal_residence: boolean;
  readonly approved_arrangement?: boolean; readonly complete_brp_received_on?: PlainDate | null; readonly evaluation_sent_on?: PlainDate | null;
  readonly offer_sent_on?: PlainDate | null; readonly offer_response_ends_on?: PlainDate | null; readonly offer_accepted_on?: PlainDate | null; readonly performing?: boolean;
  readonly appeal_window_ends_on?: PlainDate | null;
}
/**
 * E-3.2-01: for a principal residence the servicer must not refer if (1) an approved payment arrangement exists,
 * (2) a complete BRP is inside its 30-day evaluation period, (3) an offer's response period has not expired,
 * (4) the borrower accepted and is performing, (5) an appeal right has not expired. "The servicer must not delay
 * referral to foreclosure if the time frame for the borrower to respond to an offer for a workout option has expired."
 * Non-principal residences record every item `n_a` (E-3.2-04 governs them).
 */
export function prProhibitions(f: PrFacts): { items: ReviewItem[]; failing: string[]; outcome: "hold_lossmit" | "clear" } {
  const na = (code: string): ReviewItem => ({ item_code: code, result: "n_a", evidence_ids: [], reason: "not a principal residence (E-3.2-04 governs)" });
  if (!f.principal_residence) return { items: ["PR_NO_APPROVED_ARRANGEMENT", "PR_NOT_IN_30_DAY_EVAL", "PR_NO_OPEN_OFFER_WINDOW", "PR_NOT_PERFORMING_ON_ACCEPTED_OFFER", "PR_NO_OPEN_APPEAL"].map(na), failing: [], outcome: "clear" };
  const evalEnds = f.complete_brp_received_on && !f.evaluation_sent_on ? addDays(f.complete_brp_received_on, 30) : null;
  const items: ReviewItem[] = [
    { item_code: "PR_NO_APPROVED_ARRANGEMENT", result: f.approved_arrangement ? "fail" : "pass", evidence_ids: [], reason: f.approved_arrangement ? "an approved payment arrangement for a workout option exists" : "no approved payment arrangement pending" },
    { item_code: "PR_NOT_IN_30_DAY_EVAL", result: evalEnds && f.today <= evalEnds ? "fail" : "pass", evidence_ids: [], reason: evalEnds && f.today <= evalEnds ? `complete BRP received ${f.complete_brp_received_on} — 30-day evaluation period runs to ${evalEnds}` : "not inside a 30-day complete-BRP evaluation period" },
    { item_code: "PR_NO_OPEN_OFFER_WINDOW", result: f.offer_response_ends_on && !f.offer_accepted_on && f.today <= f.offer_response_ends_on ? "fail" : "pass", evidence_ids: [], reason: f.offer_response_ends_on && !f.offer_accepted_on && f.today <= f.offer_response_ends_on ? `offer sent ${f.offer_sent_on ?? "?"} — borrower's response period open until ${f.offer_response_ends_on}` : f.offer_response_ends_on && !f.offer_accepted_on ? `offer response period expired ${f.offer_response_ends_on} without acceptance — no delay beyond expiry (E-3.2-01)` : "no open offer response window" },
    { item_code: "PR_NOT_PERFORMING_ON_ACCEPTED_OFFER", result: f.offer_accepted_on && f.performing !== false ? "fail" : "pass", evidence_ids: [], reason: f.offer_accepted_on && f.performing !== false ? `offer accepted ${f.offer_accepted_on} and the borrower is performing under its terms` : "no accepted offer being performed" },
    { item_code: "PR_NO_OPEN_APPEAL", result: f.appeal_window_ends_on && f.today <= f.appeal_window_ends_on ? "fail" : "pass", evidence_ids: [], reason: f.appeal_window_ends_on && f.today <= f.appeal_window_ends_on ? `appeal period open until ${f.appeal_window_ends_on}` : "no open appeal period" },
  ];
  const failing = items.filter((it) => it.result === "fail").map((it) => it.item_code);
  return { items, failing, outcome: failing.length ? "hold_lossmit" : "clear" };
}

/**
 * E-3.2-04 (non-principal residence): a complete BRP postpones referral (`postpone_e3204`, the ladder timers
 * FNMA_E3204_NONPR_EVAL_30 / _OFFER_14 / _FIRST_PAYMENT_EOM); "The servicer must not postpone foreclosure referral
 * due to the review of a borrower inquiry" — an inquiry never postpones (rule 2; Edge cases).
 */
export function nonPrBrpItem(f: { today: PlainDate; principal_residence: boolean; earliest_unpaid_due: PlainDate | null; complete_brp_received_on: PlainDate | null; inquiry_only?: boolean; offer_sent_on?: PlainDate | null; offer_accepted_on?: PlainDate | null; first_payment_due?: PlainDate | null; first_payment_received?: boolean; breached?: boolean }): { item: ReviewItem; ladder: ReturnType<typeof nonPrLadder> | null } {
  if (f.principal_residence) return { item: { item_code: "NONPR_BRP", result: "n_a", evidence_ids: [], reason: "principal residence — E-3.2-01 prohibitions govern" }, ladder: null };
  if (f.inquiry_only || !f.complete_brp_received_on) return { item: { item_code: "NONPR_BRP", result: "pass", evidence_ids: [], reason: f.inquiry_only ? "borrower inquiry only — never postpones referral (E-3.2-04)" : "no complete BRP received" }, ladder: null };
  if (f.breached) return { item: { item_code: "NONPR_BRP", result: "pass", evidence_ids: [], reason: "borrower breached the accepted workout — referral resumes (E-3.2-04)" }, ladder: null };
  const ladder = nonPrLadder({ earliest_unpaid_due: f.earliest_unpaid_due ?? f.complete_brp_received_on, complete_brp_on: f.complete_brp_received_on, offer_sent_on: f.offer_sent_on ?? null, accepted_on: f.offer_accepted_on ?? null, first_payment_due: f.first_payment_due ?? null, ...(f.first_payment_received !== undefined ? { first_payment_received: f.first_payment_received } : {}) });
  const expired = ladder.state === "offer_window" && ladder.held_until && f.today > ladder.held_until;
  const unpaid = ladder.state === "awaiting_first_payment" && ladder.held_until && f.today > ladder.held_until;
  if (expired || unpaid) return { item: { item_code: "NONPR_BRP", result: "pass", evidence_ids: [], reason: expired ? `retention offer expired ${ladder.held_until} without acceptance — referral resumes (E-3.2-04)` : `first payment not received by ${ladder.held_until} — referral resumes the next day (E-3.2-04)` }, ladder };
  return { item: { item_code: "NONPR_BRP", result: "fail", evidence_ids: [], reason: `complete BRP received ${f.complete_brp_received_on} — postpone referral (E-3.2-04 ladder: ${ladder.state}${ladder.held_until ? `, held until ${ladder.held_until}` : ""})` }, ladder };
}

/**
 * Ingestion of a posted workout-plan payment (2.x posting against a 12.x plan): validates the inbound record and
 * appends `workout_plan.payment.received{plan_id, due_on, received_on, amount_cents, first}` — the first payment ends
 * `FNMA_E3204_NONPR_FIRST_PAYMENT_EOM` ("first payment received → hold_performing", "held until breach").
 */
export function ingestWorkoutPlanPayment(deps: ReviewDeps, i: { loan_id: string; plan_id: string; due_on: PlainDate; received_on: PlainDate; amount_cents: bigint; first?: boolean; first_payment_due?: PlainDate | null }): { event: DomainEvent; first: boolean; on_time: boolean } {
  if (!i.loan_id) throw new RangeError("loan_id is required"); if (!i.plan_id) throw new RangeError("plan_id is required");
  if (i.amount_cents <= 0n) throw new RangeError("amount_cents must be positive");
  if (i.received_on < addDays(i.due_on, -60)) throw new RangeError(`received_on ${i.received_on} is not a payment against the ${i.due_on} instalment`);
  const prior = deps.events.byLoan(i.loan_id).filter((e) => e.type === "workout_plan.payment.received" && e.payload.plan_id === i.plan_id);
  const first = i.first ?? prior.length === 0;
  const onTime = i.received_on <= endOfMonth(i.first_payment_due ?? i.due_on);
  const event = deps.events.append({ type: "workout_plan.payment.received", loanId: i.loan_id, actor: deps.actor, payload: { plan_id: i.plan_id, due_on: i.due_on, received_on: i.received_on, amount_cents: i.amount_cents.toString(), first, on_time: onTime, sequence: prior.length + 1 } });
  return { event, first, on_time: onTime };
}

// ---- D1-3-01 disaster prior written approval ------------------------------------------------------------------

/** D1-3-01 / LL-2026-01 — the five content elements of the request to hazard_loss@fanniemae.com. */
export const DISASTER_REQUEST_CONTENT = ["recommendation", "disaster_event_date", "repair_status", "insurance_claim", "borrower_engagement"] as const;
export type DisasterRequestElement = (typeof DISASTER_REQUEST_CONTENT)[number];
export interface DisasterRequest {
  /** "to initiate or continue foreclosure proceedings" (and the referral date if applicable). */
  readonly recommendation: string; readonly referral_date?: PlainDate | null;
  readonly disaster_event_date: PlainDate;
  /** "status of any repairs to the property". */
  readonly repair_status: string;
  /** "Insurance loss claim date, status, and the amount of proceeds". */
  readonly insurance_claim: { readonly claim_date: PlainDate | null; readonly status: string; readonly proceeds_cents: bigint };
  /** "summary of any engagement with the borrower, including whether QRPC has been achieved" and the borrower's intent for the property. */
  readonly borrower_engagement: { readonly summary: string; readonly qrpc_achieved: boolean; readonly borrower_intent: string; readonly d2202_cadence_met?: boolean };
}
const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
/** Which of the five elements a (possibly partial) request carries. */
export function disasterRequestElements(r: Row | null): { present: DisasterRequestElement[]; missing: DisasterRequestElement[] } {
  const ok: DisasterRequestElement[] = [];
  for (const e of DISASTER_REQUEST_CONTENT) {
    const v = r?.[e];
    if (!present(v)) continue;
    if (e === "insurance_claim") { const c = v as Row; if (!present(c.status) || !present(c.proceeds_cents) || !("claim_date" in c)) continue; }
    if (e === "borrower_engagement") { const c = v as Row; if (!present(c.summary) || typeof c.qrpc_achieved !== "boolean" || !present(c.borrower_intent)) continue; }
    ok.push(e);
  }
  return { present: ok, missing: DISASTER_REQUEST_CONTENT.filter((e) => !ok.includes(e)) };
}

/**
 * The prior-written-approval request (D1-3-01: within five days after completing the prereferral review, or after
 * determining the impact on a loan already referred). Refuses an incomplete request (RangeError names the missing
 * elements); stores the `disaster_fc_approval_requests` row (channel email:hazard_loss, tracked message id) and appends
 * `disaster_fc_approval.requested` and `disaster_fc_approval_requests.submitted{request_id, kind, submitted_at, …}`.
 */
export function submitDisasterFcRequest(deps: ReviewDeps, i: { loan_id: string; request_id?: string | null; case_id?: string | null; review_id?: string | null; kind: "initiate" | "continue"; request: DisasterRequest | Row; message_id?: string | null; decision_id?: string | null }): { request_id: string; row: Row; due_by: PlainDate | null; event: DomainEvent } {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (i.kind !== "initiate" && i.kind !== "continue") throw new RangeError("kind must be initiate or continue (D1-3-01)");
  const els = disasterRequestElements(i.request as Row);
  if (els.missing.length) throw new RangeError(`disaster approval request is missing ${els.missing.join(", ")} (D1-3-01: recommendation, disaster event date, repair status, insurance claim date/status/proceeds, borrower engagement incl. QRPC and intent)`);
  const r = i.request as DisasterRequest;
  const requestId = i.request_id || `dfr-${i.loan_id}-${deps.now}`;
  const completed = i.review_id ? dateOf(deps.store.get("prereferral_reviews", i.review_id)?.data.completed_at) : null;
  const payload = { recommendation: r.recommendation, referral_date: r.referral_date ?? null, disaster_event_date: r.disaster_event_date, repair_status: r.repair_status, insurance_claim: { claim_date: r.insurance_claim.claim_date, status: r.insurance_claim.status, proceeds_cents: BigInt(r.insurance_claim.proceeds_cents).toString() }, borrower_engagement: { summary: r.borrower_engagement.summary, qrpc_achieved: r.borrower_engagement.qrpc_achieved, borrower_intent: r.borrower_engagement.borrower_intent, d2202_cadence_met: r.borrower_engagement.d2202_cadence_met ?? null } };
  const row = deps.store.put("disaster_fc_approval_requests", requestId, { loan_id: i.loan_id, case_id: i.case_id ?? null, review_id: i.review_id ?? null, kind: i.kind, submitted_at: deps.now, channel: "email:hazard_loss", to: "hazard_loss@fanniemae.com", message_id: i.message_id ?? null, payload, fnma_response: "pending", responded_at: null, response_document_id: null, decision_id: i.decision_id ?? null }, deps.actor, deps.now).data;
  deps.events.append({ type: "disaster_fc_approval.requested", loanId: i.loan_id, actor: deps.actor, payload: { request_id: requestId, kind: i.kind, recommendation: r.recommendation, elements: els.present } });
  const event = deps.events.append({ type: "disaster_fc_approval_requests.submitted", loanId: i.loan_id, actor: deps.actor, payload: { request_id: requestId, kind: i.kind, submitted_at: deps.now, channel: "email:hazard_loss", message_id: i.message_id ?? null, review_id: i.review_id ?? null, elements: els.present } });
  return { request_id: requestId, row, due_by: completed ? addDays(completed, 5) : null, event };
}

export type FnmaDisasterResponse = "approved" | "denied" | "info_requested";
/**
 * Fannie Mae's reply from the hazard_loss@ mailbox (parsed; human-confirmed if ambiguous): the row's `fnma_response`,
 * `fnma.disaster_fc.responded{request_id, response}` (ends `SM_DISASTER_FC_RESPONSE_FOLLOWUP_10BD`) and
 * `disaster_fc_approval.approved|denied|info_requested`; an approval also appends `fnma.disaster_fc.approved` (the
 * 13.1 gate) and releases the `hold_disaster_approval` hold. A denial the partner wishes to contest is the officer's call.
 */
export function recordDisasterFcResponse(deps: ReviewDeps, i: { loan_id: string; request_id: string; response: FnmaDisasterResponse; response_document_id?: string | null; responded_at?: string | null; note?: string | null }): { row: Row; approval_id: string | null; hold_released: boolean; escalate: "officer" | null; event: DomainEvent } {
  if (!i.loan_id) throw new RangeError("loan_id is required"); if (!i.request_id) throw new RangeError("request_id is required");
  if (!["approved", "denied", "info_requested"].includes(i.response)) throw new RangeError("response must be approved, denied or info_requested (13.4 data model fnma_response)");
  const prev = deps.store.get("disaster_fc_approval_requests", i.request_id); if (!prev || prev.data.loan_id !== i.loan_id) throw new RangeError(`no disaster_fc_approval_requests ${i.request_id} for ${i.loan_id}`);
  if (!prev.data.submitted_at) throw new RangeError(`request ${i.request_id} was never submitted`);
  const respondedAt = i.responded_at ?? deps.now; const approvalId = i.response === "approved" ? `fnma-dfa-${i.request_id}` : null;
  const row = deps.store.put("disaster_fc_approval_requests", i.request_id, { fnma_response: i.response, responded_at: respondedAt, response_document_id: i.response_document_id ?? null, ...(approvalId ? { fnma_approval_id: approvalId } : {}), ...(i.note ? { response_note: i.note } : {}) }, deps.actor, deps.now).data;
  const event = deps.events.append({ type: "fnma.disaster_fc.responded", loanId: i.loan_id, actor: deps.actor, payload: { request_id: i.request_id, response: i.response, responded_at: respondedAt, response_document_id: i.response_document_id ?? null } });
  deps.events.append({ type: `disaster_fc_approval.${i.response}`, loanId: i.loan_id, actor: deps.actor, causationId: event.id, payload: { request_id: i.request_id, response_document_id: i.response_document_id ?? null } });
  if (approvalId) {
    deps.events.append({ type: "fnma.disaster_fc.approved", loanId: i.loan_id, actor: deps.actor, causationId: event.id, payload: { request_id: i.request_id, fnma_disaster_fc_approval_id: approvalId, kind: prev.data.kind } });
    deps.events.append({ type: "prereferral.hold.released", loanId: i.loan_id, actor: deps.actor, causationId: event.id, payload: { kind: "hold_disaster_approval", request_id: i.request_id } });
  }
  return { row, approval_id: approvalId, hold_released: Boolean(approvalId), escalate: i.response === "denied" ? "officer" : null, event };
}

// ---- E-1.1-02 mortgagee of record (TITLE_MORTGAGEE_OF_RECORD) --------------------------------------------------

/**
 * The title review's finding that the mortgagee of record is identified (E-1.1-02: by delinquency day 90; the 13.4
 * `TITLE_MORTGAGEE_OF_RECORD` item). Validates the finding and appends
 * `foreclosure.prep.mortgagee_of_record.identified{title_order_id, mortgagee_of_record, identified_on, evidence_document_id}`.
 */
export function recordMortgageeOfRecord(deps: ReviewDeps, i: { loan_id: string; title_order_id?: string | null; mortgagee_of_record: string; identified_on: PlainDate; evidence_document_id: string; assignment_needed?: boolean }): { title_order_id: string; row: Row; event: DomainEvent } {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (!i.mortgagee_of_record) throw new RangeError("mortgagee_of_record is required");
  if (!i.evidence_document_id) throw new RangeError("evidence_document_id (title report) is required — an item may be pass only with attached evidence");
  if (i.identified_on > todayOf(deps.now)) throw new RangeError(`identified_on ${i.identified_on} is in the future`);
  const id = i.title_order_id || `title-${i.loan_id}`;
  const prev = deps.store.get("title_orders", id)?.data ?? {};
  const row = deps.store.put("title_orders", id, { ...prev, loan_id: i.loan_id, mortgagee_of_record: i.mortgagee_of_record, mortgagee_of_record_identified_on: i.identified_on, mortgagee_of_record_document_id: i.evidence_document_id, assignment_needed: i.assignment_needed ?? prev.assignment_needed ?? null }, deps.actor, deps.now).data;
  const event = deps.events.append({ type: "foreclosure.prep.mortgagee_of_record.identified", loanId: i.loan_id, actor: deps.actor, payload: { title_order_id: id, mortgagee_of_record: i.mortgagee_of_record, identified_on: i.identified_on, evidence_document_id: i.evidence_document_id, assignment_needed: i.assignment_needed ?? null } });
  return { title_order_id: id, row, event };
}
