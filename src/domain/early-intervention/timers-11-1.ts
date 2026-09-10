/**
 * §11.1 timer overrides (process-owned; the §11 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 11.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_11_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // The 11.1 dial request (ops-11-1.ts requestDial, recorded by the 11.3 contact.log tool for every outbound attempt)
  // spells the dialer mode `ai_voice` / `human_voice` (the TCPA gates condition on `mode=ai_voice`), the 11.4 Contact
  // Engine request spells `voice` (incl. voicemails): the registry row's "every outbound voice attempt" is the union.
  o("REGF_1006_14_CALL_CAP_7IN7", { trigger: "`contact.attempt.requested{mode∈{voice, ai_voice, human_voice}, direction=outbound, fdcpa_debt_collector_flag=true}`", evaluator: "11.1.callCap7in7", why: "§11.1 timer table: trigger 'every outbound voice attempt on `fdcpa_debt_collector_flag=true`'; rule 9: `calls_7d` 'counts every outbound voice attempt that rang (answered or not, including voicemail) … by AI or human'; max 7 counted calls per person per debt in trailing 7 days (Reg F §1006.14(b))." });
}
