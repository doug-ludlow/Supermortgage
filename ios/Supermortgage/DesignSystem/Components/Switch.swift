import SwiftUI

/// `.ag-switch`: 46×28, `line` off / `button` on, a white 22pt knob that slides 18pt.
struct SwitchToggle: View {
    @Binding var isOn: Bool
    var identifier: String? = nil

    @Environment(\.tokens) private var t
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button { isOn.toggle() } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule().fill(isOn ? t.button : t.line)
                Circle()
                    .fill(Color.white)
                    .frame(width: 22, height: 22)
                    .shadow(color: .black.opacity(0.2), radius: 1.5, x: 0, y: 1)
                    .padding(3)
            }
            .frame(width: 46, height: 28)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: isOn)
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityIdentifier(identifier ?? "switch")
    }
}
