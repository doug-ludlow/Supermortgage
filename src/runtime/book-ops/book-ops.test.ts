// 34.3 partner book operations — module tests over src/runtime/book-ops/* on a private database `<base>_book_ops`
// (spec/sections/34-operator-portal/34-3-*.md; the spec's T-ids live in src/domain/operator-portal/34-3.spec.test.ts).
// The fixture book (33.1 rule 7) is imported as of 2026-09-01, then a second tape as of 2026-09-08 with loan 5 absent and loan 1's
// UPB one payment lower; a FixedClock at 07:20 America/New_York on 2026-09-15 and runtime.sweep() take 20.1's run, 33.2's review
// (no analyst model: every turn `model_off`) and 33.3's readiness pass; then the history, the hold queue, the day view, the daily
// report row, its export hash, the routes' masking and the bus tools' guardrails are asserted against the stored rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { addDays, addMonths, plainDate } from "../../kernel/calendar/date.ts";
import { Runtime, type SweepReport } from "../app.ts";
import { createLogger } from "../log.ts";
import { CommandRefused } from "../../app/commands.ts";
import { seedEntryDemo } from "../entry-seed.ts";
import { importPartnerBook } from "../partner-book.ts";
import { FakeRateFeed } from "../../infra/integrations/rates.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { writeXlsx } from "../../infra/files/xlsx.ts";
import { scheduledUpb } from "../../domain/leads-pricing/ops-20-1.ts";
import { M3_V1 } from "../../domain/partner-book/profiles/m3-v1.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, type DemoLoan } from "../../domain/partner-book/fixtures/partner-book-demo.ts";
import { TOOLS_34_3 } from "../../app/tools/section34-3.ts";
import { holdsOf, maskEmail, maskPhone, partnersOf } from "./common.ts";
import { bookHistory, bookImportDetail, diffFacts } from "./history.ts";
import { bookLoans } from "./loans.ts";
import { bookLoan } from "./loan.ts";
import { bookDay } from "./day.ts";
import { REPORT_RULE_SET_VERSION, bookDailyReport, exportDailyReport, latestDailyReport, renderDailyReport } from "./report.ts";
import { bookOpsRoutes, sweepDailyReports, type BookOpsRequest, type BookOpsRoute } from "./routes.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
type Json = Record<string, unknown>;

/** 2026-09-15 07:20 America/New_York (EDT): past 20.1's 06:30 run, 33.2's 07:00 review and 33.3's 07:15 pass; before 34.3's 07:45 escalation. */
const AS_OF = "2026-09-15"; const NOW = "2026-09-15T11:20:00.000Z";
const AS_OF_2 = "2026-09-08";   // the second tape's as-of date (7 days after the first — 33.1 rule 8's cadence)
const clock = new FixedClock(NOW);
const OPS = { kind: "human" as const, id: "u-ops-analyst", role: "ops_analyst" };
const STAFF_ID = randomUUID();

let db: Db; let runtime: Runtime; let partnerPartyId = "";
const logLines: string[] = [];
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const col = (key: string): number => { const i = M3_V1.columns.findIndex((c) => c.key === key); assert.ok(i >= 0, `the profile's ${key} column`); return i; };
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));
const J = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|partner|book/i.test(line)) process.stderr.write(line + "\n"); });
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), reviewers: new FakeReviewers({ delaySeconds: 0 }), analystLlm: null });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, '{"phone": "+18005550199"}'::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id]))[0]!.id;
});
test.after(async () => { if (!skip) await db.end(); });

// ---------------------------------------------------------------- the second tape: loan 5 absent, loan 1 one payment further along, every row as of 2026-09-08
function secondTape(): Uint8Array {
  const header = book.tapeRows[0]!;
  const rows = book.tapeRows.slice(1).filter((r) => r[col("servicer_loan_number")] !== loanN(5).servicer_loan_number).map((r) => [...r]);
  for (const r of rows) r[col("as_of_date")] = AS_OF_2;
  const one = rows.find((r) => r[col("servicer_loan_number")] === loanN(1).servicer_loan_number)!;
  const l1 = loanN(1); const upb24 = scheduledUpb(l1.original_cents, l1.note_rate_pct, l1.term_months, l1.payments_made + 1);
  one[col("upb_cents")] = Number(upb24) / 100; one[col("total_upb_cents")] = Number(upb24) / 100;
  one[col("next_due_date")] = addMonths(plainDate(l1.next_due_date), 1); one[col("last_payment_date")] = addMonths(plainDate(l1.last_payment_date), 1); one[col("interest_paid_to_date")] = addMonths(plainDate(l1.last_payment_date), 1);
  one[col("remaining_term_months")] = l1.remaining_term_months - 1;
  return writeXlsx([header, ...rows], "M3");
}
const UPB_23 = 44136613n;   // worked example A: loan 1's UPB after 23 payments, $441,366.13
const UPB_24 = scheduledUpb(loanN(1).original_cents, loanN(1).note_rate_pct, 360, loanN(1).payments_made + 1);

type LoanRow = { id: string; servicer_loan_number: string; status: string };
const loanByNumber = async (n: string): Promise<LoanRow> => { const r = (await db.query<LoanRow>(`SELECT id::text AS id, servicer_loan_number, status::text AS status FROM loans WHERE partner_party_id = $1 AND servicer_loan_number = $2`, [partnerPartyId, n]))[0]; assert.ok(r, `loan ${n}`); return r; };
const loanOf = (n: number): Promise<LoanRow> => loanByNumber(loanN(n).servicer_loan_number);
const events = async (type: string): Promise<{ loan_id: string | null; payload: Json; occurred_at: string }[]> => db.query(`SELECT loan_id::text AS loan_id, payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 ORDER BY sequence`, [type]);
const noDestination = (v: unknown): void => { const s = J(v); assert.ok(!/[a-z0-9._-]{3,}@example\.com/i.test(s), `a destination leaked: ${s.match(/.{0,40}@example\.com/)?.[0]}`); assert.ok(!/\+1\d{10}|\b\d{3}[-. ]?555[-. ]?01\d{2}\b/.test(s), "a phone number leaked"); };

let day1: { first: string; second: string; sweep: SweepReport } | undefined;
async function firstDay(): Promise<{ first: string; second: string; sweep: SweepReport }> {
  if (day1) return day1;
  assert.equal(clock.now(), NOW);
  const seed = await seedEntryDemo(runtime, { partner_id: partnerPartyId, nmlsr_id: DEMO_PARTNER.nmlsr_id });
  assert.equal(seed.partner_id, partnerPartyId);
  const first = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content: book.tape }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, OPS);
  assert.equal(first.status, "loaded", J(first.report).slice(0, 400)); assert.equal(first.rows_loaded, 12); assert.equal(first.loans_created, 12);
  const second = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: AS_OF_2, profile: "m3-v1", tape: { filename: "partner-book-demo-2.xlsx", content: secondTape() }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, OPS);
  assert.equal(second.status, "loaded", J(second.report).slice(0, 400)); assert.equal(second.rows_loaded, 11); assert.equal(second.loans_updated, 1); assert.equal(second.loans_created, 0);
  const sweep = await runtime.sweep();
  assert.ok(sweep.refi?.ran, `the refinance check ran: ${sweep.refi?.reason}`);
  assert.ok(sweep.partner_book_review.ran, `the review ran: ${sweep.partner_book_review.reason}`);
  assert.ok(sweep.partner_book_readiness.ran, `the readiness pass ran: ${sweep.partner_book_readiness.skipped}`);
  day1 = { first: first.import_id, second: second.import_id, sweep }; return day1;
}

// ---------------------------------------------------------------- rule 2: history
test("book-ops history: the two imports with what changed; the second reads 1 updated / 10 unchanged / 1 on hold and its loan-1 line shows the UPB before and after (two stored facts)", { skip }, async () => {
  const { first, second } = await firstDay();
  const h = await bookHistory(runtime, partnerPartyId);
  assert.deepEqual(h.imports.map((i) => i.import_id), [second, first], "newest first");
  const [s, f] = h.imports as [typeof h.imports[number], typeof h.imports[number]];
  assert.equal(f.as_of_date, DEMO_AS_OF); assert.equal(f.loans_created, 12); assert.equal(f.loans_updated, 0); assert.equal(f.loans_unchanged, 0); assert.equal(f.uploaded_by, "human:u-ops-analyst"); assert.equal(f.on_hold, 0);
  assert.equal(s.as_of_date, AS_OF_2); assert.equal(s.rows_loaded, 11); assert.equal(s.loans_updated, 1); assert.equal(s.loans_unchanged, 10); assert.equal(s.loans_created, 0); assert.equal(s.on_hold, 1);
  assert.equal(s.invitations_sent, 0, "no new party, no new invitation"); assert.equal(typeof s.exceptions_by_code, "object");
  const d = await bookImportDetail(runtime, second); assert.ok(d);
  assert.equal(d.lines.length, 11); assert.deepEqual(d.not_on_tape.map((n) => [n.servicer_loan_number, n.last_as_of_date]), [[loanN(5).servicer_loan_number, DEMO_AS_OF]]);
  const one = d.lines.find((l) => l.servicer_loan_number === loanN(1).servicer_loan_number)!; assert.equal(one.change, "updated"); assert.equal(one.as_of_date, AS_OF_2); assert.equal(one.previous_as_of_date, DEMO_AS_OF);
  const upb = one.diff.find((x) => x.key === "upb_cents")!; assert.ok(upb, `the UPB differed: ${J(one.diff)}`);
  assert.equal(upb.before, String(UPB_23)); assert.equal(upb.before, "44136613"); assert.equal(upb.after, String(UPB_24)); assert.ok(BigInt(String(upb.after)) < UPB_23, "one payment lower");
  assert.ok(one.diff.find((x) => x.key === "next_due_date"), "next due differed"); assert.ok(!one.diff.find((x) => x.key === "note_rate_pct"), "the rate did not"); assert.ok(!one.diff.find((x) => x.key === "pi_cents"), "P&I did not");
  assert.ok(one.changed_keys.includes("upb_cents") && !one.changed_keys.includes("as_of_date"));
  for (const l of d.lines.filter((x) => x.change === "unchanged")) assert.equal(l.diff.length, 0);
  // the before / after are the two stored facts rows, verbatim
  const facts = await db.query<{ as_of_date: string; facts: Json }>(`SELECT as_of_date::text AS as_of_date, facts FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date`, [(await loanOf(1)).id]);
  assert.equal(facts.length, 2); assert.equal(facts[0]!.facts["upb_cents"], upb.before); assert.equal(facts[1]!.facts["upb_cents"], upb.after);
  assert.deepEqual(diffFacts({ a: 1, as_of_date: "x" }, { a: 1, as_of_date: "y" }).changed_keys, []);
  noDestination(h); noDestination(d);
});

// ---------------------------------------------------------------- rule 3: the book and the hold queue
test("book-ops loans: the table carries each loan's latest stored facts, the homeowner masked, the verdict and readiness of the day; the hold queue lists loan 5 with its last as-of date; filters narrow", { skip }, async () => {
  await firstDay();
  const b = await bookLoans(runtime, { partner: partnerPartyId });
  assert.equal(b.loans.length, 12); assert.equal(b.counts.loans, 12); assert.equal(b.counts.on_hold, 1);
  assert.deepEqual(b.hold_queue.map((h) => [h.servicer_loan_number, h.last_as_of_date, h.partner_as_of_date]), [[loanN(5).servicer_loan_number, DEMO_AS_OF, AS_OF_2]]);
  assert.deepEqual([...b.hold_queue[0]!.resolutions], ["paid_off", "transferred_out", "keep"]); assert.ok(b.hold_queue[0]!.not_on_tape_since, "partner_book.loan.not_on_tape logged by the second import");
  const latest = await db.query<{ loan_id: string; as_of_date: string; facts: Json }>(`SELECT DISTINCT ON (loan_id) loan_id::text AS loan_id, as_of_date::text AS as_of_date, facts FROM partner_book_facts WHERE partner_party_id = $1 ORDER BY loan_id, as_of_date DESC, created_at DESC`, [partnerPartyId]);
  for (const l of b.loans) {
    const f = latest.find((x) => x.loan_id === l.loan_id)!; assert.ok(f);
    // rule 7: every figure equals the stored fact
    assert.equal(l.facts_as_of, f.as_of_date); assert.equal(l.upb_cents, f.facts["upb_cents"]); assert.equal(l.note_rate_pct, f.facts["note_rate_pct"]); assert.equal(l.pi_cents, f.facts["pi_cents"]); assert.equal(l.next_due_date, f.facts["next_due_date"]); assert.equal(l.value?.value_cents, f.facts["fmv_cents"]); assert.equal(l.value?.as_of, f.facts["fmv_date"]);
    assert.equal(l.status, "monitored"); assert.ok(l.state && l.state.length === 2);
    if (l.homeowner.email_masked) assert.match(l.homeowner.email_masked, /^.…@example\.com$/); if (l.homeowner.phone_masked) assert.match(l.homeowner.phone_masked, /^···\d{4}$/);
    assert.ok(l.latest_review, "the day's review"); assert.equal(l.latest_review.as_of_date, AS_OF);
    assert.equal(l.on_hold, l.servicer_loan_number === loanN(5).servicer_loan_number);
  }
  const one = b.loans.find((l) => l.servicer_loan_number === loanN(1).servicer_loan_number)!;
  assert.equal(one.facts_as_of, AS_OF_2); assert.equal(one.upb_cents, String(UPB_24)); assert.equal(one.pi_cents, "306979"); assert.equal(one.ti_cents, "61250"); assert.equal(one.value?.value_cents, "60500000"); assert.equal(one.note_rate_pct, "7.250");
  assert.equal(one.homeowner.legal_name, "Maria Garcia"); assert.equal(one.homeowner.email_masked, "m…@example.com"); assert.equal(one.homeowner.phone_masked, "···0101"); assert.equal(one.account_activated, false);
  const five = b.loans.find((l) => l.servicer_loan_number === loanN(5).servicer_loan_number)!; assert.equal(five.facts_as_of, DEMO_AS_OF); assert.equal(five.latest_review?.verdict, "not_now"); assert.ok(five.latest_review?.reasons.includes("not_on_latest_tape"));
  assert.equal((await bookLoans(runtime, { partner: partnerPartyId, hold: true })).loans.length, 1);
  assert.equal((await bookLoans(runtime, { partner: partnerPartyId, hold: false })).loans.length, 11);
  assert.equal((await bookLoans(runtime, { partner: partnerPartyId, verdict: "candidate" })).loans.length, b.counts.by_verdict["candidate"]);
  assert.equal((await bookLoans(runtime, { partner: partnerPartyId, ready: false })).loans.length, b.counts.not_ready);
  assert.equal((await bookLoans(runtime, { partner: randomUUID() })).loans.length, 0);
  assert.deepEqual(await holdsOf(runtime, partnerPartyId).then((h) => h.map((x) => x.servicer_loan_number)), [loanN(5).servicer_loan_number]);
  noDestination(b);
  assert.equal(maskEmail("maria.garcia@example.com"), "m…@example.com"); assert.equal(maskPhone("+16025550101"), "···0101"); assert.equal(maskEmail(null), null);
});

// ---------------------------------------------------------------- rule 4: a loan's page
test("book-ops loan: facts by as-of, terms history, invitations as hashes and dates, the review with reasons in words and the engine's facts, readiness items, offers and clocks — every figure a stored row's", { skip }, async () => {
  await firstDay();
  const l1 = await loanOf(1);
  const page = await bookLoan(runtime, l1.id); assert.ok(page);
  assert.equal(page.loan.servicer_loan_number, loanN(1).servicer_loan_number); assert.equal(page.loan.status, "monitored"); assert.equal(page.loan.partner_party_id, partnerPartyId); assert.equal(page.loan.property?.state, "AZ"); assert.equal(page.on_hold, false);
  assert.deepEqual(page.facts_by_as_of.map((f) => f.as_of_date), [DEMO_AS_OF, AS_OF_2]);
  assert.equal(page.facts_by_as_of[0]!.facts["upb_cents"], "44136613"); assert.equal(page.facts_by_as_of[0]!.facts["pi_cents"], "306979"); assert.equal(page.facts_by_as_of[0]!.facts["ti_cents"], "61250"); assert.equal(page.facts_by_as_of[0]!.facts["fmv_cents"], "60500000");
  assert.equal(page.facts_by_as_of[1]!.facts["upb_cents"], String(UPB_24)); assert.equal(typeof page.facts_by_as_of[0]!.raw_columns, "number", "the raw columns beside the facts (the demo tape maps every column: 0)");
  assert.deepEqual(page.terms.map((t) => [t.effective_from, t.effective_to, t.source]), [[DEMO_AS_OF, AS_OF_2, "partner_tape"], [AS_OF_2, null, "partner_tape"]]);
  assert.equal(page.terms[0]!.note_rate_bps, 72500); assert.equal(page.terms[0]!.pi_cents, "306979");
  assert.ok(page.invitations.length >= 1, "the invitation of the first import");
  for (const i of page.invitations) { assert.match(i.destination_hash, /^[0-9a-f]{64}$/); assert.ok(i.sent_at); assert.equal(i.kind, "invitation"); assert.equal(i.channel, "email"); assert.ok(!("destination" in i)); }
  const rows = await db.query<{ verdict: string; reasons: string[]; facts: Json; analyst: Json; decision_id: string }>(`SELECT verdict, reasons, facts, analyst, decision_id::text AS decision_id FROM partner_book_reviews WHERE loan_id = $1 AND as_of_date = $2`, [l1.id, AS_OF]);
  assert.equal(rows.length, 1); const stored = rows[0]!;
  const rv = page.reviews.find((r) => r.as_of_date === AS_OF)!; assert.ok(rv);
  assert.equal(rv.verdict, stored.verdict); assert.deepEqual(rv.reasons, stored.reasons); assert.equal(rv.reasons_in_words.length, stored.reasons.length); for (const w of rv.reasons_in_words) assert.ok(!/\d/.test(w), `reasons in words carry no digit: ${w}`);
  assert.deepEqual(rv.facts, stored.facts); assert.equal(rv.facts["upb_cents"], String(UPB_24), "the engine's facts read the latest tape"); assert.equal(rv.decision_id, stored.decision_id);
  assert.equal(rv.analyst.skipped, "model_off", "no analyst model: skipped, never the review"); assert.ok(rv.analyst.explanation_text);
  assert.ok(rv.verdict_words.length > 0);
  assert.ok(page.readiness.length >= 1, "the readiness row of a candidate"); const rd = page.readiness[0]!; assert.equal(rd.as_of_date, AS_OF); assert.equal(rd.ready, false);
  for (const item of rd.items) { assert.ok(["present", "stale", "missing", "not_applicable"].includes(item.status)); assert.ok(item.rule_ref); }
  assert.ok(rd.missing.includes("identity"));
  assert.ok(page.offers.length >= 1, "the day's opportunity"); const off = page.offers.find((o) => o.as_of_date === AS_OF)!; assert.ok(off); assert.ok(["offer_ready", "offered", "engaged"].includes(off.status ?? ""), off.status ?? "none");
  const opp = decodeEntityData((await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'refi_opportunities' AND id = $1`, [off.opportunity_id]))[0]!.data);
  assert.equal(off.status, opp["status"]); assert.equal(off.offer_valid_until, opp["offer_valid_until"] ?? null);
  assert.ok(page.clocks.length >= 1, "the clocks on the loan"); assert.ok(page.clocks.some((c) => c.code === "SM_PARTNER_BOOK_INVITATION_REMINDER_14"));
  assert.equal(page.resolutions.length, 0);
  const five = await bookLoan(runtime, (await loanOf(5)).id); assert.ok(five); assert.equal(five.on_hold, true); assert.equal(five.hold?.last_as_of_date, DEMO_AS_OF); assert.equal(five.not_on_tape.length, 1); assert.equal(five.not_on_tape[0]!.as_of_date, AS_OF_2);
  assert.equal(await bookLoan(runtime, randomUUID()), null); assert.equal(await bookLoan(runtime, "nope"), null);
  noDestination(page);
});

// ---------------------------------------------------------------- rule 5: the day across the book
test("book-ops day: counts by verdict and by missing item equal the rows, loan 5 reads not_now on hold, both run receipts carry their times against 07:30 ET", { skip }, async () => {
  const { sweep } = await firstDay();
  const day = await bookDay(runtime, { partner: partnerPartyId, as_of: AS_OF });
  const rows = await db.query<{ verdict: string; n: string }>(`SELECT r.verdict, count(*)::text AS n FROM partner_book_reviews r JOIN loans l ON l.id = r.loan_id WHERE r.as_of_date = $1 AND l.partner_party_id = $2 GROUP BY r.verdict`, [AS_OF, partnerPartyId]);
  const expected: Record<string, number> = { candidate: 0, watching: 0, not_now: 0, excluded: 0 }; for (const r of rows) expected[r.verdict] = Number(r.n);
  assert.deepEqual(day.reviews.by_verdict, expected); assert.equal(day.reviews.count, 12); assert.equal(day.reviews.lines.length, 12);
  assert.equal(expected["excluded"], 3, "loans 8, 10 and 11 (late, foreclosure referral, bankruptcy)"); assert.equal(expected["not_now"], 1, "loan 5 on hold"); assert.equal((expected["candidate"] ?? 0) + (expected["watching"] ?? 0), 8);
  assert.equal(day.reviews.on_hold, 1); const five = day.reviews.lines.find((l) => l.servicer_loan_number === loanN(5).servicer_loan_number)!; assert.equal(five.verdict, "not_now"); assert.equal(five.on_hold, true);
  assert.equal(day.reviews.analyst_skipped_by_reason["model_off"], 12);
  const pr = sweep.partner_book_review.programs[0]!;
  assert.equal(day.receipts.review.length, 1); const rr = day.receipts.review[0]!; assert.equal(rr.present, true); assert.equal(rr.run_id, pr.run_id); assert.equal(rr.partner_id, partnerPartyId); assert.equal(rr.at, NOW); assert.equal(rr.expected_by, "2026-09-15T11:30:00.000Z"); assert.equal(rr.late, false);
  assert.equal(rr.payload?.["candidates"], expected["candidate"]); assert.equal(rr.payload?.["excluded"], 3);
  const rd = day.receipts.readiness; assert.equal(rd.present, true); assert.equal(rd.at, NOW); assert.equal(rd.late, false); assert.equal(rd.payload?.["checked"], sweep.partner_book_readiness.checked);
  const checks = await db.query<{ ready: boolean; missing: string[] }>(`SELECT k.ready, k.missing FROM readiness_checks k JOIN loans l ON l.id = k.loan_id WHERE k.as_of_date = $1 AND l.partner_party_id = $2`, [AS_OF, partnerPartyId]);
  assert.equal(day.readiness.checked, checks.length); assert.equal(day.readiness.checked, expected["candidate"], "the candidates were checked"); assert.equal(day.readiness.ready, checks.filter((c) => c.ready).length);
  const byItem: Record<string, number> = {}; for (const c of checks) for (const m of c.missing) byItem[m] = (byItem[m] ?? 0) + 1;
  assert.deepEqual(day.readiness.by_missing_item, byItem); assert.ok((byItem["identity"] ?? 0) >= 1);
  assert.equal(day.escalations.length, 0);
  const empty = await bookDay(runtime, { partner: partnerPartyId, as_of: "2026-09-16" }); assert.equal(empty.reviews.count, 0); assert.equal(empty.receipts.review[0]!.present, false); assert.equal(empty.receipts.readiness.present, false); assert.equal(empty.receipts.readiness.expected_by, "2026-09-16T11:30:00.000Z");
  await assert.rejects(bookDay(runtime, { as_of: "yesterday" }), RangeError);
  noDestination(day);
});

// ---------------------------------------------------------------- rule 6: the daily report and its export
test("book-ops daily report: the sweep hook produces one row per partner-day from the receipts (review counts, the fair-lending extract id, readiness counts, last_as_of_date and next_expected) with its decision; re-runs append nothing; the export is a hashed document on a newer row", { skip }, async () => {
  const { sweep } = await firstDay();
  // Runtime.sweep runs this hook itself after the readiness pass (src/runtime/app.ts sweep → sweepDailyReports): the day's row was produced there, and a direct call afterwards appends nothing
  assert.ok(sweep.partner_book_daily_reports, "the sweep's daily-report hook ran"); assert.equal(sweep.partner_book_daily_reports.as_of_date, AS_OF); assert.equal(sweep.partner_book_daily_reports.produced, 1); assert.equal(sweep.partner_book_daily_reports.escalated, 0, "07:20 ET is before the 07:45 escalation");
  const s1 = await sweepDailyReports(runtime, NOW); assert.equal(s1.as_of_date, AS_OF); assert.equal(s1.produced, 0, "idempotent per partner-day: the sweep's own pass produced the row"); assert.equal(s1.escalated, 0);
  const s2 = await sweepDailyReports(runtime, NOW); assert.equal(s2.produced, 0, "idempotent per partner-day");
  const rows = await db.query<{ id: string; produced_by: string; document_id: string | null }>(`SELECT id::text AS id, produced_by, document_id::text AS document_id FROM partner_book_daily_reports WHERE partner_party_id = $1 AND as_of_date = $2 ORDER BY created_at`, [partnerPartyId, AS_OF]);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.produced_by, "sweep"); assert.equal(rows[0]!.document_id, null);
  const r = await latestDailyReport(runtime, partnerPartyId, AS_OF); assert.ok(r); assert.equal(r.id, rows[0]!.id);
  const pr = sweep.partner_book_review.programs[0]!; const receipt = (await events("partner_book.review.run_completed")).find((e) => e.payload["partner_id"] === partnerPartyId)!.payload;
  assert.equal(r.review.absent, false); assert.equal(r.review.source, "receipt"); assert.equal(r.review.run_id, pr.run_id); assert.equal(r.review.program_id, pr.program_id);
  for (const k of ["reviewed", "candidates", "watching", "not_now", "excluded", "offers_delivered", "expired", "analyst_turns", "analyst_skipped"] as const) assert.equal(r.review[k], receipt[k], k);
  assert.deepEqual(r.review.analyst_skipped_by_reason, receipt["analyst_skipped_by_reason"]); assert.equal(r.review.reviewed, 12); assert.equal(r.review.excluded, 3);
  const run = (await db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = 'refi_trigger_runs' AND data->>'program_id' = $1 AND data->>'as_of_date' = $2`, [pr.program_id, AS_OF]))[0]!; assert.ok(run, "20.1's run of the day");
  const extractId = String(decodeEntityData(run.data)["fair_lending_extract_document_id"]); assert.equal(extractId, `fle-${pr.program_id}-${AS_OF}`);
  assert.equal(r.review.fair_lending_extract_id, extractId); assert.equal(r.review.refi_run_id, run.id);
  assert.ok((await db.query(`SELECT 1 FROM entity_current WHERE kind = 'fair_lending_extracts' AND id = $1`, [extractId])).length === 1, "the extract entity exists");
  const rd = (await events("partner_book.readiness.run_completed"))[0]!.payload;
  assert.equal(r.readiness.absent, false); assert.equal(r.readiness.run_id, rd["run_id"]); assert.equal(r.readiness.checked, rd["checked"]); assert.equal(r.readiness.ready, rd["ready"]); assert.equal(r.readiness.not_ready, rd["not_ready"]); assert.equal(r.readiness.applications_opened, 0); assert.equal(r.readiness.du_runs, 0);
  assert.equal(Object.values(r.readiness.not_ready_by_item).reduce((a, b) => Math.max(a, b), 0) <= r.readiness.checked, true);
  assert.deepEqual(r.book, { loans_monitored: 12, on_hold: 1, paid_off: 0, transferred_out: 0, last_as_of_date: AS_OF_2, next_expected: addDays(plainDate(AS_OF_2), 7), imports: 2 }); assert.equal(r.book.next_expected, "2026-09-15");
  assert.ok(r.decision_id, "the decision record");
  const dec = (await db.query<{ agent: string; action: string; rule_set_version: string; model_version: string | null; prompt_version: string | null; confidence: string | null; rationale: string }>(`SELECT agent, action, rule_set_version, model_version, prompt_version, confidence::text AS confidence, rationale FROM agent_decisions WHERE id = $1`, [r.decision_id]))[0]!;
  assert.equal(dec.agent, "portfolio"); assert.equal(dec.action, "book.daily_report"); assert.equal(dec.rule_set_version, REPORT_RULE_SET_VERSION); assert.equal(dec.model_version, "deterministic"); assert.equal(dec.prompt_version, "34.3-v1"); assert.equal(Number(dec.confidence), 1); assert.ok(dec.rationale.includes(extractId));
  // on demand: the same content, no new row
  const again = await bookDailyReport(runtime, { partner: partnerPartyId, as_of: AS_OF }, OPS); assert.equal(again.produced, false); assert.equal(again.report.id, r.id);
  // compliance exports: a documents row whose sha256 is the rendered report's, and a newer report row carrying it
  const COMPLIANCE = { kind: "human" as const, id: STAFF_ID, role: "compliance" };
  const x = await exportDailyReport(runtime, { partner: partnerPartyId, as_of: AS_OF }, COMPLIANCE);
  assert.equal(x.created, true); assert.equal(x.sha256, createHash("sha256").update(x.content).digest("hex")); assert.equal(x.byte_size, Buffer.byteLength(x.content));
  assert.equal(x.content, renderDailyReport(r)); assert.ok(x.content.includes(extractId));
  const doc = (await db.query<{ kind: string; sha256: string; byte_size: string; mime_type: string; metadata: Json }>(`SELECT kind, sha256, byte_size::text AS byte_size, mime_type, metadata FROM documents WHERE id = $1`, [x.document_id]))[0]!;
  assert.equal(doc.kind, "partner_book_daily_report"); assert.equal(doc.sha256, x.sha256); assert.equal(Number(doc.byte_size), x.byte_size); assert.equal(doc.mime_type, "application/json"); assert.equal(doc.metadata["exported_by"], `human:${STAFF_ID}`); assert.equal(doc.metadata["report_id"], r.id);
  const newest = await latestDailyReport(runtime, partnerPartyId, AS_OF); assert.ok(newest); assert.equal(newest.document_id, x.document_id); assert.notEqual(newest.id, r.id); assert.deepEqual(newest.review, r.review);
  assert.equal((await db.query(`SELECT 1 FROM partner_book_daily_reports WHERE partner_party_id = $1 AND as_of_date = $2`, [partnerPartyId, AS_OF])).length, 2, "append-only: the export is a newer row");
  const x2 = await exportDailyReport(runtime, { partner: partnerPartyId, as_of: AS_OF }, COMPLIANCE); assert.equal(x2.created, false); assert.equal(x2.document_id, x.document_id);
  assert.equal((await sweepDailyReports(runtime, NOW)).produced, 0, "the exported row says the same thing");
  await assert.rejects(db.query(`UPDATE partner_book_daily_reports SET produced_by = 'x' WHERE id = $1`, [r.id]), /append-only/);
  // a day without receipts, from 07:45 ET: the ops_analyst escalation once, and no report
  const late = await sweepDailyReports(runtime, "2026-09-16T11:50:00.000Z"); assert.equal(late.as_of_date, "2026-09-16"); assert.equal(late.produced, 0); assert.equal(late.escalated, 1);
  assert.equal((await sweepDailyReports(runtime, "2026-09-16T11:55:00.000Z")).escalated, 0, "one per partner-day");
  const esc = (await db.query<{ owner_role: string; kind: string; payload: Json }>(`SELECT owner_role, kind, payload FROM escalations WHERE payload->>'kind' = 'partner_book_day_receipt_missing'`))[0]!;
  assert.equal(esc.owner_role, "ops_analyst"); assert.equal(esc.kind, "sev3"); assert.equal(esc.payload["as_of_date"], "2026-09-16"); assert.deepEqual(esc.payload["missing"], ["partner_book.review.run_completed", "partner_book.readiness.run_completed"]);
  const d16 = await bookDay(runtime, { partner: partnerPartyId, as_of: "2026-09-16" }); assert.equal(d16.escalations.length, 1);
  assert.equal(await latestDailyReport(runtime, partnerPartyId, "2026-09-16"), null);
  // on demand for a day without receipts: absent receipts, counts from rows (none)
  const d16r = await bookDailyReport(runtime, { partner: partnerPartyId, as_of: "2026-09-16" }, OPS); assert.equal(d16r.produced, true); assert.equal(d16r.report.review.absent, true); assert.equal(d16r.report.readiness.absent, true); assert.equal(d16r.report.review.reviewed, 0); assert.equal(d16r.report.book.on_hold, 1);
  noDestination(r); noDestination(x.content);
});

// ---------------------------------------------------------------- the routes: the table, masking, book.viewed, the resolve dispatch
const staff = (role: string): BookOpsRequest["staff"] => ({ staff_user_id: STAFF_ID, role, session_id: null });
const req = (role: string, params: Record<string, string> = {}, query: Record<string, string> = {}, body: Json = {}): BookOpsRequest => ({ params, query, body, staff: staff(role) });
const find = (routes: BookOpsRoute[], method: string, path: string): BookOpsRoute => { const r = routes.find((x) => x.method === method && x.path === path); assert.ok(r, `${method} ${path}`); return r; };

test("book-ops routes: the route table, every GET masked and logged as book.viewed, roles refused before any read, the resolve of loan 5 dispatched to 33.1 book.resolve with the staff actor", { skip }, async () => {
  await firstDay();
  const routes = bookOpsRoutes({ runtime });
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), [
    "GET /ops/api/partner-book/partners", "GET /ops/api/partner-book/imports", "GET /ops/api/partner-book/imports/{id}", "GET /ops/api/partner-book/loans", "GET /ops/api/partner-book/loans/{id}", "GET /ops/api/partner-book/reviews", "GET /ops/api/partner-book/readiness",
    "GET /ops/api/partner-book/daily-report", "POST /ops/api/partner-book/daily-report/export", "POST /ops/api/partner-book/loans/{id}/resolve"]);
  for (const r of routes.filter((x) => x.method === "GET")) assert.deepEqual([...r.roles], ["ops_analyst", "officer", "compliance"]);
  assert.deepEqual([...find(routes, "POST", "/ops/api/partner-book/loans/{id}/resolve").roles], ["ops_analyst"]); assert.deepEqual([...find(routes, "POST", "/ops/api/partner-book/daily-report/export").roles], ["compliance"]);
  const before = (await events("book.viewed")).length;
  const partners = await find(routes, "GET", "/ops/api/partner-book/partners").handler(req("ops_analyst")); assert.equal(partners.status, 200);
  const ps = (partners.body as { partners: Awaited<ReturnType<typeof partnersOf>> }).partners; assert.equal(ps.length, 1); assert.equal(ps[0]!.partner_party_id, partnerPartyId); assert.equal(ps[0]!.loans_monitored, 12); assert.equal(ps[0]!.on_hold, 1); assert.equal(ps[0]!.last_as_of_date, AS_OF_2); assert.equal(ps[0]!.next_expected, "2026-09-15"); assert.equal(ps[0]!.clock_status, "armed"); assert.equal(ps[0]!.tape_clock?.due_date, "2026-09-15");
  const l1 = await loanOf(1); const five = await loanOf(5);
  const responses = [
    await find(routes, "GET", "/ops/api/partner-book/imports").handler(req("officer", {}, { partner: partnerPartyId })),
    await find(routes, "GET", "/ops/api/partner-book/imports/{id}").handler(req("compliance", { id: (await firstDay()).second })),
    await find(routes, "GET", "/ops/api/partner-book/loans").handler(req("ops_analyst", {}, { partner: partnerPartyId, hold: "true" })),
    await find(routes, "GET", "/ops/api/partner-book/loans/{id}").handler(req("ops_analyst", { id: l1.id })),
    await find(routes, "GET", "/ops/api/partner-book/reviews").handler(req("ops_analyst", {}, { partner: partnerPartyId, as_of: AS_OF })),
    await find(routes, "GET", "/ops/api/partner-book/readiness").handler(req("ops_analyst", {}, { partner: partnerPartyId, as_of: AS_OF })),
    await find(routes, "GET", "/ops/api/partner-book/daily-report").handler(req("ops_analyst", {}, { partner: partnerPartyId, as_of: AS_OF })),
  ];
  for (const r of responses) { assert.equal(r.status, 200, J(r.body).slice(0, 200)); noDestination(r.body); }
  assert.equal((responses[2]!.body as { loans: unknown[] }).loans.length, 1, "?hold=true");
  const viewed = (await events("book.viewed")).slice(before); assert.deepEqual(viewed.map((e) => e.payload["view"]), ["partners", "imports", "import", "loans", "loan", "reviews", "readiness", "daily_report"]);
  for (const e of viewed) { assert.equal(e.payload["staff_user_id"], STAFF_ID); assert.equal(e.loan_id, null, "global"); } assert.equal(viewed[3]!.payload["partner_id"], partnerPartyId); assert.equal(viewed[4]!.payload["subject_id"], l1.id);
  assert.equal((await find(routes, "GET", "/ops/api/partner-book/loans/{id}").handler(req("ops_analyst", { id: randomUUID() }))).status, 404);
  assert.equal((await find(routes, "GET", "/ops/api/partner-book/reviews").handler(req("ops_analyst", {}, { as_of: "bad" }))).status, 400);
  // roles: admin touches no borrower; resolve is ops_analyst's; the export is compliance's
  const denied = await find(routes, "GET", "/ops/api/partner-book/loans").handler(req("admin")); assert.equal(denied.status, 403); assert.equal((denied.body as Json)["code"], "ROLE_REQUIRED");
  const notOps = await find(routes, "POST", "/ops/api/partner-book/loans/{id}/resolve").handler(req("compliance", { id: five.id }, {}, { resolution: "paid_off", reason: "x" })); assert.equal(notOps.status, 403); assert.equal((notOps.body as Json)["role"], "ops_analyst");
  assert.equal((await find(routes, "POST", "/ops/api/partner-book/daily-report/export").handler(req("ops_analyst", {}, {}, { partner: partnerPartyId, as_of: AS_OF }))).status, 403);
  const exp = await find(routes, "POST", "/ops/api/partner-book/daily-report/export").handler(req("compliance", {}, {}, { partner: partnerPartyId, as_of: AS_OF })); assert.ok(exp.status === 200 || exp.status === 201, J(exp.body).slice(0, 200)); assert.equal(exp.command, "book.daily_report:export"); assert.match(String((exp.body as Json)["sha256"]), /^[0-9a-f]{64}$/);
  const bad = await find(routes, "POST", "/ops/api/partner-book/loans/{id}/resolve").handler(req("ops_analyst", { id: five.id }, {}, { resolution: "vanish", reason: "x" })); assert.equal(bad.status, 400);
  // the resolution: 33.1's book.resolve through the bus with the staff member as the actor (501 only until 33.1's tool is on the bus)
  const res = await find(routes, "POST", "/ops/api/partner-book/loans/{id}/resolve").handler(req("ops_analyst", { id: five.id }, {}, { resolution: "paid_off", reason: "the partner confirmed the payoff of 2026-09-03" }));
  if (res.status === 501) { assert.equal((res.body as Json)["code"], "NOT_IMPLEMENTED"); return; }
  assert.equal(res.status, 200, J(res.body).slice(0, 300)); assert.equal(res.command, "book.resolve"); assert.deepEqual(res.subject, { kind: "loan", id: five.id });
  assert.equal((await loanOf(5)).status, "paid_off");
  const resolved = (await events("partner_book.loan.resolved")).filter((e) => e.loan_id === five.id); assert.equal(resolved.length, 1); assert.equal(resolved[0]!.payload["resolution"], "paid_off"); assert.equal(resolved[0]!.payload["was_on_hold"], true);
  const actor = (await db.query<{ actor_kind: string; actor_id: string; actor_role: string | null }>(`SELECT actor_kind, actor_id, actor_role FROM loan_events WHERE loan_id = $1 AND type = 'partner_book.loan.resolved'`, [five.id]))[0]!;
  assert.deepEqual(actor, { actor_kind: "human", actor_id: STAFF_ID, actor_role: "ops_analyst" });
  assert.equal((await bookLoans(runtime, { partner: partnerPartyId })).hold_queue.length, 0, "the hold queue is empty");
  const page = (res.body as { loan: Awaited<ReturnType<typeof bookLoan>> }).loan; assert.ok(page); assert.equal(page.loan.status, "paid_off"); assert.equal(page.resolutions.length, 1); assert.equal(page.resolutions[0]!.resolution, "paid_off"); assert.equal(page.resolutions[0]!.actor, `human:${STAFF_ID}`); assert.equal(page.on_hold, false);
  assert.equal((await bookLoans(runtime, { partner: partnerPartyId, status: "paid_off" })).loans.length, 1);
});

// ---------------------------------------------------------------- the bus tools and their guardrails
test("book-ops tools: the five 34.3 tools on the bus for the portfolio agent; READ_ONLY, NO_COMPUTED_FIGURE, ROLE_MASK and NO_DESTINATION refuse; book.daily_report writes only the report row", { skip }, async () => {
  await firstDay();
  assert.deepEqual(TOOLS_34_3.map((t) => [t.name, t.kind, t.agent, t.process]), [["book.history", "read", "portfolio", "34.3"], ["book.loans", "read", "portfolio", "34.3"], ["book.loan", "read", "portfolio", "34.3"], ["book.day", "read", "portfolio", "34.3"], ["book.daily_report", "write", "portfolio", "34.3"]]);
  for (const t of TOOLS_34_3) assert.ok(runtime.tool("34.3", t.name), `${t.name} on the bus`);
  const run = (name: string, input: Json, actor = OPS, loanId = "") => runtime.execute({ process: "34.3", name, loanId, actor, input });
  const loans = (await run("book.loans", { partner_id: partnerPartyId })).output as Awaited<ReturnType<typeof bookLoans>>; assert.equal(loans.loans.length, 12); noDestination(loans);
  const l1 = await loanOf(1);
  const page = (await run("book.loan", { loan_id: l1.id })).output as Awaited<ReturnType<typeof bookLoan>>; assert.equal(page?.loan.loan_id, l1.id);
  const scoped = (await run("book.loan", {}, OPS, l1.id)).output as Awaited<ReturnType<typeof bookLoan>>; assert.equal(scoped?.loan.loan_id, l1.id, "the command's loan");
  const hist = (await run("book.history", { partner_id: partnerPartyId, lines: false })).output as Awaited<ReturnType<typeof bookHistory>>; assert.equal(hist.imports.length, 2);
  const day = (await run("book.day", { partner_id: partnerPartyId, as_of_date: AS_OF })).output as Awaited<ReturnType<typeof bookDay>>; assert.equal(day.reviews.count, 12);
  const today = (await run("book.day", { partner_id: partnerPartyId })).output as Awaited<ReturnType<typeof bookDay>>; assert.equal(today.as_of_date, AS_OF, "the ET day of the command's clock");
  const before = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_book_daily_reports`))[0]!.n;
  const rep = (await run("book.daily_report", { partner_id: partnerPartyId, as_of_date: AS_OF })).output as Awaited<ReturnType<typeof bookDailyReport>>; assert.equal(rep.report.as_of_date, AS_OF);
  assert.equal(rep.produced, true, "loan 5 was resolved since the sweep's row: the book summary changed, a newer row is appended"); assert.equal(rep.report.book.paid_off, 1); assert.equal(rep.report.book.on_hold, 0); assert.equal(rep.report.produced_by, "human:u-ops-analyst");
  assert.equal(Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_book_daily_reports`))[0]!.n), Number(before) + 1);
  const rep2 = (await run("book.daily_report", { partner_id: partnerPartyId, as_of_date: AS_OF })).output as Awaited<ReturnType<typeof bookDailyReport>>; assert.equal(rep2.produced, false, "nothing new to say, nothing written"); assert.equal(rep2.report.id, rep.report.id);
  assert.equal(Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_book_daily_reports`))[0]!.n), Number(before) + 1);
  assert.equal((await latestDailyReport(runtime, partnerPartyId, AS_OF))?.id, rep.report.id, "the newest row wins (time-ordered ids under a fixed clock)");
  const refused = async (name: string, input: Json, code: string, actor = OPS): Promise<void> => { await assert.rejects(run(name, input, actor), (e: unknown) => { assert.ok(e instanceof CommandRefused, `${name} ${J(input)}: ${e instanceof Error ? e.message : String(e)}`); assert.equal(e.code, code); return true; }); };
  await refused("book.loans", { partner_id: partnerPartyId, unmask: true }, "ROLE_MASK");
  await refused("book.loan", { loan_id: l1.id, include_contact: true }, "ROLE_MASK", { kind: "human", id: "c", role: "compliance" });
  await refused("book.loans", { partner_id: partnerPartyId, email: "maria.garcia@example.com" }, "NO_DESTINATION");
  await refused("book.loan", { loan_id: l1.id, destination: "x" }, "NO_DESTINATION");
  await refused("book.loans", { partner_id: partnerPartyId, upb_cents: "1" }, "NO_COMPUTED_FIGURE");
  await refused("book.day", { partner_id: partnerPartyId, estimate: true }, "NO_COMPUTED_FIGURE");
  await refused("book.loans", { partner_id: partnerPartyId, op: "write" }, "READ_ONLY");
  await refused("book.loan", { loan_id: l1.id, resolution: "paid_off" }, "READ_ONLY");
  await refused("book.history", { partner_id: partnerPartyId, changes: { status: "x" } }, "READ_ONLY");
  await refused("book.daily_report", { partner_id: partnerPartyId, op: "delete" }, "READ_ONLY");
  await refused("book.loans", { partner_id: partnerPartyId }, "ROLE_DENIED", { kind: "human", id: "a", role: "admin" });
  await assert.rejects(run("book.daily_report", { partner_id: partnerPartyId, op: "export" }), /compliance/);
  const exp = (await run("book.daily_report", { partner_id: partnerPartyId, as_of_date: AS_OF, op: "export" }, { kind: "human", id: STAFF_ID, role: "compliance" })).output as Awaited<ReturnType<typeof exportDailyReport>>; assert.match(exp.sha256, /^[0-9a-f]{64}$/);
});
