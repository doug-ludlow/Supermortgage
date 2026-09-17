import XCTest
@testable import Supermortgage

/// The number's arithmetic under each state (§4 and §6).
@MainActor
final class NumberTests: XCTestCase {
    private func makeModel() -> AppModel {
        AppModel(clock: ImmediateClock(), runsTimers: false)
    }

    func testFirstRender() {
        let model = makeModel()
        XCTAssertEqual(model.total, 3188.17, accuracy: 0.001)
        XCTAssertEqual(model.doneMoves, 73.99, accuracy: 0.001)
        XCTAssertEqual(model.current, 3114.18, accuracy: 0.001)
        XCTAssertEqual(Format.money(model.current), "$3,114")
        XCTAssertEqual(model.pendingMoves, 0)
        XCTAssertEqual(model.offeredMoves, 310)
    }

    func testAfterPMIApproval() {
        let model = makeModel()
        model.approvePMI()
        XCTAssertEqual(model.pmi, .requested)
        XCTAssertEqual(model.pendingMoves, 146)
        XCTAssertEqual(model.offeredMoves, 164)
        XCTAssertEqual(Format.money(model.current), "$3,114")
    }

    func testAfterRefinanceStarts() {
        let model = makeModel()
        model.approvePMI()
        model.startRefi()
        XCTAssertEqual(model.refi, .started)
        XCTAssertEqual(model.pendingMoves, 310)
        XCTAssertEqual(model.offeredMoves, 0)
    }

    func testUtilitiesAddTwentyTwoPending() async {
        let model = makeModel()
        await model.connectNow(.smud)
        XCTAssertEqual(model.pendingMoves, 22)
        XCTAssertEqual(model.offeredMoves, 310)
    }

    func testApprovingTwiceDoesNothing() {
        let model = makeModel()
        model.approvePMI()
        let media = model.media.count
        model.approvePMI()
        XCTAssertEqual(model.media.count, media)
        XCTAssertEqual(model.pendingMoves, 146)
    }

    func testStartingRefinanceTwiceDoesNothing() {
        let model = makeModel()
        model.startRefi()
        let logCount = model.log.count
        model.startRefi()
        XCTAssertEqual(model.log.count, logCount)
    }

    func testBreakdownDropsTheCancelledLinesOnceSetupIsDone() {
        let model = makeModel()
        XCTAssertEqual(model.breakdown().count, 9)
        model.stage = .chat
        XCTAssertEqual(model.breakdown().count, 9)
        model.setupDone = true
        let rows = model.breakdown()
        XCTAssertEqual(rows.count, 7)
        XCTAssertEqual(rows.first?.key, "Mortgage — principal & interest")
        XCTAssertEqual(rows.first?.value, "$1,841.06")
        XCTAssertEqual(rows[1].value, "$571.12")
        XCTAssertEqual(rows[2].key, "PMI")
        XCTAssertEqual(rows[2].value, "$146")
        XCTAssertFalse(rows.contains { $0.key == "Title lock" || $0.key == "Home warranty" })
    }

    func testBarFractionsHaveATwoPercentFloor() {
        let model = makeModel()
        XCTAssertEqual(model.barFraction(0), 0)
        XCTAssertEqual(model.barFraction(1), 0.02, accuracy: 0.0001)
        XCTAssertEqual(model.barFraction(model.total), 1, accuracy: 0.0001)
        XCTAssertEqual(model.barFraction(310), 310 / 3188.17, accuracy: 0.0001)
    }

    func testSparkPoints() {
        let model = makeModel()
        var spark = model.sparkPoints
        XCTAssertEqual(spark.happened.count, 5)
        XCTAssertEqual(spark.plan.count, 12)
        XCTAssertEqual(spark.happened[0], model.total, accuracy: 0.001)
        XCTAssertEqual(spark.happened[4], model.current, accuracy: 0.001)
        XCTAssertEqual(spark.plan[11], model.current - 140, accuracy: 0.001)
        model.approvePMI()
        model.startRefi()
        spark = model.sparkPoints
        XCTAssertEqual(spark.happened[3], model.current - 146, accuracy: 0.001)
        XCTAssertEqual(spark.happened[4], model.current - 146 - 164, accuracy: 0.001)
    }

    func testGoalsSummariesFollowState() {
        let model = makeModel()
        XCTAssertEqual(model.nextDates.map(\.title), ["Compute site check", "Internet promo ends — I call", "Insurance quotes begin", "Assessment window opens"])
        XCTAssertEqual(model.categorySummaries[0].sub, "Refinance ready — needs your yes")
        XCTAssertEqual(model.categorySummaries[0].value, "−$164 offered")
        XCTAssertEqual(model.categorySummaries[2].sub, "2 subscriptions gone · PMI needs your yes")
        XCTAssertEqual(model.categorySummaries[2].value, "−$74 done")
        model.approvePMI()
        XCTAssertEqual(model.nextDates[1].title, "PMI decision due from your servicer")
        XCTAssertEqual(model.nextDates[1].when, "Oct 17")
        XCTAssertEqual(model.categorySummaries[2].sub, "PMI requested · 2 subscriptions gone · refund coming")
        XCTAssertEqual(model.categorySummaries[2].value, "−$74 done · −$146 pending")
        model.startRefi()
        XCTAssertEqual(model.categorySummaries[0].sub, "Refinance in progress")
        XCTAssertEqual(model.categorySummaries[0].value, "−$164 pending")
    }
}
