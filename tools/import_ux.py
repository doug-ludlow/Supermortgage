#!/usr/bin/env python3
"""Import the borrower UX specification (docs/ux/*.md — "Supermortgage Borrower Experience — UX Build Specification",
package v0.1, 2026-09-10) into the spec tree as markdown-first section 32 — Borrower experience — in the exact textual
forms the audit counts (spec/TEMPLATE-process.md). Idempotent: re-running rewrites the same files.

  python3 tools/import_ux.py [--dry-run]          (npm run spec:import:ux)
  then: npm run spec:register && python3 tools/extract_notices.py && python3 tools/extract_agents.py
        && npm run spec:manifest && python3 tools/audit.py && npm run spec:scaffold && python3 tools/workflows/wire_orig.py

Process map (one process per UX file; every UX heading's content is kept, restructured under the template's headings):
  32.1  ← 01-foundations            32.2  ← 02-data-contracts          32.3  ← 03 (T-03-01…30 → 32.3-T1…T30)
  32.4  ← 04 (T-04-…)               32.5  ← 05                          32.6  ← 06
  32.7  ← 07                        32.8  ← 08a                         32.9  ← 08b
  32.10 ← 08c                       32.11 ← 09                          32.12 ← 10
  32.13 ← 13 + 12 (rules only) + 11 (T-X-01…16 → 32.13-T1…T16); the copy strings go to copy-library.md (referenced, not units)
  README ← 00-MASTER-INDEX + 14-claude-code-build-plan (T-id mapping, vocabulary map, DELTA table, vendor fakes)

Unit rules honoured (the UX layer projects; it owns nothing the build specs own):
  T-ids     verbatim UX Given/When/Then rows, renumbered, as `| 32.k-Tn | … |` rows (only the leading id changes; O-refs
            are renumbered O2.3 → 21.3 like tools/import_origination.py so a name means one thing on both sides).
  tables    the UI-owned tables of 02 §1.6 are `(new)` bullets in 32.2; every other table the UX reads is named in prose as a
            baseline, read-only projection source — never in the `name` (baseline…) form the manifest counts.
  timers    the UX owns no timer: 32.2's "Timers and gates" table lists the allow-listed codes as bare reference rows
            (empty trigger/anchor/offset/satisfied cells; Kind "(N.M owns)"; the borrower-facing label in Breach) — a bare row
            never owns (src/kernel/timers/registry.ts). Names the UX uses as timers that are not registry codes are listed
            un-backticked.
  notices   the UX authors no notice: an `NTC_…` code stays backticked only when an earlier section (1–31) already names it,
            so 32.x never becomes an owner; the rest are listed un-backticked in 32.2.
  tools     32.2 names the UX commands as tools of the new `borrower-app` agent; 32.1 names DELTA-07's card tools for the
            existing `intake` / `borrower-comms` agents. Other processes name their thread-owning agent and no tools.
  figures   the UX has no worked money figures; no dollar figure is bolded.
"""
import re, os, sys, json, glob

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(TOOLS, '..'))
sys.path.insert(0, TOOLS)
from extract_spec import slug  # noqa: E402
from import_origination import renumber  # noqa: E402

UX = os.path.join(ROOT, 'docs', 'ux')
SECTION_N = 32
SECTION_TITLE = 'Borrower experience'
SECTION_DIR = os.path.join(ROOT, 'spec', 'sections', f'{SECTION_N:02d}-{slug(SECTION_TITLE)}')
AS_OF = '2026-09-11'
PACKAGE = 'Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)'
VENDOR_FAKES = ('Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and '
                'print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console')
UI_TABLES = ['conversations', 'messages', 'card_instances', 'card_instance_events', 'deep_links', 'ui_events', 'sessions']

# ---------------------------------------------------------------- id and cross-reference rewriting
TID_MAP = {'03': '32.3', '04': '32.4', '05': '32.5', '06': '32.6', '07': '32.7', '08a': '32.8', '08b': '32.9', '08c': '32.10', '09': '32.11', '10': '32.12', 'X': '32.13', '15': '32.14'}
FILE_MAP = {'00': 'README', '01': '32.1', '02': '32.2', '03': '32.3', '04': '32.4', '05': '32.5', '06': '32.6', '07': '32.7', '08a': '32.8', '08b': '32.9',
            '08c': '32.10', '09': '32.11', '10': '32.12', '11': '32.13', '12': 'copy-library.md', '13': '32.13', '14': 'README', '15': '32.14'}
BASENAMES = {'00-MASTER-INDEX': 'README', '01-foundations': '32.1', '02-data-contracts': '32.2', '03-entry-and-qualification': '32.3',
             '04-disclosures-intent-lock': '32.4', '05-verification-conditions-coborrowers': '32.5', '06-decision-property-title-insurance-mi': '32.6',
             '07-cd-closing-rescission-funding-boarding': '32.7', '08a-servicing-payments-statements-escrow': '32.8',
             '08b-servicing-insurance-pmi-arm-life-events-requests': '32.9', '08c-servicing-hardship-delinquency': '32.10',
             '09-rate-watch-and-re-refinance': '32.11', '10-exits': '32.12', '11-side-quests-catalogue': '32.13',
             '12-message-copy-library': 'copy-library.md', '13-acceptance-tests': '32.13', '14-claude-code-build-plan': 'README',
             '15-entry-sign-up-and-sign-in': '32.14'}

def read(p): return open(p, encoding='utf-8').read()

# notice codes an earlier section (1–31) already names — those stay backticked (the earlier section owns them); the rest are
# un-backticked so tools/extract_notices.py never makes a 32.x process an owner of a code it cannot author
def owned_notice_codes():
    codes = set()
    for f in glob.glob(os.path.join(ROOT, 'spec/sections/*/*.md')):
        if os.path.basename(os.path.dirname(f)).startswith(f'{SECTION_N}-'): continue
        if not re.match(r'\d+-\d+-', os.path.basename(f)): continue
        codes |= set(re.findall(r'`((?:NTC|INS)_[A-Z0-9_]+)`', read(f)))
    return codes
OWNED = owned_notice_codes()
UNOWNED_NOTICES = {}   # code → first 32.k that names it

# timer codes the registry knows (sections ≠ 32) and their owning process (servicing side first, then the lowest-numbered process —
# the ownership rule of src/kernel/timers/registry.ts)
def registry_timers():
    rows = json.load(open(os.path.join(ROOT, 'spec/registry/timers.json')))
    by = {}
    for t in rows:
        if int(t['section']) == SECTION_N: continue
        by.setdefault(t['code'], []).append(t)
    def key(t):
        n, m = (int(x) for x in t['process'].split('.'))
        return (0 if n < 20 else 1, n, m)
    return {c: sorted(v, key=key)[0]['process'] for c, v in by.items()}
TIMER_OWNER = registry_timers()

def created_tables():
    return set(re.findall(r'CREATE (?:TABLE|VIEW|MATERIALIZED VIEW)\s+(?:IF NOT EXISTS\s+)?(?:restricted_fl\.)?(\w+)',
                          '\n'.join(read(f) for f in glob.glob(os.path.join(ROOT, 'db/migrations/*.sql')))))
CREATED = created_tables()

def tx(text, pid=None):
    """Renumber and re-point: O-refs (O2.3 → 21.3), UX test ids (T-03-01 → 32.3-T1), UX file references (01 §3 → 32.1 §3),
    and un-backtick notice codes no earlier section owns."""
    text = renumber(text)
    text = re.sub(r'\bT-(03|04|05|06|07|08a|08b|08c|09|10|X|15)-(\d{2})\b', lambda m: f'{TID_MAP[m.group(1)]}-T{int(m.group(2))}', text)
    text = re.sub(r'\b(' + '|'.join(sorted(BASENAMES, key=len, reverse=True)) + r')(\.md)?\b', lambda m: BASENAMES[m.group(1)], text)
    text = re.sub(r'(?<![\d.])\b(00|0[1-9]|10|08a|08b|08c|11|12|13|14|15)( §)', lambda m: FILE_MAP[m.group(1)] + m.group(2), text)
    text = re.sub(r'\((0[1-9]|10|08a|08b|08c|11|13|15)\)', lambda m: f'({FILE_MAP[m.group(1)]})', text)
    text = re.sub(r'\b(0[1-9]|10|08a|08b|08c|15)\s+(?=32\.\d+-T\d)', '', text)
    def notice(m):
        code = m.group(1)
        if code in OWNED: return m.group(0)
        UNOWNED_NOTICES.setdefault(code, pid)
        return code
    text = re.sub(r'`((?:NTC|INS)_[A-Z0-9_]+)`', notice, text)
    return text

# ---------------------------------------------------------------- parsing a UX file
def parse(name):
    text = read(os.path.join(UX, name))
    h1 = re.match(r'# (.+)\n', text)
    body = text[h1.end():]
    body = re.sub(r'^---\s*$', '', body, flags=re.M)
    parts = re.split(r'^## ', body, flags=re.M)
    preamble = parts[0].strip()
    sections = []
    for p in parts[1:]:
        title, _, rest = p.partition('\n')
        sections.append((title.strip(), rest.strip()))
    return h1.group(1).strip(), preamble, sections

def demote(body):
    """UX H3 (### E1 · …) → H6 so the template's H3/H4 headings stay the only ones the extractors key on."""
    return re.sub(r'^###\s+', '###### ', body, flags=re.M)

def as_h5(title, body):
    return f'##### {title}\n\n{demote(body).strip()}\n'

TEST_TITLE = re.compile(r'^(\d+\.\s+)?(Acceptance tests.*|Tests|Cross-cutting tests)$')
TEST_BULLET = re.compile(r'^- \*\*T-(03|04|05|06|07|08a|08b|08c|09|10|X|15)-(\d{2})((?:\s[^*]+?)?)\*\*\s*(?:—\s*)?(.*)$')

def parse_tests(body, pid):
    rows = []
    for line in body.splitlines():
        m = TEST_BULLET.match(line.strip())
        if not m: continue
        n = int(m.group(2)); label = m.group(3).strip(); text = m.group(4).strip()
        if label: text = f'{label} — {text}'
        assert TID_MAP[m.group(1)] == pid, (pid, line[:60])
        rows.append((n, tx(text, pid)))
    return rows

def test_table(rows, pid):
    out = ['| ID | Acceptance test |', '|---|---|']
    for n, text in rows: out.append(f'| {pid}-T{n} | {text} |')
    return '\n'.join(out) + '\n'

# ---------------------------------------------------------------- section routing
# where a UX H2 lands under the template (default: "#### Business rules and calculations" as an H5 block)
ROUTE_DEFAULT = [
    (re.compile(r'Tests|Acceptance tests|Cross-cutting tests'), 'tests'),
    (re.compile(r'Side quests raised|Side-quest|Degraded modes'), 'edge'),
    (re.compile(r'Copy keys introduced|Proactive message catalogue'), 'outputs'),
    (re.compile(r'Reads · Commands · Events'), 'inputs'),
    (re.compile(r'Telemetry and evidence'), 'audit'),
    (re.compile(r'Mapping to build-spec tests'), 'audit'),
]
def route(title, overrides):
    for pat, slot in overrides:
        if pat.search(title): return slot
    for pat, slot in ROUTE_DEFAULT:
        if pat.search(title): return slot
    return 'rules'

# ---------------------------------------------------------------- per-process metadata
def owners_of(preamble):
    m = re.search(r'Owner specs:\s*(.+?)(?:\.\s|\n|$)', preamble, re.S)
    return tx(m.group(1).strip()) if m else None

CARD_STATE = ('Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; '
              'the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; '
              '`pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. '
              'Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` '
              'send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process '
              '(its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.')

META = {
    1: dict(title='Shell, theme, component library and Record pane', files=['01-foundations.md'], agent='intake',
            owners='every section the borrower touches — 20–31 (origination) and 1–19 (servicing); the UX projects their objects and never transitions them',
            auto='a — deterministic rendering of projections; the borrower commits by card; no agent decision is taken in the shell',
            trigger='On every session of the authenticated party; every card, message and Record patch',
            deadlines='none owned — the shell renders `timers.due_at` for allow-listed codes only (32.2 §4)',
            discrepancies='(1) DELTA-07: the `send_card`, `resolve_card_by_evidence` and `create_deep_link` tools are new on the `intake` and `borrower-comms` agents. '
                          '(2) DELTA-08: the Notice Registry channel `esign_portal` records `card_instance_id` as delivery evidence. '
                          '(3) The UX writes `human.transfer.completed`; the platform event is `human_transferred` (docs/ux/BACKEND-DELTAS.md).',
            overrides=[(re.compile(r'Component library'), 'rules'), (re.compile(r'Telemetry'), 'audit'), (re.compile(r'Degraded'), 'edge')]),
    2: dict(title='Data contracts: projections, commands, events, timers, notices, security, API', files=['02-data-contracts.md'], agent='borrower-app',
            owners='every section whose tables the projections read (1–19, 20–31); the seven UI-owned tables are the only new schema',
            auto='a — projections are computed; commands are gated by the owning process; the borrower-app agent decides nothing',
            trigger='On every event in §3; on every command in §2; SSE per session',
            deadlines='none owned — §4 is the allow-list of codes whose `due_at` may render',
            discrepancies='(1) Events the UX spells differently from the platform: `payments.reversed` = `payment.reversed`; `party.identity.verified` = `identity.verified`; '
                          '`human.transfer.completed` = `human_transferred`; `autodraft.change.requested` = the `autodraft.enrollment.*` family; `signing_sessions.consent_captured` is a column state, not an event. '
                          '(2) `preapproval.letter.issued` (DELTA-01) is not a platform event yet. (3) Names the UX uses as timers that are not registry codes and a notice code no section owns are listed under Timers and gates. '
                          '(4) Consent kinds `credit_authorization`, `joint_intent`, `irs_estatement`, `blanket_verification_authorization` and the E-SIGN scope classes were not in the 0001 `consent_kind` enum (db/migrations/0112). '
                          'All in docs/ux/BACKEND-DELTAS.md.',
            overrides=[(re.compile(r'^2\. Commands|^3\. Events'), 'inputs'), (re.compile(r'^5\. Notices'), 'outputs'), (re.compile(r'^7\. API'), 'integrations')]),
    3: dict(title='Entry and the five-minute qualification', files=['03-entry-and-qualification.md'], agent='intake',
            owners='20.3 (lead intake), 20.4 (pricing), 21.1 (application), 21.2 (LE), 21.3 (companions), 21.4 (intent, lock), 22.1–22.6 (documents, credit, income, assets, liabilities, identity), 23.1–23.3 (DU, conditions, decision), 24.1 (valuation), 31.1 (licensing)',
            auto='c — the borrower confirms and commits by card; the agent proposes and explains; `mlo_of_record` approves terms and locks under `origination.ai_mlo_intake=assisted`',
            trigger='On `lead.created`; per party; three happy paths (refinance, preapproval, purchase with contract)',
            deadlines='renders `REGZ_1026_19E1_LE_3BD`, `REGB_1002_9_DECISION_30`, `SM_O21_MLO_REVIEW_SLA_1BD`, `SM_LOCK_MLO_APPROVAL_SLA_30MIN`, `SM_UW_DECISION_VALIDITY` (owned by 21.x / 23.x)',
            discrepancies='(1) `party.identity.verified` is the platform\'s `identity.verified` (22.6). (2) `preapproval.letter.issued` and the `prequalifications` preapproval columns are DELTA-01 (0077 created `prequalifications` for the soft-pull prequalification only).',
            overrides=[(re.compile(r'^0\. Design targets'), 'rules')]),
    4: dict(title='Disclosures, intent to proceed, lock, revised LEs', files=['04-disclosures-intent-lock.md'], agent='intake',
            auto='c — the borrower confirms receipt, proceeds and locks by card; `mlo_of_record` approves LEs and locks',
            trigger='On `application.trid_received`; on every `disclosure.*`, `intent.*`, `lock.*`, `changed_circumstance.*` event',
            deadlines='renders `REGZ_1026_19E1_LE_3BD`, `REGZ_1026_37A13_COSTS_EXPIRE_10BD`, `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`, `SM_LOCK_EXPIRY_WARN_7` (owned by 21.x)',
            discrepancies='none — the process renders the 21.2–21.5 states as they are; the "What changed" diff is computed by `api` from two figure snapshots, never free text.'),
    5: dict(title='Verification, needs list, conditions, second borrower', files=['05-verification-conditions-coborrowers.md'], agent='intake',
            auto='c — the borrower uploads, connects, explains and invites by card; `underwriting_reviewer` clears what auto-clear does not',
            trigger='On `condition.opened` / `document_requests` / `verification.received` / `document.classified`; on an invite',
            deadlines='renders `SM_NEEDS_LIST_BORROWER_RESPONSE_5`, `SM_DOC_EXPIRY_WARN_14`, `FNMA_B1_1_03_CREDIT_DOCS_4M` (owned by 22.x)',
            discrepancies='none beyond 32.2\'s list.'),
    6: dict(title='Decision, property, title, insurance, MI, clear to close', files=['06-decision-property-title-insurance-mi.md'], agent='intake',
            auto='c — the borrower responds to counteroffers, schedules access, selects MI and supplies insurance by card; `underwriting_reviewer` approves denials',
            trigger='On `decision.issued{kind}`; on every valuation, project, title, hazard/flood, MI and CTC state change',
            deadlines='renders `REGB_1002_9_COUNTEROFFER_90`, `REGB_1002_9_NOIA`, `REGB_1002_14_APPRAISAL_COPY_3BD_GATE`, `FNMA_B4_1_3_12_ROV_TURNTIME_5BD`, `FDPA_4104A_FLOOD_NOTICE_GATE`, `SM_UW_DECISION_VALIDITY` (owned by 21.6 / 23.x / 24.x)',
            discrepancies='(1) SM_QC_PREFUNDING_HOLD is named as a timer but is not a registry code (28.1 owns the pre-funding QC hold as a state; the UX renders it as "a final review is in progress").'),
    7: dict(title='CD, closing, rescission, funding, boarding', files=['07-cd-closing-rescission-funding-boarding.md'], agent='intake',
            auto='c — the borrower confirms CD receipt, picks the signing slot, signs on the RON platform (L4, outside the app), may exercise rescission; `officer` accepts a rescission waiver; `funding_approver` authorizes funding',
            trigger='On `disclosure.cd.*`; on every `closings`, `signing_sessions`, rescission, `fundings` and boarding state change',
            deadlines='renders `SM_O62_CD_TARGET_4SBD`, `REGZ_1026_19F1_CD_3SBD_GATE`, `REGZ_1026_19F1III_CD_MAILBOX_3SBD`, `REGZ_1026_23_RESCISSION_3SBD_GATE`, `SM_O73_POST_RESCISSION_FUNDING_1BD`, `FNMA_B2_1_5_FIRST_PAYMENT_2M`, `SM_O64_FIRST_PAYMENT_LETTER_5BD`, `REGX_1024_17G_INITIAL_STMT_45`, `REGZ_1026_39_OWNERSHIP_NOTICE_30` (owned by 25.x / 26.x / 30.x)',
            discrepancies='none beyond 32.2\'s list; the RON platform is a `FAKE` in every build stage.'),
    8: dict(title='Servicing: loan home, payments, autopay, statements, escrow', files=['08a-servicing-payments-statements-escrow.md'], agent='borrower-comms',
            owners='2.1–2.7 (cashiering), 7.1 (periodic statements), 7.4 (E-SIGN), 7.x (1098), 3.1–3.8 (escrow); 6.x and 5.x are invisible',
            auto='c — the borrower pays, enrolls, elects and asks by card; the `cashiering` and `escrow` agents post and compute; `officer` waivers on money fields',
            trigger='On `loan.boarded`; on every payment, autodraft, statement-cycle and escrow-analysis event',
            deadlines='renders payment due date, `due_date + grace_days`, `next_draft_on`, `REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45`, `REGX_1024_17I_ANNUAL_STMT_30`, `REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10` (owned by 2.x / 3.x)',
            discrepancies='(1) `payments.reversed` is the platform\'s `payment.reversed` (2.x). (2) `autodraft.change.requested` is the `autodraft.enrollment.*` family (2.x). (3) NTC_STATE_ANNUAL_ESCROW_STMT_UT is not in the notice registry (3.3 names the Utah escrow statements differently) — docs/ux/BACKEND-DELTAS.md.'),
    9: dict(title='Servicing: insurance, PMI, ARM, life events, requests', files=['08b-servicing-insurance-pmi-arm-life-events-requests.md'], agent='borrower-comms',
            owners='9.1–9.x (insurance), 10.1–10.x (PMI), 7.2 (ARM notices), 4.4 (successors), 4.1/4.2 (NoE, RFI), 4.5 (complaints), 7.6/16.1 (payoff requests), 8.x (credit-reporting disputes), 7.x (privacy, contact changes)',
            auto='c — the borrower supplies evidence, asks, disputes and updates by card; the `insurance-property`, `pmi`, `case` and `payoff-release` agents run the owning processes',
            trigger='On every insurance, PMI, ARM, successor, case and payoff event; on a typed message (Intake Router, 4.1)',
            deadlines='renders `REGX_1024_37C_FPI_FIRST_NOTICE_45`, `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15`, `HPA_4902B_AUTO_TERMINATE_0`, `REGZ_1026_36C3_PAYOFF_STMT_7BD`, RFI/NoE ack and response dates (owned by 9.x / 10.x / 7.6 / 4.x)',
            discrepancies='none beyond 32.2\'s list.'),
    10: dict(title='Servicing: hardship and delinquency', files=['08c-servicing-hardship-delinquency.md'], agent='borrower-comms',
             owners='11.1–11.5 (early intervention, QRPC, Reg F, imminent default), 12.1–12.9 (loss mitigation), 13 (foreclosure), 14 (bankruptcy), 4.3 (continuity of contact), 8.x, 7.1',
             auto='c — the borrower asks for help, responds to offers and appeals by card; the `default-collections` and `lossmit-underwriter` agents run the owning processes; `lossmit_reviewer` approves denials',
             trigger='On `loan.delinquency.day_reached{n}`; on a hardship message; on every `lossmit.*`, `workout_plans.*`, foreclosure and bankruptcy event',
             deadlines='renders `REGX_1024_39A_LIVE_CONTACT_36`, `REGX_1024_41E1_ACCEPT_14`, `SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW`, `REGX_1024_41F1_120_DAY_GATE` (owned by 11.x / 12.x / 13.x)',
             discrepancies='none beyond 32.2\'s list.'),
    11: dict(title='Rate-watch and the re-refinance loop', files=['09-rate-watch-and-re-refinance.md'], agent='borrower-comms',
             auto='c — the borrower answers the offer and re-confirms the compressed application by card; `mlo_of_record` reviews terms; the `pricing` and `intake` agents run 20.x',
             trigger='Standing from `loan.boarded`; on `refi.opportunity.offered`; on `refi.request`',
             deadlines='renders `SM_REFI_OPPORTUNITY_EXPIRY_30`, `FNMA_C1_1_01_PREMIUM_RECAPTURE_120`, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` (owned by 20.1 / 20.2 / 16.x / 3.5)',
             discrepancies='(1) DELTA-05: the `standing` flag on `consents` (db/migrations/0112). (2) DELTA-10: the per-listing estimate under an approved quote id.'),
    12: dict(title='Exits', files=['10-exits.md'], agent='borrower-comms',
             auto='c — the borrower requests a payoff, authorizes third parties and pays by card; the `payoff-release` and `transfer` agents run 16.x / 17.x',
             trigger='On a payoff request; on `funds_received`; on a transfer-out batch; on a successor confirmation; on liquidation',
             deadlines='renders `REGZ_1026_36C3_PAYOFF_STMT_7BD`, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD`, `REGX_1024_33B3_COMBINED_15`, `REGX_1024_33C1_LATE_FEE_PROTECTION_60` (owned by 7.6 / 16.x / 3.5 / 17.x)',
             discrepancies='(1) FNMA_NIB_BALANCE_NOTICE is named as a timer but is not a registry code (16.2 renders the non-interest-bearing balance notice as a notice, not a clock).'),
    13: dict(title='Cross-cutting: acceptance harness, copy library rules, side-quest catalogue', files=['13-acceptance-tests.md', '12-message-copy-library.md', '11-side-quests-catalogue.md'], agent='borrower-app',
             owners='the build-spec tests each UI test depends on (mapping under Audit and evidence); the copy strings themselves live in copy-library.md and are not units',
             auto='a — the harness runs against the `api` command handlers with the real Timer Engine and Notice Registry; no UI-only mock of regulatory behaviour',
             trigger='On every build stage (README §Closing); on every commit of the copy library',
             deadlines='none owned',
             discrepancies='none — the cross-cutting tests restate binding rules of 32.1 and 32.2.'),
    14: dict(title='Entry, sign-up and sign-in', files=['15-entry-sign-up-and-sign-in.md'], agent='borrower-app',
             owners='20.2 (advertising content checklist), 20.3 (lead intake, assurance levels, disclosure, soft-pull prequalification, terms review), 20.4 (rate sheet, quote, disclaimer), 21.1 (application intake), 22.6 (identity), 31.1 (state licensing gate), 32.1/32.2 (shell, commands, sessions), 32.3 (the five-minute qualification this process hands off to), 32.13 (cross-cutting rules)',
             auto='c — the visitor answers by chip and card; the agent proposes nothing and computes no regulatory date; `mlo_of_record` reviews terms under `origination.ai_mlo_intake=assisted`',
             trigger='On `GET /` of the borrower host (organic), a referral link, a deep link from a 20.2 touch, or Sign in; per lead before L1 and per party after',
             deadlines='renders `SM_LEAD_INACTIVITY_EXPIRY_90`, `SM_MLO_PREAPP_TERMS_REVIEW_1BH`, `SM_QUOTE_VALIDITY_GATE`, `REGB_1002_9_DECISION_30` (owned by 20.3 / 21.x)',
             discrepancies='(1) DELTA-11…16 (docs/ux/BACKEND-DELTAS.md) declare the L0 lead session (`lead_tokens`), Sign in with Google (`oidc_identities`, `sessions.auth_method = oidc_google`), the soft pull at L1 with consumer-entered identity, the deep-link and return pages, the partner from configuration and link-my-loan. (2) The console moves from `/` to `/ops` so the root of the host is the thread (§6.3). Nothing else is new: every state, command, event, timer and role is 20.2/20.3/20.4/21.1/22.6/31.1/32.x\'s.',
             roles='`mlo_of_record`, `human_agent`',
             overrides=[(re.compile(r'^0\. Ground truth'), 'rules'), (re.compile(r'^7\. Phases|^8\. Prompts|^10\. Definition of done'), 'audit'), (re.compile(r'^9\. Acceptance tests'), 'tests')],
             retitle={'5. AI agent design': 'Owning agent, process tools and guardrails (the counted paragraph is under AI agent design below)'}),
}

# ---------------------------------------------------------------- generated blocks
def baseline_tables(text):
    names = sorted(set(re.findall(r'`([a-z][a-z0-9_]{3,})`', text)) & CREATED)
    return [n for n in names if n not in UI_TABLES]

def timers_in(text):
    seen = []
    for c in re.findall(r'`([A-Z][A-Z0-9_]+)`', text):
        if c in TIMER_OWNER and c not in seen: seen.append(c)
    return seen

def non_registry_timer_names(text):
    out = []
    for c in re.findall(r'`([A-Z][A-Z0-9_]{6,})`', text):
        if c.startswith(('NTC_', 'INS_')) or c in TIMER_OWNER or c in out: continue
        out.append(c)
    return out

def allow_list_rows():
    """32.2's registry table: one bare reference row per allow-listed code (02 §4), in the order the UX lists them."""
    _, _, sections = parse('02-data-contracts.md')
    body = next(b for t, b in sections if t.startswith('4. Timers'))
    rows = []; seen = set()
    for line in body.splitlines():
        if not line.startswith('| `') and not line.startswith('| Servicing'): continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        label = cells[1] if len(cells) > 1 else ''
        if line.startswith('| Servicing'): label = 'per 32.8–32.12 (as stated in each)'
        codes = re.findall(r'`([A-Z][A-Z0-9_]+)`', cells[0])
        if '`_PREDUE_20`' in cells[0]: codes.append('SM_O64_FIRST_PAYMENT_LETTER_PREDUE_20')   # the UX abbreviates the sibling code
        for code in codes:
            if code in seen or code not in TIMER_OWNER: continue
            seen.add(code); rows.append((code, label))
    return rows

def data_model_32_2(text):
    bullets = [
        '- **`conversations`** (new): `conversation_id uuid pk`, `party_id` → `parties`, `created_at`, `locale`, `timezone`. One per party (32.1 §6.1); the same conversation continues across origination, servicing and every refinance.',
        '- **`messages`** (new; append-only): `message_id uuid pk`, `conversation_id` → `conversations`, `at`, `sender` enum {borrower, agent, human, notice, system}, `sender_ref`, `channel` enum {app, sms, email, voice, mail}, `body_text` (pii), `card_instance_id?`, `subject_application_id?`, `subject_loan_id?`, `external_ref` (telephony sid / e-mail id).',
        '- **`card_instances`** (new): `card_instance_id uuid pk`, `conversation_id` → `conversations`, `party_id`, `subject_application_id?`, `subject_loan_id?`, `kind` (the CardKind of 32.1 §3), `status` enum {pending, resolved, expired, superseded, cancelled}, `created_by`, `copy_key`, `props jsonb`, `evidence jsonb` (persisted on resolve), `command_ref?`, `expires_at`, `created_at`, `resolved_at`.',
        '- **`card_instance_events`** (new; append-only): `card_instance_id` → `card_instances`, `from_status`, `to_status`, `at`, `actor` (party, agent or `human_agent`), `channel`, `evidence jsonb` — every status transition of a card appends here.',
        '- **`deep_links`** (new): `token pk`, `party_id`, `target jsonb` {card_instance_id | document_id | route}, `expires_at` (7 days), `created_for_message_id` → `messages`, `single_use` false. Tokens never encode loan data (32.1 §6.5).',
        '- **`ui_events`** (new; append-only): `ui_event_id uuid pk`, `party_id`, `session_id` → `sessions`, `conversation_id`, `card_instance_id?`, `kind` enum {card_shown, card_resolved, document_opened, document_scrolled_to_end, consent_affirmed, connector_started, connector_completed, deep_link_opened, voice_started, human_requested}, `at`, `ip`, `user_agent`, `disclosure_version_id?`, `payload jsonb` (32.1 §9).',
        '- **`sessions`** (new): `session_id uuid pk`, `party_id`, `level` enum {L1, L2, L3}, `created_at`, `last_seen_at`, `passkey_id?`, `ip`, `user_agent` (32.1 §5).',
    ]
    base = baseline_tables(text)
    return ('UI-owned tables (the only new schema this package permits; retention follows the owning record\'s class — `sm_lead_36m` before an application, '
            '`fnma_loan_file_life_plus_4y` once one exists — 31.3):\n' + '\n'.join(bullets) + '\n\n'
            '- Baseline, read-only projection sources the read models of §1 are built from (owned by the sections cited in the Blueprint row; no table is re-declared here): '
            + ', '.join(f'`{n}`' for n in base) + '.\n'
            '- Baseline tables written, only ever through the owning process\'s command handler (the UI writes no domain row directly): `consents`, `intent_records`, '
            '`disclosures` (`receipt_evidence`), `credit_authorizations`, `condition_clearances`, `contacts`, `lead_interactions`, `applicant_demographics` (restricted; write-once).\n')

def data_model_14(text):
    """docs/ux/15 §6.1 verbatim: the two UI-owned tables this process adds (counted by spec_manifest.py) and the baseline tables it writes."""
    m = re.search(r'^### 6\.1 Data model\n(.*?)(?=^### |^## |\Z)', text, re.S | re.M)
    assert m, '15-entry-sign-up-and-sign-in.md: "### 6.1 Data model" block not found'
    base = baseline_tables(text)
    body = tx(m.group(1).strip(), '32.14')
    return (body + '\n- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): '
            + (', '.join(f'`{n}`' for n in base) if base else 'none named') + '.\n')

def data_model_other(text, k):
    if k == 14: return data_model_14(text)
    base = baseline_tables(text)
    ui = [n for n in UI_TABLES if f'`{n}`' in text]
    s = ('No UI-owned table is declared here (32.2 declares the seven UI-owned tables' + (f'; this process writes `{"`, `".join(ui)}` through the 32.2 command endpoints' if ui else '') + ').\n'
         '- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): '
         + (', '.join(f'`{n}`' for n in base) if base else 'none named') + '.\n'
         '- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.\n')
    return s

def timers_block_32_2(text):
    rows = allow_list_rows()
    lines = ['| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |', '|---|---|---|---|---|---|---|']
    for code, label in rows:
        lines.append(f'| `{code}` | ({TIMER_OWNER[code]} owns) |  |  |  |  | {label} |')
    names = []
    for k in sorted(META):
        for f in META[k]['files']:
            for c in non_registry_timer_names(read(os.path.join(UX, f))):
                if c not in [n for n, _ in names]: names.append((c, f'32.{k}'))
    note = ('Every row above is a bare reference (empty trigger, anchor, offset and satisfied cells): the code is owned by the process in the Kind column, the '
            'UI renders its `due_at` under the label in the Breach column and never computes a date. The allow-list itself (labels and calendar notes) is §4 '
            'under Business rules.\n\n'
            'Jurisdiction overrides: none — `jurisdiction_rules` drives copy only (Business rules §8).\n\n'
            'Names the UX uses as timers that are not registry codes (backend delta; listed without backticks so nothing registers them): '
            + ', '.join(f'{c} ({p})' for c, p in names) + '.\n')
    if UNOWNED_NOTICES:
        note += ('\nNotice codes the UX renders that no earlier section names (not in spec/registry/notices.json; listed without backticks so 32.x never becomes an owner):\n\n'
                 '| Code | Named by | Nearest registry family |\n|---|---|---|\n'
                 + '\n'.join(f'| {c} | {p} | docs/ux/BACKEND-DELTAS.md |' for c, p in sorted(UNOWNED_NOTICES.items())) + '\n')
    return '\n'.join(lines) + '\n\n' + note

def timers_block_other(text, k):
    codes = timers_in(text)
    s = 'None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.\n\n'
    if codes:
        s += ('Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list\'s): '
              + ', '.join(f'`{c}` ({TIMER_OWNER[c]})' for c in codes) + '.\n')
    extra = non_registry_timer_names(text)
    if extra:
        s += '\nNamed as timers here but not registry codes (docs/ux/BACKEND-DELTAS.md): ' + ', '.join(extra) + '.\n'
    s += '\nJurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.\n'
    return s

def commands_32_2():
    """The UX commands of 02 §2 in table order — the borrower-app agent's tools."""
    _, _, sections = parse('02-data-contracts.md')
    body = next(b for t, b in sections if t.startswith('2. Commands'))
    tools = []
    for line in body.splitlines():
        if not line.startswith('| `'): continue
        cell = line.strip().strip('|').split('|')[0]
        names = re.findall(r'`([a-z]+\.[A-Za-z]+)`', cell)
        if not names: continue
        base = names[0]
        tools.append(base)
        for suffix in re.findall(r'`\.([a-z]+)`', cell):   # `autodraft.enroll` / `.change` / `.pause` / `.revoke`
            tools.append(base.split('.')[0] + '.' + suffix)
    return tools

def agent_paragraph(k, meta):
    if k == 1:
        return ('`intake` and `borrower-comms` agents (tools: `send_card`, `resolve_card_by_evidence`, `create_deep_link`) — DELTA-07 adds the three card tools to both '
                'thread-owning agents (the `intake` agent owns the thread before funding, `borrower-comms` after). End-to-end: the agent sends a typed card whenever the '
                'owning process reaches a state that needs the borrower (never free text for anything legally consequential), resolves a card from out-of-band evidence '
                '(a spoken "proceed" with the transcript; a human-agent send) only where the owning process permits that manner, and mints a deep link for every outbound '
                'message about a pending card. It proposes nothing on money fields and never resolves a consent, a signature or a payment. Decision record schema: '
                '{card_instance_id, conversation_id, party_id, kind, copy_key, command_ref, rule_set_version, model_version, prompt_version, confidence, rationale}. '
                'Guardrails: the automation disclosure precedes every exchange; no rate or payment is presented as personal before `mlo.review.completed{approved}`; '
                'no card is created for a party other than the one it is for; no consent, disclosure receipt, lock, intent, signature or authorization exists as chat text; '
                'no DU, credit-report, fraud, QC or compliance content is ever rendered. Escalations: `mlo_of_record` for terms and locks, `human_agent` on "human" or any '
                'distress keyword, `officer` for money-field waivers, `attorney` never from the shell.')
    if k == 2:
        tools = commands_32_2()
        return ('`borrower-app` agent (tools: ' + ', '.join(f'`{t}`' for t in tools) + '). End-to-end: the borrower-app is the command surface of the borrower experience — every tool is one UX command of §2, issued by a card resolve or '
                'a direct endpoint (§7) with idempotency key = `card_instance_id`, checked by the owning handler against the gate named in the §2 table, and refused with '
                '{code, gate, copy_key}; the agent proposes nothing, decides nothing and computes no regulatory date. Decision record schema: {command, card_instance_id, '
                'party_id, subject, gate, outcome, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. Guardrails: no command bypasses its '
                'gate; money fields (`payment.makeOneTime`, `payment.extraPrincipal`, autodraft amounts, `escrow.electShortage`) require a fresh L1 code within 10 minutes and '
                'never an agent-side waiver — `officer` only; `applicant_demographics` is write-once from the borrower\'s own card and never read back; DU findings, '
                'credit-report contents, fraud, QC and compliance internals are never serialized to the client (§6). Escalations: `human_agent` for `human.request`, '
                '`mlo_of_record` for `lock.request` approval, `officer` for money-field waivers, `underwriting_reviewer` never from the client.')
    if k == 14:
        return ('`borrower-app` agent (tools: `lead.answer`, `lead.requestRange`, `lead.proceed`, `party.linkLoan`). End-to-end: the owning agent is 32.2\'s `borrower-app`, executing as the '
                'thread-owning `intake` agent\'s card tools where a card is sent. `lead.answer` writes the S1 facts through 20.3 explainProgram{op=set_fact} and refuses any fact '
                'outside 20.3 rule 6; `lead.requestRange` renders 20.3 generalRateRange through 20.2 runContentChecklist and refuses on a failing checklist and for a closed state; '
                '`lead.proceed` runs 20.3 explainProgram{op=convert} to application.received and refuses before terms.presented under origination.ai_mlo_intake=assisted. It reuses '
                'lead.start, lead.acknowledgeAiDisclosure, party.authenticate, credit.authorize, party.startIdentity, application.setGoal and party.updateContact of 32.2; `party.linkLoan` (DELTA-16) '
                'links a signed-in party to a serviced loan by loan_last4 or property_zip + ssn_last4 + date_of_birth, raises the session to L2 on an exact match and refuses any mismatch without naming the field. '
                'Decision record schema: {lead_id, step, command, party_id, gate, outcome, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. '
                'Guardrails: L0_FACTS_ONLY (no name, contact, income, SSN or prohibited inquiry on a lead without a party); RANGE_IS_PUBLISHED (the range is the sheet\'s low to high; '
                'no tier, no LLPA, no borrower figure); NO_RATE_BEFORE_MLO_REVIEW (existing, on send_card{personal_terms}); STATE_GATE_FIRST (no range and no identity ask while '
                'licensing.gate.blocked); CONSENT_VOICE_VOID (existing). The agent proposes nothing and computes no regulatory date; every decision row names the lead id and the step. '
                'Escalations: `human_agent` on "human" (20.3 transferToHuman, SLA 10 s) and `mlo_of_record` for the terms review.')
    agent = meta['agent']
    phase = {'intake': 'the pre-funding thread', 'borrower-comms': 'the post-funding thread', 'borrower-app': 'the harness and the copy library'}[agent]
    return (f'`{agent}` agent owns {phase} for this process; it sends and resolves cards through the card-sending capabilities named in 32.1 (send_card, '
            f'resolve_card_by_evidence, create_deep_link) and issues every borrower command through the 32.2 command surface; it names no tool of its own here. '
            f'End-to-end: on each event this process subscribes to, the agent puts the typed card in front of the borrower with the copy key named, keeps the Record '
            f'in step, and reminds on the owning process\'s cadence; the borrower commits by card; the owning process decides. Decision record schema: '
            f'{{card_instance_id, party_id, subject, event, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}}. Guardrails: never a decline, '
            f'"you don\'t qualify", "guaranteed" or an investor reference in copy (32.1 §7.3); never a personal rate before `mlo.review.completed{{approved}}`; never a consent '
            f'by voice or chat; never a money-field change without `officer` approval; never a date the Timer Engine did not compute. Escalations: `human_agent` on '
            f'"human" or distress; the human roles the owning process names ({meta.get("roles", "`mlo_of_record`, `underwriting_reviewer`, `officer`")}) for their acts.')

def attribute_table(k, meta, timers_attr):
    rows = [('Section', f'{SECTION_N} — {SECTION_TITLE}'), ('Automation class', meta['auto']),
            ('Capacity', meta.get('capacity', 'Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process')),
            ('Trigger & frequency', meta['trigger']), ('Governing source', f'Projection of sections {meta["owners"]}'), ('Key deadlines', meta['deadlines']), ('Timers', timers_attr)]
    return '| Attribute | Value |\n|---|---|\n' + '\n'.join(f'| {a} | {b} |' for a, b in rows) + '\n'

# ---------------------------------------------------------------- building one process file
def build_process(k):
    meta = META[k]; pid = f'{SECTION_N}.{k}'
    slots = {s: [] for s in ('inputs', 'data', 'state', 'timers', 'rules', 'integrations', 'outputs', 'edge', 'tests', 'audit')}
    tests = []
    preambles = []
    raw_all = ''
    for fname in meta['files']:
        title, preamble, sections = parse(fname)
        raw_all += read(os.path.join(UX, fname))
        stem = fname.split('-')[0]
        preambles.append(tx(preamble, pid))
        if fname.startswith('12-'):
            # copy library: its rules (preamble + channel variants) are 32.13's; the strings go to copy-library.md
            for t, b in sections:
                if t.startswith('Channel variants'): slots['rules'].append(as_h5(f'Copy library — {tx(t, pid)}', tx(b, pid)))
            continue
        for t, b in sections:
            if fname.startswith('02-') and t.startswith('1. Read models'):
                b = b[:b.index('### 1.6 UI-owned tables')].rstrip()   # 1.6 is restated as the Data model bullets
            slot = 'edge' if fname.startswith('11-') else route(t, meta.get('overrides', []))
            if slot == 'tests':
                tests += parse_tests(b, pid); continue
            if fname.startswith('02-') and t.startswith('4. Timers'):
                slots['rules'].append(as_h5(tx(t, pid), tx(b, pid))); continue
            h = tx(t, pid)
            for old_t, new_t in meta.get('retitle', {}).items():
                if t.startswith(old_t): h = new_t
            if fname.startswith('11-'): h = f'Side-quest catalogue — {h}'
            if fname.startswith('13-'): h = f'Acceptance harness — {h}'
            slots[slot].append(as_h5(h, tx(b, pid)))
    if 'owners' not in meta:
        meta['owners'] = owners_of(preambles[0]) or 'the sections named in the Blueprint row'
    timers_attr = ', '.join(f'`{c}`' for c, _ in allow_list_rows()) if k == 2 else '—'

    out = [f'# {pid} — {meta["title"]}', '', attribute_table(k, meta, timers_attr)]
    out += ['### Blueprint row',
            f'Projection of sections {meta["owners"]}. ' + ' '.join(p for p in preambles if p).replace('\n\n', ' ').strip()
            + f' (Imported from docs/ux/{", ".join(meta["files"])} — {PACKAGE}; UX file {", ".join(f.split("-")[0] for f in meta["files"])} is {pid} here.)', '']
    out += [f'### Verified requirement (as of {AS_OF})',
            f'**Projection of sections {meta["owners"]}** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, '
            'a money figure) is verified in the owning process file cited, and the UI renders the owning process\'s state, `timers.due_at` and rendered documents without '
            'recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the '
            'owning file it stays so here. Statutory and Guide citations in the text are the owning process\'s.', '',
            f'**Discrepancies vs blueprint**: {meta["discrepancies"]}', '']
    out += ['### Operational prerequisites',
            f'- Vendor fakes: {VENDOR_FAKES} (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.',
            '- The partner\'s legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.',
            '- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.', '']
    out += ['### Build spec', '#### Inputs and triggers',
            f'- {meta["trigger"]}. Events that move this process\'s screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower\'s behalf except sending a card (`human_agent`) — 32.5 §8.']
    out += slots['inputs'] + ['']
    out += ['#### Data model', data_model_32_2(raw_all) if k == 2 else data_model_other(raw_all, k)]
    out += slots['data'] + ['#### State machine', CARD_STATE, ''] + slots['state']
    out += ['#### Timers and gates', timers_block_32_2(raw_all) if k == 2 else timers_block_other(raw_all, k)] + slots['timers']
    out += ['#### Business rules and calculations',
            '1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).',
            '2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.',
            '3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).', '']
    out += slots['rules']
    out += ['#### Integrations',
            f'- **`FAKE` vendors** — {VENDOR_FAKES}. Adapters this process touches: ' + meta.get('adapters', 'the ones its cards name (ConnectCard vendors, the RON platform, telephony, e-mail/SMS, print/mail)') + '; each is direction in/out through the owning process\'s adapter, idempotent on `card_instance_id` / vendor session id, and on outage the card shows `failed` with the upload or paper fallback (32.1 §10).',
            '- **`api`** — the borrower endpoints of 32.2 §7; errors carry {code, gate, copy_key}; the SSE stream of 32.2 §3.', '']
    out += slots['integrations']
    out += ['#### Outputs and artifacts',
            '- Rows written: `card_instances` (+ `card_instance_events`), `messages`, `ui_events`, `deep_links`; domain evidence rows through the owning handler (32.1 §9). Documents produced: none — every disclosure and notice rendered here is the owning process\'s rendered document (`notices.rendered_document_id`, `disclosures.rendered_document_id`), shown with its template version and delivery evidence; a notice delivered by mail shows *Mailed* and no receipt action.', '']
    out += slots['outputs']
    out += ['#### AI agent design (AI-first)', agent_paragraph(k, meta), '']
    out += ['#### Edge cases and failure modes',
            '- Vendor down → `ConnectCard` `failed` with the `UploadCard` fallback; AI path off → `human_agent` turns, cards and Record unchanged; DU / Fannie Mae outage → no borrower-visible error, timers still render; offline → cards queue *unsent* and nothing shows as done until the server acknowledges; E-SIGN suspect → the document flips to *Mailed* and re-verification is offered (32.1 §10).', '']
    out += slots['edge']
    out += ['#### Test cases and acceptance criteria', test_table(tests, pid) if tests else 'No T-numbered tests are assigned to this process by the UX package; its behaviour is asserted by 32.13\'s cross-cutting tests (32.13-T1…T16) and by the per-screen tests of 32.3–32.12 that exercise it.\n']
    out += ['#### Audit and evidence',
            '- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections\' evidence packs (19.x, 31.3). No analytics vendor receives PII.', '']
    out += slots['audit']
    out += ['### Open questions / decisions',
            '1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**']
    if k == 2:
        out += ['2. Names the UX spells differently from the platform (Discrepancies above). **Default: the platform spelling; the UX maps at the SSE boundary and docs/ux/BACKEND-DELTAS.md records each.**']
    out += ['', '### Sources']
    for f in meta['files']: out.append(f'- docs/ux/{f} — {PACKAGE}')
    out += ['- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)',
            f'- The owning build-spec processes: sections {meta["owners"]} (spec/sections/)', '']
    text = '\n'.join(out)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return pid, text

# ---------------------------------------------------------------- README and copy library
def build_readme():
    _, pre0, s0 = parse('00-MASTER-INDEX.md')
    _, pre14, s14 = parse('14-claude-code-build-plan.md')
    get = lambda secs, prefix: next(b for t, b in secs if t.startswith(prefix))
    out = [f'# Section {SECTION_N} — {SECTION_TITLE}', '',
           f'<!-- imported from docs/ux/ ({PACKAGE}) by tools/import_ux.py; UX file NN is process 32.k per the map below. Re-run `npm run spec:import:ux` after editing docs/ux; never edit the process files by hand. -->', '',
           '## Overview', '', tx(pre0), '', tx(get(s0, '0. What this package is')), '',
           '**One id grammar.** The UX package cites the Origination build specification as O1–O12; here those are sections 20–31 (O2.3 → 21.3, `tools/import_origination.py`), and the servicing sections 1–19 keep their numbers. Every UX cross-reference was rewritten the same way, so a name means one thing on both sides.', '',
           '### Vendor fakes', '',
           f'{VENDOR_FAKES}. A build stage never waits on a vendor credential; the fake honours the vendor\'s contract (webhooks, session ids, failure modes) so the cards resolve on the same events in every stage, and a swap to the live adapter changes no card, command or test. The word `FAKE` in a class name, a log line, a doc heading or a console label is the only signal that a counterparty is simulated — no fake is ever unnamed.', '',
           '### Process map (UX file → process; UX test id → T-id)', '',
           '| UX file | Process | UX tests | T-ids here |', '|---|---|---|---|',
           '| 00-MASTER-INDEX.md, 14-claude-code-build-plan.md | this README | — | — |',
           '| 01-foundations.md | 32.1 | — | — |', '| 02-data-contracts.md | 32.2 | — | — |',
           '| 03-entry-and-qualification.md | 32.3 | T-03-01 … T-03-30 | 32.3-T1 … 32.3-T30 |',
           '| 04-disclosures-intent-lock.md | 32.4 | T-04-01 … T-04-10 | 32.4-T1 … 32.4-T10 |',
           '| 05-verification-conditions-coborrowers.md | 32.5 | T-05-01 … T-05-11 | 32.5-T1 … 32.5-T11 |',
           '| 06-decision-property-title-insurance-mi.md | 32.6 | T-06-01 … T-06-12 | 32.6-T1 … 32.6-T12 |',
           '| 07-cd-closing-rescission-funding-boarding.md | 32.7 | T-07-01 … T-07-13 | 32.7-T1 … 32.7-T13 |',
           '| 08a-servicing-payments-statements-escrow.md | 32.8 | T-08a-01 … T-08a-11 | 32.8-T1 … 32.8-T11 |',
           '| 08b-servicing-insurance-pmi-arm-life-events-requests.md | 32.9 | T-08b-01 … T-08b-11 | 32.9-T1 … 32.9-T11 |',
           '| 08c-servicing-hardship-delinquency.md | 32.10 | T-08c-01 … T-08c-11 | 32.10-T1 … 32.10-T11 |',
           '| 09-rate-watch-and-re-refinance.md | 32.11 | T-09-01 … T-09-10 | 32.11-T1 … 32.11-T10 |',
           '| 10-exits.md | 32.12 | T-10-01 … T-10-08 | 32.12-T1 … 32.12-T8 |',
           '| 15-entry-sign-up-and-sign-in.md | 32.14 | T-15-01 … T-15-20 | 32.14-T1 … 32.14-T20 |',
           '| 13-acceptance-tests.md, 12-message-copy-library.md (rules), 11-side-quests-catalogue.md | 32.13 | T-X-01 … T-X-16 | 32.13-T1 … 32.13-T16 |',
           '| 12-message-copy-library.md (the strings) | copy-library.md (referenced; not units) | — | — |', '',
           'The mapping rule: T-NN-kk → 32.k-Tkk with the leading zero dropped (T-03-01 = 32.3-T1, T-08c-11 = 32.10-T11, T-X-16 = 32.13-T16); the Given/When/Then text is the UX text verbatim apart from the renumbered cross-references.', '',
           '### Principles (fixed)', '', tx(get(s0, '2. Principles')), '',
           '### Binding rules', '', tx(get(s0, '3. Binding rules')), '',
           '### Vocabulary map — UX term → build-spec object', '', tx(get(s0, '4. Vocabulary map')), '',
           '### The three happy paths', '', tx(get(s0, '5. The three happy paths')), '',
           '### Side quests', '', tx(get(s0, '6. Side quests')), '',
           '### Open items carried into the package', '', tx(get(s0, '7. Open items')), '',
           '### Backend deltas the UX requires (DELTA-01…10)', '', tx(get(s14, '3. Backend deltas')), '',
           'The reconciliation this import found (event spellings, consent kinds, the `esign_portal` channel, non-registry timer names, an unregistered notice code, the `prequalifications` columns) is kept in docs/ux/BACKEND-DELTAS.md.', '',
           '## Processes', '', '| Process | Title | Automation class |', '|---|---|---|']
    for k in sorted(META):
        out.append(f'| 32.{k} | {META[k]["title"]} | {META[k]["auto"].split(" ")[0]} |')
    out += ['', '## Closing', '',
            '### Where things live', '', renumber(get(s14, '1. Where things live')), '',
            'In this repository the borrower app is `apps/borrower` and the API seam is `src/runtime/borrower` (db/migrations/0111 onward); the per-process build files are `src/domain/borrower/<n>-<m>.spec.test.ts`, `timers-32-k.ts`, `evaluators-32-k.ts`, `src/app/tools/section32-k.ts` and `src/notices/authored/section32-k.ts`. Tests are API-level `node:test` cases plus Playwright driven from `node:test`, titled exactly as the T-id rows.', '',
            '### Build stages', '', tx(get(s14, '2. Build stages')), '',
            '### Prompts', '', renumber(get(s14, '4. Prompts')), '',
            '### Definition of done (package)', '', tx(get(s14, '5. Definition of done')), '',
            'In audit terms: a 32.x process is done only when its row in docs/audit/COVERAGE.md is at 100% of its units; the only statement of progress is that fraction.', '',
            '### Sequencing against the backend build', '', tx(get(s14, '6. Sequencing')), '']
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(out))

def build_copy_library():
    title, pre, secs = parse('12-message-copy-library.md')
    out = [f'# Section {SECTION_N} — copy library', '',
           f'<!-- docs/ux/12-message-copy-library.md ({PACKAGE}), imported by tools/import_ux.py. Reference material for 32.13 (copy tests) and every 32.x copy key; the strings are not audit units. -->', '',
           tx(pre), '']
    for t, b in secs: out += [f'## {tx(t)}', '', tx(b), '']
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(out))

# ---------------------------------------------------------------- main
def main():
    dry = '--dry-run' in sys.argv
    for k in sorted(META):                       # pre-scan so 32.2's table of unowned notice codes sees every file
        for f in META[k]['files']: tx(read(os.path.join(UX, f)), f'{SECTION_N}.{k}')
    files = {}
    for k in sorted(META):
        pid, text = build_process(k)
        files[os.path.join(SECTION_DIR, f'{SECTION_N}-{k}-{slug(META[k]["title"])}.md')] = text
    files[os.path.join(SECTION_DIR, 'README.md')] = build_readme()
    files[os.path.join(SECTION_DIR, 'copy-library.md')] = build_copy_library()
    # stale process files from an earlier title are removed so one process has one file
    for old in glob.glob(os.path.join(SECTION_DIR, f'{SECTION_N}-[0-9]*-*.md')):
        if old not in files:
            print('remove stale', os.path.relpath(old, ROOT))
            if not dry: os.remove(old)
    for p, text in files.items():
        print(('would write ' if dry else 'wrote ') + os.path.relpath(p, ROOT) + f'  ({len(text.split())} words)')
        if dry: continue
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, 'w', encoding='utf-8').write(text)
    tids = sum(len(re.findall(r'^\| 32\.\d+-T\d+ \|', t, re.M)) for t in files.values())
    print(f'{len(files)} files; T-id rows {tids}; reference timer rows {len(allow_list_rows())}; borrower-app tools {len(commands_32_2())}; '
          f'unowned notice codes un-backticked: {sorted(UNOWNED_NOTICES)}')
    leftovers = [(os.path.relpath(p, ROOT), m) for p, t in files.items() for m in re.findall(r'\bO(?:1[0-2]|[1-9])(?:\.\d+)?\b', t)]
    if leftovers: print('unrewritten O-references:', len(leftovers), leftovers[:10])
    print('next: npm run spec:register && python3 tools/extract_notices.py && python3 tools/extract_agents.py && npm run spec:manifest && python3 tools/audit.py && npm run spec:scaffold && python3 tools/workflows/wire_orig.py')

if __name__ == '__main__': main()
