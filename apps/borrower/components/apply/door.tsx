"use client";

/**
 * 32.19 §2.1 / §2.3 (docs/ux/18) — the door for a browser with no session (`welcome` → `intro` → `account`, the
 * existing `Account` form skinned by apply.css) and the four tabs beside Apply: Chat (`POST /v1/borrower/messages` only),
 * My Loan (the loan record through `components/record`'s sections, or `apply.loan.empty`), Tasks (the seven derived rows and
 * the pending asks with no step of their own, hosted through `components/cards`), Account (the first name, the partner, Sign
 * out). `signedIn = Boolean(me)`; `footer.disclosure` is rendered by the chrome on every screen including the door.
 * Every rendered string is a copy key.
 */
import { Account } from "@/components/account/Account";
import { DocumentsSection, LoanSection, NextSection, NumbersSection, PeopleSection, PropertySection, StatusSection, type RecordLink } from "@/components/record/sections";
import { copy, copyOptions } from "@/lib/copy";
import { formatDate } from "@/lib/format";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import type { BorrowerMe, BorrowerRecord, ThreadMessage } from "@/lib/types/record";
import { TASKS, hostedInTasks, neededCards, type Door, type Draft, type Step, type Tab, type TaskId } from "./apply-model";
import { HostedCard } from "./steps";

export type DoorProps = {
  door: Door;
  accountMode: "sign_up" | "sign_in";
  setDoor: (d: Door) => void;
  setAccountMode: (m: "sign_up" | "sign_in") => void;
  /** After `POST auth/account` (or the code door) opened the session: poll `me` until the organic application appears. */
  onSession: () => void;
};

export function DoorScreens(p: DoorProps) {
  if (p.door === "welcome") {
    return (
      <div className="sm-bubble">
        <h1 data-copy-key="apply.door.title">{copy("apply.door.title")}</h1>
        <p className="sm-hero" data-copy-key="apply.door.tagline">{copy("apply.door.tagline")}</p>
        <button type="button" className="sm-primary" data-testid="apply-continue" data-copy-key="apply.continue" onClick={() => p.setDoor("intro")}>{copy("apply.continue")}</button>
      </div>
    );
  }
  if (p.door === "intro") {
    return (
      <div className="sm-bubble">
        <h1 data-copy-key="apply.door.what">{copy("apply.door.what")}</h1>
        <p data-copy-key="apply.door.what_body">{copy("apply.door.what_body")}</p>
        <p data-copy-key="apply.door.what_more">{copy("apply.door.what_more")}</p>
        <button type="button" className="sm-primary" data-testid="apply-continue" data-copy-key="apply.door.create" onClick={() => { p.setAccountMode("sign_up"); p.setDoor("account"); }}>{copy("apply.door.create")}</button>
        <button type="button" className="sm-link" data-testid="apply-have-account" data-copy-key="apply.door.have_account" onClick={() => { p.setAccountMode("sign_in"); p.setDoor("account"); }}>{copy("apply.door.have_account")}</button>
      </div>
    );
  }
  return (
    <div className="sm-bubble sm-bubble-account">
      <Account
        mode={p.accountMode}
        onSession={() => p.onSession()}
        navigate={(url) => {
          if (url.includes("google")) window.location.assign(url);
          else p.onSession();
        }}
      />
      <button type="button" className="sm-link" data-testid="apply-account-switch" data-copy-key={p.accountMode === "sign_up" ? "apply.door.sign_in_instead" : "apply.door.create"} onClick={() => p.setAccountMode(p.accountMode === "sign_up" ? "sign_in" : "sign_up")}>
        {p.accountMode === "sign_up" ? copy("apply.door.sign_in_instead") : copy("apply.door.create")}
      </button>
    </div>
  );
}

export type TabProps = {
  tab: Exclude<Tab, "apply">;
  me: BorrowerMe;
  record: BorrowerRecord | null;
  cards: readonly AnyCardInstance[];
  messages: readonly ThreadMessage[];
  draft: Draft;
  done: Record<TaskId, boolean>;
  focusedCard: string | null;
  setTab: (t: Tab) => void;
  setStep: (s: Step) => void;
  onSignOut: () => void;
  /** A card hosted in Tasks (or under My Loan's documents) resolves through the page's one resolve path. */
  onResolveCard: (cardInstanceId: string, req: ResolveRequest) => Promise<void>;
  /** My Loan: a document row opens its card (a DocumentCard's viewer and "Confirm receipt" — 32.16-T15). */
  openCard: (cardInstanceId: string | null) => void;
  /** A resolve is in flight: the hosted cards' controls wait for it. */
  busy: boolean;
};

/** The tabs beside Apply (docs/ux/18 §2.3). */
export function TabScreens(p: TabProps) {
  if (p.tab === "loan") return <LoanTab {...p} />;
  if (p.tab === "account") {
    return (
      <div className="sm-bubble">
        <h1 data-copy-key="apply.account.title">{copy("apply.account.title")}</h1>
        <p data-testid="apply-account-who"><span data-testid="apply-account-name">{p.me.first_name || copy("apply.account.signed_in")}</span> · <span data-testid="apply-account-partner">{p.me.partner.legal_name}</span></p>
        <button type="button" className="sm-primary" data-testid="apply-sign-out" data-copy-key="apply.account.sign_out" onClick={p.onSignOut}>{copy("apply.account.sign_out")}</button>
      </div>
    );
  }
  if (p.tab === "chat") {
    const lines = p.messages.filter((m) => m.body_text);
    return (
      <div className="sm-chat" data-testid="apply-chat">
        {lines.length === 0 ? <p className="sm-lead" data-copy-key="apply.chat.empty">{copy("apply.chat.empty")}</p> : null}
        {lines.map((m) => (
          <div key={m.message_id} className={m.sender === "borrower" ? "sm-msg me" : "sm-msg"} data-sender={m.sender}>{m.body_text}</div>
        ))}
      </div>
    );
  }
  return <TasksTab {...p} />;
}

/**
 * My Loan (owner decision 6): a party with a loan subject sees the loan record on day one — the badge (Monitored for a
 * partner-book loan), the partner as the servicer of record, the loan's last four and the numbers — through
 * `components/record`'s own sections (status, next, numbers, people, documents, property, loan). A party with no loan
 * subject sees `apply.loan.empty`: no dollar sign, no digit.
 */
function LoanTab(p: TabProps) {
  const loan = p.me.subjects.find((s) => s.loan_id);
  if (!loan) {
    return (
      <div className="sm-empty" data-testid="apply-loan-empty">
        <h2 data-copy-key="apply.loan.title">{copy("apply.loan.title")}</h2>
        <p data-copy-key="apply.loan.empty">{copy("apply.loan.empty")}</p>
      </div>
    );
  }
  const r = p.record && p.record.subject.loan_id === loan.loan_id ? p.record : null;
  const link: RecordLink = (target) => { if (target.card_instance_id) p.openCard(target.card_instance_id); };
  const focused = p.focusedCard ? p.cards.find((c) => c.card_instance_id === p.focusedCard) : undefined;
  const servicer = r?.people.find((x) => x.role === "servicer_of_record")?.display_name ?? r?.partner_book?.partner_name ?? null;
  const last4 = r?.partner_book?.loan_last4 ?? null;
  return (
    <div className="sm-loan" data-testid="apply-loan" data-loan-id={loan.loan_id}>
      <h1>{loan.label}</h1>
      {r ? (
        <>
          <p className="sm-lead">
            <strong className="sm-badge" data-testid="apply-badge">{r.status.badge}</strong>
            {r.next ? <span data-testid="apply-next-event"> · {r.next.label} {formatDate(r.next.due_at, r.timezone)}</span> : <span data-testid="apply-next-event" data-copy-key="apply.loan.nothing_scheduled"> · {copy("apply.loan.nothing_scheduled")}</span>}
          </p>
          {servicer ? <p className="sm-lead" data-testid="apply-loan-servicer"><span data-copy-key="apply.loan.servicer">{copy("apply.loan.servicer")}</span> <strong>{servicer}</strong></p> : null}
          {last4 ? <p className="sm-lead" data-testid="apply-loan-last4" data-copy-key="apply.loan.number">{copy("apply.loan.number", { last4 })}</p> : null}
          <div className="sm-record-host" data-testid="apply-loan-record">
            <StatusSection r={r} link={link} />
            <NextSection r={r} link={link} />
            <NumbersSection r={r} />
            <PeopleSection r={r} />
            <DocumentsSection r={r} link={link} />
            {focused ? <HostedCard card={focused} record={r} busy={p.busy} expanded onResolveCard={p.onResolveCard} /> : null}
            <PropertySection r={r} />
            <LoanSection r={r} />
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Tasks (docs/ux/18 §2.3): the seven rows with `data-done` derived on every render (`doneFrom` — never remembered), a tap
 * jumps to the step; the second line is `journey_progress` ("7 of 12", 32.16-T13) and the record's needed count; then every
 * pending ask with no step of its own — a gap card, `credit.liabilities.confirm`, `refi.current_loan.confirm`, a 33.x
 * OfferCard — hosted through `components/cards` and resolved here; the nothing-needed state when nothing is pending (32.13-T15).
 */
function TasksTab(p: TabProps) {
  const labels = copyOptions("apply.tasks.rows");
  const [purposeBuy = "", purposeRefi = ""] = copyOptions("apply.tasks.purpose");
  const purpose = p.record?.header.purpose;
  const title = p.draft.intent === "purchase" || purpose === "Buying" ? purposeBuy : p.draft.intent === "refinance" || purpose === "Refinancing" ? purposeRefi : copy("apply.tasks.purpose");
  const doneCount = TASKS.filter((t) => p.done[t]).length;
  const hosted = hostedInTasks(p.cards);
  const application = p.me.subjects.some((s) => s.application_id);
  const needed = p.record?.needed_summary?.count ?? p.record?.needed_from_you.length ?? 0;
  const jp = p.record?.journey_progress ?? null;
  const nothingNeeded = Boolean(p.record) && needed === 0 && neededCards(p.cards).length === 0 && (p.record?.read_only === true || !application || TASKS.every((t) => p.done[t]));
  return (
    <div data-testid="apply-tasks" data-needed={needed}>
      <h1 className="sm-tasks-title" data-copy-key="apply.tasks.title">{copy("apply.tasks.title")}</h1>
      {needed > 0 ? <p className="sm-lead" data-testid="apply-needed-count" data-copy-key="apply.tasks.needed_count">{copy("apply.tasks.needed_count", { count: needed })}</p> : null}
      {application && !p.record?.read_only ? (
        <div className="sm-card">
          <h3 className="sm-tasks-purpose">{title}</h3>
          <p className="sm-fine" data-copy-key="apply.tasks.progress">{copy("apply.tasks.progress", { done: doneCount, total: TASKS.length })}</p>
          {jp ? <p className="sm-fine" data-copy-key="apply.tasks.journey"><span data-copy-key="apply.tasks.journey_label">{copy("apply.tasks.journey_label")}</span> <span data-testid="progress-count">{copy("apply.tasks.journey", { done: jp.done, total: jp.total })}</span></p> : null}
          {TASKS.map((t, i) => (
            <button key={t} type="button" className="sm-row sm-task" data-testid={`apply-task-${t}`} data-done={p.done[t] ? "true" : "false"} onClick={() => { p.setTab("apply"); p.setStep(t); }}>
              <span>{labels[i] ?? t}</span>
              <strong>{p.done[t] ? copy("apply.tasks.done") : ""}</strong>
            </button>
          ))}
        </div>
      ) : null}
      {hosted.length ? (
        <div className="sm-card" data-testid="apply-tasks-hosted">
          {hosted.map((c) => <HostedCard key={c.card_instance_id} card={c} record={p.record} busy={p.busy} expanded={p.focusedCard === c.card_instance_id} onResolveCard={p.onResolveCard} />)}
        </div>
      ) : null}
      {nothingNeeded ? <p className="sm-lead" data-testid="tasks-empty" data-copy-key="needs.none">{copy("needs.none")}</p> : null}
    </div>
  );
}
