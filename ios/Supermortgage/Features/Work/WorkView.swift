import SwiftUI

/// Work — the count line, the category segments, the Needs you group, the category's rows and the
/// collapsed "Doesn’t apply" disclosure.
struct WorkView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t
    @State private var showDoesntApply = false

    var body: some View {
        TabPage {
            ScreenTitle("Work")
            Text(model.workCountLine)
                .textStyle(.support)
                .foregroundStyle(t.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, -8)
                .padding(.bottom, 16)
                .accessibilityIdentifier("work.count")
            SegmentedControl(
                segments: WorkCategory.allCases.map { Segment(value: $0, label: $0.label, count: model.segmentCount($0)) },
                selection: $model.workSegment)
                .padding(.bottom, 18)

            let needs = model.needsYouRows
            if !needs.isEmpty {
                GroupHeading(title: "Needs you", count: needs.count)
                ForEach(needs) { item in
                    WorkRowView(item: item) { model.openWorkSheet(item.id) }
                }
            }

            GroupHeading(title: model.workSegment.label, count: nil)
            ForEach(model.categoryRows(model.workSegment)) { item in
                WorkRowView(item: item) { model.openWorkSheet(item.id) }
            }

            let na = model.doesntApplyRows(model.workSegment)
            if !na.isEmpty {
                Button { showDoesntApply.toggle() } label: {
                    HStack(spacing: 10) {
                        Text("Doesn’t apply to your home (\(na.count))")
                            .textStyle(.support)
                            .foregroundStyle(t.muted)
                        Icon(.arrow, size: 16)
                            .foregroundStyle(t.muted)
                            .rotationEffect(.degrees(showDoesntApply ? 90 : 0))
                        Spacer(minLength: 0)
                        Text(showDoesntApply ? "−" : "+")
                            .font(.system(size: 23, weight: .light))
                            .foregroundStyle(t.quiet)
                    }
                    .padding(.vertical, 12)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, 6)
                .accessibilityIdentifier("work.doesntApply")
                if showDoesntApply {
                    ForEach(na) { item in
                        WorkRowView(item: item) { model.openWorkSheet(item.id) }
                    }
                }
            }
        }
        .accessibilityIdentifier("screen.work")
    }
}

/// `.ag-group > h2`: a 17pt semibold group title with an optional count chip.
struct GroupHeading: View {
    let title: String
    let count: Int?

    @Environment(\.tokens) private var t

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .textStyle(.bodySemibold)
                .foregroundStyle(t.text)
            if let count {
                Chip(text: "\(count)", status: .needsYou)
            }
        }
        .padding(.top, 14)
        .padding(.bottom, 2)
        .accessibilityAddTraits(.isHeader)
    }
}

/// `.ag-row`: status dot, title, the chip + cadence line, the meta line, and the amount on the right.
struct WorkRowView: View {
    let item: WorkItem
    let action: () -> Void

    @Environment(\.tokens) private var t

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                StatusDot(status: item.status)
                    .padding(.top, 7)
                VStack(alignment: .leading, spacing: 0) {
                    Text(item.title)
                        .textStyle(.bodyMedium)
                        .foregroundStyle(t.text)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(alignment: .center, spacing: 8) {
                        Chip(text: item.statusLabel, status: item.status)
                        Text(item.cadence)
                            .textStyle(.meta)
                            .foregroundStyle(t.muted)
                    }
                    .padding(.top, 6)
                    Text(item.meta)
                        .textStyle(.meta)
                        .foregroundStyle(t.quiet)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                }
                Spacer(minLength: 0)
                if let amount = Format.amount(for: item) {
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(amount.main)
                            .textStyle(.supportSemibold)
                            .foregroundStyle(t.text)
                        Text(amount.small)
                            .textStyle(.meta)
                            .foregroundStyle(t.muted)
                    }
                    .lineLimit(1)
                    .padding(.top, 1)
                }
            }
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(item.status == .doesntApply ? 0.62 : 1)
        .bottomLine(t.line)
        .accessibilityIdentifier("work.row.\(item.id)")
    }
}
