import SwiftUI

/// `.choice`: a 64pt `surface` row with a 1pt `line` border and 16pt corners — an optional icon,
/// a 17pt medium title and a 15pt `muted` small line.
struct ChoiceRow: View {
    var icon: IconName? = nil
    let title: String
    var small: String? = nil
    let action: () -> Void

    @Environment(\.tokens) private var t

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                if let icon {
                    Icon(icon, size: 24)
                        .foregroundStyle(t.text)
                        .frame(width: 28, height: 28)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .textStyle(.bodyMedium)
                        .foregroundStyle(t.text)
                    if let small {
                        Text(small)
                            .textStyle(.support)
                            .foregroundStyle(t.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
            .background(t.surface)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(t.line, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("choice.\(title)")
    }
}
