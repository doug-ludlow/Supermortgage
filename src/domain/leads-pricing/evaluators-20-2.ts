/**
 * §20.2 gate evaluators, keyed "20.2.<name>". Every key must be named by an `evaluator:` override in
 * timers-20-2.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts come from the touch context (ops-20-2.ts checkGates / the gate fact adapters): `{ consents, partner_name,
 * number, kind | channel }`, `{ on_national_registry, as_of, last_transaction_on, last_inquiry_on,
 * company_dnc_requested_on, national_dnc_written_permission }`, `{ as_of, anchor_on, company_dnc_requested_on }`,
 * `{ at, time_zones | tz, channel, state_window }`, `{ creative, rendered_text, rate_sheet_current }`,
 * `{ campaign_kind, channel, prescreen_enabled, prescreen }`.
 */
import type { Evaluator } from "../../app/evaluator-kit.ts";
import { pewcGateFromFacts, nationalDncGateFromFacts, ebrWindowFromFacts, quietHoursGateFromFacts, creativeApprovalGateFromFacts, prescreenGateFromFacts } from "./ops-20-2.ts";

export const EVALUATORS_20_2: Record<string, Evaluator> = {
  /** TCPA_64_1200_A2_PEWC_GATE (rule 3; T1/T2/T12): marketing PEWC — written, active, both (f)(9) elements, seller = partner, SM on its behalf, the number as entered — for an AI-voice/SMS touch to a charged-for line. */
  "20.2.pewcGate": (f) => pewcGateFromFacts(f),
  /** TCPA_64_1200_A3_LANDLINE_PEWC_GATE (§64.1200(a)(3); worked example 4): the same PEWC for an artificial-voice marketing call to a residential landline. */
  "20.2.landlinePewcGate": (f) => pewcGateFromFacts(f),
  /** TCPA_64_1200_C2_NATIONAL_DNC_GATE (T4): not on the registry, or an EBR (transaction 18 m / inquiry 3 m, terminated by a company DNC), or signed written permission. */
  "20.2.nationalDncGate": (f) => nationalDncGateFromFacts(f),
  /** TCPA_64_1200_F5_EBR_TRANSACTION_18M: the transaction EBR window is open while as_of < anchor + 18 months and no company DNC. */
  "20.2.ebrTransactionWindow": (f) => ebrWindowFromFacts(f, "transaction_18m"),
  /** TCPA_64_1200_F5_EBR_INQUIRY_3M: the inquiry EBR window is open while as_of < inquiry + 3 months and no company DNC. */
  "20.2.ebrInquiryWindow": (f) => ebrWindowFromFacts(f, "inquiry_3m"),
  /** TCPA_64_1200_C1_QUIET_HOURS_GATE (rule 5; T9): 09:00–20:00 policy inside the 08:00–21:00 rule in every called-party tz, no Sundays/federal holidays, state overrides. */
  "20.2.quietHoursGate": (f) => quietHoursGateFromFacts(f),
  /** SM_CAMPAIGN_CREATIVE_APPROVAL_GATE (T7/T8): creative approved, not superseded, all checklist items true, rate sheet current, rendered text investor-blind. */
  "20.2.creativeApprovalGate": (f) => creativeApprovalGateFromFacts(f),
  /** FCRA_615D_PRESCREEN_NOTICE_GATE (rule 9; T11): flag on, 12 CFR 1022.54(c)–(d) short and long notices on a written solicitation, criteria frozen, 25-month retention set. */
  "20.2.prescreenNoticeGate": (f) => prescreenGateFromFacts(f),
};
