/**
 * §30.2 process-owned tools — bus tools for 30.2 defined with `defineTools("30.2", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 30.2; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `boarding` agent in origination mode (1.1's package): at `loan.funded` it snapshots the origination aggregate,
 * maps it to LBDS paths, runs the OB-* and OW-* rules, boards, posts the opening ledger, indexes documents with retention classes,
 * evaluates consent scopes, seeds the timers, sends the first-payment letter and opens the first statement cycle. Every
 * act goes through `OriginationBoardingService` (rt.services["orig-boarding"]) so the bus is the process's own emitter
 * (events carry both applicationId and loanId). Guardrails encode the spec's sentences: money fields come only from the
 * signed note / CD hashes (never agent-edited); a hard-rule waiver needs `officer` (money) or the boarding lead
 * (non-money) with a written reason; demographics, consents and TCPA authority are never inferred; no boarding while
 * `rescission_expires_at` is in the future; the borrower is contacted only through the first-payment letter and the 7.4
 * invitation.
 */
import { defineTools, compute, decision, service, never, needsRole, guard, str, num, flag, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { OriginationBoardingService, mapFieldGuard, servicingLoanNumber, isValidServicingLoanNumber, ORIG_MONEY_FIELDS, FAIR_LENDING_PATH, FIRST_PAYMENT_LETTER, ESIGN_INVITATION, rescissionClear, openingLedgerLines, sumLines, type OriginationSnapshot } from "../../domain/orig-boarding/ops-30-2.ts";

/** Missing-input guard: a tool executed without its subject refuses with a RangeError (never a TypeError). */
const need = (i: ToolInput, ...keys: string[]): void => { const gaps = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (gaps.length) throw new RangeError(`30.2 tool needs ${gaps.join(", ")}`); };
const svc = (rt: Parameters<typeof service>[0]): OriginationBoardingService => service<OriginationBoardingService>(rt, "orig-boarding");
const touchesMoney = (i: ToolInput): string[] => [...new Set([...Object.keys(i.changes ?? {}), ...Object.keys((i.data as Record<string, unknown> | undefined) ?? {})])].filter((f) => (ORIG_MONEY_FIELDS as readonly string[]).includes(f) || f === "note" || f === "final_cd" || f === "escrow_analysis");
const guardCode = (i: ToolInput): ReturnType<typeof mapFieldGuard> => mapFieldGuard({ canonical_path: str(i, "canonical_path") || str(i, "path"), derivation: (i.derivation as string | undefined) ?? null });

export const TOOLS_30_2: readonly ToolDef[] = defineTools("30.2", "boarding", [
  // Rule 1: the origination aggregate at funding is read, never re-keyed by hand; with a snapshot on the runtime it returns the mapped record and staging rows.
  { name: "snapshotOrigination", kind: "read", handler: compute((i, _c, rt) => { if (!str(i, "application_id")) return rt.store.list("applications").map((r) => ({ id: r.id, version: r.version })); const r = svc(rt).find(str(i, "application_id")); if (!r) return rt.store.get("applications", str(i, "application_id"))?.data ?? null; return { application_id: r.application_id, loan_id: r.loan_id, status: r.status, snapshot_hash: r.mapped.snapshot_hash, mapping_version: r.mapped.mapping_version, staging: r.mapped.staging, loans: r.mapped.loans, loan_terms: r.mapped.loan_terms }; }) },
  // Rule 1 / T7: one field, one LBDS path, one source document; a GOVERNMENT_MONITORING / consent path may only carry the applicant's own statement.
  { name: "mapField", kind: "write", handler: compute((i, ctx, rt) => { need(i, "application_id", "canonical_path"); const g = guardCode(i); if (!g.ok) throw new RangeError(`${g.code}: ${g.reason}`);
      const row = { source: "origination", application_id: str(i, "application_id"), canonical_path: str(i, "canonical_path"), raw_value: i.raw_value ?? null, canonical_value: i.canonical_value ?? null, source_document_id: (i.source_document_id as string | undefined) ?? null, mapping_rule_id: str(i, "mapping_rule_id") || null, derivation: (i.derivation as string | undefined) ?? "source_document" };
      const rec = rt.store.put("boarding_staging", `${row.application_id}:${row.canonical_path}`, row, ctx.actor, ctx.now);
      ctx.events.append({ type: "boarding.field_mapped", applicationId: row.application_id, actor: ctx.actor, payload: { ...row, version: rec.version } });
      return rec.data; }),
    guardrails: [never("INFERRED_DEMOGRAPHICS", "30.2 guardrails: the agent may not infer demographics (F-1-11; HMDA Appendix B); OB-013 collected_via ∈ {self_reported, not_provided}", (i) => { const g = guardCode(i); return !g.ok && g.code === "INFERRED_DEMOGRAPHICS"; }, `a ${FAIR_LENDING_PATH} field is copied from applicant_demographics or recorded as not_provided — never derived (e.g. from a surname)`),
      never("INFERRED_CONSENT", "30.2 guardrails: the agent may not infer consents or TCPA authority (7001(c)(6); 20.2)", (i) => { const g = guardCode(i); return !g.ok && g.code === "INFERRED_CONSENT"; }, "consent and TCPA fields carry only the borrower's recorded election")] },
  // Rule 2: OB-001…OB-022 / OW-001…OW-012 over the staged record; deterministic and idempotent on the same snapshot.
  { name: "runValidation", kind: "act", handler: compute((i, _c, rt) => { need(i, "application_id"); return svc(rt).validate(str(i, "application_id")); }) },
  // Corrections from the origination record: non-money fields only; money fields are refused (they come only from the signed note / CD data hashes) — route them instead.
  { name: "proposeCorrection", kind: "write", moneyFields: [...ORIG_MONEY_FIELDS], handler: compute((i, ctx, rt) => { need(i, "application_id"); const changes = { ...((i.data as Record<string, unknown> | undefined) ?? {}), ...((i.changes as Record<string, unknown> | undefined) ?? {}) } as Parameters<OriginationBoardingService["proposeCorrection"]>[1];
      const r = svc(rt).proposeCorrection(str(i, "application_id"), changes, ctx.actor, { provenance: i.provenance === "source" ? "source" : "agent", evidence_document_ids: Array.isArray(i.evidence_document_ids) ? (i.evidence_document_ids as string[]) : [], ...(typeof i.rationale === "string" ? { rationale: i.rationale } : {}) });
      if (!r.ok) throw new RangeError(`${r.code}: ${r.reason}`); return r; }),
    guardrails: [never("MONEY_FIELDS_FROM_SOURCE_ONLY", "30.2 guardrails: money fields (amount, rate, P&I, escrow deposit, prepaid interest, buydown funds) come only from the signed note/CD data hashes — the agent may never edit them", (i) => touchesMoney(i).length > 0 && i.provenance !== "source", "money fields are never agent-corrected: route the defect to 26.1 (note) / 25.2 (CD) / 30.3 (escrow) with routeToOwner; a corrected source document is applied with provenance=source and its evidence_document_ids"),
      guard("SOURCE_EVIDENCE", "30.2 rule 1: every field is written from a versioned source with its source_document_id", (i) => (i.provenance === "source" && !(Array.isArray(i.evidence_document_ids) && (i.evidence_document_ids as unknown[]).length) ? "a source correction cites the corrected/re-executed document (evidence_document_ids)" : undefined))] },
  // Rule 2: money-field defects go to the owning origination process (26.1 note terms, 25.2 CD, 30.3 escrow); the loan cannot board until the source record is corrected.
  { name: "routeToOwner", kind: "act", handler: compute((i, _c, rt) => { need(i, "application_id", "rule_code"); return svc(rt).routeToOwner(str(i, "application_id"), str(i, "rule_code")); }) },
  // Rule 4: 10 digits with a check digit, allocated at `staged`; exposed to 29.3 as the Loan Delivery Lender Loan Number.
  { name: "allocateServicingLoanNumber", kind: "act", handler: compute((i, _c, rt) => { need(i, "application_id"); const r = svc(rt).find(str(i, "application_id")); if (r) return { application_id: r.application_id, loan_id: r.loan_id, servicing_loan_number: r.servicing_loan_number, allocated_at: "staged", check_digit_valid: isValidServicingLoanNumber(r.servicing_loan_number) };
      need(i, "sequence"); const n = servicingLoanNumber(num(i, "sequence")); return { application_id: str(i, "application_id"), servicing_loan_number: n, check_digit_valid: isValidServicingLoanNumber(n) }; }) },
  // State machine: validated → boarded needs zero open OB-*; a loan whose rescission period has not run never boards; a hard-rule waiver is an officer (money) / boarding-lead (non-money) act with a written reason.
  { name: "boardLoan", kind: "act", handler: compute((i, ctx, rt) => { need(i, "application_id"); const s = svc(rt);
      if (str(i, "waive_rule_code")) { const w = s.waive(str(i, "application_id"), str(i, "waive_rule_code"), ctx.actor, str(i, "reason")); if (!w.ok) throw new RangeError(`${w.code}: ${w.reason}`); }
      const r = s.board(str(i, "application_id")); if (!r.ok) throw new RangeError(`boarding refused: ${r.reason}`); return { status: r.status, boarded_at: r.boarded_at, opening_entry_set_id: r.ledger_set.id }; }),
    guardrails: [never("OPEN_HARD_FAILURE", "30.2 state machine: `validated` needs zero open `OB-*` failures; the loan cannot board until the source record is corrected", (i) => num(i, "open_hard_failures") > 0, "open OB-* failure(s) on the loan"),
      never("RESCISSION_PENDING", "30.2 guardrails: the agent may not board a loan whose `rescission_expires_at` is in the future (OB-018; 25.3/26.3)", (i) => flag(i, "rescindable") && !!i.rescission_expires_at && !!i.funded_at && !rescissionClear(true, str(i, "rescission_expires_at"), str(i, "funded_at")), "rescission_expires_at is not before loan.funded"),
      needsRole("HARD_WAIVER_MONEY_IS_OFFICER", "30.2 guardrails: a hard-rule waiver needs `officer` (money) with a written reason", (i) => !!str(i, "waive_rule_code") && flag(i, "money_field"), ["officer"], "waiving a money-field hard rule is an officer act"),
      needsRole("HARD_WAIVER_NEEDS_LEAD", "30.2 guardrails: a hard-rule waiver needs the boarding lead (non-money) with a written reason", (i) => !!str(i, "waive_rule_code") && !flag(i, "money_field"), ["officer", "ops_analyst"], "waiving a hard rule is a human act by the boarding lead (ops_analyst) or an officer"),
      guard("WAIVER_REASON", "30.2 guardrails: a waiver carries a written reason", (i) => (str(i, "waive_rule_code") && !str(i, "reason") ? "a waiver needs a written reason" : undefined))] },
  // Rule 3: the balanced opening set against `origination_funding_clearing`; figures come from the boarded record's note/CD, never from the input (an explicit entry set is only accepted when it balances and every line carries a rule_ref).
  { name: "postOpeningEntries", kind: "act", handler: compute((i, ctx, rt) => { need(i, "application_id"); const s = svc(rt); const r = s.find(str(i, "application_id")); if (r && !r.opening_entry_set_id && flag(i, "preview")) { const lines = openingLedgerLines(r.loan_id, s.d.prepurchaseTiAccountId, { principal_cents: r.mapped.loans.original_loan_amount_cents, escrow_deposit_cents: r.snapshot.escrow_analysis ? r.snapshot.final_cd.initial_escrow_deposit_cents : 0n, prepaid_interest_cents: r.prepaid.prepaid_interest_cents }); return { lines, balanced: sumLines(lines) === 0n }; }
      const set = s.postOpeningEntries(str(i, "application_id")); ctx.decide({ agent: ctx.actor.id, action: "postOpeningEntries", rationale: `opening balances ${set.id} (30.2 rule 3)`, ruleSetVersion: "30.2@tools.v1", loanId: r?.loan_id ?? ctx.loanId, subject: { kind: "ledger_entry_set", id: set.id } }); return { entry_set_id: set.id, lines: set.lines.length, balanced: sumLines(set.lines) === 0n }; }),
    guardrails: [never("FIGURES_FROM_SOURCE_HASHES", "30.2 guardrails: money fields come only from the signed note/CD data hashes — the opening figures are not tool input", (i) => ["principal_cents", "escrow_deposit_cents", "prepaid_interest_cents", "buydown_funds_cents"].some((k) => i[k] !== undefined), "opening figures are read from the boarded record (note amount, CD (g)(3), 26.3 prepaid interest), never keyed")] },
  // Rule 6: every origination artifact re-keyed to loan_id with its retention class; the security instrument copy is `required_for_servicing_file`.
  { name: "indexDocuments", kind: "act", handler: compute((i, _c, rt) => { need(i, "application_id"); return svc(rt).indexDocuments(str(i, "application_id")); }) },
  // Rule 7: origination consents re-keyed with provenance=origination; servicing scope only from the disclosure version + demonstration; never inferred.
  { name: "boardConsents", kind: "act", handler: compute((i, _c, rt) => { need(i, "application_id"); return svc(rt).boardConsents(str(i, "application_id")); }),
    guardrails: [never("NO_INFERRED_CONSENT", "30.2 guardrails: the agent may not infer consents or TCPA authority; an oral 'yes' is evidence, not consent (7001(c)(6))", (i) => flag(i, "infer") || flag(i, "inferred") || i.captured_via === "voice", "consent scope is decided from the disclosure version, the borrower's election and the demonstration test only")] },
  // 30.4 rule 10: the verification set (codes + anchors) recorded as `timers.seeded`; the instances themselves are armed by the registry on the boarding events.
  { name: "seedTimers", kind: "act", handler: compute((i, _c, rt) => { need(i, "application_id"); return svc(rt).seedTimers(str(i, "application_id")); }) },
  // Rule 10: the first-payment letter (mail; portal copy with consent) carrying the B-1 text and, on OW-002, the 7.4 invitation — the only borrower contact this process makes.
  { name: "sendNotice", kind: "act", handler: compute(async (i, _c, rt) => { need(i, "application_id"); const template = str(i, "template_code") || FIRST_PAYMENT_LETTER; if (template !== FIRST_PAYMENT_LETTER) throw new RangeError(`30.2 sends only ${FIRST_PAYMENT_LETTER} (with ${ESIGN_INVITATION} enclosed on OW-002)`);
      return svc(rt).sendFirstPaymentLetter(str(i, "application_id"), { sent_on: D(str(i, "sent_on") || svc(rt).d.clock.now().slice(0, 10)), mailed_at: (i.mailed_at as string | undefined) ?? null }); }),
    guardrails: [never("LETTER_AND_INVITATION_ONLY", "30.2 guardrails: the agent never contacts the borrower except through the first-payment letter and the 7.4 invitation", (i) => !!str(i, "template_code") && str(i, "template_code") !== FIRST_PAYMENT_LETTER && str(i, "template_code") !== ESIGN_INVITATION, `only ${FIRST_PAYMENT_LETTER} (carrying ${ESIGN_INVITATION} when OW-002) may be sent from boarding`),
      never("INFORMATIONAL_NOT_TRANSFER_NOTICE", "30.2 rule 10 / §1024.33(b): the letter is informational — not a notice of servicing transfer, not a collection communication", (i) => flag(i, "as_transfer_notice") || flag(i, "collection"), "no servicing is transferred at boarding (§1024.2(b)); the letter states the payee is as disclosed at closing")] },
  { name: "writeDecision", kind: "act", handler: decision() },
]);

export type { OriginationSnapshot };
