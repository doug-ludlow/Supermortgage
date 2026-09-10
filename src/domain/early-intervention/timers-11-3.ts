/**
 * §11.3 timer overrides (process-owned; the §11 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 11.3 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_11_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // No 11.3 process overrides: the section's rows in ./timers.ts already spell the three gates the way the platform emits them —
  // `contact.started{party_role∈{trusted_advisor, authorized_third_party}}` (thirdPartyConversation), `contact.modification_terms.discussed`
  // (modificationTermsDiscussed) and `investor_events.building{family=qrpc}` (buildQrpcInvestorEvent), all in ./ops-11-3.ts, called by
  // the 11.3 tools identity.verify / authorization.record / lossmit_facts.get / qrpc.capture (src/app/tools/section11.ts).
  void o; // add `o(code, { … , why })` rows here when a 11.3 row needs a spelling the section's override does not carry.
}
