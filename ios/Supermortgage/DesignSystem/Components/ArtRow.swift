import SwiftUI

/// `.ag-thumb`: a 54×66 `surface` tile with a 1pt `cardLine` border; `chart.bar` in `accent` when live, else `doc`.
struct ArtThumb: View {
    let live: Bool

    @Environment(\.tokens) private var t

    var body: some View {
        Image(systemName: live ? "chart.bar" : "doc")
            .font(.system(size: 20, weight: .light))
            .foregroundStyle(live ? t.accent : t.quiet)
            .frame(width: 54, height: 66)
            .background(t.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(live ? t.accent : t.cardLine, lineWidth: 1))
            .shadow(color: .black.opacity(t.cardShadowOpacity), radius: 12.5, x: 0, y: 7)
            .accessibilityHidden(true)
    }
}

/// `.ag-art`: the thumb, a 17pt medium title, a 15pt `muted` subtitle and a chevron; hairline below.
struct ArtRow: View {
    let artifact: Artifact
    let action: () -> Void

    @Environment(\.tokens) private var t

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 14) {
                ArtThumb(live: artifact.live)
                VStack(alignment: .leading, spacing: 3) {
                    Text(artifact.title)
                        .textStyle(.bodyMedium)
                        .foregroundStyle(t.text)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(artifact.subtitle)
                        .textStyle(.support)
                        .foregroundStyle(t.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Icon(.arrow, size: 16)
                    .foregroundStyle(t.quiet)
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .bottomLine(t.line)
        .accessibilityIdentifier("artifact.\(artifact.id.rawValue)")
    }
}
