import SwiftUI

/// `.ag-typing`: three 7pt `quiet` dots blinking on a 1.2s cycle, staggered by 0.2s.
struct TypingIndicator: View {
    @Environment(\.tokens) private var t
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lit = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(t.quiet)
                    .frame(width: 7, height: 7)
                    .opacity(lit ? 1 : 0.3)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.48).repeatForever(autoreverses: true).delay(Double(i) * 0.2), value: lit)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 2)
        .onAppear { lit = true }
        .accessibilityLabel("Typing")
    }
}
