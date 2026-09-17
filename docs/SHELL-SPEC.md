# Supermortgage app — Milestone 1: the shell

You are building the first milestone of a new iPhone app: the **shell**. Every screen, tab, sheet and interaction in the attached HTML prototype, rebuilt natively in SwiftUI, running entirely on fixture data with no network. When this milestone is done, a person can install the app from Xcode, tap through the whole product exactly as they can in the HTML, and nothing they tap is a dead end.

You are **not** building the agent runtime, the API, real connections (Plaid, servicer, credit), push notifications, Sign in with Apple, or the full refinance application. Those are later milestones. Do not stub them with fake network layers; the shell is fixtures and local state only.

---

## 1. The source of truth

`docs/prototype/Supermortgage-Agent-Prototype.html` is the specification. Where these instructions and the HTML disagree, the HTML wins. Where the HTML is silent, these instructions decide. Do not invent screens, copy, data or behavior that is in neither.

How to read the file:

- **`:root` CSS block (top of the file):** the design tokens — colors for light and `[data-theme=dark]`, type sizes and line heights, letter-spacing, radii, control heights. Reproduce these exactly (§3).
- **The second `<script>` block** (it begins `// Supermortgage agent shell — fictional data only.`) is the app. Everything you need is in it:
  - `HOME`, `COST`, `TOTAL` — the home and the cost lines that make the number.
  - `WORK_RAW` — the 59 standing actions: `[category, title, detail, cadence, status, dollars/mo, meta, extra]`. Copy every string verbatim.
  - `ARTS`, `MEDIA`, `SNIPS`, `PERMS`, `STATUS` — artifacts, media, the header's working snippets, the permissions, the status labels.
  - `A` — the app state. Your `AppModel` mirrors it.
  - `onboarding`, `views`, the `*Sheet()` functions — the screens and sheets, with their copy.
  - `scriptIntro`, `scriptSetup`, `scriptCredit`, `scriptPlaid`, `scriptNumber`, `answer` — the chat script, its options and its timings.
  - `act` — every tappable action and what it changes.
  - `doneMoves`, `pendingMoves`, `offeredMoves`, `current`, `spark` — the number's arithmetic and the Goals chart.
- **The first `<script>` block and the `<div id="apply-shell">` markup** are the legacy Apply web prototype embedded for the "Start the refinance" demo. **Ignore them** except as described in §5.10. Do not port them.
- **Copy is exact.** Every string the user sees comes from the HTML, including apostrophes (’), em dashes (—) and the "$0!" in the welcome subheader. Do not paraphrase, do not fix grammar, do not add text.

---

## 2. Repository, toolchain, layout

Create the repository fresh (suggested name `supermortgage-app`). Private.

```
supermortgage-app/
  README.md                 what this is, how to open and run it
  CLAUDE.md                 the working rules for this repo (§10)
  docs/
    prototype/Supermortgage-Agent-Prototype.html   copied in unchanged
    SHELL-SPEC.md           this document
  ios/
    project.yml             XcodeGen spec (commit it) — generate with `xcodegen generate`
    Supermortgage.xcodeproj generated; commit it too so the project opens without tooling
    Supermortgage/          the app target
      App/                  SupermortgageApp.swift, AppModel.swift, Router.swift, Fixtures loading
      DesignSystem/         Tokens.swift, Typography.swift, Components/ (one file per component, §3.3)
      Features/
        Onboarding/  Chat/  Feed/  Work/  Goals/  Artifacts/  Agent/ (avatar sheet)  Menu/  Settings/  Invite/  Refinance/
      Fixtures/             Home.swift, Costs.swift, WorkRegistry.swift, Artifacts.swift, Copy.swift, Permissions.swift
      Resources/            Assets.xcassets (AppIcon placeholder, Avatar.svg with Preserve Vector Data, AccentColor)
    SupermortgageTests/     unit tests (§8)
    SupermortgageUITests/   the walk (§8)
  api/README.md             one paragraph: "The agent runtime. Milestone 2." Nothing else.
  web/README.md             one paragraph pointing at docs/prototype. Nothing else.
  .github/workflows/ios.yml build + test on macos-14 (§8)
```

- **Platform:** iOS 17.0 minimum, iPhone only, portrait only. Xcode 16. Swift 5.10 language mode (do not enable Swift 6 strict concurrency for the shell).
- **Frameworks:** SwiftUI only. Foundation. No third-party dependencies of any kind — no packages, no CocoaPods, no SPM remotes. Charts are drawn with `Path`/`Canvas`, not Swift Charts, to match the prototype's sparkline exactly.
- **Project generation:** XcodeGen (`brew install xcodegen` if absent). `project.yml` defines one app target `Supermortgage` (bundle id `com.supermortgage.app`, display name `Supermortgage`), a unit-test target and a UI-test target. Commit both `project.yml` and the generated `.xcodeproj`.
- **State:** in memory only. Nothing is persisted between launches; the app opens on the Welcome screen every time. (Settings → Your data → Delete also returns the app to Welcome; see §5.9.)
- **Build must pass:** `xcodebuild -project ios/Supermortgage.xcodeproj -scheme Supermortgage -destination 'platform=iOS Simulator,name=iPhone 15' test` with zero warnings you introduced.

---

## 3. Design system

### 3.1 Color tokens

Define every token from the HTML `:root` block as a `Color` in `Tokens.swift`, light and dark, resolved through the environment `colorScheme` **and** overridable by the in-app Appearance setting (§5.9). Names follow the CSS names:

| Token | Light | Dark |
|---|---|---|
| text | #080808 | #f5f5f5 |
| paper (background) | #fcfcfc | #151516 |
| surface | #ffffff | #222224 |
| bubble | #eaeaea | #2c2c2e |
| muted | #68686a | #adadb2 |
| quiet | #a2a2a4 | #94949a |
| line | #e5e5e5 | #38383b |
| cardLine | #dedede | #414145 |
| fieldLine | #bababc | #68686d |
| subtle | #f4f4f4 | #29292c |
| selected | #ebebeb | #343437 |
| accent | #bf242b | #ef858b |
| button | #bf242b | #bf242b |
| accentPressed | #aa1d24 | #a71e25 |
| accentSoft | #f9e1e2 | #382025 |
| accentText | #842128 | #f59b9f |
| userFrom / userTo / userText | #faeded / #f6cfd2 / #4e4142 | #37252a / #51262c / #f8d9dc |
| chrome (header buttons, composer, tab bar) | #ffffff at 92% | #222224 at 92% |
| handle (sheet grabber) | #d5d5d5 | #58585e |

Take the rest (`paperGlass`, `paperFade`, `chromeEdge`, shadows) from the same block.

### 3.2 Type, radii, sizes

System font (SF Pro) throughout — it is the HTML's `-apple-system` stack, so nothing to import. Use fixed sizes, not Dynamic Type, for the shell:

- body 17/22, tracking −0.3 · support 15/20 · meta 12/16 · title 24/29, tracking −0.65, weight 600 · sheet title 22/27, weight 600 · the big number 44/48, weight 600, tracking −1.6 · onboarding h1 28/34 weight 500 · welcome h1 30/36 weight 500 in `muted`.
- Radii: card 28 · bubble 22 (assistant: 22/22/22/6 — small radius bottom-left; user: 22/22/6/22) · field 8 · choice 16 · pill 100 · sheet 30 top corners.
- Control height 44. Gutter 16. Header height 128 + safe area. Tab bar 62 high, pill-shaped, `chrome` background, 5 equal cells; selected cell `selected` background; icons only (labels are accessibility labels).
- The brand mark "s": Georgia Italic (available on iOS), `accent`, sizes as in the HTML (`.onboarding-mark` 86pt, the favicon-style mark where used).
- Avatar: export the inline SVG from `AVATAR` in the script as `Avatar.svg` into the asset catalog with Preserve Vector Data; render at 66×66 with a soft drop shadow; when `working`, a thin `accentSoft` ring with an `accent` arc rotating once per 1.5s around it.

### 3.3 Components (one SwiftUI view each, named for the HTML class)

`HeaderBar` (menu · avatar+name pill+snippet · Invite) · `TabBar` · `Composer` · `Sheet` (bottom sheet: grabber, title row with close button, scrollable body; use `.sheet` with `.presentationDetents([.medium, .large])`, `.presentationDragIndicator(.hidden)`, your own grabber, 30pt top corners) · `Toast` (dark pill, bottom, 2.2s) · `MessageBubble` (assistant/user, with optional key-value block and bullet list) · `TypingIndicator` (three dots) · `ChatChoice` (dashed-border option; `.primaryish` variant solid `accent` border, `accentText` label) · `StatusRow` (spinner or check + text + small) · `Card` · `ListRow` (label left muted, value right 500) · `Pill`/`Chip` (variants by status) · `SegmentedControl` (pill container, `subtle` selected, optional count) · `Switch` (custom: 46×28, `line` off / `button` on, white knob) · `RadioRow` · `ChoiceRow` (icon, title, small) · `PanelRow`/`MenuRow` · `ProgressBar` (three segments) · `Sparkline` · `IntroPoint` · `Orb` (the red rotating ring) · `Spinner`.

Match the HTML's spacing and borders; when in doubt, measure the HTML in a browser at 390pt wide.

---

## 4. Architecture and state

- `AppModel: ObservableObject` (or `@Observable`) is the single source of truth, mirroring the HTML's `A`: `stage` (.welcome, .know, .setup, .chat), `tab` (.chat, .feed, .work, .goals, .artifacts), `name`, `setupDone`, `connections` (mortgage/credit/plaid), `chat: [Message]`, `feed: [Post]`, `liked`, `log: [LogEntry]`, `goals`, `paused`, `workSegment`, `artifactsSegment`, `feedInstructions`, `instructionsDismissed`, `pmi` (.ready/.requested), `refi` (.offered/.started/.declined), `escrowRefund` (.requested/.approved), `buffer`, `approvals`, `notify`, `theme`, `snippetIndex`, `memory`.
- `Fixtures` are static Swift values transcribed from the HTML: `Home`, `costLines` (9), `workRegistry` (59 rows, in file order, ids `w1…w59`), `artifacts` (7), `media` (3, grows to 5), `snippets` (6), `permissions` (9), the six goal categories, the copy.
- `WorkItem` has `category`, `title`, `detail`, `cadence`, `status` (.running, .needsYou, .done, .waiting, .needsConnection, .doesntApply), `dollarsPerMonth`, `once`, `meta`, `key` (refi, lock, buffer, site, grid, pmi, smud, util), `artifactId`, `askFirst`, `paused`. `askFirst` defaults true when status is `.needsYou` or the title matches `lock|policy|sign|refinance|debt` (the HTML's rule).
- **The number.** `total = Σ costLines = 3,188.17`. `doneMoves = 73.99` once setup completes (title lock 19.99 + home warranty 54). `pending = (pmi == .requested ? 146 : 0) + (refi == .started ? 164 : 0) + (smud connected ? 22 : 0)`. `offered = (refi == .offered ? 164 : 0) + (pmi == .ready ? 146 : 0)`. `current = total − doneMoves`. Display with `NumberFormatter` currency, no cents unless the HTML shows cents (cost lines with cents show two decimals).
- `ChatEngine` runs the script as an `async` sequence on the main actor with `Task.sleep`, using the HTML's delays: intro 600 / 1100 / 1000 ms; "{name} it is" 600; first ask 1000; progress rows 1700 / 1500 / 1800 ms; the number 1400; the findings 1600; the actions 1300; the refinance offer 1700. A typing indicator bubble appears for the whole delay and is replaced by the message. Options on a message disappear once any option in the thread is used (the HTML sets `used` on every message with options when the user acts).
- Proactive messages: 28s and 58s after the number, exactly as `scriptNumber` schedules them, each also writing a feed post, a log entry and a toast "{name} posted to your feed".
- Header snippet: cycles through `snippets` every 6s once setup is done and not paused; shows "Paused" when paused; empty before setup.
- `Router` owns which sheet is up (an enum of sheet kinds with payloads) and the toast. Only one sheet at a time; opening another replaces it.

---

## 5. Screens

Build each exactly as the HTML renders it at 390pt wide. Copy comes from the HTML; behavior is listed here.

### 5.1 Onboarding
1. **Welcome** — mark, "Welcome to Supermortgage", the subheader, spinner low on the page. Auto-advances after 2.6s.
2. **Here's how I work:** — mark, heading, three `IntroPoint`s (icons: `arrow.triangle.2.circlepath`, `wallet.pass`, `minus.circle`; SF Symbols, light weight), the terms line (two link-styled words that do nothing), primary "Get started".
3. **Setting up your agent** — `Orb` spinning, heading. 1.7s, then the shell appears on Chat and the intro script starts.

Header, tab bar and composer are hidden during onboarding.

### 5.2 The shell
`HeaderBar` (sticky, `paper` gradient fading at the bottom): menu button left → Menu sheet; center avatar button → Agent sheet; name pill shows "Supermortgage" until named; snippet line under it; "Invite" pill right → Invite sheet. `TabBar` fixed at the bottom over a `paper` fade. `Composer` visible only on Chat: plus button → Attach sheet; text field "Message"; send button (`arrow.up`) that fills `button` when the field is non-empty. Switching to a non-Chat tab scrolls to top; Chat scrolls to the bottom.

### 5.3 Chat
The thread from `chat`, newest at the bottom, auto-scrolling on every append. Message kinds: text, rich (the "how I work" bullets; the number with its key-value breakdown; the findings bullets), progress row (spinner → check with small text), options (dashed chips; `.primaryish` for Review it / Start the refinance / Connect with Plaid), user bubbles (right-aligned, the gradient).

The script, in order, with the HTML's copy:
- Intro (3 messages) → naming chips **Hazel · Reed · Something else…** (Something else → Name sheet: one text field, Save; empty falls back to Hazel).
- Name chosen → user bubble "I'll call you {name}" → header pill updates → "{name} it is. I like it." → the first ask with three chips (servicer / statement / photo). Any chip → user bubble with the chip's label → progress "Reading your statement…" → check with the address and terms.
- Credit ask: **Yes, go ahead** → progress → "Credit report ready · 742…"; **Not now** → "No problem…" and on to Plaid.
- Plaid chip → Plaid sheet (Northstar Bank, three checked accounts, Continue) → user bubble "Connected Northstar Bank · {n} accounts" → progress "Reading 12 months of transactions…" → "Found 9 recurring home charges".
- The number message (big "$3,188" + breakdown), the findings, the actions message with **Review it**, the refinance message with **Start the refinance · Show me the numbers · Not yet**. Five feed posts are written here (see `scriptNumber`), four log entries, the media gains the escrow receipt, the header snippet starts cycling, the two proactive timers arm.
- **Review it** → Approval sheet (§5.11). **Start the refinance** → §5.10. **Show me the numbers** → the Refinance comparison artifact sheet. **Not yet** → user bubble and the reply.

Typed messages: user bubble, then `answer(text)` from the HTML — keyword routing in that order (human/person → schedule chips; cost/number/month/pay → the number reply with breakdown; refi/rate; pmi; insur; tax/assess; compute/earn/income/adu/rent/solar; pause/stop → pauses; default → "Got it…" plus a log entry).

### 5.4 Feed
Day label from the clock: "{Weekday} morning|afternoon|evening" (before noon / before 17:00 / after). The **Feed instructions** card (title, intro, the instructions text, Edit → Instructions sheet with a text area and Save; Got it → hides the card for the session). Posts newest first: emoji icon in a 44pt column, title (+ `accentSoft` tag when present), body, then heart (toggles filled `accent`), "Discuss" (switches to Chat, posts a user bubble "About “{title}”" and the reply), "Open" when the post carries an action (Review it / Start the refinance), info → "Why this post" sheet. Empty state before the number exists (icon, two lines).

### 5.5 Work
Heading "Work"; the count line built from live status counts ("59 things I do for your home — 24 running · 3 need you · 14 waiting for a date · 3 need a connection · 4 done · 11 don't apply" at first render); segmented **Upgrade 14 · Income 9 · Eliminate 25** (counts exclude doesn't-apply). Then, in order: **Needs you** group (all `.needsYou` rows across categories, count chip), the selected category's rows (excluding needs-you and doesn't-apply), and a collapsed **Doesn't apply to your home (n)** disclosure with the category's doesn't-apply rows at 62% opacity.

A row: status dot (running solid `text`; needs you `accent` with an `accentSoft` halo; done `muted`; waiting hollow `quiet`; needs a connection dashed `accent`; doesn't apply hairline), title, a line with the status chip and the cadence, the meta line in `quiet`, and on the right the amount ("−$146 /mo", "+$412 once", "/mo est." for waiting/need/connection rows; blank when 0). "Paused" replaces the chip label when paused.

Tap → Work sheet: detail paragraph; rows Status / How often / Right now / Worth; **History** (derived as in `history(w)`); **What it produced** (an artifact row when the item has one → opens that artifact sheet); **Before it acts**: Ask me first | Just do it; actions by key/status — `pmi` ready → "Review the request"; `refi` offered → "Start the refinance" + "Show me the numbers"; `buffer` unset → three `ChoiceRow`s ($2,500 / $5,000 / $10,000) that set the buffer, flip the row to running and toast; needs a connection → "Connect" (§5.9 connect behavior); running/waiting → "Do it now" (toast "{name} is on it…", 1.4s, then the meta line becomes "Checked just now · nothing changed" — except w35, insurance, which flips to running with its own meta and writes a feed post) — then always "Pause this / Resume this".

State changes that ripple into Work: PMI approval → w42 waiting with "Requested Sep 17 · servicer has 30 days"; refinance started → w1 running "In progress · watching pricing hourly", w3 running "Live · best pricing so far 5.75%"; SMUD/utilities connected → w44 and w46 running with their metas; thermostat connected → w24 running; "No tenants" goal → rows whose title matches `room|ADU|rent the house|sublet` become doesn't-apply with "You said no tenants".

### 5.6 Goals
Heading "Goals"; "Tracking" label; the card: "Monthly housing cost", the big current number, "→", "$0"; the three-segment bar (done `accent`, pending #e08a8f / dark #a8474d, offered `accentSoft`; each segment's width = value/total with a 2% minimum when non-zero); the legend; the sparkline (solid `accent` line for what has happened, dashed `accentSoft` for the plan — reproduce `spark()` point for point); the fine print; the **next dates** list (PMI decision row appears only once PMI is requested). Then any user-created goals as rows with "Planning"; **By category** — three rows (Upgrade / Income / Eliminate) whose subtitles and values follow the HTML's `subs` logic; tapping one opens Work on that segment. **Create a goal** — intro line and six rows with icons and a plus; tap → Goal sheet (text area with the HTML's per-category placeholder, "Build the plan") → adds a Tracking row, toasts "Added to Tracking", logs; "No tenants" also retires the tenant rows (§5.5).

### 5.7 Artifacts
Heading; segmented **Artifacts 7 · Media n**. Artifact rows: 54×66 thumb (`chart.bar` and `accent` border when live, else `doc`), title, subtitle (subtitles change: PMI → "Sent Sep 17 · response due Oct 17"; refinance → "In progress · 5.75%"; insurance → "In progress · 5 carriers"). Tap → the artifact's preview sheet, each laid out as in `artSheet`: dashboard (cost rows, total, fine print), refinance comparison (two columns Today/Offered + four rows + fine print + "Start the refinance" while offered), statement audit (four status rows, the third with a spinner), PMI request (the letter, "DRAFT" or "Sent September 17, 2026"; "Review and approve" while ready), insurance, site check, appeal packet. Media: a 3-column grid of 3:4 tiles (icon + caption).

### 5.8 Agent sheet (avatar tap)
Title = the name (or "Your agent"); status line with spinner: "Working on: {snippet, lowercased}" or "Paused"; segmented **Activity · Permissions · Memory**. Activity: the log, newest first, with times (or the empty line). Permissions: "Does on its own" (4, switches on) and "Asks first" (5, switches off) with the fine print; toggling only toasts. Memory: intro, an editable text area seeded from `memoryText()` (or the saved edit), Save → toast "Saved" + log. Footer row **Pause everything** with a switch that sets `paused` (header snippet, avatar ring and status line respond; toast).

### 5.9 Menu, Settings, About, Invite, Attach, Schedule
- **Menu** — "Side chats" (The refinance · PMI cancellation · Insurance renewal, subtitles from state) → each switches to Chat, posts the user bubble and runs the matching `answer`; "More": Settings, What I know about your home (→ Agent sheet on Memory), Invite a neighbor, About Supermortgage.
- **Settings** — Connections (Mortgage servicer, Credit, Bank accounts "On"; Insurance carrier and Utilities "Connect" until connected); Approvals (3 radios; default "Ask before anything binding"); Notifications (3 radios; default the first); Appearance **Light | Dark** (sets the in-app color scheme immediately and keeps it for the session); Your data **Download** (toast) and **Delete** (in the shell: reset the whole model and return to Welcome); the "How Supermortgage makes money" paragraph.
- **Connect** (from Settings or a Work sheet): toast "Connecting…", 1.4s, apply the HTML's effect per key (smud/util → both utility rows running + feed post + log; grid → thermostat row; ins → connected), toast "Connected", re-render; from Settings, reopen Settings.
- **About** — the four short sections and the fictional-data line.
- **Invite** — the paragraph, a read-only field "supermortgage.com/j/juniper-lane", "Copy link" → toast "Link copied".
- **Attach** (composer plus) — three `ChoiceRow`s; picking one posts a user bubble, adds a media tile, runs a progress row, logs.
- **Schedule a call** — two slot rows; picking one posts the user bubble, logs and replies.

### 5.10 Refinance entry (the one place the shell departs from the HTML)
In the HTML, "Start the refinance" opens the embedded legacy Apply web prototype. Do not port it. Instead: after the agent's "Opening the refinance…" message (700ms) and a 900ms beat, present a full-screen cover **Refinance** with the header (back chevron, the "s" mark and "Supermortgage" pill, "Invite"), one screen titled "Your current home." with fields prefilled from `Home` — Property address, Your goal (Lower payment), Estimated home value $410,000, Mortgage balance $287,400, How will you use it? (Main home), a disclosed "Property details" row, primary "Continue", link "Use a sample statement" — and a bottom bar "Hand back to {name}". **Continue** shows a status row "Handing your file to the platform…" for 1.2s and then dismisses. Dismissing (either way) marks the refinance started (state changes in §5.5/§5.4/§5.7) and posts the agent's "I've got it from here…" message. The rest of the application is Milestone 3.

### 5.11 Approval (PMI)
The one approval card in the shell, presented as a sheet titled "Cancel PMI": a bordered card with the heading, the intro, six `ListRow`s, then **Approve** / **Not now**. Approve → close, state to requested, w42 updated, the artifact subtitle and the PMI feed post rewritten, the media gains the sent confirmation, log, user bubble "Approved", the reply, toast "PMI request sent".

---

## 6. Fixture data checks

Transcribe from the HTML; these are the values your unit tests assert:

- 9 cost lines; total 3,188.17; formatted number "$3,188"; after setup, current "$3,114".
- 59 work rows: at first render 24 running, 3 need you (w1, w8, w42), 14 waiting, 3 need a connection (w24, w44, w46), 4 done (w6, w30, w32, w49), 11 don't apply; segment counts 14 / 9 / 25.
- Offered at first render: $310 (164 + 146); pending $0. After PMI approval: pending $146, offered $164. After the refinance starts: pending $310, offered $0.
- 7 artifacts; 3 media tiles, 4 after the number, 5 after PMI approval.
- Feed: 5 posts after the number; the PMI post loses its tag and changes title on approval; the rates post changes title when the refinance starts; a 6th post at 28s, a 7th at 58s.

---

## 7. Motion and timing

Only what the HTML does: the typing indicator; screen entry fade (`enter`: 0.16s, from 75% opacity and 3pt down); the avatar working ring (1.5s rotation); the spinner (1s); the orb (1.3s); switch and toast transitions (0.15–0.18s). No other animation. Respect Reduce Motion by disabling all of it.

---

## 8. Tests

- **Unit tests** (`SupermortgageTests`): fixture counts and sums from §6; the number's arithmetic under each state; work status derivation for the connect/approve/refinance/no-tenants transitions; the chat script's message order and option sets with delays set to zero (inject a clock).
- **The walk** (`SupermortgageUITests`, one test, in this order — mirror the HTML smoke tests): launch → Welcome auto-advances → Get started → Chat intro → tap Hazel → the three connections (statement · Yes, go ahead · Plaid → Continue) → the number appears → Review it → Approve → Feed shows "PMI cancellation sent" → Work shows "2 need you" → tap a Needs-you row → sheet → close → Goals shows "$3,114" → Artifacts → Refinance comparison → Start the refinance → the Refinance cover → Hand back → Chat shows "I've got it from here" → avatar → Permissions → Memory → close → menu → Settings → Dark → close → type "what is my number now?" → the reply contains "$3,114" → Pause everything → header reads "Paused". Give every tappable element an accessibility identifier so the walk is stable.
- **CI** (`.github/workflows/ios.yml`): on push and pull request, `macos-14`, Xcode 16, `xcodegen generate`, then `xcodebuild … test` for the unit tests and the walk on the iPhone 15 simulator. Red CI blocks merge.

---

## 9. Definition of done

- Every screen, sheet and action in §5 exists and matches the HTML at 390pt in light and dark.
- Every string is the HTML's string.
- The walk passes locally and in CI; the unit tests pass; the build has no new warnings.
- No network calls, no persistence, no dependencies, no code from the legacy Apply prototype.
- `README.md` says how to open, run, and run the walk in three commands.

Out of scope and not to be started: the API and agent runtime, any real connector, push, Sign in with Apple, Face ID, App Store assets beyond a placeholder icon, the full refinance application, iPad, landscape, localization.

---

## 10. Working rules for this repo (put these in CLAUDE.md)

- The HTML in `docs/prototype/` is the spec for the shell; copy and structure come from it verbatim. When something is unclear, read the HTML again before deciding.
- SwiftUI only, iOS 17, no dependencies, fixtures only. Do not add a networking layer "for later".
- Small commits, one screen or component each, in the order of §5. Each commit builds and its tests pass.
- Don't claim a screen is done until it has been compared against the HTML side by side in the simulator at 390pt, light and dark.
- Don't rename, "improve" or reword product copy. Don't add screens, settings, empty states or explanatory text the HTML doesn't have.
- Keep the fixture values exactly (§6); tests assert them.
- When you must depart from the HTML (there is one sanctioned case, §5.10), say so in the commit message.
