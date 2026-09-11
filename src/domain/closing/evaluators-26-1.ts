/**
 * §26.1 gate evaluators, keyed "26.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-26-1.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts are `setGateFacts(set, txReview, note_date, templates)` from ops-26-1.ts plus the CTC facts of `docGenGate`.
 */
import { ok, no, b, s, arr, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
import { docGenGate, templateVersionCheck, txOneYearRule, type DocumentTemplate, type QcRuleCode } from "./ops-26-1.ts";

const date = (f: Record<string, unknown>, k: string): PlainDate | null => (typeof f[k] === "string" && /^\d{4}-\d{2}-\d{2}/.test(f[k] as string) ? plainDate((f[k] as string).slice(0, 10)) : null);

export const EVALUATORS_26_1: Record<string, Evaluator> = {
  /** SM_O71_DOC_GEN_GATE: final CD delivered, approval with PTD cleared, 24.4 trust/POA and 25.1 compliance gates open, lock active through the closing date. */
  "26.1.docGenGate": (f) => { const r = docGenGate({ final_cd_delivered: b(f, "final_cd_delivered"), approval_ptd_cleared: b(f, "approval_ptd_cleared"), trust_poa_gate_open: b(f, "trust_poa_gate_open"), compliance_pass_cd_gate_open: b(f, "compliance_pass_cd_gate_open"), lock_status: s(f, "lock_status"), lock_expires_on: date(f, "lock_expires_on"), closing_date: date(f, "closing_date") }); return r.open ? ok : no(r.reason!); },
  /** SM_O71_TEMPLATE_VERSION_GATE (Uniform Instruments Fact Sheet Jan 2023; Legal Documents archive): every template mandatory on the note date, none retired, one revision family. */
  "26.1.templateVersionGate": (f) => { const t = arr<DocumentTemplate>(f, "templates"); const nd = date(f, "note_date"); if (!t.length || !nd) return no("templates and note_date required"); const r = templateVersionCheck(t, nd); return r.result === "pass" ? ok : no(`DQC_TEMPLATE_VERSION ${r.reason}: ${r.detail}`); },
  /** SM_O71_DOC_QC_PASS_GATE: every hard document_qc_checks rule passed or was officer-waived. */
  "26.1.docQcPassGate": (f) => { const c = arr<{ rule_code: QcRuleCode; result: string; severity?: string }>(f, "checks"); if (!c.length) return no("no document_qc_checks recorded"); const bad = c.filter((x) => x.result === "fail" && x.severity !== "soft").map((x) => x.rule_code); return bad.length ? no(`failed: ${bad.join(", ")}`) : ok; },
  /** SM_O71_INSTRUCTIONS_ACK_GATE (B5-4.1-03): the title company's acknowledgment is mandatory for TX 50(a)(6); policy (warning) elsewhere. */
  "26.1.instructionsAckGate": (f) => (b(f, "tx_50a6") && !f.acknowledged_at ? no("TX 50(a)(6): closing instructions not acknowledged by the settlement agent") : ok),
  /** TX_50A6_ONE_YEAR_GATE (§50(a)(6)(M)(iii)): closing on/after the first anniversary of the prior 50(a)(6) closing on the same homestead. */
  "26.1.txOneYearGate": (f) => { const cd = date(f, "closing_date"); if (!cd) return no("closing_date required"); const r = txOneYearRule(date(f, "prior_50a6_closing_date"), cd); return r.ok ? ok : no(`closing ${cd} before the anniversary ${r.anniversary}`); },
  /** TX_50F2_ONE_YEAR_GATE (§50(f)(2)(A)): the refinance is not closed before the first anniversary of the existing 50(a)(6) closing. */
  "26.1.txF2OneYearGate": (f) => { const cd = date(f, "closing_date"); if (!cd) return no("closing_date required"); const r = txOneYearRule(date(f, "existing_50a6_closing_date"), cd); return r.ok ? ok : no(`refinance ${cd} before the anniversary ${r.anniversary}`); },
};
