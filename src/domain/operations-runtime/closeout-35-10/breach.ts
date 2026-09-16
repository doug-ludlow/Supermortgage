/**
 * §35.10 — a breached closeout clock names its closeout (T13): the arming `refinance.closeout.step.entered` payload's application_id, prior_loan_id,
 * closeout_id, step (the transition it waited to make) and waiting_on ride on the sweep's escalation (35.3's paged breach pass reads it).
 */
type Row = Record<string, unknown>;
export const BREACH_PAYLOAD_KEYS = ["application_id", "prior_loan_id", "closeout_id", "step", "waiting_on", "servicer_loan_number", "tape_status"] as const;
export function breachPayloadOf(armingPayload: Row | null): Row {
  if (!armingPayload) return {};
  const out: Row = {};
  for (const k of BREACH_PAYLOAD_KEYS) if (armingPayload[k] !== undefined && armingPayload[k] !== null) out[k] = armingPayload[k];
  // a clocked wait entered on a transition (the port the step waits on) names it: `awaiting_schedule → quote`
  if (typeof armingPayload["transition"] === "string") out["step"] = armingPayload["transition"];
  return out;
}
