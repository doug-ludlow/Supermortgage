import SwiftUI

/// "Cancel PMI" — the one approval card in the shell.
struct ApprovalSheet: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var router: Router
    @Environment(\.tokens) private var t

    var body: some View {
        SheetContainer("Cancel PMI") {
            PreviewBox {
                Text(Copy.approvalHeading)
                    .textStyle(.bodySemibold)
                    .foregroundStyle(t.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 4)
                Text(Copy.approvalIntro)
                    .textStyle(.support)
                    .foregroundStyle(t.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 8)
                ForEach(Copy.approvalRows) { row in
                    ListRow(row.key, row.value)
                }
            }
            ActionStack {
                PrimaryButton("Approve") { model.approvePMI() }
                SecondaryButton("Not now") { router.dismiss() }
            }
        }
    }
}
