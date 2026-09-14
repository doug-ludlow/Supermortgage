// The partner book's offer delivery (src/runtime/partner-book-offers.ts) — the pure parts: who may approve the partner's
// campaign and creative (the FAKE officer only outside production with the FAKE reviewers on; a person otherwise) and
// what counts as an open offer (one open offer per loan, rule 5). No database. The delivery pass itself is exercised by
// src/domain/partner-book/33-2.spec.test.ts (T5, the officer test and the day-32 test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate } from "../kernel/calendar/date.ts";
import { FAKE_OFFICER, fakeOfficerFromEnv, isOpenOffer } from "./partner-book-offers.ts";

test("fakeOfficerFromEnv: never in production; off under FAKE_REVIEWERS=off or INTEGRATIONS other than fake; the FAKE officer otherwise", () => {
  assert.equal(fakeOfficerFromEnv({ ENVIRONMENT: "production" }), null);
  assert.equal(fakeOfficerFromEnv({ ENVIRONMENT: "production", INTEGRATIONS: "fake" }), null);
  assert.equal(fakeOfficerFromEnv({ ENVIRONMENT: "production", INTEGRATIONS: "fake", FAKE_REVIEWERS: "on" }), null);
  assert.equal(fakeOfficerFromEnv({ ENVIRONMENT: " Production " }), null);
  assert.equal(fakeOfficerFromEnv({ FAKE_REVIEWERS: "off" }), null);
  assert.equal(fakeOfficerFromEnv({ FAKE_REVIEWERS: " OFF " }), null);
  assert.equal(fakeOfficerFromEnv({ INTEGRATIONS: "real" }), null);
  assert.deepEqual(fakeOfficerFromEnv({}), FAKE_OFFICER);
  assert.deepEqual(fakeOfficerFromEnv({ ENVIRONMENT: "nonprod" }), FAKE_OFFICER);
  assert.deepEqual(fakeOfficerFromEnv({ ENVIRONMENT: "test", INTEGRATIONS: "fake", FAKE_REVIEWERS: "on" }), FAKE_OFFICER);
  assert.deepEqual(FAKE_OFFICER, { kind: "human", id: "FAKE:officer", role: "officer" });
});

test("isOpenOffer: offered and not past offer_valid_until (none → open), or engaged; never offer_ready, expired, declined, converted or suppressed", () => {
  const today = plainDate("2026-10-16");
  assert.equal(isOpenOffer({ status: "offered", offer_valid_until: plainDate("2026-10-16") }, today), true);
  assert.equal(isOpenOffer({ status: "offered", offer_valid_until: plainDate("2026-11-15") }, today), true);
  assert.equal(isOpenOffer({ status: "offered", offer_valid_until: plainDate("2026-10-15") }, today), false);
  assert.equal(isOpenOffer({ status: "offered", offer_valid_until: null }, today), true);
  assert.equal(isOpenOffer({ status: "engaged", offer_valid_until: plainDate("2026-10-15") }, today), true);
  for (const status of ["offer_ready", "expired", "declined", "converted", "suppressed"] as const) assert.equal(isOpenOffer({ status, offer_valid_until: plainDate("2026-11-15") }, today), false, status);
});
