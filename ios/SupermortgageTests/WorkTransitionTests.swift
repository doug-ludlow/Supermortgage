import XCTest
@testable import Supermortgage

/// Work status derivation for the connect / approve / refinance / no-tenants transitions (§5.5).
@MainActor
final class WorkTransitionTests: XCTestCase {
    private func makeModel() -> AppModel {
        AppModel(clock: ImmediateClock(), runsTimers: false)
    }

    func testPMIApprovalRipples() {
        let model = makeModel()
        model.approvePMI()
        let w42 = model.item(.pmi)!
        XCTAssertEqual(w42.status, .waiting)
        XCTAssertEqual(w42.meta, "Requested Sep 17 · servicer has 30 days")
        XCTAssertEqual(model.artifact(.pmi)?.subtitle, "Sent Sep 17 · response due Oct 17")
        XCTAssertEqual(model.media.last?.title, "PMI request · sent confirmation")
        XCTAssertEqual(model.log.first?.text, "PMI cancellation request sent")
        XCTAssertEqual(model.chat.last?.role, .user)
        XCTAssertEqual(model.chat.last?.body, .text("Approved"))
        XCTAssertEqual(model.count(.needsYou), 2)
        XCTAssertEqual(model.history(for: w42).first?.text, "Cancellation request sent")
    }

    func testRefinanceStartRipples() {
        let model = makeModel()
        model.startRefi()
        XCTAssertEqual(model.item(.refi)?.status, .running)
        XCTAssertEqual(model.item(.refi)?.meta, "In progress · watching pricing hourly")
        XCTAssertEqual(model.item(.lock)?.status, .running)
        XCTAssertEqual(model.item(.lock)?.meta, "Live · best pricing so far 5.75%")
        XCTAssertEqual(model.artifact(.refi)?.subtitle, "In progress · 5.75%")
        XCTAssertEqual(model.log.first?.text, "Refinance opened · 5.75%")
        XCTAssertEqual(model.tab, .chat)
        XCTAssertEqual(model.history(for: model.item(.refi)!).map(\.when), ["6:31 today", "Yesterday", "Sep 15"])
    }

    func testConnectUtilities() async {
        let model = makeModel()
        await model.connectNow(.smud)
        XCTAssertEqual(model.item(.smud)?.status, .running)
        XCTAssertEqual(model.item(.smud)?.meta, "Time-of-day plan requested · about $22 a month")
        XCTAssertEqual(model.item(.util)?.status, .running)
        XCTAssertEqual(model.item(.util)?.meta, "Watching bills against your baseline")
        XCTAssertEqual(model.feed.first?.title, "Switched you to a time-of-day plan")
        XCTAssertEqual(model.feed.first?.icon, "⚡")
        XCTAssertEqual(model.log.first?.text, "Utilities connected · rate plan switched")
        XCTAssertEqual(model.router.sheet, .settings)
        XCTAssertEqual(model.count(.needsConnection), 1)
    }

    func testConnectUtilKeyIsTheSameAsSMUD() async {
        let model = makeModel()
        await model.connectNow(.util)
        XCTAssertEqual(model.item(.smud)?.status, .running)
        XCTAssertEqual(model.item(.util)?.status, .running)
    }

    func testConnectThermostat() async {
        let model = makeModel()
        await model.connectNow(.grid)
        XCTAssertEqual(model.item(.grid)?.status, .running)
        XCTAssertEqual(model.item(.grid)?.meta, "Thermostat enrolled · first event pays next month")
        XCTAssertEqual(model.log.first?.text, "Thermostat enrolled in demand response")
        XCTAssertNil(model.router.sheet)
    }

    func testConnectInsuranceCarrier() async {
        let model = makeModel()
        await model.connectNow(.ins)
        XCTAssertTrue(model.insuranceConnected)
        XCTAssertEqual(model.log.first?.text, "Insurance carrier connected")
        XCTAssertEqual(model.router.sheet, .settings)
    }

    func testNoTenantsRetiresTheTenantRows() {
        let model = makeModel()
        model.saveGoal("No tenants", note: "")
        XCTAssertEqual(model.goals.count, 1)
        XCTAssertEqual(model.goals.first?.note, "Planning")
        XCTAssertEqual(model.log.first?.text, "New goal: No tenants")
        for id in ["w20", "w22", "w27"] {
            XCTAssertEqual(model.item(id: id)?.status, .doesntApply, id)
            XCTAssertEqual(model.item(id: id)?.meta, "You said no tenants", id)
        }
        XCTAssertEqual(model.count(.doesntApply), 13)
        XCTAssertEqual(model.segmentCount(.income), 7)
        XCTAssertEqual(model.router.toastText, "Added to Tracking")
    }

    func testOtherGoalsDoNotTouchWork() {
        let model = makeModel()
        model.saveGoal("Add an ADU", note: "  a small one  ")
        XCTAssertEqual(model.goals.first?.note, "a small one")
        XCTAssertEqual(model.count(.doesntApply), 11)
    }

    func testBuffer() {
        let model = makeModel()
        model.setBuffer(5000)
        XCTAssertEqual(model.buffer, 5000)
        XCTAssertEqual(model.item(.buffer)?.status, .running)
        XCTAssertEqual(model.item(.buffer)?.meta, "Buffer $5,000 · sweeps on the 1st")
        XCTAssertEqual(model.log.first?.text, "Buffer set to $5,000")
        XCTAssertEqual(model.router.toastText, "Buffer set to $5,000")
        XCTAssertEqual(model.count(.needsYou), 2)
    }

    func testDoItNowOnInsuranceStartsQuotes() async {
        let model = makeModel()
        model.name = "Hazel"
        await model.doItNow("w35")
        XCTAssertEqual(model.item(id: "w35")?.status, .running)
        XCTAssertEqual(model.item(id: "w35")?.meta, "Quotes requested from 5 carriers · first back tomorrow")
        XCTAssertEqual(model.artifact(.ins)?.subtitle, "In progress · 5 carriers")
        XCTAssertEqual(model.feed.first?.title, "Insurance quotes started early")
        XCTAssertEqual(model.log.first?.text, "Ran now: I re-quote your homeowner’s policy every renewal and switch when it pays")
        XCTAssertEqual(model.router.toastText, "Done")
    }

    func testDoItNowElsewhereOnlyChecks() async {
        let model = makeModel()
        await model.doItNow("w2")
        XCTAssertEqual(model.item(id: "w2")?.status, .running)
        XCTAssertEqual(model.item(id: "w2")?.meta, "Checked just now · nothing changed")
        XCTAssertEqual(model.feed.count, 0)
    }

    func testAskModeAndPause() {
        let model = makeModel()
        model.setAskFirst("w4", true)
        XCTAssertTrue(model.item(id: "w4")!.askFirst)
        XCTAssertEqual(model.router.toastText, "I’ll ask first")
        model.setAskFirst("w4", false)
        XCTAssertFalse(model.item(id: "w4")!.askFirst)
        XCTAssertEqual(model.router.toastText, "I’ll just do it")
        model.togglePause("w4")
        XCTAssertTrue(model.item(id: "w4")!.paused)
        XCTAssertEqual(model.item(id: "w4")!.statusLabel, "Paused")
        XCTAssertEqual(model.log.first?.text, "Paused: I keep your score above the levels lenders price on, and time card payments before any credit pull")
        model.togglePause("w4")
        XCTAssertEqual(model.item(id: "w4")!.statusLabel, "Running")
        XCTAssertEqual(model.log.first?.text, "Resumed: I keep your score above the levels lenders price on, and time card payments before any credit pull")
    }

    func testHistoryByStatus() {
        let model = makeModel()
        XCTAssertEqual(model.history(for: model.item(id: "w6")!).map(\.text), ["You’re at 70% — already under the line"])
        XCTAssertEqual(model.history(for: model.item(id: "w2")!).map(\.text), ["Credit report valid 87 days · asset report 118 days", "Checked · nothing changed"])
        XCTAssertEqual(model.history(for: model.item(id: "w3")!).map(\.text), ["Scheduled · Starts when the refinance opens"])
        XCTAssertEqual(model.history(for: model.item(id: "w24")!).map(\.text), ["Waiting on a connection"])
        XCTAssertEqual(model.history(for: model.item(id: "w11")!).map(\.text), ["Checked once · doesn’t apply"])
        XCTAssertEqual(model.history(for: model.item(.pmi)!).map(\.text), ["Request drafted · waiting for your yes", "Value check · $410,000 · LTV 70%"])
    }

    func testSettingsAndPause() {
        let model = makeModel()
        model.setPaused(true)
        XCTAssertTrue(model.paused)
        XCTAssertEqual(model.log.first?.text, "Paused everything")
        XCTAssertEqual(model.router.toastText, "Paused")
        model.setupDone = true
        XCTAssertEqual(model.snippet, "Paused")
        model.setPaused(false)
        XCTAssertEqual(model.snippet, "Checking this morning’s rates")
        XCTAssertEqual(model.router.toastText, "Back to work")
        model.setApprovals(.justDoIt)
        XCTAssertEqual(model.approvals, .justDoIt)
        XCTAssertEqual(model.router.toastText, "Approvals updated")
        model.setNotify(.daily)
        XCTAssertEqual(model.router.toastText, "Notifications updated")
        model.setTheme(.dark)
        XCTAssertEqual(model.theme, .dark)
        model.saveMemory("Home: somewhere else")
        XCTAssertEqual(model.memoryDisplay, "Home: somewhere else")
        XCTAssertEqual(model.log.first?.text, "Memory edited")
        model.saveInstructions("  Post more.  ")
        XCTAssertEqual(model.feedInstructions, "Post more.")
        model.saveInstructions("   ")
        XCTAssertEqual(model.feedInstructions, "Post more.")
    }

    func testDeleteResetsEverything() async {
        let model = makeModel()
        model.name = "Hazel"
        model.stage = .chat
        model.setupDone = true
        model.approvePMI()
        model.startRefi()
        await model.connectNow(.smud)
        model.saveGoal("No tenants", note: "")
        model.setTheme(.dark)
        model.deleteData()
        XCTAssertEqual(model.stage, .welcome)
        XCTAssertEqual(model.name, "")
        XCTAssertFalse(model.setupDone)
        XCTAssertEqual(model.chat.count, 0)
        XCTAssertEqual(model.feed.count, 0)
        XCTAssertEqual(model.log.count, 0)
        XCTAssertEqual(model.goals.count, 0)
        XCTAssertEqual(model.pmi, .ready)
        XCTAssertEqual(model.refi, .offered)
        XCTAssertEqual(model.theme, .light)
        XCTAssertEqual(model.media.count, 3)
        XCTAssertEqual(model.count(.needsYou), 3)
        XCTAssertEqual(model.count(.doesntApply), 11)
        XCTAssertEqual(model.artifact(.pmi)?.subtitle, "Draft — waiting for your yes")
        XCTAssertNil(model.router.sheet)
        XCTAssertNil(model.router.toastText)
        XCTAssertFalse(model.router.refinanceShown)
    }
}
