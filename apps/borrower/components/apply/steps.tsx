"use client";

/**
 * 32.19 §2.2 (docs/ux/18) — the nine Apply screens as components over `{draft, cards, record, busy, patch, onContinue}`.
 * Every rendered string is a copy key (the `apply.*` family, `refi.home.estate` / `refi.home.clean_energy_lien` for the
 * two home questions); the consents statement above Property's Continue is the goal card's own `props.statement`
 * (32.17 rule 20 — the tap writes the three rows; no checkbox). Session 1 wires goal and property for the three
 * branches; the You / Connect / Details / Questions / Demographics / Review / Result screens hold their values in the
 * draft and post nothing until Sessions 2–3 (docs/ux/18 §5).
 */
import { useId, type ReactNode } from "react";
import { copy, copyExtra, copyOptions } from "@/lib/copy";
import { SHOW_FAKE_MARKERS } from "@/lib/env";
import type { AnyCardInstance } from "@/lib/types/cards";
import type { BorrowerRecord } from "@/lib/types/record";
import { pending, resolved, type Draft, type EstateType, type Occupancy, type RefiGoal, type Step, type YesNo } from "./apply-model";

export type StepProps = {
  step: Step;
  draft: Draft;
  cards: readonly AnyCardInstance[];
  record: BorrowerRecord | null;
  busy: boolean;
  patch: (p: Partial<Draft>) => void;
  onContinue: () => void;
  setStep: (s: Step) => void;
};

function Continue({ busy, onContinue, disabled = false, labelKey = "apply.continue" }: { busy: boolean; onContinue: () => void; disabled?: boolean; labelKey?: string }) {
  return (
    <button type="button" className="sm-primary" data-testid="apply-continue" data-copy-key={labelKey} disabled={busy || disabled} onClick={onContinue}>
      {copy(labelKey)}
    </button>
  );
}

/** A labelled text input; the label is the copy key's text, the placeholder its `helper:` extra. */
function Field({ copyKey, value, onChange, inputMode, type = "text" }: { copyKey: string; value: string; onChange: (v: string) => void; inputMode?: "decimal" | "numeric" | "text"; type?: string }) {
  const id = useId();
  return (
    <>
      <label className="sm-label" htmlFor={id} data-copy-key={copyKey}>{copy(copyKey)}</label>
      <div className="sm-field">
        <input id={id} type={type} inputMode={inputMode} value={value} placeholder={copyExtra(copyKey, "helper")} onChange={(e) => onChange(e.target.value)} />
      </div>
    </>
  );
}

/** A labelled select whose options come from the copy key's `options` (`A` · `B`), mapped to the given ids in order; the empty choice repeats the question. */
function Select({ copyKey, value, ids, onChange }: { copyKey: string; value: string; ids: readonly string[]; onChange: (v: string) => void }) {
  const id = useId();
  const labels = copyOptions(copyKey);
  return (
    <>
      <label className="sm-label" htmlFor={id} data-copy-key={copyKey}>{copy(copyKey)}</label>
      <div className="sm-field">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{copy(copyKey)}</option>
          {ids.map((optionId, i) => (
            <option key={optionId} value={optionId}>{labels[i] ?? optionId}</option>
          ))}
        </select>
      </div>
    </>
  );
}

/** A row of choice buttons from a copy key's options, in the given id order. */
function Choices<T extends string>({ copyKey, ids, value, onChange, solid = false }: { copyKey: string; ids: readonly T[]; value: T | null; onChange: (v: T) => void; solid?: boolean }) {
  const labels = copyOptions(copyKey);
  return (
    <div className="sm-stack">
      {ids.map((id, i) => (
        <button key={id} type="button" className={`sm-choice${solid ? " solid" : ""}${value === id ? " selected" : ""}`} aria-pressed={value === id} onClick={() => onChange(id)}>
          <strong>{labels[i] ?? id}</strong>
        </button>
      ))}
    </div>
  );
}

function Bubble({ titleKey, children }: { titleKey: string; children: ReactNode }) {
  return (
    <div className="sm-bubble">
      <h1 data-copy-key={titleKey}>{copy(titleKey)}</h1>
      {children}
    </div>
  );
}

const OCCUPANCIES: readonly Occupancy[] = ["primary", "second_home", "investment"];
const REFI_GOALS: readonly RefiGoal[] = ["lower", "faster", "cash"];
const ESTATES: readonly EstateType[] = ["fee_simple", "leasehold"];
const YES_NO: readonly YesNo[] = ["no", "yes"];   // `refi.home.clean_energy_lien`'s options are No · Yes
const FIRST_TIME: readonly YesNo[] = ["yes", "no"];   // `apply.property.first_time`'s options are Yes · No

export function GoalStep({ draft, busy, patch, onContinue }: StepProps) {
  return (
    <div className="sm-bubble">
      <h1 className="sm-hero" data-copy-key="apply.goal.question">{copy("apply.goal.question")}</h1>
      <div className="sm-stack">
        <button type="button" className={`sm-choice${draft.intent === "purchase" ? " selected" : ""}`} aria-pressed={draft.intent === "purchase"} onClick={() => patch({ intent: "purchase" })}>
          <strong data-copy-key="apply.goal.buy">{copy("apply.goal.buy")}</strong>
        </button>
        <button type="button" className={`sm-choice${draft.intent === "refinance" ? " selected" : ""}`} aria-pressed={draft.intent === "refinance"} onClick={() => patch({ intent: "refinance" })}>
          <strong data-copy-key="apply.goal.refi">{copy("apply.goal.refi")}</strong>
        </button>
      </div>
      {draft.intent === "refinance" ? (
        <>
          <p className="sm-label" data-copy-key="apply.goal.refi_purpose">{copy("apply.goal.refi_purpose")}</p>
          <Choices copyKey="apply.goal.refi_purpose" ids={REFI_GOALS} value={draft.refiGoal} onChange={(refiGoal) => patch({ refiGoal })} />
        </>
      ) : null}
      <p className="sm-label" data-copy-key="apply.goal.occupancy">{copy("apply.goal.occupancy")}</p>
      <Choices copyKey="apply.goal.occupancy" ids={OCCUPANCIES} value={draft.occupancy} onChange={(occupancy) => patch({ occupancy })} />
      <Continue busy={busy} onContinue={onContinue} disabled={!draft.intent} />
    </div>
  );
}

export function PropertyStep({ draft, cards, busy, patch, onContinue }: StepProps) {
  const purchase = draft.intent === "purchase";
  const goal = pending(cards, "entry.goal.question");
  const tapped = Boolean(resolved(cards, "entry.goal.question"));   // back on Property after the tap: Continue re-runs the step's writes without a second tap (wire.ts `goalCardOf`)
  const statement = goal && goal.kind === "ChoiceCard" ? goal.props.statement : undefined;
  const statementVersion = goal && goal.kind === "ChoiceCard" ? goal.props.statement_version : undefined;
  const shopping = purchase && draft.shopping;
  return (
    <Bubble titleKey={purchase ? "apply.property.next" : "apply.property.current"}>
      {purchase ? (
        <div className="sm-switch" data-testid="apply-property-switch">
          <button type="button" className={!draft.shopping ? "active" : ""} aria-pressed={!draft.shopping} data-copy-key="apply.property.have_address" onClick={() => patch({ shopping: false })}>{copy("apply.property.have_address")}</button>
          <button type="button" className={draft.shopping ? "active" : ""} aria-pressed={draft.shopping} data-copy-key="apply.property.still_looking" onClick={() => patch({ shopping: true })}>{copy("apply.property.still_looking")}</button>
        </div>
      ) : null}
      {!shopping ? <Field copyKey="apply.property.address" value={draft.property} onChange={(property) => patch({ property })} /> : null}
      <Field copyKey="apply.property.state" value={draft.state} onChange={(state) => patch({ state: state.toUpperCase().slice(0, 2) })} />
      {shopping ? (
        <>
          <Field copyKey="apply.property.price_low" value={draft.priceLow} inputMode="decimal" onChange={(priceLow) => patch({ priceLow })} />
          <Field copyKey="apply.property.price_high" value={draft.priceHigh} inputMode="decimal" onChange={(priceHigh) => patch({ priceHigh })} />
          <Field copyKey="apply.property.down" value={draft.down} inputMode="decimal" onChange={(down) => patch({ down })} />
          <Select copyKey="apply.property.first_time" value={draft.firstTimeBuyer} ids={FIRST_TIME} onChange={(v) => patch({ firstTimeBuyer: v as YesNo })} />
        </>
      ) : purchase ? (
        <>
          <Field copyKey="apply.property.price" value={draft.price} inputMode="decimal" onChange={(price) => patch({ price })} />
          <Field copyKey="apply.property.down" value={draft.down} inputMode="decimal" onChange={(down) => patch({ down })} />
        </>
      ) : (
        <>
          <Field copyKey="apply.property.value" value={draft.value} inputMode="decimal" onChange={(value) => patch({ value })} />
          <Field copyKey="apply.property.balance" value={draft.balance} inputMode="decimal" onChange={(balance) => patch({ balance })} />
          {draft.refiGoal === "cash" ? <Field copyKey="apply.property.cash_out" value={draft.cashOut} inputMode="decimal" onChange={(cashOut) => patch({ cashOut })} /> : null}
        </>
      )}
      {!shopping ? (
        <>
          <Select copyKey="refi.home.estate" value={draft.estateType} ids={ESTATES} onChange={(v) => patch({ estateType: v as EstateType })} />
          <Select copyKey="refi.home.clean_energy_lien" value={draft.cleanEnergyLien} ids={YES_NO} onChange={(v) => patch({ cleanEnergyLien: v as YesNo })} />
        </>
      ) : null}
      {statement ? (
        <p className="sm-fine" data-testid="apply-consents" data-statement-version={statementVersion}>{statement}</p>
      ) : tapped ? null : (
        <p className="sm-fine" data-copy-key="apply.property.waiting">{copy("apply.property.waiting")}</p>
      )}
      <Continue busy={busy} onContinue={onContinue} disabled={!goal && !tapped} />
    </Bubble>
  );
}

const HOUSING = ["own", "rent", "free"] as const;

export function YouStep({ draft, busy, patch, onContinue }: StepProps) {
  const months = draft.months.replace(/\D/g, "");
  const under24 = months !== "" && BigInt(months) < 24n;
  return (
    <Bubble titleKey="apply.you.title">
      <p className="sm-lead" data-copy-key="apply.you.credit_note">{copy("apply.you.credit_note")}</p>
      <Field copyKey="apply.you.legal_name" value={draft.legalName} onChange={(legalName) => patch({ legalName })} />
      <Field copyKey="apply.you.dob" value={draft.dob} onChange={(dob) => patch({ dob })} />
      <Field copyKey="apply.you.ssn" value={draft.ssn} inputMode="numeric" onChange={(ssn) => patch({ ssn })} />
      <p className="sm-label" data-copy-key="apply.you.basis">{copy("apply.you.basis")}</p>
      <div className="sm-switch">
        {HOUSING.map((id, i) => (
          <button key={id} type="button" className={draft.housing === id ? "active" : ""} aria-pressed={draft.housing === id} onClick={() => patch({ housing: id })}>{copyOptions("apply.you.basis")[i] ?? id}</button>
        ))}
      </div>
      {draft.housing === "rent" ? <Field copyKey="apply.you.rent" value={draft.rent} inputMode="decimal" onChange={(rent) => patch({ rent })} /> : null}
      <Field copyKey="apply.you.months" value={draft.months} inputMode="numeric" onChange={(m) => patch({ months: m })} />
      {under24 ? (
        <div className="sm-card" data-testid="apply-prior-address">
          <h3 data-copy-key="apply.you.prior">{copy("apply.you.prior")}</h3>
          <Field copyKey="apply.property.address" value={draft.priorAddressLine} onChange={(priorAddressLine) => patch({ priorAddressLine })} />
          <Field copyKey="apply.property.state" value={draft.priorState} onChange={(priorState) => patch({ priorState: priorState.toUpperCase().slice(0, 2) })} />
          <Field copyKey="apply.you.months" value={draft.priorMonths} inputMode="numeric" onChange={(priorMonths) => patch({ priorMonths })} />
        </div>
      ) : null}
      <Continue busy={busy} onContinue={onContinue} />
    </Bubble>
  );
}

export function ConnectStep({ draft, busy, patch, onContinue }: StepProps) {
  return (
    <Bubble titleKey="apply.connect.title">
      {SHOW_FAKE_MARKERS ? <p className="sm-lead" data-copy-key="apply.connect.fake_note"><span className="sm-fake">{copy("apply.connect.fake_note")}</span></p> : null}
      <Field copyKey="apply.connect.income" value={draft.income} inputMode="decimal" onChange={(income) => patch({ income })} />
      <Field copyKey="apply.connect.employer" value={draft.employer} onChange={(employer) => patch({ employer })} />
      <Continue busy={busy} onContinue={onContinue} labelKey="apply.connect.cta" />
    </Bubble>
  );
}

const CITIZENSHIPS = ["us_citizen", "permanent_resident", "non_permanent_resident"] as const;
const MARITALS = ["unmarried", "married", "separated"] as const;

export function DetailsStep({ draft, busy, patch, onContinue }: StepProps) {
  return (
    <Bubble titleKey="apply.details.title">
      <Select copyKey="apply.details.citizenship" value={draft.citizenship} ids={CITIZENSHIPS} onChange={(v) => patch({ citizenship: (v || "us_citizen") as Draft["citizenship"] })} />
      <Select copyKey="apply.details.marital" value={draft.marital} ids={MARITALS} onChange={(v) => patch({ marital: (v || "unmarried") as Draft["marital"] })} />
      <Field copyKey="apply.details.dependents" value={draft.dependents} inputMode="numeric" onChange={(dependents) => patch({ dependents })} />
      {draft.marital === "married" ? <p className="sm-note" data-copy-key="apply.details.spouse_later">{copy("apply.details.spouse_later")}</p> : null}
      <Continue busy={busy} onContinue={onContinue} />
    </Bubble>
  );
}

export function QuestionsStep({ draft, busy, patch, onContinue }: StepProps) {
  return (
    <Bubble titleKey="apply.questions.title">
      <p data-copy-key="apply.questions.lead">{copy("apply.questions.lead")}</p>
      <div className="sm-stack">
        <button type="button" className={`sm-choice solid${draft.noneApply ? " selected" : ""}`} aria-pressed={draft.noneApply} onClick={() => patch({ noneApply: true })}>
          <strong data-copy-key="apply.questions.none">{copy("apply.questions.none")}</strong>
        </button>
        <button type="button" className={`sm-choice solid${!draft.noneApply ? " selected" : ""}`} aria-pressed={!draft.noneApply} onClick={() => patch({ noneApply: false })}>
          <strong data-copy-key="apply.questions.some">{copy("apply.questions.some")}</strong>
          <small data-copy-key="apply.questions.one_at_a_time">{copy("apply.questions.one_at_a_time")}</small>
        </button>
      </div>
      <Continue busy={busy} onContinue={onContinue} />
    </Bubble>
  );
}

export function DemographicsStep({ busy, onContinue }: StepProps) {
  return (
    <Bubble titleKey="apply.demographics.title">
      <p data-copy-key="apply.demographics.lead">{copy("apply.demographics.lead")}</p>
      <Continue busy={busy} onContinue={onContinue} />
    </Bubble>
  );
}

/** Review is a readiness view (owner decision 1): what the draft holds, the badge, the consents note; the number cards' CTA comes with Session 3. */
export function ReviewStep({ draft, record, cards }: StepProps) {
  const [purposeBuy = "", purposeRefi = ""] = copyOptions("apply.tasks.purpose");
  const [rowPurpose = "", rowHome = "", rowName = "", rowIncome = ""] = copyOptions("apply.review.rows");
  const purpose = draft.intent === "purchase" ? purposeBuy : draft.intent === "refinance" ? purposeRefi : copy("apply.tasks.purpose");
  const home = record?.property?.address || (draft.shopping ? draft.state : draft.property);
  const needed = cards.filter((c) => c.status === "pending");
  return (
    <Bubble titleKey="apply.review.title">
      <div className="sm-card">
        <div className="sm-row"><span>{rowPurpose}</span><strong>{purpose}</strong></div>
        <div className="sm-row"><span>{rowHome}</span><strong>{home}</strong></div>
        <div className="sm-row"><span>{rowName}</span><strong>{draft.legalName}</strong></div>
        <div className="sm-row"><span>{rowIncome}</span><strong>{draft.income}</strong></div>
      </div>
      {record?.status.badge ? (
        <p className="sm-lead"><span data-copy-key="apply.review.status">{copy("apply.review.status")}</span> <strong data-testid="apply-badge">{record.status.badge}</strong></p>
      ) : null}
      {record?.property?.tbd ? <p className="sm-lead" data-copy-key="apply.review.tbd">{copy("apply.review.tbd")}</p> : null}
      {needed.length ? (
        <>
          <h3 data-copy-key="apply.review.needed">{copy("apply.review.needed")}</h3>
          <ul className="sm-needed">
            {needed.map((c) => <li key={c.card_instance_id} data-testid={`apply-card-${c.card_instance_id}`}>{copy(c.copy_key)}</li>)}
          </ul>
        </>
      ) : null}
      <p className="sm-fine" data-copy-key="apply.review.consents_note">{copy("apply.review.consents_note")}</p>
    </Bubble>
  );
}

export function ResultStep({ record, setStep }: StepProps) {
  return (
    <Bubble titleKey="apply.result.title">
      {record?.status.badge ? <p className="sm-lead"><strong data-testid="apply-badge">{record.status.badge}</strong></p> : null}
      <button type="button" className="sm-secondary" data-copy-key="apply.result.back" onClick={() => setStep("review")}>{copy("apply.result.back")}</button>
    </Bubble>
  );
}

export function StepScreen(p: StepProps) {
  switch (p.step) {
    case "goal": return <GoalStep {...p} />;
    case "property": return <PropertyStep {...p} />;
    case "you": return <YouStep {...p} />;
    case "connect": return <ConnectStep {...p} />;
    case "details": return <DetailsStep {...p} />;
    case "questions": return <QuestionsStep {...p} />;
    case "demographics": return <DemographicsStep {...p} />;
    case "review": return <ReviewStep {...p} />;
    case "result": return <ResultStep {...p} />;
  }
}
