import Foundation

/// Runs the prototype's chat script on the main actor with the HTML's delays. A typing bubble
/// stands in for every message during its delay and is replaced in place when it lands.
@MainActor
final class ChatEngine {
    private unowned let model: AppModel
    private let clock: AppClock

    init(model: AppModel, clock: AppClock) {
        self.model = model
        self.clock = clock
    }

    // MARK: Primitives (`user`, `say`, `progress`)

    /// A user bubble; every option in the thread becomes used.
    func user(_ text: String) {
        for i in model.chat.indices where model.chat[i].options != nil {
            model.chat[i].used = true
        }
        model.chat.append(Message(id: UUID(), role: .user, body: .text(text), options: nil, used: false))
    }

    @discardableResult
    func say(_ body: MessageBody, options: [ChatOption]? = nil, delay: Int = 800) async -> Message? {
        let typing = Message(id: UUID(), role: .agent, body: .typing, options: nil, used: false)
        model.chat.append(typing)
        do {
            try await clock.sleep(ms: delay)
        } catch {
            model.chat.removeAll { $0.id == typing.id }
            return nil
        }
        let message = Message(id: typing.id, role: .agent, body: body, options: options, used: false)
        if let i = model.chat.firstIndex(where: { $0.id == typing.id }) {
            model.chat[i] = message
        } else {
            model.chat.append(message)
        }
        return message
    }

    /// A status row: spinner with `loading`, then a check with `done` (and `small`) after `ms`.
    /// Returns false when the task was cancelled (a reset), so callers stop there.
    @discardableResult
    func progress(_ loading: String, done: String, small: String? = nil, ms: Int = 1600) async -> Bool {
        let id = UUID()
        model.chat.append(Message(id: id, role: .agent, body: .progress(ProgressState(loading: loading, done: nil, small: nil)), options: nil, used: false))
        do {
            try await clock.sleep(ms: ms)
        } catch {
            model.chat.removeAll { $0.id == id }
            return false
        }
        if let i = model.chat.firstIndex(where: { $0.id == id }) {
            model.chat[i].body = .progress(ProgressState(loading: loading, done: done, small: small))
        }
        return true
    }

    // MARK: The script

    func scriptIntro() async {
        await say(.text(Copy.intro1(owner: Home.owner)), delay: 600)
        await say(.bullets(lead: Copy.introLead, items: Copy.introBullets.map { [Span.plain($0)] }), delay: 1100)
        await say(.text(Copy.nameAsk), options: [
            ChatOption("Hazel", .nameMe("Hazel")),
            ChatOption("Reed", .nameMe("Reed")),
            ChatOption("Something else…", .nameOther),
        ], delay: 1000)
    }

    func scriptSetup() async {
        await say(.text(Copy.nameChosen(model.name)), delay: 600)
        await say(.text(Copy.firstAsk), options: [
            ChatOption("Sign in to your servicer", .connMortgage("Sign in to your servicer")),
            ChatOption("Upload a statement", .connMortgage("Upload a statement")),
            ChatOption("Take a photo", .connMortgage("Take a photo")),
        ], delay: 1000)
    }

    func scriptCredit() async {
        await say(.text(Copy.creditAsk), options: [
            ChatOption("Yes, go ahead", .connCredit("Yes, go ahead")),
            ChatOption("Not now", .connCredit("Not now")),
        ], delay: 900)
    }

    func scriptPlaid() async {
        await say(.text(Copy.plaidAsk), options: [ChatOption("Connect with Plaid", .plaid, primary: true)], delay: 900)
    }

    /// The findings bullets, with the prototype's `<strong>`.
    static let findings: [[Span]] = [
        [.plain("PMI is still on your loan. Your home is worth about $410,000, so you’re at 70%. It can come off. "), .bold("$146 a month.")],
        [.plain("A title-lock subscription ($19.99) and a home warranty ($54). Neither returns anything to you.")],
        [.plain("Your escrow analysis over-collected. A $412 refund is owed.")],
        [.plain("Your homeowner’s policy renews \(Home.renewal). I’ll shop it February 1.")],
    ]

    func scriptNumber() async {
        guard !Task.isCancelled else { return }
        model.setupDone = true
        model.addLog("First pass complete · number computed")
        model.post("🏠", "Your number: \(Format.money(model.total)) a month",
                   "Mortgage \(Format.money(Home.payment)) (including \(Format.money(Home.escrow)) escrow and \(Format.money(Home.pmi)) PMI) · utilities $368 · internet $89 · services and subscriptions $173. This is what the house costs you today. It only goes one way from here.")
        guard await say(.number(lead: Copy.numberLead, amount: Format.money(model.total), rows: model.breakdown()), delay: 1400) != nil else { return }
        guard await say(.bullets(lead: Copy.findingsLead, items: ChatEngine.findings), delay: 1600) != nil else { return }
        model.post("✂️", "Cancelled two things you were paying for nothing", "Title lock ($19.99) and a home warranty ($54). The county recorder sends deed alerts free; I turned those on. −$74 a month.")
        model.post("🧾", "Your servicer over-collected your escrow", "The annual analysis was off by $412. Refund requested. I’ll post when it lands.")
        model.post("🛡️", "PMI can come off", "You’re at 70% of value. One approval and I send the request.", tag: "Needs you", action: .reviewPMI)
        model.post("📉", "Rates this morning: 5.75%", "Three-eighths under your 6.125%. A refinance saves about $164 a month. Ready when you are.", action: .startRefi)
        model.media.append(MediaItem(title: "Escrow refund request · confirmation", kind: .camera))
        model.addLog("Cancelled title lock ($19.99/mo)")
        model.addLog("Cancelled home warranty ($54/mo)")
        model.addLog("Requested escrow refund ($412)")
        model.addLog("Turned on county recorder alerts")
        guard await say(.text(Copy.actionsMessage), options: [ChatOption("Review it", .reviewPMI, primary: true)], delay: 1300) != nil else { return }
        guard await say(.text(Copy.refinanceOffer), options: [
            ChatOption("Start the refinance", .startRefi, primary: true),
            ChatOption("Show me the numbers", .showArtifact(.refi)),
            ChatOption("Not yet", .notYet),
        ], delay: 1700) != nil else { return }
        model.startSnippets()
        model.armProactive()
    }

    /// `answer(q)`: keyword routing, in the prototype's order.
    func answer(_ q: String) async {
        if q.matches("human|person|someone|specialist|talk to") {
            await say(.text(Copy.answerHuman), options: [ChatOption("Schedule a call", .schedule)])
            return
        }
        if q.matches("cost|number|month|pay") {
            let lead = "Right now it’s \(Format.money(model.current)) a month — down \(Format.money(model.doneMoves)) since we started. \(Format.money(model.pendingMoves)) more is pending and \(Format.money(model.offeredMoves)) is on the table."
            await say(.number(lead: lead, amount: nil, rows: model.breakdown()))
            return
        }
        if q.matches("refi|rate") {
            let text = model.refi == .started ? Copy.answerRefiStarted : Copy.answerRefiOffered
            let options: [ChatOption]? = model.refi == .offered ? [ChatOption("Start the refinance", .startRefi, primary: true)] : nil
            await say(.text(text), options: options)
            return
        }
        if q.matches("pmi") {
            let text = model.pmi == .requested ? Copy.answerPMIRequested : Copy.answerPMIReady
            let options: [ChatOption]? = model.pmi == .ready ? [ChatOption("Review it", .reviewPMI, primary: true)] : nil
            await say(.text(text), options: options)
            return
        }
        if q.matches("insur") {
            await say(.text(Copy.answerInsurance(renewal: Home.renewal)), options: [ChatOption("Start quotes now", .doNow("w35"))])
            return
        }
        if q.matches("tax|assess") {
            await say(.text(Copy.answerTax))
            return
        }
        if q.matches("compute|earn|income|adu|rent|solar") {
            await say(.text(Copy.answerIncome))
            return
        }
        if q.matches("pause|stop") {
            model.paused = true
            await say(.text(Copy.answerPaused))
            return
        }
        guard await say(.text(Copy.answerDefault)) != nil else { return }
        model.addLog("Looked into: “\(String(q.prefix(60)))”")
    }
}
