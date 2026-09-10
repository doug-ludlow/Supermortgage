/**
 * §13 tool paths on the bus: the SCRA protection gate asserted by
 * `attorney.instruction.send` opens the day after the tail (13.8-T4/T11 on
 * the tool path, not only the calculators) and every refusal leaves its trail
 * (evaluation row, `foreclosure.gate.refused{command, code}`, sev 1), the
 * SCRA late-charge waiver is the 2.7 `fees` rows (never the caller's figure),
 * `dmdc.verify` holds instead of fabricating a certificate when the adapter is
 * missing or down and its Y result governs the review and the SCRA gate
 * (13.4-T5 on the bus), `bk.scrub` opens the `bk_stay` hold on a hit
 * (13.4-T10), a low-confidence model item routes to a human_agent whose own
 * entry resolves it (13.4-T8), `foreclosure.gates.evaluate(loan_id, step)`
 * reads the counters/occupancy/state from the loan row only and writes
 * evaluation rows plus the 13.1 decision record, and the 13.3 bid is
 * `totalIndebtedness()`/`bid()` over store facts (the model never edits amounts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { GateClosed } from "../../app/evaluators.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { SECTION_13_TOOLS } from "../../app/tools/section13.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeDmdc, FakePacer } from "../../infra/integrations/legal.ts";

const AGENT: Actor = { kind: "agent", id: "foreclosure-ops" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const ATTORNEY: Actor = { kind: "human", id: "u-attorney", role: "attorney" };
const ANALYST: Actor = { kind: "human", id: "u-analyst", role: "ops_analyst" };
const HUMAN_AGENT: Actor = { kind: "human", id: "u-specialist", role: "human_agent" };

function uow(now = "2026-09-03T09:00:00.000Z", loanId = "L-13"): UowContext & { decisions: DecisionInput[]; clock: FixedClock } {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: (d) => { decisions.push({ loanId, ...d }); }, decisions };
}
function harness(ports: ToolRuntime["ports"] = {}, now?: string) {
  const ctx = uow(now); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, SECTION_13_TOOLS); const bus = new CommandBus(agents);
  const run = (process: string, name: string, actor: Actor, input: Record<string, unknown>, at?: string) => bus.execute(cmds.get(toolKey(process, name))!, actor, input, ctx, at ? { now: at } : {});
  const types = (from = 0) => ctx.events.all().slice(from).map((e) => e.type);
  const put = (kind: string, id: string, data: Record<string, unknown>) => rt.store.put(kind, id, data, OFFICER, ctx.clock.now());
  return { ctx, rt, run, types, put };
}
const refused = (code: string) => (e: unknown) => e instanceof CommandRefused && e.code === code;
const gateClosed = (code: string) => (e: unknown) => e instanceof GateClosed && e.ref === code;
type Wrapped<T> = { result: T; item: { item_code: string; result: string; evaluator: string; evidence_ids: string[]; caller_result_ignored?: string } | null; review: { id: string; outcome: string | null; pending_human: string[] } };

test("13.8 tool path: the SCRA gate closes on open, stays closed through protection_ends_on, and opens the day after with scra.case.closed{tail_expired} — never by the agent; the late-charge waiver is the 2.7 fees rows and every refusal leaves its trail", async () => {
  const h = harness({}, "2026-06-03T12:00:00.000Z");
  // 2.7 fee rows: one late charge assessed after the call to duty (waived), one before it and one already collected (not)
  h.put("fees", "fee-pre", { loan_id: "L-13", fee_type: "late_charge", assessed_on: "2026-03-01", amount_cents: "5000", state: "assessed" });
  h.put("fees", "fee-apr", { loan_id: "L-13", fee_type: "late_charge", assessed_on: "2026-04-17", amount_cents: "8186", state: "assessed" });
  h.put("fees", "fee-may", { loan_id: "L-13", fee_type: "late_charge", assessed_on: "2026-05-17", amount_cents: "8186", state: "collected", collected_cents: "8186" });
  // 13.9 guardrail: the waiver amount is never the caller's
  await assert.rejects(h.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-13", op: "open", dmdc_status: "Y", origination_on: "2024-03-01", service_begin_on: "2026-03-15", late_charges_since_service_cents: 99_999_999n }), refused("NO_MODEL_LATE_CHARGE_FIGURE"));
  const opened = await h.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-13", op: "open", dmdc_status: "Y", origination_on: "2024-03-01", service_begin_on: "2026-03-15", verified_on: "2026-06-03", firm_id: "F-1" });
  const o = opened.output as { gate: string; status_code: string; late_charges_waived_cents: bigint; late_charge_fee_ids: string[]; firm_instruction: { kind: string; due: string; instruction_id: string }; ledger_set_id: string | null; basis: string; pre_service_obligation: boolean; case_id: string };
  assert.equal(o.gate, "closed"); assert.equal(o.status_code, "32"); assert.equal(o.firm_instruction.kind, "SCRA_STAY"); assert.equal(o.firm_instruction.due, "2026-06-04");
  assert.equal(o.late_charges_waived_cents, 8_186n, "only the outstanding late charge assessed after service began"); assert.deepEqual(o.late_charge_fee_ids, ["fee-apr"]);
  // 13.8-T3 consequences are written, not only returned: the firm instruction row + event, status 32 queued for 5.x, the late-charge waiver posted; the case row carries the 0015 columns
  assert.equal(h.rt.store.get("attorney_instructions", o.firm_instruction.instruction_id)!.data.kind, "SCRA_STAY");
  assert.ok(h.types().includes("attorney.instruction.sent")); assert.ok(h.types().includes("delinquency.status_code.queued")); assert.ok(h.types().includes("late_charges.waived")); assert.ok(h.types().includes("scra.stay.granted"));
  assert.equal(h.ctx.ledger.sets().length, 1); assert.ok(o.ledger_set_id); const lines = h.ctx.ledger.sets()[0]!.lines; assert.equal(lines.reduce((s, l) => s + l.amountCents, 0n), 0n, "balanced"); assert.ok(lines.every((l) => l.ruleRef === "13.8.D2-3.4-01.late_charge_waiver")); assert.equal(lines[0]!.amountCents, 8_186n);
  const row = h.rt.store.get("scra_cases", "scra-L-13")!.data; assert.equal(row.basis, "dmdc"); assert.equal(row.pre_service_obligation, true); assert.equal(row.case_id, "scra-L-13"); assert.equal(row.status, "open_active_duty"); assert.ok(row.fc_stay_granted_at); assert.equal(row.gate, undefined, "no columns outside the 0015 scra_cases shape");
  // on duty: RESUME refused by the gate — with the refusal trail (13.1 Outputs; 13.2 "refused; sev 1")
  const before = h.ctx.events.all().length;
  await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "RESUME" }), gateClosed("SCRA_3953C_FC_PROTECTION_GATE"));
  const refusal = h.ctx.events.all().slice(before).find((e) => e.type === "foreclosure.gate.refused")!; assert.equal(refusal.payload.code, "SCRA_3953C_FC_PROTECTION_GATE"); assert.equal(refusal.payload.command, "attorney.instruction.send{kind=RESUME}"); assert.equal(refusal.payload.step, "judgment_motion");
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "sev1" && e.ownerRole === "compliance_sentinel" && e.payload.gate === "SCRA_3953C_FC_PROTECTION_GATE"));
  assert.ok(h.rt.store.list("foreclosure_gate_evaluations").some((e) => e.data.gate_code === "SCRA_3953C_FC_PROTECTION_GATE" && e.data.result === "closed" && e.data.step === "judgment_motion"));
  assert.ok(!h.types(before).includes("attorney.instruction.sent"), "no message leaves for the attorney network");
  // the agent can never open the gate; the attorney records a court order at Fannie Mae's direction (13.8 guardrail) — checked below after the tail
  await assert.rejects(h.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-13", op: "gate_exception", basis: "court_order_at_fnma_direction", document_id: "ord-1", fnma_direction_document_id: "dir-1" }), refused("GATE_EXCEPTION_IS_ATTORNEYS"));
  await assert.rejects(h.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-13", op: "close", service_end_on: "2027-02-28" }), refused("CANNOT_OPEN_GATE"));
  await assert.rejects(h.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-13", op: "get", court_order_at_fnma_direction: true }), refused("CANNOT_OPEN_GATE"), "the exception is never a caller flag");
  // service ends Feb. 28, 2027 on orders: protection through Feb. 28, 2028 inclusive (13.8-T4)
  const closed = await h.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-13", op: "close", service_end_on: "2027-02-28", orders_document_id: "orders-1" }, "2027-03-02T12:00:00.000Z");
  assert.equal((closed.output as { status: string; protection_ends_on: string }).status, "open_tail_12m"); assert.equal((closed.output as { protection_ends_on: string }).protection_ends_on, "2028-02-28");
  for (const on of ["2027-12-01", "2028-02-28"]) await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "RESUME" }, `${on}T12:00:00.000Z`), gateClosed("SCRA_3953C_FC_PROTECTION_GATE"), `closed on ${on}`);
  assert.ok(!h.types().includes("scra.case.closed"), "no closure while the tail runs");
  // the day after: the sweep closes the case, the gate opens, RESUME goes out
  const mark = h.ctx.events.all().length;
  const resumed = await h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "RESUME" }, "2028-02-29T12:00:00.000Z");
  assert.equal((resumed.output as { kind: string }).kind, "RESUME");
  const after = h.types(mark); assert.ok(after.includes("scra.case.closed")); assert.ok(after.includes("foreclosure.gate.opened")); assert.ok(after.includes("attorney.instruction.sent"));
  const closedEvent = h.ctx.events.all().find((e) => e.type === "scra.case.closed")!; assert.equal(closedEvent.payload.reason, "tail_expired"); assert.equal(closedEvent.payload.gate_opens_on, "2028-02-29");
  const gateEvent = h.ctx.events.all().find((e) => e.type === "foreclosure.gate.opened")!; assert.equal(gateEvent.payload.code, "SCRA_3953C_FC_PROTECTION_GATE"); assert.equal(gateEvent.payload.reason, "tail_expired");
  assert.equal(h.rt.store.get("scra_cases", "scra-L-13")!.data.status, "closed");
  assert.equal(h.rt.store.list("foreclosure_gate_evaluations").filter((e) => e.data.reason_code === "tail_expired").length, 1, "the gate opening carries its evaluation row");
  assert.ok(h.rt.store.list("foreclosure_gate_evaluations").every((e) => e.data.result === "open" || e.data.result === "closed"), "0015 shape: result ∈ {open, closed}");
  // Mar. 1, 2028 (the spec's date) is open too; `get` on a closed case returns it as closed
  await h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "CERTIFY_SALE" }, "2028-03-01T12:00:00.000Z");
  assert.equal(((await h.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-13", op: "get" }, "2028-03-01T12:00:00.000Z")).output as { status: string }).status, "closed");
});

test("13.8-T11 tool path: a 2027-06-01 service end keeps the gate closed on 2028-05-31 and 2028-06-01 and opens it on 2028-06-02; the attorney's court order at Fannie Mae's direction opens it earlier", async () => {
  const h = harness({}, "2026-06-03T12:00:00.000Z");
  await h.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-13", op: "open", dmdc_status: "Y", origination_on: "2024-03-01", service_begin_on: "2026-03-15" });
  await h.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-13", op: "close", service_end_on: "2027-06-01", dmdc_certificate_id: "cert-left-active-duty" }, "2027-06-05T12:00:00.000Z");
  for (const on of ["2028-05-31", "2028-06-01"]) await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "CERTIFY_SALE" }, `${on}T12:00:00.000Z`), (e: unknown) => e instanceof GateClosed, `closed on ${on}`);
  await h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "CERTIFY_SALE" }, "2028-06-02T12:00:00.000Z");
  assert.equal(h.ctx.events.all().find((e) => e.type === "scra.case.closed")!.payload.gate_opens_on, "2028-06-02");
  // court order at Fannie Mae's direction on a second loan still on duty: recorded by the attorney as the gate's evaluation row, opens the gate without ending the period
  const h2 = harness({}, "2026-06-03T12:00:00.000Z");
  await h2.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-13", op: "open", dmdc_status: "Y", origination_on: "2024-03-01", service_begin_on: "2026-03-15" });
  await assert.rejects(h2.run("13.8", "scra.case.get/open/close", ATTORNEY, { loan_id: "L-13", op: "gate_exception", basis: "borrower_consent", document_id: "x" }), refused("CANNOT_OPEN_GATE"));
  const exc = await h2.run("13.8", "scra.case.get/open/close", ATTORNEY, { loan_id: "L-13", op: "gate_exception", basis: "court_order_at_fnma_direction", document_id: "ord-1", fnma_direction_document_id: "dir-1" }, "2026-09-01T12:00:00.000Z");
  assert.equal((exc.output as { gate: string; status: string; court_order_at_fnma_direction: boolean }).gate, "open"); assert.equal((exc.output as { status: string }).status, "open_active_duty", "the service period is not ended by the order"); assert.equal((exc.output as { court_order_at_fnma_direction: boolean }).court_order_at_fnma_direction, true);
  assert.equal(h2.ctx.events.all().find((e) => e.type === "foreclosure.gate.opened")!.payload.reason, "court_order_at_fnma_direction");
  const ev = h2.rt.store.list("foreclosure_gate_evaluations").find((e) => e.data.reason_code === "court_order_at_fnma_direction")!; assert.equal(ev.data.result, "open"); assert.equal((ev.data.inputs as { case_id: string }).case_id, "scra-L-13");
  assert.equal(h2.rt.store.get("scra_cases", "scra-L-13")!.data.court_order_at_fnma_direction, undefined, "the exception fact lives on the evaluation row, not on a column 0015 lacks");
  await h2.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "RESUME" }, "2026-09-02T12:00:00.000Z");
});

test("13.4 dmdc.verify: no adapter or an outage holds the review (hold_scra + portal task) and never emits a verification; a wired adapter verifies, stores the scra_verifications row, and its Y governs the checklist item, the review outcome and the SCRA gate (13.4-T5 on the bus)", async () => {
  const none = harness({});
  const r = (await none.run("13.4", "dmdc.verify", AGENT, { loan_id: "L-13", last_name: "Borrower" })).output as Wrapped<{ status: string; outcome: string; certificate_id: null; escalation_id: string }>;
  assert.equal(r.result.status, "unavailable"); assert.equal(r.result.outcome, "hold_scra"); assert.equal(r.result.certificate_id, null); assert.equal(r.item!.result, "fail", "never refer on stale data");
  assert.ok(!none.types().includes("dmdc.verification.completed"), "no fabricated certificate"); assert.ok(none.types().includes("prereferral.hold.opened"));
  assert.equal(none.rt.escalations.opened[0]!.kind, "human_portal_task"); assert.equal(none.rt.escalations.opened[0]!.payload.kind, "dmdc_batch");
  assert.equal(none.rt.store.list("scra_verifications").length, 0);
  const dmdc = new FakeDmdc(); dmdc.activeDuty.set("borrower|6789", { start: "2026-03-15", end: null });   // FakeDmdc keys on last name + SSN last 4
  const wired = harness({ dmdc });
  // the caller's `item_result: "pass"` (with evidence) cannot record a Y as pass — the adapter's result is the item's
  const y = (await wired.run("13.4", "dmdc.verify", AGENT, { loan_id: "L-13", last_name: "Borrower", first_name: "A", ssn: "123456789", review_id: "prr-1", item_result: "pass", evidence_document_id: "cert-doc" })).output as Wrapped<{ status: string; certificate_id: string; outcome: string; on_active_duty: string; purpose: string; method: string }>;
  assert.equal(y.result.status, "Y"); assert.equal(y.result.on_active_duty, "Y"); assert.equal(y.result.outcome, "hold_scra"); assert.match(y.result.certificate_id, /^CERT-/); assert.equal(y.result.purpose, "prereferral"); assert.equal(y.result.method, "dmdc_single");
  assert.equal(y.item!.item_code, "SCRA_DMDC"); assert.equal(y.item!.result, "fail"); assert.equal(y.item!.evaluator, "rule"); assert.deepEqual(y.item!.evidence_ids, [y.result.certificate_id]); assert.equal(y.item!.caller_result_ignored, "pass");
  assert.ok(wired.types().includes("dmdc.verification.completed")); assert.equal(wired.rt.store.list("scra_verifications").length, 1);
  // completing the review with every other item passing still yields hold_scra, and the referral gates refuse
  const done = (await wired.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-13", review_id: "prr-1", item_result: "pass", evidence_document_id: "insp-doc", complete_review: true })).output as Wrapped<unknown>;
  assert.equal(done.review.outcome, "hold_scra");
  const gates = (await wired.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-13", step: "refer" })).output as { open: boolean; gates: { gate_code: string; result: string }[]; blocked_by: string[] };
  assert.equal(gates.gates.find((g) => g.gate_code === "SCRA_3953C_FC_PROTECTION_GATE")!.result, "closed", "DMDC Y closes the SCRA gate before any case row exists"); assert.ok(gates.blocked_by.includes("SCRA_3953C_FC_PROTECTION_GATE")); assert.equal(gates.open, false);
  await assert.rejects(wired.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "RESUME" }), gateClosed("SCRA_3953C_FC_PROTECTION_GATE"));
  const n = (await wired.run("13.4", "dmdc.verify", AGENT, { loan_id: "L-14", last_name: "Other", first_name: "B", ssn: "999999999" })).output as Wrapped<{ status: string; outcome: string }>;
  assert.equal(n.result.status, "N"); assert.equal(n.result.outcome, "pass"); assert.equal(n.item!.result, "pass");
  dmdc.outage = true;
  const out = (await wired.run("13.4", "dmdc.verify", AGENT, { loan_id: "L-13", last_name: "Borrower", first_name: "A", ssn: "123456789" })).output as Wrapped<{ status: string; outcome: string }>;
  assert.equal(out.result.status, "unavailable"); assert.equal(out.result.outcome, "hold_scra");
  // the checklist guardrails fire on the item tools that consume them
  await assert.rejects(wired.run("13.4", "dmdc.verify", AGENT, { loan_id: "L-13", last_name: "Borrower", item_result: "pass" }), refused("ITEM_PASS_NEEDS_EVIDENCE"));
});

test("13.4-T8 tool path: a model item below 0.85 is recorded pending_human with the human_agent task (pass or fail), the review cannot complete until the human_agent's own entry resolves it, and a caller flag never does", async () => {
  const h = harness({});
  const low = (await h.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-16", review_id: "prr-16", item: "OCCUPANCY_VERIFIED", item_result: "pass", evidence_document_id: "d-1", confidence: 0.7 })).output as Wrapped<unknown>;
  assert.equal(low.item!.result, "pending_human"); assert.equal(low.item!.evaluator, "model"); assert.deepEqual(low.review.pending_human, ["OCCUPANCY_VERIFIED"]);
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "human_agent" && e.payload.item === "OCCUPANCY_VERIFIED" && e.payload.proposed_result === "pass"));
  await assert.rejects(h.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-16", review_id: "prr-16", complete_review: true }), /await.*human_agent verification/);
  await assert.rejects(h.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-16", review_id: "prr-16", item: "OCCUPANCY_VERIFIED", item_result: "pass", evidence_document_id: "d-1", confidence: 0.7, human_resolved: true }), refused("HUMAN_RESOLUTION_IS_RECORDED"));
  const human = (await h.run("13.4", "inspection.get", HUMAN_AGENT, { id: "insp-1", loan_id: "L-16", review_id: "prr-16", item: "OCCUPANCY_VERIFIED", item_result: "pass", evidence_document_id: "d-1" })).output as Wrapped<unknown>;
  assert.equal(human.item!.evaluator, "human"); assert.deepEqual(human.review.pending_human, []);
  const done = (await h.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-16", review_id: "prr-16", complete_review: true })).output as Wrapped<unknown>;
  assert.equal(done.review.outcome, "refer");
});

test("13.4 bk.scrub: the PACER adapter decides the hit and the result is stored; a hit opens the bk_stay hold and hands the petition to 14.x (13.4-T10); no adapter holds — the caller's pacer_hit is never consulted", async () => {
  const none = harness({});
  const r = (await none.run("13.4", "bk.scrub", AGENT, { loan_id: "L-13", last_name: "Borrower", ssn4: "1234", pacer_hit: false })).output as Wrapped<{ scrubbed: boolean; outcome: string }>;
  assert.equal(r.result.scrubbed, false); assert.equal(r.result.outcome, "hold_bankruptcy"); assert.equal(r.item!.result, "fail");
  const pacer = new FakePacer(); pacer.parties.push({ caseNumber: "26-10001", court: "txnb", chapter: 13, lastName: "Borrower", firstName: "A", ssn4: "1234", dateFiled: "2026-05-01", status: "open" });
  const wired = harness({ pacer });
  const hit = (await wired.run("13.4", "bk.scrub", AGENT, { loan_id: "L-13", last_name: "Borrower", ssn4: "1234", pacer_hit: false })).output as Wrapped<{ scrubbed: boolean; outcome: string; open_bk_case: { case_number: string }; hold_id: string | null }>;
  assert.equal(hit.result.scrubbed, true); assert.equal(hit.result.outcome, "hold_bankruptcy"); assert.equal(hit.result.open_bk_case.case_number, "26-10001"); assert.equal(wired.rt.store.list("bk_scrubs").length, 1); assert.equal(hit.item!.result, "fail");
  assert.equal(wired.rt.store.get("foreclosure_holds", hit.result.hold_id!)!.data.kind, "bk_stay"); assert.ok(wired.types().includes("foreclosure.hold.opened")); assert.equal(wired.ctx.events.all().find((e) => e.type === "bankruptcy.petition.filed")!.payload.source, "pacer_scrub");
  const gates = (await wired.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-13", step: "refer" })).output as { blocked_by: string[] };
  assert.ok(gates.blocked_by.includes("BK_362_STAY_GATE")); assert.ok(gates.blocked_by.includes("HOLD:bk_stay"));
  const clean = (await wired.run("13.4", "bk.scrub", AGENT, { loan_id: "L-14", last_name: "Nobody", ssn4: "0000", pacer_hit: true })).output as Wrapped<{ outcome: string }>;
  assert.equal(clean.result.outcome, "pass"); assert.equal(clean.item!.result, "pass"); assert.equal(wired.rt.store.list("foreclosure_holds").length, 1);
});

test("13.1 foreclosure.gates.evaluate(loan_id, step): the ordered gate list with reasons, one evaluation row per gate, the human_agent escalation for a low-confidence non-PR conclusion, the step-scoped (g) gates, the decision record — and the counters/occupancy/state from the loan row only", async () => {
  const h = harness({}, "2026-05-02T12:00:00.000Z");
  h.put("loans", "L-13", { loan_id: "L-13", state: "NY", earliest_unpaid_due: "2026-01-01", occupancy: "unknown" });
  const r = (await h.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-13", step: "refer" })).output as { step: string; open: boolean; blocked_by: string[]; gates: { gate_code: string; result: string; reason: string | null; evaluator: string | null }[]; evaluation_ids: string[]; referral: { ok: boolean; blocked_by: string[] }; counters: { regx_days_delinquent: number } };
  const codes = r.gates.map((g) => g.gate_code);
  assert.deepEqual(codes.slice(0, 6), ["REGX_1024_41F1_120_DAY_GATE", "REGX_1024_41F2_PRE_FILING_APP_GATE", "REGX_1024_41K2_NO_FIRST_FILING_GATE", "FNMA_E1202_REFER_NO_EARLIER_121", "BK_362_STAY_GATE", "SCRA_3953C_FC_PROTECTION_GATE"], "13.3 rule 1 order");
  const by = Object.fromEntries(r.gates.map((g) => [g.gate_code, g]));
  assert.equal(r.counters.regx_days_delinquent, 121); assert.equal(by.REGX_1024_41F1_120_DAY_GATE!.result, "open", "day 121"); assert.equal(by.REGX_1024_41F1_120_DAY_GATE!.evaluator, "13.1.preForeclosureReviewPeriodElapsed");
  assert.equal(by.SCRA_DMDC_STALE_30!.result, "closed", "no certificate on file"); assert.match(by.SCRA_DMDC_STALE_30!.reason!, /DMDC certificate age/);
  assert.equal(by.PACKAGE_READY!.result, "closed"); assert.match(by.PACKAGE_READY!.reason!, /note_custody.*assignments.*referral_package_document_id|note copy/); assert.equal(by.REGX_1024_41G_DUAL_TRACK_GATE!.result, "not_applicable", "(g) does not apply to refer");
  assert.equal(r.open, false); assert.ok(r.blocked_by.includes("SCRA_DMDC_STALE_30")); assert.equal(r.referral.ok, false);
  assert.equal(r.evaluation_ids.length, r.gates.length); assert.equal(h.rt.store.list("foreclosure_gate_evaluations").length, r.gates.length);
  assert.ok(h.rt.store.list("foreclosure_gate_evaluations").every((e) => e.data.step === "refer" && e.data.rule_set_version === "13.1@tools.v1" && (e.data.result === "open" || e.data.result === "closed") && e.data.evaluator === undefined));
  // the 13.1 decision record: gate results by evaluation ids, occupancy source, rule set
  const d = h.ctx.decisions.find((x) => x.action === "foreclosure.gates.evaluate:refer")!; assert.ok(d); assert.deepEqual(d.evidenceDocumentIds, r.evaluation_ids); assert.equal(d.ruleCode, r.blocked_by[0]); assert.match(d.rationale, /occupancy principal_residence from loans/);
  // a second evaluation appends, never overwrites; not_applicable rides in reason_code (0015: result ∈ {open, closed})
  await h.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-13", step: "judgment_motion" }, "2026-05-03T12:00:00.000Z");
  assert.equal(h.rt.store.list("foreclosure_gate_evaluations").length, 2 * r.gates.length, "rows accumulate (judgment_motion evaluates the same gate set with different applicability)");
  const jm = h.rt.store.list("foreclosure_gate_evaluations").filter((e) => e.data.step === "judgment_motion"); assert.ok(jm.find((e) => e.data.gate_code === "REGX_1024_41G_DUAL_TRACK_GATE" && e.data.result === "open" && e.data.reason_code === null)); assert.ok(jm.find((e) => e.data.gate_code === "REGX_1024_41F1_120_DAY_GATE" && e.data.result === "open" && e.data.reason_code === "not_applicable"));
  // 13.1-T4 on the tool path: a non-PR conclusion at 0.85 is escalated to human_agent (opened), and the loan stays a principal residence
  const occ = (await h.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-13", step: "refer", model_conclusion: { non_principal: true, confidence: 0.85 } })).output as { occupancy: { treated_as: string }; occupancy_escalation_id: string | null };
  assert.equal(occ.occupancy.treated_as, "principal_residence"); assert.ok(occ.occupancy_escalation_id); assert.equal(h.rt.escalations.opened.find((e) => e.id === occ.occupancy_escalation_id)!.kind, "human_agent");
  // 13.1-T8 on the tool path: an attempted referral on a closed gate is refused with the event and the sev-1 escalation
  const attempt = (await h.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-13", step: "refer", attempt_referral: true }, "2026-04-01T12:00:00.000Z")).output as { refused: { event: { gate: string } } | null; gates: { gate_code: string; result: string }[] };
  assert.equal(attempt.gates[0]!.result, "closed", "day 90"); assert.equal(attempt.refused!.event.gate, "REGX_1024_41F1_120_DAY_GATE"); assert.ok(h.types().includes("foreclosure.gate.refused")); assert.ok(h.rt.escalations.opened.some((e) => e.kind === "sev1"));
  // 13.1 guardrail: the agent cannot open a closed gate — not by a gate list, not by moving the counters, not by asserting occupancy
  for (const bad of [{ gates: [] }, { today: "2026-06-01" }, { earliest_unpaid_due: "2025-10-01" }, { occupancy: "non_principal" }, { principal_residence: false }, { state: "TX" }]) await assert.rejects(h.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-13", step: "refer", ...bad }, "2026-04-01T12:00:00.000Z"), refused("CANNOT_OPEN_GATE"), JSON.stringify(bad));
  assert.equal(((await h.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-13", step: "refer" }, "2026-04-01T12:00:00.000Z")).output as { gates: { result: string }[] }).gates[0]!.result, "closed", "day 90 stays closed whatever the caller says");
  // `delinquency.counters.get` reads the loan too
  const c = (await h.run("13.1", "delinquency.counters.get", AGENT, { loan_id: "L-13" }, "2026-04-01T12:00:00.000Z")).output as { regx_days_delinquent: number; fc_120_day_open_on: string };
  assert.equal(c.regx_days_delinquent, 90); assert.equal(c.fc_120_day_open_on, "2026-05-02");
  await assert.rejects(h.run("13.1", "delinquency.counters.get", AGENT, { loan_id: "L-13", today: "2026-06-01" }), refused("COUNTERS_ARE_COMPUTED"));
  // 13.1 rule 3: a verified non-principal-residence change on file (borrower statement in contacts) makes the Reg X gate not applicable — evidence, not a caller claim
  h.put("loans", "L-14", { loan_id: "L-14", state: "TX", earliest_unpaid_due: "2026-01-01", occupancy: "unknown" });
  h.put("contacts", "c-14", { loan_id: "L-14", occupancy_statement: "non_principal" });
  const npr = (await h.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-14", step: "refer" }, "2026-04-01T12:00:00.000Z")).output as { gates: { gate_code: string; result: string }[]; occupancy: { treated_as: string; on_file: string }; occupancy_escalation_id: string | null };
  assert.equal(npr.occupancy.on_file, "non_principal"); assert.equal(npr.occupancy.treated_as, "non_principal"); assert.equal(npr.occupancy_escalation_id, null); assert.equal(npr.gates[0]!.result, "not_applicable");
});

test("13.2 (g) facts come from the 12.x application rows: a complete application after the first notice and >37 days before the sale closes the dual-track gate until an exit; every hold refusal names its gate and leaves the trail", async () => {
  const h = harness({}, "2026-09-03T12:00:00.000Z");
  h.put("foreclosure_cases", "FC-1", { loan_id: "L-13", status: "active", first_notice_filed_at: "2026-06-01", sale_on: "2026-11-03" });
  h.put("lossmit_applications", "lma-1", { loan_id: "L-13", status: "complete", received_on: "2026-08-01", complete_received_on: "2026-08-15" });
  await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "RESUME" }), gateClosed("REGX_1024_41G_DUAL_TRACK_GATE"));
  assert.equal(h.ctx.events.all().filter((e) => e.type === "foreclosure.gate.refused").length, 1);
  h.put("lossmit_applications", "lma-1", { exit: "all_options_rejected" });
  await h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "RESUME" });
  // a released 12.x hold no longer blocks; an active one does — and the refusal names the hold's gate
  h.put("foreclosure_holds", "hold-L-13-lm_appeal_pending", { loan_id: "L-13", kind: "lm_appeal_pending", status: "active", from: "2026-09-04" });
  await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "CERTIFY_SALE" }), gateClosed("REGX_1024_41G_DUAL_TRACK_GATE"));
  h.put("foreclosure_holds", "hold-L-13-lm_appeal_pending", { status: "released" });
  await h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "CERTIFY_SALE" });
  h.put("foreclosure_holds", "hold-L-13-scra", { loan_id: "L-13", kind: "scra_3953", status: "active", from: "2026-09-04" });
  const before = h.ctx.events.all().length;
  await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "CERTIFY_SALE" }), gateClosed("SCRA_3953C_FC_PROTECTION_GATE"));
  const refusal = h.ctx.events.all().slice(before).find((e) => e.type === "foreclosure.gate.refused")!; assert.equal(refusal.payload.code, "SCRA_3953C_FC_PROTECTION_GATE"); assert.equal(refusal.payload.step, "sale_certify"); assert.equal(refusal.payload.command, "attorney.instruction.send{kind=CERTIFY_SALE}");
  assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "sev1").length, 3); assert.ok(h.rt.store.list("foreclosure_gate_evaluations").some((e) => e.data.gate_code === "SCRA_3953C_FC_PROTECTION_GATE" && e.data.result === "closed"));
});

test("13.3 bid on the bus: totalIndebtedness()/bid() over the loan's balances, the case's sale date and Fannie Mae's reserve price — the model never edits amounts; the firm's acknowledgment closes the bid clock", async () => {
  const h = harness({}, "2026-10-20T12:00:00.000Z");
  h.put("loans", "L-13", { loan_id: "L-13", state: "TX", upb_cents: 25_000_000n, note_rate_pct: "6.50", lpi_due_date: "2025-09-01", escrow_advances_cents: 684_217n, corporate_advances_cents: 197_500n, attorney_fees_cents: 215_000n, costs_cents: 148_750n });
  h.put("foreclosure_cases", "FC-13", { loan_id: "L-13", status: "sale_scheduled", sale_on: "2026-11-03" });
  // the worked example (13.3 rule 5): $281,509.46 total indebtedness; no reserve ⇒ bid indebtedness
  for (const figs of [{ max_bid_cents: 100n }, { total_indebtedness_cents: 1n }, { reserve_price_cents: 27_000_000n, reserve_expires_on: "2026-11-20", sale_on: "2026-11-03" }]) await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "BID_INSTRUCTIONS", ...figs }), refused("NO_MODEL_BID_FIGURES"), JSON.stringify(figs, (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v)));
  const a = (await h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "BID_INSTRUCTIONS", firm_id: "F-1" })).output as { basis: string; max_bid_cents: bigint; total_indebtedness_cents: bigint; bid_instruction_id: string };
  assert.equal(a.total_indebtedness_cents, 28_150_946n); assert.equal(a.max_bid_cents, 28_150_946n); assert.equal(a.basis, "indebtedness");
  const bidRow = h.rt.store.get("bid_instructions", a.bid_instruction_id)!.data; assert.equal(bidRow.basis, "total_indebtedness"); assert.equal(bidRow.interest_cents, 1_905_479n); assert.equal(bidRow.interest_days, 428); assert.equal(bidRow.case_id, "FC-13"); assert.ok(h.types().includes("foreclosure.sale.bid.issued"));
  // an unexpired reserve below indebtedness ⇒ bid the reserve (lesser); an expired one ⇒ fall back to indebtedness (13.3-T10), never lower
  h.put("reserve_prices", "rp-1", { loan_id: "L-13", reserve_price_cents: 27_000_000n, expires_on: "2026-11-20", received_on: "2026-10-15" });
  const b = (await h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "BID_INSTRUCTIONS" })).output as { basis: string; max_bid_cents: bigint };
  assert.equal(b.basis, "reserve"); assert.equal(b.max_bid_cents, 27_000_000n);
  h.put("reserve_prices", "rp-1", { expires_on: "2026-11-01" });
  const c = (await h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "BID_INSTRUCTIONS" })).output as { basis: string; max_bid_cents: bigint; bid_instruction_id: string };
  assert.equal(c.basis, "indebtedness"); assert.equal(c.max_bid_cents, 28_150_946n); assert.match(String(h.rt.store.get("bid_instructions", c.bid_instruction_id)!.data.rationale), /expired 2026-11-01/);
  // an officer override rides in `changes` (moneyFields) and is still refused below indebtedness without an unexpired reserve
  await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "BID_INSTRUCTIONS", changes: { max_bid_cents: 27_000_000n } }), refused("MONEY_FIELD"));
  await assert.rejects(h.run("13.2", "attorney.instruction.send", OFFICER, { loan_id: "L-13", kind: "BID_INSTRUCTIONS", changes: { max_bid_cents: 27_000_000n, total_indebtedness_cents: 28_150_946n } }), refused("BID_BELOW_INDEBTEDNESS_NEEDS_RESERVE"));
  await assert.rejects(h.run("13.2", "attorney.instruction.send", OFFICER, { loan_id: "L-13", kind: "BID_INSTRUCTIONS", changes: { max_bid_cents: 27_000_000n } }), /below total indebtedness/);
  // a transfer-tax state without exemption opens at $100 and bids up to the lesser amount
  h.put("loans", "L-13", { transfer_tax_no_exemption: true });
  const d = (await h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "BID_INSTRUCTIONS" })).output as { opening_bid_cents: bigint; max_bid_cents: bigint; bid_instruction_id: string };
  assert.equal(d.opening_bid_cents, 10_000n); assert.equal(d.max_bid_cents, 28_150_946n);
  // the firm's inbound ACK is recorded on the instruction and emitted (closes FNMA_E3205_BID_INSTRUCTIONS_5BD)
  const ack = (await h.run("13.2", "attorney.instruction.status", AGENT, { id: `ai-L-13-BID_INSTRUCTIONS-2026-10-20T12:00:00.000Z`, op: "acknowledge", ack_by: "F-1" })).output as { status: string; acknowledged_at: string };
  assert.equal(ack.status, "acknowledged"); const ackEvent = h.ctx.events.all().find((e) => e.type === "attorney.instruction.acknowledged")!; assert.equal(ackEvent.payload.kind, "BID_INSTRUCTIONS");
  assert.ok(h.rt.store.get("bid_instructions", d.bid_instruction_id)!.data.firm_ack_at);
  assert.equal(((await h.run("13.2", "attorney.instruction.status", AGENT, { id: `ai-L-13-BID_INSTRUCTIONS-2026-10-20T12:00:00.000Z` })).output as { status: string }).status, "acknowledged");
});

test("13.7 litigation.classify opens the matter and the LITIGATION_HOLD row; 13.3/13.5/13.6/13.9 sentences refuse on the tools their engines run on", async () => {
  const h = harness({}, "2026-09-10T12:00:00.000Z");
  h.put("loans", "L-13", { loan_id: "L-13", state: "TX", upb_cents: 25_000_000n, note_rate_pct: "6.50", lpi_due_date: "2025-09-01" });
  h.put("foreclosure_cases", "FC-13", { loan_id: "L-13", status: "sale_scheduled", sale_on: "2026-11-03" });
  const r = (await h.run("13.7", "litigation.classify", AGENT, { loan_id: "L-13", served_on: "2026-09-10", attacks_validity_priority_enforceability: true, confidence: 0.92 })).output as { classification: string; category: number; hold_id: string | null };
  assert.equal(r.classification, "non_routine"); assert.equal(r.category, 2); assert.ok(r.hold_id);
  const opened = h.ctx.events.all().find((e) => e.type === "litigation.matter.opened")!; assert.equal(opened.payload.classification, "non_routine");
  assert.ok(h.types().includes("litigation.hold.opened")); assert.equal(h.rt.store.get("foreclosure_holds", "hold-L-13-litigation")!.data.kind, "litigation");
  await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "RESUME" }), (e: unknown) => e instanceof GateClosed && e.ref === "LITIGATION_HOLD" && /litigation/.test(e.message));
  const routine = (await h.run("13.7", "litigation.classify", AGENT, { loan_id: "L-14", served_on: "2026-09-10", damages_claim: true, confidence: 0.7 })).output as { classification: string; hold_id: string | null };
  assert.equal(routine.classification, "attorney_confirmation_required"); assert.equal(routine.hold_id, null);
  // 13.3: a method deviation needs Form 20 and the officer (the bid itself is computed — see the bid test)
  await assert.rejects(h.run("13.2", "attorney.instruction.send", OFFICER, { loan_id: "L-13", kind: "BID_INSTRUCTIONS", method_deviation: true }), refused("METHOD_DEVIATION_NEEDS_FORM20"));
  await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "BID_INSTRUCTIONS", method_deviation: true, form20_approval_id: "f20-1" }), refused("METHOD_DEVIATION_OFFICER"));
  await h.run("13.2", "attorney.instruction.send", OFFICER, { loan_id: "L-13", kind: "BID_INSTRUCTIONS", method_deviation: true, form20_approval_id: "f20-1" });
  // 13.9: no court-relief request is ever prepared; no denial without attorney review when service is asserted in writing
  await assert.rejects(h.run("13.6", "attorney.message.send", AGENT, { firm_id: "F-1", subject: "Petition to proceed with sale despite SCRA stay" }), refused("NO_COURT_RELIEF_REQUEST"));
  await assert.rejects(h.run("13.2", "attorney.instruction.send", AGENT, { loan_id: "L-13", kind: "SCRA_STAY", court_relief_request: true }), refused("NO_COURT_RELIEF_REQUEST"));
  await assert.rejects(h.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: "L-15", op: "open", dmdc_status: "N", origination_on: "2024-03-01", service_begin_on: "2026-03-15", written_assertion: true }), refused("ATTORNEY_REVIEWS_ASSERTED_SERVICE_DENIAL"));
  const reviewed = (await h.run("13.8", "scra.case.get/open/close", ATTORNEY, { loan_id: "L-15", op: "open", dmdc_status: "N", origination_on: "2024-03-01", service_begin_on: "2026-03-15", written_assertion: true })).output as { opened: boolean; denial_allowed: boolean; request_orders: boolean };
  assert.equal(reviewed.opened, false); assert.equal(reviewed.denial_allowed, false); assert.equal(reviewed.request_orders, true); assert.ok(h.types().includes("scra.orders.requested"));
  // 13.6: Form 200 certification is the officer's
  await assert.rejects(h.run("13.6", "attorney.message.send", ANALYST, { firm_id: "F-1", subject: "Form 200 certification", form200_certification: true }), refused("FORM200_OFFICER_CERTIFIES"));
  await h.run("13.6", "attorney.message.send", OFFICER, { firm_id: "F-1", subject: "Form 200 certification", form200_certification: true });
  // 13.5: the rebuttal is submitted only over the officer's signature, and the submission resolves the bill's clock
  await assert.rejects(h.run("13.5", "documents.bundle", AGENT, { loan_id: "L-13", document_ids: ["d-1"], submit: true }), refused("OFFICER_SIGNS_REBUTTAL"));
  const draft = (await h.run("13.5", "documents.bundle", AGENT, { loan_id: "L-13", document_ids: ["d-1"], id: "bundle-1" })).output as { status: string }; assert.equal(draft.status, "drafted");
  const sent = (await h.run("13.5", "documents.bundle", OFFICER, { loan_id: "L-13", document_ids: ["d-1"], id: "bundle-1", submit: true, bill_id: "bill-1" })).output as { status: string; signer_role: string };
  assert.equal(sent.status, "submitted"); assert.equal(sent.signer_role, "officer"); assert.equal(h.ctx.events.all().find((e) => e.type === "comp_fee_bill.resolved")!.payload.result, "rebutted");
});

test("13.8 dmdc.results.import writes one scra_verifications row per borrower (purpose boarding) and emits dmdc.verification.completed{purpose=boarding} — the SM_DMDC_VERIFY_BOARDING_0 satisfaction", async () => {
  const h = harness({}, "2026-06-03T12:00:00.000Z");
  const r = (await h.run("13.8", "dmdc.results.import", AGENT, { loan_id: "L-13", boarded_on: "2026-06-01", results: [{ borrower_id: "b1", status: "N", certificate_id: "CERT-1", as_of: "2026-06-03" }, { borrower_id: "b2", status: "N", certificate_id: "CERT-2", as_of: "2026-06-03" }] })).output as { verification_ids: string[]; status: string; purpose: string; due: string };
  assert.equal(r.verification_ids.length, 2); assert.equal(r.status, "N"); assert.equal(r.purpose, "boarding"); assert.equal(r.due, "2026-06-08");
  const rows = h.rt.store.list("scra_verifications"); assert.equal(rows.length, 2); assert.ok(rows.every((x) => x.data.method === "dmdc_batch" && x.data.purpose === "boarding" && x.data.on_active_duty === "N" && x.data.status_date === "2026-06-03"));
  const e = h.ctx.events.all().find((x) => x.type === "dmdc.verification.completed")!; assert.equal(e.payload.purpose, "boarding");
  const gates = (await h.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-13", step: "refer" })).output as { gates: { gate_code: string; result: string }[] };
  assert.equal(gates.gates.find((g) => g.gate_code === "SCRA_DMDC_STALE_30")!.result, "open", "the boarding certificate is fresh"); assert.equal(gates.gates.find((g) => g.gate_code === "SCRA_3953C_FC_PROTECTION_GATE")!.result, "open");
});
