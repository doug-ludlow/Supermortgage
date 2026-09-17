import SwiftUI

/// `.intro-point`: a 24pt light SF Symbol, a 17pt medium heading and a 15pt `muted` paragraph.
struct IntroPoint: View {
    let symbol: String
    let title: String
    let text: String

    @Environment(\.tokens) private var t

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(t.text)
                .frame(width: 24, height: 24)
                .padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .textStyle(.bodyMedium)
                    .foregroundStyle(t.text)
                Text(text)
                    .textStyle(.support)
                    .foregroundStyle(t.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
