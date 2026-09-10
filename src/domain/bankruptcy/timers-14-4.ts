/**
 * §14.4 timer overrides: for every 14.4 registry row whose trigger or "Satisfied by" column
 * is prose, a `reg.override(code, { trigger?, satisfied | evaluator, anchorField?, why })`
 * naming an event some bus tool or runner actually emits — this process's
 * `bk.reporting_state.write` (`bankruptcy.reporting_state.changed/reviewed/retracted`), 14.1's
 * `bk.case.read/write` (`bankruptcy.case.written`, src/app/tools/section14-1.ts) or 8.1's cycle
 * runner (`metro2.loan.furnished` per loan at transmission, src/domain/credit-reporting/ops.ts).
 * 14.1's ops functions return `bankruptcy.status.changed` / `bankruptcy.case.dismissed` as data
 * and no bus tool forwards them, so no override names them (see src/domain/foreclosure/timers.ts
 * applyForeclosureSatisfiedOverrides for the pattern). Called from this section's timers.ts after
 * the section-level overrides (and after 8.3's, src/domain/timer-overrides.ts), so these win the merge.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_14_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // "any 14.1 phase event" → on the bus a 14.1 phase change is the case-record write (`bk.case.read/write{op=write}` emits
  // `bankruptcy.case.written{id, version, fields}` — the payload carries no status, so every case write arms the 1-BD sync and the
  // feed answers with the row it writes (`.changed`), the no-change review of a non-phase write or a relief order (`.reviewed`, rule 8)
  // or the retraction of a false match (`.retracted`, rule 10); `bankruptcy.reporting_state.*` covers the three).
  o("SM_BK_CR_STATE_SYNC_1BD", { trigger: "`bankruptcy.case.written`", satisfied: "`bankruptcy.reporting_state.*`",
    why: "§14.4 timer table: 'any 14.1 phase event' → `bankruptcy_reporting_state` row written within 1 `business_days_servicer`; the phase event on the bus is 14.1's case-record write (`bankruptcy.case.written`), answered by the feed's row/review/retraction event (rule 8: relief from stay is 'no reporting change by itself' — reviewed, not written)." });
  // "`bankruptcy.case.dismissed/withdrawn`": 14.1 emits only the dismissal (as data); `withdrawn` is 14.4's own mapping of the debtor's
  // voluntary dismissal (14.4-Q3), so the deadline arms on the feed's row carrying either phase. "CII I–P for one cycle … freeze released"
  // is the next snapshot 8.3 derives from that row: the per-loan `metro2.loan.furnished` the 8.1 runner emits when the cycle transmits
  // (the row's `supersedes` names the petition `freeze_status` suppression 8.3 releases; the payload of `metro2.loan.furnished` carries
  // no CII, so the pattern cannot yet be narrowed to `{cii∈{I…P}}` — an 8.1 payload change).
  o("SM_BK_CR_DISMISSAL_RELEASE_NEXT_CYCLE", { trigger: "`bankruptcy.reporting_state.changed{phase∈{dismissed, withdrawn}}`", anchorField: "dismissal_date", satisfied: "`metro2.loan.furnished`",
    why: "§14.4 timer table: `bankruptcy.case.dismissed/withdrawn` → 'CII I–P for one cycle then Q; freeze released' at the next snapshot (rule 6; 14.4-Q3 maps the debtor's own motion to `withdrawn`); satisfied when the next cycle furnishes the loan (`metro2.loan.furnished`, CreditCycleRunner.transmit); sev-2 — a stale freeze is an inaccuracy." });
  // "`bankruptcy.case.discharged` with `debt_discharged=true`": the flag is the feed's derivation (data model), carried on its event; the
  // E/H final record with zero balances and Date Closed is the `delete_account` overlay 8.3 derives from that row (`bankruptcy_discharged`)
  // and furnishes in the next cycle — `metro2.loan.furnished` for the loan (not `credit.suppression.created`, which 8.3 emits the moment
  // it books the suppression, before any snapshot); after that record the account is `final_reported` (8.3 state machine; 8.3-Q4 default).
  o("SM_BK_CR_DISCHARGE_FINAL_RECORD", { trigger: "`bankruptcy.reporting_state.changed{phase=discharged, debt_discharged=true}`", anchorField: "discharge_date", satisfied: "`metro2.loan.furnished`",
    why: "§14.4 timer table: discharge with `debt_discharged=true` → 'CII E/H record with zero balances and Date Closed; then `final_reported`' in the next snapshot (rule 5; rule 4 surrender); satisfied when that cycle furnishes the loan (`metro2.loan.furnished`); sev-2." });
  // "`bankruptcy.reaffirmation.filed`" is 14.1 data no bus tool emits; the gate arms on the feed's row that records the filing
  // (`reaffirmation_date` set, not yet `reaffirmation_final`; a rescission clears `reaffirmation_date`, so it never re-arms on V).
  // "until `USC_524C4_REAFFIRM_RESCISSION` expiry": the later of the discharge and 60 days after the agreement was filed (11 U.S.C. §524(c)(4));
  // the gate is EVALUATORS_14_4["14.4.reaffirmationFinal"] (evaluators-14-4.ts), which corrects the inline definition's discharge + 60 anchor.
  o("SM_BK_CR_REAFFIRM_HOLD", { trigger: "`bankruptcy.reporting_state.changed{reaffirmation_date is not null, reaffirmation_final=false}`", evaluator: "14.4.reaffirmationFinal", anchorField: "reaffirmation_date",
    why: "§14.4 timer table: `bankruptcy.reaffirmation.filed` → hold 'until `USC_524C4_REAFFIRM_RESCISSION` expiry (14.1)' — later of discharge_at or filed_at + 60 calendar days — then `reaffirmation_final=true` → CII R (rule 5; T5: filed 2026-11-20, discharge 2026-12-15 → A through 2027-01-19, R on the Jan-31-2027 snapshot); armed by the feed's row carrying the filing." });
  // BK_CII_APPLY_NEXT_CYCLE is 8.3's row (src/domain/credit-reporting/timers.ts names `metro2.snapshot.built{cii_applied=true}`, which no
  // runner emits); the 14.4 row triggers on the feed's event and is satisfied by 'snapshot carries the phase's CII/mechanism' — the next
  // cycle furnishing the loan (`metro2.loan.furnished`), the CII being 8.3's derivation from the row. 8.3's offset (1st of next month 00:05 ET) is kept.
  o("BK_CII_APPLY_NEXT_CYCLE", { trigger: "`bankruptcy.reporting_state.changed`", satisfied: "`metro2.loan.furnished`",
    why: "§14.4 timer table: `bankruptcy.reporting_state.changed` → next `FNMA_C41_01_METRO2_SNAPSHOT_EOM` 'carries the phase's CII/mechanism' — the loan furnished in that cycle (`metro2.loan.furnished`, CreditCycleRunner.transmit); `officer` sev-2." });
  // SM_CR_SUPPRESSION_REVIEW_30 is 8.3's row for every suppression reason ("review recorded" → `credit.suppression.reviewed`, an 8.3 review
  // tool 8.3 has yet to emit); the 14.4 half — 'review with docket check (14.1 daily sync)' — is `bk.reporting_state.write{op=review}`
  // (`bankruptcy.reporting_state.reviewed{docket_checked=true}`), which 8.3's review can forward. Owned there; not overridden here.
}
