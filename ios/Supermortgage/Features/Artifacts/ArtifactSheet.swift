import SwiftUI

/// An artifact's preview sheet, laid out as `artSheet` does for each id.
struct ArtifactSheet: View {
    let id: ArtifactID

    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        if let artifact = model.artifact(id) {
            SheetContainer(artifact.title) {
                switch id {
                case .dash: dashboard
                case .refi: refinance
                case .audit: audit
                case .pmi: pmi
                case .ins: insurance
                case .site: site
                case .tax: tax
                }
            }
        } else {
            EmptyView()
        }
    }

    private func heading(_ text: String) -> some View {
        Text(text)
            .textStyle(.bodySemibold)
            .foregroundStyle(t.text)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.bottom, 10)
    }

    private var dashboard: some View {
        PreviewBox {
            heading("\(Format.money(model.current)) a month")
            ForEach(Costs.lines.filter { !$0.label.matches("warranty|Title lock") }) { line in
                ListRow(line.label, Format.money(line.amount, line.amount.truncatingRemainder(dividingBy: 1) != 0 ? 2 : 0))
            }
            HStack(alignment: .firstTextBaseline) {
                Text("Now")
                Spacer(minLength: 0)
                Text(Format.money(model.current))
            }
            .textStyle(.bodySemibold)
            .foregroundStyle(t.text)
            .padding(.top, 10)
            .overlay(alignment: .top) { Rectangle().fill(t.text).frame(height: 2) }
            .padding(.top, 10)
            FineText("Down \(Format.money(model.doneMoves)) since Thursday. \(Format.money(model.pendingMoves)) pending, \(Format.money(model.offeredMoves)) offered.")
                .padding(.bottom, 0)
        }
    }

    private var refinance: some View {
        Group {
            PreviewBox {
                heading("Your loan today vs the offer")
                HStack(alignment: .top, spacing: 10) {
                    CompareColumn(title: "Today", rows: [
                        KeyValue(key: "Rate", value: "6.125%"),
                        KeyValue(key: "P&I", value: "$1,841"),
                        KeyValue(key: "Left", value: "27 yrs"),
                    ])
                    CompareColumn(title: "Offered", rows: [
                        KeyValue(key: "Rate", value: "5.75%"),
                        KeyValue(key: "P&I", value: "$1,677"),
                        KeyValue(key: "Term", value: "30 yrs"),
                    ])
                }
                .padding(.top, -2)
                ListRow("Monthly savings", "$164")
                ListRow("Costs (lender credit applied)", "$1,780")
                ListRow("Payback", "11 months")
                ListRow("Seven-year benefit", "$11,940")
                FineText(Copy.refiFine)
                    .padding(.bottom, 0)
            }
            if model.refi == .offered {
                ActionStack {
                    PrimaryButton("Start the refinance") { model.startRefi() }
                }
            }
        }
    }

    private var audit: some View {
        PreviewBox {
            heading("September statement")
            StatusRow(text: "Payment applied correctly", small: "$1,841.06 P&I · $571.12 escrow")
                .padding(.vertical, 14)
                .bottomLine(t.line)
            StatusRow(text: "No late charge, no force-placed insurance")
                .padding(.vertical, 14)
                .bottomLine(t.line)
            StatusRow(text: "Escrow analysis over-collected",
                      small: "Cushion held at $1,940 against a $1,528 maximum. $412 refund \(model.escrowRefund.rawValue).",
                      done: false, spinnerTop: t.accent)
                .padding(.vertical, 14)
                .bottomLine(t.line)
            StatusRow(text: "PMI still billed at 70% LTV", small: "Not an error — it needs a request. See the PMI cancellation request.")
                .padding(.vertical, 14)
        }
    }

    private var pmi: some View {
        Group {
            PreviewBox {
                Text(Copy.pmiLetter(sent: model.pmi == .requested))
                    .textStyle(.support)
                    .foregroundStyle(t.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("artifact.pmi.letter")
            }
            if model.pmi == .ready {
                ActionStack {
                    PrimaryButton("Review and approve") { model.reviewPMI() }
                }
            }
        }
    }

    private var insurance: some View {
        PreviewBox {
            heading("Renewal \(Home.renewal)")
            IntroText(Copy.insuranceIntro(), color: t.muted)
            ActionStack {
                SecondaryButton("Start quotes now") { model.doNow("w35") }
            }
            .padding(.top, 0)
        }
    }

    private var site: some View {
        PreviewBox {
            heading("Site check · Sep 24")
            Text(Copy.siteIntro)
                .textStyle(.support)
                .foregroundStyle(t.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var tax: some View {
        PreviewBox {
            heading("Nothing to appeal this year")
            Text(Copy.taxIntro)
                .textStyle(.support)
                .foregroundStyle(t.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// `.ag-col`: a bordered column with a 15pt semibold heading and 12pt key-value rows.
struct CompareColumn: View {
    let title: String
    let rows: [KeyValue]

    @Environment(\.tokens) private var t

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .textStyle(.supportSemibold)
                .foregroundStyle(t.text)
                .padding(.bottom, 8)
            ForEach(rows) { row in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(row.key)
                        .textStyle(.meta)
                        .foregroundStyle(t.muted)
                    Spacer(minLength: 0)
                    Text(row.value)
                        .textStyle(.metaMedium)
                        .foregroundStyle(t.text)
                }
                .padding(.vertical, 6)
                .topLine(t.line)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(t.line, lineWidth: 1))
    }
}
