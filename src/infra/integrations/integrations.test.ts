/**
 * Integration framework tests: the outbox's idempotency and retry/fallback
 * behaviour, the codecs, and each fake's documented failure modes (spec
 * citations inline).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryOutbox, MemoryPortalTasks, Dispatcher, backoffMs, type OutboundAdapter } from "./outbox.ts";
import { TransientFailure, PermanentRejection, AdapterUnavailable } from "./failures.ts";
import { parseBai2, lockboxItems, Bai2Error } from "./codecs/bai2.ts";
import { buildNachaFile, parseAchReturns, returnRecord } from "./codecs/nacha.ts";
import { FakeFnmaLsdu, LsduOutboundAdapter, headOfLineBlocked, FakeFnmaServicingEvents, FakeFnmaSmdu, FakeFnmaP360, buildCrsFiles, FakeFnmaConnect } from "./fnma.ts";
import { FakeMers, minCheckDigitOk, verifyPostTransfer, FANNIE_MAE_ORG_ID } from "./mers.ts";
import { FakeCustodian, FakeEvault, WormViolation } from "./custody.ts";
import { LockboxIngestor, FakeLockbox, lockboxFileMissing, FakeCustodialBank, FakeOdfi, nextWindow } from "./banking.ts";
import { FakePrintMail, FakeEdelivery, FakeTelephony } from "./delivery.ts";
import { FakeMetro2, FakeEoscar, eoscarOutageRouting } from "./credit.ts";
import { FakeLpiTracking, FakeFlood, nfhlScreeningAllowed, FakeTaxService, FakeMi } from "./property.ts";
import { FakePacer, pacerMatchAccepted, FakeDmdc, dmdcOutcome, FakeErecording } from "./legal.ts";

const T0 = "2026-09-03T14:00:00.000Z";
const LAR = (loan: string, eventId: string, seq: number) => ({ fnmaLoanNumber: loan, eventId, sequence: seq, record: `96${loan.padEnd(10)}${"0".repeat(68)}`.slice(0, 80) });

test("outbox: the same idempotency key is enqueued once — 5.1 IT-7 'zero duplicates in files and outbox'", async () => {
  const outbox = new MemoryOutbox();
  const a = await outbox.enqueue({ adapter: "fnma-lsdu", idempotencyKey: "S1|L1|payment.contractual|2026-09-01|1", payload: [LAR("1234567890", "e1", 1)] }, T0);
  const b = await outbox.enqueue({ adapter: "fnma-lsdu", idempotencyKey: "S1|L1|payment.contractual|2026-09-01|1", payload: [LAR("1234567890", "e1", 1)] }, T0);
  assert.equal(a.duplicate, false); assert.equal(b.duplicate, true); assert.equal(a.message.id, b.message.id);
  assert.equal((await outbox.due("fnma-lsdu", T0)).length, 1);
});

test("dispatcher: transient failures back off and retry, then dead-letter into a human portal task; outages fall back immediately; rejections never retry", async () => {
  const outbox = new MemoryOutbox(); const tasks = new MemoryPortalTasks();
  const dispatcher = new Dispatcher(outbox, tasks, { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 600_000 });
  const lsdu = new FakeFnmaLsdu(); const adapter = new LsduOutboundAdapter(lsdu);
  const { message } = await outbox.enqueue({ adapter: "fnma-lsdu", idempotencyKey: "k1", payload: [LAR("1234567890", "e1", 1)] }, T0);
  lsdu.controls.failNext(2);
  const r1 = await dispatcher.deliver(adapter, message, T0);
  assert.equal(r1.outcome, "retry"); assert.equal(message.attempts, 1); assert.equal(message.nextAttemptAt, new Date(Date.parse(T0) + backoffMs(1)).toISOString());
  assert.equal((await outbox.due("fnma-lsdu", T0)).length, 0, "not due until the backoff elapses");
  const r2 = await dispatcher.deliver(adapter, message, message.nextAttemptAt!);
  assert.equal(r2.outcome, "retry"); assert.equal(backoffMs(2), 120_000);
  const r3 = await dispatcher.deliver(adapter, message, message.nextAttemptAt!);
  assert.equal(r3.outcome, "acked"); assert.equal(message.status, "acked"); assert.ok(message.ackedAt);
  // exhausted retries → dead + lsdu_file_upload task for the fnma_portal_operator
  const { message: m2 } = await outbox.enqueue({ adapter: "fnma-lsdu", idempotencyKey: "k2", payload: [LAR("1234567890", "e2", 2)] }, T0);
  lsdu.controls.failNext(10);
  let out = await dispatcher.deliver(adapter, m2, T0); out = await dispatcher.deliver(adapter, m2, T0); out = await dispatcher.deliver(adapter, m2, T0);
  assert.equal(out.outcome, "dead"); assert.equal(out.task?.kind, "lsdu_file_upload"); assert.equal(out.task?.ownerRole, "fnma_portal_operator"); assert.equal(m2.status, "dead");
  // declared outage → fallback on the first attempt
  lsdu.controls.failNext(0); lsdu.controls.setOutage(true);
  const { message: m3 } = await outbox.enqueue({ adapter: "fnma-lsdu", idempotencyKey: "k3", payload: [LAR("1234567890", "e3", 3)] }, T0);
  const r4 = await dispatcher.deliver(adapter, m3, T0);
  assert.equal(r4.outcome, "fallback"); assert.equal(m3.attempts, 1); assert.equal(tasks.tasks.length, 2);
  lsdu.controls.setOutage(false);
  // counterparty rejection → rejected, no retry, no task
  const { message: m4 } = await outbox.enqueue({ adapter: "fnma-lsdu", idempotencyKey: "k4", payload: [{ ...LAR("1234567890", "e4", 4), record: "too short" }] }, T0);
  const r5 = await dispatcher.deliver(adapter, m4, T0);
  assert.equal(r5.outcome, "rejected"); assert.equal(m4.status, "rejected"); assert.equal((m4.response as { code: string }).code, "LAR_FORMAT"); assert.equal(tasks.tasks.length, 2);
});

test("BAI2: lockbox detail parses into items with control totals verified; an altered total is refused", () => {
  const good = ["01,121000248,SM,260903,0700,1,,,2/", "02,SM,121000248,1,260903,,USD,2/", "03,4455667788,USD,010,50000000,,,015,52500000,,/", "16,165,158017,0,BR1,0012345678,LOCKBOX PMT/", "16,165,219257,0,BR2,0087654321,LOCKBOX PMT/", "88,CONTINUED/", "49,102877274,5/", "98,102877274,1,7/", "99,102877274,1,9/"].join("\n");
  const f = parseBai2(good);
  assert.equal(f.controlTotalCents, 102_877_274n);
  const items = lockboxItems(f);
  assert.deepEqual(items.map((i) => [i.sequence, i.amountCents, i.scanline]), [[1, 158_017n, "0012345678"], [2, 219_257n, "0087654321"]]);
  assert.throws(() => parseBai2(good.replace("49,102877274,5/", "49,102877275,5/")), Bai2Error);
  assert.throws(() => parseBai2(good.replace("99,102877274,1,9/", "99,102877274,1,8/")), /record count/);
});

test("lockbox ingest (2.1): replayed file is a duplicate; a re-sent file with changed items raises an exception instead of re-posting; missing-file alarm at 07:00 local", async () => {
  const content = ["01,121000248,SM,260903,0700,77,,,2/", "02,SM,121000248,1,260903,,USD,2/", "03,4455667788,USD/", "16,165,158017,0,BR1,0012345678,PMT/", "49,158017,3/", "98,158017,1,5/", "99,158017,1,7/"].join("\n");
  const ing = new LockboxIngestor();
  const first = ing.ingest(content);
  assert.equal(first.status, "ingested"); assert.equal(first.items.length, 1);
  assert.equal(ing.ingest(content).status, "duplicate");
  const changed = content.replace("158017,0,BR1", "158018,0,BR1").replace("49,158017,3/", "49,158018,3/").replace("98,158017,1,5/", "98,158018,1,5/").replace("99,158017,1,7/", "99,158018,1,7/");
  const second = ing.ingest(changed);
  assert.equal(second.status, "changed_items"); assert.deepEqual(second.changed, ["77:4455667788#1"]); assert.equal(second.items.length, 0);
  const box = new FakeLockbox(); box.post("lb.bai", content, T0);
  assert.equal((await box.fetch(T0)).length, 1); assert.equal((await box.fetch(T0)).length, 0);
  box.outage = true; await assert.rejects(box.fetch(T0), (e: unknown) => e instanceof AdapterUnavailable && e.fallbackKind === "bank_portal_download");
  assert.equal(lockboxFileMissing("2026-09-02", "2026-09-03", "06:59"), false);
  assert.equal(lockboxFileMissing("2026-09-02", "2026-09-03", "07:00"), true);
});

test("custodial bank statement: opening/closing ledger, credits/debits and the isolated interest credit (6.2/6.3)", async () => {
  const bai = ["01,121000248,SM,260903,0700,9,,,2/", "02,SM,121000248,1,260903,,USD,2/", "03,111,USD,010,1000000,,,015,1219257,,/", "16,165,219257,0,B1,,ACH SETTLEMENT/", "16,155,1234,0,B2,,INTEREST CREDIT/", "16,455,1234,0,B3,,FEE/", "49,2440982,5/", "98,2440982,1,7/", "99,2440982,1,9/"].join("\n");
  const bank = new FakeCustodialBank(); bank.post("111", "2026-09-03", bai);
  const s = await bank.priorDay("111", "2026-09-03");
  assert.equal(s.openingLedgerCents, 1_000_000n); assert.equal(s.closingLedgerCents, 1_219_257n);
  assert.equal(s.credits.length, 2); assert.equal(s.debits.length, 1); assert.equal(s.interestCreditCents, 1_234n);
});

test("Nacha: PPD debit file builds with valid 94-char records, the ODFI dedupes replays and rejects malformed files, returns/NOCs parse with R/C codes (2.3)", async () => {
  const file = buildNachaFile({ immediateDestination: " 121000248", immediateOrigin: "1234567890", fileDate: "2026-09-01", fileTime: "0900", fileIdModifier: "A",
    batches: [{ secCode: "PPD", companyName: "SUPERMORTGAGE", companyId: "1234567890", entryDescription: "MORTGAGE", effectiveDate: "2026-09-03", odfiRouting: "121000248",
      entries: [{ transactionCode: "27", routingNumber: "011000015", accountNumber: "123456", amountCents: 219_257n, individualId: "L-1", individualName: "BORROWER ONE", traceSequence: 1 }] }] });
  const lines = file.split("\n").filter(Boolean);
  assert.ok(lines.every((l) => l.length === 94), lines.map((l) => l.length).join(","));
  assert.equal(lines.length % 10, 0);
  assert.equal(lines[0]![0], "1"); assert.equal(lines[1]!.slice(0, 4), "5225"); assert.equal(lines[2]!.slice(0, 3), "627");
  const odfi = new FakeOdfi();
  const a1 = await odfi.transmit("ach.txt", file, T0); const a2 = await odfi.transmit("ach.txt", file, T0);
  assert.equal(a1.status, "accepted"); assert.equal(a1.duplicate, false); assert.equal(a2.duplicate, true);
  assert.equal((await odfi.transmit("bad.txt", file.replace("\n5225", "\n522"), T0)).status, "rejected");
  odfi.postReturns("2026-09-04T10:00:00.000Z", returnRecord({ transactionCode: "27", rdfi: "011000015", account: "123456", amountCents: 219_257n, individualId: "L-1", name: "BORROWER ONE", originalTrace: "121000240000001", code: "R01", returnDate: "2026-09-04" })
    + returnRecord({ transactionCode: "27", rdfi: "011000015", account: "123456", amountCents: 219_257n, individualId: "L-1", name: "BORROWER ONE", originalTrace: "121000240000001", code: "C01", returnDate: "2026-09-04", correctedData: "654321" }));
  const rets = await odfi.returns("2026-09-04");
  assert.deepEqual(rets.map((r) => [r.kind, r.code]), [["return", "R01"], ["noc", "C01"]]);
  assert.equal(rets[1]!.correctedData, "654321");
  assert.deepEqual(nextWindow(odfi.windows, "15:00"), { hhmm: "19:30", tomorrow: false });
  assert.deepEqual(nextWindow(odfi.windows, "20:00"), { hhmm: "10:30", tomorrow: true });
  assert.equal(parseAchReturns("").length, 0);
});

test("LSDU (5.1): per-record hard/soft/invalid feedback, the same file resubmitted is the same submission, head-of-line blocking on open hard rejects", async () => {
  const lsdu = new FakeFnmaLsdu({ rejects: { "2222222222": { kind: "hard", code: "LPI_MISMATCH", message: "LPI does not match Fannie Mae position" }, "3333333333": { kind: "soft", code: "INTEREST_VARIANCE", message: "expected interest differs", fnmaExpected: { interest: "135294" } } }, inactiveLoans: ["4444444444"] });
  const recs = [LAR("1111111111", "e1", 1), LAR("2222222222", "e2", 1), LAR("3333333333", "e3", 1), LAR("4444444444", "e4", 1)];
  const s1 = await lsdu.submitLarFile(recs, T0); const s2 = await lsdu.submitLarFile(recs, T0);
  assert.equal(s1.submissionId, s2.submissionId);
  const fb = await lsdu.feedback(s1.submissionId);
  assert.deepEqual(fb.map((f) => f.kind), ["accepted", "hard", "soft", "invalid"]);
  assert.deepEqual(fb[2]!.fnmaExpected, { interest: "135294" });
  assert.match(fb[3]!.message!, /readd_requests@fanniemae.com/);
  const open = fb.filter((f) => f.kind === "hard" || f.kind === "invalid").map((f) => ({ fnmaLoanNumber: f.fnmaLoanNumber, kind: f.kind, sequence: 1 }));
  assert.equal(headOfLineBlocked(open, { fnmaLoanNumber: "2222222222", sequence: 2 }), true);
  assert.equal(headOfLineBlocked(open, { fnmaLoanNumber: "3333333333", sequence: 2 }), false, "soft rejects do not block");
  assert.equal(headOfLineBlocked(open, { fnmaLoanNumber: "1111111111", sequence: 2 }), false);
});

test("Servicing Platform events (5.1): Accepted / Accepted with Warnings / Rejected with a fatal rule; UI CSV limits enforced", async () => {
  const se = new FakeFnmaServicingEvents({ fatal: { "e-bad": { code: "ESC-014", message: "reported balance ≠ prior balance + item" } }, warnings: { "e-warn": { code: "ESC-W01", message: "negative T&I balance" } } });
  const r = await se.submitEvents([{ eventId: "e-ok", fnmaLoanNumber: "1111111111", eventType: "escrow.deposit", body: {} }, { eventId: "e-warn", fnmaLoanNumber: "1111111111", eventType: "escrow.deposit", body: {} }, { eventId: "e-bad", fnmaLoanNumber: "1111111111", eventType: "escrow.deposit", body: {} }], T0);
  assert.deepEqual(r.responses.map((x) => x.status), ["accepted", "accepted_with_warnings", "rejected"]);
  assert.equal(r.responses[2]!.messages[0]!.severity, "fatal");
  const tooMany = Array.from({ length: 101 }, (_, i) => ({ eventId: `x${i}`, fnmaLoanNumber: "1111111111", eventType: "escrow.deposit", body: {} }));
  await assert.rejects(se.submitEvents(tooMany, T0), (e: unknown) => e instanceof PermanentRejection && e.code === "PER_LOAN_LIMIT");
});

test("SMDU / P360 / CRS / Connect: case lifecycle needs the Officer Signature Date to close; claims are idempotent by claim_number; CRS files split by servicer+settlement date with fixed positions; Connect pulls before refresh are transient", async () => {
  const smdu = new FakeFnmaSmdu();
  const c = await smdu.createCase("1111111111", "flex_mod", { upb: "24954677" });
  await assert.rejects(smdu.createCase("1111111111", "flex_mod", {}), (e: unknown) => e instanceof PermanentRejection && e.code === "CASE_OPEN");
  await smdu.decision(c.caseId); await smdu.reportTppPayment(c.caseId, { dueDate: "2026-10-01", receivedOn: "2026-10-01", amountCents: "150000" });
  await assert.rejects(smdu.close(c.caseId, ""), /Officer Signature Date/);
  assert.equal((await smdu.close(c.caseId, "2027-01-15")).status, "closed");
  const p360 = new FakeFnmaP360();
  const claim = await p360.submitClaim("CLM-1", "1111111111", [{ line: "attorney_fees", amount: "250000" }], T0);
  assert.equal((await p360.submitClaim("CLM-1", "1111111111", [], T0)).lines.length, 1);
  p360.advance("CLM-1", "psa", "2026-09-10T00:00:00.000Z");
  assert.equal((await p360.claimStatus("CLM-1")).status, "psa"); assert.equal(claim.history.length, 2);
  const files = buildCrsFiles([{ servicerNumber: "123456789", remittanceCode: "001", fnmaLoanNumber: "1111111111", amountCents: 21_925_700n, settlementDate: "2026-09-04" }, { servicerNumber: "123456789", remittanceCode: "311", fnmaLoanNumber: "2222222222", amountCents: 100n, settlementDate: "2026-09-05" }]);
  assert.equal(files.length, 2);
  const line = files[0]!.content.split("\n")[0]!;
  assert.equal(line.length, 48); assert.equal(line.slice(0, 9), "123456789"); assert.equal(line.slice(9, 13), "0001"); assert.equal(line.slice(13, 28).trim(), "1111111111"); assert.equal(line.slice(28, 38), "0021925700"); assert.equal(line.slice(38, 46), "20260904");
  const connect = new FakeFnmaConnect();
  await assert.rejects(connect.pull("loan_activity_summary", "2026-09-03"), TransientFailure);
  connect.seed("loan_activity_summary", "2026-09-03", [{ accepted: "500", hard_rejected: "1" }]);
  assert.equal((await connect.pull("loan_activity_summary", "2026-09-03")).rows[0]!["hard_rejected"], "1");
});

test("MERS (1.5): MIN check digit, registration/TOS confirm flow, rejects on bad MINs and non-servicer TOS, post-transfer verification", async () => {
  const mers = new FakeMers();
  const min = "10001230000000001"; const good = min + (() => { for (let d = 0; d < 10; d++) if (minCheckDigitOk(min + d)) return String(d); return "0"; })();
  assert.equal(minCheckDigitOk(good), true); assert.equal(minCheckDigitOk(good.slice(0, 17) + ((Number(good[17]) + 1) % 10)), false);
  const partner = "1000123", sm = "1000999";
  let r = await mers.submitBatch([{ txnId: "t1", min: good, type: "registration", effectiveDate: "2026-09-01", orgId: "1000555" }, { txnId: "t2", min: "123", type: "registration", effectiveDate: "2026-09-01", orgId: "1000555" }], T0);
  assert.deepEqual(r.results.map((x) => x.status), ["accepted", "rejected"]); assert.equal(r.results[1]!.rejectCode, "MIN_INVALID");
  r = await mers.submitBatch([{ txnId: "t3", min: good, type: "tos_initiate", effectiveDate: "2026-10-01", orgId: partner, counterpartyOrgId: partner }], T0);
  assert.equal(r.results[0]!.rejectCode, "NOT_SERVICER");
  r = await mers.submitBatch([{ txnId: "t4", min: good, type: "tos_initiate", effectiveDate: "2026-10-01", orgId: "1000555", counterpartyOrgId: partner }], T0);
  assert.equal(r.results[0]!.status, "pending_confirmation");
  assert.equal((await mers.pendingTransfers(partner)).length, 1);
  r = await mers.submitBatch([{ txnId: "t5", min: good, type: "tos_confirm", effectiveDate: "2026-10-01", orgId: partner }, { txnId: "t6", min: good, type: "min_update_subservicer", effectiveDate: "2026-10-01", orgId: sm }], T0);
  assert.deepEqual(r.results.map((x) => x.status), ["accepted", "accepted"]);
  const snap = (await mers.queryMin(good))!;
  assert.deepEqual(verifyPostTransfer(snap, partner, sm), []);
  assert.equal(snap.investorOrgId, FANNIE_MAE_ORG_ID);
  assert.deepEqual(verifyPostTransfer({ ...snap, subservicerOrgId: null }, partner, sm), [`subservicer none ≠ ${sm}`]);
  mers.outage = true; await assert.rejects(mers.queryMin(good), AdapterUnavailable);
});

test("custodian and e-vault (1.4): trial balance idempotent by batch+hash; documents held under SHA-256, WORM (no overwrite), tamper detected, legal hold blocks disposal", async () => {
  const cust = new FakeCustodian();
  const rows = [{ fnmaLoanNumber: "1111111111", noteDate: "2021-07-15", originalUpbCents: 26_000_000n }];
  const a = await cust.sendTrialBalance("B1", rows, T0); const b = await cust.sendTrialBalance("B1", rows, T0);
  assert.equal(a.duplicate, false); assert.equal(b.duplicate, true); assert.equal(a.receiptId, b.receiptId);
  await assert.rejects(cust.requestDocuments("1111111111", "2009", ["note"], T0), (e: unknown) => e instanceof PermanentRejection && e.code === "NOT_HELD");
  cust.seed({ fnmaLoanNumber: "1111111111", custodianLoanId: "C1", status: "certified", exceptions: [], documents: ["note", "mortgage"] });
  assert.equal((await cust.requestDocuments("1111111111", "2009", ["note"], T0)).expectedBy, "2026-09-08");
  await cust.releaseRequest("1111111111", "payoff", T0);
  await assert.rejects(cust.releaseRequest("1111111111", "payoff", T0), (e: unknown) => e instanceof PermanentRejection && e.code === "ALREADY_RELEASED");
  const vault = new FakeEvault();
  const s1 = await vault.store("NOTE PDF BYTES", { contentType: "application/pdf", retentionClass: "life_of_loan_plus_4y" }, T0);
  const s2 = await vault.store("NOTE PDF BYTES", { contentType: "application/pdf", retentionClass: "life_of_loan_plus_4y" }, "2026-09-04T00:00:00.000Z");
  assert.equal(s2.duplicate, true); assert.equal(s2.storedAt, T0, "second store never overwrites the first");
  assert.equal(await vault.verify(s1.sha256), "intact");
  vault.tamper(s1.sha256); assert.equal(await vault.verify(s1.sha256), "tampered");
  await assert.rejects(vault.dispose(s1.sha256, T0, "2031-01-01"), WormViolation);
  await vault.placeLegalHold(s1.sha256);
  assert.equal(await vault.dispose(s1.sha256, "2032-01-01T00:00:00.000Z", "2031-01-01"), "held");
});

test("print/mail and e-delivery (7.x, 9.2): jobs dedupe by id, production run stamps mailed/proof, returned mail feeds back; electronic send needs a consent id and hard bounces report", async () => {
  const pm = new FakePrintMail();
  const job = { jobId: "J1", noticeId: "N1", template: "NTC_REGX_1024_39B_EARLY_INTERVENTION", recipient: { name: "B", address: "1 Test St" }, pages: 2, separateDocument: true };
  assert.equal((await pm.submit(job, T0)).duplicate, false); assert.equal((await pm.submit(job, T0)).duplicate, true);
  await assert.rejects(pm.submit({ ...job, jobId: "J2", recipient: { name: "B", address: " " } }, T0), (e: unknown) => e instanceof PermanentRejection && e.code === "ADDRESS_MISSING");
  assert.equal(await pm.cancel("J1", T0), "cancelled");
  await pm.submit({ ...job, jobId: "J3" }, T0);
  pm.runProduction("2026-09-04T13:00:00.000Z");
  const s = await pm.status("J3"); assert.equal(s.status, "mailed"); assert.equal(s.proofOfMailingId, "POM-J3"); assert.equal(await pm.cancel("J3", T0), "too_late");
  pm.markReturned("J3", "2026-09-12T00:00:00.000Z", "NIXIE: no such number");
  assert.deepEqual((await pm.returns("2026-09-10")).map((r) => r.noticeId), ["N1"]);
  const ed = new FakeEdelivery(); ed.bouncing.add("bad@example.com");
  await assert.rejects(ed.send({ messageId: "M1", noticeId: "N1", channel: "email", to: "a@example.com", subject: "s", consentId: "" }, T0), (e: unknown) => e instanceof PermanentRejection && e.code === "NO_CONSENT");
  assert.equal((await ed.send({ messageId: "M1", noticeId: "N1", channel: "email", to: "a@example.com", subject: "s", consentId: "c1" }, T0)).status, "sent");
  assert.equal((await ed.send({ messageId: "M2", noticeId: "N2", channel: "email", to: "bad@example.com", subject: "s", consentId: "c1" }, T0)).status, "bounced");
});

test("telephony (11.1): machine answer leaves the limited-content message only on debt-collector loans; line type and reassigned-number checks", async () => {
  const tel = new FakeTelephony(); tel.outcomeFor = () => "machine";
  const dc = await tel.dial({ attemptId: "a1", to: "+15551234567", mode: "ai_voice", fdcpaDebtCollector: true, limitedContentMessage: "LCM", identifiedMessage: "ID" }, T0);
  const non = await tel.dial({ attemptId: "a2", to: "+15551234567", mode: "ai_voice", fdcpaDebtCollector: false, identifiedMessage: "ID" }, T0);
  const nonNoMsg = await tel.dial({ attemptId: "a3", to: "+15551234567", mode: "ai_voice", fdcpaDebtCollector: false }, T0);
  assert.deepEqual([dc.messageLeft, non.messageLeft, nonNoMsg.messageLeft], ["limited_content", "identified", "none"]);
  tel.lines.set("+15551234567", "mobile"); tel.reassigned.set("+15551234567", "2026-06-01");
  assert.equal(await tel.lineType("+15551234567"), "mobile");
  assert.equal((await tel.reassignedSince("+15551234567", "2026-01-01")).reassigned, true);
  assert.equal((await tel.reassignedSince("+15551234567", "2026-07-01")).reassigned, false);
  tel.outage = true; await assert.rejects(tel.dial({ attemptId: "a4", to: "+1", mode: "human_voice", fdcpaDebtCollector: false }, T0), (e: unknown) => e instanceof AdapterUnavailable && e.fallbackKind === "human_dialer_failover");
});

test("Metro 2 and e-OSCAR (8.1/8.2): per-bureau transmission with dedupe and acks; ACDV responses validate before submit; AUDs cannot create records; 8.2-T11 outage routing", async () => {
  const m2 = new FakeMetro2();
  const file = "HEADER...\nBASE...\nTRAILER...";
  const t1 = await m2.transmit("experian", "m2.txt", file, T0); const t2 = await m2.transmit("experian", "m2.txt", file, T0);
  assert.equal(t2.duplicate, true); assert.equal((await m2.ack("experian", t1.fileId))!.status, "accepted");
  await assert.rejects(m2.transmit("equifax", "x", "BASE only", T0), (e: unknown) => e instanceof PermanentRejection && e.code === "METRO2_STRUCTURE");
  m2.outages.add("innovis"); await assert.rejects(m2.transmit("innovis", "m2.txt", file, T0), AdapterUnavailable);
  const eo = new FakeEoscar();
  eo.post({ controlNumber: "C1", bureau: "experian", consumer: { name: "B", ssnLast4: "1234" }, accountNumber: "A1", disputeCodes: ["112"], receivedAt: T0, responseDueOn: "2026-09-17", images: [], fcraRelevantInfo: false });
  assert.equal((await eo.findAcdvs("2026-09-01")).length, 1);
  assert.deepEqual(await eo.validateAcdvResponse({ controlNumber: "C1", responseCode: "99", accountFields: {} }), { valid: false, errors: ["response code 99 not in the ACDV response code table", "a modifying response must carry the corrected account fields"] });
  await assert.rejects(eo.submitAcdvResponse({ controlNumber: "C1", responseCode: "99", accountFields: {} }, T0), PermanentRejection);
  assert.equal((await eo.submitAcdvResponse({ controlNumber: "C1", responseCode: "01", accountFields: {} }, T0)).duplicate, false);
  assert.equal((await eo.submitAcdvResponse({ controlNumber: "C1", responseCode: "01", accountFields: {} }, T0)).duplicate, true);
  assert.equal((await eo.findAcdvs("2026-09-01")).length, 0, "answered ACDVs leave the inbox");
  await assert.rejects(eo.submitAud({ audId: "U1", bureau: "experian", accountNumber: "A1", fields: { create_record: "true" }, reason: "x" }, T0), /may not be used to add or create/);
  assert.equal(eoscarOutageRouting("2026-09-04", "2026-09-03"), "human_web_app");
  assert.equal(eoscarOutageRouting("2026-09-10", "2026-09-03"), "wait_for_api");
  eo.outage = true; await assert.rejects(eo.findAcdvs(T0), (e: unknown) => e instanceof AdapterUnavailable && e.fallbackKind === "eoscar_web_entry");
});

test("insurance tracking / flood / tax / MI (9.x, 3.7, 10.x, 15.3): inbound dedupe by vendor key, LPI bind-once and pro-rata refund, flood certificate idempotency and map changes, NFHL screening only, tax delete idempotent, MI claim needs a NOD", async () => {
  const lpi = new FakeLpiTracking();
  const msg = { vendorLoanId: "V1", policyId: "P1", type: "policy_snapshot" as const, vendorSequence: 7, carrier: "ACME", coverageCents: 30_000_000n, deductibleCents: 250_000n, effectiveOn: "2026-01-01", expiresOn: "2027-01-01" };
  lpi.post(msg); lpi.post(msg); lpi.post({ ...msg, vendorSequence: 8, type: "cancellation", cancelledOn: "2026-09-01" });
  const inbound = await lpi.inbound("2026-09-01");
  assert.deepEqual(inbound.map((m) => m.vendorSequence), [7, 8]);
  const b = await lpi.bind("V1", 30_000_000n, "2026-09-16", T0);
  assert.equal(b.annualPremiumCents, 750_000n);
  await assert.rejects(lpi.bind("V1", 1n, "2026-09-17", T0), (e: unknown) => e instanceof PermanentRejection && e.code === "ALREADY_BOUND");
  const cancelled = await lpi.cancel(b.bindingId, "2026-10-16", T0);   // 30 days earned
  assert.equal(cancelled.refundCents, 750_000n - 750_000n * 30n / 365n);
  const flood = new FakeFlood(); flood.zoneFor = (a) => (a.includes("Bayou") ? { zone: "AE", sfha: true } : { zone: "X", sfha: false });
  const d1 = await flood.orderDetermination("PR1", "1 Bayou Rd", T0); const d2 = await flood.orderDetermination("PR1", "1 Bayou Rd", T0);
  assert.equal(d1.certificateId, d2.certificateId); assert.equal(d1.sfha, true);
  await assert.rejects(flood.transferLifeOfLoan(d1.certificateId, "X"), (e: unknown) => e instanceof PermanentRejection && e.code === "NOT_ENROLLED");
  await flood.enrollLifeOfLoan(d1.certificateId); flood.publishMapChange(d1.certificateId, "X", false, "2026-12-01", "2026-09-05T00:00:00.000Z");
  assert.equal((await flood.mapChanges("2026-09-04")).length, 1);
  assert.equal(nfhlScreeningAllowed("determination"), false); assert.equal(nfhlScreeningAllowed("screening"), true);
  flood.outage = true; await assert.rejects(flood.orderDetermination("PR2", "x", T0), (e: unknown) => e instanceof AdapterUnavailable && e.fallbackKind === "fema_nfhl_screening_only");
  const tax = new FakeTaxService();
  assert.equal((await tax.delete("PARCEL-1", "paid_in_full", T0)).duplicate, false); assert.equal((await tax.delete("PARCEL-1", "paid_in_full", T0)).duplicate, true);
  const mi = new FakeMi(); mi.certificates.add("CERT-1");
  assert.equal((await mi.requestCancellation("CERT-9", "automatic_78", "2026-10-01", T0)).status, "rejected");
  assert.equal((await mi.requestCancellation("CERT-1", "automatic_78", "2026-10-01", T0)).status, "accepted");
  await assert.rejects(mi.fileClaim("CERT-1", "MIC-1", [], T0), (e: unknown) => e instanceof PermanentRejection && e.code === "NO_NOD");
  await mi.notifyDefault("CERT-1", "2026-03-01", T0);
  assert.equal((await mi.fileClaim("CERT-1", "MIC-1", [], T0)).status, "pending"); assert.equal((await mi.fileClaim("CERT-1", "MIC-1", [], T0)).duplicate, true);
  mi.decide("MIC-1", "curtailed", 5_000_000n, "attorney fees over allowable");
  assert.equal((await mi.claimStatus("MIC-1")).benefitCents, 5_000_000n);
});

test("PACER / DMDC / e-recording (14.1, 13.8, 16.3): SSN-only queries rejected and matches need SSN4+last name; DMDC X/Z are unknown and outages postpone the sale; e-recording packages idempotent by (task, attempt) with recorder rejects", async () => {
  const pacer = new FakePacer();
  pacer.parties.push({ caseNumber: "26-10001", court: "txnb", chapter: 13, lastName: "Borrower", firstName: "Bea", ssn4: "1234", dateFiled: "2026-08-20", status: "open" });
  await assert.rejects(pacer.partiesFind({ ssn: "123456789", dateFiledFrom: "2018-01-01" }), (e: unknown) => e instanceof PermanentRejection && e.code === "SSN_ONLY");
  const { reportId } = await pacer.partiesFind({ lastName: "borrower", ssn4: "1234", dateFiledFrom: "2018-01-01" });
  const hits = await pacer.reportDownload(reportId);
  assert.equal(hits.length, 1); assert.equal(pacerMatchAccepted(hits[0]!, { lastName: "BORROWER", ssn4: "1234" }), true); assert.equal(pacerMatchAccepted(hits[0]!, { lastName: "Borrower", ssn4: "9999" }), false);
  await pacer.deleteReport(reportId); assert.equal(await pacer.reportStatus(reportId), "failed");
  const dmdc = new FakeDmdc(); dmdc.activeDuty.set("soldier|4321", { start: "2026-01-01", end: null }); dmdc.mismatchNames.add("nomatch");
  const batch = await dmdc.buildBatch([{ requestId: "r1", lastName: "Soldier", firstName: "S", ssn: "000004321", activeDutyStatusDate: "2026-09-01" }, { requestId: "r2", lastName: "Civilian", firstName: "C", ssn: "000001111", activeDutyStatusDate: "2026-09-01" }, { requestId: "r3", lastName: "NoMatch", firstName: "N", activeDutyStatusDate: "2026-09-01" }, { requestId: "r4", lastName: "Soldier", firstName: "S", ssn: "000004321", activeDutyStatusDate: "2025-06-01" }], T0);
  assert.equal(batch.rows, 4);
  const results = await dmdc.ingestResults(batch.batchId, "");
  assert.deepEqual(results.map((r) => [r.status, dmdcOutcome(r)]), [["active_duty", "protected"], ["not_active", "clear"], ["Z", "unknown"], ["X", "unknown"]]);
  dmdc.outage = true; await assert.rejects(dmdc.singleLookup({ requestId: "r5", lastName: "S", firstName: "S", activeDutyStatusDate: "2026-09-01" }), (e: unknown) => e instanceof AdapterUnavailable && e.fallbackKind === "postpone_sale_pending_dmdc");
  const er = new FakeErecording();
  await assert.rejects(er.createPackage({ releaseTaskId: "RT1", attempt: 1, county: "Nowhere", state: "TX", documentSha256: "a".repeat(64) }, T0), (e: unknown) => e instanceof PermanentRejection && e.code === "COUNTY_NOT_COVERED");
  const p1 = await er.createPackage({ releaseTaskId: "RT1", attempt: 1, county: "Dallas", state: "TX", documentSha256: "a".repeat(64) }, T0);
  assert.equal((await er.createPackage({ releaseTaskId: "RT1", attempt: 1, county: "Dallas", state: "TX", documentSha256: "a".repeat(64) }, T0)).duplicate, true);
  er.rejectFor = (p) => (p.attempt === 1 ? "legal description illegible" : null);
  assert.equal((await er.submit(p1.packageId, T0)).status, "rejected");
  const p2 = await er.createPackage({ releaseTaskId: "RT1", attempt: 2, county: "Dallas", state: "TX", documentSha256: "b".repeat(64) }, T0);
  const rec = await er.submit(p2.packageId, "2026-09-05T15:00:00.000Z");
  assert.equal(rec.status, "recorded"); assert.ok(rec.instrumentNumber); assert.equal(rec.feeCents, 3_400n);
});
