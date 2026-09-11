"use client";

/**
 * 32.7 §2 — the closing types 26.2's `decideClosingType` allows for this loan (RON only when the state is on the FNMA
 * list and the agent/notary can run it; IPEN; hybrid; paper), one radio each, labelled by copy key. The ScheduleCard
 * filters its slots to the chosen type: the slot the borrower books carries `closing_type_preference`, and 26.2's
 * `runPreSessionChecks{schedule}` records the election — the card never decides eligibility itself (T4, T5).
 */
import type { ClosingTypeOption, ScheduleSlot } from "@/lib/types/cards";
import { copy } from "@/lib/copy";

export function defaultClosingType(options: readonly ClosingTypeOption[] | undefined, preferred?: string): string | undefined {
  if (!options?.length) return undefined;
  return (preferred && options.some((o) => o.id === preferred) ? preferred : undefined) ?? options.find((o) => o.is_default)?.id ?? options[0]?.id;
}

/** The slots for a closing type (all slots when the card carries no types — 32.6's appraisal visits, callbacks). */
export function slotsForType(slots: readonly ScheduleSlot[], closingType: string | undefined): ScheduleSlot[] {
  if (!closingType) return [...slots];
  return slots.filter((s) => !s.closing_type || s.closing_type === closingType);
}

export function ClosingTypeOptions({ options, value, onChange, name, disabled, fallbackCopyKey }: { options: readonly ClosingTypeOption[]; value: string | undefined; onChange: (id: string) => void; name: string; disabled?: boolean; fallbackCopyKey?: string }) {
  return (
    <fieldset className="sm-fieldset" data-testid="closing-type-options">
      <legend>How you'll sign</legend>
      <div className="sm-radios">
        {options.map((o) => (
          <label key={o.id} data-closing-type={o.id}>
            <input type="radio" name={name} value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} disabled={disabled} />
            <span>{copy(o.copy_key)}</span>
          </label>
        ))}
      </div>
      {fallbackCopyKey && !options.some((o) => o.id === "ron") ? <p className="sm-muted" data-testid="closing-type-fallback">{copy(fallbackCopyKey)}</p> : null}
    </fieldset>
  );
}
