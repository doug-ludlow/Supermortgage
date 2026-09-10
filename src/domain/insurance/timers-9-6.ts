/**
 * §9.6 timer overrides (process-owned; the §9 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 9.6 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. Every event named here is appended by a real code path in ./ops-9-6.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_9_6(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // The 45-day clocks arm on the process's own `flood.fpi.notice.sent` (spec timer table: trigger `flood.fpi.notice.sent`,
  // anchor "mailed date"), appended by ops-9-6 recordFloodNoticeMailed on the proof of mailing — or by sendFloodNotice45 on
  // a delivery the Notice Registry made electronically under an active E-SIGN consent. The section-level `notice.mailed`
  // trigger never fires for an e-delivered notice (the catalog row keeps the section default `esign_or_mail`), so the gate
  // and the place-after-45 deadline would never arm for it.
  o("FDPA_4012A_E_FLOOD_FPI_NOTICE_45", { trigger: "`flood.fpi.notice.sent{template=INS_FLOOD_FPI_NOTICE_45}`", anchor: "`mailed_at`",
    why: "§9.6 timer table: trigger `flood.fpi.notice.sent`, anchor 'mailed date', +45 calendar_days — 42 U.S.C. §4012a(e)(2): 'if the borrower fails to purchase … within 45 days after notification'; the event carries `mailed_at` (the proof-of-mailing date, or the e-delivery date when the registry delivered under E-SIGN) and `template`, so only the 45-day flood notice opens the gate." });
  o("FDPA_4012A_E2_FLOOD_PLACE_AFTER_45", { trigger: "`flood.fpi.notice.sent{template=INS_FLOOD_FPI_NOTICE_45}`", anchor: "`mailed_at`", offset: "+45 calendar_days",
    why: "§9.6 timer table: 'gate opens' = t0 + 45 of the flood notice (anchor 't0 + 45', offset 0: place on the first day allowed; Fannie Mae B-3-01 'no lapses of coverage') — armed by the same `flood.fpi.notice.sent` as the gate, due on the 45th day, satisfied by `flood.lpi.bound` (ops-9-6 bindFloodLpiPlacement)." });
  o("INS_FLOOD_NOTICE_SLA_3BD", { anchor: "`detected_at`", satisfied: "`flood.fpi.notice.sent{template=INS_FLOOD_FPI_NOTICE_45}`",
    why: "§9.6 timer table: trigger `flood.deficiency.detected` (ops-9-6 evaluateFloodCoverage carries `detected_at`, the anchor 'detection'), 3 business_days_servicer, satisfied by `flood.fpi.notice.sent` — conditioned on the template so a hazard notice on the same loan cannot close the flood SLA (statute: 'shall notify', §4012a(e)(1))." });
  o("FNMA_B301_FLOOD_REMAP_COVERAGE_120", { trigger: "`flood.map_change.received{direction=into_sfha}`",
    why: "§9.6 timer table: trigger '`flood.map_change.received` (into SFHA)' — the parenthetical is the `direction` the column grammar drops (B-3-01: remapped **into** an SFHA → coverage within 120 days after the effective date of the remapping; a remap out releases the requirement instead, rule 7). Anchor `effective_date` from the section override; satisfied by `flood.coverage.verified` or `flood.lpi.bound`." });
  o("NFIP_44CFR6111_MAP_REVISION_1DAY_13M", { trigger: "`flood.map_change.received{direction=into_sfha}`", anchor: "`effective_date`",
    why: "§9.6 timer table: informational 13-month window from the map revision's 'effective date' (44 CFR 61.11: 1-day effective date during the 13 months after a map revision that places the building in an SFHA; worked timeline: the 2027-02-03 revision into AE) — anchored on `effective_date` of the `flood.map_change.received{direction=into_sfha}` ops-9-6 receiveVendorMessage appends; ends when coverage is verified." });
  o("FLOOD_LOL_HEARTBEAT_35", { anchor: "`received_at`",
    why: "§9.6 timer table: anchor 'last heartbeat' = `received_at` of the vendor message (`flood.lol.message.received`, appended by ops-9-6 receiveVendorMessage for every determination_result / map_change_notification / community_status_change / lomr_loma_received on the vendor aggregate); the next message satisfies the open row and arms the next 35-day window." });
}
