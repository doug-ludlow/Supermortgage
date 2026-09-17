import XCTest
@testable import Supermortgage

/// The chat script's message order and option sets, with the clock set to zero delay (§8).
@MainActor
final class ChatScriptTests: XCTestCase {
    private func makeModel() -> AppModel {
        AppModel(clock: ImmediateClock(), runsTimers: false)
    }

    private func labels(_ message: Message?) -> [String] {
        message?.options?.map(\.label) ?? []
    }

    func testIntroMessagesAndNamingChips() async {
        let model = makeModel()
        model.getStarted()
        XCTAssertEqual(model.stage, .setup)
        await model.drain()
        XCTAssertEqual(model.stage, .chat)
        XCTAssertEqual(model.tab, .chat)
        XCTAssertEqual(model.chat.count, 3)
        XCTAssertEqual(model.chat[0].body, .text("Hey Doug, I’m your personal agent. My job is to take your monthly housing cost to $0."))
        XCTAssertEqual(model.chat[1].body, .bullets(lead: "A bit about how I work:", items: Copy.introBullets.map { [Span.plain($0)] }))
        XCTAssertEqual(model.chat[2].body, .text("What would you like to call me? You can always change this later."))
        XCTAssertEqual(labels(model.chat[2]), ["Hazel", "Reed", "Something else…"])
        XCTAssertEqual(model.chat[2].options?[2].action, .nameOther)
        XCTAssertTrue(model.chat.allSatisfy { $0.role == .agent })
    }

    func testTheWholeSetupPath() async {
        let model = makeModel()
        model.getStarted()
        await model.drain()

        model.act(.nameMe("Hazel"))
        await model.drain()
        XCTAssertEqual(model.name, "Hazel")
        XCTAssertEqual(model.chat[3].role, .user)
        XCTAssertEqual(model.chat[3].body, .text("I’ll call you Hazel"))
        XCTAssertTrue(model.chat[2].used, "options disappear once any option in the thread is used")
        XCTAssertTrue(model.chat[2].visibleOptions.isEmpty)
        XCTAssertEqual(model.chat[4].body, .text("Hazel it is. I like it."))
        XCTAssertEqual(model.chat[5].body, .text("To get started I need three things. First, your mortgage or lease."))
        XCTAssertEqual(labels(model.chat[5]), ["Sign in to your servicer", "Upload a statement", "Take a photo"])

        model.act(.connMortgage("Upload a statement"))
        await model.drain()
        XCTAssertTrue(model.connections.mortgage)
        XCTAssertEqual(model.chat[6].body, .text("Upload a statement"))
        XCTAssertEqual(model.chat[7].body, .progress(ProgressState(loading: "Reading your statement…", done: Home.address,
                                                                    small: "Fannie Mae conforming · 6.125% fixed · $2,412.18 a month · PMI $146")))
        XCTAssertEqual(model.chat[8].body, .text("Next: can I check your credit? It’s a soft pull — it won’t affect your score."))
        XCTAssertEqual(labels(model.chat[8]), ["Yes, go ahead", "Not now"])

        model.act(.connCredit("Yes, go ahead"))
        await model.drain()
        XCTAssertTrue(model.connections.credit)
        XCTAssertEqual(model.chat[9].body, .text("Yes, go ahead"))
        XCTAssertEqual(model.chat[10].body, .progress(ProgressState(loading: "Checking your credit…", done: "Credit report ready", small: "742 · 3 accounts · no late payments")))
        XCTAssertEqual(model.chat[11].body, .text("Last one: connect your accounts so I can see what the house actually costs you each month."))
        XCTAssertEqual(model.chat[11].options, [ChatOption("Connect with Plaid", .plaid, primary: true)])

        model.act(.plaid)
        XCTAssertEqual(model.router.sheet, .plaid)
        model.plaidDone(accounts: 3)
        await model.drain()
        XCTAssertNil(model.router.sheet)
        XCTAssertTrue(model.connections.plaid)
        XCTAssertTrue(model.setupDone)
        XCTAssertEqual(model.chat[12].body, .text("Connected Northstar Bank · 3 accounts"))
        XCTAssertEqual(model.chat[13].body, .progress(ProgressState(loading: "Reading 12 months of transactions…", done: "Found 9 recurring home charges", small: nil)))
        guard case .number(let lead, let amount, let rows) = model.chat[14].body else { return XCTFail("expected the number") }
        XCTAssertEqual(lead, "Your monthly housing cost is")
        XCTAssertEqual(amount, "$3,188")
        XCTAssertEqual(rows.count, 7)
        guard case .bullets(let findingsLead, let findings) = model.chat[15].body else { return XCTFail("expected the findings") }
        XCTAssertEqual(findingsLead, "Here’s what I found on the first pass:")
        XCTAssertEqual(findings.count, 4)
        XCTAssertEqual(findings[0].last, .bold("$146 a month."))
        XCTAssertEqual(model.chat[16].body, .text(Copy.actionsMessage))
        XCTAssertEqual(model.chat[16].options, [ChatOption("Review it", .reviewPMI, primary: true)])
        XCTAssertEqual(model.chat[17].body, .text(Copy.refinanceOffer))
        XCTAssertEqual(labels(model.chat[17]), ["Start the refinance", "Show me the numbers", "Not yet"])
        XCTAssertEqual(model.chat[17].options?[0].primary, true)
        XCTAssertEqual(model.chat[17].options?[1].action, .showArtifact(.refi))
        XCTAssertEqual(model.chat.count, 18)

        XCTAssertEqual(model.feed.count, 5)
        XCTAssertEqual(model.feed.map(\.title), [
            "Rates this morning: 5.75%",
            "PMI can come off",
            "Your servicer over-collected your escrow",
            "Cancelled two things you were paying for nothing",
            "Your number: $3,188 a month",
        ])
        XCTAssertEqual(model.feed[1].tag, "Needs you")
        XCTAssertEqual(model.feed[1].action, .reviewPMI)
        XCTAssertEqual(model.feed[0].action, .startRefi)
        XCTAssertEqual(model.feed[4].body, "Mortgage $2,412 (including $571 escrow and $146 PMI) · utilities $368 · internet $89 · services and subscriptions $173. This is what the house costs you today. It only goes one way from here.")
        XCTAssertEqual(model.media.count, 4)
        XCTAssertEqual(model.media.last?.title, "Escrow refund request · confirmation")
        XCTAssertEqual(model.log.count, 8)
        XCTAssertEqual(model.log.first?.text, "Turned on county recorder alerts")
        XCTAssertEqual(model.snippet, "Checking this morning’s rates")

        model.act(.reviewPMI)
        XCTAssertEqual(model.router.sheet, .approval)
        model.approvePMI()
        await model.drain()
        XCTAssertEqual(model.feed[1].title, "PMI cancellation sent")
        XCTAssertNil(model.feed[1].tag)
        XCTAssertNil(model.feed[1].action)
        XCTAssertEqual(model.media.count, 5)
        XCTAssertEqual(model.chat[18].body, .text("Approved"))
        XCTAssertEqual(model.chat[19].body, .text(Copy.pmiSent))
        XCTAssertEqual(model.router.toastText, "PMI request sent")

        model.act(.startRefi)
        await model.drain()
        XCTAssertEqual(model.feed[0].title, "Refinance opened at 5.75%")
        XCTAssertNil(model.feed[0].action)
        XCTAssertEqual(model.chat[20].body, .text("Start the refinance"))
        XCTAssertEqual(model.chat[21].body, .text(Copy.refiOpening))
        XCTAssertTrue(model.router.refinanceShown)
        XCTAssertEqual(model.pendingMoves, 310)
        XCTAssertEqual(model.offeredMoves, 0)

        model.closeRefinance()
        await model.drain()
        XCTAssertFalse(model.router.refinanceShown)
        XCTAssertEqual(model.chat[22].body, .text(Copy.refiHandedBack))

        await model.escrowRefundApproved()
        XCTAssertEqual(model.escrowRefund, .approved)
        XCTAssertEqual(model.feed.count, 6)
        XCTAssertEqual(model.feed.first?.title, "Escrow refund approved — $412")
        XCTAssertEqual(model.chat.last?.body, .text(Copy.escrowApprovedMessage))
        XCTAssertEqual(model.router.toastText, "Hazel posted to your feed")
        await model.roofPoolOpened()
        XCTAssertEqual(model.feed.count, 7)
        XCTAssertEqual(model.feed.first?.title, "Four homes on your street are on Supermortgage")
        XCTAssertEqual(model.chat.last?.body, .text(Copy.roofPoolMessage))
    }

    func testCreditNotNowSkipsToPlaid() async {
        let model = makeModel()
        model.name = "Reed"
        model.act(.connCredit("Not now"))
        await model.drain()
        XCTAssertFalse(model.connections.credit)
        XCTAssertEqual(model.chat[0].body, .text("Not now"))
        XCTAssertEqual(model.chat[1].body, .text(Copy.creditDeclined))
        XCTAssertEqual(labels(model.chat[2]), ["Connect with Plaid"])
    }

    func testSomethingElseFallsBackToHazel() async {
        let model = makeModel()
        model.act(.nameOther)
        XCTAssertEqual(model.router.sheet, .name)
        model.saveName("   ")
        await model.drain()
        XCTAssertEqual(model.name, "Hazel")
        XCTAssertNil(model.router.sheet)
        XCTAssertEqual(model.chat.first?.body, .text("I’ll call you Hazel"))
        let other = makeModel()
        other.saveName(" Juniper ")
        XCTAssertEqual(other.name, "Juniper")
    }

    func testNotYet() async {
        let model = makeModel()
        model.act(.notYet)
        await model.drain()
        XCTAssertEqual(model.refi, .offered)
        XCTAssertEqual(model.chat.map(\.body), [.text("Not yet"), .text(Copy.notYetReply)])
    }

    func testAnswerRouting() async {
        let model = makeModel()
        model.name = "Hazel"
        model.stage = .chat
        model.setupDone = true

        model.send("what is my number now?")
        await model.drain()
        guard case .number(let lead, let amount, let rows) = model.chat[1].body else { return XCTFail("expected the number reply") }
        XCTAssertEqual(lead, "Right now it’s $3,114 a month — down $74 since we started. $0 more is pending and $310 is on the table.")
        XCTAssertNil(amount)
        XCTAssertEqual(rows.count, 7)

        model.send("Can I talk to a human?")
        await model.drain()
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerHuman))
        XCTAssertEqual(labels(model.chat.last), ["Schedule a call"])

        model.send("refi?")
        await model.drain()
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerRefiOffered))
        XCTAssertEqual(labels(model.chat.last), ["Start the refinance"])

        model.send("pmi")
        await model.drain()
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerPMIReady))
        XCTAssertEqual(labels(model.chat.last), ["Review it"])

        model.send("insurance")
        await model.drain()
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerInsurance(renewal: "March 3")))
        XCTAssertEqual(model.chat.last?.options?.first?.action, .doNow("w35"))

        model.send("my taxes")
        await model.drain()
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerTax))

        model.send("solar?")
        await model.drain()
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerIncome))

        model.send("hello there")
        await model.drain()
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerDefault))
        XCTAssertEqual(model.log.first?.text, "Looked into: “hello there”")

        model.send("   ")
        await model.drain()
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerDefault), "blank messages are ignored")

        model.send("please stop")
        await model.drain()
        XCTAssertTrue(model.paused)
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerPaused))
        XCTAssertEqual(model.snippet, "Paused")
    }

    func testAnswersFollowState() async {
        let model = makeModel()
        model.approvePMI()
        model.startRefi()
        await model.drain()
        model.send("rates?")
        await model.drain()
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerRefiStarted))
        XCTAssertNil(model.chat.last?.options)
        model.send("PMI status")
        await model.drain()
        XCTAssertEqual(model.chat.last?.body, .text(Copy.answerPMIRequested))
        XCTAssertNil(model.chat.last?.options)
    }

    func testSideChatsDiscussAttachAndSchedule() async {
        let model = makeModel()
        model.name = "Hazel"
        model.sideChat(.pmi)
        await model.drain()
        XCTAssertEqual(model.tab, .chat)
        XCTAssertEqual(model.chat[0].body, .text("PMI"))
        XCTAssertEqual(model.chat[1].body, .text(Copy.answerPMIReady))

        model.post("🏠", "A post", "Its body.")
        model.discuss(model.feed[0].id)
        await model.drain()
        XCTAssertEqual(model.chat[2].body, .text("About “A post”"))
        XCTAssertEqual(model.chat[3].body, .text("Happy to. Its body. What would you like to change or know?"))

        model.attachPick("A photo of a bill")
        await model.drain()
        XCTAssertEqual(model.chat[4].body, .text("A photo of a bill"))
        XCTAssertEqual(model.chat[5].body, .progress(ProgressState(loading: "Reading it…", done: "Read. Nothing new against what I have — filed under Media.", small: nil)))
        XCTAssertEqual(model.media.last?.title, "A photo of a bill")
        XCTAssertEqual(model.log.first?.text, "Read an upload: A photo of a bill")

        model.scheduled("Today, 4:30 PM")
        await model.drain()
        XCTAssertEqual(model.chat[6].body, .text("Today, 4:30 PM"))
        XCTAssertEqual(model.chat[7].body, .text("Booked for Today, 4:30 PM. They’ll have the full picture."))
        XCTAssertEqual(model.log.first?.text, "Call scheduled Today, 4:30 PM")
    }
}
