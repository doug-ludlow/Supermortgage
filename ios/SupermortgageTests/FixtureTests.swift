import XCTest
@testable import Supermortgage

/// §6 of the spec: the fixture values transcribed from the HTML.
@MainActor
final class FixtureTests: XCTestCase {
    private func makeModel() -> AppModel {
        AppModel(clock: ImmediateClock(), runsTimers: false)
    }

    func testNineCostLinesSumToTheNumber() {
        XCTAssertEqual(Costs.lines.count, 9)
        XCTAssertEqual(Costs.total, 3188.17, accuracy: 0.001)
        XCTAssertEqual(Format.money(Costs.total), "$3,188")
        XCTAssertEqual(Costs.lines.first?.label, "Mortgage — principal & interest")
        XCTAssertEqual(Costs.lines.last?.label, "Title lock")
        XCTAssertEqual(Costs.lines.last?.amount, 19.99)
    }

    func testFiftyNineWorkRowsInFileOrder() {
        let model = makeModel()
        XCTAssertEqual(model.work.count, 59)
        XCTAssertEqual(model.work.first?.id, "w1")
        XCTAssertEqual(model.work.last?.id, "w59")
        XCTAssertEqual(model.work.map(\.id), (1...59).map { "w\($0)" })
        XCTAssertEqual(model.work.first?.title, "I check your rate against the market every morning and refinance you when it pays")
        XCTAssertEqual(model.work.last?.title, "For renters: I shop the renter’s policy your lease requires")
    }

    func testStatusCountsAtFirstRender() {
        let model = makeModel()
        XCTAssertEqual(model.count(.running), 24)
        XCTAssertEqual(model.count(.needsYou), 3)
        XCTAssertEqual(model.count(.waiting), 14)
        XCTAssertEqual(model.count(.needsConnection), 3)
        XCTAssertEqual(model.count(.done), 4)
        XCTAssertEqual(model.count(.doesntApply), 11)
        XCTAssertEqual(model.needsYouRows.map(\.id), ["w1", "w8", "w42"])
        XCTAssertEqual(model.work.filter { $0.status == .needsConnection }.map(\.id), ["w24", "w44", "w46"])
        XCTAssertEqual(model.work.filter { $0.status == .done }.map(\.id), ["w6", "w30", "w32", "w49"])
        XCTAssertEqual(model.workCountLine,
                       "59 things I do for your home — 24 running · 3 need you · 14 waiting for a date · 3 need a connection · 4 done · 11 don’t apply")
    }

    func testSegmentCountsExcludeDoesntApply() {
        let model = makeModel()
        XCTAssertEqual(model.segmentCount(.upgrade), 14)
        XCTAssertEqual(model.segmentCount(.income), 9)
        XCTAssertEqual(model.segmentCount(.eliminate), 25)
        XCTAssertEqual(model.categoryRows(.upgrade).count, 14 - 2)
        XCTAssertEqual(model.doesntApplyRows(.upgrade).count, 3)
    }

    func testKeysAndArtifactsOnRows() {
        let model = makeModel()
        XCTAssertEqual(model.item(.refi)?.id, "w1")
        XCTAssertEqual(model.item(.lock)?.id, "w3")
        XCTAssertEqual(model.item(.buffer)?.id, "w8")
        XCTAssertEqual(model.item(.site)?.id, "w18")
        XCTAssertEqual(model.item(.grid)?.id, "w24")
        XCTAssertEqual(model.item(.pmi)?.id, "w42")
        XCTAssertEqual(model.item(.smud)?.id, "w44")
        XCTAssertEqual(model.item(.util)?.id, "w46")
        XCTAssertEqual(model.item(id: "w28")?.once, 412)
        XCTAssertEqual(model.item(id: "w28")?.artifactId, .audit)
        XCTAssertEqual(model.item(id: "w49")?.dollarsPerMonth, -73.99)
        XCTAssertEqual(model.item(.refi)?.dollarsPerMonth, -164)
        XCTAssertEqual(model.item(.pmi)?.dollarsPerMonth, -146)
        XCTAssertEqual(model.item(.smud)?.dollarsPerMonth, -22)
        XCTAssertEqual(model.item(id: "w35")?.dollarsPerMonth, -38)
    }

    func testAskFirstRule() {
        let model = makeModel()
        XCTAssertTrue(model.item(.refi)!.askFirst, "needs-you rows ask first")
        XCTAssertTrue(model.item(.lock)!.askFirst, "the title mentions a refinance")
        XCTAssertTrue(model.item(id: "w35")!.askFirst, "the title mentions a policy")
        XCTAssertTrue(model.item(id: "w9")!.askFirst, "the title mentions debt")
        XCTAssertFalse(model.item(id: "w4")!.askFirst)
        XCTAssertFalse(model.item(id: "w13")!.askFirst)
        XCTAssertEqual(model.work.filter(\.askFirst).count, 15)
    }

    func testArtifactsMediaSnippetsPermissions() {
        let model = makeModel()
        XCTAssertEqual(model.artifacts.count, 7)
        XCTAssertEqual(model.artifacts.map(\.id), [.dash, .refi, .audit, .pmi, .ins, .site, .tax])
        XCTAssertEqual(model.artifacts.first?.subtitle, "Live · updates with every move")
        XCTAssertTrue(model.artifacts.first!.live)
        XCTAssertEqual(model.artifacts.filter(\.live).count, 1)
        XCTAssertEqual(model.media.count, 3)
        XCTAssertEqual(model.media.map(\.title), ["Mortgage statement · Sep 2026", "Title-lock cancellation receipt", "Home warranty cancellation receipt"])
        XCTAssertEqual(Copy.snippets.count, 6)
        XCTAssertEqual(Permissions.all.count, 9)
        XCTAssertEqual(Permissions.doesOnItsOwn.count, 4)
        XCTAssertEqual(Permissions.asksFirst.count, 5)
        XCTAssertEqual(GoalCategory.all.map(\.title), ["Pay off by a date", "Add an ADU", "Move in a few years", "Keep my escrow", "No tenants", "Something else"])
    }

    func testWorkRowAmounts() {
        let model = makeModel()
        XCTAssertEqual(Format.amount(for: model.item(.pmi)!)?.main, "−$146")
        XCTAssertEqual(Format.amount(for: model.item(.pmi)!)?.small, "/mo est.")
        XCTAssertEqual(Format.amount(for: model.item(id: "w28")!)?.main, "+$412")
        XCTAssertEqual(Format.amount(for: model.item(id: "w28")!)?.small, "once")
        XCTAssertEqual(Format.amount(for: model.item(id: "w49")!)?.main, "−$74")
        XCTAssertEqual(Format.amount(for: model.item(id: "w49")!)?.small, "/mo")
        XCTAssertNil(Format.amount(for: model.item(id: "w2")!))
        XCTAssertEqual(Format.worth(for: model.item(id: "w28")!), "$412 once")
        XCTAssertEqual(Format.worth(for: model.item(.refi)!), "$164 a month")
        XCTAssertNil(Format.worth(for: model.item(id: "w2")!))
    }

    func testFormatting() {
        XCTAssertEqual(Format.money(Home.payment, 2), "$2,412.18")
        XCTAssertEqual(Format.money(Home.payment), "$2,412")
        XCTAssertEqual(Format.money(73.99), "$74")
        XCTAssertEqual(Format.money(0), "$0")
        XCTAssertEqual(Format.money(5000), "$5,000")
        var components = DateComponents()
        components.year = 2026
        components.month = 9
        components.day = 17
        components.hour = 9
        components.minute = 41
        let calendar = Calendar(identifier: .gregorian)
        let morning = calendar.date(from: components)!
        XCTAssertEqual(Format.dayLabel(morning, calendar: calendar), "Thursday morning")
        components.hour = 14
        XCTAssertEqual(Format.dayLabel(calendar.date(from: components)!, calendar: calendar), "Thursday afternoon")
        components.hour = 19
        XCTAssertEqual(Format.dayLabel(calendar.date(from: components)!, calendar: calendar), "Thursday evening")
        XCTAssertEqual(Format.clock(morning), "9:41 AM")
    }

    func testMemoryText() {
        XCTAssertTrue(Copy.memoryText().hasPrefix("Home: 24 Juniper Lane, Sacramento, CA 95816 · single-family · 1,640 sq ft · built 1998 · no HOA"))
        XCTAssertTrue(Copy.memoryText().contains("$2,412.18 a month including escrow"))
        XCTAssertTrue(Copy.memoryText().hasSuffix("Preferences: ask before anything binding · buffer not set · tenants: undecided"))
    }
}
