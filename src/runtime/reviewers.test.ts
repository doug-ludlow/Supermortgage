// DELTA-30 — the FAKE reviewers (src/infra/integrations/reviewers.ts) on their own database: the worked-example loan on
// the book (src/runtime/borrower/fixtures/refi-book.ts), the borrower asks "can I refinance?" (20.1's request path →
// `offer_ready`), the 32.11 flow asks the MLO of record to review the terms (SM_MLO_PREAPP_TERMS_REVIEW_1BH armed, the
// `terms.pending_mlo` StatusCard), and the sweep's FAKE reviewer approves it through `20.3 requestQuote{op=review}` as
// `human:FAKE:mlo_of_record` once the delay has passed — the journey continues (`terms.presented`, the OfferCard). A transfer
// to a person (4.3 human.transfer) is joined by `FAKE:human_agent` (the PersonCard). With FAKE_REVIEWERS=off nothing happens.
// Skips without Postgres (not a spec unit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reachable } from "../infra/db/client.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { FakeReviewers, fakeReviewersFromEnv, fakeReviewerRolesFromEnv, FAKE_REVIEWER_ROLES, FAKE_HUMAN_AGENT_NAME } from "../infra/integrations/reviewers.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { Runtime } from "./app.ts";
import { PgConsoleStore } from "../console/pg-store.ts";
import { MST } from "./borrower/fixtures/journey.ts";
import { openRefiBook, type RefiBook } from "./borrower/fixtures/refi-book.ts";

const DB_URL = process.env["FAKE_REVIEWERS_TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_fake_reviewers";
const up = await reachable((() => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })());   // the fixture creates the named database
const skip = up ? false : `no Postgres at ${DB_URL}`;
type P = Record<string, unknown>;
const clock = new FixedClock("2026-09-30T16:00:00.000Z");
const DELAY_S = 20;
const reviewers = new FakeReviewers({ delaySeconds: DELAY_S });
let book: RefiBook;
test.before(async () => { if (!skip) book = await openRefiBook({ dbUrl: DB_URL, clock, reviewers, currentFacts: true }); });
test.after(async () => { if (!skip) await book.close(); });

const plus = (iso: string, seconds: number): string => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const events = (type: string) => book.db.query<{ actor_kind: string; actor_id: string; actor_role: string | null; payload: P; occurred_at: string }>(`SELECT actor_kind, actor_id, actor_role, payload, occurred_at FROM loan_events WHERE type = $1 ORDER BY sequence`, [type]);

test("the environment switch: FAKE_REVIEWERS=off yields no reviewers; the default fills every role after 20 s; the delay is configurable", () => {
  assert.equal(fakeReviewersFromEnv({ INTEGRATIONS: "fake", FAKE_REVIEWERS: "off" }), null);
  assert.deepEqual(fakeReviewerRolesFromEnv({ FAKE_REVIEWERS: "off" }), []);
  const on = fakeReviewersFromEnv({})!; assert.ok(on); assert.equal(on.delaySeconds, 20); assert.deepEqual([...on.roles], [...FAKE_REVIEWER_ROLES]);
  assert.equal(fakeReviewersFromEnv({ FAKE_REVIEWER_DELAY_S: "5" })!.delaySeconds, 5);
  assert.deepEqual(on.actor("mlo_of_record"), { kind: "human", id: "FAKE:mlo_of_record", role: "mlo_of_record" });
});

test("the MLO terms review: the borrower's refinance request reaches the MLO of record; the FAKE reviewer approves it after the delay, as human:FAKE:mlo_of_record, and the journey continues to the presented terms and the OfferCard", { skip }, async () => {
  const { runtime, loanId, programId, partyId } = book;
  // Thu Oct 1, 2026 09:00 MST: "can I refinance?" — 20.1's request path (no solicitation gates) → offer_ready on the borrower_request path
  clock.set(MST("2026-10-01", "09:00"));
  const asked = await runtime.execute({ process: "20.1", name: "emitOfferReady", loanId, actor: { kind: "agent", id: "intake" }, input: { op: "request", loan_id: loanId, program_id: programId, free_text: "Can I refinance? What would a refinance look like?" } });
  const opp = (asked.output as { opportunity_id: string; status: string }); assert.equal(opp.status, "offer_ready", JSON.stringify(asked.output).slice(0, 300));
  await book.settle();
  // 32.11: the terms are with the MLO of record first — the review clock is armed, the borrower sees the pending status and no rate
  const req = (await events("terms.presentation.requested")).filter((e) => e.payload["quote_id"] === `Q-OFFER-${opp.opportunity_id}`); assert.equal(req.length, 1);
  const armed = (await book.timers("SM_MLO_PREAPP_TERMS_REVIEW_1BH")).at(-1)!; assert.equal(armed.status, "armed"); assert.deepEqual({ kind: armed.subject_kind, id: armed.subject_id }, { kind: "loan", id: loanId }, "the review clock on the loan the request ran under");
  assert.ok((await book.cards(partyId)).some((c) => c.copy_key === "terms.pending_mlo" && c.props["opportunity_id"] === opp.opportunity_id));
  assert.equal((await book.cards(partyId)).filter((c) => c.kind === "OfferCard").length, 0);
  const requestedAt = clock.now();
  // 10 s later: the sweep runs the reviewers — nothing is old enough
  clock.set(plus(requestedAt, 10));
  const early = await runtime.sweep();
  assert.ok(early.reviewers); assert.equal(early.reviewers!.pending, 0); assert.equal(early.reviewers!.delay_s, DELAY_S);
  assert.equal((await events("mlo.review.completed")).length, 0);
  // with FAKE_REVIEWERS=off a runtime over the same book leaves the queue to a person, however long it waits
  clock.set(plus(requestedAt, 3600));
  const off = new Runtime({ db: book.db, registry: loadOverriddenRegistry(), clock, reviewers: fakeReviewersFromEnv({ FAKE_REVIEWERS: "off" }) });
  const offSweep = await off.sweep(); assert.equal(offSweep.reviewers, null);
  assert.equal((await events("mlo.review.completed")).length, 0, "FAKE_REVIEWERS=off: nothing is approved");
  assert.equal((await book.timers("SM_MLO_PREAPP_TERMS_REVIEW_1BH")).at(-1)!.status, "breached", "one business hour has passed: the review clock breached, still unfilled — a person's queue");
  // 25 s after the request (the clock back where the FAKE runtime looks): the FAKE reviewer approves through 20.3's own tool
  clock.set(plus(requestedAt, 25));
  const sweep = await runtime.sweep();
  const rep = sweep.reviewers!; assert.equal(rep.pending, 1, JSON.stringify(rep)); assert.equal(rep.actions.length, 1);
  assert.deepEqual({ ...rep.actions[0]!, detail: undefined }, { kind: "terms_review", role: "mlo_of_record", ref: `Q-OFFER-${opp.opportunity_id}`, tool: "20.3 requestQuote{op=review}", scope: { loan_id: loanId, application_id: null }, outcome: "approved", detail: undefined });
  assert.match(rep.line, /^FAKE reviewers .*: pending=1 approved=1 left_open=0 failed=0 delay_s=20 \[terms_review:Q-OFFER-/);
  const done = await events("mlo.review.completed"); assert.equal(done.length, 1);
  assert.equal(done[0]!.actor_kind, "human"); assert.equal(done[0]!.actor_id, "FAKE:mlo_of_record"); assert.equal(done[0]!.actor_role, "mlo_of_record");
  assert.equal(done[0]!.payload["outcome"], "approved"); assert.equal(done[0]!.payload["review_id"], `FAKE-MR-Q-OFFER-${opp.opportunity_id}`); assert.match(String(done[0]!.payload["notes"]), /^FAKE reviewer: approved automatically after 20s/);
  assert.equal(done[0]!.payload["mlo_name"], "A. Lee (FAKE demo MLO)", "the review is attributed to the MLO of record on the lead, never to the FAKE");
  assert.equal((await book.timers("SM_MLO_PREAPP_TERMS_REVIEW_1BH")).at(-1)!.status, "satisfied_late");
  // the journey continues: 20.3 presents (terms.presented), the OfferCard for the borrower's own request
  await book.settle();
  const presented = (await events("terms.presented")).filter((e) => e.payload["quote_id"] === `Q-OFFER-${opp.opportunity_id}`); assert.equal(presented.length, 1); assert.equal(presented[0]!.payload["mlo_review_id"], `FAKE-MR-Q-OFFER-${opp.opportunity_id}`);
  const card = (await book.cards(partyId)).find((c) => c.kind === "OfferCard" && c.props["refi_opportunity_id"] === opp.opportunity_id);
  assert.ok(card, "the OfferCard"); assert.equal(card!.status, "pending"); assert.equal(card!.props["path"], "borrower_request"); assert.equal(card!.props["offered_rate"], "6.125"); assert.equal(card!.props["mlo_attribution"], "A. Lee (FAKE demo MLO), NMLSR ID 222333");
  // the record of what happened is the FAKE's: the events say FAKE:mlo_of_record; a second sweep finds nothing pending (idempotent by the review's own event)
  const again = await runtime.sweep(); assert.equal(again.reviewers!.pending, 0); assert.equal((await events("mlo.review.completed")).length, 1);
});

test("a transfer to a person: 4.3's human_agent escalation is joined by FAKE:human_agent after the delay, through the same tool's op=complete; the borrower sees the PersonCard; the console queue row said FAKE while it waited", { skip }, async () => {
  const { runtime, loanId, partyId } = book;
  clock.set(MST("2026-10-01", "10:00"));
  const r = await runtime.execute({ process: "4.3", name: "human.transfer", loanId, actor: { kind: "agent", id: "borrower-comms" }, input: { loan_id: loanId, reason: "borrower asked for a person", payload: { reason: "borrower asked for a person", party_id: partyId, source: "test" } } });
  const esc = r.escalations.find((e) => e.kind === "human_agent")!; assert.ok(esc, JSON.stringify(r.escalations));
  // the console queue names the FAKE on the pending row (the ops console's own read model, built as src/runtime/server.ts builds it: over the runtime's reviewers)
  const consoleStore = new PgConsoleStore(book.db, runtime.registry, runtime.agents, { fakeReviewers: { roles: reviewers.roles, delaySeconds: reviewers.delaySeconds } });
  const queue = await consoleStore.queue({ kind: "escalation", now: clock.now(), loanId });
  const row = queue.find((q) => q.id === esc.id)!; assert.ok(row); assert.equal(row.title, "human_agent escalation — FAKE reviewer"); assert.deepEqual(row.detail["fake_reviewer"], { role: "human_agent", approves_after_s: DELAY_S, marker: "FAKE" });
  const openedAt = clock.now();
  clock.set(plus(openedAt, 5)); assert.equal((await runtime.sweep()).reviewers!.pending, 0);
  clock.set(plus(openedAt, 30));
  const sweep = await runtime.sweep();
  const mine = sweep.reviewers!.actions.find((a) => a.ref === esc.id)!; assert.ok(mine, JSON.stringify(sweep.reviewers)); assert.equal(mine.outcome, "approved"); assert.equal(mine.tool, "4.3 human.transfer{op=complete}");
  const completed = (await events("escalation.completed")).filter((e) => e.payload["escalation_id"] === esc.id); assert.equal(completed.length, 1); assert.equal(completed[0]!.actor_id, "FAKE:human_agent"); assert.equal(completed[0]!.payload["kind"], "human_agent");
  assert.equal((await book.db.query<{ completed_at: string | null }>(`SELECT completed_at FROM escalations WHERE id = $1`, [esc.id]))[0]!.completed_at !== null, true);
  await book.settle();
  const person = (await book.cards(partyId)).find((c) => c.kind === "PersonCard" && c.props["escalation_id"] === esc.id);
  assert.ok(person, "the PersonCard (32.13 T-X-08)"); assert.equal(person!.props["role"], "human_agent"); assert.equal(person!.props["human_agent_id"], "FAKE:human_agent"); assert.equal(person!.copy_key, "person.human_agent");
  assert.equal(person!.props["name"], FAKE_HUMAN_AGENT_NAME, "the person the borrower meets is named FAKE"); assert.ok(FAKE_HUMAN_AGENT_NAME.startsWith("FAKE"));
  assert.equal((await consoleStore.queue({ kind: "escalation", now: clock.now(), loanId })).some((q) => q.id === esc.id), false, "off the queue");
});
