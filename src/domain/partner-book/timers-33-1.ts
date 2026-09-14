/**
 * §33.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 33.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * `SM_PARTNER_BOOK_INVITATION_REMINDER_14` needs no override: the registry row parses as written — trigger
 * `partner_book.invitation.sent{kind=invitation}` (src/kernel/events/match.ts parses the `{kind=invitation}` payload
 * filter into a `=` condition the engine applies with eventMatches), anchor `sent_at` (a payload field), offset
 * `+14 calendar_days`, satisfied `partner_book.account.activated` — so `npm run spec:lint -- --verbose` lists it under
 * neither "unparsed triggers" nor "still unarmable" nor "not satisfiable", and tools/audit.py sees it armable and
 * satisfiable. It is a section-33 (≥ 20) row, so the engine arms it only for an event carrying origination context
 * (src/kernel/timers/engine.ts isOriginationContext: `origination: true` on every 33.x payload); the instance's subject
 * is the event's aggregate — a loan-scoped `partner_book.invitation.sent{loan_id}` arms a `{loan, <loan_id>}` clock and a
 * loan-scoped `partner_book.account.activated` on the same loan satisfies it (sameSubject). Breach action (spec timer
 * table: "sev 3 → `portfolio` (one reminder on the same channel, then the clock closes)") is src/runtime/partner-book.ts
 * sendPartnerBookReminders, run from the sweep's breach pass — not a registry concern.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_33_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  void o; // no 33.1 overrides needed (see the header) — add `o(code, { … , why })` rows here only if a row stops parsing.
}
