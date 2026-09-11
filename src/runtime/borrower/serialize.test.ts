/**
 * The allow-list serializer (13 §1 contract tests; 13 §3 T-X-03): shapes drop what they do not name; no shape names a
 * restricted field; against a database, no column of the restricted tables (du_findings_interpretations, risk_assessment,
 * credit_reports, compliance_test_runs, qc_*, fraud_*, applicant_demographics) that is not also an ordinary column of the
 * tables the surface legitimately reads appears in any shape. Errors are {code, gate?, copy_key} with the 02-named copy keys.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { connect, reachable } from "../../infra/db/client.ts";
import { ALL_ALLOWED_FIELDS, FORBIDDEN_FIELDS, SHAPES, serialize } from "./serialize.ts";
import { BorrowerError, toBorrowerError } from "./errors.ts";
import { CommandRefused } from "../../app/commands.ts";
import { GateClosed } from "../../app/evaluators.ts";
import { GATE_COPY_KEYS, copyKeyFor } from "./copy-keys.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
const skip = up ? false : `no Postgres at ${DB_URL}`;

test("serializer: a shape keeps only the fields it names, at every depth, and turns bigint into decimal strings", () => {
  const out = serialize("me", { party: { party_id: "p1", party_type: "borrower", display_name: "Avery Fixture", tin_encrypted: "x", contact: { email: "a@b" } }, level: "L2", risk_assessment: { score: 1 }, session: { session_id: "s1", level: "L2", token_hash: "h", ip: "1.1.1.1", fresh_l1: true },
    subjects: [{ application_id: "a1", loan_id: null, role: "borrower", stage: "origination", label: "x", application_borrower_id: "ab1", du_findings: {} }], extra: 1n });
  assert.deepEqual(out, { party: { party_id: "p1", party_type: "borrower", display_name: "Avery Fixture" }, level: "L2", session: { session_id: "s1", level: "L2", fresh_l1: true }, subjects: [{ application_id: "a1", loan_id: null, role: "borrower", stage: "origination", label: "x" }] });
  assert.deepEqual(serialize("document_uploaded", { document_id: "d", byte_size: 12n, matched_request_ids: ["r1", { nested: true }] }), { document_id: "d", byte_size: "12", matched_request_ids: ["r1"] });
  assert.deepEqual(serialize("error", new BorrowerError(409, "X", "SM_IDENTITY_IAL2_GATE").body()), { code: "X", gate: "SM_IDENTITY_IAL2_GATE", copy_key: "gate.identity.verify_first" });
});

test("serializer: no shape names a forbidden field; every shape is closed (an unknown key never passes)", () => {
  for (const f of FORBIDDEN_FIELDS) assert.ok(!ALL_ALLOWED_FIELDS.has(f), f);
  for (const name of Object.keys(SHAPES) as (keyof typeof SHAPES)[]) assert.deepEqual(serialize(name, { definitely_not_a_field: 1, applicant_demographics: { race: [] } }), {}, name);
});

test("errors: CommandRefused → {code, gate, copy_key} with 02's copy keys for the gates it names; GateClosed → gate from the evaluator ref; validation → BAD_REQUEST; the default is error.generic", () => {
  const refused = toBorrowerError(new CommandRefused("requestLock", "SM_QUOTE_VALIDITY_GATE", "20.4", "quote expired"));
  assert.equal(refused.status, 409); assert.deepEqual(refused.body(), { code: "SM_QUOTE_VALIDITY_GATE", gate: "SM_QUOTE_VALIDITY_GATE", copy_key: "gate.quote.expired" });
  assert.deepEqual(toBorrowerError(new CommandRefused("submitDu", "SM_IDENTITY_IAL2_GATE", "22.6", "x")).body(), { code: "SM_IDENTITY_IAL2_GATE", gate: "SM_IDENTITY_IAL2_GATE", copy_key: "gate.identity.verify_first" });
  assert.deepEqual(toBorrowerError(new CommandRefused("orderCredit", "SM_O21_JOINT_INTENT_GATE", "21.1", "x")).body(), { code: "SM_O21_JOINT_INTENT_GATE", gate: "SM_O21_JOINT_INTENT_GATE", copy_key: "gate.joint_intent.each_borrower" });
  assert.deepEqual(toBorrowerError(new CommandRefused("chargeFee", "REGZ_1026_19E2_INTENT_FEE_GATE", "21.4", "x")).body(), { code: "REGZ_1026_19E2_INTENT_FEE_GATE", gate: "REGZ_1026_19E2_INTENT_FEE_GATE", copy_key: "gate.intent.before_fees" });
  assert.deepEqual(toBorrowerError(new CommandRefused("requestLock", "SM_O61_COMPLIANCE_PASS_LOCK_GATE", "21.4", "x")).body(), { code: "SM_O61_COMPLIANCE_PASS_LOCK_GATE", gate: "SM_O61_COMPLIANCE_PASS_LOCK_GATE", copy_key: "gate.lock.compliance_pending" });
  assert.deepEqual(toBorrowerError(new CommandRefused("x", "NOT_ALLOWLISTED", "cite", "x")).body(), { code: "NOT_ALLOWLISTED", copy_key: "error.generic" });
  assert.deepEqual(toBorrowerError(new GateClosed("SM_IDENTITY_IAL2_GATE", "not at IAL2")).body(), { code: "GATE_CLOSED", gate: "SM_IDENTITY_IAL2_GATE", copy_key: "gate.identity.verify_first" });
  const bad = toBorrowerError(new RangeError("application_id is required"));
  assert.equal(bad.status, 400); assert.deepEqual(bad.body(), { code: "BAD_REQUEST", copy_key: "error.generic" });
  assert.equal(copyKeyFor("SOMETHING_ELSE"), "error.generic");
  for (const g of ["SM_IDENTITY_IAL2_GATE", "REGZ_1026_19E2_INTENT_FEE_GATE", "SM_O21_JOINT_INTENT_GATE", "SM_QUOTE_VALIDITY_GATE", "SM_O61_COMPLIANCE_PASS_LOCK_GATE"]) assert.ok(GATE_COPY_KEYS[g], `${g} has a copy key (02 §2)`);
});

test("schema grep (T-X-03): no column of the restricted tables — beyond the generic columns they share with ordinary tables — is a field any borrower shape names", { skip }, async () => {
  const db = connect(DB_URL);
  try {
    const restricted = await db.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema IN ('public', 'restricted_fl') AND (table_name IN ('du_findings_interpretations', 'risk_assessment', 'credit_reports', 'compliance_test_runs', 'applicant_demographics') OR table_name LIKE 'qc\\_%' OR table_name LIKE 'fraud\\_%')`);
    assert.ok(restricted.length > 50, "the restricted tables exist");
    // generic = a column name some non-restricted table also has (id, status, document_id, outcome, …): a homonym, not a leak
    const generic = new Set((await db.query<{ column_name: string }>(`SELECT DISTINCT column_name FROM information_schema.columns WHERE table_schema = 'public' AND NOT (table_name IN ('du_findings_interpretations', 'risk_assessment', 'credit_reports', 'compliance_test_runs') OR table_name LIKE 'qc\\_%' OR table_name LIKE 'fraud\\_%')`)).map((r) => r.column_name));
    const leaks = restricted.filter((c) => !generic.has(c.column_name) && ALL_ALLOWED_FIELDS.has(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`);
    assert.deepEqual(leaks, []);
    // and the demographic columns are never generic: applicant_demographics' own fields are forbidden outright
    const demo = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'restricted_fl' AND table_name = 'applicant_demographics'`);
    for (const c of demo) if (!["id", "application_borrower_id", "collected_at"].includes(c.column_name)) assert.ok(!ALL_ALLOWED_FIELDS.has(c.column_name), c.column_name);
  } finally { await db.end(); }
});
