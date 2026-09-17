import SwiftUI

/// Settings — Connections, Approvals, Notifications, Appearance, Your data, and how Supermortgage makes money.
struct SettingsSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    private var utilitiesConnected: Bool { model.item(.smud)?.status == .running }

    var body: some View {
        SheetContainer("Settings") {
            SectionHeading("Connections", top: 0)
            PermRow("Mortgage servicer", small: "Connected · statement read today") { onChip }
            PermRow("Credit", small: "Allowed · soft pull · 742") { onChip }
            PermRow("Bank accounts", small: "Northstar Bank · 3 accounts") { onChip }
            PermRow("Insurance carrier", small: model.insuranceConnected ? "Connected" : "Not connected") {
                if model.insuranceConnected {
                    onChip
                } else {
                    connectButton { model.connect(.ins) }
                        .accessibilityIdentifier("settings.connect.ins")
                }
            }
            PermRow("Utilities (SMUD, city water)", small: utilitiesConnected ? "Connected" : "Not connected") {
                if utilitiesConnected {
                    onChip
                } else {
                    connectButton { model.connect(.smud) }
                        .accessibilityIdentifier("settings.connect.smud")
                }
            }

            SectionHeading("Approvals")
            ForEach(ApprovalsSetting.allCases) { setting in
                RadioRow(title: setting.title, small: setting.detail, selected: model.approvals == setting) {
                    model.setApprovals(setting)
                }
            }

            SectionHeading("Notifications")
            ForEach(NotifySetting.allCases) { setting in
                RadioRow(title: setting.title, selected: model.notify == setting) {
                    model.setNotify(setting)
                }
            }

            SectionHeading("Appearance")
            SegmentedControl(
                segments: AppTheme.allCases.map { Segment(value: $0, label: $0.label) },
                selection: Binding(get: { model.theme }, set: { model.setTheme($0) }))
                .padding(.bottom, 18)

            SectionHeading("Your data")
            HStack(spacing: 10) {
                SecondaryButton("Download") { model.downloadData() }
                SecondaryButton("Delete") { model.deleteData() }
            }

            SectionHeading("How Supermortgage makes money")
            IntroText(Copy.howItMakesMoney, color: t.muted)
        }
    }

    private var onChip: some View {
        Chip(text: "On", status: .running)
    }

    private func connectButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text("Connect")
        }
        .buttonStyle(CapsuleButtonStyle(fill: t.bubble, pressed: t.selected, label: t.text, fullWidth: false, minHeight: 36))
    }
}
