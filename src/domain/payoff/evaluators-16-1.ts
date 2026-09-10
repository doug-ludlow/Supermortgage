/**
 * §16.1 gate evaluators, keyed "16.1.<name>". Every key must be named by an
 * `evaluator:` override in timers-16-1.ts / the section timers.ts and vice versa (src/app/app.test.ts checks both).
 *   16.1.goodThroughWithin30Days — SM_PAYOFF_GOOD_THROUGH_MAX_30: good-through ≤ receipt + 30 CD (decision 4).
 *   16.1.wireInstructionsVerified — SM_PAYOFF_WIRE_VERIFY_GATE: wire instruction version = active vault version; token
 *     minted for this statement hash on that version (facts: verification_token, statement_hash, minted_token,
 *     minted_statement_hash, minted_wire_instruction_version_id, minted_issued_at from the mintVerificationToken record).
 */
import { ok, no, s, daysBetween, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { wireVerifyGate } from "./ops-16-1.ts";

export const EVALUATORS_16_1: Record<string, Evaluator> = {
  "16.1.goodThroughWithin30Days": (f) => {
    const received = s(f, "received_on") as PlainDate, goodThrough = s(f, "good_through") as PlainDate;
    if (!received || !goodThrough) return no("received_on and good_through are required (SM_PAYOFF_GOOD_THROUGH_MAX_30)");
    const d = daysBetween(received, goodThrough) - 1;   // funds are deemed received on good_through: the statement covers receipt + 1 … good_through − 1
    return d <= 30 ? ok : no(`good-through ${goodThrough} covers ${d} calendar days after receipt ${received} (> 30): quote to receipt + 30 days with the per-diem instruction (16.1 decision 4)`);
  },
  "16.1.wireInstructionsVerified": (f) => {
    const minted = s(f, "minted_token") ? { token: s(f, "minted_token"), statement_hash: s(f, "minted_statement_hash"), wire_instruction_version_id: s(f, "minted_wire_instruction_version_id"), issued_at: s(f, "minted_issued_at") } : null;
    const r = wireVerifyGate({ wire_instruction_version_id: s(f, "wire_instruction_version_id") || null, active_vault_version_id: s(f, "active_vault_version_id"), verification_token: s(f, "verification_token") || null, source: (s(f, "wire_instruction_source") || "vault") as "vault",
      ...(s(f, "statement_hash") || minted ? { statement_hash: s(f, "statement_hash") || null, minted } : {}) });
    return r.open ? ok : no(`${r.reason}${r.alert ? ` — fraud signal to ${r.alert.to}` : ""}`);
  },
};
