// 36.3 rule 1 — the pure bucket projection (src/domain/servicing-partner-portal/buckets.ts): the verdict is the bucket, the hold wins,
// review_pending before the first review, the query keys of rule 3, the counts of rule 4, and 36.5's banner and page bucket. No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BANNER_ACTIVE, BANNER_IN_REFINANCE, BOARD_BUCKETS, REVIEW_PENDING, bannerMonitored, bannerOf, bucketForVerdict, bucketOf, countsOf, eligibilityQueryOf, pageBucketOf } from "./buckets.ts";

const review = (verdict: string, reasons: string[] = [], as_of_date = "2026-09-15") => ({ as_of_date, verdict, reasons });

test("36.3 rule 1: candidate → eligible_now, watching → likely_soon with the watch rate, not_now and excluded → not_near with the engine's codes", () => {
  assert.deepEqual(bucketOf({ on_hold: false, latest_review: review("candidate", ["rate_delta", "npv_positive"]) }), { bucket: "eligible_now", place: "eligible_now", reasons: ["rate_delta", "npv_positive"], watch_rate_pct: null, review_as_of: "2026-09-15" });
  assert.deepEqual(bucketOf({ on_hold: false, latest_review: review("watching", ["rate_delta_bps -25 < 25"]), watch_rate_pct: "5.625" }), { bucket: "likely_soon", place: "likely_soon", reasons: ["rate_delta_bps -25 < 25"], watch_rate_pct: "5.625", review_as_of: "2026-09-15" });
  assert.deepEqual(bucketOf({ on_hold: false, latest_review: review("not_now", ["cooldown"]) }).bucket, "not_near");
  assert.deepEqual(bucketOf({ on_hold: false, latest_review: review("excluded", ["bankruptcy_active"]) }), { bucket: "not_near", place: "not_near", reasons: ["bankruptcy_active"], watch_rate_pct: null, review_as_of: "2026-09-15" });
  // the watch rate rides on a Likely soon row only — a candidate's or an excluded loan's is never shown, even if the input carries one
  assert.equal(bucketOf({ on_hold: false, latest_review: review("candidate"), watch_rate_pct: "6.000" }).watch_rate_pct, null);
  assert.equal(bucketOf({ on_hold: false, latest_review: review("watching"), watch_rate_pct: null }).watch_rate_pct, null);
  // the mapping is the verdict and nothing else: an unknown verdict string never mints a fourth place
  assert.equal(bucketForVerdict("something_else"), "not_near");
  for (const v of ["candidate", "watching", "not_now", "excluded"]) assert.ok((BOARD_BUCKETS as readonly string[]).includes(bucketForVerdict(v)));
});

test("36.3 rule 1: the hold wins over the verdict (Holds, none of the three), and no review yet is not_near with review_pending", () => {
  const held = bucketOf({ on_hold: true, latest_review: review("not_now", ["not_on_latest_tape"]) });
  assert.deepEqual([held.bucket, held.place, held.reasons], [null, "holds", ["not_on_latest_tape"]]);
  assert.deepEqual([bucketOf({ on_hold: true, latest_review: review("candidate") }).place, bucketOf({ on_hold: true, latest_review: null }).place], ["holds", "holds"]);
  const pending = bucketOf({ on_hold: false, latest_review: null });
  assert.deepEqual(pending, { bucket: "not_near", place: "not_near", reasons: [REVIEW_PENDING], watch_rate_pct: null, review_as_of: null });
});

test("36.3 rule 3: bucket, state (upper-cased) and on_hold narrow; every other key and every value outside the set is dropped unread", () => {
  const q = eligibilityQueryOf([["bucket", "eligible_now"], ["state", "ca"], ["fico", "700"], ["dti", "40"], ["zip", "85013"], ["name", "Maria"], ["age", "60"], ["investor", "FNMA"], ["score", "9"], ["ready", "true"]]);
  assert.deepEqual([q.bucket, q.state, q.on_hold], ["eligible_now", "CA", null]);
  assert.deepEqual(q.applied, ["bucket", "state"]); assert.deepEqual(q.dropped, ["fico", "dti", "zip", "name", "age", "investor", "score", "ready"]);
  // a value outside the set: the key is dropped as an unknown one is (serviced / in_refinance are the page's values, not the board's)
  assert.deepEqual([eligibilityQueryOf([["bucket", "serviced"]]).bucket, eligibilityQueryOf([["bucket", "in_refinance"]]).bucket, eligibilityQueryOf([["bucket", "eligible_now"]]).bucket], [null, null, "eligible_now"]);
  assert.deepEqual(eligibilityQueryOf([["bucket", "serviced"]]).dropped, ["bucket"]);
  assert.deepEqual([eligibilityQueryOf([["state", "Ariz"]]).state, eligibilityQueryOf([["state", "AZ"]]).state, eligibilityQueryOf([["state", "1A"]]).state], [null, "AZ", null]);
  assert.deepEqual([eligibilityQueryOf([["on_hold", "true"]]).on_hold, eligibilityQueryOf([["on_hold", "false"]]).on_hold, eligibilityQueryOf([["on_hold", "yes"]]).on_hold, eligibilityQueryOf([]).on_hold], [true, false, null, null]);
});

test("36.3 rule 4: the counts add up — the three buckets over the loans not on hold, plus the held ones", () => {
  const rows = [review("candidate"), review("candidate"), review("watching"), review("excluded"), review("not_now"), null].map((r) => bucketOf({ on_hold: false, latest_review: r }));
  const held = bucketOf({ on_hold: true, latest_review: review("watching") });
  assert.deepEqual(countsOf([...rows, held]), { eligible_now: 2, likely_soon: 1, not_near: 3, on_hold: 1 });
  const c = countsOf([...rows, held]); assert.equal(c.eligible_now + c.likely_soon + c.not_near + c.on_hold, 7);
});

test("36.5 rule 4: the banner is the row's state — one of three sentences, or null for a retired row (DELTA-03)", () => {
  const partner = "Northlight Mortgage Servicing (FAKE partner)";
  assert.equal(bannerOf({ status: "monitored", partner_legal_name: partner, open_application: false, origination_application_id: null }), bannerMonitored(partner));
  assert.equal(bannerMonitored(partner), "Monitored — Northlight Mortgage Servicing (FAKE partner) remains servicer");
  assert.equal(bannerOf({ status: "monitored", partner_legal_name: partner, open_application: true, origination_application_id: null }), BANNER_IN_REFINANCE);
  assert.equal(bannerOf({ status: "active", partner_legal_name: partner, open_application: false, origination_application_id: "app-1" }), BANNER_ACTIVE);
  assert.equal(BANNER_ACTIVE, "Active — Supermortgage subservicing");
  for (const status of ["paid_off", "transferred_out"]) assert.equal(bannerOf({ status, partner_legal_name: partner, open_application: false, origination_application_id: null }), null);
  assert.equal(bannerOf({ status: "active", partner_legal_name: partner, open_application: false, origination_application_id: null }), null, "an active row without the link is not the boarded refinance");
});

test("36.5 rule 5: the page's bucket — serviced, in_refinance, else rule 1's value with the hold beside it; null for a retired row", () => {
  assert.equal(pageBucketOf({ status: "active", open_application: false, on_hold: false, latest_review: null }), "serviced");
  assert.equal(pageBucketOf({ status: "monitored", open_application: true, on_hold: false, latest_review: review("candidate") }), "in_refinance");
  assert.equal(pageBucketOf({ status: "monitored", open_application: false, on_hold: false, latest_review: review("candidate") }), "eligible_now");
  assert.equal(pageBucketOf({ status: "monitored", open_application: false, on_hold: true, latest_review: review("watching") }), "likely_soon", "a held loan reads its verdict's bucket on the page");
  assert.equal(pageBucketOf({ status: "monitored", open_application: false, on_hold: false, latest_review: null }), "not_near");
  assert.equal(pageBucketOf({ status: "paid_off", open_application: false, on_hold: false, latest_review: review("candidate") }), null);
});
