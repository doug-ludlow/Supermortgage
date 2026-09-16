/**
 * §35.2 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.2 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.2's recurring clocks (SM_DOC_INTEGRITY_DAILY) are global: each is armed by a per-day (or per-run) completion receipt on
 * the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"` override
 * on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The deadline rows of 35.2
 * parse and arm from the registry as written and need no override.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1 (SM_DOC_WORM_DRAIN_1D): the satisfied event must carry the verified generation. Emitters: src/domain/operations-runtime/documents/store.ts
  // (`document.staged{document_id, staged_at}` from documents.store; `document.stored{document_id, storage_uri, stored_generation}` from the drain after the re-read hash matched).
  o("SM_DOC_WORM_DRAIN_1D", { satisfied: "`document.stored{stored_generation}`",
    why: "§35.2 rule 4: the drain 'puts the object with x-goog-if-generation-match: 0, re-reads it, compares the hash and only then swaps storage_uri … and emits document.stored'; Outputs: `document.stored{document_id, storage_uri, stored_generation}`. 10.x's `documents.store` tool (src/app/tools/section10.ts) emits a `document.stored{id, version, fields}` of its own that stores no bytes and carries no generation — the clock is satisfied only by the event that carries the verified `stored_generation` (one name, one meaning: the field condition keeps 10.x's event from satisfying a drain clock)." });
  // Timer table row 2: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent), at the hour the spec names.
  o("SM_DOC_INTEGRITY_DAILY", { anchorField: "as_of_date", offset: "+1 calendar_days, 02:30 ET", subject: "global",
    why: "§35.2 timer table row `SM_DOC_INTEGRITY_DAILY`: recurring on `document.integrity.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `document.integrity.run_completed`, breach 'sev 1 → `ciso` (no integrity run today — 19.1 \"integrity job verifies hashes daily\")' — 'Trigger & frequency: On every rendered notice, disclosure, closing document, statement and 1098 (per loan or application); on every borrower upload and vendor delivery (bytes in); the staged-blob drain every sweep; the integrity run daily at 02:30 America/New_York; a mail batch per notice batch; an envelope on demand from the owning process'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
}
