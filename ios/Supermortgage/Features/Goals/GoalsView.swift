import SwiftUI

/// Goals — the Tracking card (the number, the bar, the sparkline, next dates), user goals,
/// By category, and Create a goal.
struct GoalsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        TabPage {
            ScreenTitle("Goals")
            Text("Tracking")
                .textStyle(.support)
                .foregroundStyle(t.muted)
            trackingCard
                .padding(.top, 10)
            ForEach(model.goals) { goal in
                SubRow(title: goal.title, small: goal.note, value: "Planning") { model.openGoal(goal.title) }
            }
            SectionHeading("By category")
            ForEach(Array(model.categorySummaries.enumerated()), id: \.offset) { _, row in
                SubRow(title: row.category.label, small: row.sub, value: row.value) {
                    model.openWork(segment: row.category)
                }
            }
            SectionHeading("Create a goal")
            Text(Copy.goalsIntro)
                .textStyle(.support)
                .foregroundStyle(t.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 6)
            ForEach(GoalCategory.all) { category in
                Button { model.newGoal(category.title) } label: {
                    HStack(spacing: 12) {
                        Icon(category.icon, size: 20)
                            .foregroundStyle(t.quiet)
                        Text(category.title)
                            .textStyle(.body)
                            .foregroundStyle(t.text)
                        Spacer(minLength: 0)
                        Icon(.plus, size: 20)
                            .foregroundStyle(t.quiet)
                    }
                    .padding(.vertical, 12)
                    .frame(minHeight: 56)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .bottomLine(t.line)
                .accessibilityIdentifier("goal.new.\(category.title)")
            }
        }
        .accessibilityIdentifier("screen.goals")
    }

    private var trackingCard: some View {
        let done = model.doneMoves
        let pending = model.pendingMoves
        let offered = model.offeredMoves
        let spark = model.sparkPoints
        return Card {
            Text("Monthly housing cost")
                .textStyle(.support)
                .foregroundStyle(t.muted)
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(Format.money(model.current))
                    .textStyle(.bigNumber)
                    .foregroundStyle(t.text)
                    .accessibilityIdentifier("goals.number")
                Text("→")
                    .textStyle(.arrow)
                    .foregroundStyle(t.quiet)
                Text("$0")
                    .textStyle(.body)
                    .foregroundStyle(t.muted)
            }
            .padding(.top, 2)
            ProgressBar(done: model.barFraction(done), pending: model.barFraction(pending), offered: model.barFraction(offered))
                .padding(.top, 16)
                .padding(.bottom, 8)
            HStack(spacing: 14) {
                LegendItem(color: t.accent, text: "Done −\(Format.money(done))")
                LegendItem(color: t.pendingBar, text: "Pending −\(Format.money(pending))")
                LegendItem(color: t.accentSoft, outline: t.cardLine, text: "Offered −\(Format.money(offered))")
            }
            Sparkline(happened: spark.happened, plan: spark.plan)
                .padding(.top, 14)
            FineText(Copy.sparkFine)
            HistoryList(rows: model.nextDates.map { (text: $0.title, when: $0.when) }, lineAbove: true)
        }
    }
}

/// `.ag-legend` item: an 8pt dot and 12pt `muted` text.
struct LegendItem: View {
    let color: Color
    var outline: Color? = nil
    let text: String

    @Environment(\.tokens) private var t

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .overlay(Circle().strokeBorder(outline ?? Color.clear, lineWidth: 1))
                .frame(width: 8, height: 8)
            Text(text)
                .textStyle(.meta)
                .foregroundStyle(t.muted)
        }
    }
}

/// `.ag-sub`: a 17pt semibold title, a 15pt `muted` small line and a semibold value on the right.
struct SubRow: View {
    let title: String
    let small: String
    let value: String
    let action: () -> Void

    @Environment(\.tokens) private var t

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .textStyle(.bodySemibold)
                        .foregroundStyle(t.text)
                    Text(small)
                        .textStyle(.support)
                        .foregroundStyle(t.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Text(value)
                    .textStyle(.supportSemibold)
                    .foregroundStyle(t.text)
                    .lineLimit(1)
            }
            .padding(.vertical, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .bottomLine(t.line)
        .accessibilityIdentifier("goals.row.\(title)")
    }
}
