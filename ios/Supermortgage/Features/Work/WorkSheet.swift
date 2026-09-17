import SwiftUI

/// A standing action's sheet: detail, Status / How often / Right now / Worth, History,
/// What it produced, Before it acts, and the actions by key and status.
struct WorkSheet: View {
    let id: String

    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        if let item = model.item(id: id) {
            SheetContainer(item.title) {
                IntroText(item.detail, color: t.muted)
                ListRow("Status") {
                    Chip(text: item.statusLabel, status: item.status)
                }
                ListRow("How often", item.cadence)
                ListRow("Right now", item.meta)
                if let worth = Format.worth(for: item) {
                    ListRow("Worth", worth)
                }
                SheetSection("History") {
                    HistoryList(rows: model.history(for: item))
                }
                if let artifactId = item.artifactId, let artifact = model.artifact(artifactId) {
                    SheetSection("What it produced") {
                        ArtRow(artifact: artifact) { model.openArtifact(artifactId) }
                    }
                }
                SheetSection("Before it acts") {
                    SegmentedControl(
                        segments: [Segment(value: true, label: "Ask me first"), Segment(value: false, label: "Just do it")],
                        selection: Binding(get: { item.askFirst }, set: { model.setAskFirst(id, $0) }))
                        .padding(.top, 8)
                }
                ActionStack {
                    actions(for: item)
                    SecondaryButton(item.paused ? "Resume this" : "Pause this") { model.togglePause(id) }
                }
            }
        } else {
            EmptyView()
        }
    }

    @ViewBuilder
    private func actions(for item: WorkItem) -> some View {
        if item.key == .pmi && model.pmi == .ready {
            PrimaryButton("Review the request") { model.reviewPMI() }
        } else if item.key == .refi && model.refi == .offered {
            PrimaryButton("Start the refinance") { model.startRefi() }
            SecondaryButton("Show me the numbers") { model.openArtifact(.refi) }
        } else if item.key == .buffer && model.buffer == 0 {
            VStack(spacing: 8) {
                ChoiceRow(title: "$2,500 buffer", small: "Everything above it goes to principal") { model.setBuffer(2500) }
                ChoiceRow(title: "$5,000 buffer", small: "The usual choice") { model.setBuffer(5000) }
                ChoiceRow(title: "$10,000 buffer", small: "Conservative") { model.setBuffer(10000) }
            }
        } else if item.status == .needsConnection {
            PrimaryButton("Connect") {
                if let key = ConnectKey(workKey: item.key) { model.connect(key) }
            }
        } else if item.status == .running || item.status == .waiting {
            PrimaryButton("Do it now") { model.doNow(id) }
        }
    }
}
