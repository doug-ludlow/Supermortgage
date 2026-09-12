// The daily refinance check (src/runtime/refi-daily.ts) as the sweep runs it, on its own database: the worked-example
// loan of 20.1 boarded on the servicing book (src/runtime/borrower/fixtures/refi-book.ts), a FixedClock advanced to the
// next 06:30 ET, `Runtime.sweep()` — the FAKE rate feed's sheet published for the day through 20.4, the universe from
// `v_refi_universe`, `20.1 emitOfferReady{op=run}` → `refi.trigger.run_completed`, SM_REFI_TRIGGER_DAILY satisfied (never
// breached) and re-armed for the next 06:30, the loan's opportunity `offer_ready` at the worked example's 6.125 % / $3,402.62,
// a second sweep the same day idempotent, the 32.11 flow's review request and — after 20.2's touch and the MLO of record's
// approval — the OfferCard on the borrower's thread, and the next day's sweep satisfying the re-armed clock again.
// Skips without Postgres (not a spec unit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reachable } from "../infra/db/client.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { FakeRateFeed } from "../infra/integrations/rates.ts";
import { REFI_OFFER_SAMPLE } from "../notices/authored/section20-2.ts";
import { OFFICER, MLO, EDT, MST } from "./borrower/fixtures/journey.ts";
import { openRefiBook, type RefiBook } from "./borrower/fixtures/refi-book.ts";
import { sheetIdFor, runIdFor } from "./refi-daily.ts";

const DB_URL = process.env["REFI_DAILY_TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_refi_daily";
const up = await reachable((() => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })());   // the fixture creates the named database
const skip = up ? false : `no Postgres at ${DB_URL}`;
type P = Record<string, unknown>;
const clock = new FixedClock("2026-09-30T16:00:00.000Z");
const feed = new FakeRateFeed();
let book: RefiBook;
test.before(async () => { if (!skip) book = await openRefiBook({ dbUrl: DB_URL, clock, rateFeed: feed }); });
test.after(async () => { if (!skip) await book.close(); });

const DAILY = "SM_REFI_TRIGGER_DAILY";
/** The run's own receipt is a global event (the sheet aggregate, no loan). */
const runsCompleted = () => book.db.query<{ payload: P }>(`SELECT payload FROM loan_events WHERE type = 'refi.trigger.run_completed' ORDER BY sequence`);
const counts = (rows: { status: string }[]): Record<string, number> => rows.reduce<Record<string, number>>((a, t) => ({ ...a, [t.status]: (a[t.status] ?? 0) + 1 }), {});

test("before 06:30 ET the sweep runs no daily check; at 06:30 ET it publishes the day's sheet, runs the trigger per program, satisfies SM_REFI_TRIGGER_DAILY and finds the worked-example offer", { skip }, async () => {
  const { runtime, loanId, programId, partnerPartyId } = book;
  // 06:29 EDT Thu Oct 1, 2026: not yet
  clock.set(EDT("2026-10-01", "06:29"));
  const early = await runtime.sweep();
  assert.ok(early.refi, "a runtime with a rate feed reports the daily check"); assert.equal(early.refi!.ran, false); assert.match(String(early.refi!.reason), /before 06:30 ET/);
  assert.equal((await runsCompleted()).length, 0);
  // 06:30 EDT: the day's run
  clock.set(EDT("2026-10-01", "06:30"));
  const sweep = await runtime.sweep();
  const r = sweep.refi!; assert.equal(r.ran, true, JSON.stringify(r));
  assert.deepEqual(r.rate_sheet, { rate_sheet_id: sheetIdFor("2026-10-01" as never, "FAKE"), published: true, source: "pe_whole_loan_api", price_count: 9 });
  assert.equal(r.universe.view_rows, 1); assert.equal(r.universe.loaded, 1, "the servicing facts re-derived from the view differ from the row on record (no payment made yet there) → loaded through 20.1 loadUniverse{load_row}"); assert.deepEqual(r.universe.skipped, []);
  assert.equal(r.programs.length, 1); const p = r.programs[0]!;
  assert.equal(p.program_id, programId); assert.equal(p.partner_id, partnerPartyId); assert.equal(p.run_id, runIdFor("2026-10-01" as never, programId)); assert.equal(p.error, null);
  assert.equal(p.loans, 1); assert.equal(p.loans_in_universe, 1); assert.equal(p.loans_evaluated, 1); assert.equal(p.opportunities_detected, 1); assert.deepEqual(p.suppressed_by_reason, {}); assert.equal(p.decisions, 1);
  assert.match(r.line, /^refi daily 2026-10-01: sheet=rs-2026-10-01-FAKE \(published\) programs=1 view_rows=1 loaded=1 unchanged=0 skipped=0 universe=1 evaluated=1 offers=1 suppressed=\{\}$/);
  // the sheet: 20.4's own `rate_sheet.published` (global), superseding the demo seed's; the run: `refi.trigger.run_completed` on the sheet
  const published = await book.db.query<{ payload: P }>(`SELECT payload FROM loan_events WHERE type = 'rate_sheet.published' AND payload->>'rate_sheet_id' = $1`, [r.rate_sheet!.rate_sheet_id]);
  assert.equal(published.length, 1); assert.equal(published[0]!.payload["published_on"], "2026-10-01"); assert.equal(published[0]!.payload["partner_id"], partnerPartyId);
  const done = await book.db.query<{ payload: P; actor_id: string }>(`SELECT payload, actor_id FROM loan_events WHERE type = 'refi.trigger.run_completed' ORDER BY sequence`);
  assert.equal(done.length, 1); assert.equal(done[0]!.payload["as_of_date"], "2026-10-01"); assert.equal(done[0]!.payload["program_id"], programId); assert.equal(done[0]!.payload["rate_sheet_id"], r.rate_sheet!.rate_sheet_id); assert.equal(done[0]!.payload["loans_in_universe"], 1); assert.equal(done[0]!.actor_id, "intake");
  // SM_REFI_TRIGGER_DAILY: the day's clock (global subject) satisfied by the run, re-armed for Fri Oct 2 06:30 ET — never breached
  const timers = await book.timers(DAILY);
  assert.deepEqual(counts(timers), { satisfied: 1, armed: 1 }, JSON.stringify(timers));
  assert.ok(timers.every((t) => t.subject_kind === "global"), "the day's clock, not the sheet's");
  assert.equal(new Date(timers.find((t) => t.status === "armed")!.due_at!).toISOString(), EDT("2026-10-02", "06:30"));
  assert.equal(sweep.breaches.filter((b) => b.code === DAILY).length, 0);
  // the worked example (20.1 worked example 1 / T1): 6.125 %, $3,402.62, 87.5 bps, offer_ready — from the view's row, not a fixture's
  const oppId = p.offer_ready[0]!; assert.equal(oppId, `opp-${loanId}-2026-10-01-${programId}`);
  const opp = (await book.entity("refi_opportunities", oppId))!; assert.equal(opp["status"], "offer_ready"); assert.equal(opp["trigger_kind"], "scheduled"); assert.equal(opp["run_id"], p.run_id);
  const cand = opp["candidate_terms"] as P; assert.equal(cand["note_rate"], "0.06125"); assert.equal(String(cand["pi_cents"]), "340262"); assert.equal(String(cand["loan_amount_cents"]), "56000000"); assert.equal(cand["ltv"], "0.7000");
  const ex = opp["existing_terms"] as P; assert.equal(ex["note_rate"], "0.07000"); assert.equal(String(ex["upb_cents"]), "55310641", "scheduled UPB after 24 payments, from the view + the amortization arithmetic"); assert.equal(ex["remaining_term_months"], 336);
  const m = opp["benefit_metrics"] as P; assert.equal(m["rate_delta_bps"], 87.5); assert.equal(String(m["pi_delta_cents"]), "35634"); assert.equal(String(m["npv_cents"]), "2429278");
  const ready = await book.loanEvents("refi.opportunity.offer_ready"); assert.equal(ready.length, 1); assert.equal(ready[0]!.payload["opportunity_id"], oppId); assert.equal(ready[0]!.payload["path"], "proactive");
  // the decision row (20.1 writeDecision): rule_ref "20.1 rules 1–9", the intake agent
  const dec = await book.db.query<{ agent: string; action: string; rule_code: string; subject_id: string }>(`SELECT agent, action, rule_code, subject_id FROM agent_decisions WHERE loan_id = $1 AND action = 'refi.opportunity.fire'`, [loanId]);
  assert.equal(dec.length, 1); assert.equal(dec[0]!.agent, "intake"); assert.equal(dec[0]!.rule_code, "20.1 rules 1–9"); assert.equal(dec[0]!.subject_id, oppId);
  // the universe row the run wrote is the view's (investor-blind; the vendor facts kept)
  const row = (await book.entity("refi_universe", loanId))!; assert.equal(row["payments_made"], 24); assert.equal(row["next_due_date"], "2026-11-01"); assert.equal(String(row["upb_cents"]), "55310641"); assert.equal(String((row["value_estimate"] as P)["value_cents"]), "80000000"); assert.equal(row["representative_score"], 765);
  assert.ok(!("investor_id" in row) && !("fnma_loan_number" in row) && !("remittance_type" in row));
  // the daily log line
  const logged = book.lines.find((l) => l.includes('"message":"refi daily run"')); assert.ok(logged, "the one-line report is logged"); assert.ok(logged!.includes(r.line));
  // 32.11 reacted: the MLO of record's review of the offer's terms is requested; the borrower sees the pending status, no rate yet
  await book.settle();
  const req = await book.loanEvents("terms.presentation.requested"); assert.equal(req.length, 1); assert.equal(req[0]!.payload["quote_id"], `Q-OFFER-${oppId}`);
  const cards = await book.cards(book.partyId);
  assert.ok(cards.some((c) => c.copy_key === "terms.pending_mlo" && c.props["opportunity_id"] === oppId), JSON.stringify(cards.map((c) => c.copy_key)));
  assert.equal(cards.filter((c) => c.kind === "OfferCard").length, 0, "no OfferCard before 20.2's touch and the MLO's approval");
});

test("a second sweep the same day is idempotent: no second sheet, no second run, the clock still satisfied; a later publish the same day leaves the day's clock alone", { skip }, async () => {
  const { runtime } = book;
  clock.set(EDT("2026-10-01", "06:31"));
  const again = await runtime.sweep();
  assert.equal(again.refi!.ran, false); assert.equal(again.refi!.reason, "already ran today");
  assert.equal((await runsCompleted()).length, 1);
  const sheets = await book.db.query<{ id: string }>(`SELECT payload->>'rate_sheet_id' AS id FROM loan_events WHERE type = 'rate_sheet.published' ORDER BY sequence`);
  assert.deepEqual(sheets.map((x) => x.id).filter((id) => id.startsWith("rs-2026-10-01-")), ["rs-2026-10-01-FAKE"], JSON.stringify(sheets));
  assert.equal(feed.calls.length, 1, "the feed is read once a day");
  assert.deepEqual(counts(await book.timers(DAILY)), { satisfied: 1, armed: 1 });
  // an intra-day republish (20.4: a ≥ 12.5 bps move) arms nothing new: the day's clock is one instance
  clock.set(EDT("2026-10-01", "11:00"));
  await runtime.execute({ process: "20.4", name: "publishRateSheet", loanId: "", actor: { kind: "agent", id: "pricing" }, input: { rate_sheet_id: "rs-2026-10-01-intraday", partner_id: book.partnerPartyId, source: "pe_whole_loan_api", published_at: clock.now(), expires_at: EDT("2026-10-02", "07:00"), prices: await feed.fetchPrices(clock.now()) } });
  assert.deepEqual(counts(await book.timers(DAILY)), { satisfied: 1, armed: 1 });
});

test("20.2's touch makes the opportunity offered; the MLO of record approves the terms; the 32.11 flow raises the OfferCard on the borrower's thread", { skip }, async () => {
  const { journey: j, loanId, programId, partnerPartyId } = book; const scope = { loan: loanId };
  const oppId = `opp-${loanId}-2026-10-01-${programId}`; const R = loanId.slice(0, 8);
  const CAMPAIGN = `camp-refi-${R}`, CREATIVE = `cr-email-${R}`;
  const PARTNER = "[Partner]";
  const EMAIL_TEXT = `${PARTNER}, NMLSR ID 123456, is your current lender; Supermortgage services your loan for ${PARTNER}. Your current rate 7.000% → offered rate 6.125% (6.155% annual percentage rate (APR)); 360 monthly principal-and-interest payments of $3,402.62; fixed rate for the full term — the annual percentage rate will not increase. Payments do not include amounts for taxes and insurance premiums, and your actual payment obligation will be greater. No lender fees and no third-party closing costs charged to you; those costs are paid by Supermortgage and reflected in the rate offered. This is not a commitment to lend. Rates change daily. This is an advertisement from ${PARTNER}; unsubscribe: https://portal.example.com/u; ${PARTNER}, 100 Example Way, Anytown, AZ 85000.`;
  clock.set(EDT("2026-10-01", "12:00"));
  await j.tool(scope, "20.2", "planChannels", { op: "create_campaign", campaign_id: CAMPAIGN, partner_id: partnerPartyId, program_id: programId, kind: "refi_trigger_outbound", channels: ["email"], selection_rule_set: "sm.refi_trigger.v1", creative_ids: [CREATIVE] });
  await j.tool(scope, "20.2", "renderCreative", { creative_id: CREATIVE, campaign_id: CAMPAIGN, channel: "email", template: EMAIL_TEXT, variables: {}, variables_schema: ["borrower_name", "offered_rate_pct"], rate_sheet_id: "rs-2026-10-01-intraday" });
  await j.tool(scope, "20.2", "renderCreative", { op: "approve", creative_id: CREATIVE, campaign_kind: "refi_trigger_outbound", sheet_rates_pct: ["6.125", "6.250", "6.000"], optout_offer_seconds: 2 }, OFFICER);
  clock.set(EDT("2026-10-01", "12:30")); await j.tool(scope, "20.2", "planChannels", { op: "approve_campaign", campaign_id: CAMPAIGN }, OFFICER);
  clock.set(EDT("2026-10-01", "13:00")); await j.tool(scope, "20.2", "planChannels", { op: "launch", campaign_id: CAMPAIGN }, OFFICER);
  // the e-mail touch (20.2 worked example 1's channel plan) the same afternoon → `offered`; the MLO's review follows within the quote's validity (SM_MLO_PREAPP_TERMS_REVIEW_1BH is one business hour)
  clock.set(MST("2026-10-01", "14:00"));
  const SCRUB = { scrub_id: `scrub-${R}`, source: "ftc_registry", registry_version_obtained_at: EDT("2026-09-28", "06:00"), obtained_on: "2026-09-28", valid_until: "2026-10-29", numbers_checked: 12_000, hits: 340, file_hash: "sha256:0928" };
  await j.tool(scope, "20.2", "scheduleTouch", { op: "complete_scrub", scrub_id: SCRUB.scrub_id, obtained_at: SCRUB.registry_version_obtained_at, numbers_checked: SCRUB.numbers_checked, hits: SCRUB.hits, file_hash: SCRUB.file_hash });
  const consent = { consent_id: `c-info-${R}`, party_id: "B1", loan_id: loanId, kind: "tcpa_voice", purpose: "informational", phone_number: "+16025550142", status: "active", written_consent: false, pewc_elements: null, signature_kind: null, disclosure_version: null, disclosure_text_hash: null, captured_at: EDT("2025-10-14", "10:00"), written_confirmation_due_at: null, national_dnc_written_permission: false, evidence: { captured_via: "portal_enrollment" } };
  const facts = { touch: { touch_id: `t-email-${R}`, campaign_id: CAMPAIGN, campaign_kind: "refi_trigger_outbound", creative_id: CREATIVE, channel: "email", party_id: "B1", loan_id: loanId, opportunity_id: oppId, destination: "borrower@example.com", destination_id: "email-1", line_type: null, queued_at: MST("2026-10-01", "14:00"), time_zones: ["America/Phoenix"], state: "AZ" },
    partner_name: PARTNER, consents: [consent], scrubs: [SCRUB], suppressions: [], on_national_registry: false, ebr: { last_transaction_on: "2026-10-01" }, rate_sheet_current: true };
  const sched = await j.tool(scope, "20.2", "scheduleTouch", { facts }); assert.equal(sched.output["outcome"], "scheduled", JSON.stringify(sched.output).slice(0, 300));
  await j.tool(scope, "20.2", "scheduleTouch", { op: "send", touch_id: sched.output["touch_id"], payload: { ...REFI_OFFER_SAMPLE, pi_cents: "340262", account_last4: "0001" }, recipient: { name: "Alex Borrower", mailing_address: "100 N Central Ave, Phoenix, AZ 85004", email: "borrower@example.com" } });
  await j.tool(scope, "20.1", "emitOfferReady", { op: "offered", opportunity_id: oppId });
  await book.settle();
  assert.equal((await book.entity("refi_opportunities", oppId))!["status"], "offered");
  assert.equal((await book.timers("SM_REFI_OFFER_SLA_2BD")).at(-1)!.status, "satisfied", "20.2's marketing.touch.sent satisfies the 2-BD SLA");
  // the MLO of record's review (20.3 requestQuote{review}: the mlo_of_record's act) on the inquiry lead / quote the flow opened → terms.presented → the OfferCard
  clock.set(MST("2026-10-01", "14:20"));
  const review = await j.tool(scope, "20.3", "requestQuote", { op: "review", lead_id: `L-offer-${oppId}`, quote_id: `Q-OFFER-${oppId}`, review_id: `MR-${R}`, outcome: "approved" }, MLO);
  assert.ok(review.events.some((e) => e.type === "mlo.review.completed" && e.payload["outcome"] === "approved"));
  await book.settle();
  assert.ok((await book.loanEvents("terms.presented")).some((e) => e.payload["quote_id"] === `Q-OFFER-${oppId}`));
  const card = (await book.cards(book.partyId)).find((c) => c.kind === "OfferCard" && c.props["refi_opportunity_id"] === oppId);
  assert.ok(card, "the OfferCard for the daily run's offer"); assert.equal(card!.status, "pending"); assert.equal(card!.props["path"], "proactive"); assert.equal(card!.command_ref, "offer.respond"); assert.equal(card!.created_by, "agent:borrower-comms");
  assert.equal(card!.props["offered_rate"], "6.125"); assert.equal(card!.props["current_rate"], "7.000"); assert.equal(card!.props["new_pi_payment_cents"], "340262"); assert.equal(card!.props["mlo_attribution"], "A. Lee (FAKE demo MLO), NMLSR ID 222333", "the MLO of record from the demo seed's roster (32.14 entry-seed), whose review approved the terms");
});

test("the next morning's sweep publishes the next sheet and the run satisfies the re-armed clock again — nothing about SM_REFI_TRIGGER_DAILY ever breaches", { skip }, async () => {
  const { runtime } = book;
  clock.set(EDT("2026-10-02", "06:30"));
  const sweep = await runtime.sweep();
  assert.equal(sweep.refi!.ran, true, JSON.stringify(sweep.refi)); assert.equal(sweep.refi!.rate_sheet!.rate_sheet_id, "rs-2026-10-02-FAKE"); assert.equal(sweep.refi!.rate_sheet!.published, true);
  assert.equal(sweep.refi!.programs[0]!.error, null); assert.equal(sweep.refi!.programs[0]!.loans_evaluated, 1);
  assert.equal(sweep.breaches.filter((b) => b.code === "SM_REFI_TRIGGER_DAILY").length, 0);
  const timers = await book.timers("SM_REFI_TRIGGER_DAILY");
  assert.deepEqual(counts(timers), { satisfied: 2, armed: 1 }, JSON.stringify(timers));
  assert.equal(new Date(timers.find((t) => t.status === "armed")!.due_at!).toISOString(), EDT("2026-10-03", "06:30"));
  assert.equal((await runsCompleted()).length, 2);
  assert.equal((await book.db.query(`SELECT 1 FROM escalations WHERE payload->>'timer_code' = 'SM_REFI_TRIGGER_DAILY'`)).length, 0, "no sev-3 breach escalation");
});
