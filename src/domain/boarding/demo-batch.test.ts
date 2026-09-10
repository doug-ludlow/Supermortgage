/**
 * The demo transfer batch: 100 synthetic loans that survive a round trip
 * through the transferor tape layout, run through the 1.1 DQ gate with
 * exactly the designed defects found, and board on the transfer date. The
 * committed fixture under fixtures/transfer-batch-demo/ must be what the
 * generator produces (regenerate with tools/gen-transfer-batch.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateDemoBatch, DEMO_BATCH, amortizedBalance, monthlyInterestCents } from "./demo-batch.ts";
import { encodeTransferBatch, decodeTransferBatch, parseCsv, FINAL_TAPE_HEADER, type TransferBatchFiles } from "./tape-codec.ts";
import { boardingHarness } from "./fixtures.ts";
import { levelPayment, ratePercent, cents } from "../../kernel/money/cents.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x === undefined ? undefined : x));
const batch = generateDemoBatch();
const files = encodeTransferBatch(batch, batch.coborrowers);

test("100 loans with the shape of a real book: vintages, ARMs, escrow, MI, delinquency, BK/FC, loss mit, SCRA, NIB, eNotes", () => {
  const L = batch.loans;
  assert.equal(L.length, 100);
  assert.equal(new Set(L.map((l) => l.transferor_loan_number)).size, 100); assert.equal(new Set(L.map((l) => l.fnma_loan_number)).size, 100);
  assert.equal(L.filter((l) => l.amortization === "arm").length, 12);
  assert.equal(L.filter((l) => l.mi.flag).length, 8);
  assert.equal(L.filter((l) => l.bankruptcy.active).length, 2); assert.equal(L.filter((l) => l.foreclosure.active).length, 2);
  assert.equal(L.filter((l) => l.lossmit.in_process).length, 3); assert.equal(L.filter((l) => l.scra.active).length, 1);
  assert.equal(L.filter((l) => l.deferred_principal_cents > 0n || l.forborne_principal_cents > 0n).length, 3);
  assert.equal(L.filter((l) => l.custody?.enote_evault_ref).length, 2);
  assert.deepEqual({ aa: L.filter((l) => l.remittance_type === "A/A").length, sa: L.filter((l) => l.remittance_type === "S/A").length, ss: L.filter((l) => l.remittance_type === "S/S").length }, { aa: 60, sa: 25, ss: 15 });
  const current = L.filter((l) => l.next_due_date === DEMO_BATCH.transfer_date).length;
  assert.equal(current, 82, "82 current, 10 thirty days, 5 sixty days, 3 ninety-plus");
  assert.ok(L.filter((l) => l.escrowed).length >= 80);
  // every figure derives from the terms: P&I is the level payment on the original terms and UPB is that amortization through the paid-through date
  for (const l of L) {
    assert.equal(l.pi_cents, levelPayment(l.original_upb_cents!, ratePercent(l.note_rate_pct!), l.original_term_months!), l.transferor_loan_number);
    assert.ok(l.upb_cents! > 0n && l.upb_cents! < l.original_upb_cents!, l.transferor_loan_number);
    if (l.scheduled_upb_cents != null) assert.ok(l.scheduled_upb_cents <= l.upb_cents!, "scheduled UPB ≤ actual for a delinquent S/S loan");
    assert.equal(l.escrow_payment_cents, l.escrow_lines.length ? (l.escrow_lines.reduce((s, e) => s + e.annual_amount_cents, 0n) + 6n) / 12n : 0n);
    assert.ok(/^000-\d{2}-\d{4}$/.test(l.borrower.tin!), "synthetic TIN in the never-issued 000 area");
  }
  // the 1.1 worked example arithmetic holds for the generator's amortizer: $245,634.12 at 6.375% → $1,304.93 interest
  assert.equal(monthlyInterestCents(cents("245634.12"), "6.375"), 130_493n);
  assert.equal(amortizedBalance(cents("259033.17"), "6.375", 360, 0), cents("259033.17"));
});

test("the tape files round-trip: encode → CSV → decode reproduces every loan and position exactly", () => {
  const decoded = decodeTransferBatch(files);
  assert.equal(decoded.loans.length, 100);
  for (let i = 0; i < 100; i++) assert.equal(canon(decoded.loans[i]), canon(batch.loans[i]), batch.loans[i]!.transferor_loan_number);
  assert.equal(canon(decoded.fnma), canon(batch.fnma)); assert.equal(canon(decoded.trialBalance), canon(batch.trialBalance)); assert.equal(canon(decoded.mers), canon(batch.mers));
  assert.equal(canon(decoded.images), canon(batch.images)); assert.equal(canon(decoded.fairLending), canon(batch.fairLending));
  const rows = parseCsv(files["boarding_tape.final.csv"]);
  assert.equal(rows.length, 100); assert.deepEqual(Object.keys(rows[0]!), [...FINAL_TAPE_HEADER]);
  assert.equal(rows.filter((r) => r["coborrower_name"]).length, batch.coborrowers.size, "the unmapped co-borrower column rides along");
  assert.equal(parseCsv(files["payment_history.csv"]).length, 100 * 24 - 2, "24 months per loan; one loan's history has a two-month gap (W-014)");
});

test("through the 1.1 gate: exactly the designed hard failures, the designed warnings, and every other loan boards on the transfer date", () => {
  const h = boardingHarness(`${DEMO_BATCH.transfer_date}T09:00:00.000Z`, DEMO_BATCH.transfer_date);
  const decoded = decodeTransferBatch(files);
  for (const p of decoded.fnma) h.ext.fnmaRows.set(p.fnma_loan_number, p);
  for (const t of decoded.trialBalance) h.ext.tb.set(t.transferor_loan_number, t.upb_cents);
  for (const m of decoded.mers) h.ext.mersRows.set(m.min, m);
  for (const [name, text] of Object.entries(files)) {
    const kind = name === "boarding_tape.final.csv" ? "final" : name.replace(/(_file)?\.csv$/, "");
    if (["final", "payment_history", "escrow_history", "escrow_analysis", "lossmit", "fc_bk", "consents", "images_manifest", "trial_balance"].includes(kind)) assert.equal(h.svc.ingestTape(h.batch.batch_id, kind as "final", text, text.split("\n").length - 2).status, "accepted");
  }
  assert.equal(h.svc.ingestTape(h.batch.batch_id, "final", files["boarding_tape.final.csv"], 100).status, "duplicate", "1.1-T10: same hash → idempotent receipt");
  const staged = h.svc.stage(h.batch.batch_id, decoded.loans);
  assert.equal(staged.length, 100);
  const card = h.svc.validate(h.batch.batch_id);
  const byNumber = new Map(staged.map((bl) => [bl.staged.transferor_loan_number, bl]));
  // hard failures: exactly the planted ones, each with its planted rule code
  const hardFound = new Map<string, string[]>();
  for (const bl of staged) { const codes = bl.validations.filter((v) => v.severity === "hard" && v.result === "fail").map((v) => v.code); if (codes.length) hardFound.set(bl.staged.transferor_loan_number, codes.sort()); }
  assert.deepEqual([...hardFound].sort(), [...batch.designed.hard].map(([k, v]) => [k, [...v].sort()]).sort());
  assert.equal(card.loans["exception"], batch.designed.hard.size); assert.equal(card.loans["validated"], 100 - batch.designed.hard.size);
  // warnings: every planted warning is found on its loan (other warnings may also fire; none of the planted ones may be missed)
  for (const [n, codes] of batch.designed.warnings) {
    const found = byNumber.get(n)!.validations.filter((v) => v.severity === "warning" && v.result === "fail").map((v) => v.code);
    for (const c of codes) assert.ok(found.includes(c), `${n} should raise ${c} (found ${found.join(",") || "none"})`);
  }
  const warned = staged.filter((bl) => bl.validations.some((v) => v.severity === "warning" && v.result === "fail")).length;
  assert.ok(warned >= batch.designed.warnings.size && warned <= 60, `${warned} loans carry warnings`);
  assert.ok(Object.keys(card.hard).length >= 6 && card.hard_fail_rate === batch.designed.hard.size / 100, JSON.stringify(card.hard));
  // the transfer date has arrived and the final tape is reconciled: every validated loan boards; the exceptions do not
  const r = h.svc.board(h.batch.batch_id, { finalTapeReconciled: true });
  assert.equal(r.boarded.length, 100 - batch.designed.hard.size); assert.equal(r.refused.length, 0);
  assert.equal(h.events.ofType("loan.boarded").length, 94);
  // boarding derives delinquency from the history, never from a tape code (1.1-T5 rule): the 30/60/90 loans carry their FDCPA flag
  const boarded = r.boarded.map((bl) => bl.staged.transferor_loan_number);
  const flagged = r.boarded.filter((bl) => (bl.regx_days_delinquent_at_boarding ?? 0) > 0);
  assert.equal(flagged.length, boarded.filter((n) => byNumber.get(n)!.staged.next_due_date! < DEMO_BATCH.transfer_date).length);
  assert.ok(flagged.some((bl) => bl.fnma_delinquency_status_at_boarding && bl.fnma_delinquency_status_at_boarding !== "current"));
});

test("the committed fixture is what the generator produces (regenerate with tools/gen-transfer-batch.ts)", () => {
  const dir = fileURLToPath(new URL("../../../fixtures/transfer-batch-demo/", import.meta.url));
  if (!existsSync(dir + "manifest.json")) return;   // not generated yet in this checkout
  const manifest = JSON.parse(readFileSync(dir + "manifest.json", "utf8")) as { files: Record<string, { sha256: string; row_count: number }> };
  for (const [name, text] of Object.entries(files)) {
    assert.equal(createHash("sha256").update(text).digest("hex"), manifest.files[name]?.sha256, `${name} differs from the committed fixture`);
    assert.equal(readFileSync(dir + name, "utf8"), text, name);
  }
  assert.equal(manifest.files["boarding_tape.final.csv"]!.row_count, 100);
  const _k: keyof TransferBatchFiles = "boarding_tape.final.csv"; void _k;
});
