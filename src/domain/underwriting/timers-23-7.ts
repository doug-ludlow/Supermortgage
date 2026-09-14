/**
 * §23.7 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 23.7 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * `SM_DU_PREFLIGHT_GATE` needs no override: the registry row parses as written — kind not_before_gate, trigger
 * `du.document.emitted` (23.6), anchor `emitted_at` (a payload field), offset `0` (src/kernel/timers/offset.ts parses a
 * bare "0" as a same-day offset, i.e. the gate opens on the anchor and holds until satisfied), satisfied by
 * `du.preflight.passed` (23.7) — so `npm run spec:lint -- --verbose` lists it under neither "prose offsets" nor
 * "unparsed triggers" nor "still unarmable" nor "not satisfiable". Spec breach column: "hold; `du.submitted` cannot be
 * emitted for the document" — the hold is 23.1's `submit` evaluating the gate (23.7-T10), not a registry concern.
 * tools/audit.py counts the code as built only once source emits both events (Phase 6: emit.ts / preflight.ts).
 *
 * Phase 6 note — origination context. This is a section-23 (≥ 20) row, so the engine arms it ONLY for an event that
 * carries origination context (src/kernel/timers/engine.ts isOriginationContext: `DomainEvent.applicationId`, an
 * `application` aggregate, or `payload.application_id` / `source = 'origination'` / `origination: true`). 23.6's
 * `du.document.emitted` and 23.7's `du.preflight.passed` must therefore be appended with `applicationId` (and
 * `origination: true` on the payload, as every 33.x payload does) or the gate never arms and never satisfies; the
 * instance's subject is the event's aggregate, so both events must name the same aggregate (the `du_documents` row
 * or the application) for sameSubject to match the satisfied event to the armed clock.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_23_7(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  void o; // no 23.7 overrides yet — add `o(code, { … , why })` rows here.
}
