import Foundation
import Combine

/// The single source of truth, mirroring the prototype's `A`, `WORK`, `ARTS` and `MEDIA`.
/// In memory only: nothing is persisted, and `reset()` returns the app to Welcome.
@MainActor
final class AppModel: ObservableObject {
    // `A`
    @Published var stage: Stage = .welcome
    @Published var tab: ShellTab = .chat
    @Published var name = ""
    @Published var setupDone = false
    @Published var connections = Connections()
    @Published var chat: [Message] = []
    @Published var feed: [Post] = []
    @Published var liked: Set<String> = []
    @Published var log: [LogEntry] = []
    @Published var goals: [Goal] = []
    @Published var paused = false
    @Published var workSegment: WorkCategory = .upgrade
    @Published var artifactsSegment: ArtifactsSegment = .artifacts
    @Published var feedInstructions = Copy.feedInstructions
    @Published var instructionsDismissed = false
    @Published var pmi: PMIState = .ready
    @Published var refi: RefiState = .offered
    @Published var escrowRefund: EscrowRefundState = .requested
    @Published var buffer = 0
    @Published var approvals: ApprovalsSetting = .binding
    @Published var notify: NotifySetting = .moves
    @Published var theme: AppTheme = .light
    @Published var snippetIndex = 0
    @Published var memory: String?
    @Published var insuranceConnected = false

    // `WORK`, `ARTS`, `MEDIA`
    @Published var work: [WorkItem] = WorkRegistry.items()
    @Published var artifacts: [Artifact] = ArtifactFixtures.artifacts
    @Published var media: [MediaItem] = ArtifactFixtures.media

    let router: Router
    let clock: AppClock
    /// False in unit tests: no snippet cycling and no proactive timers, so state is deterministic.
    let runsTimers: Bool

    private(set) lazy var engine = ChatEngine(model: self, clock: clock)
    private var tasks: [Task<Void, Never>] = []
    private var snippetTask: Task<Void, Never>?

    init(clock: AppClock = RealClock(), runsTimers: Bool = true) {
        self.clock = clock
        self.runsTimers = runsTimers
        self.router = Router(clock: clock)
    }

    // MARK: - Derived numbers

    var total: Double { Costs.total }
    /// `doneMoves()`: title lock 19.99 + home warranty 54.
    var doneMoves: Double { 73.99 }
    var pendingMoves: Double {
        (pmi == .requested ? 146 : 0) + (refi == .started ? 164 : 0) + (item(.smud)?.status == .running ? 22 : 0)
    }
    var offeredMoves: Double {
        (refi == .offered ? 164 : 0) + (pmi == .ready ? 146 : 0)
    }
    var current: Double { total - doneMoves }

    /// `breakdown()`: the cost lines minus the two cancelled subscriptions once setup is done.
    func breakdown() -> [KeyValue] {
        Costs.lines
            .filter { !(stage == .chat && setupDone && $0.label.matches("warranty|Title lock") && doneMoves > 0) }
            .map { KeyValue(key: $0.label, value: Format.money($0.amount, $0.amount.truncatingRemainder(dividingBy: 1) != 0 ? 2 : 0)) }
    }

    /// The header's snippet: empty before setup, "Paused" when paused, else the cycling snippet.
    var snippet: String {
        if !setupDone { return "" }
        if paused { return "Paused" }
        return Copy.snippets[snippetIndex % Copy.snippets.count]
    }

    var displayName: String { name.isEmpty ? "Supermortgage" : name }
    var agentTitle: String { name.isEmpty ? "Your agent" : name }
    var isWorking: Bool { stage == .chat && setupDone && !paused }
    var memoryDisplay: String { memory ?? Copy.memoryText() }

    // MARK: - Work lookups

    func item(_ key: WorkKey) -> WorkItem? { work.first { $0.key == key } }
    func item(id: String) -> WorkItem? { work.first { $0.id == id } }
    func artifact(_ id: ArtifactID) -> Artifact? { artifacts.first { $0.id == id } }
    func post(id: String) -> Post? { feed.first { $0.id == id } }

    func count(_ status: WorkStatus) -> Int { work.filter { $0.status == status }.count }

    /// "59 things I do for your home — 24 running · 3 need you · …"
    var workCountLine: String {
        "\(work.count) things I do for your home — \(count(.running)) running · \(count(.needsYou)) need you · \(count(.waiting)) waiting for a date · \(count(.needsConnection)) need a connection · \(count(.done)) done · \(count(.doesntApply)) don’t apply"
    }

    /// Segment counts exclude doesn't-apply rows.
    func segmentCount(_ category: WorkCategory) -> Int {
        work.filter { $0.category == category && $0.status != .doesntApply }.count
    }
    var needsYouRows: [WorkItem] { work.filter { $0.status == .needsYou } }
    func categoryRows(_ category: WorkCategory) -> [WorkItem] {
        work.filter { $0.category == category && $0.status != .needsYou && $0.status != .doesntApply }
    }
    func doesntApplyRows(_ category: WorkCategory) -> [WorkItem] {
        work.filter { $0.category == category && $0.status == .doesntApply }
    }

    /// `history(w)`.
    func history(for w: WorkItem) -> [(text: String, when: String)] {
        var h: [(text: String, when: String)] = []
        if w.status == .done { h.append((w.meta, "Today")) }
        if w.key == .refi {
            h.append(("Rate sheet read · 5.75% · trigger met", "6:31 today"))
            h.append(("Rate sheet read · 5.875% · not yet", "Yesterday"))
            h.append(("Rate sheet read · 6.00% · not yet", "Sep 15"))
        } else if w.key == .pmi {
            h.append((pmi == .requested ? "Cancellation request sent" : "Request drafted · waiting for your yes", "Today"))
            h.append(("Value check · $410,000 · LTV 70%", "Today"))
        } else if w.status == .running {
            h.append((w.meta, "Today"))
            h.append(("Checked · nothing changed", "Sep 10"))
        } else if w.status == .waiting {
            h.append(("Scheduled · " + w.meta, "Today"))
        } else if w.status == .needsConnection {
            h.append(("Waiting on a connection", "Today"))
        } else if w.status == .doesntApply {
            h.append(("Checked once · doesn’t apply", "Today"))
        }
        return h
    }

    private func update(_ key: WorkKey, _ change: (inout WorkItem) -> Void) {
        if let i = work.firstIndex(where: { $0.key == key }) { change(&work[i]) }
    }
    private func update(id: String, _ change: (inout WorkItem) -> Void) {
        if let i = work.firstIndex(where: { $0.id == id }) { change(&work[i]) }
    }
    func setArtifactSubtitle(_ id: ArtifactID, _ subtitle: String) {
        if let i = artifacts.firstIndex(where: { $0.id == id }) { artifacts[i].subtitle = subtitle }
    }

    // MARK: - Goals data

    /// The "next dates" list; the PMI decision row appears only once PMI is requested.
    var nextDates: [(title: String, when: String)] {
        var rows: [(title: String, when: String)] = [("Compute site check", "Sep 24")]
        if pmi == .requested { rows.append(("PMI decision due from your servicer", "Oct 17")) }
        rows.append(("Internet promo ends — I call", "Nov 14"))
        rows.append(("Insurance quotes begin", "Feb 1"))
        rows.append(("Assessment window opens", "Jul 2027"))
        return rows
    }

    /// The "By category" rows: title, subtitle, value — the prototype's `subs`.
    var categorySummaries: [(category: WorkCategory, sub: String, value: String)] {
        let upgradeSub = refi == .started ? "Refinance in progress" : refi == .offered ? "Refinance ready — needs your yes" : "Watching every morning"
        let upgradeValue = refi == .started ? "−$164 pending" : "−$164 offered"
        let eliminateSub = pmi == .requested ? "PMI requested · 2 subscriptions gone · refund coming" : "2 subscriptions gone · PMI needs your yes"
        let eliminateValue = "−\(Format.money(doneMoves)) done" + (pmi == .requested ? " · −$146 pending" : "")
        return [
            (.upgrade, upgradeSub, upgradeValue),
            (.income, "Site check Sep 24 · lot allows an ADU", "$0 so far"),
            (.eliminate, eliminateSub, eliminateValue),
        ]
    }

    /// Bar segment width as a fraction of the total, with a 2% minimum when non-zero (`pct`).
    func barFraction(_ value: Double) -> Double {
        max(value != 0 ? 0.02 : 0, value / total)
    }

    /// `spark()`: the five points that have happened, then the plan.
    var sparkPoints: (happened: [Double], plan: [Double]) {
        let c = current
        let afterPMI = c - (pmi == .requested ? 146 : 0)
        let afterRefi = afterPMI - (refi == .started ? 164 : 0)
        let pts = [total, c, c, afterPMI, afterRefi]
        let p4 = pts[4]
        let proj = pts + [p4 - 38, p4 - 60, p4 - 60, p4 - 95, p4 - 95, p4 - 140, p4 - 140]
        return (pts, proj)
    }

    // MARK: - Logging and posting

    func addLog(_ text: String) {
        log.insert(LogEntry(text: text, at: Format.clock()), at: 0)
    }

    func post(_ icon: String, _ title: String, _ body: String, tag: String? = nil, action: PostAction? = nil) {
        feed.insert(Post(id: "f\(feed.count + 1)", icon: icon, title: title, body: body, at: Format.clock(), tag: tag, action: action), at: 0)
    }

    /// Spawns a main-actor task the model can cancel on reset.
    func run(_ body: @escaping @MainActor () async -> Void) {
        let task = Task { await body() }
        tasks.append(task)
    }

    /// Waits for every spawned task (tests run them against an `ImmediateClock`).
    func drain() async {
        var seen = 0
        while seen < tasks.count {
            let pending = Array(tasks[seen...])
            seen = tasks.count
            for task in pending {
                _ = await task.value
            }
        }
    }

    // MARK: - Onboarding

    /// Welcome auto-advances after 2.6s.
    func welcomeAppeared() {
        guard runsTimers else { return }
        run { [weak self] in
            guard let self else { return }
            do { try await self.clock.sleep(ms: 2600) } catch { return }
            if self.stage == .welcome { self.stage = .know }
        }
    }

    /// "Get started": the orb for 1.7s, then the shell on Chat and the intro script.
    func getStarted() {
        stage = .setup
        run { [weak self] in
            guard let self else { return }
            do { try await self.clock.sleep(ms: 1700) } catch { return }
            self.stage = .chat
            self.tab = .chat
            await self.engine.scriptIntro()
        }
    }

    // MARK: - Navigation

    func select(_ tab: ShellTab) { self.tab = tab }

    func openWork(segment: WorkCategory) {
        workSegment = segment
        tab = .work
    }

    func openMenu() { router.present(.menu) }
    func openAgent(_ segment: AgentSegment = .activity) { router.present(.agent(segment)) }
    func openInvite() { router.present(.invite) }
    func openAbout() { router.present(.about) }
    func openSettings() { router.present(.settings) }
    func openAttach() { router.present(.attach) }
    func openWorkSheet(_ id: String) { router.present(.work(id)) }
    func openArtifact(_ id: ArtifactID) { router.present(.artifact(id)) }
    func openWhy(_ postId: String) { router.present(.whyPost(postId)) }
    func editInstructions() { router.present(.editInstructions) }
    func newGoal(_ title: String) { router.present(.newGoal(title)) }
    func openGoal(_ title: String) { router.present(.goalOpen(title)) }
    func schedule() { router.present(.schedule) }
    func openPlaid() { router.present(.plaid) }
    func reviewPMI() { router.present(.approval) }
    func nameOther() { router.present(.name) }

    // MARK: - Chat actions

    func act(_ action: ChatAction) {
        switch action {
        case .nameMe(let n): nameAgent(n)
        case .nameOther: nameOther()
        case .connMortgage(let label): connectMortgage(label)
        case .connCredit(let label): connectCredit(label)
        case .plaid: openPlaid()
        case .reviewPMI: reviewPMI()
        case .startRefi: startRefi()
        case .showArtifact(let id): openArtifact(id)
        case .notYet: notYet()
        case .schedule: schedule()
        case .doNow(let id): doNow(id)
        }
    }

    func nameAgent(_ n: String) {
        engine.user("I’ll call you \(n)")
        name = n
        run { [weak self] in await self?.engine.scriptSetup() }
    }

    /// The Name sheet's Save: empty falls back to Hazel.
    func saveName(_ raw: String) {
        let n = raw.trimmed.isEmpty ? "Hazel" : raw.trimmed
        router.dismiss()
        nameAgent(n)
    }

    func connectMortgage(_ label: String) {
        engine.user(label)
        connections.mortgage = true
        addLog("Mortgage statement read")
        run { [weak self] in
            guard let self else { return }
            guard await self.engine.progress("Reading your statement…", done: Home.address,
                                             small: "Fannie Mae conforming · 6.125% fixed · \(Format.money(Home.payment, 2)) a month · PMI $146", ms: 1700) else { return }
            await self.engine.scriptCredit()
        }
    }

    func connectCredit(_ label: String) {
        engine.user(label)
        if label == "Not now" {
            run { [weak self] in
                guard let self else { return }
                guard await self.engine.say(.text(Copy.creditDeclined), delay: 600) != nil else { return }
                await self.engine.scriptPlaid()
            }
            return
        }
        connections.credit = true
        addLog("Credit checked (soft pull) · 742")
        run { [weak self] in
            guard let self else { return }
            guard await self.engine.progress("Checking your credit…", done: "Credit report ready", small: "742 · 3 accounts · no late payments", ms: 1500) else { return }
            await self.engine.scriptPlaid()
        }
    }

    /// Plaid's Continue with the number of checked accounts (falls back to 3).
    func plaidDone(accounts: Int) {
        router.dismiss()
        let n = accounts > 0 ? accounts : 3
        engine.user("Connected Northstar Bank · \(n) accounts")
        connections.plaid = true
        addLog("Connected \(n) bank accounts")
        run { [weak self] in
            guard let self else { return }
            guard await self.engine.progress("Reading 12 months of transactions…", done: "Found 9 recurring home charges", ms: 1800) else { return }
            await self.engine.scriptNumber()
        }
    }

    func approvePMI() {
        router.dismiss()
        guard pmi == .ready else { return }
        pmi = .requested
        update(.pmi) { w in
            w.status = .waiting
            w.meta = "Requested Sep 17 · servicer has 30 days"
        }
        setArtifactSubtitle(.pmi, "Sent Sep 17 · response due Oct 17")
        for i in feed.indices where feed[i].action == .reviewPMI {
            feed[i].tag = nil
            feed[i].action = nil
            feed[i].title = "PMI cancellation sent"
            feed[i].body = "Request and valuation sent to your servicer. They have 30 days; I follow up on day 15 and day 30. −$146 a month when it clears."
        }
        media.append(MediaItem(title: "PMI request · sent confirmation", kind: .camera))
        addLog("PMI cancellation request sent")
        engine.user("Approved")
        run { [weak self] in await self?.engine.say(.text(Copy.pmiSent), delay: 700) }
        router.toast("PMI request sent")
    }

    func startRefi() {
        router.dismiss()
        guard refi == .offered else { return }
        if tab != .chat { tab = .chat }
        engine.user("Start the refinance")
        refi = .started
        update(.refi) { w in
            w.status = .running
            w.meta = "In progress · watching pricing hourly"
        }
        update(.lock) { w in
            w.status = .running
            w.meta = "Live · best pricing so far 5.75%"
        }
        setArtifactSubtitle(.refi, "In progress · 5.75%")
        for i in feed.indices where feed[i].action == .startRefi {
            feed[i].action = nil
            feed[i].title = "Refinance opened at 5.75%"
            feed[i].body = "I’ve filled in what I know. Pricing is watched hourly; you’ll get a card before the lock. −$164 a month when it funds."
        }
        addLog("Refinance opened · 5.75%")
        run { [weak self] in
            guard let self else { return }
            guard await self.engine.say(.text(Copy.refiOpening), delay: 700) != nil else { return }
            do { try await self.clock.sleep(ms: 900) } catch { return }
            self.router.refinanceShown = true
        }
    }

    /// The Refinance cover was dismissed (Continue or Hand back).
    func closeRefinance() {
        router.refinanceShown = false
        if refi == .started {
            run { [weak self] in await self?.engine.say(.text(Copy.refiHandedBack), delay: 500) }
        }
    }

    func notYet() {
        engine.user("Not yet")
        run { [weak self] in await self?.engine.say(.text(Copy.notYetReply), delay: 600) }
    }

    /// The composer's send.
    func send(_ text: String) {
        let v = text.trimmed
        guard !v.isEmpty else { return }
        engine.user(v)
        run { [weak self] in await self?.engine.answer(v) }
    }

    func attachPick(_ label: String) {
        router.dismiss()
        engine.user(label)
        media.append(MediaItem(title: label, kind: .camera))
        run { [weak self] in
            guard let self else { return }
            guard await self.engine.progress("Reading it…", done: "Read. Nothing new against what I have — filed under Media.", ms: 1500) else { return }
            self.addLog("Read an upload: \(label)")
        }
    }

    func scheduled(_ slot: String) {
        router.dismiss()
        engine.user(slot)
        addLog("Call scheduled \(slot)")
        run { [weak self] in await self?.engine.say(.text("Booked for \(slot). They’ll have the full picture."), delay: 600) }
    }

    func sideChat(_ chat: SideChat) {
        router.dismiss()
        tab = .chat
        engine.user(chat.userText)
        run { [weak self] in await self?.engine.answer(chat.query) }
    }

    // MARK: - Feed actions

    func toggleLike(_ postId: String) {
        if liked.contains(postId) { liked.remove(postId) } else { liked.insert(postId) }
    }

    func discuss(_ postId: String) {
        guard let p = post(id: postId) else { return }
        tab = .chat
        engine.user("About “\(p.title)”")
        run { [weak self] in await self?.engine.say(.text("Happy to. \(p.body) What would you like to change or know?"), delay: 700) }
    }

    func open(_ action: PostAction) {
        switch action {
        case .reviewPMI: reviewPMI()
        case .startRefi: startRefi()
        }
    }

    func saveInstructions(_ text: String) {
        let t = text.trimmed
        if !t.isEmpty { feedInstructions = t }
        router.dismiss()
        router.toast("Feed instructions updated")
    }

    func gotIt() { instructionsDismissed = true }

    // MARK: - Work actions

    func doNow(_ id: String) {
        run { [weak self] in await self?.doItNow(id) }
    }

    /// "Do it now": toast, 1.4s, then the row's meta changes (w35, insurance, flips to running).
    func doItNow(_ id: String) async {
        guard let w = item(id: id) else { return }
        router.dismiss()
        router.toast("\(name.isEmpty ? "Agent" : name) is on it…")
        addLog("Ran now: \(w.title)")
        do { try await clock.sleep(ms: 1400) } catch { return }
        if let i = work.firstIndex(where: { $0.id == id }) {
            if work[i].status == .waiting && id == "w35" {
                work[i].status = .running
                work[i].meta = "Quotes requested from 5 carriers · first back tomorrow"
                setArtifactSubtitle(.ins, "In progress · 5 carriers")
                post("🛡️", "Insurance quotes started early", "Five carriers, alongside a rebuild-cost check and the water-shutoff discount. First quotes back tomorrow.")
            } else {
                work[i].meta = "Checked just now · nothing changed"
            }
        }
        router.toast("Done")
    }

    func setAskFirst(_ id: String, _ ask: Bool) {
        update(id: id) { $0.askFirst = ask }
        router.toast(ask ? "I’ll ask first" : "I’ll just do it")
    }

    func togglePause(_ id: String) {
        guard let i = work.firstIndex(where: { $0.id == id }) else { return }
        work[i].paused.toggle()
        addLog("\(work[i].paused ? "Paused" : "Resumed"): \(work[i].title)")
    }

    func setBuffer(_ amount: Int) {
        buffer = amount
        update(.buffer) { w in
            w.status = .running
            w.meta = "Buffer \(Format.money(Double(amount))) · sweeps on the 1st"
        }
        addLog("Buffer set to \(Format.money(Double(amount)))")
        router.dismiss()
        router.toast("Buffer set to \(Format.money(Double(amount)))")
    }

    func connect(_ key: ConnectKey) {
        run { [weak self] in await self?.connectNow(key) }
    }

    /// `connect(k)`: "Connecting…", 1.4s, the effect per key, "Connected"; Settings reopens for smud/util/ins.
    func connectNow(_ key: ConnectKey) async {
        router.dismiss()
        router.toast("Connecting…")
        do { try await clock.sleep(ms: 1400) } catch { return }
        switch key {
        case .smud, .util:
            update(.smud) { w in
                w.status = .running
                w.meta = "Time-of-day plan requested · about $22 a month"
            }
            update(.util) { w in
                w.status = .running
                w.meta = "Watching bills against your baseline"
            }
            post("⚡", "Switched you to a time-of-day plan", "Your interval data says evenings are light. About $22 a month, starting next cycle.")
            addLog("Utilities connected · rate plan switched")
        case .grid:
            update(.grid) { w in
                w.status = .running
                w.meta = "Thermostat enrolled · first event pays next month"
            }
            addLog("Thermostat enrolled in demand response")
        case .ins:
            insuranceConnected = true
            addLog("Insurance carrier connected")
        }
        router.toast("Connected")
        if key == .smud || key == .util || key == .ins {
            router.present(.settings)
        }
    }

    // MARK: - Goals actions

    func saveGoal(_ title: String, note raw: String) {
        let note = raw.trimmed.isEmpty ? "Planning" : raw.trimmed
        goals.append(Goal(title: title, note: note))
        addLog("New goal: \(title)")
        router.dismiss()
        router.toast("Added to Tracking")
        if title == "No tenants" {
            for i in work.indices where WorkItem.isTenantRow(work[i].title) {
                work[i].status = .doesntApply
                work[i].meta = "You said no tenants"
            }
        }
    }

    // MARK: - Agent sheet, settings

    func saveMemory(_ text: String) {
        if !text.isEmpty { memory = text }
        router.dismiss()
        router.toast("Saved")
        addLog("Memory edited")
    }

    func setPaused(_ on: Bool) {
        paused = on
        addLog(on ? "Paused everything" : "Resumed")
        router.toast(on ? "Paused" : "Back to work")
    }

    func permissionToggled(on: Bool) {
        router.toast(on ? "I can do that on my own now" : "I’ll ask first")
    }

    func setApprovals(_ value: ApprovalsSetting) {
        approvals = value
        router.toast("Approvals updated")
    }

    func setNotify(_ value: NotifySetting) {
        notify = value
        router.toast("Notifications updated")
    }

    func setTheme(_ value: AppTheme) { theme = value }

    func downloadData() { router.toast("Preparing your export") }

    /// Settings → Your data → Delete: the shell resets the whole model and returns to Welcome.
    func deleteData() { reset() }

    func copyInviteLink() { router.toast("Link copied") }

    // MARK: - Timers

    /// The header snippet cycles every 6s once setup is done and not paused.
    func startSnippets() {
        snippetTask?.cancel()
        guard runsTimers else { return }
        snippetTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do { try await self.clock.sleep(ms: 6000) } catch { return }
                if !self.paused { self.snippetIndex += 1 }
            }
        }
    }

    /// The two proactive messages, 28s and 58s after the number.
    func armProactive() {
        guard runsTimers else { return }
        run { [weak self] in
            guard let self else { return }
            do { try await self.clock.sleep(ms: 28000) } catch { return }
            await self.escrowRefundApproved()
        }
        run { [weak self] in
            guard let self else { return }
            do { try await self.clock.sleep(ms: 58000) } catch { return }
            await self.roofPoolOpened()
        }
    }

    func escrowRefundApproved() async {
        guard escrowRefund == .requested else { return }
        escrowRefund = .approved
        post("💵", "Escrow refund approved — $412", "Your servicer approved the refund. It lands as a credit on your October statement.")
        addLog("Escrow refund approved ($412)")
        router.toast("\(name) posted to your feed")
        await engine.say(.text(Copy.escrowApprovedMessage), delay: 400)
    }

    func roofPoolOpened() async {
        post("🏘️", "Four homes on your street are on Supermortgage", "I’m pooling a roof bid for next spring with your neighbors. Nothing needed from you yet.")
        addLog("Roof pool opened with 3 neighbors")
        router.toast("\(name) posted to your feed")
        await engine.say(.text(Copy.roofPoolMessage), delay: 400)
    }

    // MARK: - Reset

    /// Back to Welcome with every value at its initial state; nothing survives.
    func reset() {
        for t in tasks { t.cancel() }
        tasks.removeAll()
        snippetTask?.cancel()
        snippetTask = nil
        router.reset()
        stage = .welcome
        tab = .chat
        name = ""
        setupDone = false
        connections = Connections()
        chat = []
        feed = []
        liked = []
        log = []
        goals = []
        paused = false
        workSegment = .upgrade
        artifactsSegment = .artifacts
        feedInstructions = Copy.feedInstructions
        instructionsDismissed = false
        pmi = .ready
        refi = .offered
        escrowRefund = .requested
        buffer = 0
        approvals = .binding
        notify = .moves
        theme = .light
        snippetIndex = 0
        memory = nil
        insuranceConnected = false
        work = WorkRegistry.items()
        artifacts = ArtifactFixtures.artifacts
        media = ArtifactFixtures.media
    }
}
