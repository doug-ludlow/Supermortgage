/**
 * 32.18 rule 7 — the gap-to-card mapping (spec/sections/32-borrower-experience/32-18-*.md rule 7, T8): 23.6 assembles the DU
 * document with `conditionality = report` and names every required data point it could not fill on
 * `du.document.emitted{required_missing, gaps[{code, path}]}`; each gap the borrower supplies becomes the card that collects it,
 * re-sent as the current ask, and each gap the platform derives is logged, never asked. The mapping itself lives beside the
 * cards it re-sends (3-entry.ts `reactDuGaps` / `gapCards`: the declarations sequence, the address confirm card, the home card).
 *
 * This flow is registered after 5-verification (flows/index.ts FLOWS) on purpose: the emission commits in the same settlement
 * as `du.findings.interpreted`, on which 5-verification sends the needs checklist; a reaction from 3-entry would raise the
 * re-sent card before that checklist and the rail (01 §1.3: the newest pending card is the current ask) would pin the
 * checklist instead. Registered here, the re-sent card is the last one raised by the settlement.
 *
 *   du.document.emitted{required_missing > 0, gaps}     the cards, one per ask per emission (flow_key suffixed by the emission)
 *   du.preflight.refused{code, xpath, rule}              23.7's refusal over the same emission (23.1 buildDuRequest runs preflight inline): its one XPath maps the same way
 */
import { reactDuGaps } from "./3-entry.ts";
import type { BorrowerFlow } from "./index.ts";

export const FLOW_ID = "32.18";
const REACTS = new Set(["du.document.emitted", "du.preflight.refused"]);

export const FLOW_18_DU_GAPS: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  onEvents: (deps, events) => reactDuGaps(deps, events),
};
