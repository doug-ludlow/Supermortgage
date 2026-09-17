import SwiftUI

/// `.ag-radio`: a 19pt radio, the title (15/20) and an optional small line, hairline below.
struct RadioRow: View {
    let title: String
    var small: String? = nil
    let selected: Bool
    let action: () -> Void

    @Environment(\.tokens) private var t

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                ZStack {
                    Circle().strokeBorder(selected ? t.button : t.quiet, lineWidth: selected ? 6 : 1.5)
                }
                .frame(width: 19, height: 19)
                .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .textStyle(.support)
                        .foregroundStyle(t.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if let small, !small.isEmpty {
                        Text(small)
                            .textStyle(.meta)
                            .foregroundStyle(t.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .bottomLine(t.line)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("radio.\(title)")
    }
}
