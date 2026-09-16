"use client";

/**
 * 32.19 §2.2 (docs/ux/18) — the nine Apply screens as components over `{draft, cards, record, busy, patch, onContinue}`.
 * Every rendered string is a copy key (the `apply.*` family, `refi.home.estate` / `refi.home.clean_energy_lien` for the
 * two home questions); the consents statement above Property's Continue is the goal card's own `props.statement`
 * (32.17 rule 20 — the tap writes the three rows; no checkbox). Session 1 wires goal and property for the three
 * branches; Session 2 the You (the identity, SSN and prior cards behind one Continue; a frozen bureau's lift card as the
 * caution row — 32.16-T14), Connect (the two FAKE connections and the income card) and Details (the profile card)
 * screens; Session 3 the Questions (the declarations cards one at a time), Demographics (the DemographicsCard in the
 * chrome), Review (the readiness view whose one CTA is the number cards' tap) and Result (the badge, `du.running`, the
 * ChecklistCard — nothing posted) screens, with `HostedCard` / `NeededList` shared with Tasks (docs/ux/18 §2.2–2.3).
 */
import { useId, type ReactNode } from "react";
import { Card } from "@/components/cards";
import { isIssueCard } from "@/components/record/Rail";
import { copy, copyExtra, copyOptions } from "@/lib/copy";
import { SHOW_FAKE_MARKERS } from "@/lib/env";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import type { BorrowerRecord } from "@/lib/types/record";
import { formatMoney } from "@/lib/format";
import { BASES, CITIZENSHIPS, LANGUAGES, MARITALS, MILITARIES, cents, isGapCard, isTbdPurchase, neededCards, pending, pendingDeclaration, resolved, stepOfCard, stepOfCopyKey, type Basis, type Citizenship, type Draft, type EstateType, type Language, type Marital, type Military, type Occupancy, type RefiGoal, type Step, type Tab, type YesNo } from "./apply-model";
import { underTwoYears } from "./wire";

export type StepProps = {
  step: Step;
  draft: Draft;
  cards: readonly AnyCardInstance[];
  record: BorrowerRecord | null;
  busy: boolean;
  patch: (p: Partial<Draft>) => void;
  onContinue: () => void;
  setStep: (s: Step) => void;
  setTab: (t: Tab) => void;
  /** A card hosted inside a step (a caution row's lift card, a declarations question, the demographics card, Tasks' orphans) resolves through the same API call as the steps' own taps. */
  onResolveCard: (cardInstanceId: string, req: ResolveRequest) => Promise<void>;
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

/** The step's hosted cards (docs/ux/18 §2.2): the platform's issue cards the step owns (`STEP_OF_COPY_KEY`) render as caution rows, the card component inside (never a toast, never a modal — 32.16 §2.2); an issue card with no step stays a Tasks row. */
function CautionRows({ step, cards, record, onResolveCard }: Pick<StepProps, "step" | "cards" | "record" | "onResolveCard">) {
  const rows = cards.filter((c) => c.status === "pending" && isIssueCard(c) && stepOfCopyKey(c.copy_key) === step);
  if (!rows.length) return null;
  return (
    <>
      {rows.map((c) => (
        <div key={c.card_instance_id} className="sm-card sm-caution sm-card-host" data-testid="apply-caution" data-tone="caution" data-rail-card={c.card_instance_id}>
          <h3 data-copy-key="apply.you.caution">{copy("apply.you.caution")}</h3>
          <Card card={c} timezone={record?.timezone ?? "America/Phoenix"} onResolve={(req) => onResolveCard(c.card_instance_id, req)} />
        </div>
      ))}
    </>
  );
}

export function YouStep({ step, draft, cards, record, busy, patch, onContinue, onResolveCard }: StepProps) {
  const under24 = underTwoYears(draft.months) || Boolean(pending(cards, "identity.prior_residence.title"));   // SQ-06: the typed months, or the card itself still pending (a return with an empty draft)
  const basisLabels = copyOptions("apply.you.basis");
  return (
    <Bubble titleKey="apply.you.title">
      <p className="sm-lead" data-copy-key="apply.you.credit_note">{copy("apply.you.credit_note")}</p>
      <CautionRows step={step} cards={cards} record={record} onResolveCard={onResolveCard} />
      <Field copyKey="apply.you.legal_name" value={draft.legalName} onChange={(legalName) => patch({ legalName })} />
      <Field copyKey="apply.you.dob" value={draft.dob} inputMode="numeric" onChange={(dob) => patch({ dob })} />
      <Field copyKey="apply.you.ssn" value={draft.ssn} inputMode="numeric" type="password" onChange={(ssn) => patch({ ssn })} />
      <p className="sm-label" id="apply-you-basis" data-copy-key="apply.you.basis">{copy("apply.you.basis")}</p>
      <div className="sm-switch" role="group" aria-labelledby="apply-you-basis">
        {BASES.map((id, i) => (
          <button key={id} type="button" className={draft.housing === id ? "active" : ""} aria-pressed={draft.housing === id} onClick={() => patch({ housing: id })}>{basisLabels[i] ?? id}</button>
        ))}
      </div>
      {draft.housing === "rent" ? <Field copyKey="apply.you.rent" value={draft.rent} inputMode="decimal" onChange={(rent) => patch({ rent })} /> : null}
      <Field copyKey="apply.you.months" value={draft.months} inputMode="numeric" onChange={(months) => patch({ months })} />
      {under24 ? (
        <div className="sm-card" data-testid="apply-prior-address">
          <h3 data-copy-key="apply.you.prior">{copy("apply.you.prior")}</h3>
          <Field copyKey="apply.you.prior_street" value={draft.priorAddressLine} onChange={(priorAddressLine) => patch({ priorAddressLine })} />
          <Field copyKey="apply.you.prior_city" value={draft.priorCity} onChange={(priorCity) => patch({ priorCity })} />
          <Field copyKey="apply.you.prior_state" value={draft.priorState} onChange={(priorState) => patch({ priorState: priorState.toUpperCase().slice(0, 2) })} />
          <Field copyKey="apply.you.prior_zip" value={draft.priorZip} inputMode="numeric" onChange={(priorZip) => patch({ priorZip })} />
          <Select copyKey="apply.you.prior_basis" value={draft.priorBasis} ids={BASES} onChange={(v) => patch({ priorBasis: (v || "rent") as Basis })} />
          {draft.priorBasis === "rent" ? <Field copyKey="apply.you.prior_rent" value={draft.priorRent} inputMode="decimal" onChange={(priorRent) => patch({ priorRent })} /> : null}
          <Field copyKey="apply.you.prior_months" value={draft.priorMonths} inputMode="numeric" onChange={(priorMonths) => patch({ priorMonths })} />
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

/** The profile card's option ids for a path when the card is pending (the server's list), else the model's (the same ids, 3-entry.ts profileCard). */
function profileOptions(cards: readonly AnyCardInstance[], path: string, fallback: readonly string[]): readonly string[] {
  const card = pending(cards, "profile.title");
  const field = card && card.kind === "ProfileCard" ? card.props.fields.find((f) => f.path === path) : undefined;
  const ids = field?.options?.map((o) => o.id);
  return ids && ids.length ? ids : fallback;
}
/** The option labels from the copy key, in the model's id order; an id the card lists that the model does not is shown by its id. */
function labelsFor(copyKey: string, modelIds: readonly string[], ids: readonly string[]): readonly string[] {
  const labels = copyOptions(copyKey);
  return ids.map((id) => { const i = modelIds.indexOf(id); return i >= 0 ? labels[i] ?? id : id; });
}
function ProfileSelect({ copyKey, value, ids, labels, onChange }: { copyKey: string; value: string; ids: readonly string[]; labels: readonly string[]; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <>
      <label className="sm-label" htmlFor={id} data-copy-key={copyKey}>{copy(copyKey)}</label>
      <div className="sm-field">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{copy(copyKey)}</option>
          {ids.map((optionId, i) => <option key={optionId} value={optionId}>{labels[i] ?? optionId}</option>)}
        </select>
      </div>
    </>
  );
}

export function DetailsStep({ draft, cards, busy, patch, onContinue }: StepProps) {
  const citizenships = profileOptions(cards, "citizenship_status", CITIZENSHIPS); const maritals = profileOptions(cards, "marital_status", MARITALS);
  const militaries = profileOptions(cards, "military_service", MILITARIES); const languages = profileOptions(cards, "language_preference", LANGUAGES);
  return (
    <Bubble titleKey="apply.details.title">
      <ProfileSelect copyKey="apply.details.citizenship" value={draft.citizenship} ids={citizenships} labels={labelsFor("apply.details.citizenship", CITIZENSHIPS, citizenships)} onChange={(v) => patch({ citizenship: v as Citizenship })} />
      <ProfileSelect copyKey="apply.details.marital" value={draft.marital} ids={maritals} labels={labelsFor("apply.details.marital", MARITALS, maritals)} onChange={(v) => patch({ marital: v as Marital })} />
      {draft.marital === "married" ? <p className="sm-note" data-testid="apply-spouse-later" data-copy-key="apply.details.spouse_later">{copy("apply.details.spouse_later")}</p> : null}
      <Field copyKey="apply.details.dependents" value={draft.dependents} inputMode="numeric" onChange={(dependents) => patch({ dependents })} />
      <ProfileSelect copyKey="apply.details.military" value={draft.military} ids={militaries} labels={labelsFor("apply.details.military", MILITARIES, militaries)} onChange={(v) => patch({ military: v as Military })} />
      <ProfileSelect copyKey="apply.details.language" value={draft.language} ids={languages} labels={labelsFor("apply.details.language", LANGUAGES, languages)} onChange={(v) => patch({ language: v as Language })} />
      <Continue busy={busy} onContinue={onContinue} />
    </Bubble>
  );
}

/** A `components/cards` card inside the column (docs/ux/18 §2.2: the protocol renderers are the data layer, rendered inside the Apply chrome): the card's own component, resolving through the page's one resolve path. `apply-card-{id}` is the test hook. */
export function HostedCard({ card, record, busy = false, expanded = false, onResolveCard, onOpen }: { card: AnyCardInstance; record: BorrowerRecord | null; busy?: boolean; expanded?: boolean; onResolveCard: StepProps["onResolveCard"]; onOpen?: (target: { card_instance_id?: string; document_id?: string }) => void }) {
  return (
    <div className="sm-card-host" data-testid={`apply-card-${card.card_instance_id}`} data-copy-key={card.copy_key} data-gap={isGapCard(card) ? "true" : undefined} data-expanded={expanded ? "true" : "false"}>
      {isGapCard(card) ? <p className="sm-lead" data-copy-key="application.gap.resend">{copy("application.gap.resend")}</p> : null}
      <Card card={card} timezone={record?.timezone ?? "America/Phoenix"} busy={busy} onResolve={(req) => onResolveCard(card.card_instance_id, req)} onOpen={onOpen} />
    </div>
  );
}

/** Every pending ask as a task (docs/ux/18 §2.2 review / result): a link to its step, or to Tasks when it has no step of its own; a re-sent gap card carries the copy library's `application.gap.resend` line. */
export function NeededList({ cards, setStep, setTab }: { cards: readonly AnyCardInstance[]; setStep: (s: Step) => void; setTab: (t: Tab) => void }) {
  const needed = neededCards(cards);
  if (!needed.length) return null;
  return (
    <>
      <h3 data-copy-key="apply.review.needed">{copy("apply.review.needed")}</h3>
      <ul className="sm-needed">
        {needed.map((c) => {
          const step = stepOfCard(c);
          return (
            <li key={c.card_instance_id} data-testid={`apply-card-${c.card_instance_id}`} data-copy-key={c.copy_key} data-gap={isGapCard(c) ? "true" : undefined} data-step={step ?? "tasks"}>
              <button type="button" className="sm-linkbtn sm-task-link" onClick={() => { if (step) { setTab("apply"); setStep(step); } else setTab("tasks"); }}>
                {isGapCard(c) ? `${copy("application.gap.resend")} ` : ""}{copy(c.copy_key, (c.props as { copy_tokens?: Record<string, string> }).copy_tokens)}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Questions (docs/ux/18 §2.2): the pending `declarations.*` card rendered one question at a time — `declarations.occupancy` and
 * its follow-ups, `declarations.clean_energy_lien`, `declarations.title` (none / some), then `declarations.item` ×13 with the
 * bankruptcy and borrowed-funds follow-ups — each through its own `components/cards` component (a ChoiceCard's tap posts
 * `{evidence: {option_id, tapped_at}, option_id}`; the explanation is the ExplanationCard, the amount the ConfirmCard). The
 * page holds nothing: the next question arrives from the flows on the tap (`ApplyProduct.onResolveCard` → `waitAfterDeclaration`).
 */
export function QuestionsStep({ cards, record, busy, onContinue, onResolveCard }: StepProps) {
  const current = pendingDeclaration(cards);
  const answered = cards.some((c) => c.status === "resolved" && c.copy_key.startsWith("declarations.") && !isGapCard(c));
  return (
    <Bubble titleKey="apply.questions.title">
      <p data-copy-key="apply.questions.lead">{copy("apply.questions.lead")}</p>
      <p className="sm-fine" data-copy-key="apply.questions.one_at_a_time">{copy("apply.questions.one_at_a_time")}</p>
      {current ? (
        <HostedCard card={current} record={record} busy={busy} onResolveCard={onResolveCard} />
      ) : answered ? (
        <>
          <p className="sm-lead" data-testid="apply-questions-done" data-copy-key="apply.questions.done">{copy("apply.questions.done")}</p>
          <Continue busy={busy} onContinue={onContinue} />
        </>
      ) : (
        <p className="sm-fine" data-copy-key="apply.questions.waiting">{copy("apply.questions.waiting")}</p>
      )}
    </Bubble>
  );
}

/** Demographics (docs/ux/18 §2.2; owner decision 3): the existing DemographicsCard inside the chrome — the server's option lists, a decline per group, the answers in the resolve body only (never on the card). */
export function DemographicsStep({ cards, record, busy, onContinue, onResolveCard }: StepProps) {
  const card = pending(cards, "demographics.title");
  const done = Boolean(resolved(cards, "demographics.title"));
  return (
    <Bubble titleKey="apply.demographics.title">
      <p data-copy-key="apply.demographics.lead">{copy("apply.demographics.lead")}</p>
      {card ? (
        <HostedCard card={card} record={record} busy={busy} onResolveCard={onResolveCard} />
      ) : done ? (
        <>
          <p className="sm-lead" data-testid="apply-demographics-done" data-copy-key="apply.demographics.done">{copy("apply.demographics.done")}</p>
          <Continue busy={busy} onContinue={onContinue} />
        </>
      ) : (
        <p className="sm-fine" data-copy-key="apply.questions.waiting">{copy("apply.questions.waiting")}</p>
      )}
    </Bubble>
  );
}

/** The borrower's own rows on Review: the name from the record's people (the confirmed identity), else the draft; the income as typed. */
const borrowerName = (record: BorrowerRecord | null, draft: Draft): string => record?.people.find((p) => p.role === "borrower")?.display_name || draft.legalName;
/** The number the CTA will write, for the row: the typed figure formatted, else the card's own (the FAKE AVM), else empty. */
function shownNumber(cards: readonly AnyCardInstance[], key: string, path: string, typed: string): string {
  if (typed.trim()) return formatMoney(cents(typed), { whole: true });
  const card = pending(cards, key) ?? resolved(cards, key);
  const confirmedField = ((card?.evidence as { fields?: { path: string; value_confirmed?: string }[] } | undefined)?.fields ?? []).find((f) => f.path === path);
  const value = confirmedField?.value_confirmed ?? (card && card.kind === "ConfirmCard" ? card.props.fields.find((f) => f.path === path)?.value : undefined) ?? "";
  return /^\d+$/.test(value) ? formatMoney(value, { whole: true }) : "";
}

/**
 * Review is a readiness view (owner decision 1): the rows Purpose · Home · Name · Income, the numbers the one CTA will
 * write (Value, Loan amount, Product), the badge from `record.status.badge`, every pending card as a task, the fine print
 * that the three consents were written at the goal tap. No control names a submission; "Confirm these numbers" is the last
 * number cards' tap (wire.ts `commitReview`), after which Result reads the badge. Still looking: `apply.review.tbd`.
 */
export function ReviewStep({ draft, record, cards, busy, patch, onContinue, setStep, setTab }: StepProps) {
  const [purposeBuy = "", purposeRefi = ""] = copyOptions("apply.tasks.purpose");
  const [rowPurpose = "", rowHome = "", rowName = "", rowIncome = ""] = copyOptions("apply.review.rows");
  const [numValue = "", numAmount = "", numProduct = ""] = copyOptions("apply.review.numbers");
  const [frm30 = "", frm15 = ""] = copyOptions("apply.review.products");
  const purchase = draft.intent === "purchase";
  const tbd = isTbdPurchase(cards, record);
  const purpose = purchase ? purposeBuy : draft.intent === "refinance" ? purposeRefi : record?.header.purpose ?? copy("apply.tasks.purpose");
  const home = record?.property?.address || (draft.shopping ? draft.state : draft.property);
  const numbersDone = Boolean(resolved(cards, "refi.product.choice")) || Boolean(resolved(cards, "preapproval.target"));
  const valueTyped = tbd ? draft.priceHigh || draft.price : purchase ? draft.price : draft.value;
  const amountTyped = (() => {
    const price = tbd ? draft.priceHigh || draft.price : draft.price;
    if ((purchase || tbd) && price.trim()) { if (!draft.down.trim()) return ""; const p = BigInt(cents(price)); const d = BigInt(cents(draft.down)); return d <= p ? (p - d).toString() : ""; }   // the row shows price − down only once both are typed (wire.ts commitReview requires the down payment too)
    if (!purchase && draft.balance.trim()) return draft.refiGoal === "cash" && draft.cashOut.trim() ? (BigInt(cents(draft.balance)) + BigInt(cents(draft.cashOut))).toString() : cents(draft.balance);
    return "";
  })();
  const amountShown = amountTyped ? formatMoney(amountTyped, { whole: true }) : tbd ? "" : shownNumber(cards, "refi.loan_amount.confirm", "loan_amount_sought", "");
  const product = !purchase && draft.refiGoal === "faster" ? frm15 : frm30;
  return (
    <Bubble titleKey="apply.review.title">
      <div className="sm-card">
        <div className="sm-row"><span>{rowPurpose}</span><strong>{purpose}</strong></div>
        <div className="sm-row"><span>{rowHome}</span><strong>{home}</strong></div>
        <div className="sm-row"><span>{rowName}</span><strong>{borrowerName(record, draft)}</strong></div>
        <div className="sm-row"><span>{rowIncome}</span><strong>{draft.income.trim() ? formatMoney(cents(draft.income), { whole: true }) : ""}</strong></div>
      </div>
      <h3 data-copy-key="apply.review.numbers">{copy("apply.review.numbers")}</h3>
      <div className="sm-card" data-testid="apply-review-numbers">
        {!numbersDone && !valueTyped.trim() ? (
          <Field copyKey={tbd ? "apply.property.price_high" : purchase ? "apply.property.price" : "apply.property.value"} value={valueTyped} inputMode="decimal" onChange={(v) => patch(tbd ? { priceHigh: v } : purchase ? { price: v } : { value: v })} />
        ) : null}
        {!numbersDone && !tbd && !purchase && !draft.balance.trim() ? <Field copyKey="apply.property.balance" value={draft.balance} inputMode="decimal" onChange={(balance) => patch({ balance })} /> : null}
        {!numbersDone && (purchase || tbd) && !draft.down.trim() ? <Field copyKey="apply.property.down" value={draft.down} inputMode="decimal" onChange={(down) => patch({ down })} /> : null}
        <div className="sm-row"><span>{numValue}</span><strong data-testid="apply-review-value">{tbd ? (valueTyped.trim() ? formatMoney(cents(valueTyped), { whole: true }) : "") : shownNumber(cards, "refi.value.confirm", "property_value_estimate", valueTyped)}</strong></div>
        <div className="sm-row"><span>{numAmount}</span><strong data-testid="apply-review-amount">{amountShown}</strong></div>
        <div className="sm-row"><span>{numProduct}</span><strong data-testid="apply-review-product">{product}</strong></div>
      </div>
      {record?.status.badge ? (
        <p className="sm-lead"><span data-copy-key="apply.review.status">{copy("apply.review.status")}</span> <strong className="sm-badge" data-testid="apply-badge">{record.status.badge}</strong></p>
      ) : null}
      {tbd ? <p className="sm-lead" data-testid="apply-review-tbd" data-copy-key="apply.review.tbd">{copy("apply.review.tbd")}</p> : null}
      <NeededList cards={cards} setStep={setStep} setTab={setTab} />
      <p className="sm-fine" data-copy-key="apply.review.consents_note">{copy("apply.review.consents_note")}</p>
      <Continue busy={busy} onContinue={onContinue} labelKey={numbersDone ? "apply.continue" : "apply.review.confirm"} />
    </Bubble>
  );
}

/**
 * Result (owner decision 1): "We're checking your application." — the badge, the copy library's `du.running` StatusCard and
 * the ChecklistCard when they come (through `components/cards`), any pending ask as a task (a re-sent gap card in the copy
 * library's words). The page posts nothing here: the DU moment is the flows' own run.
 */
export function ResultStep({ cards, record, setStep, setTab, onResolveCard }: StepProps) {
  const running = cards.filter((c) => c.copy_key === "du.running").sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  const checklists = cards.filter((c) => c.kind === "ChecklistCard" && c.status === "pending");
  return (
    <Bubble titleKey="apply.result.title">
      {record?.status.badge ? <p className="sm-lead"><span data-copy-key="apply.review.status">{copy("apply.review.status")}</span> <strong className="sm-badge" data-testid="apply-badge">{record.status.badge}</strong></p> : null}
      {!running && !checklists.length ? <p className="sm-lead" data-copy-key="apply.result.waiting">{copy("apply.result.waiting")}</p> : null}
      {running ? <HostedCard card={running} record={record} onResolveCard={onResolveCard} /> : null}
      {checklists.map((c) => <HostedCard key={c.card_instance_id} card={c} record={record} onResolveCard={onResolveCard} onOpen={() => setTab("tasks")} />)}
      <NeededList cards={cards} setStep={setStep} setTab={setTab} />
      <button type="button" className="sm-secondary" data-testid="apply-back" data-copy-key="apply.result.back" onClick={() => setStep("review")}>{copy("apply.result.back")}</button>
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
